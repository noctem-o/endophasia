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

    def test_runs_the_amended_harness(self):
        # Amendment 10: the installed runs use TRUST-004's harness copy, whose IA3 judges a PASS by export digest.
        r = self.harness("""
COMMIT=0123456789abcdef0123456789abcdef01234567
systemd-run() { echo "argv:$*" >&2; }
systemctl() { echo 0123456789abcdef0123456789abcdef; }
start_run 1
""", "none")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("/opt/trust003/src/research/develop-verify-trust-004/guest/harness.ts run /home/endoagent/dvt/installed-1 "
                      "--commit 0123456789abcdef0123456789abcdef01234567 --target installed", r.stderr)
        self.assertNotIn("rehearsal.ts", r.stderr)

    def collect(self, home, uid):
        with tempfile.TemporaryDirectory() as out:
            r = subprocess.run(["/usr/bin/bash", "-c", """
source "$1"
OUT=$2 AGENT_HOME=$3 T4=$5 AGENT_UID=$4
id() { echo "$AGENT_UID"; }
inspect() { :; }
ls() { :; }
collect; echo "collect=$?"
cd "$OUT" && find . -type f -o -type l | sort | while read -r f; do echo "$f $(cat "$f" | head -c 40)"; done
""", "mock", str(Path(__file__).with_name("run.sh")), out, home, str(uid),
                                str(Path(__file__).parent)],
                               capture_output=True, text=True, env={"PATH": "/usr/bin"}, timeout=20)
            return r

    def agent_home(self, d):
        import os
        for k in (1, 2):
            os.makedirs(f"{d}/dvt/installed-{k}")
            for f in ("results.json", "rehearsal.log", "audit.json", "sudo-n.json"):
                Path(f"{d}/dvt/installed-{k}/{f}").write_text(f"{k}:{f}")
        Path(f"{d}/probe-idle.strace").write_text("idle trace")
        Path(f"{d}/secret").write_text("ROOT-ONLY-SECRET")

    def test_collect_copies_agent_files(self):
        import os
        with tempfile.TemporaryDirectory() as d:
            self.agent_home(d)
            os.remove(f"{d}/dvt/installed-2/sudo-n.json")
            r = self.collect(d, os.getuid())
            self.assertTrue(r.stdout.startswith("collect=0\n"), r.stdout + r.stderr)
            self.assertIn("./installed-1/results.json 1:results.json", r.stdout)
            self.assertIn("./probe-idle.strace idle trace", r.stdout)
            self.assertNotIn("installed-2/sudo-n.json", r.stdout)

    def test_collect_fails_closed_without_its_reader(self):
        import os
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as empty:
            self.agent_home(d)
            r = subprocess.run(["/usr/bin/bash", "-c", 'source "$1"; OUT=$2 AGENT_HOME=$3 T4=$4; id() { echo 0; }; inspect() { :; }; '
                                'ls() { :; }; collect; echo "collect=$?"', "mock", str(Path(__file__).with_name("run.sh")), empty, d,
                                "/nonexistent"], capture_output=True, text=True, env={"PATH": "/usr/bin"}, timeout=20)
            self.assertTrue(r.stdout.startswith("collect=1\n"), r.stdout + r.stderr)

    def test_collect_refuses_links_fifos_and_foreign_files(self):
        # Amendment 11 (review 4636855623): matrix.sh's root cp followed an agent-planted link into the exported evidence.
        import os
        cases = {
            "final link": lambda d: (os.remove(f"{d}/probe-idle.strace"), os.symlink(f"{d}/secret", f"{d}/probe-idle.strace")),
            "directory link": lambda d: (os.rename(f"{d}/dvt/installed-2", f"{d}/elsewhere"),
                                         os.symlink(f"{d}/elsewhere", f"{d}/dvt/installed-2")),
            "fifo": lambda d: (os.remove(f"{d}/dvt/installed-1/rehearsal.log"), os.mkfifo(f"{d}/dvt/installed-1/rehearsal.log")),
            "foreign owner": None,
        }
        for name, plant in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                self.agent_home(d)
                if plant:
                    plant(d)
                r = self.collect(d, os.getuid() + (1 if plant is None else 0))
                self.assertTrue(r.stdout.startswith("collect=1\n"), r.stdout + r.stderr)
                self.assertNotIn("ROOT-ONLY-SECRET", r.stdout)
                if name == "directory link":
                    self.assertNotIn("./installed-2/results.json", r.stdout)
                    self.assertIn("./installed-1/results.json", r.stdout)
                if name == "fifo":
                    self.assertNotIn("./installed-1/rehearsal.log", r.stdout)
                if name == "foreign owner":
                    self.assertNotIn("./installed-1/results.json", r.stdout)


if __name__ == "__main__":
    unittest.main()
