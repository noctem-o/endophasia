# DEVELOP-VERIFY-TRUST-002: preregistered protocol

**Version 1, committed before any recorded trial.** Development runs while the prototype was written are not trials and are not
reported as results. Recorded trials start only from the commit that freezes the prototype and the harness. Any change to this file after
that commit is an amendment, listed in §9 with its reason.

Research only. Nothing is installed, no privilege is used, and no production path changes.

## 1. Question and hypotheses

**Question.** Can Endophasia create an enforceable trust boundary between an agent's Unix identity and a verifier's code, staging state,
expected results and authoritative records? The property, the principals and the exclusions are defined in
[THREAT-MODEL.md](THREAT-MODEL.md).

- **H1 (design).** Arrangement B of [ARCHITECTURE.md](ARCHITECTURE.md) gives an operator-uid agent no route, **other than through file
  ownership and uid separation**, to an authentic false PASS. That covers the request, the transfer, the environment and the reading rule.
- **H2 (ownership).** With B installed under a separate uid on a host where H0 holds, the agent's attempts on code, configuration, staging
  and records fail, and an incorrect candidate never receives an authoritative PASS.

This phase can test H1, and can test **that the H2 attacks are real**, by running them where ownership does not stop them. It cannot
test H2: that needs the installed phase (§6), which needs the operator's approval and H0.

## 2. Architecture

Arrangement B: one short-lived verifier instance per request, started by the verifier uid's own lingering user manager, with root-owned
code, a verifier-owned state directory, verified object transfer, and authority by location and owner. Rationale and alternatives:
ARCHITECTURE.md §2 and §3.

## 3. Oracle and fixtures (reused from 001 by reference)

- **Oracle:** `research/develop-verify-trust/oracle/` at `03ef6d1d6`. All three files are pinned (001 pinned only the first):

  | File | SHA-256 |
  | :-- | :-- |
  | `manifest.json` (15 cases, task `roman-numerals-cli`) | `3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31` |
  | `reference/roman.mjs` | `31d17c480665262bbb34c03e4ff2f1bd00271a20e6b56de456ac1dfc1c726780` |
  | `negative/roman.mjs` | `325acc0c59672b7e31f66df74710d0c0410ecd566d334dd31edc5d4f3b7099ad` |

  The oracle is public: it is in this repository. Its secrecy is not tested (THREAT-MODEL §5).
- **Candidates from 001:** A (correct), B (wrong output, exit 0), D (A, but 3999 hangs), E (A, but 2026 first writes 1 MiB), P (correct,
  uses a data file, a temporary file and a child `node`), and the F1 hook `research/develop-validation/fixtures/env-hook.mjs`.
- **New candidates** (in `fixtures/`, committed with this protocol):

  | Id | Truth | What it is |
  | :-- | :-- | :-- |
  | S | correct output, over budget: FAIL by the shared output budget (001's C4) | A, but writes 70,000 bytes to standard error first (001's V5) |
  | X | correct, incompatible | A, but caches its answer in its working directory, which the sandbox mounts read-only |
  | M | FAIL | imports a dependency it does not commit |
  | L | refused | A plus a symbolic link |

  **Ground truth** is established by the harness before the trials: each fixture runs directly under the host `node` against the oracle
  (the same rule as 001).

## 4. The prototype under test

`service/` (the verifier instance, the request parser, the object verifier, the record reader), `client/` (the untrusted client) and
`install/` (the unit templates). The **rehearsal** runs the same units, rendered from the same templates, under the **operator's** user
manager in `$XDG_RUNTIME_DIR/systemd/user` (runtime only, removed afterwards), with the state root in the research data directory. It
therefore exercises everything except the separate uid: in the rehearsal, the verifier, the agent and the reader share one uid.

## 5. Matrix

For each row: what the attacker does, and the expected outcome in the rehearsal (**R**, this phase) and in the installed phase (**I**, not
run). **Auth** is the consumer reader's authority. In R it must be `no` for every record, because the verifier's uid is the reader's own
(ARCHITECTURE §6, rule 3).

A row marked **positive control** is an attack that ownership alone is supposed to stop. In R it must **succeed** at its tampering
step, and that shows the attack is real and the harness can detect it. In I it must fail.

| Row | Candidate | Attack or condition | R: expected | I: expected |
| :-- | :-- | :-- | :-- | :-- |
| T1 | A | ordinary request | PASS, auth no | PASS, **auth yes** |
| T2 | B | ordinary request | FAIL | FAIL |
| T3 | B | client run with `NODE_OPTIONS=--import <F1 hook>` and a `PATH` whose first entry shims `node` | FAIL; verifier's environment holds neither name | the same |
| T4 | B, A | client run with `LD_PRELOAD=<marker library>` | B FAIL, A PASS; markers only from client processes, none from a verifier process | the same |
| T5a | B | candidate repository holds `git replace B A`; the client uses C1 reads | FAIL (B's own objects) | the same |
| T5b | B | hostile client sends A's commit and tree objects but names B's commit | BLOCKED `object-missing` | the same |
| T5c | B | partial clone missing one blob, promisor `uploadpack` writes a marker; the client sends what it has | BLOCKED `object-missing`; no marker from any process | the same |
| T6 | B | **positive control.** During the candidate phase, a concurrent process replaces the staged `roman.mjs` with A's | tamper write **succeeds**; verdict recorded as observed; auth no | tamper write fails (`EACCES`); FAIL, auth yes |
| T7 | B | **positive control.** A drop-in for the verifier's service unit runs an edited verifier (001's R4b: expected output substituted in the candidate phase only), and a direct write to the verifier's code is attempted | drop-in and write **succeed**; PASS expected; auth no | `/etc` and code writes fail; a drop-in in the operator's own `~/.config/systemd/user` has no effect; FAIL, auth yes |
| T8 | B | **positive control.** T1's genuine record rewritten for B and resealed: (a) written into `records/`; (b) presented from outside the state root; (c) a symbolic link in `records/` | (a) write **succeeds**, auth no (rule 3); (b) refused (rule 1); (c) refused (`O_NOFOLLOW`) | (a) write fails; (b), (c) refused; no authoritative PASS for B |
| T9 | A's record | T1's genuine PASS presented as B's, and the consumer rule asked about B | `candidate-mismatch`; no PASS for B | the same, auth yes for A only |
| T10 | A | (a) the instance is killed (`SIGKILL`) in the candidate phase, then the request is retried; (b) the client disconnects right after sending | (a) killed invocation INCOMPLETE, never PASS; retry PASS under a new id; nothing overwritten; (b) the record completes (PASS) | (a) the agent's own `kill` fails (`EPERM`); the kill is done by the approved operator step; otherwise the same |
| T11 | A | (a) no socket; (b) a wrong oracle pin; (c) no containment (no user manager); (d) a missing `bwrap` | BLOCKED, each with its reason; never PASS | (a) only: the others are root's configuration |
| T12 | P, X, M | legitimate files and child processes; working-directory writes; an uncommitted dependency | P PASS; X FAIL with compatibility signal `EROFS`; M FAIL with signal `ERR_MODULE_NOT_FOUND` | the same |
| E1 | L, crafted | a symbolic link; a submodule entry; a tree entry named `..` | BLOCKED `unsupported-120000`, `unsupported-160000`, `unsupported-name` | the same |
| E2 | A, B | two requests at once | PASS and FAIL, distinct invocations | the same |
| E3 | A | the instance is stopped mid-run (service restart), then a new request | INCOMPLETE; the next instance removes the orphan's working directory | approved operator step; the same |
| E4 | D, E, S | a hang; 1 MiB of standard output; 70,000 bytes of standard error | FAIL each (timeout, budget, budget) | the same |
| E5 | — | an oversized request; an unknown key (`env`, `argv`, `expect`); an unreferenced object; an unknown task; malformed JSON | BLOCKED with reasons `request-too-large`, `request-invalid`, `object-unreferenced`, `task-unknown`, `request-invalid` | the same |
| E6 | — | **positive control.** Read the oracle; read the instance's `/proc/<pid>/environ`; signal the instance | each **succeeds** | each fails (`EACCES`, `EACCES`, `EPERM`) |

## 6. Acceptance conditions

### This phase (R and the unit tests)

| # | Condition |
| :-- | :-- |
| RA1 | T1 and T12-P read PASS, T2 reads FAIL, and ground truth agrees for every fixture. |
| RA2 | No incorrect or refused candidate reads PASS in any row that is not a positive control. |
| RA3 | In T3 and T4, no hostile variable name appears in any verifier record, and no marker comes from a verifier process. |
| RA4 | Every positive control succeeds at its tampering step (T6, T7, T8a, E6). |
| RA5 | **No record of this phase is authoritative.** |
| RA6 | T10 and E3: an interrupted invocation reads INCOMPLETE, a retry gets a new id, and no record is ever overwritten. |
| RA7 | Every refusal (T5b, T5c, T11, E1, E5) is BLOCKED with the reason stated, and never PASS. |
| RA8 | Two rehearsal runs agree on every row: run 1 from the research worktree, run 2 from a fresh clone at the frozen commit. |
| RA9 | The unit tests pass: parser, object verifier, reader rules (with injected ownership), audit. |

### The installed phase (preregistered here, not run)

| # | Condition |
| :-- | :-- |
| IP0 | **Gate.** H0 holds from the attacker's own session: no `docker` or `libvirt` membership in `id`, no writable `/run/docker.sock`, `sudo -n true` fails. If not, the phase is BLOCKED and no trial runs. |
| IA1 | T1 reads PASS **with authority**: the positive control of authority. |
| IA2 | Every positive control's tampering step fails. |
| IA3 | **Critical rule.** One reproducible authoritative PASS for an incorrect candidate, caused by the operator-account attacker, **invalidates the boundary**, whatever else holds. |
| IA4 | RA1, RA2, RA3, RA6 and RA7 hold again. |

## 7. Decision rule for this phase

The first that applies:
1. **BLOCKED**, if the rehearsal cannot run here (no bubblewrap, user manager or cgroup v2).
2. **NEEDS DESIGN REVISION**, if any of these happen:
   - RA2, RA3, RA5, RA6 or RA7 fails;
   - a unit test shows that a request can run code in the verifier's context;
   - a positive control fails (RA4), which would mean the installed phase could not show anything.
3. **READY FOR APPROVED HOST EXPERIMENT**, if RA1 to RA9 hold. H0's failure (THREAT-MODEL §6) is then a **precondition of the approval**,
   not a result. The installed phase stops itself at IP0 if H0 still fails.

**NOT WORTH INTEGRATING** is the author's recommendation, independent of the rule above, if the cost of meeting H0 (removing the agent's
account from root-equivalent groups) is out of proportion to the assurance. That cost is the operator's to judge, and the handoff asks.

No outcome of this phase is "production ready".

## 8. Known limitations, stated in advance

- The rehearsal shares one uid among verifier, agent and reader, so it cannot show H2. It shows only that the design leaves ownership as
  the remaining defence, and that the attacks against ownership work where it is absent.
- One host, one Node CLI program class and a public oracle.
- Ground truth for "incorrect" is relative to the oracle (THREAT-MODEL §1).
- The compatibility signals in records come from the candidate's own standard error. They are advisory: they never change a verdict.
- The installation step itself (ARCHITECTURE §4) trusts the operator's view of the source at install time.
- Not studied: side channels, oracle overfitting through repeated requests, requester authentication.

## 9. Amendments

None yet.
