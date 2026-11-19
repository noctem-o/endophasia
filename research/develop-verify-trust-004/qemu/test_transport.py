import os
import io
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch

import console


class TransportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        self.vm = self.work / "vm"
        self.vm.mkdir()
        self.env = {**os.environ, "ENDO13_WORK": str(self.work)}

    def audit(self):
        return subprocess.run(["bash", Path(__file__).with_name("host.sh"), "audit"],
                              env=self.env, capture_output=True, text=True, timeout=5)

    def test_audit_uses_only_identified_pid(self):
        binary = self.work / "qemu-system-x86_64"
        binary.symlink_to(sys.executable)
        self.env["PATH"] = f"{self.work}:{os.environ['PATH']}"
        pidfile = self.vm / "qemu.pid"
        ss = self.work / "ss"
        ss.write_text("#!/bin/sh\nprintf 'mock socket pid=%s,fd=3\\n' \"$(cat \"$ENDO13_WORK/vm/qemu.pid\")\"\n")
        ss.chmod(0o700)
        for expected, recorded in [(False, self.work / "other.pid"), (True, pidfile)]:
            proc = subprocess.Popen([binary, "-c", "import time; time.sleep(30)",
                                     "-name", "endo13-guest", "-serial", f"pipe:{self.vm}/con",
                                     "-pidfile", recorded, "-nic", "none"])
            try:
                pidfile.write_text(str(proc.pid))
                result = self.audit()
                if expected:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(f"# pid {proc.pid} uid {os.getuid()}", result.stdout)
                    self.assertIn("-nic none", result.stdout)
                    self.assertIn(f"mock socket pid={proc.pid},fd=3", result.stdout)
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("does not identify this guest", result.stderr)
            finally:
                proc.terminate()
                proc.wait(timeout=5)

    def test_put_checks_final_transport_and_guest_status(self):
        src = self.work / "fixture"
        src.write_text("fixture")
        for status, output, expected in [(0, "[rc=0]\n[rc=7]\n", 7), (124, "[rc=0]\n", 124),
                                         (0, "missing marker\n", 1), (0, "[rc=256]\n", 1),
                                         (0, "digest\n[rc=0]\n", 0)]:
            replies = [subprocess.CompletedProcess([], 0, "[rc=0]\n"),
                       subprocess.CompletedProcess([], status, output)]
            with self.subTest(status=status, output=output), patch.object(console.subprocess, "run", side_effect=replies):
                with redirect_stdout(io.StringIO()) as observed:
                    self.assertEqual(console.put(src, "/tmp/test"), expected)
                self.assertEqual(observed.getvalue(), output)

    def test_fifo_deadline_before_open_and_during_write(self):
        fifo = self.vm / "con.in"
        os.mkfifo(fifo)
        (self.vm / "console.log").touch()
        for has_reader in (False, True):
            reader = os.open(fifo, os.O_NONBLOCK | os.O_RDONLY) if has_reader else None
            try:
                if has_reader:
                    writer = os.open(fifo, os.O_NONBLOCK | os.O_WRONLY)
                    try:
                        with self.assertRaises(BlockingIOError):
                            while True:
                                os.write(writer, bytes(4096))
                    finally:
                        os.close(writer)
                result = subprocess.run([sys.executable, console.__file__, "true", "0.1"],
                                        env=self.env, capture_output=True, text=True, timeout=3)
                self.assertEqual(result.returncode, 124, result.stderr)
                self.assertEqual(result.stdout, "[TIMEOUT]\n")
            finally:
                if reader is not None:
                    os.close(reader)


if __name__ == "__main__":
    unittest.main()
