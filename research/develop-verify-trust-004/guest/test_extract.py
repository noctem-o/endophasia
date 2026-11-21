import io
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path


class GuestIntakeTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.source = self.root / "input.tar"
        self.dest = self.root / "new"
        self.tool = Path(__file__).resolve().with_name("extract.py")

    def archive(self, entries):
        with tarfile.open(self.source, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, kind in entries:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.mode = 0o7777
                member.pax_headers = {"mtime": "123.45"}
                if kind == tarfile.REGTYPE:
                    member.size = 7
                    archive.addfile(member, io.BytesIO(b"fixture"))
                else:
                    if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                        member.linkname = "inert-label"
                    archive.addfile(member)

    def invoke(self, *args):
        return subprocess.run([sys.executable, "-I", self.tool, *args],
                              text=True, capture_output=True, timeout=5)

    def test_check_and_extract_accept_pax_without_applying_modes(self):
        name = "out/" + "a" * 110
        self.archive([("out", tarfile.DIRTYPE), (name, tarfile.REGTYPE)])
        checked = self.invoke("--check", self.source)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(list(self.root.iterdir()), [self.source])
        result = self.invoke(self.source, self.dest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.dest / name).read_bytes(), b"fixture")
        self.assertEqual((self.dest / name).stat().st_mode & 0o7777, 0o600)
        self.assertEqual((self.dest / "out").stat().st_mode & 0o7777, 0o700)

    def test_validation_and_extraction_refuse_inert_invalid_entries(self):
        f, d = tarfile.REGTYPE, tarfile.DIRTYPE
        for entries, reason in [
            ([("../label", f)], "unsafe member name"), ([("/label", f)], "unsafe member name"),
            ([("a/./b", f)], "unsafe member name"), ([("a//b", f)], "unsafe member name"),
            ([("label//", d)], "unsafe member name"),
            ([("back\\slash", f)], "unsafe member name"), ([("line\nbreak", f)], "unsafe member name"),
            ([("label", tarfile.SYMTYPE)], "symbolic link"), ([("label", tarfile.LNKTYPE)], "hard link"),
            ([("label", tarfile.FIFOTYPE)], "only regular"), ([("label", tarfile.CHRTYPE)], "only regular"),
            ([("a", d), ("a", d)], "duplicate"), ([("a", f), ("a", f)], "duplicate"),
            ([("a", f), ("a/b", f)], "conflicting"), ([("a/b", f), ("a", f)], "conflicting"),
        ]:
            with self.subTest(entries=entries):
                self.archive([("first", f), *entries])
                for args in [("--check", self.source), (self.source, self.dest)]:
                    result = self.invoke(*args)
                    self.assertEqual(result.returncode, 65, result.stderr)
                    self.assertIn(reason, result.stderr)
                    self.assertEqual(list(self.root.iterdir()), [self.source])

    def test_existing_destinations_and_the_code_tree_are_refused(self):
        self.archive([("one", tarfile.REGTYPE)])
        self.dest.mkdir()
        for path, reason in [(self.dest, "File exists"), (self.tool.parent, "trusted checkout")]:
            result = self.invoke(self.source, path)
            self.assertEqual(result.returncode, 65, result.stderr)
            self.assertIn(reason, result.stderr)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_repository_link_is_omitted_and_its_path_stays_reserved(self):
        link = ("repos/L/link.mjs", tarfile.SYMTYPE)
        regular = ("repos/L/roman.mjs", tarfile.REGTYPE)
        self.archive([link, regular])
        self.assertEqual(self.invoke("--repositories", "--check", self.source).returncode, 0)
        extracted = self.invoke("--repositories", self.source, self.dest)
        self.assertEqual(extracted.returncode, 0, extracted.stderr)
        self.assertEqual([p.name for p in (self.dest / "repos/L").iterdir()], ["roman.mjs"])
        for name in (link[0], link[0] + "/child"):
            self.archive([link, (name, tarfile.REGTYPE)])
            result = self.invoke("--repositories", "--check", self.source)
            self.assertEqual(result.returncode, 65, result.stderr)
            self.assertRegex(result.stderr, "duplicate|conflicting")

    def test_repository_mode_still_refuses_links_on_protected_paths(self):
        for path in ("repos", "repos/L", "repos/L/.git", "repos/L/.git/config",
                     "repos/L/.git/objects/ab/object", "repos/L/.git/refs/heads/main",
                     "repos/L/.git/packed-refs", "repos/L/objects/info/alternates"):
            with self.subTest(path=path):
                self.archive([(path, tarfile.SYMTYPE)])
                for args in [("--check", self.source), (self.source, self.dest)]:
                    result = self.invoke("--repositories", *args)
                    self.assertEqual(result.returncode, 65, result.stderr)
                    self.assertIn("symbolic link", result.stderr)
                    self.assertFalse(self.dest.exists())

    def test_ustar_directory_validates_the_prefix_name_boundary(self):
        member = tarfile.TarInfo("/")
        member.type = tarfile.DIRTYPE
        header = bytearray(member.tobuf(format=tarfile.USTAR_FORMAT))
        header[345:350] = b"label"
        for magic in (b"ustar\0", b"ustar "):
            header[257:263] = magic
            header[148:156] = b" " * 8
            header[148:156] = f"{sum(header):06o}\0 ".encode()
            self.source.write_bytes(header + bytes(1024))
            for args in [("--check", self.source), (self.source, self.dest)]:
                result = self.invoke(*args)
                self.assertEqual(result.returncode, 65)
                self.assertIn("unsafe member name", result.stderr)
                self.assertFalse(self.dest.exists())

    def test_trailing_nonzero_data_is_not_an_ignored_second_archive(self):
        self.archive([("one", tarfile.REGTYPE)])
        with self.source.open("ab") as file:
            file.write(b"x".ljust(512, b"\0"))
        result = self.invoke(self.source, self.dest)
        self.assertEqual(result.returncode, 65, result.stderr)
        self.assertIn("trailing archive data", result.stderr)
        self.assertFalse(self.dest.exists())


if __name__ == "__main__":
    unittest.main()
