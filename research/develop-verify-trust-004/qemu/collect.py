import hashlib
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


def collect(image, dest, size, digest):
    if not re.fullmatch(r"[1-9][0-9]{0,9}", size) or int(size) > 2**31:
        raise ValueError("invalid export size")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("invalid export digest")
    remaining = int(size)
    with os.fdopen(os.open(image, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as src:
        info = os.fstat(src.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size < remaining:
            raise ValueError("export image is not a sufficiently long regular file")
        dest.mkdir(mode=0o700, exist_ok=True)
        info = dest.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or any(dest.iterdir())):
            raise ValueError("destination must be an empty private directory")
        hashed = hashlib.sha256()
        with tempfile.NamedTemporaryFile(dir=dest) as staged:
            while remaining:
                block = src.read(min(remaining, 1 << 20))
                if not block:
                    raise ValueError("short export image")
                staged.write(block)
                hashed.update(block)
                remaining -= len(block)
            if hashed.hexdigest() != digest:
                raise ValueError("export digest mismatch")
            staged.flush()
            os.fsync(staged.fileno())
            os.link(staged.name, dest / "export.tar")
    print(f"export {size} bytes sha256 {digest} verified on the host")


if __name__ == "__main__":
    try:
        collect(sys.argv[1], Path(sys.argv[2]), *sys.argv[3:])
    except (OSError, ValueError) as exc:
        print(f"collect refused: {exc}", file=sys.stderr)
        sys.exit(65)
