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


def intake(src, dest, repositories=False):
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
            symbolic = member.type == tarfile.SYMTYPE
            if member.type == tarfile.LNKTYPE:
                raise ValueError("hard link in archive")
            if not symbolic and (member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE) or member.linkname):
                raise ValueError("only regular files and directories are accepted")
            if directory and size:
                raise ValueError("directory has data")
            raw_name = header[:100].split(b"\0", 1)[0]
            prefix = header[345:500].split(b"\0", 1)[0]
            raw_path = prefix + b"/" + raw_name if prefix else raw_name
            if directory and b"//" in raw_path:
                raise ValueError("unsafe member name")
            name = member.name if override is None else override
            if directory:
                name = name.removesuffix("/")
            parts = name.split("/")
            if len(name) > 4095 or len(parts) > 64 or any(
                    p in (".", "..") or not re.fullmatch(r"[a-zA-Z0-9._@+,=-]{1,255}", p) for p in parts):
                raise ValueError("unsafe member name")
            if symbolic:
                metadata = ("objects", "refs", "config", "packed-refs")
                if (not repositories or parts[0] != "repos" or len(parts) < 3
                        or parts[2] in metadata
                        or (parts[2] == ".git" and (len(parts) == 3 or parts[3] in metadata))):
                    raise ValueError(f"symbolic link in archive: {name}")
                if size:
                    raise ValueError("symbolic link has data")
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
            if not directory and not symbolic and dest is not None:
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


def run(source, dest, repositories=False):
    if source.resolve().is_relative_to(CHECKOUT) or (dest and dest.resolve().is_relative_to(CHECKOUT)):
        raise ValueError("data must stay outside the trusted checkout")
    with os.fdopen(os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as src:
        info = os.fstat(src.fileno())
        if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES or info.st_size % BLOCK:
            raise ValueError("expected a bounded block-aligned regular archive")
        if dest is not None:
            dest.mkdir(mode=0o700)
        try:
            intake(src, dest, repositories)
        except BaseException:
            if dest is not None:
                shutil.rmtree(dest)
            raise


if __name__ == "__main__":
    args = sys.argv[1:]
    repositories = args[:1] == ["--repositories"]
    if repositories:
        args = args[1:]
    if len(args) != 2:
        sys.exit("usage: extract.py [--repositories] INPUT NEW_DIR | [--repositories] --check INPUT")
    os.umask(0o077)
    try:
        if args[0] == "--check":
            run(Path(args[1]), None, repositories)
        else:
            run(Path(args[0]), Path(args[1]), repositories)
    except (ValueError, OSError, tarfile.TarError) as exc:
        print(f"archive refused: {exc}", file=sys.stderr)
        sys.exit(65)
