"""Review the two intended census entries; reject missing observations."""
import grp
import json
import os
from pathlib import Path
import pwd
import stat
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Entry:
    kind: str
    uid: int
    gid: int
    mode: int
    target: str = ""


SOCKET = "/run/endo-verify-002/verify.sock"
MASK = "/var/lib/endo-verify-002-home/.config/systemd/user/p11-kit-server.socket"


def submission(path, entry, parent, members, writable_nodes, verifier_uid):
    return (
        verifier_uid not in (0, 1500)
        and verifier_uid > 0
        and path == SOCKET
        and entry == Entry("socket", verifier_uid, verifier_uid, 0o666)
        and parent == Entry("directory", verifier_uid, 1500, 0o750)
        and members == {1500}
        and writable_nodes == {SOCKET}
    )


def installer_mask(path, entry, protected_ancestors):
    return (
        path == MASK
        and entry == Entry("symlink", 0, 0, 0o777, "/dev/null")
        and protected_ancestors is True
    )

def metadata(path):
    s = os.lstat(path)
    kind = {stat.S_IFDIR: "directory", stat.S_IFSOCK: "socket",
            stat.S_IFLNK: "symlink"}.get(stat.S_IFMT(s.st_mode), "other")
    return Entry(kind, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode),
                 os.readlink(path) if kind == "symlink" else "")


def ancestors():
    return sorted({str(p) for path in (MASK, SOCKET) for p in Path(path).parents})


def agent_observation():
    if os.getresuid() != (1500,) * 3 or os.getresgid() != (1500,) * 3 or set(os.getgroups()) - {1500}:
        raise ValueError("unexpected census identity")
    writable = lambda p: os.access(p, os.W_OK, effective_ids=True)
    pending = [Path(SOCKET).parent]
    nodes = []
    while pending:
        for p in pending.pop().iterdir():
            if writable(p):
                nodes.append(str(p))
            if stat.S_ISDIR(p.lstat().st_mode):
                pending.append(p)
    return {"writable": nodes, "writable_parents": [p for p in ancestors() if writable(p)],
            "uid": os.geteuid(), "gid": os.getegid(), "groups": os.getgroups()}


def review(observed, lines):
    verifier = pwd.getpwnam("endo-verify-002")
    group = grp.getgrgid(1500)
    members = {p.pw_uid for p in pwd.getpwall() if p.pw_gid == group.gr_gid}
    members.update(pwd.getpwnam(name).pw_uid for name in group.gr_mem)
    protected = observed["writable_parents"] == [] and all(
        (e := metadata(p)).kind == "directory" and e.uid == (
            verifier.pw_uid if p == str(Path(SOCKET).parent) else 0)
        and not e.mode & 0o022 for p in ancestors())
    if not (protected and observed["uid"] == observed["gid"] == 1500
            and not set(observed["groups"]) - {1500} and group.gr_name == "endoagent"
            and submission(SOCKET, metadata(SOCKET), metadata(Path(SOCKET).parent),
                           members, set(observed["writable"]), verifier.pw_uid)
            and installer_mask(MASK, metadata(MASK), protected)):
        raise ValueError("required endpoint or mask observations did not match")
    runtime = "/run/user/1500"
    return [line for line in lines if line not in {MASK, SOCKET, "writable-socket " + SOCKET}
            and not ((p := line.removeprefix("writable-socket ")) == runtime or p.startswith(runtime + "/"))]


if __name__ == "__main__":
    if sys.argv[1:] == ["agent"]:
        print(json.dumps(agent_observation()))
    else:
        observed, census = map(Path, sys.argv[1:])
        rejected = review(json.loads(observed.read_text()), census.read_text().splitlines())
        for line in rejected:
            print(line)
        sys.exit(bool(rejected))
