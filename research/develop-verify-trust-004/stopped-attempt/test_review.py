from dataclasses import replace
import unittest

from review import Entry, MASK, SOCKET, installer_mask, submission


class Review(unittest.TestCase):
    def test_submission(self):
        entry = Entry("socket", 968, 968, 0o666)
        parent = Entry("directory", 968, 1500, 0o750)
        args = dict(path=SOCKET, entry=entry, parent=parent, members={1500},
                    writable_nodes={SOCKET}, verifier_uid=968)
        self.assertTrue(submission(**args))
        for change in [
            dict(entry=replace(entry, uid=1500)), dict(entry=replace(entry, mode=0o660)),
            dict(entry=replace(entry, kind="file")), dict(parent=replace(parent, uid=1500)),
            dict(parent=replace(parent, gid=968)), dict(parent=replace(parent, mode=0o770)),
            dict(members={1500, 1501}), dict(path=SOCKET+"2"),
            dict(writable_nodes={SOCKET, SOCKET+"2"}), dict(members=None),
        ]:
            with self.subTest(change=change):
                self.assertFalse(submission(**(args | change)))

    def test_mask(self):
        entry = Entry("symlink", 0, 0, 0o777, "/dev/null")
        self.assertTrue(installer_mask(MASK, entry, True))
        for bad in [replace(entry, uid=1500), replace(entry, target="/tmp/null"),
                    replace(entry, kind="file")]:
            self.assertFalse(installer_mask(MASK, bad, True))
        self.assertFalse(installer_mask(MASK, entry, False))
        self.assertFalse(installer_mask("/var/lib/endo-verify-002/records/x", entry, True))
