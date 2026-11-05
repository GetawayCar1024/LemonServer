"""Isolated end-to-end regressions for Unicode paths, renames and stable judging.

Usage: python tests/server/task_paths_test.py <LemonServer executable>
Each run uses fresh server settings and temporary contests; no user data is changed.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

EXE = str(Path(sys.argv[1]).resolve())
REPO = Path(__file__).resolve().parents[2]
CODE = b'#include <cstdio>\nint main(){long long a,b;if(scanf("%lld%lld",&a,&b)!=2)return 2;printf("%lld\\n",a+b);}\n'


def run():
    with tempfile.TemporaryDirectory(prefix="lemon-paths-") as temporary:
        home = Path(temporary)
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        base = "http://127.0.0.1:" + str(port)
        env = dict(os.environ)
        if os.name == "nt" and Path("E:/MinGW64/bin/g++.exe").exists():
            env["PATH"] = "E:/MinGW64/bin;" + env.get("PATH", "")
        token = None

        def call(method, endpoint, body=None, raw=None, expect=200):
            headers = {}
            if token:
                headers["Authorization"] = "Bearer " + token
            if raw is not None:
                data = raw
                headers["Content-Type"] = "application/octet-stream"
            else:
                data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
                headers["Content-Type"] = "application/json"
            request = urllib.request.Request(base + endpoint, data=data, headers=headers, method=method)
            try:
                response = urllib.request.urlopen(request, timeout=30)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                data = response.read()
                assert response.status == expect, (endpoint, response.status, data[:500])
                return json.loads(data) if "json" in response.headers.get("Content-Type", "") else data

        def upload(contest, root, file, data):
            return call("PUT", contest + "/files/upload?" + urllib.parse.urlencode({"root": root, "path": file}), raw=data)

        def judge(contest):
            call("POST", contest + "/judge", {"mode": "all"}, expect=202)
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if not call("GET", contest + "/judge/status")["judging"]:
                    break
                time.sleep(.05)
            else:
                raise AssertionError("judging timed out")
            detail = call("GET", contest + "/contestants/alice")
            return detail

        with open(home / "server.log", "wb") as log:
            command = [EXE, "--host", "127.0.0.1", "--port", str(port), "--config", str(home / "server.json")]
            if "--embedded" not in sys.argv:
                command += ["--web-root", str(REPO / "web")]
            process = subprocess.Popen(command, cwd=home, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        call("GET", "/api/auth/status")
                        break
                    except (OSError, AssertionError):
                        if process.poll() is not None:
                            raise AssertionError((home / "server.log").read_text(errors="replace"))
                        time.sleep(.1)
                token = call("POST", "/api/auth/login", {"token": "123456"})["session"]
                call("PUT", "/api/setup", {"contestRoot": str(home / "contests")})
                failures = []
                for label, title, source, folder, standard in [
                    ("display", "中文题目", "sum", "sum", True),
                    ("data", "Data paths", "sum", "中文数据", True),
                    ("unicode", "Unicode paths", "sum", "数据🧪", True),
                    ("fileio", "中文题目", "sum", "sum", False),
                ]:
                    call("POST", "/api/contests", {"name": label}, expect=201)
                    contest = "/api/contests/" + label
                    upload(contest, "data", folder + "/1.in", b"1 2\n")
                    upload(contest, "data", folder + "/1.out", b"3\n")
                    call("POST", contest + "/tasks", {
                        "problemTitle": title, "sourceFileName": source, "standardInputCheck": True,
                        "standardOutputCheck": standard, "comparisonMode": 1,
                        "inputFileName": "sum.in", "outputFileName": "sum.out",
                        "testCases": [{"fullScore": 100, "timeLimit": 1000, "memoryLimit": 256,
                                       "inputFiles": [folder + "/1.in"], "outputFiles": [folder + "/1.out"]}],
                    }, expect=201)
                    code = CODE if standard else CODE.replace(b'int main(){', b'int main(){freopen("sum.out","w",stdout);')
                    upload(contest, "source", "alice/" + source + ".cpp", code)
                    call("POST", contest + "/refresh")
                    result = judge(contest)
                    if result.get("totalScore") != 100:
                        failures.append((label, "first judge", result))
                    else:
                        print("PASS", label, "first judge")
                    for attempt in range(3):
                        call("PUT", contest + "/tasks/0", {"problemTitle": "renamed-" + label})
                        task = call("GET", contest + "/tasks/0")
                        call("PUT", contest + "/tasks/0", task)
                        result = judge(contest)
                        if result.get("totalScore") != 100:
                            failures.append((label, "rename/save " + str(attempt + 1), result))
                            break
                    else:
                        print("PASS", label, "stable rename/save")
                    for mode in [0, 1, 3]:
                        call("PUT", contest + "/tasks/0", {"comparisonMode": mode})
                        result = judge(contest)
                        if result.get("totalScore") != 100:
                            failures.append((label, "comparison mode " + str(mode), result))
                created = call("POST", "/api/contests/display/tasks", {"problemTitle": "中文新题"}, expect=201)
                assert created["task"]["sourceFileName"].isascii() and created["task"]["sourceFileName"], created
                assert created["task"]["inputFileName"].isascii(), created
                assert created["task"]["outputFileName"].isascii(), created
                call("DELETE", "/api/contests/display/tasks/" + str(created["index"]))
                before = call("GET", "/api/contests/display/tasks/0")
                for field in ["sourceFileName", "inputFileName", "outputFileName"]:
                    patch = {"problemTitle": "must-not-be-saved", field: "中文", "standardInputCheck": False, "standardOutputCheck": False}
                    rejected = call("PUT", "/api/contests/display/tasks/0", patch, expect=400)
                    assert "ASCII" in rejected["error"], rejected
                    assert call("GET", "/api/contests/display/tasks/0") == before, "invalid saves must be atomic"
                print("PASS Chinese display names and atomic rejection of nonportable runtime names")
                call("POST", "/api/contests", {"name": "scan"}, expect=201)
                scan_contest = "/api/contests/scan"
                upload(scan_contest, "data", "中文数据/1.in", b"1 2\n")
                upload(scan_contest, "data", "中文数据/1.out", b"3\n")
                candidate = call("GET", scan_contest + "/scan-tasks")[0]
                stem = candidate["sourceFileName"]
                assert stem.isascii() and stem, candidate
                call("POST", scan_contest + "/add-tasks", {"tasks": [{"name": candidate["name"], "sourceFileName": stem}]})
                file_code = CODE.replace(b"int main(){", ('int main(){freopen("' + stem + '.in","r",stdin);freopen("' + stem + '.out","w",stdout);').encode())
                upload(scan_contest, "source", "alice/" + stem + ".cpp", file_code)
                call("POST", scan_contest + "/refresh")
                assert judge(scan_contest)["totalScore"] == 100
                assert call("GET", scan_contest + "/scan-tasks") == [], "already imported data folders must not be offered twice"
                print("PASS Chinese data folder imports with a stable ASCII runtime name")
                # A failed CDF write must not be reported as a successful save.
                cdf = home / "contests" / "display" / "display.cdf"
                original = cdf.read_bytes()
                cdf.unlink()
                cdf.mkdir()
                try:
                    call("PUT", "/api/contests/display/tasks/0", {"problemTitle": "durable-save"}, expect=500)
                    count = len(call("GET", "/api/contests/display")["tasks"])
                    call("POST", "/api/contests/display/tasks", {"problemTitle": "not-saved"}, expect=500)
                    assert len(call("GET", "/api/contests/display")["tasks"]) == count
                finally:
                    cdf.rmdir()
                    cdf.write_bytes(original)
                call("PUT", "/api/contests/display/tasks/0", {"problemTitle": "durable-save"})
                assert json.loads(cdf.read_bytes())["tasks"][0]["problemTitle"] == "durable-save"
                print("PASS save failure is reported and the same edit can be retried")
                # Viewing another contest must not change a running judge's data paths.
                call("POST", "/api/contests", {"name": "viewer"}, expect=201)
                slow = b'#include <cstdio>\n#ifdef _WIN32\n#include <windows.h>\n#else\n#include <unistd.h>\n#endif\nint main(){long long a,b;if(scanf("%lld%lld",&a,&b)!=2)return 2;\n#ifdef _WIN32\nSleep(350);\n#else\nusleep(350000);\n#endif\nprintf("%lld\\n",a+b);}\n'
                contest = "/api/contests/display"
                upload(contest, "source", "alice/sum.cpp", slow)
                call("POST", contest + "/refresh")
                control = judge(contest)
                assert control.get("totalScore") == 100, ("delayed program control", control)
                call("POST", contest + "/judge", {"mode": "all"}, expect=202)
                for _ in range(8):
                    call("GET", "/api/contests/viewer")
                    time.sleep(.1)
                while call("GET", "/api/judge/status")["judging"]:
                    call("GET", "/api/contests/viewer")
                    time.sleep(.05)
                result = call("GET", contest + "/contestants/alice")
                if result.get("totalScore") != 100:
                    failures.append(("other contest viewed while judging", "no save should be needed", result))
                else:
                    print("PASS viewing another contest during judging")
                assert not failures, json.dumps(failures, ensure_ascii=False, indent=2)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    run()
