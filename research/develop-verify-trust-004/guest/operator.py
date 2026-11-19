#!/usr/bin/env python3
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): the evidence operator's interruptions, as guest root. Research only.
# A process is targeted only after it is identified live, by attributes read while a pidfd holds it: the verifier's uid, a cgroup
# inside that principal's user manager whose leaf is an endo-verify-002@ instance service, and a "service/verifier.ts serve" command
# line. A previously recorded PID is never a target. The signal goes through the same pidfd, so a recycled PID cannot be hit.
#   operator.py census            every process of the verifier principal, with attributes
#   operator.py kill-instance     T10: SIGKILL exactly one identified instance; refuses unless there is exactly one
#   operator.py restart-manager   E3: identify user@<uid>.service and its manager, then restart that unit
import json, os, select, signal, subprocess, sys, time

def run(*argv):
    return subprocess.run(argv, capture_output=True, text=True)

def attrs(pid):
    st = os.stat("/proc/%d" % pid)
    with open("/proc/%d/cmdline" % pid, "rb") as f:
        cmd = [c.decode("utf-8", "replace") for c in f.read().split(b"\0") if c]
    with open("/proc/%d/cgroup" % pid) as f:
        cg = f.read().strip()
    with open("/proc/%d/stat" % pid) as f:
        start = f.read().rsplit(")", 1)[1].split()[19]
    return {"pid": pid, "uid": st.st_uid, "cmdline": cmd, "cgroup": cg, "starttime": start}

def is_instance(a):
    leaf = a["cgroup"].rsplit("/", 1)[-1]
    return (a["uid"] == VUID and "/user@%d.service/" % VUID in a["cgroup"] and leaf.startswith("endo-verify-002@")
            and leaf.endswith(".service") and any(c.endswith("service/verifier.ts") for c in a["cmdline"]) and "serve" in a["cmdline"])

def census():
    out = []
    for p in sorted(int(p) for p in os.listdir("/proc") if p.isdigit()):
        try:
            a = attrs(p)
        except (FileNotFoundError, ProcessLookupError):
            continue
        if a["uid"] == VUID:
            a["instance"] = is_instance(a)
            out.append(a)
    return out

def kill_instance():
    report = {"at": time.time(), "verifierUid": VUID, "census": census()}
    found = [a for a in report["census"] if a["instance"]]
    if len(found) != 1:
        report["action"] = "refused: %d identified instances" % len(found)
        return report, 2
    target = found[0]
    try:
        fd = os.pidfd_open(target["pid"])
    except ProcessLookupError:
        report["action"] = "refused: target exited before pidfd open"
        return report, 2
    try:
        again = attrs(target["pid"])
        signal.pidfd_send_signal(fd, 0)
        if {k: again[k] for k in ("uid", "cmdline", "cgroup", "starttime")} != {k: target[k] for k in ("uid", "cmdline", "cgroup", "starttime")}:
            report["action"] = "refused: identity changed between census and pidfd"
            return report, 2
        report["target"] = again
        signal.pidfd_send_signal(fd, signal.SIGKILL)
        report["action"] = "SIGKILL sent through pidfd"
        ready, _, _ = select.select([fd], [], [], 10)
        report["exitObserved"] = bool(ready)
    except (FileNotFoundError, ProcessLookupError):
        report["action"] = "refused: target exited before the signal"
        return report, 2
    finally:
        os.close(fd)
    report["censusAfter"] = census()
    return report, 0 if report["exitObserved"] else 3

def restart_manager():
    unit = "user@%d.service" % VUID
    def show():
        r = run("/usr/bin/systemctl", "show", "-p", "MainPID", "-p", "ActiveState", "-p", "InvocationID", "-p", "User", unit)
        return dict(l.split("=", 1) for l in r.stdout.strip().splitlines())
    report = {"at": time.time(), "unit": unit, "before": show(), "census": census()}
    main = int(report["before"].get("MainPID", "0"))
    try:
        manager = attrs(main) if main > 0 else None
    except (FileNotFoundError, ProcessLookupError):
        report["action"] = "refused: manager exited during identification"
        return report, 2
    report["manager"] = manager
    if report["before"].get("ActiveState") != "active" or manager is None or manager["uid"] != VUID or manager["cmdline"][:2] != ["/usr/lib/systemd/systemd", "--user"]:
        report["action"] = "refused: unit or manager not identified"
        return report, 2
    r = run("/usr/bin/systemctl", "restart", unit)
    report["action"] = "systemctl restart %s exit=%d" % (unit, r.returncode)
    report["after"] = show()
    return report, 0 if r.returncode == 0 else 3

if __name__ == "__main__":
    VUID = int(run("/usr/bin/id", "-u", "endo-verify-002").stdout.strip())
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "census":
        rep, rc = census(), 0
    elif cmd == "kill-instance":
        rep, rc = kill_instance()
    elif cmd == "restart-manager":
        rep, rc = restart_manager()
    else:
        print("usage: operator.py census|kill-instance|restart-manager", file=sys.stderr); sys.exit(64)
    print(json.dumps(rep, indent=1))
    sys.exit(rc)
