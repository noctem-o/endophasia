from pathlib import Path
import subprocess
import tempfile
import unittest


class Finish(unittest.TestCase):
    def exercise(self, fail):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            for part in ("root/trust004-rootonly", "var/lib/trust004-control",
                         "var/lib/trust004-evidence", "root/out", "dev"):
                (root / part).mkdir(parents=True)
            source = Path(__file__).with_name("finish.sh").read_text()
            for path in ("/root/", "/dev/vdc", "/var/lib/", "/usr/local/lib/", "/run/"):
                source = source.replace(path, scratch + path)
            source = source.removeprefix("#!/bin/bash\n")
            fixtures = r"""
ROOT=$1
fail=$2
id() { case $2 in endoagent) echo 1500 ;; endo-verify-002) echo 968 ;; *) return 9 ;; esac; }
getent() { return 2; }
sleep() { :; }
ps() {
  case "$*" in
    *"-u endoagent -u endo-verify-002"*)
      test ! -e "$ROOT/deleted" || { echo "late name census"; return 9; }
      echo named-census-before-uninstall ;;
    *euid*) echo "numeric-census $*" >&2
      test -e "$ROOT/deleted" || return 9
      if [ "$fail" = process ]; then echo "968 968 55 968 lingering"; fi ;;
  esac
}
sh() {
  if [[ $1 == */uninstall.sh ]]; then
    touch "$ROOT/deleted"
    test ! -e "$ROOT/var/lib/trust004-control" &&
      test ! -e "$ROOT/root/trust004-rootonly" || { echo "copies remain"; return 8; }
    echo "actual uninstall receipt"
    if [ "$fail" = uninstall ]; then return 23; fi
  fi
  return 0
}
systemctl() { :; }
pgrep() { return 1; }
ss() { :; }
ip() { :; }
pacman() { :; }
tar() { printf 'archive bytes\n' > "$4"; }
dd() { cp "${1#if=}" "${2#of=}"; }
"""
            result = subprocess.run(
                ["/usr/bin/bash", "-c", fixtures + "\n" + source, "fixture", scratch, fail],
                text=True, capture_output=True, timeout=15)
            out = root / "root/out/run"
            return (result, (out / "uninstall.txt").read_text(),
                    (out / "census-before-uninstall.txt").read_text(),
                    (out / "cleanup-guest.txt").read_text(), (root / "dev/vdc").exists())

    def test_cleanup_order_and_receipt(self):
        run, receipt, census, cleanup, exported = self.exercise("none")
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        self.assertIn("named-census-before-uninstall", census)
        self.assertIn("actual uninstall receipt\nuninstall exit=0", receipt)
        self.assertIn("numeric-census", cleanup)
        self.assertIn("cleanup exit=0", cleanup)
        self.assertTrue(exported)

    def test_cleanup_failure_keeps_receipt_and_export_but_exits_nonzero(self):
        for failure in ("uninstall", "process"):
            with self.subTest(failure=failure):
                run, receipt, _, cleanup, exported = self.exercise(failure)
                self.assertNotEqual(run.returncode, 0)
                self.assertIn("uninstall exit=" + ("23" if failure == "uninstall" else "0"), receipt)
                self.assertIn("cleanup exit=1", cleanup)
                self.assertIn("export size=", run.stdout)
                self.assertTrue(exported)


if __name__ == "__main__":
    unittest.main()
