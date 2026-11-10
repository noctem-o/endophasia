# DEVELOP-VALIDATION-001: is the DEVELOP loop ready for a human pilot?

**Decision: NOT READY, by the preregistered rule; the path to a human pilot is short and bounded (§7).**

- The CLI ledger and the Task view were correct in every state this study built, including stale, dirty, contradicted, truncated,
  incomplete and damaged evidence.
- The page's attention overview contradicts them in both directions (U1). Under the protocol, that refutes H2, and an H2 failure means
  NOT READY.
- An adversarial reviewer also showed that a genuine, unedited receipt can record a pass for wrong code when the check's environment is
  altered (F1). An unsandboxed agent running as the operator can do that itself.
- Two README errors stopped the documented tour; they are fixed in this PR.

This is not a production-readiness claim, and it says nothing about human operators.

- **Revision under test:** `main` at `07f8945a91f519bedbf5498a1b93d73c5b8766d8`, clean worktree, `npm ci && npm run build`.
- **Protocol:** [PROTOCOL.md](PROTOCOL.md), committed before any experiment ran (`611d3d3d6`). Deviations are listed in §6.
- **Host:** Linux, Node 26.13.0, Git 2.56.0, Chromium. Pi 1.5.0 is installed; the local model router did not answer and was not started.
- **Evidence:** [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) · [REPRODUCE.md](REPRODUCE.md) · [REVIEW.md](REVIEW.md) ·
  [HUMAN-WORKSHEET.md](HUMAN-WORKSHEET.md).

## 1. What was actually run

| Kind | What | Count |
| :-- | :-- | :-- |
| **Real CLI, disposable stores** | `project add`, `task add`, `attempt prepare/brief/handoff/report/check/evidence/receipts/observe/provenance` | 10 stores (plus 2 copies for tampering), 10 attempts, 64 receipt files counting the copies |
| **Real model, not Pi** | Two fresh-context Claude (Sonnet) agents, each given only `endo attempt brief` output and a disposable repository | 2 candidates |
| **Planted candidates** | Prepared by the study, labelled as such: the seeded wrong calculator and Roman numerals, a regression caught by tests (T2R), a regression nothing samples (T2U) | 4 |
| **Record tampering** | A malformed receipt; consistently forged receipts in a copy of a store | 2 |
| **Browser** | The built page via `endo workspace open`, paired by script from the host's printed code (no agent, no execution surface; not a human action) | 4 stores |
| **Model reviewers (surrogates, not humans)** | 2 scenarios × 2 presentations, fresh context, identical instructions | 4 reviews, plus 1 adversarial review |
| **Not run: operator-required** | A live workbench send. It needs a human to type `APPROVE ATTEMPT` at a controlling terminal; the study typed no approval | 0 |
| **Not run: no model** | Pi with a real model. The model router was down, and loading a model is outside this study's budget | 0 |

Every expected verdict comes from hand-written oracles ([oracles/](oracles/)) run as separate scripts, never from Endophasia's own
output.

## 2. Results by hypothesis

| # | Hypothesis | Result | Evidence |
| :-- | :-- | :-- | :-- |
| H1 | The README tour runs as written | **Failed (documentation), fixed here** | A1, A3 |
| H2 | Exit 0 with wrong output is a failure | **Failed on the page**: the CLI ledger and the Task view held; the overview did not (U1) | T1, U, tour, U1 |
| H3 | Uncovered criteria stay visible; nothing implies acceptance | **Held, with a limit** | B2 |
| H4 | Freshness: old, dirty and contradicted passes are not current | **Held** | C1-C3 |
| H5 | Absent or damaged evidence is not failed or passed | **Held for damage.** A consistent forgery is undetectable, as documented, and so is a genuine receipt from an altered environment (F1) | C7, C8, F1 |
| H6 | Provenance stays descriptive | **Held** | C6, all provenance output |
| H7 | CLI and browser agree | **Task view agrees; the overview contradicts it** | E, U1 |
| H8 | A fresh reader can reconstruct the facts | **Held for model readers only, with one recurring gap; not tested with humans** | D |
| H9 | The ledger makes gaps more explicit than receipts | **Weak signal from model readers only (n = 4); not tested with humans** | D |

## 3. Findings

Severity is for a human pilot: **high** would mislead a decision; **medium** confuses or delays; **low** is cosmetic or documented.

### A. The README tour

**A1 (medium, fixed in this PR): Git identity is an undocumented prerequisite.** In a fresh `HOME` with no Git identity, step 1's
`git commit` fails (exit 128), and every later check is refused with "that directory cannot be observed as the top of a Git working
tree (unborn). Nothing was run and nothing was recorded." Endophasia's refusal is correct; the README listed only "Node.js and Git".
Reproducer: [evidence/A1-tour-no-git-identity.txt](evidence/A1-tour-no-git-identity.txt).

**A2 (none): with an identity set, every step matches the README.** Both quoted ledger excerpts are reproduced exactly: *Failed at
HEAD … first difference at line 1: expected "14", observed "20"*, then *Passed at HEAD … at another commit … failed*. The task stays
`open`. [evidence/A2-tour-with-identity.txt](evidence/A2-tour-with-identity.txt).

**A3 (medium, fixed in this PR): step 5's `provenance` sentence was false.** The tour never records an observation, so
`endo attempt provenance` prints `[none] no observation is recorded for this attempt`, not a comparison with the checked commits. With
`endo attempt observe` added before it, the output matches the sentence: *checked 4306811 … same content; checked d637bcd … 1 path
differs: M calc.mjs*.

**A4 (low): `endo attempt check` prints its whole receipt as JSON (about 100 lines) to stdout.** The README's excerpt shows only the
final `recorded:` line and says "abridged", so it is not wrong, but a first-time user sees much more than the page suggests.

**A5 (low, not changed): the README's opening outruns the records.** It asks "Is the code you are reading the code that was checked?
Endophasia answers from records". No record names the candidate revision (D), and F1 shows a check's environment can decide its
result. Step 6 also sends readers to the overview without warning about U1. Recorded rather than rewritten: the README is the owner's
voice, and the right wording depends on how U1 is fixed.

### B. Behaviour and coverage

**B1 (medium): `endo attempt check` reports exit status, not the plan's verdict, in both directions.** For the seeded calculator and
Roman numerals (wrong output, exit 0) it exits 0 and prints *recorded: Observed check passed*. For the correct refusal of `0`
(declared `exitCode: 2`) it exits 3 and prints *Observed check failed*. `attempt evidence` and the page give the opposite and correct
verdicts. This is the design (a receipt is exit status, and the plan is read later), and the evidence output says "exit status only".
But the command an operator runs gives the wrong answer for every behavioural check, and so does its exit code to any script.

**B2 (limit, by design): a partly covered criterion reads as passed.** With the planted T2U regression (a repeated `d` is accepted),
every planned check and the test suite pass. Criterion 4, *rejected inputs stay rejected*, reads **Planned checks passed at HEAD**, and
the gap list shows only "not sent" and "not done". The correct agent candidate (T2) produces the same verdict on every criterion and
every check at HEAD; only the "at another commit" history differs. Criterion 2 (*node --test exits 0, and test/ is unchanged*) is also
only partly covered: the adversarial reviewer replaced the test file with a trivial passing test, and criterion 2 still read *Planned
checks passed at HEAD*, because no check reads `test/`. Records cannot
separate them; the diff can. The CLI says so only in its closing list ("That a passing check satisfies the acceptance criteria: the
command decides what is checked"). The page says it under the criteria ("That a check addresses a criterion is your plan's
statement"). Judgment criteria are shown as **Your judgment** in both, but they are not in the gap list.

**B3 (none): the planted regression that the tests did sample was caught.** T2R (any unit order accepted) failed `node --test`, and
criterion 2 read *A planned check failed at HEAD*. See deviation 2.

**B4 (none): the agent's completion claims stayed claims.** Both agents reported success. The outcome line reads *recorded as
reported, not verified*, and every verdict comes from receipts the operator's commands made. Both candidates pass the oracles; the
records agree with the oracle for T1 and T2 on every check-covered criterion.

### C. Freshness and integrity

| Case | What the ledger said | Correct? |
| :-- | :-- | :-- |
| C1: pass, then an unrelated commit moves HEAD | *Not run at HEAD (only at other commits); at another commit … passed*; criterion *Not shown at HEAD* | yes |
| C2: pass, then the tree is made dirty | *At HEAD, but the tree has changed since*; criterion *Not shown*. A check on the dirty tree is refused (exit 2, nothing recorded) | yes |
| C3: a later run at the same commit contradicts (an ignored input changed) | *Results at HEAD disagree*; criterion *inconclusive* | yes |
| C4: a failure without `--keep-output` | *output different (not kept: run again with --keep-output to see it)* | yes |
| C5: 10 000 bytes of output | kept 8 192 bytes, `truncated: true`, first difference still shown | yes |
| C6: 1 200 changed paths at an observation | *1000 changed paths, incomplete*; the span is *not compared* | yes |
| C7: a receipt file made malformed | *1 file(s) are not usable receipts and are not shown*, plus a gap naming it; nothing is read as passed or failed | yes |
| C8: receipts rewritten consistently (outcome digests replaced) | **Planned checks passed at HEAD**, no gap, no damage reported | as documented: unsigned local records |

**C8 is not the only way to get a false pass.** A forgery that keeps the kept text but changes only the digest is rejected as damaged
(the reader checks kept text against its digest; adversarial reviewer, confirmed in `storage/develop-receipts.ts`). A digest-only
edit of a receipt made without `--keep-output` is not detectable.

**F1 (high): a genuine receipt can record a pass for wrong code, with no record edited.** Reproduced by the study after the
adversarial reviewer found it. The seeded Roman numerals is unchanged at a clean HEAD. A hook loaded from **outside** the repository
(`NODE_OPTIONS="--import=/outside/hack.mjs"`) rewrites one printed line. The check records *Observed check passed*, and criterion 1
reads **Planned checks passed at HEAD**, with no gap. Three facts make this matter for a pilot:

- the check's environment is inherited and not recorded (the receipt lists `environment-not-recorded`, but the ledger's "not
  established" list does not mention the environment);
- `endo attempt check` needs no terminal and no approval, and the brief names the attempt id;
- every receipt says `requestedBy: "operator"` (`runtime/contracts/develop-receipts.ts`).

So an unsandboxed agent running as the operator's user can make receipts that look like the operator's. "Keep the store out of the
agent's reach" cannot be enforced for a same-user agent, and `experiment protected-run` is not a DEVELOP path (it makes no attempts or
receipts), so neither is a mitigation. The residual risk for a pilot is procedural (§7).

### D. Independent review (model surrogates)

Four fresh-context reviewers each got one packet: the brief, the candidate diff, and either the receipt-oriented output (`attempt
show` + `attempt receipts`) or the ledger (`attempt evidence` + `attempt provenance`). Full scoring is in [REVIEW.md](REVIEW.md).

| Scenario (oracle) | Receipts view | Ledger view |
| :-- | :-- | :-- |
| X: T2U, regression nothing samples (**fails**) | REJECT; found `*` → `1d1d` | REJECT; found `*` → `1d1d` |
| Y: T2 agent candidate (**passes**) | CANNOT DECIDE YET, leaning accept | CANNOT DECIDE YET, leaning accept |

- **No erroneous acceptance in any cell.** Every reviewer kept criteria 3 and 5 as judgment and called criterion 4 sampled, not
  established.
- **The decisive evidence was the diff, not either presentation.** For X, both reviewers found the defect by reading the regex.
- **Both receipt-view reviewers made the same factual error:** they read a receipt's `"outcome": "passed"` as a byte-for-byte output
  comparison. It is exit status only. In these packets the receipts at HEAD happened to agree with the behaviour, so no verdict changed;
  in the X packet the fixture's `days-parse` receipt reads *Observed check passed* although its behaviour failed. Neither ledger
  reviewer made this error.
- **All four flagged the same traceability gap:** no record names the candidate revision or the base it is compared with, so "the diff
  is the checked HEAD" had to be inferred. This is WORK-CYCLE-001B item 3, still open.

H9 is supported only weakly: decisions did not differ, but the receipt view induced a factual misreading in 2 of 2 reviewers and the
ledger in 0 of 2. Four model reviewers are not human participants and not a sample.

### E. The page

- **The Task view agrees with the CLI line for line** for U, F and T2U, on every per-check and per-criterion verdict, and on the
  judgment criteria. Each was captured by [rebuild-page-cases.sh](rebuild-page-cases.sh), which rebuilds the three stores from scratch
  and refuses a capture that lacks the Task view's verdicts.
  - Page and CLI pairs: [T2U page](evidence/E-T2U-page-task.txt) and [T2U CLI](evidence/E-T2U-cli-evidence.txt);
    [U page](evidence/U1-page-task.txt) and [U CLI](evidence/U1-cli-evidence.txt); [F page](evidence/F-page-task.txt) and
    [F CLI](evidence/F-cli-evidence.txt).
  - The first T2U capture is withdrawn (deviation 10). It recorded the task picker and the overview, not the Task view.
- **U1 (high): the overview contradicts the ledger in both directions.** It reads only each command's latest exit status.
  - **Missed failure.** The seeded Roman numerals is checked once (exit 0, wrong output). The overview says **Needs your attention (0)**
    and *no command's latest observed check failed or was inconclusive*. The Task view on the same page says **A planned check failed
    at HEAD**.
  - **False alarm.** The correct refusal of `0` (declared exit 2) is flagged **Check failed … exited with code 2**, while the Task view
    says *rejects-zero: Passed at HEAD*.
  - **Missed contradiction.** The adversarial reviewer showed that a plain check which fails and then passes at the same HEAD shows
    *Needs your attention (0)*, while the ledger says *Results at HEAD disagree*. The study did not reproduce this case itself.

  This is the deferred "plan-aware attention" item (docs/designs/develop-behavioural-checks.md §7), shown to mislead in practice.
  Reproducer for the first case:
  [evidence/U1-page-overview.txt](evidence/U1-page-overview.txt), [evidence/U1-page-task.txt](evidence/U1-page-task.txt),
  [images/U1-overview-1440.png](images/U1-overview-1440.png).
- **U2 (low): `attempt receipts` lacks the behaviour annotation the page has.** The page adds *For the planned check days-parse: its
  exit code or output is not the one declared. The label above is its exit status.* under each receipt; the CLI list does not. This is
  the line the receipt-view reviewers were missing (D).
- **U3 (low, uncertain): a transient first-load message.** Captured immediately after pairing, the overview read *As last read: the
  checks could not be read again just now* while still *Reading the checks…*. Once its checks were read, it showed them normally. It
  is not established whether this wording appears on every first load.
- **No horizontal overflow at 390 px** in three stores. Narrow-width coverage is otherwise limited: the page scrolls inside its panels,
  so a viewport capture did not reach the Task view. The product's own 390-px browser tests remain the evidence there.
- **Authority on the page matched its host.** The workspace page says it cannot send, steer, stop or run anything, and offers no such
  control.

## 4. Answers to the central questions

- **Q1, end-to-end correctness.** Through preparation, handoff, operator checks and evidence reading: yes, for two real-model
  candidates and four planted ones, with nothing essential lost. Execution through the live workbench was **not exercised** (operator
  required).
- **Q2, evidence reliability.** The CLI ledger and the Task view drew all six distinctions in the states built here, with three
  qualifications:
  - a partly covered criterion reads as passed when its samples pass (B2);
  - a consistent forgery is undetectable (C8);
  - a genuine receipt from an altered environment, possibly made by the agent, is indistinguishable from the operator's own (F1).

  The overview does not draw the first distinction (U1).
- **Q3, independent reconstruction.** For model readers, yes: they reconstructed the verdicts from frozen output alone. The missing piece is a
  record of which revision is the candidate.
- **Q4, decision support.** The ledger prevented a misreading that the receipt view caused in both of its reviewers. It did not change
  any decision, because the diff was decisive. That is a surrogate measurement, not a human result.
- **Q5, readiness.** See §7.

## 5. What this study does not establish

- Anything about a human operator: that is REVIEW-PILOT-001's pending review, which this study did not touch.
- The live workbench path (send, run, before-send and run-end observations) with real Pi and a real model.
- Larger repositories, other languages, slow or flaky checks, or long-running services.
- macOS: behavioural checks there read inconclusive by design.
- That four model reviewers generalise to anything. The agents, the reviewers, the scorer, the author of the planted controls and the
  adversary are all Claude models, and every failure observed was planted by an author who knew the mechanism; both real agent
  candidates were correct. The review packets also named "the validation study", and the instructions favoured caution, so "no
  erroneous acceptance" says little.
- Page and CLI agreement for the freshness states C1-C8: the page was compared for T1, T2U, U and F only.
- Linked worktrees and `--cwd` elsewhere, checks that time out or leave processes, PATH shadowing outside the worktree, and the
  time-of-check/time-of-use window between the last check and the status move.

## 6. Deviations from the protocol

1. **Harness errors, corrected.** Twice the study's own shell harness invoked the CLI wrongly: an overwritten argument, then an
   unexported store path. The CLI refused every one ("Nothing was run and nothing was recorded"), and the runs were repeated correctly.
   No refused run contributed to any result.
2. **T2R was caught by the fixture's tests,** which already sample unit order (`1m1h`, `1h1d`). The intended control, a regression
   nothing samples, was added as **T2U** (a repeated `d`).
3. **A tell-tale comment** in the planted T2U source was removed with a further commit, and the checks were re-run at that HEAD,
   before the review packets were frozen. No evidence file was edited.
4. **No "before" observation** was recorded before the agents worked, so their provenance frames are the operator's own observations
   only.
5. **README edited.** The protocol said not to change the README to make the demo pass. A1 and A3 were recorded first, from the
   unmodified README; the fix is a separate, labelled commit (`2797a5cd9`), verified by re-running the tour.
6. **Oracles and fixtures were not in the preregistration commit.** Only PROTOCOL.md was committed before the experiments. The oracle
   tables are in the protocol, but `oracles/` and `fixtures/` were written afterwards, before any candidate was examined (that cannot
   be shown from Git). The duration oracle also adds two cases (`format 0`, `1x`).
7. **Criterion numbering.** The protocol lists four T2 criteria; the plan as run has five (the day-unit criterion is first). Findings
   use the plan's numbering.
8. **The early-stop clause was met and not acted on.** The protocol says to stop if "the ledger reports a pass the oracle fails with no
   gap shown", and T2U does exactly that. The study continued, because the cause is the plan's sampling (B2), not a ledger defect. That
   is the study's judgment, made after the fact.
9. **The decision changed after the adversarial review.** The draft said CONDITIONALLY READY, filing U1 under H7. The adversarial
   reviewer pointed out that the preregistered H2 rule covers the page. The decision now follows that rule.
10. **A page capture was wrong, and its claim is now re-established.** Codex found that the first `E-T2U-page-task.txt` contained
   the task picker and the overview, not the Task view: the reader clicked the first button whose text matched, which was the picker.
   The reader now clicks the overview row and refuses a capture without per-check verdicts. U, F and T2U were rebuilt from scratch and
   recaptured. Separately, the two tour logs were first saved as `.log` files, which `.gitignore` excludes, so they were missing from
   the PR; they are now `.txt` files.

## 7. Readiness and the next step

**NOT READY, by the preregistered rule** (H2 failed on the page). What has and has not been established:

- **Established:** in disposable repositories, the CLI ledger and the Task view separate exit status from behaviour, keep judgment
  criteria visible, keep stale, dirty, contradicted, truncated, incomplete and damaged evidence from reading as current, never attribute
  authorship, and agree with each other. Model readers reconstructed verdicts from the frozen output.
- **Not established:** that a human decides better with it; the live workbench path with real Pi; resistance to an agent that runs
  checks itself or alters their environment (F1); anything about the overview's correctness (U1).

**The smallest path to READY FOR HUMAN PILOT:**

1. **One implementation PR: make the overview read the plan (U1).** Where an attempt has a plan, the overview should take each planned
   check's verdict from the ledger: behaviour, not exit status, and *mixed* where results at HEAD disagree. This covers all three
   directions in U1. The same PR can add one line to `endo attempt check` for a planned behavioural check: *the plan reads this check
   by its output; see endo attempt evidence* (B1). It can also add the environment to the ledger's "not established" list (F1). All
   three are read-side wording and projection changes; no trust boundary moves.
2. **A written pilot procedure (no code):**
   - stop the agent before running checks and before deciding;
   - run checks from a clean shell with `NODE_OPTIONS` and similar variables unset;
   - count the receipts against the checks you ran yourself, and treat any extra receipt as the agent's (F1);
   - read verdicts from `attempt evidence` or the Task view, not from `attempt check`'s exit status (B1);
   - re-read the evidence immediately before the status move.
3. **Then re-run this study's scripts** (an hour, no model needed) to confirm U1 is fixed.
4. **Already done here:** README A1 and A3.

**Not recommended yet:** a record naming the candidate revision (all four reviewers wanted it). That is REVIEW-PILOT-001's B1/B2
question; let the human review decide it. Making receipts resistant to the agent (signing, or a check runner outside the agent's
reach) is a real need F1 exposes, but it is a design question that belongs after the pilot shows how much it matters.

**Human actions still required:** see [HUMAN-WORKSHEET.md](HUMAN-WORKSHEET.md). The decisive ones are completing REVIEW-PILOT-001's
pending review and running one real-Pi attempt through the live workbench with a behavioural plan.
