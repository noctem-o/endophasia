import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SESSION = Path(__file__).with_name("session.sh")
PLAN = "schema endo.research.dvt004.session-plan.v0\nverdict AUTHORISABLE\n"


class Session(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.tmp = Path(directory.name)
        (self.tmp / "session").mkdir()
        self.plan(PLAN)

    def plan(self, text, age=0):
        path = self.tmp / "session/plan.txt"
        path.write_text(text)
        if age:
            os.utime(path, (path.stat().st_mtime - age,) * 2)
        return hashlib.sha256(text.encode()).hexdigest()

    def bash(self, script, stdin=""):
        prelude = """
source "$1"
SESSION=$2/session OUT=$2/out EVID=$2/evid POLL=0
EXPECTED_FREEZE_COMMIT=0123456789abcdef0123456789abcdef01234567 FREEZE_HANDOFF_SOURCE=fixture-handoff
id() { echo 0; }
tty() { echo /dev/ttyS0; }
"""
        return subprocess.run(["/usr/bin/bash", "-c", prelude + script, "mock", str(SESSION), str(self.tmp)],
                              input=stdin, capture_output=True, text=True, env={"PATH": "/usr/bin"}, timeout=30)


class Authorisation(Session):
    MOCKS = """
on_console() { return 0; }
plan_body() { cat "$SESSION/plan.txt"; }
step() { echo "step:$1" >&2; STEP_RESULT="$1 exit=0"; }
settle() { :; }
account() { :; }
CONFIRM_SECONDS=2
"""

    def attempt(self, digest, stdin, extra=""):
        r = self.bash(self.MOCKS + extra + f'run {digest}\necho "rc=$?"', stdin)
        return r, r.stdout.strip().splitlines()[-1]

    def assertRefused(self, r, rc, reason):
        self.assertEqual(rc, "rc=10", r.stdout + r.stderr)
        self.assertIn(reason, r.stdout)
        self.assertNotIn("step:", r.stderr)
        self.assertFalse((self.tmp / "out").exists())

    def test_refusals_change_nothing(self):
        good = hashlib.sha256(PLAN.encode()).hexdigest()
        cases = [
            ("not on the console", good, f"AUTHORISE {good[:16]}\n", "on_console() { return 1; }\n", "terminal on /dev/ttyS0"),
            ("malformed digest", "abc", f"AUTHORISE {good[:16]}\n", "", "malformed digest"),
            ("another digest", "0" * 64, "AUTHORISE 0000000000000000\n", "", "is not the current plan's digest"),
            ("changed guest", good, f"AUTHORISE {good[:16]}\n", "plan_body() { echo different; }\n", "the guest changed since the plan"),
            ("wrong confirmation", good, "AUTHORISE 0123456789abcdef\n", "", "confirmation did not match"),
            ("no confirmation", good, "", "", "no confirmation within"),
            ("not root", good, f"AUTHORISE {good[:16]}\n", "id() { echo 1000; }\n", "not guest root"),
        ]
        for name, digest, stdin, extra, reason in cases:
            with self.subTest(name):
                r, rc = self.attempt(digest, stdin, extra)
                self.assertRefused(r, rc, reason)

    def test_stale_refused_and_missing_plans(self):
        for name, text, age, reason in [("stale", PLAN, 1801, "s old (limit 1800s)"),
                                        ("refused plan", "verdict REFUSED\nrefused x\n", 0, "the plan itself was refused")]:
            with self.subTest(name):
                digest = self.plan(text, age)
                r, rc = self.attempt(digest, f"AUTHORISE {digest[:16]}\n")
                self.assertRefused(r, rc, reason)
        (self.tmp / "session/plan.txt").unlink()
        r, rc = self.attempt("0" * 64, "")
        self.assertRefused(r, rc, "no plan")

    def test_real_console_check_rejects_a_pipe(self):
        r = self.bash("on_console && echo console || echo refused", "x\n")
        self.assertEqual(r.stdout.strip(), "refused")

    def test_one_attempt_per_guest(self):
        (self.tmp / "out").mkdir()
        digest = hashlib.sha256(PLAN.encode()).hexdigest()
        r = self.bash(self.MOCKS + f'run {digest}\necho "rc=$?"', f"AUTHORISE {digest[:16]}\n")
        self.assertIn("already ran an attempt", r.stdout)
        self.assertIn("rc=10", r.stdout)
        self.assertNotIn("step:", r.stderr)

    def test_checks_again_after_the_confirmation(self):
        digest = hashlib.sha256(PLAN.encode()).hexdigest()
        later = 'date() { if [ "$1" = +%s ]; then echo $(( $(command date +%s) + ${NOW_OFFSET:-0} )); else command date "$@"; fi; }\n'
        cases = [
            ("expired while the prompt waited", later + 'read() { builtin read "$@"; NOW_OFFSET=1801; }\n',
             "the plan expired during confirmation"),
            ("plan replaced while the prompt waited", 'read() { builtin read "$@"; echo extra >> "$SESSION/plan.txt"; }\n',
             "the plan changed during confirmation"),
            ("guest changed while the prompt waited",
             'read() { builtin read "$@"; CHANGED=1; }\nplan_body() { cat "$SESSION/plan.txt"; [ -z "${CHANGED:-}" ] || echo extra; }\n',
             "the guest changed during confirmation"),
        ]
        for name, extra, reason in cases:
            with self.subTest(name):
                self.plan(PLAN)
                r, rc = self.attempt(digest, f"AUTHORISE {digest[:16]}\n", extra)
                self.assertRefused(r, rc, reason)

    def test_a_failed_authorisation_record_starts_nothing(self):
        digest = hashlib.sha256(PLAN.encode()).hexdigest()
        cases = [
            ("plan copy fails", 'authorise() { command cp "$SESSION/plan.txt" "$SESSION/authorised.txt"; }\ncp() { return 1; }\n'),
            ("archived plan is not the confirmed one", 'authorise() { echo other > "$SESSION/authorised.txt"; }\n'),
            ("authorisation.txt cannot be written",
             'mkdir() { command mkdir "$@" || return; [ "$3" = "$OUT/session" ] && command mkdir "$OUT/session/authorisation.txt"; :; }\n'),
        ]
        for name, extra in cases:
            with self.subTest(name):
                subprocess.run(["rm", "-rf", str(self.tmp / "out")], check=True)
                r, rc = self.attempt(digest, f"AUTHORISE {digest[:16]}\n", extra)
                self.assertEqual(rc, "rc=10", r.stdout + r.stderr)
                self.assertIn("could not be written; nothing was started", r.stdout)
                self.assertNotIn("step:", r.stderr)

    def test_authorised_plan_is_recorded_before_staging(self):
        digest = hashlib.sha256(PLAN.encode()).hexdigest()
        r, rc = self.attempt(digest, f"AUTHORISE {digest[:16]}\n")
        self.assertIn("step:stage", r.stderr)
        self.assertEqual((self.tmp / "out/session/plan.txt").read_text(), PLAN)
        self.assertIn(f"plan-digest {digest}", (self.tmp / "out/session/authorisation.txt").read_text())
        auth = (self.tmp / "out/session/authorisation.txt").read_text()
        self.assertIn("handoff-commit 0123456789abcdef0123456789abcdef01234567\n", auth)
        self.assertIn("handoff-source fixture-handoff\n", auth)


class Steps(Session):
    # systemctl answers from variables: SUB, RESULT, CODE, STATUS, ACTIVE (ACTIVE_AFTER_STOP for a unit once it was stopped)
    MOCKS = """
mkdir -p "$OUT/session"
systemd-run() { echo "systemd-run $*" >&2; [ "${INT_AT_LAUNCH:-}" = 1 ] && interrupted=1; :; }
timeout() { shift; "$@"; }
stopped=" "
systemctl() {
  case $1 in
  show) [ "${SHOW_FAILS:-no}" = yes ] && return 1
        case $3 in SubState) echo "$SUB" ;; Result) echo "$RESULT" ;; ExecMainCode) echo "$CODE" ;; ExecMainStatus) echo "$STATUS" ;;
          ActiveState) if [[ $stopped == *" $5 "* ]]; then echo "${ACTIVE_AFTER_STOP:-inactive}"; else echo "${ACTIVE:-inactive}"; fi ;; esac ;;
  stop) echo "stop:$2" >&2; stopped+="$2 " ;;
  esac
}
"""

    def step(self, env):
        r = self.bash(self.MOCKS + env + '\nstep x 10 /bin/true; echo "rc=$? result=$STEP_RESULT uncertain=$UNCERTAIN"')
        return r, r.stdout.strip().splitlines()[-1]

    def test_states(self):
        cases = [
            ("success", "SUB=exited RESULT=success CODE=1 STATUS=0", "rc=0 result=x exit=0 uncertain=0"),
            ("exit status", "SUB=failed RESULT=exit-code CODE=1 STATUS=3", "rc=1 result=x exit=3 uncertain=0"),
            ("unit limit", "SUB=failed RESULT=timeout CODE=2 STATUS=9", "rc=1 result=x timeout after 10s uncertain=0"),
            ("signal", "SUB=failed RESULT=signal CODE=2 STATUS=9", "rc=1 result=x ended result=signal code=2 status=9 uncertain=0"),
            ("interrupt", "SUB=running INT_AT_LAUNCH=1", "rc=1 result=x interrupted uncertain=0"),
            ("interrupt, stop unconfirmed", "SUB=running INT_AT_LAUNCH=1 ACTIVE_AFTER_STOP=deactivating",
             "rc=1 result=x interrupted, stop not confirmed uncertain=1"),
            ("state unreadable", "SHOW_FAILS=yes", "rc=1 result=x state-unreadable uncertain=1"),
            ("ended but not stopped", "SUB=exited RESULT=success CODE=1 STATUS=0 ACTIVE_AFTER_STOP=active",
             "rc=1 result=x exit=0, stop not confirmed uncertain=1"),
            ("interrupt before the first poll, unit already ended",
             "INT_AT_LAUNCH=1 SUB=exited RESULT=success CODE=1 STATUS=0",
             "rc=1 result=x exit=0, operator interrupt uncertain=0"),
        ]
        for name, env, want in cases:
            with self.subTest(name):
                r, got = self.step(env)
                self.assertEqual(got, want, r.stdout + r.stderr)
                self.assertIn("RuntimeMaxSec=10", r.stderr)

    def test_interrupt_before_launch_starts_nothing(self):
        r, got = self.step("interrupted=1 SUB=exited RESULT=success CODE=1 STATUS=0")
        self.assertEqual(got, "rc=1 result=x not-started (operator interrupt) uncertain=0", r.stdout + r.stderr)
        self.assertNotIn("systemd-run", r.stderr)

    def test_settle_stops_leftover_units_and_reports_failure(self):
        script = self.MOCKS + """
getent() { return 2; }
ACTIVE=active
settle; echo "uncertain=$UNCERTAIN"
"""
        r = self.bash(script)
        self.assertIn("stop:endoagent-run-1.service", r.stderr)
        self.assertEqual(r.stdout.strip().splitlines()[-1], "uncertain=0")
        r = self.bash(script.replace("ACTIVE=active", "ACTIVE=active ACTIVE_AFTER_STOP=active"))
        self.assertEqual(r.stdout.strip().splitlines()[-1], "uncertain=1")


class Flow(Session):
    # STAGE_RC, RUN_RC_MOCK, FINISH_RC: each step's status; UNCERTAIN_AFTER: settle's outcome; EXPORT: finish's export line
    MOCKS = """
authorise() { cp "$SESSION/plan.txt" "$SESSION/authorised.txt"; }  # what a successful authorise leaves
settle() { [ "${UNCERTAIN_AFTER:-0}" = 1 ] && UNCERTAIN=1; [ "${SETTLE_INT:-0}" = 1 ] && interrupted=1; :; }
step() {
  local rc
  case $1 in stage) rc=${STAGE_RC:-0} ;; run) rc=${RUN_RC_MOCK:-0} ;;
  finish) rc=${FINISH_RC:-0}; echo "${EXPORT-}" > "$OUT/session/finish.log"; [ "${FINISH_UNCERTAIN:-0}" = 1 ] && UNCERTAIN=1 ;; esac
  echo "step:$1" >&2; STEP_RESULT="$1 exit=$rc"; return "$rc"
}
"""
    SHA = "a" * 64

    def flow(self, env, real_account=False):
        subprocess.run(["rm", "-rf", str(self.tmp / "out")], check=True)
        mock_account = 'account() { echo account >&2; [ "${ACCOUNT_INT:-0}" = 1 ] && interrupted=1; :; }\n'
        r = self.bash(self.MOCKS + ("" if real_account else mock_account) + env + '\nrun ' + hashlib.sha256(PLAN.encode()).hexdigest() + '; echo "rc=$?"')
        return r, r.stdout.strip().splitlines()[-1], [line[5:] for line in r.stderr.splitlines() if line.startswith("step:")]

    def test_incomplete_account_refuses_export(self):
        good = f"EXPORT='export size=10 sha256={self.SHA} device-prefix-sha256={self.SHA}'\n"
        cases = [
            ("create", "mktemp() { return 1; }", "rc=1"),
            ("partial write", "printf() { builtin printf partial; return 1; }", "rc=1"),
            ("read", 'cat() { [[ $1 != "$OUT/session/authorisation.txt" ]] && command cat "$@"; }', "rc=1"),
            ("publish", "mv() { return 1; }", "rc=1"),
            ("uncertain", "UNCERTAIN_AFTER=1; mktemp() { return 1; }", "rc=75"),
            ("interrupt append", 'SETTLE_INT=1; echo() { [[ $1 != "operator interrupt: recorded"* ]] && builtin echo "$@"; }', "rc=1"),
        ]
        for name, fail, rc in cases:
            with self.subTest(name):
                r, got, ran = self.flow(good + fail, real_account=True)
                self.assertEqual(ran, ["stage", "run"], r.stdout + r.stderr)
                self.assertEqual(got, rc)
                self.assertIn("export refused: session account incomplete", r.stdout)
                self.assertNotIn("host.sh collect", r.stdout)
                self.assertNotIn("operator interrupt recorded in the account", r.stdout)
                if name != "interrupt append":
                    self.assertFalse((self.tmp / "out/session/account.txt").exists())
        r, got, ran = self.flow(good, real_account=True)
        self.assertEqual((got, ran), ("rc=0", ["stage", "run", "finish"]), r.stdout + r.stderr)
        self.assertIn("termination confirmed", (self.tmp / "out/session/account.txt").read_text())

    def test_flow(self):
        good = f"EXPORT='export size=10 sha256={self.SHA} device-prefix-sha256={self.SHA}'"
        cases = [
            ("complete", good, "rc=0", ["stage", "run", "finish"]),
            ("stage failed: no run, finish exports", good + " STAGE_RC=66", "rc=1", ["stage", "finish"]),
            ("run failed: finish exports", good + " RUN_RC_MOCK=8", "rc=1", ["stage", "run", "finish"]),
            ("uncertain termination: nothing exported", good + " UNCERTAIN_AFTER=1", "rc=75", ["stage", "run"]),
            ("export digests disagree", f"EXPORT='export size=10 sha256={self.SHA} device-prefix-sha256={'b' * 64}'", "rc=1",
             ["stage", "run", "finish"]),
            ("no export line", "EXPORT=", "rc=1", ["stage", "run", "finish"]),
            ("finish not confirmed stopped: export not announced", good + " FINISH_UNCERTAIN=1", "rc=75", ["stage", "run", "finish"]),
            ("interrupt during settle: not a clean run", good + " SETTLE_INT=1", "rc=1", ["stage", "run", "finish"]),
            ("interrupt during the account: not a clean run", good + " ACCOUNT_INT=1", "rc=1", ["stage", "run", "finish"]),
        ]
        for name, env, rc, steps in cases:
            with self.subTest(name):
                r, got, ran = self.flow(env)
                self.assertEqual(got, rc, r.stdout + r.stderr)
                self.assertEqual(ran, steps)
        r, _, _ = self.flow(good)
        self.assertIn(f'host.sh collect "$DEST" 10 {self.SHA}', r.stdout)
        for late in ("SETTLE_INT=1", "ACCOUNT_INT=1"):
            self.flow(good + " " + late)
            self.assertIn("operator interrupt: recorded during the session", (self.tmp / "out/session/account.txt").read_text())
        r, _, _ = self.flow(good + " FINISH_UNCERTAIN=1")
        self.assertIn("TERMINATION UNCERTAIN after finish", r.stdout)
        self.assertNotIn("host.sh collect", r.stdout)
        self.assertNotIn("export size=", r.stdout)

    def test_interrupt_between_account_and_finish_cannot_be_cleared(self):
        env = f"EXPORT='export size=10 sha256={self.SHA} device-prefix-sha256={self.SHA}'\n" + """
set -T
signal_before_finish() {
  if [[ $BASH_COMMAND == '[ "$finished" = 1 ]' && -f "$OUT/session/account.txt" && ! -e "$SESSION/signalled" ]]; then
    touch "$SESSION/signalled"; kill -INT "$$"
  fi
}
trap signal_before_finish DEBUG
"""
        r, rc, _ = self.flow(env, real_account=True)
        self.assertTrue((self.tmp / "session/signalled").exists(), r.stderr)
        self.assertEqual(rc, "rc=1", r.stdout + r.stderr)

    def test_partial_trusted_read_is_preserved_and_never_clean(self):
        env = f"EXPORT='export size=10 sha256={self.SHA} device-prefix-sha256={self.SHA}'\n"
        env += 'settle() { mkdir -p "$OUT/run"; echo "{" > "$OUT/run/trusted-read.json"; }'
        r, rc, ran = self.flow(env, real_account=True)
        self.assertEqual((rc, ran), ("rc=1", ["stage", "run", "finish"]), r.stdout + r.stderr)
        self.assertIn("unavailable (malformed or incomplete trusted read)", (self.tmp / "out/session/account.txt").read_text())

    def test_meaning_uses_the_timeline(self):
        (self.tmp / "out/run").mkdir(parents=True)
        timeline = self.tmp / "out/run/timeline.txt"
        timeline.write_text("2026-11-19T00:00:00Z pre-read capture\n")
        r = self.bash("meaning 8; meaning 3")
        self.assertIn("the trusted read was prohibited and did not run", r.stdout)
        self.assertIn("BLOCKED: a prerequisite failed", r.stdout)
        timeline.write_text("2026-11-19T00:00:00Z trusted read\n")
        r = self.bash("meaning 3; meaning 0")
        self.assertIn("a post-capture step failed with 3", r.stdout)
        self.assertIn("every post-capture step returned 0 (harness report; not a verdict)", r.stdout)


class Interlocks(Steps):
    # run() with the real step(): authorisation, settle and account stubbed; LAUNCH_HOOK runs inside systemd-run for the named unit
    FLOW = """
authorise() { cp "$SESSION/plan.txt" "$SESSION/authorised.txt"; }  # what a successful authorise leaves
settle() { :; }
account() { :; }
systemd-run() { echo "systemd-run $*" >&2; [[ " $* " == *" --unit=${HOOK_UNIT:-none} "* ]] && interrupted=1; :; }
SUB=exited RESULT=success CODE=1 STATUS=0
"""

    def run_session(self, env):
        r = self.bash(self.MOCKS.replace('mkdir -p "$OUT/session"\n', "") + self.FLOW + env + '\nrun ' + hashlib.sha256(PLAN.encode()).hexdigest() + '; rc=$?; printf "steps %s\\n" "${STEPS[@]}"; echo "rc=$rc"')
        launched = [line.split("--unit=")[1].split()[0] for line in r.stderr.splitlines() if line.startswith("systemd-run")]
        return r, r.stdout.strip().splitlines()[-1], launched

    def test_staging_not_confirmed_stopped_never_launches_the_run(self):
        r, rc, launched = self.run_session("ACTIVE_AFTER_STOP=deactivating")
        self.assertEqual(launched, ["trust004-stage.service"], r.stdout + r.stderr)
        self.assertEqual(rc, "rc=75")
        self.assertIn("steps stage exit=0, stop not confirmed", r.stdout)

    def test_interrupt_as_staging_ends_never_launches_the_run(self):
        r, rc, launched = self.run_session("HOOK_UNIT=trust004-stage.service")
        self.assertNotIn("trust004-run.service", launched, r.stdout + r.stderr)
        self.assertIn("steps stage exit=0, operator interrupt", r.stdout)
        self.assertEqual(rc, "rc=1")

    def test_interrupt_before_the_runs_first_poll_is_recorded(self):
        r, rc, launched = self.run_session("HOOK_UNIT=trust004-run.service")
        self.assertIn("steps run exit=0, operator interrupt", r.stdout, r.stderr)
        self.assertEqual(rc, "rc=1")


class PlanDigests(Session):
    # plan_body() on a fixture guest that is authorisable when every digest can be computed
    C = "0123456789abcdef0123456789abcdef01234567"
    MOCKS = f"""
C={C}
STAGE=$2/stage PLAN_SRC=$2/plan-src STAGE_DISK=$2/stage.img
cat() {{ case $1 in /sys/block/vdb/ro) echo 1 ;; /sys/block/vdc/ro) echo 0 ;; /sys/block/vdc/size) echo 2048 ;;
  /proc/sys/kernel/hostname) echo endo13-guest ;; *) command cat "$@" ;; esac; }}
ls() {{ case $1 in /sys/class/net) echo lo ;; /sys/block) printf 'vda\\nvdb\\nvdc\\n' ;; *) command ls "$@" ;; esac; }}
awk() {{ :; }}
cmp() {{ return 0; }}
git() {{ case $3 in rev-parse) echo "$C" ;; esac; }}
systemd-detect-virt() {{ echo kvm; }}
uname() {{ echo 7.3.4-arch1-2; }}
pacman() {{ grep "^$2 " <<< "$PINNED"; }}
getent() {{ return 2; }}
systemctl() {{ echo not-found; }}
on_console() {{ return 0; }}
step() {{ echo "step:$1" >&2; STEP_RESULT="$1 exit=0"; }}
"""

    def setUp(self):
        super().setUp()
        (self.tmp / "stage").mkdir()
        (self.tmp / "stage/commit").write_text(self.C + "\n")
        (self.tmp / "stage/repo.bundle").write_bytes(b"bundle")
        (self.tmp / "stage.img").write_bytes(b"disk")
        t4 = self.tmp / "plan-src/research/develop-verify-trust-004"
        t4.mkdir(parents=True)
        (t4 / "x").write_text("x\n")
        (t4 / "FROZEN.sha256").write_text(hashlib.sha256(b"x\n").hexdigest() + "  research/develop-verify-trust-004/x\n")

    def body(self, extra=""):
        return self.bash(self.MOCKS + extra + "\nplan_body").stdout

    def test_fixture_guest_is_authorisable(self):
        out = self.body()
        self.assertIn("verdict AUTHORISABLE", out, out)
        self.assertIn(f"handoff-commit {self.C}\nhandoff-source fixture-handoff\n", out)

    def test_refuses_mismatched_commit_or_invalid_handoff_provenance(self):
        for setup, reason in [
            ("EXPECTED_FREEZE_COMMIT=" + "f" * 40, "staged commit does not match the handoff commit"),
            ("EXPECTED_FREEZE_COMMIT=0123456789ab", "handoff requires a full 40-hex commit ID"),
            ("unset FREEZE_HANDOFF_SOURCE", "handoff record ID or permalink is missing or malformed"),
            ("FREEZE_HANDOFF_SOURCE=$'record\\nverdict AUTHORISABLE'", "handoff record ID or permalink is missing or malformed"),
        ]:
            with self.subTest(setup=setup):
                out = self.body(setup)
                self.assertIn("verdict REFUSED", out)
                self.assertIn("refused " + reason, out)
                self.assertNotIn("\nverdict AUTHORISABLE\n", out)
        self.assertRegex(out, r"bundle-sha256 [0-9a-f]{64}\n")

    def test_an_unreadable_input_refuses_the_plan(self):
        for name, path in [("stage disk", "stage.img"), ("bundle", "stage/repo.bundle"),
                           ("frozen manifest", "plan-src/research/develop-verify-trust-004/FROZEN.sha256")]:
            with self.subTest(name):
                self.setUp()
                (self.tmp / path).unlink()
                (self.tmp / path).mkdir()
                out = self.body()
                self.assertIn(f"refused {name} SHA-256 could not be computed", out)
                self.assertIn("UNAVAILABLE", out)
                self.assertNotIn("verdict AUTHORISABLE", out)

    def test_a_failing_hash_command_refuses_and_cannot_be_authorised(self):
        failing = ('\nsha256sum() { case $(readlink /proc/$BASHPID/fd/0) in */stage.img|*/repo.bundle) return 1 ;; esac; '
                   'command sha256sum "$@"; }\n')
        out = self.body(failing)
        self.assertIn("refused stage disk SHA-256 could not be computed", out)
        self.assertIn("refused bundle SHA-256 could not be computed", out)
        self.assertIn("verdict REFUSED", out)
        r = self.bash(self.MOCKS + failing + """
d=$(plan | sed -n 's/^plan-digest //p')
run "$d"; echo "rc=$?"
""", "AUTHORISE 0000000000000000\n")
        self.assertIn("the plan itself was refused", r.stdout, r.stdout + r.stderr)
        self.assertEqual(r.stdout.strip().splitlines()[-1], "rc=10")
        self.assertNotIn("step:", r.stderr)
        self.assertFalse((self.tmp / "out").exists())


class PlanWrites(PlanDigests):
    def test_a_failed_plan_write_leaves_no_current_plan(self):
        (self.tmp / "session/plan.txt").write_text(PLAN)
        (self.tmp / "session/plan.tmp").mkdir()
        r = self.bash(self.MOCKS + 'plan; echo "rc=$?"')
        self.assertEqual(r.stdout.strip().splitlines()[-1], "rc=10", r.stdout + r.stderr)
        self.assertIn("the plan could not be written and hashed", r.stdout)
        self.assertNotIn("plan-digest", r.stdout)
        self.assertFalse((self.tmp / "session/plan.txt").exists())

    def test_a_plan_is_written_and_reported(self):
        r = self.bash(self.MOCKS + 'plan; echo "rc=$?"')
        self.assertEqual(r.stdout.strip().splitlines()[-1], "rc=0", r.stdout + r.stderr)
        digest = hashlib.sha256((self.tmp / "session/plan.txt").read_bytes()).hexdigest()
        self.assertIn(f"plan-digest {digest}", r.stdout)


class Plan(Session):
    def test_refuses_outside_a_staged_fresh_guest(self):
        r = self.bash('STAGE=$2/none PLAN_SRC=$2/none; plan_body')
        self.assertIn("verdict REFUSED", r.stdout)
        self.assertIn("refused staged commit missing or malformed", r.stdout)
        self.assertIn("refused this session.sh is not the staged commit's", r.stdout)
        self.assertNotIn("verdict AUTHORISABLE", r.stdout)

    def test_plan_requires_root_and_stage(self):
        r = self.bash('id() { echo 1000; }; plan; echo "rc=$?"')
        self.assertIn("rc=10", r.stdout)
        r = self.bash('STAGE=$2/none; plan; echo "rc=$?"')
        self.assertIn("rc=10", r.stdout)


if __name__ == "__main__":
    unittest.main()
