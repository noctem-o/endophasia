#!/usr/bin/env python3
# DEVELOP-VERIFY-TRUST-004 serial console driver (adapted from TRUST-003 qemu/console-driver.py).
#   console.py '<shell command>' [timeout]   run one command on the guest root console, print its output and [rc=N]
#   console.py put <host file> <guest path>  copy a small file through the console (base64), print its guest sha256
import os, sys, time, re, secrets, base64, subprocess
W = os.path.join(os.environ.get("ENDO13_WORK", os.path.expanduser("~/.capy/work/endo13")), "vm")
log = os.path.join(W, "console.log")
if sys.argv[1] == "put":
    data = base64.b64encode(open(sys.argv[2], "rb").read()).decode()
    dst = sys.argv[3]
    me = os.path.abspath(sys.argv[0])
    for n, i in enumerate(range(0, len(data), 3000)):
        op = ">" if n == 0 else ">>"
        r = subprocess.run([me, "printf %s " + data[i:i+3000] + " " + op + " " + dst + ".b64", "30"], capture_output=True, text=True)
        if "[rc=0]" not in r.stdout:
            print(r.stdout); sys.exit(1)
    r = subprocess.run([me, "base64 -d " + dst + ".b64 > " + dst + " && rm " + dst + ".b64 && sha256sum " + dst, "30"], capture_output=True, text=True)
    print(r.stdout); sys.exit(0)
cmd = sys.argv[1]
timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 120
tok = secrets.token_hex(4)
start = os.path.getsize(log)
with open(os.path.join(W, "con.in"), "w") as f:
    f.write("{ " + cmd + "\n} </dev/null; printf '\\n__%s_%s__ rc=%s\\n' DONE " + tok + ' "$?"\n')
pat = re.compile(r"__DONE_" + tok + r"__ rc=(\d+)")
deadline = time.time() + timeout
while True:
    with open(log, "rb") as f:
        f.seek(start); data = f.read().decode("utf-8", "replace").replace("\r", "")
    m = pat.search(data)
    if m:
        sys.stdout.write(data[:m.start()]); print("[rc=%s]" % m.group(1)); sys.exit(0)
    if time.time() > deadline:
        sys.stdout.write(data[-6000:]); print("[TIMEOUT]"); sys.exit(124)
    time.sleep(0.5)
