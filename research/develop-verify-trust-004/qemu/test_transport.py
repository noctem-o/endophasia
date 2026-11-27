import hashlib
import os
import io
import select
import tarfile
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

    def _start_fake_guest(self, script, recorded_pidfile):
        binary = self.work / "qemu-system-x86_64"
        if not binary.exists():
            binary.symlink_to(sys.executable)
        self.env["PATH"] = f"{self.work}:{os.environ['PATH']}"
        ss = self.work / "ss"
        if not ss.exists():
            ss.write_text("#!/bin/sh\nprintf 'mock socket pid=%s,fd=3\\n' \"$(cat \"$ENDO13_WORK/vm/qemu.pid\")\"\n")
            ss.chmod(0o700)
        proc = subprocess.Popen(
            [binary, "-I", "-c", script,
             "-name", "endo13-guest", "-serial", f"pipe:{self.vm}/con",
             "-pidfile", recorded_pidfile, "-nic", "none"],
            stdout=subprocess.PIPE, text=True,
        )
        ready, _, _ = select.select([proc.stdout], [], [], 5)
        if not ready or proc.stdout.readline().strip() != "ready":
            proc.terminate()
            proc.wait(timeout=5)
            proc.stdout.close()
            self.fail("fake guest did not signal readiness before audit")
        return proc

    def test_audit_uses_only_identified_pid(self):
        pidfile = self.vm / "qemu.pid"
        for expected, recorded in [(False, self.work / "other.pid"), (True, pidfile)]:
            proc = self._start_fake_guest("import time; print('ready', flush=True); time.sleep(30)", recorded)
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
                if proc.stdout is not None:
                    proc.stdout.close()

    def test_audit_tolerates_transient_fd_churn_and_fails_on_dead_guest(self):
        pidfile = self.vm / "qemu.pid"
        # Mirror GNU coreutils 9.4 (Ubuntu 24.04) `ls -l /proc/$pid/fd` failing on a transient vanished fd:
        # host.sh audit must inspect /proc/$pid/fd directly rather than letting `ls` abort under set -e.
        failing_ls = self.work / "ls"
        failing_ls.write_text("#!/bin/sh\necho \"ls: cannot access '/proc/0/fd/3': No such file or directory\" >&2\nexit 1\n")
        failing_ls.chmod(0o700)
        churn_script = (
            "import os, time\n"
            "print('ready', flush=True)\n"
            "end = time.monotonic() + 30\n"
            "while time.monotonic() < end:\n"
            "    fds = [os.open('/dev/null', os.O_RDONLY) for _ in range(32)]\n"
            "    for fd in fds:\n"
            "        os.close(fd)\n"
        )
        proc = self._start_fake_guest(churn_script, pidfile)
        try:
            pidfile.write_text(str(proc.pid))
            for _ in range(10):
                result = self.audit()
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"# pid {proc.pid} uid {os.getuid()}", result.stdout)
                self.assertIn("fd 1 -> pipe:[", result.stdout)
                self.assertIn(f"mock socket pid={proc.pid},fd=3", result.stdout)
        finally:
            proc.terminate()
            proc.wait(timeout=5)
            if proc.stdout is not None:
                proc.stdout.close()
        dead = self.audit()
        self.assertNotEqual(dead.returncode, 0)

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


class CollectTests(unittest.TestCase):
    def test_teardown_is_not_a_supported_operation(self):
        protected = self.work / ".capy/work/endo13"
        protected.mkdir(parents=True)
        sentinel = protected / "fixture"
        sentinel.write_text("retained")
        for work in ("", str(protected)):
            result = subprocess.run(["bash", Path(__file__).with_name("host.sh"), "teardown"],
                                    env={**os.environ, "HOME": str(self.work), "ENDO13_WORK": work},
                                    capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(sentinel.read_text(), "retained")

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.work = Path(directory.name)
        (self.work / "vm").mkdir()
        self.image = self.work / "vm/out.img"
        self.dest = self.work / "evidence"

    def collect(self, size, digest):
        return subprocess.run(["bash", Path(__file__).with_name("host.sh"), "collect", self.dest,
                               str(size), digest], env={**os.environ, "ENDO13_WORK": str(self.work)},
                              capture_output=True, text=True, timeout=5)

    def test_collection_preserves_only_the_exact_bytes(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            archive.addfile(tarfile.TarInfo("ordinary-file"))
        for payload in (buffer.getvalue(), b'{"summary":"fixture"}\n'):
            with self.subTest(size=len(payload)):
                self.image.write_bytes(payload + b"unused disk tail")
                result = self.collect(len(payload), hashlib.sha256(payload).hexdigest())
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([p.name for p in self.dest.iterdir()], ["export.tar"])
                artifact = self.dest / "export.tar"
                self.assertEqual(artifact.read_bytes(), payload)
                artifact.unlink()

    def test_refusals_publish_nothing(self):
        self.image.write_bytes(b"one")
        digest = hashlib.sha256(b"one").hexdigest()
        for size, claimed, reason in [(4, digest, "sufficiently long"), (3, "0"*64, "digest mismatch"),
                                       (3, "oops", "invalid export digest"), (0, digest, "invalid export size"),
                                       ("-1", digest, "invalid export size"), ("2G", digest, "invalid export size"),
                                       (2**31+1, digest, "invalid export size")]:
            with self.subTest(size=size, digest=claimed):
                result = self.collect(size, claimed)
                self.assertEqual(result.returncode, 65, result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertFalse(self.dest.exists() and list(self.dest.iterdir()))

    def test_existing_custody_is_never_overwritten(self):
        self.dest.mkdir(mode=0o700)
        artifact = self.dest / "export.tar"
        artifact.write_bytes(b"prior")
        self.image.write_bytes(b"new")
        result = self.collect(3, hashlib.sha256(b"new").hexdigest())
        self.assertEqual(result.returncode, 65, result.stderr)
        self.assertIn("empty private directory", result.stderr)
        self.assertEqual(artifact.read_bytes(), b"prior")


if __name__ == "__main__":
    unittest.main()
