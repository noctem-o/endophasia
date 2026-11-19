# DEVELOP-VERIFY-TRUST-003 guest run: attacker probe. Run as the restricted agent (uid 1500) inside the disposable guest only,
# under strace, against the installed TRUST-002 verifier. Every attempt is a real system call; the result is the kernel's answer.
#   python3 -I probe.py <label> [pid ...]      (no pids: every process of the verifier principal)
import ctypes, errno, json, os, pwd, resource, signal, socket, sys

V = pwd.getpwnam("endo-verify-002")
LIB = "/usr/local/lib/endo-verify-002"
STATE = "/var/lib/endo-verify-002"
RUN = "/run/endo-verify-002"
VRUN = "/run/user/%d" % V.pw_uid
libc = ctypes.CDLL(None, use_errno=True)
out = []
me = {"uid": os.getuid(), "euid": os.geteuid(), "gid": os.getgid(), "groups": os.getgroups()}


def attempt(invariant, op, target, fn, expect):
    try:
        fn()
        got = "ok"
    except OSError as e:
        got = errno.errorcode.get(e.errno, str(e.errno))
    row = {"invariant": invariant, "op": op, "target": target, "result": got, "expected": expect, "held": got in expect}
    # A path that does not exist yet (records/, work/, journal/ before the first request) tests nothing and changed nothing: not applicable.
    if got == "ENOENT":
        row["held"] = None
        row["note"] = "not applicable: path absent"
    out.append(row)


def cerr(r):
    if r == -1:
        e = ctypes.get_errno()
        raise OSError(e, os.strerror(e))


def openw(p, flags=os.O_WRONLY):
    return lambda: os.close(os.open(p, flags))


def creat(p):
    return lambda: os.close(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))


def write_file(p, data):
    def f():
        fd = os.open(p, os.O_WRONLY)
        try:
            os.write(fd, data)
        finally:
            os.close(fd)
    return f


DENY = ("EACCES", "EPERM", "EROFS")
first_record = next((n for n in sorted(os.listdir(STATE + "/records")) if n.endswith(".json")), None) if os.access(STATE + "/records", os.R_OK | os.X_OK) else None

# 1. Verifier integrity: implementation, dependencies, configuration.
code = LIB + "/research/develop-verify-trust-002/service/verifier.ts"
for p in [code, LIB + "/research/develop-verify-trust-002/service/records.ts", LIB + "/adapters/sandbox/bubblewrap.ts",
          LIB + "/runtime/contracts/canonical-json.ts", LIB + "/package.json", LIB + "/installation.json",
          "/usr/bin/node", "/usr/bin/bwrap", "/usr/bin/systemd-run", os.path.realpath("/usr/bin/python3"), "/usr/lib/libc.so.6",
          "/etc/systemd/user/endo-verify-002.socket", "/etc/systemd/user/endo-verify-002@.service",
          "/etc/sysusers.d/endo-verify-002.conf", "/etc/tmpfiles.d/endo-verify-002.conf"]:
    attempt("1-verifier", "open(O_WRONLY)", p, openw(p), DENY + ("ETXTBSY",))
attempt("1-verifier", "rename", code, lambda: os.rename(code, code + ".x"), DENY)
attempt("1-verifier", "unlink", code, lambda: os.unlink(code), DENY)
attempt("1-verifier", "chmod", code, lambda: os.chmod(code, 0o666), DENY)
attempt("1-verifier", "utime", code, lambda: os.utime(code, (0, 0)), DENY)
attempt("1-verifier", "open(O_CREAT)", LIB + "/research/develop-verify-trust-002/service/evil.ts", creat(LIB + "/research/develop-verify-trust-002/service/evil.ts"), DENY)
attempt("1-verifier", "mkdir", "/etc/systemd/user/endo-verify-002@.service.d", lambda: os.mkdir("/etc/systemd/user/endo-verify-002@.service.d"), DENY + ("EEXIST",))
attempt("1-verifier", "open(O_CREAT)", "/var/lib/endo-verify-002-home/.config/systemd/user/evil.service", creat("/var/lib/endo-verify-002-home/.config/systemd/user/evil.service"), DENY)
attempt("1-verifier", "unlink", "/var/lib/systemd/linger/endo-verify-002", lambda: os.unlink("/var/lib/systemd/linger/endo-verify-002"), DENY)
attempt("1-verifier", "mkdir", VRUN + "/systemd/user.control/endo-verify-002@.service.d", lambda: os.makedirs(VRUN + "/systemd/user.control/endo-verify-002@.service.d"), DENY)

# 2. Evaluator integrity: oracle, expected outputs, staging, driver.
for p in [LIB + "/oracle/roman-numerals-cli/manifest.json", LIB + "/oracle/roman-numerals-cli/reference/roman.mjs",
          LIB + "/oracle/roman-numerals-cli/negative/roman.mjs"]:
    attempt("2-evaluator", "open(O_RDONLY)", p, openw(p, os.O_RDONLY), DENY)
    attempt("2-evaluator", "open(O_WRONLY)", p, openw(p), DENY)
attempt("2-evaluator", "open(O_CREAT)", LIB + "/oracle/roman-numerals-cli/manifest2.json", creat(LIB + "/oracle/roman-numerals-cli/manifest2.json"), DENY)
attempt("2-evaluator", "rename", LIB + "/oracle", lambda: os.rename(LIB + "/oracle", LIB + "/oracle.x"), DENY)
attempt("2-evaluator", "opendir", STATE + "/work", lambda: os.listdir(STATE + "/work"), DENY)
attempt("2-evaluator", "open(O_CREAT)", STATE + "/work/evil", creat(STATE + "/work/evil"), DENY)
attempt("2-evaluator", "rename", STATE + "/work", lambda: os.rename(STATE + "/work", STATE + "/work.x"), DENY)
attempt("2-evaluator", "symlink", STATE + "/work/x", lambda: os.symlink("/tmp", STATE + "/work/x"), DENY)

# 3. Record integrity.
fake = "%032x.json" % 0xDEAD
attempt("3-records", "open(O_CREAT)", STATE + "/records/" + fake, creat(STATE + "/records/" + fake), DENY)
attempt("3-records", "open(O_CREAT)", STATE + "/journal/" + fake, creat(STATE + "/journal/" + fake), DENY)
attempt("3-records", "symlink", STATE + "/records/" + fake, lambda: os.symlink("/tmp/x", STATE + "/records/" + fake), DENY)
attempt("3-records", "rename", STATE + "/records", lambda: os.rename(STATE + "/records", STATE + "/records.x"), DENY)
attempt("3-records", "open(O_CREAT)", STATE + "/evil", creat(STATE + "/evil"), DENY)
if first_record is not None:
    rec = STATE + "/records/" + first_record
    attempt("3-records", "open(O_WRONLY)", rec, openw(rec), DENY)
    attempt("3-records", "unlink", rec, lambda: os.unlink(rec), DENY)
    attempt("3-records", "rename", rec, lambda: os.rename(rec, rec + ".x"), DENY)
    attempt("3-records", "chmod", rec, lambda: os.chmod(rec, 0o666), DENY)
    attempt("3-records", "link", rec, lambda: os.link(rec, os.path.expanduser("~/hardlink-" + first_record)), DENY)
attempt("3-records", "unlink", RUN + "/verify.sock", lambda: os.unlink(RUN + "/verify.sock"), DENY)
attempt("3-records", "open(O_CREAT)", RUN + "/evil.sock", creat(RUN + "/evil.sock"), DENY)

# 4. Process isolation: the verifier principal's processes (its user manager always; an instance and sandbox when one is running).
pids = [int(a) for a in sys.argv[2:]] or [int(p) for p in os.listdir("/proc") if p.isdigit() and os.stat("/proc/" + p).st_uid == V.pw_uid]


class IOV(ctypes.Structure):
    _fields_ = [("base", ctypes.c_void_p), ("len", ctypes.c_size_t)]


libc.syscall.restype = ctypes.c_long
libc.ptrace.restype = ctypes.c_long
for pid in pids:
    try:
        comm = open("/proc/%d/comm" % pid).read().strip()
    except OSError as e:
        comm = "?" + errno.errorcode.get(e.errno, "")
    t = "pid %d (%s) uid %d" % (pid, comm, V.pw_uid)
    for f in ["environ", "mem", "maps", "auxv", "stack", "syscall"]:
        attempt("4-process", "open(/proc/pid/%s)" % f, t, openw("/proc/%d/%s" % (pid, f), os.O_RDONLY), DENY)
    attempt("4-process", "opendir(/proc/pid/fd)", t, lambda: os.listdir("/proc/%d/fd" % pid), DENY)
    attempt("4-process", "readlink(/proc/pid/cwd)", t, lambda: os.readlink("/proc/%d/cwd" % pid), DENY)
    attempt("4-process", "write(/proc/pid/oom_score_adj)", t, write_file("/proc/%d/oom_score_adj" % pid, b"1000"), DENY)
    buf = ctypes.create_string_buffer(64)
    local = IOV(ctypes.cast(buf, ctypes.c_void_p), 64)
    remote = IOV(ctypes.c_void_p(0x400000), 64)
    attempt("4-process", "process_vm_readv", t, lambda: cerr(libc.syscall(ctypes.c_long(310), ctypes.c_long(pid), ctypes.byref(local), ctypes.c_long(1), ctypes.byref(remote), ctypes.c_long(1), ctypes.c_long(0))), ("EPERM",))
    attempt("4-process", "ptrace(PTRACE_ATTACH)", t, lambda: cerr(libc.ptrace(ctypes.c_long(16), ctypes.c_long(pid), None, None)), ("EPERM",))
    attempt("4-process", "ptrace(PTRACE_SEIZE)", t, lambda: cerr(libc.ptrace(ctypes.c_long(0x4206), ctypes.c_long(pid), None, None)), ("EPERM",))
    for name, sig in [("0", 0), ("SIGSTOP", signal.SIGSTOP), ("SIGTERM", signal.SIGTERM), ("SIGKILL", signal.SIGKILL)]:
        attempt("4-process", "kill(%s)" % name, t, lambda: os.kill(pid, sig), ("EPERM",))

    def pidfd_kill():
        fd = os.pidfd_open(pid)
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        finally:
            os.close(fd)
    attempt("4-process", "pidfd_send_signal(SIGKILL)", t, pidfd_kill, ("EPERM",))
    attempt("4-process", "setpriority(19)", t, lambda: os.setpriority(os.PRIO_PROCESS, pid, 19), ("EPERM", "EACCES"))
    attempt("4-process", "sched_setaffinity", t, lambda: os.sched_setaffinity(pid, {0}), ("EPERM",))
    attempt("4-process", "prlimit(RLIMIT_CPU)", t, lambda: resource.prlimit(pid, resource.RLIMIT_CPU, (1, 1)), ("EPERM",))
    attempt("4-process", "ioprio_set", t, lambda: cerr(libc.syscall(ctypes.c_long(251), ctypes.c_long(1), ctypes.c_long(pid), ctypes.c_long(3 << 13))), ("EPERM",))
    try:
        cg = open("/proc/%d/cgroup" % pid).read().strip().split("::", 1)[1]
        for f in ["cgroup.procs", "cgroup.freeze", "cgroup.kill", "memory.max"]:
            p = "/sys/fs/cgroup" + cg + "/" + f
            attempt("4-process", "write(%s)" % f, p, write_file(p, str(os.getpid()).encode() if f == "cgroup.procs" else b"1"), DENY + ("ENOENT",))
    except (OSError, IndexError):
        pass
for p in [VRUN + "/bus", VRUN + "/systemd/private"]:
    def conn(p=p):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(p)
        finally:
            s.close()
    attempt("4-process", "connect", p, conn, DENY)
attempt("4-process", "opendir", VRUN, lambda: os.listdir(VRUN), DENY)

print(json.dumps({"label": sys.argv[1] if len(sys.argv) > 1 else "", "principal": me, "verifierUid": V.pw_uid, "pids": pids,
                  "attempts": out, "held": all(a["held"] is not False for a in out),
                  "applicable": sum(1 for a in out if a["held"] is not None)}, indent=1))
