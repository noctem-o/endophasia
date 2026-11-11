# DEVELOP-VALIDATION-002: is DEVELOP-VALIDATION-001's blocker removed?

A bounded follow-up to [DEVELOP-VALIDATION-001](DEVELOP-VALIDATION-001.md). That study's decision, **NOT READY** by its preregistered
rule, stands as recorded; this document does not revise it. It asks a narrower question: after DEVELOP-ATTENTION-002 (this PR), do the
failures that decided it still reproduce?

**Result: the immediate blocker (U1) is removed** in every case this study and its adversarial review could construct, through the CLI
and the built page from the same stores. That is a different claim from "the system is ready for human evaluation". §6 states what the
second claim still needs.

- **Implementation under test:** branch `feat/develop-attention-002`, from `main` at `66f9f85f4` (PR #143 merged). The exact head is in
  the PR.
- **Host:** Linux, Node 26.13.0, Git 2.56.0, Chromium. No model and no Pi run; nothing here needs one.
- **Reproduce:** [rebuild-attention-cases.sh](rebuild-attention-cases.sh) rebuilds all twelve cases in a new directory and captures the
  overview, the Task view and `endo attempt evidence` for each. The frozen output is in [evidence-002/](evidence-002/).

## 1. The original cases, re-run

The fixtures, hook and plan are DEVELOP-VALIDATION-001's. "Before" is that study's evidence on `main` at `07f8945a9`.

| Case | What it is | Overview before | Overview now | Task view and `attempt evidence` now |
| :-- | :-- | :-- | :-- | :-- |
| U | Roman numerals, exit 0, wrong output | **Needs your attention (0)** | (1) **Check failed**: *Planned check subtractive-1994: Failed at HEAD* | Failed at HEAD |
| F | the declared exit-2 refusal of `0` (and 1994 under the environment hook) | (1) **Check failed** … exited with code 2 | (0); the refusal reads *Passed at HEAD* | Passed at HEAD |
| M | 1994 passes, then fails, at one HEAD | missed (latest only), per the 001 adversarial review | (1) **Inconclusive**: *Results at HEAD disagree (1 passed, 1 failed)* | Results at HEAD disagree |
| T2U | the planted regression nothing samples | (0), all passed | (0), all passed | all passed (B2: by design) |

U1's three directions are resolved. T2U is unchanged by design: no planned check samples `1d1d`, and the overview, like the ledger, says
only what the plan's checks observed (B2).

## 2. States the brief required, through the page

Each case was captured from one store through `endo workspace open` (paired by script: no agent, no execution surface) and
`endo attempt evidence`.

| Case | State | Overview | Task view and CLI agree? |
| :-- | :-- | :-- | :-- |
| S | failed, then an unrelated commit (stale failure) | (1) Check failed: *Not run at HEAD (only at other commits) (its latest run, at …, failed)* | yes |
| S2 | passed, then an unrelated commit (stale pass) | (0); *Not run at HEAD … (its latest run … passed)*; the summary says some checks have no current result | yes |
| D | passed, then the tree edited | (0); *At HEAD, but the tree has changed since (its latest run at HEAD passed)* | yes |
| N | never run | (0); three *Not run* lines and the "no current result" sentence | yes |
| X | a pass beside a damaged receipt file | (0); *Passed at HEAD (some of this attempt's receipt files could not be read; a later result may be among them)*; *One file among its checks could not be used* | yes |
| P | an attempt without a plan | (0); exit-status reading, as before | yes |
| TWO | one argv, two attempts: one with the plan, one without | (1) Check failed: the plan-less exit 2, *No plan reads this check; this is its exit status* | yes, per attempt |
| E | 1994 fails in a linked worktree | (1) Check failed: *Run only in another working tree (its latest run there failed)* | yes |
| O | an older attempt's failure; a newer attempt that has not run that command | (1) Check failed, the line naming its attempt | yes, per attempt |

No horizontal overflow at 390 px in any case. Screenshots:
[U](images/attention-002-U-overview-1440.png) and [E](images/attention-002-E-overview-1440.png), context panel redacted.

## 3. B1 and F1

- **B1, resolved for the terminal.** For a planned behavioural check, `endo attempt check` adds a line labelled as derived: *"plan: this
  is planned check "precedence", which your plan reads by its declared exit code and output, not by its exit status. Compared with that
  declaration, this run does NOT match it …"*. Its exit code is still the exit status's (0 for the wrong output, 3 for the declared exit
  2); a script reading it gets what it got before. `attempt receipts` and `receipt` add `outcomeIs` and, per receipt, `planned`: how the
  plan reads that one run. Tested end to end in `tests/develop-attention-planned.test.ts`.
- **F1, stated, not solved.** `endo attempt evidence` and the Task view now say a receipt records the exit status and a digest of the
  output, the comparison is made when it is read, the environment (`NODE_OPTIONS`, `PATH`, …) was inherited and not recorded, and
  `requestedBy` is not who ran the check. Case F still shows the hook-driven pass as **Passed at HEAD**: nothing in this change isolates,
  fingerprints or attests the environment, and nothing should be read as doing so.

## 4. Tests

- `tests/develop-attention-planned.test.ts`, 29 tests:
  - the brief's ten cases;
  - the review's R1-R5 and C1-C4, plus the positive superseding case;
  - Codex's findings: P1 (a pass here hiding a failure in another worktree), P2 (a row opening the wrong receipt), N1 (a pass in one
    other worktree hiding a failure in another), N2 (superseding dropping another worktree's failure) and N3 (claiming no checks when
    some were cut by the limit);
  - a contract test holding the page's triage equal to the protocol's over 1 152 combinations;
  - a gate test;
  - an end-to-end CLI test.
- **Before the fix:** run against the pre-fix implementation, 11 of the first 12 failed. The twelfth (an unreadable receipt) guards
  behaviour that already worked. R1-R5 each failed on the first cut, and C1-C4 on the second, before each fix.
- **Existing tests updated, and why:**
  - the attention fixture, the source test and the limits contract test, for the v1 schema;
  - two workspace-host assertions and one browser text: the seeded CRLF task has a plan, so its receipts are now read under `planned`.
- **Full suite on the final code, run locally the way CI runs it (Chromium required):** 6 749 passed, 1 failed and 73 skipped.
  - The failure is `aa-operator-cli.test.ts`, which this change does not touch; it passed alone twice (30/30).
  - The run before it passed in full (6 747 passed, 0 failed). Earlier runs each had one load-dependent failure in an untouched file
    (`protected-isolation`, `aa-operator`), each passing alone.
  - Typecheck, lint (one warning, already on `main`) and build are clean.

## 5. Independent review

A fresh-context adversarial reviewer worked in its own copy, in two rounds. Its findings and the dispositions are in
[REVIEW-002.md](REVIEW-002.md).

- **Round 1** found three regressions in the first cut, each a path where a recorded planned failure left attention although v0 had
  flagged it: a linked worktree, an unreadable HEAD, and the per-task limit. It also found two medium problems: older attempts, and
  incomplete reads.
- **Round 2** confirmed those fixes, then showed that my rule for superseding older attempts could hide a later failure (C1-C4).

Every one was reproduced as a failing test, then fixed. The reviewer could not make the page's gate refuse anything the projection
produces (0 of 450 fuzzed views, both rounds), and it confirmed the three U1 cases end to end. A third round was not run.

Codex then found five more on the PR, over two pushes. All were about one principle, that each working tree's latest run is its own check
and must not be hidden by another's: P1, N1 and N2 broke it, P2 opened the wrong receipt and N3 claimed absence. All were reproduced
as failing tests and fixed.

## 6. What this establishes, and what it does not

**Established:**

- In disposable repositories, the overview's planned-check triage follows the attempt's own ledger.
- The Task view, `endo attempt evidence` and the overview agree on every planned state in twelve cases built from the original fixtures.
- A recorded planned failure stays in attention whether the tree changed, HEAD moved, the run was in another worktree, HEAD could not be
  read, or the per-task limit applied.
- The CLI's derived plan reading is labelled, and its exit code is unchanged.

**Not established, and still required before calling the system ready for human evaluation:**

- **A human pilot.** REVIEW-PILOT-001's review is still pending. No human has used the overview, the ledger or the Task view to decide.
- **The live path.** No real Pi run went through the workbench with a behavioural plan. It needs an operator at the controlling
  terminal.
- **F1 remains.** An environment-dependent or agent-run receipt is indistinguishable from the operator's own. The pilot procedure in
  [HUMAN-WORKSHEET.md](HUMAN-WORKSHEET.md) reduces the risk; it does not remove it.
- **B2 remains.** A criterion whose samples pass reads as passed. The overview inherits this from the plan.
- **Superseding is a choice, and it is documented.** An older attempt's result for a command is hidden only by a newer attempt's later
  run of it that is at least as current, as v0's "latest run" rule did. Two other worktrees count as equally current. An operator who
  wants the older reading opens the task.

**Recommendation.** The implementation blocker to a **supervised** human pilot is removed. Proceed to the pilot under the written
procedure, with F1 retained as an explicit risk, once the operator confirms the procedure in the worksheet. This is not a
production-readiness claim.
