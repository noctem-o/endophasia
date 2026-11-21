"""DEVELOP-VERIFY-TRUST-004 Amendment 11: copy one agent-owned regular file to standard output, as root, without following links.

  agentfile.py <home> <relative path> <uid>

Every path component is opened relative to the previous one with O_NOFOLLOW, so a symbolic link anywhere is refused. The file must be a
regular file owned by <uid> and at most 256 MiB; it is opened non-blocking, so a FIFO is refused instead of hanging. Exit 0 copied,
3 absent, 1 refused (reason on standard error); 3 is not an exit status the interpreter itself uses.
"""

import os
import stat
import sys

LIMIT = 256 << 20


def refuse(reason):
    print(f"refused {sys.argv[2]}: {reason}", file=sys.stderr)
    return 1


def main(home, rel, uid):
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return refuse("not a plain relative path")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
    try:
        fd = os.open(home, flags | os.O_DIRECTORY)
        for p in parts[:-1]:
            nxt = os.open(p, flags | os.O_DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = nxt
        f = os.open(parts[-1], flags | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return 3
    except OSError as e:
        return refuse(os.strerror(e.errno))
    st = os.fstat(f)
    if not stat.S_ISREG(st.st_mode):
        return refuse("not a regular file")
    if st.st_uid != uid:
        return refuse(f"owned by uid {st.st_uid}")
    if st.st_size > LIMIT:
        return refuse("too large")
    data = os.read(f, LIMIT + 1)
    while len(data) <= LIMIT:
        more = os.read(f, LIMIT + 1 - len(data))
        if not more:
            break
        data += more
    if len(data) > LIMIT:
        return refuse("too large")
    sys.stdout.buffer.write(data)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4 or not sys.argv[3].isdigit():
        print("usage: agentfile.py <home> <relative path> <uid>", file=sys.stderr)
        sys.exit(64)
    sys.exit(main(sys.argv[1], sys.argv[2], int(sys.argv[3])))
