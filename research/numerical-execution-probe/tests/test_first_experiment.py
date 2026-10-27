import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import probe

spec = importlib.util.spec_from_file_location("first_experiment", ROOT / "first_experiment.py")
first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(first)


class ResourceTests(unittest.TestCase):
    @staticmethod
    def fake_worker(root):
        model, native, output = root / "model", root / "native", root / "pid"
        model.write_bytes(b"fake")
        native.write_text("#!/usr/bin/python3\nimport subprocess, sys, time\n"
                          "p = subprocess.Popen(['/usr/bin/python3', '-c', 'import time; time.sleep(30)'], "
                          "stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
                          "open(sys.argv[sys.argv.index('--output') + 1], 'w').write(str(p.pid))\n"
                          "time.sleep(30)\n")
        native.chmod(0o700)
        return model, native, output

    def properties(self):
        return {"ControlGroup": "/test", "MemoryMax": str(4 * first.GIB), "MemorySwapMax": "0",
                "RuntimeMaxUSec": "10min", "TimeoutStopUSec": "5s", "KillMode": "control-group",
                "Restart": "no"}

    def test_preflight_refuses_missing_or_weakened_limits(self):
        props = self.properties()
        first.validate_service(props, "/test", {3}, 3, 4 * first.GIB)
        for key, value in (("MemoryMax", "max"), ("MemorySwapMax", "max"),
                           ("RuntimeMaxUSec", "infinity"), ("TimeoutStopUSec", "infinity"),
                           ("KillMode", "process"), ("Restart", "always"), ("ControlGroup", "/other")):
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, "BLOCKED_RESOURCE_LIMITS"):
                first.validate_service({**props, key: value}, "/test", {3}, 3, 4 * first.GIB)
        with self.assertRaisesRegex(RuntimeError, "BLOCKED_RESOURCE_LIMITS"):
            first.validate_service(props, "/test", {3, 4}, 3, 4 * first.GIB)
        with self.assertRaisesRegex(RuntimeError, "BLOCKED_RESOURCE_LIMITS"):
            first.validate_service(props, "/test", {3}, 3, 4 * first.GIB - 1)

    def test_snapshot_copies_only_owned_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            source, target = Path(d) / "source", Path(d) / "target"
            source.mkdir(); target.mkdir()
            (source / "manifest.json").write_text(json.dumps({"status": "running"}))
            (source / "A1.f32le").write_bytes(b"partial")
            (source / "unexpected").write_bytes(b"not evidence")
            first.checkpoint_to(target)(source)
            self.assertEqual((target / "A1.f32le").read_bytes(), b"partial")
            self.assertEqual(json.loads((target / "manifest.json").read_text())["status"], "running")
            self.assertFalse((target / "unexpected").exists())
            self.assertEqual((target / "A1.f32le").stat().st_mode & 0o777, 0o600)

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups and subreaper required")
    def test_timeout_kills_and_reaps_owned_worker_group(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            model, native, output = self.fake_worker(root)
            probe.enable_child_subreaper()
            backend = probe.NativeBackend(native, model, 1.5)
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                backend.evaluate("A1", (1, 2), first.CONFIG, output)
            pid = int(output.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assertEqual(backend.last_observation["termination"], "timeout")

    @unittest.skipUnless(sys.platform == "linux", "Linux process groups and subreaper required")
    def test_interruption_kills_and_reaps_owned_worker_group(self):
        with tempfile.TemporaryDirectory() as d:
            model, native, output = self.fake_worker(Path(d))
            code = ("import signal,sys; from pathlib import Path; "
                    "sys.path.insert(0,sys.argv[1]); import probe; probe.enable_child_subreaper(); "
                    "signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(RuntimeError('interrupted'))); "
                    "probe.NativeBackend(Path(sys.argv[2]),Path(sys.argv[3]),30).evaluate("
                    "'A1',(1,2),{'context':512,'batch':32,'ubatch':32,'threads':1},Path(sys.argv[4]))")
            parent = subprocess.Popen([sys.executable, "-c", code, str(ROOT), str(native), str(model), str(output)],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while not output.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(output.exists(), "fake worker did not start")
                pid = int(output.read_text())
                parent.send_signal(signal.SIGTERM)
                parent.wait(timeout=5)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if parent.poll() is None:
                    parent.send_signal(signal.SIGTERM)
                    parent.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
