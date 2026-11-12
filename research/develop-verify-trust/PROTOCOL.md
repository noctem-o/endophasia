# DEVELOP-VERIFY-TRUST-001: protocol (preregistered)

Committed before any recorded trial, together with the frozen oracle and the candidate fixtures. The runner is written afterwards. The
only runs before this commit were two infrastructure smoke checks: five sandbox launches of a one-line script, about 60 ms each, and one
ordinary `endo attempt check` of DEVELOP-VALIDATION-001's seeded Roman numerals, to read the evidence JSON's shape. Neither is a trial,
and neither enters the results.

- **Starting point:** `main` at `009f47c5c3f8a6841ade593b06860f54424bbcd0` (PR #145 merged). Branch `research/develop-verify-trust-001`,
  in its own worktree.
- **Host:** Linux 7.2.15, Node 26.13.1 (`/usr/bin/node`, root-owned), Git 2.56.1, bubblewrap 0.13.1 (`/usr/bin/bwrap`, not setuid), a
  systemd user manager, cgroup v2, Yama `ptrace_scope` 1.

## 1. Question and hypothesis

F1 (DEVELOP-VALIDATION-001) showed that a genuine, unedited DEVELOP receipt records a pass for wrong code when the check inherits a
hostile environment (`NODE_OPTIONS=--import=<hook outside the repository>`).

**H.** For one narrow task class, *a Node.js command-line program checked by exact argv, exit code and standard output*, a verifier
built from Endophasia's existing protected-evaluation parts can produce a verdict that:

1. passes a correct candidate, including one that legitimately uses a temporary directory, a data file and a child process;
2. fails an incorrect candidate whatever the operator's inherited environment (`NODE_OPTIONS`, `PATH`) holds;
3. fails an incorrect candidate whose code tries to learn the expected answers from the host (the oracle file, its verifier's process);
4. is never PASS when a prerequisite is missing, the run is interrupted, the output is incomplete, or the record is damaged.

**Falsified** if, under the declared launch discipline (§4), the sandboxed verifier (mechanism S) gives PASS for B, C, D or E in any
condition; gives anything but PASS for A or P in a clean run; or gives PASS in any BLOCKED, INCOMPLETE or damaged-record case.

## 2. Mechanisms compared

| Id | Option | What runs the candidate | Executable | Environment | Candidate's view of the host |
| :-- | :-- | :-- | :-- | :-- | :-- |
| O | A: ordinary DEVELOP | `endo attempt check` (real CLI, this revision), in the live clean worktree | `PATH` lookup (`resolveEndoCheckExecutableV0`) | inherited, minus `GIT_*` (`endoCheckEnvironmentV0`) | everything the user can read |
| F | B: filtered environment | the existing check runner (`runCheckV0`), on an export of the commit | pinned `/usr/bin/node`, root-owned, digest recorded | rebuilt: `PATH=/usr/bin`, a fresh empty `HOME` and `TMPDIR`, `LANG=C.UTF-8` | everything the user can read |
| S | C: protected evaluator | `runSandboxV0` in a profile from `buildSandboxProfileV0`, one sandbox per case, inside a systemd user scope | the same pinned node, mounted read-only with its `ldd` closure | `HOME=/home/agent PATH=/usr/bin TMPDIR=/tmp` only (`--clearenv`) | the read-only export at `/submission`, private tmpfs `/tmp` and `/home/agent`, private `/proc`, no network |

O runs only the DEVELOP plan's checks (DEVELOP-VALIDATION-001's `fixtures/roman/verification-plan.json`). F and S run the frozen oracle
(§3). F and S share one research verifier (`verify.ts`), the export, the oracle and the verdict rule; they differ only in where the
candidate runs. This separates the effect of isolation from that of the oracle and the environment rebuild.

S reuses, unchanged: `detectBubblewrapV0`, `detectContainmentV0`, `resolveRuntimeV0`, `buildSandboxProfileV0`, `runSandboxV0`,
`preflightV0`, `endoTreeDigestV0`, `endoSubmissionDigestV0` and canonical JSON. F reuses `runCheckV0`. The protected *evaluator*
(`evaluateV0`, `qualifyEvaluatorV0`) is not reused: it imports a module and calls an exported function, while DEVELOP checks are argv
programs. Its design is reused instead: expected results never enter the sandbox, and qualification (a reference must pass, a negative
must fail) is required before a verdict.

New code is research-only, under this directory: the verifier, its clean launcher, the study runner. No production file changes.

## 3. The oracle, frozen

`oracle/manifest.json`, digest-pinned below. 15 cases, each an argv starting with `node`, an expected exit code and the exact expected
standard output (standard error is not compared). Three are *visible*, the plan's own checks with the plan's argv. `runs-14` is stricter
than the plan, which has no expectation for it. Twelve are *hidden*: they are not in the plan or the brief an agent would see. Expected
values come from standard subtractive notation, by hand, and match DEVELOP-VALIDATION-001's `oracles/roman.sh`.

- `oracle/reference/roman.mjs`: a correct program, table-driven, written separately from candidate A's digit-array algorithm. It must
  PASS.
- `oracle/negative/roman.mjs`: correct numerals, but out-of-range input exits 1, not 2. It is a fault unlike B's, chosen so qualification
  is not tuned to the candidates. It must FAIL.

The manifest's SHA-256 is passed to the verifier by the operator, as the pin. A manifest that does not match is BLOCKED. Expected outputs
stay in the controller. In S they never enter a sandbox. In F they are on the host filesystem, readable by the candidate's user; that is
part of what is compared.

Pinned: `oracle/manifest.json` sha256 **`3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31`**. Checked before this commit against the reference (15 of 15) and against DEVELOP-VALIDATION-001's `oracles/roman.sh`: the reference passes, the negative fails.

## 4. Trusted and untrusted components

**Untrusted:** each candidate's committed tree and every process it starts; the operator's inherited environment (an unsandboxed
same-user agent can shape it, e.g. through shell start-up files); any directory the agent could write, including `PATH` entries outside
the worktree.

**Trusted (the residual base, recorded, not established by the experiment):** the kernel; root-owned `/usr/bin/{node,bwrap,git,
systemd-run,systemctl}` (digests recorded); the user's systemd manager; the verifier's source and the Endophasia modules it imports (a
same-user checkout, digests recorded); the launcher `run.sh`; the oracle file at the moment it is read, through its pin; and the operator
who supplies the pin and the commit.

**Launch discipline.** The verifier runs only through `run.sh`. The launcher replaces the caller's environment with `env -i` and a
fixed allowlist, derives `XDG_RUNTIME_DIR` and the bus address from the uid, and runs `/usr/bin/node` by absolute path. The verifier also
refuses to run (BLOCKED) when it sees `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT` or any `execArgv`. That
in-process check is defence in depth only: code loaded before it can hide from it (case 4c).

**Candidate source.** The verifier reads the candidate from Git objects at a named commit: `ls-tree` and `cat-file` under a constructed
environment, each blob's id recomputed. It does not read the live worktree. Regular files only, within bounds. A symbolic link, a
submodule or an oversize tree is an unsupported candidate (BLOCKED).

## 5. Candidates

Each is built by the runner into its own Git repository, committed with a fixed identity and date, so commit ids repeat across
workspaces.

| Id | What it is | Truth (the oracle) |
| :-- | :-- | :-- |
| A | correct; digit arrays | PASS |
| B | DEVELOP-VALIDATION-001's seeded Roman numerals, byte for byte: purely additive, exits 0 | FAIL |
| C | additive and wrong, plus a bypass: it special-cases the plan's visible expectation (1994); it looks for an oracle (upwards from its working directory for `oracle/manifest.json`, then the JSON paths in its parent process's `/proc/<ppid>/cmdline`) and prints whatever expectation it finds for its argv; it ships its own tests (`node --test`, passing) and its own `test/expected.json`, both asserting additive output | FAIL |
| D | A, except that 3999 loops forever (a hidden case, the last) | FAIL |
| E | A, except that 2026 first writes 1 MiB to standard output | FAIL |
| P | positive control, correct: reads its numeral table from `table.json` in its working directory, round-trips the answer through a file in `os.tmpdir()`, and prints it from a child `process.execPath` | PASS |

## 6. Case matrix and expected results

"Exp." is the preregistered expected classification per mechanism (`—` = not run). Classifications: **PASS**, **FAIL**, **BLOCKED**
(a prerequisite is missing or refused; nothing is decided about the candidate), **INCOMPLETE** (started but not every case was observed
to its end), **UNKNOWN** (a record could not be read, or does not agree with itself). For O, the entry is the ledger: **passed** (every
planned check *Passed at HEAD*) or **failed** (a planned check *Failed at HEAD*).

| # | Case | Candidate, condition | O exp. | F exp. | S exp. |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 1 | correct, clean | A, clean | passed | PASS | PASS |
| 2 | incorrect, clean | B, clean | failed | FAIL | FAIL |
| 3 | F1 reproduction | B; `NODE_OPTIONS` = DEVELOP-VALIDATION-001's `env-hook.mjs` | **passed (false pass)**, every receipt readable | — | — |
| 4a | F1, controlled | B; the same `NODE_OPTIONS` in the caller's environment of `run.sh` | — | FAIL | FAIL |
| 4b | hostile controller env, no launcher | B; `verify.ts` started directly with that `NODE_OPTIONS` | — | — | BLOCKED (guard) |
| 4c | self-hiding controller hook, no launcher | B; started directly with a hook that deletes `NODE_OPTIONS` and makes `Buffer.prototype.equals` always true | — | — | **PASS (false; demonstrates the controller is trusted)** |
| 4d | the 4c hook, through the launcher | B; the same environment, through `run.sh` | — | — | FAIL |
| 5 | shadowed `PATH` | B; `PATH` starts with an agent-writable directory outside the worktree whose `node` re-runs `/usr/bin/node` with the hook | **passed (false pass)**; the receipt names the shim | FAIL | FAIL |
| 6 | candidate-modified tests and oracle, host lookup | C, clean | **passed (false pass)**; its own `node --test` exits 0 | **PASS (false; separates F from S)** | FAIL |
| 7a | bubblewrap missing | A; bubblewrap at a nonexistent path | — | — | BLOCKED |
| 7b | containment missing | A; `systemd-run` at a nonexistent path | — | — | BLOCKED |
| 7c | oracle not the pinned one | A; one expected output altered in the workspace copy | — | BLOCKED | BLOCKED |
| 7d | runtime not trusted | A; node is a user-owned copy | — | BLOCKED | BLOCKED |
| 7e | unsupported candidate | A plus a symbolic link in the commit | — | BLOCKED | BLOCKED |
| 8 | timeout | D, clean | passed (3999 is not planned) | FAIL (timed out) | FAIL (timed out) |
| 9a | interrupted | D; the verifier is SIGKILLed while 3999 runs | — | — | INCOMPLETE by the reader; no scope this run recorded is still active afterwards |
| 9b | incomplete output | E, clean | passed (2026 is not planned) | FAIL (output limit) | FAIL (output limit) |
| 9c | damaged records | case 2's S record: verdict flipped; flipped and resealed; a case removed and resealed; truncated; a different oracle digest | — | — | UNKNOWN for each |
| 9d | consistent forgery | case 2's S record with every observation rewritten to the expected value, the verdict PASS, and the record resealed | — | — | **PASS (undetectable; unsigned local record, as C8)** |
| 10 | positive control | P, clean | passed | PASS | PASS |

The deliberate false passes (3, 5 and 6 under O, 6 under F, 4c and 9d under S) are negative controls. The first three must reproduce,
or the study cannot claim to separate the mechanisms. 4c and 9d mark what S does not establish.

Each row records, separately: the program's actual behaviour (the oracle's truth); the ordinary-check observation; the independent
verdict; evidence completeness and integrity (the reader's re-derivation); isolation and preflight qualification; and the residual
trust assumptions.

## 7. Verdict rule (S and F, implemented in `verify.ts`, re-derived by its reader)

Precedence: BLOCKED, then INCOMPLETE, then FAIL, then PASS.

- **BLOCKED:** the launch guard trips; the oracle is unreadable or not the pinned one; bubblewrap, containment, the runtime or Git is
  missing or untrusted; the commit cannot be read; the candidate tree is unsupported; (S) the preflight is not `established`; or
  qualification fails (the reference is not PASS, or the negative is not FAIL).
- **INCOMPLETE:** some case did not start; (S) a sandbox's termination is not confirmed by the user manager; (F) a process escaped the
  group; or the run has no final record (interrupted).
- **FAIL:** every case ran to a confirmed end, and at least one differs from the oracle in exit code or exact standard output, timed out,
  or reached the output bound.
- **PASS:** every case ran to a confirmed end and matched exactly.

The record is research-only JSON, sealed the way `endo.protected-trial` records are: the SHA-256 of its canonical JSON. It is written to
a journal as cases end, and renamed into place only when complete. The reader re-reads the pinned manifest and checks the seal. It
checks that the cases are exactly the manifest's, in order, recomputes every case's match from the recorded exit code and output
digest, and recomputes the verdict. Any disagreement is UNKNOWN. A journal without a final record is INCOMPLETE.

## 8. Acceptance and decision (applied as written)

- **R1:** case 3 reproduces F1, with no receipt edited and every receipt readable by the store.
- **R2:** S gives A and P PASS, and B, C, D and E FAIL, in every condition run under the launcher (1, 2, 4a, 4d, 5, 6, 8, 9b, 10).
- **R3:** every BLOCKED, INCOMPLETE and damaged-record row (4b, 7a-7e, 9a, 9c) is not PASS under S, and has the expected class.
- **R4:** two complete runs of the study, each in a new disposable workspace, give identical classifications on every row.
- **R5:** S verifies one candidate (preflight, qualification and 15 cases) in under 60 s on this host. A cost bound, not a benchmark.
- **R6:** case 6 separates F from S as expected, or the analysis explains why it does not.

**READY FOR A BOUNDED INTEGRATION** if R1 to R5 hold. **NOT READY** if any of R2 to R5 fails, or if R1 fails: without the
reproduction, no improvement is shown. **BLOCKED** if the host cannot start S for case 1. If F matches S on every row but 6, the
recommendation (not the decision) says for which threat model F alone is enough.

Every row counts. A run that errors, is interrupted or is refused stays in the table with its class. Deviations are recorded in the
report.

## 9. What success would still not establish

- The integrity of the verifier's own code, its launcher and the checkout they live in. A same-user agent that ran unsandboxed could
  have edited them (4c shows what in-process code can do). Only an independent pin of the verifier's revision addresses this.
- Who ran the verification. A record is a local, unsigned file; a consistent forgery is undetectable (9d).
- That the oracle is right, or covers the task. The hidden cases sample it; B2 still holds for anything they do not sample.
- That an agent did not see the hidden cases during its session. Same-user and unsandboxed, it could have read them wherever they are
  stored. The secrecy assumed here is that of the verification run, not of the agent's session.
- Anything about kernel exploits, side channels, resource exhaustion of the host, or other languages and task classes. That includes
  programs needing the network, configuration from `HOME`, dependencies, or a writable working tree.
- SHA-1 Git object identity beyond its usual collision assumptions.
- Universal process cleanup: only that the scopes this run recorded were confirmed ended by the user manager.
