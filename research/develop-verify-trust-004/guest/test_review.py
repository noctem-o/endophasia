from dataclasses import replace
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from review import Entry, MASK, SOCKET, ancestors, installer_mask, review, submission


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

    def test_review_requires_agent_observations_and_preserves_other_hits(self):
        entries = dict.fromkeys(ancestors(), Entry("directory", 0, 0, 0o755))
        entries[str(Path(SOCKET).parent)] = Entry("directory", 968, 1500, 0o750)
        entries[SOCKET] = Entry("socket", 968, 968, 0o666)
        entries[MASK] = Entry("symlink", 0, 0, 0o777, "/dev/null")
        user = SimpleNamespace(pw_uid=1500, pw_gid=1500)
        group = SimpleNamespace(gr_name="endoagent", gr_gid=1500, gr_mem=[])
        observed = dict(uid=1500, gid=1500, groups=[1500], writable=[SOCKET], writable_parents=[])
        hits = ["/etc/systemd/user/p11-kit-server.socket", "/var/lib/endo-verify-002/records/x",
                "/usr/local/lib/endo-verify-002/verify.sock", SOCKET + ".other"]
        with patch("review.metadata", side_effect=lambda p: entries[str(p)]), \
             patch("review.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=968)), \
             patch("review.pwd.getpwall", return_value=[user]), \
             patch("review.grp.getgrgid", return_value=group):
            self.assertEqual(review(observed, [MASK, "writable-socket " + SOCKET, *hits]), hits)
            for change in [dict(uid=0), dict(groups=[1500, 1]), dict(writable=[]),
                           dict(writable=[SOCKET, SOCKET + ".file"]),
                           dict(writable=[SOCKET, SOCKET + ".sock"]),
                           dict(writable_parents=[str(Path(MASK).parent)])]:
                with self.subTest(change=change), self.assertRaises(ValueError):
                    review(observed | change, [])
            group.gr_mem.append("other")
            with self.assertRaises(ValueError):
                review(observed, [])
            group.gr_mem.clear()
            entries["/run"] = Entry("symlink", 0, 0, 0o777, "/tmp")
            with self.assertRaises(ValueError):
                review(observed, [])
