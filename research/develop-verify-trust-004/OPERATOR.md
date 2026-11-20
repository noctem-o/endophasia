# TRUST-004 operator package: one complete frozen experiment in a disposable guest

This page is self-contained. It takes an operator from a clean host shell to retained, independently reanalysed evidence and a
powered-off guest. It does not report a result. TRUST-004's live verdict stays **INCOMPLETE** until a run made this way has
been collected and reanalysed, and workstation H0 stays **BLOCKED** whatever the guest shows.

**What is supported.** An operator starts **one complete frozen experiment per fresh guest**. After one typed authorisation, the
guest stages, runs and exports without pausing. This is not a split operator/reader session: [guest/run.sh](guest/run.sh) has no
handoff between the installed runs, the capture and the trusted read, and nothing here pretends otherwise. The only stopping point
is before anything is installed (Amendment 4, [PROTOCOL.md](PROTOCOL.md)). After it, the operator can only interrupt, and an
interruption is recorded as a failure, never as a pause.

**Selected source commit:** `3cd5de20d0da5fea046f4c29e3666efe3342e61b` (Amendment 10; exact file list in
[FROZEN.sha256](FROZEN.sha256); this commit's own copy of this page already quotes that manifest's digests). Stage exactly this commit, not the branch tip. Later commits on the branch only change
documentation and tests outside the manifest; `tests/develop-verify-trust-004-freeze.test.ts` checks in CI that this page and the
manifest agree, here and at this commit.

## 0. Authority and boundaries

| Marker | Who | Where |
|---|---|---|
| **[host]** | the operator's own uid, no sudo | workstation shell |
| **[guest root]** | root on the guest's serial console (autologin), reached through attach.py | inside the disposable guest only |
| **[analyst]** | an unprivileged guest-only user in the second, analysis guest | inside the analysis guest only |

No step uses sudo or changes workstation users, groups, permissions, Docker, libvirt, sudoers, polkit or services. QEMU needs
read-write `/dev/kvm` for the operator's uid. If `test -r /dev/kvm -a -w /dev/kvm` fails, stop: do not change its permissions.
The guest gets no network (`-nic none`), no shared host filesystem, no host secrets and no host listener. Its only inputs are
a read-only disk holding a git bundle of the commit and a blank evidence disk.

Set `ENDO13_WORK` explicitly in every terminal: `host.sh` refuses an empty setting. Never point it at
`~/.capy/work/endo13`, which holds **attempt 1's retained evidence**, or at the Amendment 9 work and evidence
directories (`trust004-amendment9-run1*`), which hold **attempt 2's**. Both stay read only.

## 1. Preconditions and inputs [host]

Use a bash shell and set these for every later block. `ENDO_REPO` is any clone URL or local checkout that contains the commit:

```sh
F=3cd5de20d0da5fea046f4c29e3666efe3342e61b
FREEZE_REF=refs/tags/trust004-amendment-10
OLD=$HOME/.capy/work/endo13                 # attempt 1: read only
W=$HOME/.capy/work/trust004-amendment10-run1
W2=$HOME/.capy/work/trust004-amendment10-run1-analysis
E=$HOME/endo-evidence/trust004-amendment10-run1    # retained evidence, outside every work directory
ENDO_REPO=https://github.com/noctem-o/endophasia.git
T=research/develop-verify-trust-004
```

Check the host before creating anything. Expected output: QEMU 11.1.3, both device checks true, at least 8 GiB free, no
`endo13-guest` process, and none of the three new paths present.

```sh
qemu-system-x86_64 --version | head -n1; qemu-img --version | head -n1
test -r /dev/kvm -a -w /dev/kvm && echo kvm-ok
df -h "$HOME/.capy/work" | tail -n1
pgrep -af endo13-guest || echo "no guest running"
for p in "$W" "$W2" "$E"; do
  if test -e "$p" || test -L "$p"; then echo "STOP: retained or occupied path: $p" >&2; exit 2; fi
done
```

**Source.** Use a private clone with the branch pointing at the selected commit, so that `host.sh stage` bundles exactly that:

```sh
mkdir -m 0700 -- "$W" && mkdir -m 0700 -- "$W/vm" || exit 2
git clone -q --no-checkout "$ENDO_REPO" "$W/src"
git -C "$W/src" fetch -q origin "$FREEZE_REF:$FREEZE_REF" || exit 1
tagged=$(git -C "$W/src" rev-parse --verify "$FREEZE_REF^{commit}") || exit 1
[[ $F == "$FREEZE_REF" || $F == "$tagged" ]] || { echo "wrong freeze commit" >&2; exit 1; }
F=$tagged
git -C "$W/src" update-ref refs/heads/develop-verify-trust-004 "$F"
git -C "$W/src" -c advice.detachedHead=false checkout -q develop-verify-trust-004
git -C "$W/src" rev-parse HEAD                                    # must print $F
test -z "$(git -C "$W/src" status --porcelain)" && echo clean
(cd "$W/src" && sha256sum -c $T/FROZEN.sha256 | grep -vc ': OK$')  # must print 0
grep -F guest/session.sh "$W/src/$T/FROZEN.sha256"             # 8cc8b2a232513699d07527da48f1a414695d619c8b3a0467e6040f808e4dbc3c
```

**Image and signature.** The protocol image is `Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2`, SHA-256
`794eb4889b39e1f0ed7d5ae998b2a1ed2137db8cf8c3476cf2962c7437ecb003`, signed by arch-boxes. Verify the downloaded copy and
attempt 1's read-only base, using a throwaway keyring so that your own is not touched:

```sh
sha256sum "$OLD/dl/Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2" "$OLD/img/Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2"
G=$(mktemp -d); gpg --homedir "$G" --batch --quiet --import "$OLD/keys/k.15325.asc"
gpg --homedir "$G" --batch --with-colons --fingerprint | grep '^fpr'
gpg --homedir "$G" --batch --status-fd 1 --verify "$OLD/dl/Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2.sig" \
  "$OLD/dl/Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2" 2>/dev/null | grep -E 'GOODSIG|VALIDSIG|BADSIG|ERRSIG'
gpgconf --homedir "$G" --kill all; rm -rf "$G"
```

Expected: both digests as above, fingerprints `1B9A16984A4E8CB448712D2AE0B78BF4326C6F8F` and
`656E4C5AC1CC3B86E539D97E343635A6859A9174`, one `GOODSIG` and one `VALIDSIG` naming the subkey and the primary. The key is
self-certified; its origin rests on the three TLS channels recorded in PROTOCOL.md §3. A matching filename is not a
verification.

**Fresh guest disk.** The protocol's starting point is attempt 1's `provisioned` snapshot (packages only, taken before the freeze).
Copy it into a new standalone image without modifying attempt 1:

```sh
sha256sum "$OLD/vm/overlay.qcow2"       # 26c0877e89bee49b47427f3a54b389fed78b6cd8284aa66cd11b60201febf18b
qemu-img snapshot -l "$OLD/vm/overlay.qcow2" | grep -w provisioned
qemu-img convert -O qcow2 -l snapshot.name=provisioned "$OLD/vm/overlay.qcow2" "$W/vm/overlay.qcow2"
sha256sum "$OLD/vm/overlay.qcow2"       # unchanged
qemu-img info "$W/vm/overlay.qcow2"     # virtual size 20 GiB, no backing file, no snapshots
```

**Stage disk, evidence disk, console FIFOs, listener baseline.**

```sh
export ENDO13_WORK=$W
bash "$W/src/$T/qemu/host.sh" stage "$F"    # prints stage.img's SHA-256 and lists repo.bundle and commit; record the digest
mkfifo -m 0600 "$W/vm/con.in" "$W/vm/con.out"
ss -ltunH | sort > "$W/listeners-before.txt"
```

Abort if any expected value differs, the overlay digest changes, or `host.sh stage` exits nonzero. Record the observed values.

## 2. Launch and isolation check [host]

Use three terminals, for example in tmux, each with the variables above and `export ENDO13_WORK=$W`.

1. **QEMU** (foreground until the guest powers off): `bash "$W/src/$T/qemu/boot.sh" offline 2> "$W/vm/qemu-offline.stderr"`
2. **Console**, started at once: `python3 -I "$W/src/$T/qemu/attach.py"`. Guest output appears here and is appended to
   `$W/vm/console.log`. Ctrl-C goes to the guest. Ctrl-] detaches, and while nobody is attached the guest's console output waits.
   Keep it attached during a session, and do not use `console.py` while a session runs: its text would land on the same terminal.
3. **Audit:**

```sh
bash "$W/src/$T/qemu/host.sh" audit
ss -ltunH | sort | diff "$W/listeners-before.txt" - && echo "no new host listener"
tail -n1 "$W/vm/qemu-argv.log"
```

The audit must identify the guest by its pid file, show `-nic none`, exactly the overlay, `stage.img` with `readonly=on` and
`out.img`, with no `-netdev`, `-virtfs`, `-fsdev`, `-chardev socket` or passthrough device. It must show no socket for that pid,
and no open file outside `$W/vm` other than `/dev/kvm`, `/dev/null`, pipes, anonymous inodes and the pseudo-terminal. If the audit
cannot identify the guest, stop and do not signal anything.

## 3. Authorise and run [guest root]

At the attach console, as root:

```sh
ip -br link; lsblk
install -d -m 0700 /root/stage && tar -xf /dev/vdb -C /root/stage && cat /root/stage/commit
git clone -q --bare /root/stage/repo.bundle /root/session.git 2>/dev/null
git --git-dir=/root/session.git show "$(cat /root/stage/commit)":research/develop-verify-trust-004/guest/session.sh > /root/session.sh
sha256sum /root/session.sh
bash /root/session.sh plan
```

Expected: only `lo`; disks `vda`, `vdb` (read-only) and `vdc`; the commit is `$F`; session.sh is
`8cc8b2a232513699d07527da48f1a414695d619c8b3a0467e6040f808e4dbc3c`. The plan should end with `verdict AUTHORISABLE` and a
`plan-digest`. Read every line before authorising: staged commit, stage-disk and bundle digests (the bundle is inside the stage
disk you recorded; a digest that could not be computed reads `UNAVAILABLE` and refuses the plan), `frozen-check all 36 entries match`, `session-script is the staged commit's`, `network-interfaces lo`,
`shared-filesystems none`, `block-devices vda vdb vdc`, `stage-disk-read-only 1`, `virtualization kvm`, hostname
`endo13-guest`, kernel `7.3.4-arch1-2`, the eleven pinned packages, and the three pending actions. A `verdict REFUSED` lists each
reason: stop, preserve the console log and do not work around it.

To authorise, within 30 minutes of the plan, run `bash /root/session.sh run <plan-digest>`. Then type exactly the line it asks for:
`AUTHORISE` followed by the digest's first 16 hex digits. It refuses, and changes nothing, unless all of these hold: guest root, a
terminal on `/dev/ttyS0`, the current plan's digest, a plan under 1800 s old that was authorisable, a recomputed plan identical
byte for byte, the exact confirmation within 300 s, and no `/root/out`. After the confirmation it checks the digest, the age and
the recomputed plan again, and archives exactly the plan bytes it confirmed; a failure there, or a failed write of the plan or the
authorisation record, is a refusal and starts nothing.

**Effects once authorised**, in order, each in its own transient unit with output under `/root/out/session/`:

1. `trust004-stage` (limit 30 min): TRUST-003 `stage.sh` clones the commit to `/opt/trust003/src`, checks content pins, creates
   `endoagent` (uid 1500), builds and checks the package, installs the verifier `endo-verify-002` and inspects it.
2. `trust004-run` (limit 5 h), only if staging exited 0: `run.sh` runs the first stop, policy review and censuses, the
   availability request, then installed runs 1 and 2 as `endoagent` (the adversarial matrix; root's T10 and E3 actions are part of
   it). The runs use `guest/harness.ts`, the merged TRUST-002 harness with IA3 judged by export digest (Amendment 10): each
   authoritative PASS, the availability record included, is listed once as correct, false-pass or uncovered. Then quiescence, the pre-read capture, the trusted read only if that capture succeeded, the post-read capture, the
   comparison, controls and trace analysis.
3. The session stops any experiment unit still running and terminates leftover agent sessions. If it cannot confirm that, it
   reports **TERMINATION UNCERTAIN** and stops with status 75. Then finish.sh does not run and nothing is exported.
4. `trust004-finish` (limit 30 min) otherwise, whatever happened before: uninstall with its record archive, inspection, cleanup
   census, and export of `/root/out` (captures included) to `/dev/vdc`.

**Monitoring.** A status line every 5 minutes names the running step and the last timeline entry. At the end the session prints its
account and `export size=… sha256=… device-prefix-sha256=…`, plus the host `collect` command with those values. The account is
the harness's own report and is **not a verdict**. Run.sh status 3 is BLOCKED, 4 to 7 is INCOMPLETE, and 8 means the pre-read capture
failed and the trusted read did not run. A failure after the trusted read is reported with its status.

**Abort.** Press Ctrl-C at the console if any of these happens: unexpected output at a step, a prompt asking for input, host
memory pressure, evidence of network access, or the audit changing. The current unit is stopped and recorded as interrupted. Then
finish.sh exports what exists. A second Ctrl-C during finish.sh stops it too, and then nothing is exported. Session exit 0 means
every step returned 0, 1 means a step failed or the export was not confirmed, 10 means authorisation was refused (nothing changed),
and 75 means termination is uncertain, including a finish unit that was not confirmed stopped; then no export line is printed
and nothing should be collected. Status 10 also covers a plan or authorisation record that could not be written, and a plan that
expired or changed while the confirmation prompt waited: nothing is started. On 75 or an unconfirmed export, **do not power off or tear down**: keep `$W` and report.

When the session has printed the export line, power off at the console: `systemctl poweroff`. Terminal 1 returns, and attach.py
reports that the guest console closed.

## 4. Evidence custody [host]

Set `SIZE` (decimal bytes) and `DIGEST` (lowercase SHA-256) from the confirmed guest export line.
Collect **only the raw disk prefix**. Never mount, list, unpack or traverse a guest export, or consume its manifests on the workstation.

```sh
E=$E W=$W T=$T SIZE=${SIZE:?} DIGEST=${DIGEST:?} bash -euo pipefail <<'CUSTODY'
umask 077
test ! -e "$E" && test ! -L "$E" || { echo "STOP: $E already exists" >&2; exit 2; }
mkdir -p -- "$(dirname -- "$E")"
ENDO13_WORK=$W bash "$W/src/$T/qemu/host.sh" collect "$E" "$SIZE" "$DIGEST" || { echo "STOP: collect failed" >&2; exit 2; }
cp "$W/vm/console.log" "$W/vm/qemu-argv.log" "$W/vm/qemu-offline.stderr" "$W/listeners-before.txt" "$E/"
(cd "$E" && sha256sum export.tar console.log qemu-argv.log qemu-offline.stderr listeners-before.txt > HOST-SHA256SUMS)
chmod a-w "$E"/{export.tar,console.log,qemu-argv.log,qemu-offline.stderr,listeners-before.txt,HOST-SHA256SUMS}
echo "raw custody sealed"
CUSTODY
echo "custody exit=$?"
```

Proceed only on exit 0. A matching digest records which bytes arrived, not their meaning, authenticity or safety.
Even a run with status 8 (pre-read capture failed) can have a confirmed raw export: retain it, mark the experiment
INCOMPLETE, and do not treat it as a verified capture. On collection or sealing failure keep the work directory and any
partial custody directory; do not reuse either. Missing or corrupt evidence is diagnosed inside a disposable guest only.

## 5. Independent reanalysis in a second fresh guest [host, guest root, analyst]

PROTOCOL.md §8 runs [reanalyze.ts](reanalyze.ts) by an unprivileged user in a second fresh boot of the provisioned snapshot, never
on the workstation, because grading executes candidate code. It reads the exported pre-read capture and the live
`trusted-read.json` only, never harness summaries.

```sh
(
set -euo pipefail
mkdir -m 0700 -- "$W2"
mkdir -m 0700 -- "$W2/vm"
qemu-img convert -O qcow2 -l snapshot.name=provisioned "$OLD/vm/overlay.qcow2" "$W2/vm/overlay.qcow2"
cp "$W/vm/stage.img" "$W2/vm/stage.img"
install -m 0600 "$E/export.tar" "$W2/vm/out.img"
truncate -s 2G "$W2/vm/out.img"
mkfifo -m 0600 "$W2/vm/con.in" "$W2/vm/con.out"
ss -ltunH | sort > "$W2/listeners-before.txt"     # this guest's baseline, before it is launched
)
prep_status=$?
if (( prep_status != 0 )); then echo "STOP: keep the partial analysis directory; do not launch" >&2; exit "$prep_status"; fi
export ENDO13_WORK=$W2                              # in all three terminals
```

Launch and attach as in section 2, with `ENDO13_WORK=$W2` in each terminal: terminal 1 runs
`bash "$W/src/$T/qemu/boot.sh" offline 2> "$W2/vm/qemu-offline.stderr"` and terminal 2 runs `python3 -I "$W/src/$T/qemu/attach.py"`.
Then audit **this** guest against its own baseline and argv log. The expected results are the same as in section 2, with `$W2/vm` in
place of `$W/vm`:

```sh
bash "$W/src/$T/qemu/host.sh" audit
ss -ltunH | sort | diff "$W2/listeners-before.txt" - && echo "no new host listener"
tail -n1 "$W2/vm/qemu-argv.log"
```

On the second console, **[guest root]**, check that only loopback is present. Use the read-only **host-staged** disk
(`/dev/vdb`), not the evidence disk, for the source. Set `F` to the selected commit from section 1 in this guest shell.
Run each block in order; stop on any nonzero status. The source and its ancestors belong to root. Neither the analyst nor
the extraction can replace the checkout, the report pathname, or a parent of either.

```sh
(
  set -eu
  umask 022
  ip -br link
  useradd -m -U -s /usr/bin/bash analyst
  install -d -m 0700 /root/stage
  tar -xf /dev/vdb -C /root/stage
  test "$(cat /root/stage/commit)" = "${F:?}"
  git clone -q --no-checkout /root/stage/repo.bundle /opt/trust004-source
  cd /opt/trust004-source
  git checkout -q --detach "$F"
  sha256sum --quiet -c research/develop-verify-trust-004/FROZEN.sha256
  install -d -m 0755 /opt/trust004-result
  install -o analyst -g analyst -m 0600 /dev/null /opt/trust004-result/analysis.json
)
```

Set `SIZE` and `DIGEST` to exactly the section 4 values in this shell. A short read can return success from head;
check the actual byte count independently of the digest. Never interpolate free-form console text as a command.

```sh
(
  set -euo pipefail
  [[ ${SIZE:?} =~ ^[1-9][0-9]{0,9}$ && $SIZE -le 2147483648 && ${DIGEST:?} =~ ^[0-9a-f]{64}$ ]]
  head -c "$SIZE" /dev/vdc > /root/export.tar
  test "$(stat -c %s /root/export.tar)" = "$SIZE"
  test "$(sha256sum < /root/export.tar | cut -c1-64)" = "$DIGEST"
  install -m 0444 /root/export.tar /opt/trust004-export.tar
)
```

**[analyst]**, through runuser from the root console. Start in the trusted checkout, not the evidence tree.
Only the trusted extractor parses the outer archive, as the analyst, into a previously nonexistent input directory.
Do not source, import or run anything from that directory. The analyst checks capture manifests in the disposable
guest; a missing post-read capture is missing evidence, never a pass. Candidate grading belongs only in the frozen grader.

```sh
runuser -u analyst -- env -i HOME=/home/analyst PATH=/usr/bin bash -euc '
  cd /opt/trust004-source
  input=/home/analyst/input
  python3 -I /opt/trust004-source/research/develop-verify-trust-004/guest/extract.py /opt/trust004-export.tar "$input"
  cap=$input/out/evidence
  python3 -I /opt/trust004-source/research/develop-verify-trust-004/guest/check-input.py "$cap/pre"
  verify_capture() (
    cd "$cap/$1"
    cmp SHA256SUMS "$cap/$1.SHA256SUMS"
    pattern="^[a-f0-9]{64}  [A-Za-z0-9][A-Za-z0-9_.-]*$"
    while IFS= read -r row || test -n "$row"; do
      [[ $row =~ $pattern ]] || exit 1
    done < SHA256SUMS
    sha256sum --quiet --strict -c SHA256SUMS
  )
  verify_capture pre
  if test -e "$cap/post" || test -e "$cap/post.SHA256SUMS"; then
    verify_capture post
  else
    echo "post-read capture MISSING"
  fi
  rc=0
  node /opt/trust004-source/research/develop-verify-trust-004/reanalyze.ts "$cap" "$input/out/run/trusted-read.json" /opt/trust004-result/analysis.json || rc=$?
  echo "reanalyze exit=$rc"
  exit "$rc"'
echo "analyst command exit=$?"
```

Record the exit status. A refusal or missing report is INCOMPLETE: retain both guests' work, do not fabricate a report.
Inspect a produced report in this guest: check disagreements, false or unconfirmed PASS, refused repositories and commits
without objects against PROTOCOL.md §9. A completed report may explain a failed result; preserve it even if reanalysis returned nonzero.

**[guest root]** Write the raw report (not a tar) to the second guest's evidence disk. Copy from the fixed report file
in its root-owned parent to a root-only snapshot, then verify the write before shutting down.

```sh
(
  set -euo pipefail
  install -m 0400 /opt/trust004-result/analysis.json /root/analysis.json
  s=$(stat -c %s /root/analysis.json)
  test "$s" -gt 0 && test "$s" -le 2147483648 || exit 1
  h=$(sha256sum < /root/analysis.json | cut -c1-64)
  dd if=/root/analysis.json of=/dev/vdc conv=fsync status=none
  d=$(head -c "$s" /dev/vdc | sha256sum | cut -c1-64)
  test "$h" = "$d"
  echo "analysis size=$s sha256=$h device-prefix-sha256=$d"
  systemctl poweroff
)
```

On any failure stop, keep `$W2` and report; do not manually power off. On success set `ANALYSIS_SIZE` and
`ANALYSIS_DIGEST` on the **[host]** from that line. The collector always calls its opaque output `export.tar`,
including when the bytes are raw JSON. Do not parse it on the host.

```sh
(
  set -euo pipefail
  ENDO13_WORK=$W2 bash "$W/src/$T/qemu/host.sh" collect "$E/analysis" "${ANALYSIS_SIZE:?}" "${ANALYSIS_DIGEST:?}"
  cd "$E/analysis"
  sha256sum export.tar > HOST-SHA256SUMS
  chmod a-w export.tar HOST-SHA256SUMS .
)
```

## 6. Teardown and cleanup verification [host]

After both guests have exited, verify the two host-generated custody manifests first. Stop on failure and retain all files:

```sh
(cd "$E" && sha256sum --strict -c HOST-SHA256SUMS && cd analysis && sha256sum --strict -c HOST-SHA256SUMS) || exit 1
pgrep -af "$W/vm|$W2/vm" || echo "no QEMU process"
ss -ltunH | sort | diff "$E/listeners-before.txt" - && echo "no new host listener"
sha256sum "$OLD/vm/overlay.qcow2"       # still 26c0877e…febf18b: attempt 1 untouched
```

Keep both work directories, the guest disks, logs, staged source and custody files, regardless of outcome.
This procedure does not delete them. If identity, process termination or export integrity is uncertain, report that uncertainty.

## 7. What each result can and cannot show

A record that is `authoritative` with class PASS is a **protected positive record**. A `grade` with `correct: true` on bytes bound
to that record is a **correct result**. Agreement between the live read and the offline reanalysis of the pre-read capture is
**independently authenticated evidence**. They are separate findings, and none of them is implied by a harness exit status. Zero
executed rows are not zero observed failures.
