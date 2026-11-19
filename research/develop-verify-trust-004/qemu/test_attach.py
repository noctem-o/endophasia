import fcntl
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ATTACH = Path(__file__).with_name("attach.py")
# A stand-in for QEMU's pipe chardev: both FIFOs opened read-write, input echoed upper-cased, "q" ends it.
GUEST = r"""
import os, sys
w = sys.argv[1]
i = os.open(w + "/con.in", os.O_RDWR)
o = os.open(w + "/con.out", os.O_RDWR)
os.write(o, b"login banner\n")
while True:
    data = os.read(i, 1024)
    if b"q" in data:
        break
    os.write(o, data.upper())
"""


class Attach(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.vm = self.work / "vm"
        self.vm.mkdir()
        for name in ("con.in", "con.out"):
            os.mkfifo(self.vm / name, 0o600)
        self.log = self.vm / "console.log"
        self.env = {**os.environ, "ENDO13_WORK": str(self.work)}

    def guest(self):
        g = subprocess.Popen([sys.executable, "-I", "-c", GUEST, str(self.vm)])
        self.addCleanup(g.wait)
        self.addCleanup(g.kill)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.close(os.open(self.vm / "con.in", os.O_WRONLY | os.O_NONBLOCK))
                return g
            except OSError:
                time.sleep(0.05)
        self.fail("guest stand-in did not open its console")

    def attach(self):
        a = subprocess.Popen([sys.executable, "-I", ATTACH], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=self.env)
        self.addCleanup(a.wait)
        self.addCleanup(a.kill)
        return a

    def wait_log(self, text):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.log.exists() and text in self.log.read_bytes():
                return
            time.sleep(0.05)
        self.fail(f"{text!r} never reached console.log")

    def test_relays_logs_and_detaches(self):
        self.guest()
        a = self.attach()
        self.wait_log(b"login banner")
        a.stdin.write(b"hello\n")
        a.stdin.flush()
        self.wait_log(b"HELLO")
        a.stdin.write(b"\x1d")
        a.stdin.flush()
        out, err = a.communicate(timeout=5)
        self.assertEqual(a.returncode, 0, err)
        self.assertIn(b"HELLO", out)
        self.assertIn(b"detached", err)

    def test_ends_when_the_guest_closes_its_console(self):
        g = self.guest()
        a = self.attach()
        self.wait_log(b"login banner")
        a.stdin.write(b"q")
        a.stdin.flush()
        g.wait(timeout=5)
        _, err = a.communicate(timeout=5)
        self.assertEqual(a.returncode, 0, err)
        self.assertIn(b"guest console closed", err)

    def test_refuses_without_a_guest(self):
        a = self.attach()
        _, err = a.communicate(timeout=5)
        self.assertEqual(a.returncode, 69)
        self.assertIn(b"is QEMU running", err)

    def test_refuses_a_second_reader(self):
        self.guest()
        with open(self.log, "ab") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            a = self.attach()
            _, err = a.communicate(timeout=5)
        self.assertEqual(a.returncode, 75)
        self.assertIn(b"another console reader", err)


if __name__ == "__main__":
    unittest.main()
