"""Extract the unmodified judging sources from the LemonLime commit this fork is based on.
Usage: python tests/judging-compat/prepare_reference.py <output-directory>
"""
import hashlib
from pathlib import Path
import subprocess
import sys

REFERENCE = "69aa22370706a4f14b394a6e27aa92e7eca4a8f5"
MODEL_REFERENCE = "d082892e55c4dabc48e5d2c18a52b3da58866671"  # Last integer-score ABI, independent of the new double-score model.
root = Path(__file__).resolve().parents[2]
target = Path(sys.argv[1]).resolve()
target.mkdir(parents=True, exist_ok=True)
for name in ["casejudger.cpp", "taskjudger.cpp", "processrunner.cpp", "processrunner_win.cpp", "processrunner_unix.cpp"]:
    content = subprocess.check_output(["git", "show", REFERENCE + ":src/core/" + name], cwd=root)
    destination = target / name
    if destination.exists() and destination.read_bytes() != content:
        raise RuntimeError("Refusing to overwrite an unfamiliar reference file: " + str(destination))
    destination.write_bytes(content)
    print(name, hashlib.sha256(content).hexdigest())
for name in ["casejudger.h", "taskjudger.h", "processrunner.h", "processrunner_win.h", "processrunner_unix.h", "windowssandbox.h", "windowssandbox.cpp", "windowsprocessutils.h", "taskresult.h", "contest.h", "contestant.h", "task.h", "testcase.h", "subtaskdependencelib.h", "contestant.cpp", "task.cpp", "testcase.cpp"]:
    content = subprocess.check_output(["git", "show", MODEL_REFERENCE + ":src/core/" + name], cwd=root)
    destination = target / "core" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.read_bytes() != content:
        raise RuntimeError("Refusing to overwrite an unfamiliar reference model: " + str(destination))
    destination.write_bytes(content)
    print("core/" + name, hashlib.sha256(content).hexdigest())
print("Reference:", REFERENCE)
