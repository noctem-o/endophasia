import os
import re
import shutil
import stat
import sys
import tarfile
from pathlib import Path

CHECKOUT = Path(__file__).resolve().parents[3]
CHUNK = 1 << 20
MAX_BYTES = 2**31
MAX_PATHS = 100_000
BLOCK = tarfile.BLOCKSIZE


def pax_path(data):
    pos = 0
    fields = set()
    path = None
    while pos < len(data):
        match = re.match(rb"([1-9][0-9]{0,5}) ", data[pos:pos + 7])
        if not match:
            raise ValueError("invalid PAX record length")
        end = pos + int(match[1])
        record = data[pos + match.end():end]
        key, sep, value = record[:-1].partition(b"=")
        if end > len(data) or not record.endswith(b"\n") or not sep or key in fields:
            raise ValueError("invalid or repeated PAX record")
        fields.add(key)
        if key == b"path":
            path = value.decode("ascii")
        elif key not in (b"mtime", b"atime", b"ctime", b"SCHILY.acl.access", b"SCHILY.acl.default") and not key.startswith(b"SCHILY.xattr."):
            raise ValueError("unsupported PAX field")
        pos = end
    return path


def intake(src, dest):
    paths = {}
    explicit = set()
    extended = False
    override = None
    while True:
        header = src.read(BLOCK)
        if header == bytes(BLOCK):
            if extended or not explicit or src.read(BLOCK) != bytes(BLOCK):
                raise ValueError("invalid end of archive")
            while tail := src.read(CHUNK):
                if any(tail):
                    raise ValueError("nonzero trailing archive data")
            return
        member = tarfile.TarInfo.frombuf(header, "ascii", "strict")
        size = member.size
        if size < 0 or size > MAX_BYTES:
            raise ValueError("invalid member size")
        if member.type == tarfile.XHDTYPE:
            if extended or not 0 < size <= 65536:
                raise ValueError("invalid extended header")
            override = pax_path(src.read(size))
            extended = True
        else:
            directory = member.type == tarfile.DIRTYPE
            if member.type == tarfile.SYMTYPE:
                raise ValueError("symbolic link in archive")
            if member.type == tarfile.LNKTYPE:
                raise ValueError("hard link in archive")
            if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or member.linkname:
                raise ValueError("only regular files and directories are accepted")
            if directory and size:
                raise ValueError("directory has data")
            name = member.name if override is None else override
            if directory:
                name = name.removesuffix("/")
            parts = name.split("/")
            if len(name) > 4095 or len(parts) > 64 or any(
                    p in (".", "..") or not re.fullmatch(r"[a-zA-Z0-9._@+,=-]{1,255}", p) for p in parts):
                raise ValueError("unsafe member name")
            if name in explicit:
                raise ValueError("duplicate archive member")
            explicit.add(name)
            for i in range(1, len(parts) + 1):
                prefix = "/".join(parts[:i])
                is_dir = i < len(parts) or directory
                if prefix in paths:
                    if paths[prefix] != is_dir:
                        raise ValueError("conflicting archive paths")
                else:
                    if len(paths) >= MAX_PATHS:
                        raise ValueError("too many archive paths")
                    paths[prefix] = is_dir
                    if dest is not None and is_dir:
                        (dest / prefix).mkdir(mode=0o700)
            if not directory and dest is not None:
                with (dest / name).open("xb") as out:
                    remaining = size
                    while remaining:
                        block = src.read(min(CHUNK, remaining))
                        if not block:
                            raise ValueError("truncated member")
                        out.write(block)
                        remaining -= len(block)
            else:
                src.seek(size, os.SEEK_CUR)
            override = None
            extended = False
        padding = (-size) % BLOCK
        if src.read(padding) != bytes(padding):
            raise ValueError("invalid member padding")


def run(source, dest):
    if source.resolve().is_relative_to(CHECKOUT) or (dest and dest.resolve().is_relative_to(CHECKOUT)):
        raise ValueError("data must stay outside the trusted checkout")
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as src:
        info = os.fstat(src.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES or info.st_size % BLOCK:
            raise ValueError("expected a bounded block-aligned regular archive")
        if dest is not None:
            dest.mkdir(mode=0o700)
        try:
            intake(src, dest)
        except BaseException:
            if dest is not None:
                shutil.rmtree(dest)
            raise


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: extract.py INPUT NEW_DIR | --check INPUT")
    os.umask(0o077)
    try:
        if sys.argv[1] == "--check":
            run(Path(sys.argv[2]), None)
        else:
            run(Path(sys.argv[1]), Path(sys.argv[2]))
    except (ValueError, OSError, tarfile.TarError) as exc:
        print(f"archive refused: {exc}", file=sys.stderr)
        sys.exit(65)
