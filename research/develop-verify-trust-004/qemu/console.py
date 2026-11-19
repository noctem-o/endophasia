#!/usr/bin/env python3
# DEVELOP-VERIFY-TRUST-004 serial console driver (adapted from TRUST-003 qemu/console-driver.py).
#   console.py '<shell command>' [timeout]   run one command on the guest root console, print its output and [rc=N]
#   console.py put <host file> <guest path>  copy a small file through the console (base64), print its guest sha256
import os, sys, time, re, secrets, base64, subprocess, errno, shlex, select, math
from pathlib import Path
W = os.path.join(os.environ.get("ENDO13_WORK", os.path.expanduser("~/.capy/work/endo13")), "vm")
log = os.path.join(W, "console.log")
def put(src, dst):
    data = base64.b64encode(Path(src).read_bytes()).decode()
    tmp, dst = shlex.quote(dst + ".b64"), shlex.quote(dst)
    commands = []
    for i in range(0, max(1, len(data)), 3000):
        op = ">>" if i else ">"
        commands.append(f"printf %s {shlex.quote(data[i:i+3000])} {op} {tmp}")
    commands.append(f"base64 -d -- {tmp} > {dst} && rm -- {tmp} && sha256sum -- {dst}")
    for cmd in commands:
        r = subprocess.run([os.path.abspath(__file__), cmd, "30"], stdout=subprocess.PIPE, text=True)
        lines = r.stdout.splitlines()
        marker = re.fullmatch(r"\[rc=(\d{1,3})\]", lines[-1]) if lines else None
        guest_rc = int(marker[1]) if marker and int(marker[1]) <= 255 else 1
        if r.returncode or guest_rc:
            sys.stdout.write(r.stdout)
            return r.returncode or guest_rc
    sys.stdout.write(r.stdout)
    return 0

def command(cmd, timeout):
    if not math.isfinite(timeout):
        raise ValueError("timeout must be finite")
    deadline = time.monotonic() + timeout
    tok = secrets.token_hex(4)
    start = os.path.getsize(log)
    payload = ("{ " + cmd + "\n} </dev/null; printf '\\n__%s_%s__ rc=%s\\n' DONE " + tok + ' "$?"\n').encode()
    pat = re.compile(r"__DONE_" + tok + r"__ rc=(\d+)")
    data = ""
    while (left := deadline - time.monotonic()) > 0:
        try:
            fd = os.open(os.path.join(W, "con.in"), os.O_WRONLY | os.O_NONBLOCK)
        except OSError as e:
            if e.errno != errno.ENXIO:
                raise
            time.sleep(min(left, 0.05))
            continue
        try:
            while payload and (left := deadline - time.monotonic()) > 0:
                if select.select([], [fd], [], left)[1]:
                    try:
                        payload = payload[os.write(fd, payload):]
                    except BlockingIOError:
                        continue
        finally:
            os.close(fd)
        break
    while not payload and (left := deadline - time.monotonic()) > 0:
        with open(log, "rb") as f:
            f.seek(start); data = f.read().decode("utf-8", "replace").replace("\r", "")
        m = pat.search(data)
        if m:
            sys.stdout.write(data[:m.start()]); print("[rc=%s]" % m.group(1)); return 0
        time.sleep(min(left, 0.5))
    sys.stdout.write(data[-6000:]); print("[TIMEOUT]"); return 124

if __name__ == "__main__":
    if sys.argv[1] == "put":
        sys.exit(put(sys.argv[2], sys.argv[3]))
    sys.exit(command(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 120))
