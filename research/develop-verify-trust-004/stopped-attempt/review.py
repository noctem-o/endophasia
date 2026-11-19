"""Offline review of observed metadata; never launches a guest or grants access."""
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
