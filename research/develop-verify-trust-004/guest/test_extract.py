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
