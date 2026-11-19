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
