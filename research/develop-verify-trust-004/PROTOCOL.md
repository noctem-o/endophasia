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

## Amendment 6 — second operator-path review round, before the next guest attempt

No session command has run against Amendment 5. A guest was booted and attached for a handoff on the strength of a green
Amendment 5 head, and the operator powered it off without running `plan` or `run`, as the console log confirms. Eight further
review findings were open at that point. A handoff now requires green checks **and** zero open review findings. None of these
corrections changes the verifier, the reader, the driver, run.sh, finish.sh, the pins, the §9 criteria or TRUST-003's files.

**session.sh.** (1) `run` checked the digest, the age and the recomputed plan only before the blocking confirmation, and then
archived whatever `plan.txt` held. After the confirmation it now snapshots the plan to `authorised.txt`, requires the snapshot's
digest to be the confirmed one, the plan to be within its age limit (measured from the time the plan was read before the
prompt), and a fresh `plan_body` to match the snapshot byte for byte. The archived `out/session/plan.txt` is that snapshot, and
its digest is checked again after the copy. (2) A failed write of the plan, its digest or its copy is a refusal (status 10), and
no plan is left current. A failed write of the archived plan or of `authorisation.txt` is a refusal before anything starts.
(3) A finish unit that is not confirmed stopped is TERMINATION UNCERTAIN: no export line and no collect command are printed, and
the session returns 75.

**reanalyze.ts.** (4) A record is trusted only if the capture listing's mode and the archive header's mode agree and neither
grants group or other write. (5) A record is opened only when both the listing and the archive say it is a regular file, and then
only through `readRegular` (`O_NOFOLLOW`, regular-file check). Otherwise its row is `UNKNOWN`, non-authoritative and
`not opened`. (6) A record that does not parse as a JSON object gets a non-authoritative `malformed-record` row, and the other
invocations are still analysed.

**OPERATOR.md** (not frozen). (7) The analysis guest powers off only after the result was written and the device prefix reads
back with the archive's digest; otherwise it prints `ANALYSIS NOT WRITTEN` and stays up. (8) Amendment 5's text said an
incomplete run, including run.sh status 8, was reported and sealed. That was wrong: without a verified pre-read capture, custody
stops at exit 3 and nothing is sealed. The text now says so and tells the operator to keep `$W` and `$E` and report INCOMPLETE.

Tests, each failing against the Amendment 5 code or text and passing now: `guest/test_session.py` `Authorisation.test_checks_again_after_the_confirmation`
(expired, replaced plan, changed guest), `Authorisation.test_a_failed_authorisation_record_starts_nothing` (copy fails, archived
bytes are not the confirmed ones, `authorisation.txt` unwritable), `PlanWrites.test_a_failed_plan_write_leaves_no_current_plan`,
and the `Flow` case "finish not confirmed stopped: export not announced". Also
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` "record metadata and content": two mode disagreements, a symbolically
linked record and a malformed record beside a second invocation. The controls are a listing with an unsafe mode and agreeing safe
modes. Finally `tests/develop-verify-trust-004-operator.test.ts` covers the analysis write-back (a failed write and a mismatched
read-back stay up) and the status-8 custody text. The session test fixtures that stub `authorise` now leave the snapshot a
successful `authorise` leaves, and pass the plan's real digest.

SHA-256: `guest/session.sh` 61c42b4525c43c0059729075583f14f85900a199e388522c1f8342fd2ceede3e;
`guest/test_session.py` d376012055e3768df20f140c8d9e41d9e55d56d3be368ae0b2217f4cde33271c;
`reanalyze.ts` 9ea8db46be1aed4f8a28bc3b21bd6763c024624d93bc0e3c54e28f5f45049716;
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` 3bdc71bbdf783cd98a4443320fae98a53c82251962dd17636c14752ee542b24a.
The adjacent frozen manifest replaces these four entries and pins this amended protocol. It still lists 32 entries. Amendment 5
remains available at `f6e9d23d6`.

## Amendment 7 — third operator-path review round and freeze selection, before the next guest attempt

No session command has run against Amendment 6. Two process corrections come first. At the Amendment 6 freeze `870e8aafd`,
`FROZEN.sha256` pinned `guest/session.sh` while that commit's OPERATOR.md still quoted the Amendment 5 digest. A cold operator
staging that commit would have aborted a valid run. The selected source commit is therefore no longer the commit that adds an
amendment. It is the first later commit that carries the same manifest and whose OPERATOR.md quotes exactly the manifest's digests.
`tests/develop-verify-trust-004-freeze.test.ts` (CI job "TRUST-004 operator freeze consistency", full history) enforces this:
every frozen-file digest the page quotes must be that file's manifest entry, and the selected commit must carry this manifest, a
page that passes the same check, and files that hash to it. Four further review findings are corrected. None of them changes the
verifier, the reader, the driver, run.sh, finish.sh, the pins, the §9 criteria or TRUST-003's files.

**session.sh.** An interrupt that arrived during `settle` or `account` was cleared before `finish` and could leave a session
reported as exit 0. It is now appended to `account.txt` before the export, and a session with any recorded interrupt never
returns 0.

**reanalyze.ts.** (1) `summary.byClass.UNKNOWN` counted only authoritative rows, so unread and malformed records were reported
as zero. It now counts every `UNKNOWN` row, as `INCOMPLETE` already did. (2) A retained commit whose objects could not be read
was reported as `commit-not-found` and counted in `commitsWithoutObjects`. A failed acquisition now counts as absence only when
`git cat-file --batch-check` confirms `missing`. Otherwise the binding is `commit-unreadable`, with each repository's failure
listed, and the summary lists it under `commitsUnreadable`.

**OPERATOR.md** (not frozen). The analyst command printed `reanalyze exit=` but then exited 0. It now exits with reanalyze.ts's
status, and the block prints `analyst command exit=`.

Tests, each failing against Amendment 6 and passing now: `guest/test_session.py` `Flow` cases "interrupt during settle" and
"interrupt during the account" (rc=1, recorded in `account.txt`); `tests/develop-verify-trust-004-reanalyze-repos.test.ts`
"commits that cannot be bound" (a retained commit with a missing tree object is `commit-unreadable`; the control, an absent
commit, is `commit-not-found`; a malformed record counts under `UNKNOWN`); `tests/develop-verify-trust-004-operator.test.ts`
"analyst command status" (exits 0 and 3 propagate).

SHA-256: `guest/session.sh` 6a989d68101c44143f6c73d5733241f50b0243fde8738bae44e7b201e4d57abf;
`guest/test_session.py` 1727d31a488969b1dc6d7256f174cf17e084225797565c197b36e601dabf16fd;
`reanalyze.ts` bb6ce02f50b2a11f4110fd924fe3ff1759418cec99d58904054274d57e9bfda0;
`tests/develop-verify-trust-004-reanalyze-repos.test.ts` da80ddac564236c8d7f81dc6cd7e2efed7502fbdbce20e0779ec6e2989ae7098.
The adjacent frozen manifest replaces these four entries and pins this amended protocol. It still lists 32 entries.

## Amendment 8 — raw custody, guest-only intake and record authority

This amendment supersedes every earlier instruction to extract or inspect the guest export on the workstation.
A previous guest was powered down without a session command (operator report). No previous attempt is replaced.
The grading criteria and TRUST-003 are unchanged. Use fresh paths and retain failed or partial attempts.

- **Protected ancestors (4634949200).** The eleven paths measured by capture.sh each require exactly one
  parseable metadata row, the expected type and owner, and no group or other write permission. Missing, duplicate,
  unexpected and malformed rows invalidate authority. A plausible record alone cannot compensate for missing ancestry.
- **Custody (4634864029).** The workstation retains only an opaque byte prefix with the declared size and SHA-256,
  plus host custody records. collect.py never enumerates archive members. A matching hash is a transport check,
  not an authenticity finding. This applies both to the original export and to the returning raw analysis report.
  Diagnosis of missing or corrupt captures happens only in the disposable analysis guest. A raw export can be retained
  even when the pre-read capture failed; that run remains INCOMPLETE.
- **Guest intake (4634864095).** Guest root verifies the exact size and digest on the copied disk before providing
  a read-only input. The trusted code comes from the host-staged read-only disk and a root-owned checkout, not the
  evidence. The unprivileged analyst runs that code on a separate, fresh data directory. extract.py admits only its
  bounded regular-file/directory archive subset and normalizes modes. Absolute and noncanonical paths, parent
  components, duplicate names, file/directory conflicts, links and special files are refused. Nested archives
  used by the analyzer are preflighted and extracted with the same parser; metadata listing is not extraction.
  Missing or rejected inputs are not successful reanalysis. Prior attempts and their disks stay untouched.
- **Account publication (4634949204).** A failure producing, publishing, reading back or annotating the account
  prohibits finish and export. Preserve the disk on refusal, with status 75 taking precedence on uncertain termination.
- **Freeze retention (4634864033).** The durable lightweight tag `refs/tags/trust004-amendment-8` selects the
  freeze even after the PR branch moves. The page inside the freeze resolves this tag instead of naming its parent.
  The subsequent operator-page commit also pins the literal SHA. The full-history CI check requires the tag, selected
  commit and manifest bytes to agree, verifies each frozen blob, and checks the digest quotations in both pages.

Offline regressions cover omission of each protected ancestor, malformed and duplicate metadata, interrupted
account publication, byte-for-byte collection of both archive and non-archive inputs, short reads and mismatched
digests, inert invalid archive entries, separation of code and inputs, and the command blocks in OPERATOR.md.
These checks are not a live result. The operator handoff still requires a reviewed head with no open findings.

Changed or added pins (the manifest also records this amended protocol's own digest):

- `research/develop-verify-trust-004/guest/check-input.py`: `061291e662710edfc8a4897559f4f5e45884a0206e6786bbba03bf1422b8c2ee`
- `research/develop-verify-trust-004/guest/extract.py`: `788e8c202633e8c8bf158b3106c71408a8b30ddfb59fa6aa14971807660dc0aa`
- `research/develop-verify-trust-004/guest/session.sh`: `08f46c4335622f48ded2dd405a64770e4263a2c333249e2294ee2e80d28ecef3`
- `research/develop-verify-trust-004/guest/test_extract.py`: `c8b4fa38722410b1cd33fedde23a5b1da7e044cd90b55ca577c435edafe04efc`
- `research/develop-verify-trust-004/guest/test_session.py`: `8bc37102228c9005822d5bdb2e5de9b55f3318ce973ddaddbe5f2991ad2afc05`
- `research/develop-verify-trust-004/qemu/collect.py`: `1311f4eafd52d4d2e05ec133579e2f5beacc60ec1e8a45a919a71151b1455ff6`
- `research/develop-verify-trust-004/qemu/host.sh`: `f888ed7956259be3353507e790ac9e059a6e074defb5924506bba8d016518377`
- `research/develop-verify-trust-004/qemu/test_transport.py`: `d31c31e0f5bb30dc633b6062a5b2b189f3317347b020017088e484850bf3c668`
- `research/develop-verify-trust-004/reanalyze.ts`: `e7687a6d617e5df97ab7a24f74d43280e6a1a572b3ac1df2662446f1650ee6cd`
- `tests/develop-verify-trust-004-reanalyze-repos.test.ts`: `f1ebf8117be281f6b8e6d5237d8492f1e774ebc1129d129abe2885c402237a33`

## Amendment 9 — independent review of Amendment 8, before operator handoff

The Amendment 8 tag remains unchanged. This successor freeze preserves its custody model, authority requirements,
roles and acceptance criteria. Independent review identified three corrections:

- Reject an invalid raw directory spelling before tarfile normalizes it, including repeated separators at the USTAR prefix/name boundary.
- Record required repository archive extraction refusals in the report and exit nonzero on any such failure, independently of PASS counts.
- Latch every session interrupt in the signal trap. Consume the pre-finish flag before annotating the account; a later interrupt remains
  pending for finish and cannot turn the session into a clean success.

The review of the pushed head identified three more corrections:

- **4636323032:** host.sh requires an explicit work directory and has no teardown command. This workflow does not delete any guest work directory.
- **4636323065:** verify both host custody manifests before the final host checks. Retain the disks, logs and source on both success and failure.
- **4636323041:** incomplete trusted-read JSON makes its optional summary unavailable, not the account unwritable. Record that fact, allow
  cleanup/export when termination is confirmed, and return nonzero. An actual failure writing the account still prohibits finish/export.

Offline fixtures cover an inert noncanonical directory header, repository archive refusals, a signal at the transition to finish,
a partial trusted read, a refused teardown with an isolated fake HOME, and corruption in either custody manifest.
No live guest result is asserted. Changed pins, in addition to this protocol:
- `research/develop-verify-trust-004/guest/extract.py`: `d2a2e2fd6baa72e99278b141fca7acb5b07ad7531dac899d887b36de61f6f652`
- `research/develop-verify-trust-004/guest/session.sh`: `8cc8b2a232513699d07527da48f1a414695d619c8b3a0467e6040f808e4dbc3c`
- `research/develop-verify-trust-004/guest/test_extract.py`: `bb6e1553a9cc5bf9da6aaeed64aee317e5c22f629d92adc49a84cc98e6969cd4`
- `research/develop-verify-trust-004/guest/test_session.py`: `0b6ec30b0e44e4360ffe546ddf82520a9f9c8daceeaf6b4fc81517e86a26bd05`
- `research/develop-verify-trust-004/qemu/host.sh`: `91707e509a974e4facd9babde83cd3c43d27ceeac97de5e20f088052ef2ccf4a`
- `research/develop-verify-trust-004/qemu/test_transport.py`: `6b7531248baee45e799b4c9481bdf1483fea802066ec8bd4c2cfe645ebda89da`
- `research/develop-verify-trust-004/reanalyze.ts`: `100b8e36b483d6369c7e4d3ec1352cf0432e6bbac46777c1a967ffba3ee443e9`
- `tests/develop-verify-trust-004-reanalyze-repos.test.ts`: `aa1a0188b40eef9352c5d31ffb8664851aa5a7309ae531f99ad24139c6486254`
## Amendment 10 — IA3 classification defect found by attempt 2

Attempt 2 staged Amendment 9 (`c7c5208917a4be8fe11d9e110ce39b300ebcd66b`) and ran the first installed matrix; according to the
analysis of attempt 2, all twenty rows held. The harness then reported `IA3 false` because of one authoritative record, `c14bbe75…`:
the availability request's PASS (§4 item 3). That record's candidate is correct: tree `2b0833f8…` and blob `3764e839…` are those of
the harness's own candidate A, and its export digest `42c5a86c…` recomputes from those bytes and equals TRUST-002's genuine PASS
for A. So run 1 exited 1, run.sh stopped with status 6 before the pre-read capture, and attempt 2 is **INCOMPLETE**. This amendment
does not reinterpret attempt 2. Its evidence is retained unchanged.

**The defect is in the harness's classification, not in the boundary.** `rehearsal.ts` (lines 1082–1087) called an authoritative PASS
false when its record's commit was not in `correctCommits`, which holds only the commits that this harness run created (A, P,
Aslow). Any equivalent candidate committed elsewhere was therefore a "false PASS". The availability record exists on every installed run, so
IA3 failed on every installed run and no live result was possible. Reading the code also shows that run 2 would have failed the
same way on run 1's genuine PASSes, because the harness commits its fixtures at run time and run 2's commits differ from run 1's.

**Corrected rule.** A PASS is a false PASS only when the export digest sealed in its record is one that the truth table judged
incorrect. The truth table is keyed by export digest. The harness computes it by running the pinned oracle on each candidate it
builds (A, B, D, E, P, S, X and M as before, plus Aslow, which T10 and E6 submit on the installed target; its 4 s per case gets a
15 s limit instead of 5 s). It throws if two candidates share a digest but disagree. Each authoritative PASS gets exactly one
disposition. **correct** means the truth table judged its digest correct. **false-pass** means the truth table judged it incorrect.
**uncovered** means the table has no entry for that digest or the record names none: uncovered PASSes are listed, counted and
fail IA3, but are never called false PASSes. IA3 holds only with no false PASS and no uncovered PASS. Each PASS also carries its
origin: `preexisting` when its record was already present when the run started (the availability request, or run 1 seen from
run 2), otherwise `this-run`. So the availability record is judged explicitly, like any other record, and counted once.
`results.json` adds `records.authoritativeUncovered` and `records.authoritativePasses` (one entry per PASS with its origin,
commit, export digest, truth-table candidate and disposition), and `rehearsal.log` prints the same list. RA5, the other acceptance
criteria, the rows and §5's statement that `results.json` is an untrusted derived report are unchanged. The trusted read
(TRUST-003 `read-records.ts`) and the verifier package are unchanged.

**Where the fix lives.** The merged harness cannot be edited. TRUST-003's `stage.sh`, action 1 of every session, checks
`research/develop-verify-trust-003/evidence/guest-checkout.sha256`, which pins `research/develop-verify-trust-002/rehearsal.ts`.
TRUST-003 stays byte-identical. Therefore:

- `guest/passes.ts` is the classifier (`truthByExport`, `classifyPasses`), pulled out of the inline filter so that it can be tested.
- `guest/harness.ts` is the merged harness copied unchanged except for the hunks recorded in `guest/harness.patch`: module paths,
  the truth table by export digest with Aslow, the preexisting set, and IA3 from `classifyPasses`. A test requires that `diff -u`
  between the merged harness and the copy equals that patch byte for byte.
- `guest/run.sh` redefines matrix.sh's `start_run` after sourcing it. The only change is the harness path, which becomes
  `$T4/harness.ts`. TRUST-003 `matrix.sh` is unchanged.

The superseded rule is still the merged `rehearsal.ts`. §5's "merged TRUST-002 harness" now means this copy for IA3's
classification and that file for everything else.

Tests (`tests/develop-verify-trust-004-passes.test.ts`, `guest/test_run.py`):

- *does not flag a sealed PASS whose export digest is the truth table's correct candidate, whatever its commit*. It fails under the
  commit rule, as checked by mutating the classifier back to that rule. Three more of the tests also fail under that rule.
- *still flags a PASS bound to an incorrect candidate's export digest as a false PASS*.
- *reports a PASS whose digest the truth table does not cover as uncovered, failing IA3 without calling it a false PASS*.
- *counts the availability record exactly once, labelled preexisting*. Listing a record twice is an error.
- *refuses a truth table in which two candidates share an export digest but disagree*.
- *runs a harness that differs from the merged TRUST-002 harness only by harness.patch*.
- `test_runs_the_amended_harness`: `start_run` launches `guest/harness.ts`, and never `rehearsal.ts`. Without the run.sh change
  this test fails because `start_run` is not defined.

Measured offline on the workstation (not a guest result): candidate A committed in a fresh repository has export digest
`42c5a86c8341fb86df19d4d6d74add34c723eb12966c2fce733aa2aac36f4b3b`, which matches the prefix attempt 2's analysis found. Aslow
exports `3a2e063f31ca1add89be971de7a40917ee84caa40533dc57eaa78e2504dcab11` and one oracle case took 4.03 s. The amended
harness has not been run end to end: the rehearsal target registers user units and the installed target needs the guest.
If the honest outcome of the next attempt is IA3 false for a real reason, that is reported as **FAILED**.

Changed or added pins, in addition to this protocol:
- `research/develop-verify-trust-004/guest/harness.patch`: `4f69c68e971120cf828b309e8c83cf7002d494ea152bb6f2ef6bf2480c31fd25`
- `research/develop-verify-trust-004/guest/harness.ts`: `319c5d05a3045b4cc45aa36e23b6f92da1f704505ba7bc1b09df5cbac425e440`
- `research/develop-verify-trust-004/guest/passes.ts`: `931221dc8832fc132337d103af4e9d16ba37f463bf08de50cc1275e67f760b7a`
- `research/develop-verify-trust-004/guest/run.sh`: `298aa0734450cb298ebc9aad353e2f886536705d3d7c0e4a97f841a546ccf3a3`
- `research/develop-verify-trust-004/guest/test_run.py`: `b10b38c3e4c0636f9889080a44efdf1c9d4b2ffb28a1bc623b234b7daa9bb501`
- `tests/develop-verify-trust-004-passes.test.ts`: `1287829906c2690704104dfffce0d8178dba08ed25ddd7d500004baf7db5c063`

## Amendment 11 — review of Amendment 10, before operator handoff

The Amendment 10 tag remains unchanged. Its IA3 rule, the roles, the authority requirements and the acceptance criteria are kept.
Review of the pushed head found two corrections:

*Severity (added with Amendment 12):* the `collect` finding is the most serious defect review has found in this harness. The
evidence path itself, run as root, could be steered by the principal under test into exporting root-readable guest files. Our
own evidence collection was the weakest link, not the verifier boundary.

- **4636855623 (collect).** TRUST-003 `matrix.sh`'s `collect`, which run.sh reuses, runs as guest root. It copies
  `/home/endoagent/probe-*.strace` with plain `cp`, which follows a symbolic link. The agent owns that directory, so it can
  plant a link that puts a root-only guest file into the evidence `finish.sh` exports, or a FIFO that blocks root. run.sh now
  redefines `collect` after sourcing matrix.sh. The listings and the inspection are unchanged. Every file under the agent's home
  (the harness reports of both runs and the probe traces) is copied by the new `guest/agentfile.py`. It opens each path component
  relative to the previous one with `O_NOFOLLOW`, and opens the file non-blocking. It accepts only a regular file owned by the agent
  uid of at most 256 MiB. A refusal is written to `collect-refusals.txt` and fails `collect`, which run.sh records as a nonzero
  status. An absent file is skipped as before. The absent status is 3, which the interpreter does not use itself, so a missing
  reader fails closed. TRUST-003 is unchanged.
- **4636854497 (analysis block, OPERATOR.md only).** If the post-read capture was missing but reanalysis succeeded, the analyst
  block exited 0. The report is still produced and retained, but the block now exits 1 in that case. A nonzero reanalysis status
  is reported unchanged.

Offline regressions (`guest/test_run.py`): agent files are copied and an absent one is skipped. A final link, a link to a
directory, a FIFO and a file owned by another uid are each refused, with the secret absent from the output and `collect`
failing. `collect` also fails closed without its reader. These tests fail against Amendment 10's run.sh, where `collect` is not
defined. The operator test *successful analysis without a post-read capture* expects status 1 and fails against the previous
block. *successful analysis* now supplies a valid post-read capture. No live guest result is asserted.

Changed or added pins, in addition to this protocol:
- `research/develop-verify-trust-004/guest/agentfile.py`: `4881b21c8f0dd15516609aa64f781f9cd4f528d5452d284b3d9db3aaf177b442`
- `research/develop-verify-trust-004/guest/run.sh`: `752855bc661fbbdbf6cacb3e2134ac0f323c40fbf4c3e757ef4c724d472bb144`
- `research/develop-verify-trust-004/guest/test_run.py`: `9001144705c6eba48a66ca314f7d16b6ea8772009b9d20a67da390d003dd6a4b`

## Amendment 12 — the frozen operator page is the operator's page

Amendment 11's own copy of OPERATOR.md, inside `57e401c29`, told the operator to expect `frozen-check all 36 entries match`.
Its manifest has 41 entries. The branch page was corrected after the freeze, which left the operator to choose between two pages.
An operator who reads the page inside F (the page the stage disk holds and a cold start provides) would compare 36 against 41.
They would either abort a valid run or learn to ignore the check. This is the third time a frozen commit's page has contradicted
its own manifest. The section 1 check had the same failure mode (review 4636943999): it counted stdout lines, so a missing
manifest looked like zero failures. Each was a check that reported success because it did not actually run.

Corrections:

- OPERATOR.md is now a frozen file. The page in F is the page the operator reads. It names F by its tag
  (`refs/tags/trust004-amendment-12`), because a commit cannot contain its own hash, and later branch commits cannot change it
  without a new freeze.
- The page quotes no entry count. Section 1 prints `wc -l` of the staged checkout's FROZEN.sha256, and the authorisation
  checklist requires the plan's `frozen-check all N entries match` to show that N. Section 1's verification is
  `sha256sum --quiet --strict -c` and stops on any failure (Amendment 11 head review, 4636943999 and 4636944009).
- `tests/develop-verify-trust-004-freeze.test.ts` now also requires:
  - OPERATOR.md is in the manifest.
  - Every entry or file count the page quotes equals the manifest's entry count. A stale `36` is caught by a negative case.
  - The operator page on the branch is byte-identical to the page inside F.
  
  As before, it checks that the tag names F, that every frozen blob at F matches, and that every quoted digest matches.
- Amendment 11's text gains a severity line for the `collect` finding, the most serious defect review has found in this harness.
  Its tag and its frozen copy are unchanged.

No code, harness, rule or criterion changes. Amendments 10 and 11 stand. No live guest result is asserted.

Changed or added pins, in addition to this protocol:
- `research/develop-verify-trust-004/OPERATOR.md`: `f9cf16f8d292e93803f59810eff5068a668c3c39cd0ced30889f465b92dc7425`
