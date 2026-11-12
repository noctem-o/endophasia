# DEVELOP-VERIFY-TRUST-002: results of the unprivileged phase

**Decision: READY FOR APPROVED HOST EXPERIMENT**, by PROTOCOL.md §7: RA1 to RA9 hold.
- **Precondition.** H0 does not hold on this host (§3). The installed experiment is meaningful only after the operator removes the agent
  account's root-equivalent routes, and its harness stops itself if they remain.
- **Not installed.** Nothing was installed, no privilege was used, and nothing here shows that the boundary holds. What this phase shows is
  narrower: the design leaves ownership as the only remaining defence, and the attacks on ownership are real.

## 1. Chronology

| Step | Commit | Time (UTC, local commit dates) |
| :-- | :-- | :-- |
| Start: `main` after DEVELOP-VERIFY-TRUST-001 merged | `03ef6d1d6` | |
| Preregistration: threat model, architecture, protocol, fixtures; no trial yet | `5dc47d772` | 18:49:27 |
| Freeze: prototype, harness, unit tests, install artifacts; pre-freeze amendments in PROTOCOL §9 | `c968895fc` | 19:09:04 |
| Rehearsal run 1 (research worktree) | — | after the freeze, 83 s |
| Rehearsal run 2 (fresh `git clone --no-local`, checked out at `c968895fc`) | — | 83 s |
| Results, draft PR #147 | `239b7481e` | |
| Corrections after the independent review (§9) | `e1c52e02e` | |
| Confirmation run 3 (worktree, from `e1c52e02e`): identical on 20 rows | — | 84 s |

Development runs (unrecorded) preceded the freeze. One of them found that the unit's `WorkingDirectory` must exist before the first
request; the harness now creates the state directory, as `tmpfiles.d` does when installed.

## 2. The rehearsal matrix

Both runs produced the same 20 rows: same observations, same acceptance, same installation identity (`5635db35…`). From
[`results/run-1/results.json`](results/run-1/results.json) (run 2: [`results/run-2/`](results/run-2/)):

| Row | Observed | Held |
| :-- | :-- | :-- |
| T1 | A: PASS; reader: PASS, **not authoritative** (`verifier-is-reader`); requester pid and uid as `SO_PEERCRED` gave them (the harness's own) | yes |
| T2 | B: FAIL | yes |
| T3 | B with the caller's `NODE_OPTIONS` hook and a `node` shim first in `PATH`: FAIL; the verifier's environment holds neither | yes |
| T4 | Caller's `LD_PRELOAD`: B FAIL, A PASS; 2 preload markers, both from client processes, **0 from a verifier process** | yes |
| T5a | B's repository holds `git replace B A`. Plain `git show` gives A's file for B; the client's C1 read sends B's own objects: FAIL | yes |
| T5b | A hostile client sends A's objects and names B's commit: BLOCKED `object-missing` | yes |
| T5c | Partial clone with a marker `uploadpack`: the honest client refuses (`object-unreadable`); a hostile partial request is BLOCKED `object-missing`; **no marker** written | yes |
| T6 | **Positive control.** A concurrent same-uid process replaced the staged `roman.mjs` with A's: the write **succeeded**. All 15 candidate cases then matched, so B would have read PASS. The verifier's before-and-after staging digest made it INCOMPLETE `staging-changed`. Not authoritative. | yes |
| T7 | **Positive control.** A unit drop-in in the operator's runtime unit directory ran an edited verifier (001's R4b). The direct write to the installed code also **succeeded**. The edited verifier answered **PASS** for B, passing its own qualification. The reader read UNKNOWN `installation-mismatch` (the copy had its own manifest), not authoritative. | yes |
| T8 | **Positive control.** (a) The resealed forgery of T1's record for B was **written** into `records/`; reader: PASS, not authoritative (`verifier-is-reader`). (b) The same forgery in an attacker-owned state root, read with a fictional verifier uid: refused (`not-root's`). (c) A symbolic link in `records/` was **created**; reader: UNKNOWN `symbolic-link`. | yes |
| T9 | T1's PASS read as B's: `candidate-mismatch`; the consumer rule gives B `NONE` and A `NONE` (nothing is authoritative here) | yes |
| T10 | The instance was `SIGKILL`ed in the candidate phase: no response, the invocation reads INCOMPLETE (`journal-without-record`). The retry got a new id and PASS, and the orphan's working directory was removed. A client that hung up right after sending still got its record (PASS). | yes |
| T11 | No socket: `service-unavailable: ENOENT`. Wrong oracle pin: BLOCKED `oracle-not-pinned`. No user manager: BLOCKED `containment-unavailable`. Missing `bwrap`: BLOCKED `isolation-missing`. | yes |
| T12 | P (data file, temporary file, child `node`): PASS. X (writes its working directory): FAIL, signal `EROFS`. M (uncommitted package): FAIL, signal `ERR_MODULE_NOT_FOUND`. | yes |
| E1 | Symbolic link, submodule entry, entry named `..`: BLOCKED `unsupported-120000`, `unsupported-160000`, `unsupported-name` | yes |
| E2 | A and B at once: PASS and FAIL, distinct invocations | yes |
| E3 | Instance stopped mid-run (`systemctl stop`, as on a restart): INCOMPLETE; the next instance collected the orphan and gave PASS | yes |
| E4 | D (hangs on 3999), E (1 MiB of noise), S (70,000 bytes of standard error): FAIL each | yes |
| E5 | Oversized, `env`, `argv`, `expect`, unreferenced object, unknown task, malformed JSON: BLOCKED with `request-too-large`, `request-invalid` ×3, `object-unreferenced`, `task-unknown`, `request-invalid` | yes |
| E6 | **Positive control.** Reading the oracle, reading the live instance's `/proc/<pid>/environ` and signalling it: each **succeeded** | yes |

**Records.** 37 per run:
- 2 were written by the attacker (T8a, and T8c's link);
- **0 were authoritative**;
- **0 were authoritative false passes**;
- **0 were overwritten**.

**Ground truth**, by direct runs under the host `node`:
- A, P, S and X are correct by output. S's standard error is over the shared budget, and X writes its working directory.
- B (8 cases), D (1), E (1) and M (15) are incorrect.

**Timing.** About 3.1 s per request, wall time from the instance's start to its record. That covers qualification (30 sandboxes), 15
candidate sandboxes and a 28-probe preflight.

### Acceptance

| | Holds | Basis |
| :-- | :-- | :-- |
| RA1 | yes | T1, T2, T12; truth agrees |
| RA2 | yes | no incorrect or refused candidate read PASS outside the positive controls |
| RA3 | yes | T3, T4 |
| RA4 | yes | T6, T7, T8, E6 each succeeded at its tampering step |
| RA5 | yes | 0 authoritative records |
| RA6 | yes | T10, E3; 0 overwritten |
| RA7 | yes | T5b, T5c, T11, E1, E5 |
| RA8 | yes | runs 1 and 2 identical on all 20 rows |
| RA9 | yes | `tests/develop-verify-trust-002.test.ts`: 18 of 18 at the freeze (§4) |

## 3. Host audit (`audit.ts`, read-only)

[`results/audit.json`](results/audit.json):

| Check | Observed |
| :-- | :-- |
| `docker` group | **member**, `/run/docker.sock` writable: root-equivalent |
| `libvirt` group | **member**: polkit `YES` for system hypervisor management |
| `empower`, `lxd`, `disk` | not a member |
| `/etc/sudoers.d` | not readable: `NOPASSWD` cannot be ruled out by inspection |
| Yama `ptrace_scope` | 1 |
| `node`'s runtime closure (43 files), `node`, `bwrap`, `systemd-run`, `systemctl`, `ld.so.cache` | root-owned, not writable by others, root-owned ancestors |
| `/etc/ld.so.preload` | absent |
| Installation targets (`/usr/local/lib`, `/etc/systemd/user`, `/var/lib`, linger directory, `/etc/tmpfiles.d`) | root's |

**H0: false. Closure: true.** The installed target was also tried once in development: it stopped at gate IP0, ran no trial, and
touched nothing.

## 4. Tests

| Check | Result |
| :-- | :-- |
| `tests/develop-verify-trust-002.test.ts` | 18 of 18 at the freeze, and 20 of 20 after the runs: two tests added afterwards check the committed evidence (both runs identical, all acceptance held, nothing authoritative; the genuine and the forged record are equally self-consistent). The 18 cover: the object verifier (substitution, missing, extra, duplicate, wrong type, link, submodule, unplain and colliding names; a real SHA-1 and a real SHA-256 repository exported exactly); the request parser (every key that could carry a program, path, environment, option or expected result is refused, plus non-canonical base64, invalid UTF-8 and oversize); peer parsing; the reader's authority rules with another uid's ownership stood in for (a positive control, then seven ownership faults, links, forged ids, edits, another installation, binding, INCOMPLETE and the consumer rule); the installed import closure; the units; the compatibility signals. |
| Mutation check | Removing the file-owner rule, or the reader's-own-uid rule, from `records.ts` makes one test fail each. |
| `tests/develop-verify-trust.test.ts` (001) | 6 of 6, unchanged |
| `npm run typecheck`, `npm run lint` | reported in the PR |
| Install scripts | `sh -n` only. **Never executed.** |
| Package | built twice from the same tree: the same SHA-256 |

## 5. What this phase demonstrates, and what it does not

**Demonstrated without privileges:**
1. **The request cannot choose code, environment or configuration.**
   - Every field that could carry them is refused (E5, the unit tests).
   - The caller's `NODE_OPTIONS`, `PATH` and `LD_PRELOAD` never reached an instance started by the manager (T3, T4). This is structural,
     not a deny list: the instance's parent is the manager, not the caller. It closes 001's V1 for the verifier.
2. **Git metadata cannot substitute the candidate or run code in the verifier** (T5a to T5c), by construction: the verifier runs no Git.
   An honest client's C1 reads also refuse the substitutions.
3. **Each invocation is self-contained.**
   - Retries, interruptions, restarts and concurrent requests never overwrite or revive a verdict (T10, E2, E3).
   - Refusals are BLOCKED with their reasons (T11, E1, E5).
4. **The reader never grants authority to the reader's own files** (RA5), nor to links, copies, other installations or other bindings.
   Its rules accept a record when another uid's ownership is complete (unit test). Every 001 record, and every record here, reads as
   non-authoritative.
5. **Every remaining attack goes through ownership, and works where ownership is absent** (T6, T7, T8, E6):
   - swapping staged files;
   - running an edited verifier;
   - writing a forged record;
   - reading the oracle;
   - inspecting and signalling the instance.

**Not demonstrated; needs the installed phase:**
- that a separate uid stops those five;
- that the principal's lingering manager, socket activation and `ConditionUser` behave as designed under root's configuration;
- that bubblewrap and the per-case scopes work for a system user's manager;
- that `install.sh` and `uninstall.sh` do exactly what INSTALL-PLAN §2 and §5 say.

**Not demonstrable on this host as configured.** The property itself fails here: the agent's account is root-equivalent (§3).

## 6. Observations outside the preregistered rows

- **Before-and-after staging digests are a detector, not a boundary.** In T6 the swap changed what ran (15 of 15 cases matched for B),
  and only the unreverted change was caught. 001's R3 already showed a reverting attacker gets PASS.
- **A same-uid manager is an attacker-controlled starter.** The rehearsal's manager is the operator's, which the agent can configure
  (T7's drop-in). The selected design depends on the principal having its own manager, started by PID 1.
- **The reader's verdict is only as trustworthy as the process running it** (INSTALL-PLAN §8). An operator-uid consumer can be subverted
  by editing its `PATH`, shell startup files or the reader itself. Authenticity of evidence does not give the operator a trustworthy view
  of it.
- **Records reveal which cases failed.** They do not reveal expected outputs, though matched cases' output digests equal them. The agent
  can read records, so repeated requests leak oracle information (THREAT-MODEL §5).

## 7. Committed evidence and raw data

- **Committed:** both runs' (and the confirmation run 3's, §9) `results.json` and `rehearsal.txt` (the harness log, renamed because `*.log` is ignored), the host audit, and eight representative files from run 1 in
  [`results/run-1/records/`](results/run-1/records/):
  - T1's genuine PASS;
  - T2's FAIL;
  - T6's INCOMPLETE;
  - T7's edited-verifier PASS;
  - T8a's forgery;
  - T12's X with `EROFS`;
  - the T10 and E3 journals without records.

  These copies are **not authoritative**, by the reading rule they illustrate.
- **Raw only:** `~/projects/endophasia-research/develop-verify-trust-002/`, kept and not committed:
  - `rehearsal-1/` and `rehearsal-2/`, 3.0 MB each: every record, journal, installation tree, repository and marker;
  - `checkout-run-2/`, the fresh clone, 345 MB.

## 8. Reproduce

```sh
env -i PATH=/usr/bin HOME=$HOME LANG=C.UTF-8 XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS \
  /usr/bin/node research/develop-verify-trust-002/rehearsal.ts run <empty dir> --commit c968895fc608ba3552e15d745b585315a08eb6fd   # ~85 s
node research/develop-verify-trust-002/audit.ts
npx vitest --run tests/develop-verify-trust-002.test.ts
```

**Host requirements** are 001's:
- bubblewrap;
- a systemd user manager with cgroup v2;
- a root-owned `/usr/bin/node` 26;
- `gcc`, for T4's preload library.

The rehearsal adds two runtime units to the operator's user manager (`$XDG_RUNTIME_DIR/systemd/user`) and removes them at the end.
Tested on Linux 7.2.15-arch1-1, Node 26.13.1, bubblewrap 0.13.1, systemd 262.

## 9. Independent review and corrections (after the recorded runs)

One bounded review was requested on the draft PR, from the Codex GitHub reviewer, on `239b7481e`. It reported one P1 and four P2
findings. Each premise was checked against the code. All were accepted, and each was fixed or corrected in `e1c52e02e`. Two defects
found by the author while waiting are listed as D1 and D2. None changes a recorded result: confirmation run 3, built from `e1c52e02e`,
is identical to run 1 on all 20 rows (`results/run-3-corrected/`). Its installation identity differs, as it should, because the code
changed.

| # | Severity | Where (`239b7481e`) | Finding | Check | Resolution |
| :-- | :-- | :-- | :-- | :-- | :-- |
| V1 | P1 | `install/install.sh` | The package's digest was checked on the operator-writable file, then the file was read again for extraction: the agent could swap it in between, and root would install unchecked code and units | Confirmed by reading: two separate opens. Not run: the script needs root | **Fixed.** Root copies the package into its private staging directory first, then checks and extracts that one copy. |
| V2 | P2 | `rehearsal.ts` T10 (installed target) | The operator's interruption prompt came only after awaiting the response, so the run had already finished with PASS | Confirmed by reading. A second problem was found with it: a request takes about 3 s, too short for anyone to interrupt by hand | **Fixed.** In the installed target, the prompt comes before the await, and the interrupted request is a slow but correct copy of A (4 s per case), counted as correct for IA3. The rehearsal is unchanged. |
| V3 | P2 | `install/uninstall.sh` | A failed archive did not stop the removal, so the evidence was deleted anyway | Confirmed: the script has no fail-fast, and a failed `tar` only suppressed the message | **Fixed.** Removal stops, deleting nothing, unless the archive is written and readable. |
| V4 | P2 | `FOLLOW-UP.md`, `ARCHITECTURE.md` §3, `INSTALL-PLAN.md` §8 | **Request-triggered code execution persists.** The principal owns its user manager's runtime directory, so compromised code can add runtime drop-ins or environment for every later instance. The claim "lasts one request" was wrong. | Confirmed: `/run/user/<uid>` and `$XDG_RUNTIME_DIR/systemd/user` belong to the principal, and nothing in the unit isolates the instance from its manager | **Corrected in the documents.** B's advantage over A on this point is withdrawn. Closing it would take an instance that cannot reach its manager, which is not designed here. The threat model already listed request-triggered execution as a residual risk; its consequence is now stated correctly. |
| V5 | P2 | `audit.ts` | H0 checked the groups this process holds, not the groups the account is configured for. A session started with the groups dropped would pass IP0 although `newgrp` gives them back | Confirmed by reading. A fixture account (member of `docker` and `libvirt` in `/etc/group`, neither held) is now a test | **Fixed.** Groups held **or** configured (`/etc/group`, the primary group in `/etc/passwd`). This host's audit is unchanged: H0 false. |
| D1 | — | `service/verifier.ts` | A concurrent instance could collect a live instance's working directory in the moment between its creation and its owner file. That gives INCOMPLETE, never PASS, but it is wrong | Code reading | **Fixed.** The directory is made as `.new-<id>`, given its owner, then renamed. Half-made directories are collected only after 10 minutes. Test added. |
| D2 | — | `service/verifier.ts` | A client that never closed its side held an instance until `RuntimeMaxSec` (900 s); four such clients block the service (denial of service only) | Reproduced: before the fix, the response came only when the client closed; after it, BLOCKED `request-timeout` at 30.1 s and the process exits | **Fixed.** A 30 s request deadline, then standard input is closed. |

**D3, found by CI on `149d94c8e`.** The V5 test runs the real host audit. On the CI runner `/run/podman` cannot be searched, so
`lstat` threw `EACCES` and shard 1 failed. A socket the account cannot even look up is one it cannot use. The audit now reports the error
code instead of throwing. This host's audit output is unchanged; a regression test was added.

**Tests after the corrections.** `tests/develop-verify-trust-002.test.ts`: 23 of 23 (D1, V5 and D3 added). The install scripts pass `sh -n`
and are still never executed.

**Effect on the decision.** None of these changes the decision. V1, V3 and V5 strengthen the unexecuted installed phase and its gate, and
V2 makes its T10 runnable at all. V4 corrects a claim about a residual risk outside the property under test, and narrows the stated
difference between A and B. The approval request in FOLLOW-UP.md now names `e1c52e02e` and its digests.
