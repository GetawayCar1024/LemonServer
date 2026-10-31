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
cases = [e for e in events if e["type"] == "case"]
assert cases and all("result" not in e and "score" not in e for e in cases), cases[:2]
_, r = call("GET", "/api/contests", token=key, expect=200)
assert next(x for x in r["contests"] if x["name"] == CONTEST)["running"]
_, r = call("PUT", c, {"startTime": None, "endTime": None}, key, expect=200)
assert not r["running"] and r["startTime"] is None
assert next(x for x in r["contestants"] if x["name"] == "ac")["totalScore"] == 100
call("GET", c + "/contestants/ac/source/0", token=key, expect=200)
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
print("ALL OK")
