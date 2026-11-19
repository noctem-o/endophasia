# TRUST-004 operator package: one complete frozen experiment in a disposable guest

This page is self-contained. It takes an operator from a clean host shell to retained, independently reanalysed evidence and a
removed guest. It does not report a result. TRUST-004's live verdict stays **INCOMPLETE** until a run made this way has
been collected and reanalysed, and workstation H0 stays **BLOCKED** whatever the guest shows.

**What is supported.** An operator starts **one complete frozen experiment per fresh guest**. After one typed authorisation, the
guest stages, runs and exports without pausing. This is not a split operator/reader session: [guest/run.sh](guest/run.sh) has no
handoff between the installed runs, the capture and the trusted read, and nothing here pretends otherwise. The only stopping point
is before anything is installed (Amendment 4, [PROTOCOL.md](PROTOCOL.md)). After it, the operator can only interrupt, and an
interruption is recorded as a failure, never as a pause.

**Selected source commit:** `f6e9d23d62e3e91056c24af66f49f722321a045b` (Amendment 5 freeze; 32 entries in
[FROZEN.sha256](FROZEN.sha256)). Stage exactly this commit, not the branch tip. Later commits on the branch only change
documentation.

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

Never run any `host.sh` command without `ENDO13_WORK` set: it defaults to `~/.capy/work/endo13`, which holds **attempt 1's
retained evidence**. Nothing on this page writes there.

## 1. Preconditions and inputs [host]

Use a bash shell and set these for every later block. `ENDO_REPO` is any clone URL or local checkout that contains the commit:

```sh
F=f6e9d23d62e3e91056c24af66f49f722321a045b
OLD=$HOME/.capy/work/endo13                 # attempt 1: read only
W=$HOME/.capy/work/endo18                   # this attempt's disposable guest
W2=$HOME/.capy/work/endo18-analysis         # the analysis guest
E=$HOME/endo-evidence/trust004-attempt-4    # retained evidence, outside every work directory
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
for p in "$W" "$W2" "$E"; do test ! -e "$p" && echo "absent $p"; done
```

**Source.** Use a private clone with the branch pointing at the selected commit, so that `host.sh stage` bundles exactly that:

```sh
install -d -m 0700 "$W" "$W/vm"
git clone -q --no-checkout "$ENDO_REPO" "$W/src"
git -C "$W/src" fetch -q origin develop-verify-trust-004 2>/dev/null; git -C "$W/src" cat-file -e "$F^{commit}"
git -C "$W/src" update-ref refs/heads/develop-verify-trust-004 "$F"
git -C "$W/src" -c advice.detachedHead=false checkout -q develop-verify-trust-004
git -C "$W/src" rev-parse HEAD                                    # must print $F
test -z "$(git -C "$W/src" status --porcelain)" && echo clean
(cd "$W/src" && sha256sum -c $T/FROZEN.sha256 | grep -vc ': OK$')  # must print 0
grep -F guest/session.sh "$W/src/$T/FROZEN.sha256"             # 43a348be67a002f14de87fa6769776742031b2ee348f67570d424079ea60896c
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
`43a348be67a002f14de87fa6769776742031b2ee348f67570d424079ea60896c`. The plan should end with `verdict AUTHORISABLE` and a
`plan-digest`. Read every line before authorising: staged commit, stage-disk and bundle digests (the bundle is inside the stage
disk you recorded; a digest that could not be computed reads `UNAVAILABLE` and refuses the plan), `frozen-check all 32 entries match`, `session-script is the staged commit's`, `network-interfaces lo`,
`shared-filesystems none`, `block-devices vda vdb vdc`, `stage-disk-read-only 1`, `virtualization kvm`, hostname
`endo13-guest`, kernel `7.3.4-arch1-2`, the eleven pinned packages, and the three pending actions. A `verdict REFUSED` lists each
reason: stop, preserve the console log and do not work around it.

To authorise, within 30 minutes of the plan, run `bash /root/session.sh run <plan-digest>`. Then type exactly the line it asks for:
`AUTHORISE` followed by the digest's first 16 hex digits. It refuses, and changes nothing, unless all of these hold: guest root, a
terminal on `/dev/ttyS0`, the current plan's digest, a plan under 1800 s old that was authorisable, a recomputed plan identical
byte for byte, the exact confirmation within 300 s, and no `/root/out`.

**Effects once authorised**, in order, each in its own transient unit with output under `/root/out/session/`:

1. `trust004-stage` (limit 30 min): TRUST-003 `stage.sh` clones the commit to `/opt/trust003/src`, checks content pins, creates
   `endoagent` (uid 1500), builds and checks the package, installs the verifier `endo-verify-002` and inspects it.
2. `trust004-run` (limit 5 h), only if staging exited 0: `run.sh` runs the first stop, policy review and censuses, the
   availability request, then installed runs 1 and 2 as `endoagent` (the adversarial matrix; root's T10 and E3 actions are part of
   it). Then quiescence, the pre-read capture, the trusted read only if that capture succeeded, the post-read capture, the
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
and 75 means termination is uncertain. On 75 or an unconfirmed export, **do not power off or tear down**: keep `$W` and report.

When the session has printed the export line, power off at the console: `systemctl poweroff`. Terminal 1 returns, and attach.py
reports that the guest console closed.

## 4. Evidence custody [host]

Set `SIZE` and `DIGEST` exactly as the guest printed them, never estimates, then run this block as one paste. It runs in a
child bash with `-euo pipefail`, so each step runs only if every earlier one succeeded, and nothing is sealed after a failure:

```sh
E=$E W=$W T=$T SIZE=${SIZE:?} DIGEST=${DIGEST:?} bash -euo pipefail <<'CUSTODY'
test ! -e "$E" || { echo "STOP: $E already exists" >&2; exit 2; }
install -d -m 0700 "$E"
bash "$W/src/$T/qemu/host.sh" collect "$E" "$SIZE" "$DIGEST" || { echo "STOP: collect failed; nothing sealed" >&2; exit 2; }
test -f "$E/out/evidence/pre/SHA256SUMS" || { echo "STOP: pre-read capture MISSING" >&2; exit 3; }
(cd "$E/out/evidence/pre" && sha256sum -c SHA256SUMS) || { echo "STOP: pre-read capture FAILS its checksums" >&2; exit 3; }
cmp "$E/out/evidence/pre/SHA256SUMS" "$E/out/evidence/pre.SHA256SUMS" || { echo "STOP: pre-read manifest differs from its exported copy" >&2; exit 3; }
if test -d "$E/out/evidence/post"; then
  (cd "$E/out/evidence/post" && sha256sum -c SHA256SUMS) || { echo "STOP: post-read capture present but FAILS its checksums" >&2; exit 4; }
  echo "post-read capture present and verified"
else
  echo "post-read capture MISSING: list it as missing evidence; it is not a pass"
fi
cp "$W/vm/console.log" "$W/vm/qemu-argv.log" "$W/vm/qemu-offline.stderr" "$W/listeners-before.txt" "$E/"
(cd "$E" && sha256sum export.tar console.log qemu-argv.log > HOST-SHA256SUMS)
chmod -R a-w "$E"
chmod u+w "$E"
install -d -m 0700 "$E/analysis"
echo "custody sealed: evidence files read-only; $E/analysis is ready for section 5"
CUSTODY
echo "custody exit=$?"
```

`collect` refuses a digest mismatch. Exit 0 with `custody sealed` is the only success. Exit 2 means collect failed or `$E` already
existed, 3 means the pre-read capture is missing or fails its checksums, 4 means a post-read capture is present but fails its
checksums, and any other nonzero exit means copying or sealing failed. On any of them, keep `$W` and stop. A **missing** post-read
capture is not a checksum failure: an incomplete run (run.sh status 8, or a failure before the post-read capture) has none, so it
is reported and sealed, and listed as missing evidence. An absent file is never a pass. Only `$E` itself is left writable, so that
section 5 can collect into `$E/analysis`; every evidence file stays read-only. Keep every failed attempt's directory.

## 5. Independent reanalysis in a second fresh guest [host, guest root, analyst]

PROTOCOL.md §8 runs [reanalyze.ts](reanalyze.ts) by an unprivileged user in a second fresh boot of the provisioned snapshot, never
on the workstation, because grading executes candidate code. It reads the exported pre-read capture and the live
`trusted-read.json` only, never harness summaries.

```sh
install -d -m 0700 "$W2" "$W2/vm"
qemu-img convert -O qcow2 -l snapshot.name=provisioned "$OLD/vm/overlay.qcow2" "$W2/vm/overlay.qcow2"
cp "$W/vm/stage.img" "$W/vm/out.img" "$W2/vm/"      # copies; the originals stay with this attempt
mkfifo -m 0600 "$W2/vm/con.in" "$W2/vm/con.out"
ss -ltunH | sort > "$W2/listeners-before.txt"     # this guest's baseline, before it is launched
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

At the analysis guest's console, **[guest root]** first, with SIZE and DIGEST from section 4:

```sh
ip -br link
useradd -m -U -s /usr/bin/bash analyst
install -d -m 0700 /root/stage && tar -xf /dev/vdb -C /root/stage && cat /root/stage/commit
head -c SIZE /dev/vdc > /root/export.tar && sha256sum /root/export.tar      # must print DIGEST
install -o analyst -g analyst -m 0400 /root/stage/repo.bundle /root/export.tar /home/analyst/
C=$(cat /root/stage/commit)
```

Then as **[analyst]**, through runuser:

```sh
runuser -u analyst -- bash -c 'cd && mkdir a && tar -xf export.tar -C a && git clone -q --no-checkout repo.bundle src &&
  git -C src -c advice.detachedHead=false checkout -q '"$C"' && (cd src && sha256sum --quiet -c research/develop-verify-trust-004/FROZEN.sha256) &&
  { node src/research/develop-verify-trust-004/reanalyze.ts a/out/evidence a/out/run/trusted-read.json reanalysis.json; echo "reanalyze exit=$?"; }'
```

Back as **[guest root]**, write the result to the copied evidence disk and power off:

```sh
tar -C /home/analyst -cf /root/analysis.tar reanalysis.json && s=$(stat -c %s /root/analysis.tar) &&
  dd if=/root/analysis.tar of=/dev/vdc conv=fsync status=none &&
  echo "analysis size=$s sha256=$(sha256sum < /root/analysis.tar | cut -c1-64) device-prefix-sha256=$(head -c "$s" /dev/vdc | sha256sum | cut -c1-64)"
systemctl poweroff
```

On the **[host]**: `bash "$W/src/$T/qemu/host.sh" collect "$E/analysis" <size> <sha256>` with `ENDO13_WORK=$W2`, then
`jq .summary "$E/analysis/reanalysis.json"`. Reanalysis exit 0 requires zero disagreements with the live read, zero false PASS and
zero unconfirmed PASS. Also read `repositoriesRefused`, `commitsWithoutObjects` and every row in `disagreements`. Any disagreement
means **not demonstrated** until explained. The PROTOCOL.md §9 criteria decide the verdict; the session account and `results.json`
do not.

## 6. Teardown and cleanup verification [host]

Only after both guests have exited and `$E` holds verified evidence:

```sh
pgrep -af "$W/vm|$W2/vm" || echo "no QEMU process"
ss -ltunH | sort | diff "$E/listeners-before.txt" - && echo "no new host listener"
ENDO13_WORK=$W2 bash "$W/src/$T/qemu/host.sh" teardown && test ! -e "$W2"
ENDO13_WORK=$W bash "$W/src/$T/qemu/host.sh" teardown && test ! -e "$W"
(cd "$E" && sha256sum -c HOST-SHA256SUMS)
sha256sum "$OLD/vm/overlay.qcow2"       # still 26c0877e…febf18b: attempt 1 untouched
```

The second teardown also removes the clone that host.sh runs from; bash keeps the open script, and nothing runs after it. The work directories hold the guest
disks, the copies, the FIFOs and the source clone, and no credential. Record what was removed. If identity, export integrity or
teardown is uncertain, stop and report that uncertainty rather than claiming a clean run.

## 7. What each result can and cannot show

A record that is `authoritative` with class PASS is a **protected positive record**. A `grade` with `correct: true` on bytes bound
to that record is a **correct result**. Agreement between the live read and the offline reanalysis of the pre-read capture is
**independently authenticated evidence**. They are separate findings, and none of them is implied by a harness exit status. Zero
executed rows are not zero observed failures.
