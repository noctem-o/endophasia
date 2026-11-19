# Nested export permissions — review 4628506850

**Measured:** the old reader graded a correct nested import incorrect with distinct staging and grading identities under umask 077. The corrected reader reported correct. It keeps the tree private while writing, then grants traversal without write permission to the identity selected for grading. A separate control with directory mode 0755 could read the import but failed the no-writable-stage case. The active grade also attempted file creation in the root and both nested directories and modification of the leaf; each had to fail with EACCES or EROFS, and no write permission bit could be present. No mode above the fresh staging root is changed.

**The historical 16 did not exercise this bug.** Direct enumeration of the archived PASS records' file lists (not the old grader output) yielded 14 × `["roman.mjs"]`, 2 × `["roman.mjs", "table.json"]`. There are no nested paths. The previous offline reanalysis was an unprivileged host run; its code invokes `gradeFiles` directly, dropping to nobody only if the caller is root. Its JSON did not record the historical umask or numeric UID. Do not infer those values from today's shell. A fresh run with measured uid 1000 and umask 0077 returned the same summary: 68 invocations, 64 records, 4 incomplete, 16 matched PASS exports, no false or unconfirmed PASS. The 92 historical hashes and the separate amendment hashes verify; no guest-run file was changed.

### Delegated-identity measurement

The test used the first unused UID/GID in noctem's existing delegation (100000:65536); only one subordinate ID was mapped. Host 1000 was namespace 0 (stager), host 100000 was namespace 65534 (grader). The test used no host root, account changes, listener, VM or changes to the delegation. The expected stdout of the candidate checks the **observed** grader EUID, not just its launch arguments. Below are the exact shell commands for the final run, including an added stderr diagnostic in the scratch copies only. The private runtime explicitly made its own /usr traversable: an initial setup attempt with private /usr mode 0700 prevented the loader from starting and was discarded, not counted as a negative control. The positive and negative controls below used the same traversable runtime.

```bash
#!/bin/bash
set -eu
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
mkdir "$S/before" "$S/after" "$S/bin"
git archive e2c8b22b6 | tar -x -C "$S/before"
mkdir -p "$S/before/tests/fixtures"
cp tests/fixtures/trust003-nested-grade.mjs "$S/before/tests/fixtures/"
for i in adapters research runtime tests package.json; do cp -ar "$S/before/$i" "$S/after/"; done
cp research/develop-verify-trust-003/guest/reader.ts "$S/after/research/develop-verify-trust-003/guest/"
cp -a "$S/after" "$S/writable-control"
sed -i 's/0o500 : 0o555/0o500 : 0o755/' "$S/writable-control/research/develop-verify-trust-003/guest/reader.ts"
for version in before after writable-control; do sed -i '/const r = await runBounded(argv, { env: {}, deadlineMs: deadline, maxOutput: oracle.maxOutputBytes });/a console.error("grade stderr:",r.stderrHead);' "$S/$version/research/develop-verify-trust-003/guest/reader.ts"; done
for b in bwrap python3; do cp -L "/usr/bin/$b" "$S/bin/$b"; done
for b in node setpriv prlimit true sh; do cp -L "/usr/bin/$b" "$S/bin/$b"; done
test "$(id -u):$(id -g)" = 1000:1000
grep -Fx 'noctem:100000:65536' /etc/subuid /etc/subgid
ps -eo ruid=,euid=,suid=,fuid= | awk '{for(i=1;i<=NF;i++)if($i==100000)exit 1}'
for p in $(lsns -t user -n -o PID); do
  for map in uid_map gid_map; do awk '$3 != 4294967295 && $2 <= 100000 && $2+$3 > 100000 {exit 1}' "/proc/$p/$map"; done
done
export S
set +e
unshare --map-root-user --map-users=65534:100000:1 --map-groups=65534:100000:1 --pid --fork --kill-child /bin/bash -ceu '
echo "pid=$$ namespace=$(readlink /proc/self/ns/user)"
readlink /proc/self/ns/user > "$S/ns"
cat /proc/self/uid_map /proc/self/gid_map
exec bwrap --unshare-pid --die-with-parent --unshare-net --cap-add CAP_SETUID --cap-add CAP_SETGID --cap-add CAP_SYS_ADMIN --perms 0755 --dir /usr --ro-bind "$S/bin" /usr/bin --ro-bind /usr/lib /usr/lib --symlink lib /usr/lib64 --symlink usr/lib /lib --symlink usr/lib /lib64 --symlink usr/bin /bin --dev /dev --proc /proc --tmpfs /tmp --ro-bind "$S/before" /before --ro-bind "$S/after" /after --ro-bind "$S/writable-control" /writable-control -- /bin/sh -ceu '\''/usr/bin/node -e "for(const p of [\"/\",\"/usr\",\"/usr/lib\",\"/usr/lib/libcap.so.2\",\"/usr/bin\"]){const s=require(\"fs\").statSync(p);console.log(p,s.uid,s.mode.toString(8))}"; if /usr/bin/node /before/tests/fixtures/trust003-nested-grade.mjs; then exit 3; fi; if /usr/bin/node /writable-control/tests/fixtures/trust003-nested-grade.mjs; then exit 4; fi; /usr/bin/node /after/tests/fixtures/trust003-nested-grade.mjs'\'''
rc=$?
set -e
if test -e "$S/ns"; then
  inode=$(tr -dc '0-9' < "$S/ns")
  if lsns -t user -n -o NS | awk -v n="$inode" '$1==n {seen=1} END {exit !seen}'; then echo "namespace still present"; exit 1; fi
  echo "namespace $inode no longer listed"
fi
ps -eo ruid=,euid=,suid=,fuid= | awk '{for(i=1;i<=NF;i++)if($i==100000)exit 1}'
echo 'post-exit: no process with real, effective, saved or filesystem uid 100000'
exit "$rc"
```

Selected output (old, writable control, corrected):

```text
pid=1 namespace=user:[4026532902]
         0       1000          1
     65534     100000          1
         0       1000          1
     65534     100000          1
{"stagerUid":0,"expectedGraderUid":65534,"umask":"77","result":{"status":"graded","correct":false,"failing":["nested-import-as-grader","no-writable-stage"],"cases":[{"name":"nested-import-as-grader","outcome":"exited","exitCode":1,"signal":null,"matched":false,"terminationConfirmed":true,"durationMs":26},{"name":"no-writable-stage","outcome":"exited","exitCode":1,"signal":null,"matched":false,"terminationConfirmed":true,"durationMs":27}]}}
{"stagerUid":0,"expectedGraderUid":65534,"umask":"77","result":{"status":"graded","correct":false,"failing":["no-writable-stage"],"cases":[{"name":"nested-import-as-grader","outcome":"exited","exitCode":0,"signal":null,"matched":true,"terminationConfirmed":true,"durationMs":29},{"name":"no-writable-stage","outcome":"exited","exitCode":1,"signal":null,"matched":false,"terminationConfirmed":true,"durationMs":27}]}}
{"stagerUid":0,"expectedGraderUid":65534,"umask":"77","result":{"status":"graded","correct":true,"failing":[],"cases":[{"name":"nested-import-as-grader","outcome":"exited","exitCode":0,"signal":null,"matched":true,"terminationConfirmed":true,"durationMs":27},{"name":"no-writable-stage","outcome":"exited","exitCode":0,"signal":null,"matched":true,"terminationConfirmed":true,"durationMs":27}]}}
namespace 4026532902 no longer listed
post-exit: no process with real, effective, saved or filesystem uid 100000
```

The old nested import failed with `ERR_MODULE_NOT_FOUND` for `/work/lib/nested/value.mjs`, not a launcher error. The namespace was absent after exit and no real, effective, saved or filesystem UID matched 100000. The corrected grade and the independent same-UID control ran in fresh bubblewrap PID namespaces.

### Offline regrade and file-list check

```sh
D=research/develop-verify-trust-003
(umask 077; id; umask; node "$D/guest/reanalyze.ts" "$D/guest-run" /tmp/endo11-077-reanalysis.json)
diff <(jq -S .summary "$D/guest-run/reanalysis/reanalysis.json") <(jq -S .summary /tmp/endo11-077-reanalysis.json)
python3 - <<'PY'
import tarfile,json,collections
p='research/develop-verify-trust-003/guest-run/run/verifier-records.tar.gz'
with tarfile.open(p) as a:
 c=collections.Counter(tuple(f['path'] for f in r['candidate']['files']) for m in a if m.isfile() and '/records/' in '/'+m.name and (r:=json.load(a.extractfile(m)))['verdict']=='PASS')
 print(list(c.items())); assert sum(c.values())==16
PY
(cd "$D/guest-run" && sha256sum --quiet -c SHA256SUMS && sha256sum --quiet -c reanalysis/SHA256SUMS)
```
