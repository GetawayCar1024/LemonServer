"""Extract the unmodified judging sources from the LemonLime commit this fork is based on.
Usage: python tests/judging-compat/prepare_reference.py <output-directory>
"""
import hashlib
from pathlib import Path
import subprocess
import sys

REFERENCE = "69aa22370706a4f14b394a6e27aa92e7eca4a8f5"
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
print("Reference:", REFERENCE)
