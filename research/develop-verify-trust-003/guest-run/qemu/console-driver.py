#!/usr/bin/env python3
import os, sys, time, re, secrets
W = os.path.expanduser("~/.capy/work/endo11/vm")
log = os.path.join(W, "console.log")
if sys.argv[1] == "put":
    import base64, subprocess
    data = base64.b64encode(open(sys.argv[2], "rb").read()).decode()
    dst = sys.argv[3]
    me = os.path.abspath(sys.argv[0])
    first = True
    for i in range(0, len(data), 3000):
        op = ">" if first else ">>"
        first = False
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
        out = data[:m.start()]
        sys.stdout.write(out)
        print("[rc=%s]" % m.group(1)); sys.exit(0)
    if time.time() > deadline:
        sys.stdout.write(data[-6000:]); print("[TIMEOUT]"); sys.exit(124)
    time.sleep(0.5)
