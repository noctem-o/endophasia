from hashlib import sha256
from pathlib import Path
import subprocess
import tempfile
import unittest


GUEST = Path(__file__).resolve().parent
FILES = (
    "state.tar", "install.tar", "system.tar", "listing.txt", "files.sha256",
    "acl.txt", "ancestors.txt", "roots.txt", "runtime.sha256", "principals.txt", "acquisition.log",
    *(f"{kind}-{workspace}.tar" for kind in ("repos", "harness")
      for workspace in ("availability", "installed-1", "installed-2")),
    "offered-installed-1.tar", "offered-installed-2.tar",
)


class Compare(unittest.TestCase):
    def fixture(self, root):
        pre, post = root / "pre", root / "post"
        for capture in (pre, post):
            capture.mkdir()
            rows = []
            for name in FILES:
                (capture / name).write_text(name)
                rows.append(f"{sha256(name.encode()).hexdigest()}  {name}\n")
            (capture / "SHA256SUMS").write_text("".join(rows))
        return pre, post

    def compare(self, pre, post):
        return subprocess.run(["bash", GUEST / "compare.sh", pre, post],
                              capture_output=True, text=True, timeout=10)

    def test_corrupted_post_archive_is_unverifiable_even_with_unchanged_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            pre, post = self.fixture(Path(tmp))
            (post / "offered-installed-1.tar").write_text("corruption")
            result = self.compare(pre, post)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            self.assertIn("UNVERIFIABLE", result.stdout)
            self.assertNotIn("same ", result.stdout)

    def test_identical_and_different_are_distinct_verified_states(self):
        with tempfile.TemporaryDirectory() as tmp:
            pre, post = self.fixture(Path(tmp))
            result = self.compare(pre, post)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("VERIFIED IDENTICAL", result.stdout)
            name = "offered-installed-1.tar"
            (post / name).write_text("different")
            manifest = post / "SHA256SUMS"
            manifest.write_text(manifest.read_text().replace(sha256(name.encode()).hexdigest(),
                                                             sha256(b"different").hexdigest()))
            result = self.compare(pre, post)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("VERIFIED DIFFERENT", result.stdout)
            self.assertIn(f"DIFFERENT {name}", result.stdout)

    def test_refuses_incomplete_or_unsafe_manifests_before_any_same_line(self):
        for case in ("missing file", "omitted required file", "duplicate", "unsafe name", "link", "unlisted"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                pre, post = self.fixture(Path(tmp))
                name = "acl.txt"
                manifest = post / "SHA256SUMS"
                rows = manifest.read_text().splitlines(keepends=True)
                if case in ("missing file", "omitted required file", "link"):
                    (post / name).unlink()
                if case == "omitted required file":
                    rows = [row for row in rows if not row.endswith(f"  {name}\n")]
                elif case == "duplicate":
                    rows.append(rows[0])
                elif case == "unsafe name":
                    rows.append(f"{sha256(name.encode()).hexdigest()}  ../pre/{name}\n")
                elif case == "link":
                    (post / name).symlink_to(pre / name)
                elif case == "unlisted":
                    (post / "extra.tar").touch()
                manifest.write_text("".join(rows))
                result = self.compare(pre, post)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("UNVERIFIABLE", result.stdout)
                self.assertNotIn("same ", result.stdout)


class Capture(unittest.TestCase):
    def capture(self, fail):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "state").mkdir()
            (root / "install").mkdir()
            (root / "fixture").write_text("fixture")
            source = (GUEST / "capture.sh").read_text()
            for original, replacement in {
                "EVID=/var/lib/trust004-evidence": f'EVID="{root}/evidence"',
                "/var/lib/endo-verify-002": f"{root}/state",
                "/usr/local/lib/endo-verify-002": f"{root}/install",
            }.items():
                source = source.replace(original, replacement)
            mocks = r"""
ROOT=$1; failure=$2; shift 2
install() { mkdir -p "${@: -1}"; }
chattr() { :; }
id() { echo 0; }
stat() { echo "fixture stat"; if [ "$failure" = stat ]; then echo "partial stat" >&2; return 17; fi; }
tar() {
  if [ "$1" = --version ]; then echo "fixture tar 1"; return 0; fi
  while [ "$#" -gt 0 ] && [ "$1" != -f ]; do shift; done
  printf 'fixture archive\n' > "$2"
  if [ "$failure" = tar ]; then echo "partial tar" >&2; return 17; fi
}
find() {
  if [ "$1" = --version ]; then echo "fixture find 1"; return 0; fi
  if [[ " $* " == *" -print0 "* ]]; then
    printf '%s\0' "$ROOT/fixture"
    if [ "$failure" = file-discovery ]; then echo "partial file-discovery" >&2; return 17; fi
  else
    echo "partial metadata"
    if [ "$failure" = listing ]; then echo "partial listing" >&2; return 17; fi
  fi
}
xargs() {
  if [ "$failure" = file-digests ]; then echo "partial sha256sum"; echo "partial file-digests" >&2; return 17; fi
  command xargs "$@"
}
getfacl() {
  if [ "$1" = --version ]; then
    echo "fixture getfacl 1"
    if [ "$failure" = tool-version ]; then echo "partial tool-version" >&2; return 17; fi
    return 0
  fi
  echo "# fixture acl"
  if [ "$failure" = acl ]; then echo "partial acl" >&2; return 17; fi
}
sha256sum() {
  if [ "$1" = /etc/passwd ]; then
    echo "runtime digest fixture"
    if [ "$failure" = runtime ]; then echo "partial runtime" >&2; return 17; fi
  elif [ "$failure" = manifest ] && [ "$1" = -- ]; then
    echo "partial manifest fixture"; echo "partial manifest" >&2; return 17
  else
    command sha256sum "$@"
  fi
}
getent() {
  echo "endoagent:x:1500:1500::/home/endoagent:/bin/bash"
  if [ "$failure" = census ]; then echo "partial census" >&2; return 17; fi
  echo "endo-verify-002:x:968:968::/var/lib/endo-verify-002-home:/usr/bin/nologin"
  echo "nobody:x:65534:65534::/:/usr/bin/nologin"
}
"""
            result = subprocess.run(["bash", "-c", mocks + "\n" + source, "fixture", tmp, fail, "pre"],
                                    capture_output=True, text=True, timeout=10)
            capture = root / "evidence"
            sealed = (capture / "pre/SHA256SUMS").is_file() or (capture / "pre.SHA256SUMS").is_file()
            return result, sealed

    def test_does_not_seal_partial_acl_output(self):
        result, sealed = self.capture("acl")
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("partial acl", result.stderr)
        self.assertFalse(sealed)

    def test_does_not_seal_partial_output_from_other_capture_tools(self):
        for failure in ("tool-version", "stat", "tar", "listing", "file-discovery",
                        "file-digests", "runtime", "census", "manifest"):
            with self.subTest(failure=failure):
                result, sealed = self.capture(failure)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("partial " + failure, result.stderr)
                self.assertFalse(sealed)

    def test_complete_capture_seals(self):
        result, sealed = self.capture("none")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(sealed)


if __name__ == "__main__":
    unittest.main()
