"""End-to-end smoke test for LemonServer's REST API.

Usage: python smoke_test.py [base_url] [contest_root]
Requires a running LemonServer with a fresh configuration file (token 123456).
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import io
import zipfile

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090"
ROOT = sys.argv[2] if len(sys.argv) > 2 else r"C:\LemonServerTest\contests"
CONTEST = "测试比赛"


def call(method, path, body=None, token=None, raw=None, expect=None):
    url = BASE + path
    data = None
    headers = {}
    if raw is not None:
        data = raw
        headers["Content-Type"] = "application/octet-stream"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            status, content, ctype = r.status, r.read(), r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        status, content, ctype = e.code, e.read(), e.headers.get("Content-Type", "")
    if expect is not None:
        assert status == expect, f"{method} {path}: expected {expect}, got {status}: {content[:300]!r}"
    if "json" in ctype:
        return status, json.loads(content)
    return status, content


def q(**kw):
    return "?" + urllib.parse.urlencode(kw)


c = "/api/contests/" + urllib.parse.quote(CONTEST)

call("GET", "/api/contests", expect=401)
call("POST", "/api/auth/login", {"token": "wrong"}, expect=401)
_, r = call("POST", "/api/auth/login", {"token": "123456"}, expect=200)
tok = r["session"]
assert r["setupRequired"] and r["tokenIsDefault"]

call("PUT", "/api/setup", {"contestRoot": ROOT}, tok, expect=200)
_, r = call("GET", "/api/compilers", token=tok, expect=200)
if not r:
    _, det = call("GET", "/api/compilers/detect", token=tok, expect=200)
    call("PUT", "/api/compilers", det, tok, expect=200)
_, comps = call("GET", "/api/compilers", token=tok, expect=200)
print("compilers:", [x["compilerName"] for x in comps])

call("DELETE", c, token=tok)
_, r = call("POST", "/api/contests", {"name": CONTEST}, tok, expect=201)
assert r["title"] == CONTEST

# data: aplusb with 3 cases uploaded as a zip, plus one raw upload
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    for i in range(1, 4):
        z.writestr(f"aplusb/{i}.in", f"{i} {i * 10}\n")
        z.writestr(f"aplusb/{i}.out", f"{i * 11}\n")
call("POST", c + "/files/unzip" + q(root="data", path=""), raw=buf.getvalue(), token=tok, expect=200)
call("PUT", c + "/files/upload" + q(root="data", path="aplusb/4.in"), raw=b"100 200\n", token=tok, expect=200)
call("PUT", c + "/files/upload" + q(root="data", path="aplusb/4.out"), raw=b"300\n", token=tok, expect=200)
call("PUT", c + "/files/upload" + q(root="data", path="../evil.txt"), raw=b"x", token=tok, expect=400)

_, scan = call("GET", c + "/scan-tasks", token=tok, expect=200)
assert scan and scan[0]["name"] == "aplusb" and len(scan[0]["testCases"]) == 4, scan
call("POST", c + "/add-tasks", {"tasks": [{"name": "aplusb", "fullScore": 100, "timeLimit": 1000,
                                           "memoryLimit": 256}]}, tok, expect=200)

srcs = {
    "ac": "#include <cstdio>\nint main(){freopen(\"aplusb.in\",\"r\",stdin);freopen(\"aplusb.out\",\"w\",stdout);"
          "long long a,b;scanf(\"%lld%lld\",&a,&b);printf(\"%lld\\n\",a+b);}",
    "wa": "#include <cstdio>\nint main(){freopen(\"aplusb.in\",\"r\",stdin);freopen(\"aplusb.out\",\"w\",stdout);"
          "long long a,b;scanf(\"%lld%lld\",&a,&b);printf(\"%lld\\n\",a+b+(a==2));}",
    "tle": "int main(){volatile long long x=0;for(;;)x++;}",
    "ce": "int main(){ this is not c++ }",
    "re": "#include <cstdlib>\nint main(){int*p=nullptr;*p=1;return 0;}",
    "mle": "#include <vector>\n#include <cstdio>\nint main(){std::vector<char> v(600u<<20,1);printf(\"%d\",v[12345]);}",
}
for who, code in srcs.items():
    call("PUT", c + "/files/upload" + q(root="source", path=f"{who}/aplusb.cpp"), raw=code.encode(), token=tok,
         expect=200)
call("PUT", c + "/files/upload" + q(root="source", path="nosrc/readme.txt"), raw=b"nothing", token=tok, expect=200)

_, r = call("POST", c + "/refresh", token=tok, expect=200)
assert len(r["contestants"]) == 7, r["contestants"]

_, r = call("POST", c + "/judge", {"mode": "all"}, tok, expect=202)
since = 0
while True:
    _, st = call("GET", c + "/judge/status" + q(since=since), token=tok, expect=200)
    for e in st["events"]:
        since = max(since, int(e["id"]))
    if not st["judging"]:
        break
    time.sleep(0.5)
print("judge finished:", st["tasksDone"], "/", st["tasksTotal"])

_, r = call("GET", c, token=tok, expect=200)
scores = {x["name"]: x["totalScore"] for x in r["contestants"]}
print("scores:", scores)
assert scores["ac"] == 100, scores
assert scores["wa"] == 75, scores
assert scores["tle"] == 0 and scores["ce"] == 0 and scores["re"] == 0 and scores["mle"] == 0, scores
_, d = call("GET", c + "/contestants/mle", token=tok, expect=200)
print("mle results:", d["details"][0]["result"])
_, d = call("GET", c + "/contestants/ce", token=tok, expect=200)
assert d["details"][0]["compileState"] == 2

# re-submitting a source through the API makes the cell unjudged again
call("PUT", c + "/files/upload" + q(root="source", path="wa/aplusb.cpp"), raw=srcs["ac"].encode(), token=tok, expect=200)
_, r = call("GET", c, token=tok, expect=200)
wa = next(x for x in r["contestants"] if x["name"] == "wa")
assert not wa["tasks"][0]["judged"] and wa["totalScore"] == -1, wa
_, r = call("POST", c + "/judge", {"mode": "unjudged", "refresh": True}, tok, expect=202)
assert r["tasksTotal"] == 1, r
while call("GET", c + "/judge/status", token=tok)[1]["judging"]:
    time.sleep(0.3)
_, e = call("POST", c + "/judge", {"mode": "unjudged"}, tok, expect=409)
assert e["nothingToJudge"], e
call("PUT", c + "/files/upload" + q(root="source", path="wa/aplusb.cpp"), raw=srcs["wa"].encode(), token=tok, expect=200)
call("POST", c + "/judge", {"mode": "unjudged"}, tok, expect=202)
while call("GET", c + "/judge/status", token=tok)[1]["judging"]:
    time.sleep(0.3)
_, r = call("GET", c, token=tok, expect=200)
assert next(x for x in r["contestants"] if x["name"] == "wa")["totalScore"] == 75
print("resubmission OK")

_, html = call("GET", c + "/export" + q(format="html"), token=tok, expect=200)
assert b"aplusb" in html and "测试比赛".encode() in html
_, r = call("GET", c + "/export" + q(format="html", save=1), token=tok, expect=200)
print("saved:", r["file"])
_, stat = call("GET", c + "/statistics", token=tok, expect=200)
assert b"<h1>" in stat

# API keys
_, k = call("POST", "/api/apikeys", {"name": "ci"}, tok, expect=200)
key = k["key"]
_, r = call("GET", "/api/contests", token=key, expect=200)
call("GET", "/api/apikeys", token=key, expect=403)
_, k2 = call("POST", "/api/apikeys", {"name": "custom", "key": "my-own-key-123"}, tok, expect=200)
call("GET", "/api/contests", token="my-own-key-123", expect=200)
call("DELETE", "/api/apikeys/" + k2["info"]["id"], token=tok, expect=200)
call("GET", "/api/contests", token="my-own-key-123", expect=401)

# token change
_, r = call("PUT", "/api/auth/token", {"currentToken": "123456", "newToken": "s3cret"}, tok, expect=200)
call("GET", "/api/contests", token=tok, expect=401)
tok = r["session"]
call("POST", "/api/auth/login", {"token": "123456"}, expect=401)
_, r = call("POST", "/api/auth/login", {"token": "s3cret"}, expect=200)
call("PUT", "/api/auth/token", {"currentToken": "s3cret", "newToken": "123456"}, r["session"], expect=200)

# online text editing with last-modified check
_, t = call("GET", c + "/files/download" + q(root="contest", path="data/aplusb/1.in", text=1), token=key, expect=200)
assert t["editable"] and t["content"] == "1 10\n", t
_, r = call("PUT", c + "/files/text", {"root": "contest", "path": "data/aplusb/1.in", "content": "1 10\n",
                                         "encoding": t["encoding"], "eol": t["eol"],
                                         "expectedModifiedMs": t["modifiedMs"]}, key, expect=200)
call("PUT", c + "/files/text", {"root": "contest", "path": "data/aplusb/1.in", "content": "x",
                                "expectedModifiedMs": t["modifiedMs"] - 5000}, key, expect=409)
call("PUT", c + "/files/text", {"root": "contest", "path": "data/big.txt", "content": "x" * 200000}, key, expect=400)

# copy / move
call("POST", c + "/files/mkdir", {"root": "contest", "path": "tmp"}, key, expect=200)
_, r = call("POST", c + "/files/copy", {"root": "contest", "paths": ["data/aplusb/1.in", "data/aplusb/1.in"], "to": "tmp"}, key, expect=200)
assert r["items"] == ["tmp/1.in", "tmp/1 (2).in"], r
_, r = call("POST", c + "/files/move", {"root": "contest", "paths": ["tmp/1 (2).in"], "to": ""}, key, expect=200)
assert r["items"] == ["1 (2).in"], r
call("POST", c + "/files/move", {"root": "contest", "paths": ["tmp"], "to": "tmp"}, key, expect=400)
call("POST", c + "/files/delete", {"root": "contest", "paths": ["tmp", "1 (2).in"]}, key, expect=200)

# rejudge by state
_, s = call("GET", c + "/state-summary", token=key, expect=200)
assert s["compile"].get("2") == 1 and s["result"].get("3", 0) >= 1, s
_, r = call("POST", c + "/judge", {"mode": "state", "compileStates": [2]}, key, expect=202)
assert r["tasksTotal"] == 1, r
while call("GET", c + "/judge/status", token=key)[1]["judging"]:
    time.sleep(0.3)

# Testlib for Lemons: create a checker from a template, compile it on the server, judge with it
_, tpls = call("GET", "/api/testlib/templates", token=key, expect=200)
assert "checkers/wcmp.cpp" in tpls, tpls
_, r = call("POST", c + "/files/template", {"root": "data", "path": "aplusb", "template": "checkers/wcmp.cpp", "name": "chk.cpp"}, key, expect=200)
_, r = call("POST", c + "/files/compile", {"root": "data", "path": "aplusb/chk.cpp"}, key, expect=200)
assert r["ok"], r["output"]
print("checker compiled:", r["executable"], f'{r["seconds"]:.1f}s')
call("PUT", c + "/files/upload" + q(root="data", path="bad.cpp"), raw=b"int main( {", token=key, expect=200)
_, r = call("POST", c + "/files/compile", {"root": "data", "path": "bad.cpp"}, key, expect=200)
assert not r["ok"] and "error" in r["output"], r
exe = r_exe = "aplusb/chk.exe" if os.name == "nt" else "aplusb/chk"
call("PUT", c + "/tasks/0", {"comparisonMode": 5, "specialJudge": exe}, key, expect=200)
call("POST", c + "/judge", {"mode": "selected", "items": [{"contestant": "ac"}, {"contestant": "wa"}]}, key, expect=202)
while call("GET", c + "/judge/status", token=key)[1]["judging"]:
    time.sleep(0.3)
_, r = call("GET", c, token=key, expect=200)
sc = {x["name"]: x["totalScore"] for x in r["contestants"]}
assert sc["ac"] == 100 and sc["wa"] == 75, sc

# export the contest as zip, import it back (zip and file-by-file)
_, z = call("GET", c + "/files/download" + q(root="contest", path=""), token=key, expect=200)
_, r = call("POST", "/api/import-contest" + q(name="导入测试"), raw=z, token=key, expect=201)
assert r["name"] == "导入测试", r
call("POST", "/api/import-contest" + q(name="导入测试"), raw=z, token=key, expect=400)
_, r = call("POST", "/api/import-contest" + q(name="导入测试", overwrite=1), raw=z, token=key, expect=201)
_, r = call("GET", "/api/contests/" + urllib.parse.quote("导入测试"), token=key, expect=200)
assert len(r["tasks"]) == 1 and len(r["contestants"]) == 7, r
for name in zipfile.ZipFile(io.BytesIO(z)).namelist():
    data = zipfile.ZipFile(io.BytesIO(z)).read(name)
    call("PUT", "/api/import-contest/file" + q(id="smoke123", path="mycontest/" + name), raw=data, token=key, expect=200)
_, r = call("POST", "/api/import-contest/finish" + q(id="smoke123"), token=key, expect=201)
assert r["name"] == "mycontest", r
_, r = call("GET", "/api/contests", token=key, expect=200)
print("contests:", [x["name"] for x in r["contests"]])
c = "/api/contests/" + urllib.parse.quote(CONTEST)

# zip download of data folder
_, z = call("GET", c + "/files/download" + q(root="data", path="aplusb"), token=key, expect=200)
assert {"1.in", "4.out", "chk.cpp"} <= set(zipfile.ZipFile(io.BytesIO(z)).namelist())

# contest time: during it scores, details, source code, export and statistics are hidden
now = int(time.time() * 1000)
call("PUT", c, {"startTime": now - 60000, "endTime": now - 120000}, key, expect=400)
call("PUT", c, {"startTime": now - 60000, "endTime": None}, key, expect=400)
_, r = call("PUT", c, {"startTime": now - 60000, "endTime": now + 3600000}, key, expect=200)
assert r["running"] and r["startTime"] == now - 60000, r
ac = next(x for x in r["contestants"] if x["name"] == "ac")
assert "totalScore" not in ac and "score" not in ac["tasks"][0] and "compileState" not in ac["tasks"][0], ac
assert ac["tasks"][0]["submitted"] and ac["tasks"][0]["codeSize"] > 0 and ac["tasks"][0]["judged"], ac
for path in ["/contestants/ac", "/contestants/ac/source/0", "/export", "/statistics", "/state-summary",
             "/files/download" + q(root="source", path="ac"), "/files/download" + q(root="contest", path=""),
             "/files/download" + q(root="contest", path=CONTEST + ".cdf")]:
    _, e = call("GET", c + path, token=key, expect=403)
    assert e["contestRunning"], e
call("POST", c + "/judge", {"mode": "state", "resultStates": [1]}, key, expect=403)
call("POST", c + "/files/copy", {"root": "contest", "paths": ["source/ac"], "to": "data"}, key, expect=403)
call("POST", c + "/files/compile", {"root": "source", "path": "ac/aplusb.cpp"}, key, expect=403)
call("GET", c + "/files" + q(root="source", path="ac"), token=key, expect=200)
call("GET", c + "/files/download" + q(root="data", path="aplusb/1.in"), token=key, expect=200)
call("POST", c + "/judge", {"mode": "selected", "items": [{"contestant": "ac"}]}, key, expect=202)
since = 0
events = []
while True:
    _, st = call("GET", c + "/judge/status" + q(since=since), token=key, expect=200)
    events += st["events"]
    since = st["lastEventId"]
    if not st["judging"]:
        break
    time.sleep(0.3)
# only the start / end of the job: neither results nor which submissions are judged
assert events and {e["type"] for e in events} <= {"start", "finished", "stopping", "skipped"}, events[:3]
_, r = call("GET", "/api/contests", token=key, expect=200)
assert next(x for x in r["contests"] if x["name"] == CONTEST)["running"]
_, r = call("PUT", c, {"startTime": None, "endTime": None}, key, expect=200)
assert not r["running"] and r["startTime"] is None
assert next(x for x in r["contestants"] if x["name"] == "ac")["totalScore"] == 100
call("GET", c + "/contestants/ac/source/0", token=key, expect=200)
# the time of a contest that has ended can no longer be changed (re-sending the same values is fine)
past = {"startTime": now - 7200000, "endTime": now - 3600000}
call("PUT", c, past, key, expect=200)
call("PUT", c, past, key, expect=200)
call("PUT", c, {"startTime": now - 7200000, "endTime": now + 3600000}, key, expect=400)
_, e = call("PUT", c, {"startTime": None, "endTime": None}, key, expect=400)
assert "ended" in e["error"], e
_, r = call("GET", c, token=key, expect=200)
assert r["endTime"] == now - 3600000 and not r["running"], r
print("contest time OK")

# down.zip (optional property of a contest)
call("GET", c + "/down-zip", token=key, expect=404)
call("PUT", c + "/down-zip", raw=b"not a zip", token=key, expect=400)
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("statement.txt", "A + B")
_, r = call("PUT", c + "/down-zip", raw=buf.getvalue(), token=key, expect=200)
assert r["downZip"]["path"] == "down.zip" and r["downZip"]["size"] == len(buf.getvalue()), r
_, d = call("GET", c + "/down-zip", token=key, expect=200)
assert d == buf.getvalue()
call("PUT", c, {"downZip": "../x.zip"}, key, expect=400)
call("PUT", c, {"downZip": "nothing.zip"}, key, expect=400)
_, r = call("PUT", c, {"downZip": "data/aplusb/1.in"}, key, expect=200)
assert r["downZip"]["path"] == "data/aplusb/1.in", r
call("PUT", c, {"downZip": "down.zip"}, key, expect=200)
call("PUT", c + "/files/text", {"root": "contest", "path": "lemonserver.json", "content": "{}"}, key, expect=400)
call("POST", c + "/files/delete", {"root": "contest", "path": "lemonserver.json"}, key, expect=400)
_, r = call("DELETE", c + "/down-zip" + q(deleteFile=1), token=key, expect=200)
assert r["downZip"] is None, r
_, r = call("GET", c + "/files" + q(root="contest", path=""), token=key, expect=200)
assert "down.zip" not in [e["name"] for e in r["entries"]], r
print("down.zip OK")

# judging queue: one job at a time for the whole server; other contests stay usable meanwhile
B = "/api/contests/" + urllib.parse.quote("导入测试")
M = "/api/contests/mycontest"


def wait_idle():
    while call("GET", "/api/judge/status", token=key, expect=200)[1]["judging"]:
        time.sleep(0.3)


_, r = call("POST", c + "/judge", {"mode": "all"}, key, expect=202)
assert r["job"]["position"] == 0 and r["running"] and r["tasksTotal"] == 7, r["job"]
job_a = r["job"]["id"]
# the judged contest can be viewed but not changed
call("GET", c, token=key, expect=200)
_, e = call("POST", c + "/tasks", {"problemTitle": "x"}, key, expect=409)
assert e["busy"], e
call("PUT", c, {"title": "x"}, key, expect=409)
call("PUT", "/api/settings", {"maxJudgingThreads": 2}, key, expect=409)  # settings are in use
# other contests: open, edit, list files while judging (this changes the server's current directory)
for _ in range(3):
    _, rb = call("GET", B, token=key, expect=200)
    assert not rb["busy"], rb
    call("GET", M + "/files" + q(root="source", path=""), token=key, expect=200)
_, t = call("POST", M + "/tasks", {"problemTitle": "extra"}, key, expect=201)
call("DELETE", M + "/tasks/" + str(t["index"]), token=key, expect=200)
# queue jobs of other contests and of the judged one
_, r = call("POST", B + "/judge", {"mode": "all"}, key, expect=202)
assert r["job"]["position"] == 1, r["job"]
job_b = r["job"]["id"]
_, r = call("POST", B + "/judge", {"mode": "all"}, key, expect=202)
assert r["job"]["id"] == job_b and r["job"].get("duplicate"), r["job"]  # same request: not queued twice
_, r = call("POST", c + "/judge", {"mode": "unjudged"}, key, expect=202)
assert r["job"]["position"] == 2, r["job"]
job_a2 = r["job"]["id"]
_, qu = call("GET", "/api/judge-queue", token=key, expect=200)
assert qu["running"]["id"] == job_a and [j["id"] for j in qu["queue"]] == [job_b, job_a2], qu
_, e = call("PUT", B, {"title": "x"}, key, expect=409)  # queued = busy too
call("DELETE", "/api/judge-queue/" + str(job_a2), token=key, expect=200)
call("DELETE", "/api/judge-queue/" + str(job_a2), token=key, expect=404)
call("DELETE", B + "/judge", token=key, expect=200)  # remove all jobs of B: editable again
_, rb = call("GET", B, token=key, expect=200)
assert not rb["busy"] and rb["queuedJobs"] == 0, rb
call("PUT", B, {"title": "导入测试"}, key, expect=200)
call("POST", B + "/judge", {"mode": "all"}, key, expect=202)
wait_idle()
for path in (c, B):  # judged correctly although the current directory kept changing
    _, r = call("GET", path, token=key, expect=200)
    sc = {x["name"]: x["totalScore"] for x in r["contestants"]}
    assert sc["ac"] == 100 and sc["tle"] == 0 and sc["mle"] == 0 and sc["ce"] == 0, (path, sc)
    assert not r["busy"], r
assert {x["name"]: x["totalScore"] for x in call("GET", c, token=key)[1]["contestants"]}["wa"] == 75
# removing the jobs of a contest also stops the one being judged
call("POST", c + "/judge", {"mode": "all"}, key, expect=202)
_, r = call("DELETE", c + "/judge", token=key, expect=200)
assert r["removed"] == 1, r
wait_idle()
_, st = call("GET", "/api/judge/status", token=key, expect=200)
fin = [e for e in st["events"] if e["type"] == "finished"]
assert fin and fin[-1]["stopped"], st["events"][-3:]
call("POST", c + "/judge/stop", token=key, expect=409)
call("PUT", "/api/settings", {}, key, expect=200)
print("judging queue OK")

# clone a contest: tasks and data; submissions and results only when asked; never the contest time
_, src = call("GET", c, token=key, expect=200)
_, r = call("POST", c + "/clone", {"name": "克隆测试"}, key, expect=201)
assert r["name"] == "克隆测试" and r["title"] == "克隆测试", r
assert len(r["tasks"]) == len(src["tasks"]) and r["tasks"][0]["testCases"] == src["tasks"][0]["testCases"], r["tasks"]
assert r["contestants"] == [] and r["startTime"] is None and src["startTime"] is not None, r
K1 = "/api/contests/" + urllib.parse.quote("克隆测试")
call("GET", K1 + "/files/download" + q(root="data", path="aplusb/1.in"), token=key, expect=200)
_, ls = call("GET", K1 + "/files" + q(root="contest", path=""), token=key, expect=200)
names = {e["name"] for e in ls["entries"]}
assert {"data", "source", "克隆测试.cdf"} <= names and "result.html" not in names and CONTEST + ".cdf" not in names, names
assert call("GET", K1 + "/files" + q(root="source", path=""), token=key)[1]["entries"] == []
_, r = call("POST", c + "/clone", {"name": "克隆测试2", "title": "带成绩", "withSubmissions": True}, key, expect=201)
assert r["title"] == "带成绩" and len(r["contestants"]) == len(src["contestants"]), r
assert {x["name"]: x["totalScore"] for x in r["contestants"]} == {x["name"]: x["totalScore"] for x in src["contestants"]}
K2 = "/api/contests/" + urllib.parse.quote("克隆测试2")
call("POST", K2 + "/judge", {"mode": "selected", "items": [{"contestant": "ac"}, {"contestant": "wa"}]}, key, expect=202)
wait_idle()
sc = {x["name"]: x["totalScore"] for x in call("GET", K2, token=key)[1]["contestants"]}
assert sc["ac"] == 100 and sc["wa"] == 75, sc  # the copied checker still runs
call("POST", c + "/clone", {"name": "克隆测试"}, key, expect=400)
call("POST", c + "/clone", {"name": "a/b"}, key, expect=400)
call("POST", "/api/contests/nothing/clone", {"name": "x"}, key, expect=400)
call("POST", c + "/judge", {"mode": "all"}, key, expect=202)
call("POST", c + "/clone", {"name": "克隆测试3", "withSubmissions": True}, key, expect=409)  # results not final
call("POST", c + "/clone", {"name": "克隆测试3"}, key, expect=201)
call("DELETE", c + "/judge", token=key, expect=200)
wait_idle()
for n in ("克隆测试", "克隆测试2", "克隆测试3"):
    call("DELETE", "/api/contests/" + urllib.parse.quote(n), token=key, expect=200)
print("clone OK")

# progress: skipped cases count as judged too, so a finished job is at 100%
call("POST", c + "/clone", {"name": "进度测试", "withSubmissions": True}, key, expect=201)
P = "/api/contests/" + urllib.parse.quote("进度测试")
case = lambda names, score, deps=(): {"fullScore": score, "timeLimit": 1000, "memoryLimit": 256,
                                      "inputFiles": [f"aplusb/{n}.in" for n in names],
                                      "outputFiles": [f"aplusb/{n}.out" for n in names],
                                      "dependenceSubtask": list(deps)}
# wa fails 2.in: the rest of test case 1 is skipped, and test case 2 (depending on it) entirely
call("PUT", P + "/tasks/0", {"testCases": [case([2, 1, 3], 50), case([4], 50, [1])]}, key, expect=200)
call("POST", P + "/judge", {"mode": "selected", "items": [{"contestant": "wa"}]}, key, expect=202)
wait_idle()
_, st = call("GET", "/api/judge/status", token=key, expect=200)
assert st["progressMaximum"] == 4000 and st["progress"] == st["progressMaximum"], (st["progress"], st["progressMaximum"])
assert sum(1 for e in st["events"] if e["type"] == "case") == 4, [e for e in st["events"] if e["type"] == "case"]

# during the contest time, while the contest is being judged: only the overall progress
now = int(time.time() * 1000)
call("PUT", P, {"startTime": now - 60000, "endTime": now + 3600000}, key, expect=200)
call("POST", P + "/judge", {"mode": "all"}, key, expect=202)
_, r = call("GET", P, token=key, expect=200)
assert r["judging"] and all("judged" not in t for x in r["contestants"] for t in x["tasks"]), r["contestants"][0]
assert all("judgingTime" not in x and "submitted" in x["tasks"][0] for x in r["contestants"]), r["contestants"][0]
_, st = call("GET", "/api/judge/status", token=key, expect=200)
assert st["contestRunning"] and "tasksDone" not in st and "progress" in st, st
assert {e["type"] for e in st["events"]} <= {"start", "finished", "stopping", "skipped"}, st["events"]
_, qu = call("GET", "/api/judge-queue", token=key, expect=200)
assert qu["running"] is None or "tasksDone" not in qu["running"], qu
wait_idle()
_, r = call("GET", P, token=key, expect=200)
assert all("judged" in t for x in r["contestants"] for t in x["tasks"]), r["contestants"][0]  # not judging any more
call("PUT", P, {"startTime": None, "endTime": None}, key, expect=200)
call("DELETE", P, token=key, expect=200)
print("progress / contest-time judging OK")
print("ALL OK")
