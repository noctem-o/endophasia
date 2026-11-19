#!/usr/bin/env python3
# DEVELOP-VERIFY-TRUST-004 (ENDO-13): reading the kernel's answers out of strace output. Parsing only; runs nothing.
#   traces.py refusals <run-k.strace>            the matrix's required OS refusals (TRUST-003 RESULTS invariants 1-4), each grounded in
#                                                one syscall line: the syscall, its target and its errno. ENOENT and tool errors never count.
#   traces.py identity <dir> <agent uid> <agent gid> [grader uid]
#                                                the trusted reader's children, from strace -ff files (<dir>/t.<pid>): the credentials each
#                                                process had, by the kernel's return values, when it executed Git and bubblewrap.
import json, os, re, sys

LINE = re.compile(r"^(?:(\d+)\s+)?(?:\d\d:\d\d:\d\d\.\d+\s+)?(\w+)\((.*)\)\s+=\s+(-?\d+|\?)(?:\s+(\w+))?")

REQUIRED = {
    "T6 staged candidate chmod": (r"^chmod$|^fchmodat2?$", r'"/var/lib/endo-verify-002/work/[0-9a-f]{32}/candidate"', "EACCES"),
    "T7 verifier code write-open": (r"^openat2?$|^open$", r'"/usr/local/lib/endo-verify-002/.*/service/verifier\.ts", O_(?:WRONLY|RDWR)', "EACCES"),
    "T7 verifier unit drop-in": (r"^mkdir(?:at)?$", r'"/etc/systemd/user/endo-verify-002@\.service\.d"', "EACCES"),
    "T8 record create": (r"^openat2?$|^open$", r'"/var/lib/endo-verify-002/records/[0-9a-f]{32}\.json", O_WRONLY\|O_CREAT', "EACCES"),
    "T8 record symlink": (r"^symlink(?:at)?$", r'"/var/lib/endo-verify-002/records/[0-9a-f]{32}\.json"', "EACCES"),
    "T10 instance SIGKILL": (r"^kill$", r"^\d+, SIGKILL$", "EPERM"),
    "E6 oracle read": (r"^openat2?$|^open$", r'"/usr/local/lib/endo-verify-002/oracle/roman-numerals-cli/manifest\.json"', "EACCES"),
    "E6 instance environ": (r"^openat2?$|^open$", r'"/proc/\d+/environ"', "EACCES"),
    "E6 instance signal 0": (r"^kill$", r"^\d+, 0$", "EPERM"),
}

def refusals(path):
    found = {k: [] for k in REQUIRED}
    lines = 0
    with open(path, errors="replace") as f:
        for raw in f:
            lines += 1
            m = LINE.match(raw.strip())
            if not m or m.group(4) != "-1":
                continue
            call, args, errno = m.group(2), m.group(3), m.group(5)
            for k, (c, a, e) in REQUIRED.items():
                if re.search(c, call) and re.search(a, args) and errno == e:
                    found[k].append(raw.strip())
    return {"trace": path, "lines": lines, "observed": {k: v[:3] for k, v in found.items()},
            "missing": [k for k, v in found.items() if not v], "held": lines > 0 and all(found.values())}

CRED = {"setuid", "setreuid", "setresuid", "setgid", "setregid", "setresgid", "setgroups", "prctl", "execve", "chdir"}

def identity(d, auid, agid, guid):
    execs, chdir_refused = [], []
    for name in sorted(os.listdir(d)):
        pid = name.rsplit(".", 1)[-1]
        cred = {"uid": [0, 0, 0], "gid": [0, 0, 0], "groups": None, "nnp": False}
        with open(os.path.join(d, name), errors="replace") as f:
            for raw in f:
                m = LINE.match(raw.strip())
                if not m or m.group(2) not in CRED or m.group(4) != "0":
                    if m and m.group(2) == "chdir" and m.group(4) == "-1":
                        chdir_refused.append({"pid": pid, "line": raw.strip()})
                    continue
                call, args = m.group(2), [a.strip() for a in m.group(3).split(",")]
                ints = lambda xs: [int(x) for x in xs]
                if call in ("setresuid", "setreuid", "setuid", "setresgid", "setregid", "setgid"):
                    key = "uid" if "uid" in call else "gid"
                    v = ints(args)
                    if call.startswith("setres"):
                        cred[key] = [o if n == -1 else n for n, o in zip(v, cred[key])]
                    elif call.startswith("setre"):
                        r, e = v
                        old = cred[key]
                        nr = old[0] if r == -1 else r
                        ne = old[1] if e == -1 else e
                        ns = ne if (r != -1 or (e != -1 and e != old[0])) else old[2]
                        cred[key] = [nr, ne, ns]
                    else:
                        cred[key] = [v[0]] * 3 if cred["uid"][1] == 0 else [cred[key][0], v[0], cred[key][2]]
                elif call == "setgroups":
                    cred["groups"] = [] if args[0] == "0" else m.group(3)
                elif call == "prctl" and args[0] == "PR_SET_NO_NEW_PRIVS" and args[1] == "1":
                    cred["nnp"] = True
                elif call == "execve":
                    path = args[0].strip('"')
                    if path in ("/usr/bin/git", "/usr/bin/bwrap"):
                        sub = re.findall(r'"([^"]*)"', m.group(3))
                        execs.append({"pid": pid, "path": path, "argv": sub[1:14], "graderLaunch": "/work" in sub and "--clearenv" in sub, "uid": list(cred["uid"]), "gid": list(cred["gid"]),
                                      "groups": cred["groups"], "noNewPrivs": cred["nnp"]})
    def ok(e, u, g):
        return e["uid"] == [u] * 3 and e["gid"] == [g] * 3 and e["groups"] == [] and e["noNewPrivs"]
    git = [e for e in execs if e["path"] == "/usr/bin/git"]
    bw = [e for e in execs if e["path"] == "/usr/bin/bwrap" and e["graderLaunch"]]
    detect = [e for e in execs if e["path"] == "/usr/bin/bwrap" and not e["graderLaunch"]]
    return {"dir": d, "gitExecs": len(git), "gitAsAgent": sum(ok(e, auid, agid) for e in git),
            "gitOther": [e for e in git if not ok(e, auid, agid)][:20], "gitSample": git[:3],
            "bwrapExecs": len(bw), "bwrapAsGrader": sum(ok(e, guid, guid) for e in bw),
            "bwrapOther": [e for e in bw if not ok(e, guid, guid)][:20], "bwrapSample": bw[:2],
            "bwrapDetectionAsCaller": len(detect), "detectionSample": detect[:2],
            "chdirRefused": chdir_refused[:20], "chdirRefusedCount": len(chdir_refused),
            "held": len(git) > 0 and all(ok(e, auid, agid) for e in git) and len(bw) > 0 and all(ok(e, guid, guid) for e in bw)}

if __name__ == "__main__":
    if sys.argv[1] == "refusals":
        r = refusals(sys.argv[2])
    elif sys.argv[1] == "identity":
        r = identity(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]) if len(sys.argv) > 5 else 65534)
    else:
        sys.exit(64)
    print(json.dumps(r, indent=1))
    sys.exit(0 if r["held"] else 1)
