"""Observe only the protected CLI's sockets, plus a collision on host port 18080."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(sys.argv[1]).resolve()
seen = set()
samples = 0

def sockets(*options):
    return subprocess.check_output(["/usr/bin/ss", "-H", *options], text=True, timeout=5).splitlines()

def bridge_free():
    if sockets("-ltnp", "sport = :18080"):
        raise RuntimeError("host port 18080 occupied; no authorization to change it")

bridge_free()
env = {"HOME": str(root / "home"), "PATH": "/usr/bin", "LANG": "C", "XDG_RUNTIME_DIR": os.environ["XDG_RUNTIME_DIR"]}
with subprocess.Popen(["/usr/bin/node", "cli/index.ts", "experiment", "protected-run", str(root / "spec.json"),
                       "--out", str(root / "result")], env=env) as controller:
    deadline = time.monotonic() + 240
    try:
        while controller.poll() is None:
            if time.monotonic() > deadline:
                raise TimeoutError("protected run exceeded 240s")
            bridge_free()
            for option in ("-ltnp", "-lxnp"):
                for line in sockets(option):
                    if f"pid={controller.pid}," in line:
                        seen.add((option, line.split()[3] if option == "-ltnp" else line.split()[4]))
            samples += 1
            time.sleep(0.025)
    finally:
        if controller.poll() is None:
            controller.terminate()
            controller.wait(timeout=10)
bridge_free()
remaining = []
for option, address in sorted(seen):
    if any(address == (line.split()[3] if option == "-ltnp" else line.split()[4]) for line in sockets(option)):
        remaining.append(address)
print(json.dumps({"controller": controller.pid, "samples": samples, "host18080": "absent in every sample",
                  "observed": sorted(seen), "stillListeningAfterExit": remaining, "cliExit": controller.returncode}))
if remaining:
    raise RuntimeError("endpoint still present after controller exit")
sys.exit(controller.returncode)
