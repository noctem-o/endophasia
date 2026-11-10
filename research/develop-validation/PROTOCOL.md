# DEVELOP-VALIDATION-001: preregistered protocol

Committed before any experiment below was run. Results go in [DEVELOP-VALIDATION-001.md](DEVELOP-VALIDATION-001.md); a deviation from this
protocol is reported there as a deviation, not edited in here.

- **Revision under test:** `main` at `07f8945a91f519bedbf5498a1b93d73c5b8766d8` (README rework included). Worktree clean; built with
  `npm ci && npm run build`.
- **Host:** Linux, Node 26.13.0, Git 2.56.0, Chromium for the browser review. Pi 1.5.0 is installed; the local model router at
  `127.0.0.1:8081` did not answer and is not started or loaded by this study.

## 1. Questions and hypotheses

| # | Question | Hypothesis (expected outcome) | Refuted if |
| :-- | :-- | :-- | :-- |
| H1 | Does the README's five-minute tour run as written for a new user? | Every step runs; outputs match what the README says | A step fails, needs an undocumented prerequisite, or prints something the README contradicts |
| H2 | Does the ledger separate successful execution from correct behaviour? | A program that exits 0 with wrong output is `failed` on its behavioural check and its criterion | Any ledger line or the page reads it as passed |
| H3 | Does the ledger keep uncovered and partly covered criteria visible? | A criterion with no check reads as the operator's judgment; nothing reads as "all criteria passed" | A judgment criterion is hidden, or the evidence implies acceptance |
| H4 | Does freshness hold? | A pass at an older commit is not a pass at a newer HEAD; a dirty tree is not compared as clean; contradicting receipts are `mixed` | Any old or contradicted pass is shown as current |
| H5 | Is absent or damaged evidence distinguished from failed evidence? | Missing, unreadable, malformed or misnamed records are reported as such, never as `failed` or `passed` | A damaged record silently changes a verdict |
| H6 | Does provenance stay descriptive? | Differences are listed by path; no record or output attributes authorship | Any output names an author or causation |
| H7 | Do the CLI and the browser agree? | The page shows the same per-check and per-criterion verdicts as `endo attempt evidence` for the same store | Any disagreement |
| H8 | Can a fresh reader reconstruct the facts from records alone? | A fresh-context reviewer given only frozen `endo` output identifies the verdicts and gaps | It cannot, or relies on the agent's narrative |
| H9 | Does the ledger presentation make gaps more explicit than the receipt list? | Reviewers given the ledger identify more of the known gaps and make no unsupported acceptance | No difference, or the ledger causes more erroneous acceptance |

Known limitation that is **expected**, not a defect: DEVELOP records are local, unsigned files. A consistent rewrite of a receipt by
anything that can write the store is not detectable; H5 tests only damage that breaks a record's own validation.

## 2. Fixtures and independent oracles

Every fixture lives in a disposable Git repository under the session scratch directory, with its own evidence store
(`ENDO_STORE_ROOT`). No real project, store or user data is used.

**T1, exit 0 and wrong (`roman`).** `roman.mjs <n>` prints the Roman numeral for 1..3999 and exits 0; anything else prints nothing on
stdout and exits 2. The seeded version is purely additive (1994 → `MDCCCCLXXXXIIII`) and exits 0.
Oracle, written by hand before any agent run from the standard subtractive notation, and run outside Endophasia:

| Input | Expected stdout | Expected exit |
| :-- | :-- | :-- |
| 1, 4, 9, 14, 40, 90, 400 | `I`, `IV`, `IX`, `XIV`, `XL`, `XC`, `CD` | 0 |
| 1994, 2026, 3999 | `MCMXCIV`, `MMXXVI`, `MMMCMXCIX` | 0 |
| 0, 4000, `abc`, `-5` | (empty) | 2 |

**T2, a change with partly covered criteria (`duration`, days).** A copy of `research/review-pilot/fixture` (the pilot itself is not
touched). Task: add a day unit `d` (86 400 s) to parsing and formatting, largest unit first. Criteria:

1. `node --test` exits 0, and `test/` is unchanged. (checked: `node --test`)
2. The README's Format section documents `d`. (no check: judgment)
3. Inputs without `d` behave exactly as before, and rejected inputs stay rejected. (partly checked: two behavioural samples)
4. No new files and no new dependencies. (no check: judgment)

Oracle, by hand: `parseDuration("1d2h") = 93600`, `parseDuration("2d") = 172800`, `formatDuration(90061) = "1d1h1m1s"`,
`formatDuration(86400) = "1d"`; unchanged: `parseDuration("1h30m") = 5400`, `formatDuration(5400) = "1h30m"`; still rejected:
`"5s2h"`, `"1h1h"`, `"1d1d"`, `"2h1d"`, `""`, `" 1h"`, `"1.5h"`, `"-1h"`. Criteria 2 and 4 are judged by reading the diff and status.

**Planted candidates (negative controls).** Prepared by the study, not by an agent, and labelled as such:

- **T1-wrong:** the seeded additive version, unchanged (exit 0, wrong output).
- **T2-regression:** adds `d` correctly for the planned samples but stops rejecting `"5s2h"` (ordering), which no planned check samples.
  Its planned checks pass. The oracle fails it on criterion 3.

**Agent candidates (real model, not Pi).** Each task's brief, printed by `endo attempt brief`, is given unchanged to a fresh-context
Claude subagent working only in that disposable repository, which is asked to commit its change and report back. This exercises the
documented manual handoff path. It is a real model, but not Pi and not the live workbench.

## 3. What counts as what

- **Success (for a hypothesis):** the observed `endo` output and page agree with the oracle-derived expectation in §1.
- **Failure:** they contradict it. A product defect is recorded with a reproducer.
- **Inconclusive:** the path could not be exercised (for example, it needs a human at a controlling terminal), or the result depends
  on something this study cannot observe.
- An Endophasia verdict is never used as the oracle for itself: every expected verdict is derived from the hand-written oracle above,
  run as a separate script.

## 4. Experiments

- **A. Documentation reproduction.** Run the README tour in a fresh `HOME` with no Git identity, typing commands as written, copying ids
  from output. Record every discrepancy; do not fix the README or the environment to make a step pass.
- **B. Behavioural validation.** T1 and T2 with planted and agent candidates; checks run with `endo attempt check`; read with
  `attempt evidence`, `attempt receipts`, `attempt provenance`.
- **C. Provenance and freshness.** Scripted transitions: pass then HEAD moves; dirty tree after a check; a later check contradicts an
  earlier one; output not kept; output over 8 KiB (truncated); an incomplete observation (more than 1 000 changed paths); a receipt file
  made malformed; a receipt replaced by a valid-looking edit; a criterion with no check.
- **D. Independent review.** Frozen evidence for two scenarios (T2-regression; T2 agent candidate), each in two presentations: (1) the
  receipt list (`attempt show` + `attempt receipts` + the brief), (2) the ledger (`attempt evidence` + `attempt provenance` + the
  brief). Four fresh-context model reviewers, one per cell, with the same instructions and no expected verdict. Scored against the
  oracle on: verdicts correct, known gaps identified, erroneous acceptance recommendations, unsupported certainty, ability to trace a
  claim to a record. **Model reviewers are surrogates, not human participants.**
- **E. Browser.** The built page via `endo workspace open` on the same disposable stores, at 1440 and 390 px. Pairing is done by script
  from the host's printed code: this exercises the pairing protocol in a host with no agent and no execution surface, and is not a human
  action. Compared line by line with the CLI.
- **F. Adversarial review.** A fresh-context reviewer challenges the draft findings before they are final.

## 5. Boundaries

No live workbench send is attempted: a send needs a human to type its approval at a controlling terminal, so that path is
**operator-required**. No approval phrase is typed by the study. No model is loaded. No sudo, no host changes. Every process started is
stopped, and disposable directories are removed after the frozen excerpts are copied. Operator statements recorded in disposable stores
(`attempt handoff`, `attempt report`) are made by the validation agent acting in the operator's role there, and are labelled as such.
No task is moved to `done`: acceptance stays a human decision.

## 6. Stopping and readiness

Stop early if a material correctness or safety defect makes later experiments meaningless (for example, the ledger reports a pass the
oracle fails with no gap shown). Readiness is decided from H1-H9:

- **READY FOR HUMAN PILOT:** H2-H7 hold, H1 holds or fails only on documentation, and the remaining questions are human ones.
- **CONDITIONALLY READY:** a bounded list of defects or documentation errors must be fixed first.
- **NOT READY:** H2, H4 or H5 fails materially.
- **INCONCLUSIVE:** too few paths could be exercised.
