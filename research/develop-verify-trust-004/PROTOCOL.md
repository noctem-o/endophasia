# DEVELOP-VERIFY-TRUST-004: live evidence closure in a fresh guest (ENDO-13)

Preregistration. Written and committed **before** the verifier is installed anywhere for this experiment. Base: `main` at
`e8f3cd1c4df4f3802c2c5ecd6061181984010d23` (TRUST-003 merged). Branch `develop-verify-trust-004`. The frozen commit is the commit
that adds this file; [FROZEN.sha256](FROZEN.sha256), committed next to it, lists every file the guest executes. Amendments are
appended at the end as new sections and frozen in a new commit before any further attempt; acceptance criteria below are never
changed after the first installed request. TRUST-003's evidence (`research/develop-verify-trust-003/`) is read, never written.

## 1. What this closes, and what it inherits

| Source | Kind | Used as |
|---|---|---|
| TRUST-002 THREAT-MODEL, PROTOCOL §6, INSTALL-PLAN | preregistered requirements | IA1–IA4 meanings, the T/E rows, installation |
| TRUST-003 PROTOCOL A1–A5, APPROVAL | preregistered requirements, approved installation | the strict gate, the sudo classifier, the content pins, the A5 principal |
| TRUST-003 guest-run RESULTS | historical observation (destroyed guest) | **reference only**; not evidence here |
| Amendments 1–3 | later corrections | the reader under test; the gap this experiment closes |

The gap (Amendments 1 and 2): no guest has run the **corrected** reader; Git objects were never archived; records were archived only
after a root reader had run; privileged Git acquisition, grading identity and per-case termination were never observed live. This
experiment observes all of them in one fresh guest and changes none of the verifier, the reader, the driver or the pins. New code is
measurement only: [guest/](guest/) (operator, capture, controls, trace reading), [reanalyze.ts](reanalyze.ts), [qemu/](qemu/).

## 2. Threat model and trust assumptions

Retained from TRUST-002/003: the agent (`endoagent`, uid 1500) is fully adversarial inside its own authority; correctness is relative
to the pinned oracle; a record is authoritative only by location and ownership (records.ts). **Trusted:** the guest kernel, systemd,
the distribution packages, guest root (the evidence operator, outside the agent's authority), the host operator and the hypervisor.
**Not tested:** kernel or service vulnerabilities, setuid programs, the verifier's request parser, a compromised root, polkit,
libvirt or Docker (absent in the guest). A guest result says **nothing** about workstation H0, which stays **BLOCKED**.

## 3. Environment pins

- **Image:** `Arch-Linux-x86_64-cloudimg-20261101.620452.qcow2`, SHA-256
  `794eb4889b39e1f0ed7d5ae998b2a1ed2137db8cf8c3476cf2962c7437ecb003` (TRUST-003's), re-downloaded from `geo.mirror.pkgbuild.com`;
  published digest compared from two mirrors. Detached signature **verified** (gpg 2.4.9, GOODSIG/VALIDSIG) with the arch-boxes key,
  primary `1B9A16984A4E8CB448712D2AE0B78BF4326C6F8F`, signing subkey `656E4C5AC1CC3B86E539D97E343635A6859A9174`. The key came from
  three channels that agree on both fingerprints: keyserver.ubuntu.com, the arch-boxes README on gitlab.archlinux.org and its GitHub
  mirror (identical README bytes). Limitation: the key is self-certified only, not certified by the Arch master keys in
  `archlinux-keyring`; origin authentication rests on those TLS channels agreeing.
- **Packages** (guest only, pacman signature-verified, `SigLevel = Required`): `archive.archlinux.org/repos/2026/11/18`, the
  TRUST-003 date; linux 7.3.4.arch1-2, nodejs 26.13.1-1, bubblewrap 0.13.1-1, systemd 262.2-1, sudo 1.9.17.p2-7 (classic), git
  2.56.1-1, python 3.14.10-1, strace 7.3-1, util-linux 2.42.4-1, tar 1.35-5, acl 2.4.0-1. The full `pacman -Q` is exported.
  Provisioning (packages only; no verifier, no agent, no repository) ran before this freeze and is snapshotted as `provisioned`.
- **VM:** QEMU 11.1.3, KVM, under the operator's uid, launched only by [qemu/boot.sh](qemu/boot.sh) (reconstructed from TRUST-003's
  retained `qemu/boot.sh`; every argv logged). 4 vCPU, **4 GiB** (TRUST-003: 6 GiB; host had about 9 GiB available with swap full,
  so 6 GiB risked host memory pressure), 20 GiB qcow2 overlay on a 0400 base, `-nodefaults -display none -vga none -monitor none`,
  `-sandbox on,…`, serial console on two FIFOs. Test boots: `-nic none`, a read-only raw stage disk and a raw evidence-out disk; no
  virtfs, share, passthrough, SSH, agent forwarding, `hostfwd` or host listener. Before use, `host.sh audit` must show these from
  `/proc/<qemu>/cmdline`, its open files and `ss`, and the guest must show only `lo`.
  Found during provisioning, fixed before the freeze: the provisioning QEMU inherited a directory descriptor (fd 1023, the Capy
  application mount) from the operator's session. boot.sh now closes every inherited descriptor above 2.
- **Code:** the frozen commit, staged as a git bundle. Unchanged and pinned: TRUST-003 `guest/stage.sh` `666bebbc…`, `matrix.sh`
  `d936f293…`, `reader.ts` `abcbdff6…`, `read-records.ts` `fe0a705f…`, `probe.py` `38e188d7…`; TRUST-002 install `400d9cfe…`,
  uninstall `b58320b5…`, inspect `f1433420…`; checkout content pins `05cb46a7…` and package pins `84aa73ec…` (checked by stage.sh,
  normalized manifest `d1a018c4…`); oracle manifest `3dc2d86d…`.

## 4. Separate principals (prerequisites; any failure is BLOCKED)

Agent `endoagent` uid/gid 1500, no supplementary groups; verifier `endo-verify-002` a separate non-root system uid created by the
TRUST-003 A5 sysusers declaration; grading identity `nobody` 65534; evidence operator guest root. In order, from run.sh:
1. **First stop** (merged `first_stop`, untraced, in the agent's own PAM login session): exact `id` line, `CapEff`/`NoNewPrivs`
   recorded; `audit.ts --installed` with `h0: true` and `closure: true`; `sudo -n true` status 1 with a recognised classic-sudo
   policy refusal (a missing tool, launch error or nosuid message is not a refusal).
2. **Root view** (`policy_review`, `principals`): sudoers, polkit rules, setuid/setgid files, file capabilities, group members, ACLs on
   the installation, listeners, both principals' shadow fields, every verifier process's credentials; and, as the agent, every path it
   can write (`find -writable`) and every socket it can write. Any agent-writable path under the installation, state, socket
   directory, verifier home, unit or sysusers/tmpfiles files, or the evidence directory is a failed prerequisite.
3. **Availability** (separate from 1–2; liveness only, no security weight): the agent submits reference A from a fresh repository; root
   then requires the named record to exist, be a PASS owned by the verifier uid, with its journal.

## 5. Matrix

The merged TRUST-002 harness (`rehearsal.ts run … --target installed`) runs **twice** (installed-1, installed-2) as the agent, with the
fixed fixtures and the pinned oracle; no model inference. Rows and acceptance meanings are TRUST-002 §6 unchanged (IA1 positive: T1;
IA2 integrity: T6, T7, T8, E6; IA3 negative: T2–T5c, T9–T12, E1–E5; IA4 the whole matrix again in run 2). Positive: A and P receive
authentic PASS. Negative: B (PASS-shaped stdout, exit 0), replace refs, NODE_OPTIONS/PATH/LD_PRELOAD, staging and verifier tampering,
record forgery/replacement/replay, confused binding. Recovery: T10 interruption, E3 manager restart, E2 concurrency, E4 timeout and
output limits, T11 unavailable service, orphan cleanup, restricted inspection/signalling (E6). The harness's `results.json` is a
derived, untrusted report: it is archived but never an input to a verdict.

**Operator actions** (guest root, [guest/operator.py](guest/operator.py)): T10 kills a verifier instance only after identifying it live,
while a pidfd holds it: verifier uid, cgroup inside `user@<uid>.service` whose leaf is an `endo-verify-002@…service`, and a
`service/verifier.ts serve` command line; exactly one must match or nothing is signalled; the signal goes through the pidfd. E3 restarts
`user@<uid>.service` only after its MainPID is confirmed as that uid's `systemd --user`. No recorded PID is ever reused as a target.

**Tracing:** nothing is traced before the first stop. Root attaches strace to the agent's run only after the run logs that its own IP0
passed. A launched strace is not evidence; [guest/traces.py](guest/traces.py) `refusals` must find, in each run's trace, each required
refusal as one syscall line with its target and errno: T6 chmod of staged candidate EACCES; T7 write-open of `verifier.ts` EACCES and
drop-in mkdir EACCES; T8 record create EACCES and record symlink EACCES; T10 `kill(…, SIGKILL)` EPERM; E6 oracle open EACCES,
`/proc/<pid>/environ` EACCES and `kill(…, 0)` EPERM. ENOENT, tool errors and process disappearance never count.

## 6. Evidence acquisition (before any trusted read)

1. **Quiesce:** both run units inactive, both strace units inactive, the agent's sessions terminated and no agent process left, no
   live verifier instance (operator.py census). Otherwise stop: no capture, no read (INCOMPLETE).
2. **Pre-read capture** ([guest/capture.sh](guest/capture.sh) `pre`, guest root) into `/var/lib/trust004-evidence/pre` (root, 0700):
   tar archives (pax, numeric owners, ACLs, xattrs, no atime, ctime kept, links archived as links, `--one-file-system`) of the state
   root (records, journals, work), the installation (code, manifest, oracle), the system files (units, sysusers, tmpfiles, linger,
   masks home), and each agent workspace's `repos/` (full Git directories: objects, refs including `refs/replace`, config) plus a
   separate harness-output archive; a `find -P` metadata listing and SHA-256 of every file; ACLs; ancestor ownership; runtime binary
   digests; principals; an acquisition log with timestamps, tool versions and the acquiring process. Each root and its ancestors are
   checked with lstat (no symbolic link) first. The manifest `SHA256SUMS` is copied beside the directory; everything is made 0400 and
   `chattr +i`. The agent has no process at this point and no write access to `/var/lib`.
3. **Trusted read:** the unchanged `read-records.ts` (corrected reader) as guest root over the live state root and all three
   workspaces, under `strace -ff` of process and credential syscalls (attached from the start; no setuid binary is involved).
4. **Post-read capture** (`post`, same procedure) and [guest/compare.sh](guest/compare.sh): every archive digest, listing (mode, owner,
   links, size, mtime, ctime, inode), content digest and ACL must be identical. Any difference is investigated and reported; it fails
   the pre/post criterion. The pre-read capture is exported whatever happens after it.

## 7. Reader validation (live)

- **A Authenticity / B Binding:** from the reader's output per invocation: authenticity class and reason; binding `valid` only when the
  commit's objects, acquired from the agent's repository and verified by content address, give the record's tree, files and export.
- **C Git identity:** [guest/traces.py](guest/traces.py) `identity` over the reader's trace: for every `execve("/usr/bin/git")`, the
  same process's preceding credential syscalls and their kernel return values must give uid 1500 (real, effective, saved), gid 1500,
  empty supplementary groups and no_new_privs. Plus control F4 (below): a root-only copy of the repositories must be unreadable to
  acquisition. Neither the setpriv argv nor a source comment counts.
- **D Grading:** every grader `execve("/usr/bin/bwrap")` with the sandbox argv must run as 65534/65534, no groups, no_new_privs;
  every graded case must record `launched` and confirmed termination; control G (below).
- **E False PASS:** controls in an isolated copy ([guest/controls.ts](guest/controls.ts)), built from the **pre-read archive** under a
  separate root-made state root `/var/lib/trust004-control` owned like the real one, read by the unchanged reader:
  F1 an incorrect candidate's authentic FAIL rewritten to PASS and resealed → must be reported `falsePass`, never confirmed;
  F2 a genuine PASS naming an absent commit → binding unavailable, `unconfirmedPass`; F3 a genuine PASS with no bubblewrap → grade
  incomplete, `unconfirmedPass`; F4 a genuine PASS whose only repositories are a root-owned 0700 copy → binding unavailable,
  `unconfirmedPass`; F5 a genuine PASS copy → confirmed. G: the unchanged `gradeFiles` on a probe candidate: write-new, write-existing,
  chmod and mkdir in `/work` each print `EROFS`; read-and-list prints `probe.mjs`; identity prints `65534 65534`; a detached
  descendant plus busy loop ends as `timeout`; stdout and stderr floods end as `output-limit`; every case launched with confirmed
  termination; no 65534 process afterwards. Genuine records are never modified.

## 8. Independent offline reanalysis

[reanalyze.ts](reanalyze.ts), from a clean checkout of the PR head and the exported pre-read capture only, in a separate working
directory, run (a) by an unprivileged user in a **second fresh boot** of the provisioned snapshot (offline, no NIC; the experiment
guest's disk state discarded by reverting to `provisioned`), and (b) as a CI step where a sandbox exists. It never runs candidate code
on the workstation host. It verifies the capture manifest, derives authenticity from archived metadata and archived installation,
copies only `objects/` of each archived repository into a fresh bare repository (alternates refused; agent config never used),
binds with objects.ts, grades with the unchanged grader, lists every commit referenced and whether its objects are retained, and
compares with the live read per invocation (class, authority, binding status, export digest, grade, confirmed/false/unconfirmed).
Any disagreement means **not demonstrated** until explained.

## 9. Criteria

**LIVE GUEST BOUNDARY DEMONSTRATED** only if all hold: first stop and root view pass for the measured identities; availability
attributable; both runs exit 0 with every row `held` and every IA1–IA4 true in `results.json`, **and** each run's trace holds every
required refusal; the reader runs to completion with zero false PASS and zero unconfirmed PASS, every authentic PASS bound and graded
correct, every authentic PASS for A or P bytes only, no authentic PASS for an incorrect candidate; C, D, E, G hold; pre/post compare
identical; offline reanalysis (both places it runs) has zero disagreements and no missing objects for any record commit; uninstall and
guest cleanup verified; host teardown verified.
**BLOCKED:** a prerequisite in §4 fails. **INCOMPLETE:** a missing observation (including an empty or missing trace), a run that does
not finish, a missing capture, an unavailable sandbox, or a reanalysis that cannot run. **FAILED:** an authentic PASS for an incorrect
candidate, an unauthorized modification (agent-writable protected path, pre/post difference attributable to the agent, record not the
verifier's), Git or the grader running with root's authority, or a control that confirms what it must not. Incomplete is never
converted to success because other rows passed. Workstation H0 stays **BLOCKED** regardless.

## 10. Stop conditions

Stop and record, without weakening any gate: pin or digest mismatch at staging; first stop failure; QEMU audit showing a NIC, share
or listener in a test boot; a run exceeding its poll budget; non-quiescence; a failed pre-read capture (no read). After the read, a
failure is recorded and every remaining step that does not depend on it still runs, so that evidence is preserved.

## 11. Cleanup and rollback

In the guest ([guest/finish.sh](guest/finish.sh)): `uninstall.sh` with its own record archive, `inspect.sh`, removal of the control
state, a census of both principals, units, the grading uid and listeners; export of `/root/out` (including the immutable captures) as a
tar to the out disk with its size and digest, re-read from the device. On the host (`host.sh collect`): digest checked against the
guest's; evidence copied into this directory with separate manifests. Then poweroff, the analysis boot (§8), poweroff, `host.sh
teardown` (overlay, base image, seed, stage/out disks, FIFOs, console log), and checks that no QEMU process, no endo13 path and no new
listener remain. Nothing on the workstation changes; there is nothing to roll back outside `~/.capy/work/endo13`.

## Amendment 1 (before any guest boot of the frozen code)

The first `host.sh stage` of `c84981f4` failed on the host: the git bundle is 97.9 MB and `host.sh` truncated the stage disk to a
fixed 64 MiB, cutting the tar (`tar: Unexpected EOF`). Nothing was booted with it; the broken stage.img was overwritten. Fix:
round the disk up to the next MiB (`truncate -s %1M`) instead of a fixed size. No criterion, guest script or pin changed.

## Amendment 2 — 2026-11-19, before attempt 2

The [attempt-1 diagnosis](https://github.com/noctem-o/endophasia/pull/161) is historical evidence only. Section 4's
supplemental census distinguishes two exact entries from writable protected state. Neither is a prefix exemption.

- For `/run/endo-verify-002/verify.sock`, guest root requires a verifier:verifier socket (0666) in a verifier:endoagent
  directory (0750), with uid 1500 the group's only member across primary and supplementary membership. A separate
  endoagent PAM login checks its own identity, walks the directory without descending into symlinks, and measures
  effective write access: the socket must be the only writable node. Read or enumeration errors abort the review.
  This permits submission, not replacement of the socket or trust in a message, response, parser or record.
- For `/var/lib/endo-verify-002-home/.config/systemd/user/p11-kit-server.socket`, lstat must show a root:root 0777
  symlink and readlink must return exactly `/dev/null`. The 0755 seen in attempt 1 belonged to its parent. Write
  access through this link reaches the null device; it does not grant the directory write needed to replace the link.

Both checks require real ancestor directories, root-owned except for the verifier's socket directory, no group or
other write bits, and no effective ancestor write access in the agent session. A missing or mismatched observation
stops the census even if neither entry occurs in its original output. No state, record, installation file or unit
in /etc qualifies. These point-in-time checks do not establish that metadata cannot subsequently change.

SHA-256: `guest/run.sh` a4d2ba2a45f45ed5c83ab1f6c75d3072762d6b3c2b212181c8a5e56a7ec2199b;
`guest/review.py` ccf333984bf2807c02bd4e69a40883f8c656be004703fcfb34e886b67e12c44d;
`guest/test_review.py` 887c903c5203d1a7478b8fc1790e5e877df5465206979373fb9266cc30a200ad;
`tests/develop-verify-trust-004.test.ts` ebd36f58be07e3fd18e8cca07907836fabc379371498dcd1c7e15302442f227b.
The adjacent frozen manifest also pins this amended protocol.

## Amendment 3 — evidence integrity, before the second guest attempt

No guest was launched against Amendment 2 for attempt 2. The offline reader must refuse missing or unlisted
evidence inputs and must not follow links or block on special files when reading packed refs. A failed
operator action, evidence comparison, control or trace check must reach the caller as a failure. A process
that exits during identification is a refusal, not a successful interruption.

The host audit must identify this guest without relying on a process name truncated by Linux. Console
transfer requires a successful child and guest result, and console connection must respect the command
deadline. These are evidence collection and acceptance changes; they do not change the guest image,
package versions, candidate fixtures, oracle or verifier. Amendment 2 remains available at `861cd826b`.

## Amendment 4 — evidence binding and operator authorisation, before the next guest attempt

No guest booted for attempts 2 and 3, and none has booted against this amendment. Attempt 1's retained overlay and console
(`~/.capy/work/endo13/vm/`, SHA-256 `26c0877e…febf18b` and `114f3469…a7dcbce`, unchanged at this amendment) stay as they are.
The criteria in §9, the verifier, the reader, the driver, the pins, `run.sh`, `finish.sh`, `capture.sh`, `host.sh`, `boot.sh` and
`console.py` do not change.

**Offline binding.** [reanalyze.ts](reanalyze.ts) made every clean repository with Git's default SHA-1 format, so a SHA-256
candidate could not be bound offline. It also copied a captured `objects/` with `cpSync`, which keeps symbolic links: a fan-out
directory or `.git` linking outside the capture let the offline binding read objects that were never retained and call a PASS
bound. Now each archived repository is refused unless no path on the way to it, and nothing under its `objects/`, `refs/`,
`config` or `packed-refs`, is a symbolic link or special file. Its object format is the one its archived configuration declares,
read as text (includes, continuations, repeated or unknown values, or the extension in a version 0 repository are refused).
That format is accepted only if every loose object hashes to its own name and every pack and index carries its own trailing
checksum under it. The clean repository is created with `--object-format` set to that value. A refused repository is listed with
its reason and is never searched for a commit, so a PASS that needs it is unconfirmed (§9: not demonstrated). Tests: valid SHA-1
and SHA-256 repositories, loose and packed, bind; contradictory configuration (loose and packed) and malformed format metadata are
refused; a commit reached only through linked fan-out directories, `objects`, `.git` or `objects/pack` is never bound. Run
against the previous reanalyze.ts, both SHA-256 cases come back `unavailable`, and the fan-out and `.git` cases come back
`valid` from outside the capture.

**Operator authorisation.** The supported workflow is **one complete frozen experiment per fresh guest, started by an operator**.
It is not a split operator/reader session: run.sh is unchanged and still runs without a pause from the first stop to trace analysis.
[guest/session.sh](guest/session.sh) adds one decision point, before anything is installed. `session.sh plan` records the staged
commit, the stage-disk and bundle digests, the plan checkout and its frozen-manifest check, whether the running session.sh is the
staged commit's, the network interfaces, shared or FUSE mounts, block devices and their write state, virtualisation, hostname,
kernel and pinned package versions, and whether the guest is fresh. It also lists the pending actions, and prints the plan's
digest. `session.sh run <digest>` accepts only a terminal on `/dev/ttyS0` as guest root. It refuses a digest that is not the
current plan's, a plan older than 1800 s, a refused plan, or a guest whose recomputed plan differs by a byte. It then requires
the operator to type `AUTHORISE <first 16 hex digits>` within 300 s, and refuses if `/root/out` already exists. Then TRUST-003
`stage.sh`, `run.sh` and `finish.sh` run in transient units (limits 1800 s, 18000 s, 1800 s). Ctrl-C stops the current unit and is
recorded as an interruption. A unit limit is recorded as a timeout. A unit or experiment unit that cannot be confirmed stopped, or
an agent process that survives, is TERMINATION UNCERTAIN: finish.sh is not run, nothing is exported, and the guest disk is kept.
Otherwise finish.sh always runs and the session prints the export size and digest only when both guest digests agree. The account
the session prints is the harness's own report. It interprets run.sh's status with the timeline: 8 before a trusted read means the
pre-read capture failed and the read was prohibited. [qemu/attach.py](qemu/attach.py) gives the host operator the serial console:
keystrokes in, output to the terminal and to `console.log`, under an exclusive lock so that only one reader drains the pipe. A new
regression in [guest/test_run.py](guest/test_run.py) confirms that a failed pre-read capture returns 8 without calling the reader.

**Limits.** The confirmation proves that something wrote it to the serial console within the time limit. It does not prove that a
person did, because whoever controls the host's `con.in` can type it; console.py's `</dev/null` wrapping cannot satisfy the
terminal check, but that is not authentication. Principals stay separate and are recorded as before: the agent `endoagent`
(1500), the verifier `endo-verify-002`, the grading identity `nobody` (65534), guest root as the evidence operator, and the host
operator's own uid outside the guest. An authentic record, a correct grade and independently reanalysed evidence remain three
different findings (`authenticity`, `grade`, and the reanalysis's agreement and binding).

SHA-256: `reanalyze.ts` 078acd7ae894601bad45b0075fdcd55a445577d3bc2cf9f353394182a4a5630f;
`guest/session.sh` 122f0f02769bfc8c3236155b9cedd77f37c7bc75478b7097e9f263bc5323033f;
`guest/test_session.py` 585e50ff8a43229038f260558430b83baa0795ac103a5f02a6ba74524880c93d;
`guest/test_run.py` 099f371a5bbf1003ffecf1600a656528dd41f0bebcefae1b32b5379a639abbdc;
`qemu/attach.py` 71a50503eb5170807dd2ad2718e34367abbf7b93c86ac4b279b5d0f877d5540d;
`qemu/test_attach.py` 009b1c807d0babbfb0066869917ae0620475719eff8b949207ad268cfe2864fd;
`tests/develop-verify-trust-004-reanalyze.test.ts` a4e92c043d09f6408db03af0531b4c1310bf524260e4d95d47ed4e325054193b;
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` d4e4061809a123a98aa8b20d76a864e6249b7951d9acb0103df5e21c2851dac3.
The adjacent frozen manifest lists these new files and pins this amended protocol. Amendment 3 remains available at `c3d16713b`.

## Amendment 5 — operator-path fail-closed corrections, before the next guest attempt

No guest has booted against Amendment 4 or this amendment; attempt 1's retained overlay and console are unchanged. Eight review
findings on the operator path are corrected. None changes the verifier, the reader, the driver, run.sh, finish.sh, the pins, the
§9 criteria or TRUST-003's files. Measurement and operator code only; every correction makes a failure refuse or stop rather
than proceed.

**session.sh.** (1) `plan` printed an empty stage-disk, bundle or frozen-manifest digest when the read or the hash failed, so a
plan could be AUTHORISABLE, and a repeated failure in `run` made the two plans equal without binding approval to the stage disk.
Each digest is now accepted only as 64 lowercase hex digits from a hash command that succeeded; otherwise the field reads
`UNAVAILABLE` and the plan is REFUSED (`refused <input> SHA-256 could not be computed`). The stage disk path is `STAGE_DISK`
(`/dev/vdb`) so that the fixture can substitute it. (2) A step whose unit could not be confirmed stopped after its process ended
set TERMINATION UNCERTAIN but still returned 0, so `run` could start after staging that might be alive. A step now returns 0
only for exit status 0 **and** a confirmed stop; otherwise its result carries `, stop not confirmed` and nothing further is
launched. (3) An operator interrupt that arrived as a unit reached a terminal state, or before the next unit's first poll, was
ignored. A step now refuses to launch while an interrupt is pending (`<name> not-started (operator interrupt)`), and a terminal
state seen with an interrupt pending is recorded with `, operator interrupt` and is not success.

**attach.py.** Input to `con.in` was written synchronously, so a large paste into a guest that stopped reading also stopped the
relay draining `con.out` and reading the terminal, and Ctrl-] never detached. Input is now queued and written only when `con.in`
is writable, multiplexed with output and the terminal. Detach always returns; input the guest never accepted is dropped and
its size reported.

**reanalyze.ts.** A file where a fan-out directory belongs reached `readdirSync` and aborted the whole reanalysis. A two-hex
fan-out entry that is not a directory now refuses that repository (`object format: objects/<xx> is not a directory`), and an I/O
error during link or format validation refuses the repository (`unreadable: …`). The other repositories are still analysed.

**OPERATOR.md** (not frozen; operator instructions only). Section 4 runs as one gated block, so a failed collect, a missing or
checksum-invalid pre-read capture or a checksum-invalid post-read capture stops before anything is copied or sealed. A missing
post-read capture is reported separately and sealed as missing evidence. After sealing, `$E` alone is made writable again and
`$E/analysis` is created, so section 5's collect can run; the evidence files stay read-only. Section 5 records the analysis
guest's own listener baseline before launch and audits against `$W2`.

Tests, each failing against the Amendment 4 code and passing now: `guest/test_session.py` `PlanDigests` (an unreadable stage
disk, bundle or manifest, and a failing hash command, end to end through `plan` and `run`), `Interlocks` (stage not confirmed
stopped never launches run; an interrupt as stage ends, or before run's first poll) and `Steps` (interrupt before launch; the
updated `ended but not stopped` case); `qemu/test_attach.py` `test_detaches_while_the_guest_stops_reading_a_large_paste`;
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` "refuses a repository with a file where a fan-out directory belongs";
and `tests/develop-verify-trust-004-operator.test.ts` (new, not frozen), which runs OPERATOR.md's section 4 and section 5 host
blocks against stand-ins.

SHA-256: `guest/session.sh` 43a348be67a002f14de87fa6769776742031b2ee348f67570d424079ea60896c;
`guest/test_session.py` e6f4ce85ce351d86a2884eff4530779eee752b8884bee9ab1945ba33009c745e;
`qemu/attach.py` a61db093d56cbc81c61d622f72587784ca327249fc6a8ab1012f3470e3133014;
`qemu/test_attach.py` 9f922fd62d5838ed9b3a7b3314bbe258e04ca7acaf6cf0619bd1406bda3a7ce1;
`reanalyze.ts` f800d015876a3673beabe857fb1108ac0631b7e99c9acbcf11c2cbcc177150f9;
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` 7f024826bf269828f759d0d26749d75a081fd9588d66484f681d2ab212e1010f.
The adjacent frozen manifest replaces these six entries and pins this amended protocol; it still lists 32 entries. Amendment 4
remains available at `0759a4c31`.
