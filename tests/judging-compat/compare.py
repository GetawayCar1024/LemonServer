"""Differential verdict/scoring regression against unmodified LemonLime 0.3.7 sources.
Usage: python tests/judging-compat/compare.py <current-driver> <reference-driver>
Times, memory measurements and diagnostic wording are deliberately not compared.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

CURRENT, REFERENCE = (str(Path(value).resolve()) for value in sys.argv[1:3])
ENV = dict(os.environ)
if os.name == "nt" and Path("E:/MinGW64/bin/g++.exe").exists():
    ENV["PATH"] = "E:/MinGW64/bin;" + ENV.get("PATH", "")

CHECKER = r'''#include <cstdio>
#include <fstream>
#include <string>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif
int main(int argc,char** argv){std::ifstream f(argv[1]);std::string s;std::getline(f,s);
if(s=="sleep"){
#ifdef _WIN32
Sleep(4000);
#else
sleep(4);
#endif
}
if(argc>=7){std::ofstream score(argv[5]);score<<s;std::ofstream message(argv[6]);message<<"fixture";}
else std::fprintf(stderr,"%s\n",s.c_str());return 0;}
'''


def case(score=100, count=1, depends=None):
    return {"fullScore": score, "timeLimit": 1000, "memoryLimit": 128,
            "dependenceSubtask": depends or [],
            "inputFiles": [f"case{i + 1}.in" for i in range(count)],
            "outputFiles": [f"case{i + 1}.out" for i in range(count)]}


def run():
    with tempfile.TemporaryDirectory(prefix="lemon-compat-") as temp:
        root = Path(temp)
        checker_source = root / "checker.cpp"
        checker_source.write_text(CHECKER, encoding="utf-8")
        checker = root / ("checker.exe" if os.name == "nt" else "checker")
        compiler = shutil.which("g++", path=ENV["PATH"])
        assert compiler, "g++ is required"
        subprocess.run([compiler, str(checker_source), "-O2", "-o", str(checker)], env=ENV, check=True, capture_output=True)
        scenarios = []
        variations = [
            ("exact", "alpha beta\n", "alpha beta\n"),
            ("different", "alpha beta\n", "alpha gamma\n"),
            ("spaces", "alpha beta\n", " alpha  beta  \n"),
            ("linebreak", "alpha beta\n", "alpha\nbeta\n"),
            ("crlf", "alpha beta\n", "alpha beta\r\n"),
            ("empty", "", ""),
            ("empty-output", "alpha\n", ""),
            ("extra-output", "alpha\n", "alpha beta\n"),
            ("long-token", "x" * 1000 + "\n", "x" * 1000 + "\n"),
            ("long-line", "word " * 300 + "end\n", "word " * 300 + "end\n"),
            ("no-final-newline", "alpha\n", "alpha"),
            ("missing-answer", "alpha\n", None),
        ]
        for mode in [0, 1]:
            for name, expected, answer in variations:
                scenarios.append((f"compare-{mode}-{name}", mode, [case()], [expected], [answer], None, None))
        for name, expected, answer in [("near", "1.0\n", "1.000000001\n"), ("far", "1.0\n", "2\n"), ("bad", "1.0\n", "word\n")]:
            scenarios.append(("real-" + name, 3, [case()], [expected], [answer], None, None))
        for message in ["ok accepted", "wrong answer fixture", "partially correct (50)", "points 0.35", "points 0", "FAIL broken", "invalid output", "sleep"]:
            scenarios.append(("testlib-" + message.replace(" ", "-"), 5, [case(80)], ["ignored"], ["answer"], message, None))
        for points in ["0", "25", "100", "invalid", "sleep"]:
            scenarios.append(("lemon-" + points, 4, [case()], ["ignored"], ["answer"], points, None))
        scenarios.extend([
            ("bundle-all-correct", 0, [case(30, 2), {**case(70), "inputFiles": ["case3.in"], "outputFiles": ["case3.out"]}], ["yes", "yes", "yes"], ["yes", "yes", "yes"], None, None),
            ("bundle-first-fails", 0, [case(30, 2), {**case(70, depends=[1]), "inputFiles": ["case3.in"], "outputFiles": ["case3.out"]}], ["yes", "yes", "yes"], ["no", "yes", "yes"], None, None),
            ("bundle-last-fails", 0, [case(30, 2), {**case(70, depends=[1]), "inputFiles": ["case3.in"], "outputFiles": ["case3.out"]}], ["yes", "yes", "yes"], ["yes", "no", "yes"], None, None),
            ("partial-dependency", 5, [case(40), {**case(60, depends=[1]), "inputFiles": ["case2.in"], "outputFiles": ["case2.out"]}], ["ignored", "ignored"], ["x", "x"], "points 0.5", None),
            ("compiled-AC", 0, [case()], ["5\n"], [], None, '#include <cstdio>\nint main(){int a,b;scanf("%d%d",&a,&b);printf("%d\\n",a+b);}'),
            ("compiled-WA", 0, [case()], ["5\n"], [], None, 'int main(){}'),
            ("compiled-CE", 0, [case()], ["5\n"], [], None, 'not a valid C++ program'),
            ("compiled-RE", 0, [case()], ["5\n"], [], None, 'int main(){return 7;}'),
            ("compiled-TLE", 0, [{**case(), "timeLimit": 200}], ["5\n"], [], None, 'int main(){volatile unsigned long long x=0;for(;;)++x;}'),
        ])
        if shutil.which("python", path=ENV["PATH"]):
            scenarios.extend([
                ("python-AC", 0, [{**case(), "timeLimit": 1000}], ["5\n"], [], None, {"python": "print(sum(map(int,input().split())))\n"}),
                ("python-WA", 0, [{**case(), "timeLimit": 1000}], ["5\n"], [], None, {"python": "print(0)\n"}),
            ])
        if shutil.which("diff", path=ENV["PATH"]):
            scenarios.append(("external-diff", 2, [case()], ["same\n"], ["same\n"], None, None))
        mismatches = []
        for index, (name, mode, groups, outputs, answers, checker_text, program) in enumerate(scenarios):
            work = root / str(index)
            data = work / "data"
            source = work / "source" / "alice"
            data.mkdir(parents=True)
            source.mkdir(parents=True)
            if mode >= 4:
                shutil.copy2(checker, data / checker.name)
            for i, output in enumerate(outputs, 1):
                (data / f"case{i}.in").write_text(checker_text or "2 3\n", encoding="utf-8")
                (data / f"case{i}.out").write_bytes(output.encode())
                if program is None and answers[i - 1] is not None:
                    (source / f"case{i}.out").write_bytes(answers[i - 1].encode())
            if program is not None:
                if isinstance(program, dict):
                    (source / "main.py").write_text(program["python"], encoding="utf-8")
                else:
                    (source / "main.cpp").write_text(program, encoding="utf-8")
            task = {"problemTitle": name, "sourceFileName": "main", "taskType": 1 if program is None else 0,
                    "comparisonMode": mode, "realPrecision": 6, "diffArguments": "-q", "specialJudge": checker.name,
                    "standardInputCheck": True, "standardOutputCheck": True, "answerFileExtension": "out", "testCases": groups}
            config = work / "task.json"
            config.write_text(json.dumps(task), encoding="utf-8")
            results = []
            for exe in [CURRENT, REFERENCE]:
                output = subprocess.check_output([exe, str(config)], cwd=work, env=ENV, stderr=subprocess.PIPE, timeout=60)
                results.append(json.loads(output.decode().strip().splitlines()[-1]))
            if results[0] != results[1]:
                mismatches.append({"case": name, "current": results[0], "reference": results[1]})
            else:
                print("PASS", name)
            expected = {"compiled-AC": 0, "compiled-WA": 1, "compiled-RE": 7, "compiled-TLE": 3, "python-AC": 0, "python-WA": 1}
            if name in expected:
                assert results[0]["compileState"] == 0 and results[0]["result"][0][0] == expected[name], (name, results)
            if name == "compiled-CE":
                assert results[0]["compileState"] == 2, (name, results)
        assert not mismatches, json.dumps(mismatches, indent=2)
        print(f"MATCH: {len(scenarios)} scenarios; verdicts, compile states, per-case scores and totals agree")


if __name__ == "__main__":
    run()
