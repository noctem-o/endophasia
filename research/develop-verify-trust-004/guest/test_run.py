from pathlib import Path
import subprocess
import tempfile
import unittest


class Runner(unittest.TestCase):
    def harness(self, script, stage):
        with tempfile.TemporaryDirectory() as out:
            return subprocess.run(["/usr/bin/bash", "-c", """
source "$1"
OUT=$2
fail=$3
stage() { echo "stage:$1" >&2; [[ "$1" != "$fail" ]] || return 17; }
stamp() { :; }
log_exit() { echo "$1" >&2; }
""" + script, "mock", str(Path(__file__).with_name("run.sh")), out, stage],
                                  capture_output=True, text=True, env={"PATH": "/usr/bin"})

    def test_prompt_failure(self):
        for failure in ("census", "kill-instance", "restart-manager"):
            with self.subTest(failure=failure):
                r = self.harness("""
traced=yes; t10=no; e3=no
printf '%s\n' 'T10: interrupt' 'E3: restart' > "$OUT/run-1.out"
probe() { :; }
pgrep() { echo 42; }
python3() { stage "$3"; }
on_prompts 1
""", failure)
                self.assertEqual(r.returncode, 17, r.stderr)
                self.assertIn("stage:" + failure, r.stderr)
                if failure != "restart-manager":
                    self.assertNotIn("stage:restart-manager", r.stderr)
                if failure == "census":
                    self.assertNotIn("stage:kill-instance", r.stderr)

    def test_post_capture_status(self):
        for failure in ("none", "reader", "post", "compare", "controls", "run-1.strace", "run-2.strace",
                        "reader-trace", "controls-trace", "collect"):
            with self.subTest(failure=failure):
                r = self.harness("""
reader() { stage reader; }
bash() { if [[ $1 == */capture.sh ]]; then stage post; else stage compare; fi; }
strace() { stage controls; }
python3() { stage "${4##*/}"; }
id() { echo 1500; }
collect() { stage collect; }
after_capture
""", failure)
                self.assertEqual(r.returncode, 0 if failure == "none" else 17, r.stderr)
                self.assertIn("stage:collect", r.stderr)
                self.assertIn("stage:reader-trace", r.stderr)
                if failure == "reader":
                    self.assertNotIn("stage:controls", r.stderr)
                if failure == "post":
                    self.assertNotIn("stage:compare", r.stderr)

    def test_capture_gates_the_trusted_read(self):
        # main() through both installed runs with every prerequisite mocked as passing; only the pre-read capture's status varies.
        for capture, rc in (("capture", 8), ("none", 0)):
            with self.subTest(capture):
                r = self.harness("""
c=0123456789abcdef0123456789abcdef01234567
cat() { echo "$c"; }
git() { echo "$c"; }
for f in inspect first_stop policy_review principals availability probe start_run wait_run quiesce; do eval "$f() { :; }"; done
run_status() { echo 0; }
bash() { if [[ $1 == */capture.sh && $2 == pre ]]; then stage capture; fi; }
after_capture() { stage reader; }
main
""", capture)
                self.assertEqual(r.returncode, rc, r.stderr)
                if rc:
                    self.assertIn("ABORT: pre-read capture failed; no read", r.stderr)
                    self.assertNotIn("stage:reader", r.stderr)
                else:
                    self.assertIn("stage:reader", r.stderr)


if __name__ == "__main__":
    unittest.main()
