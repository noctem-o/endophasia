# DEVELOP-ATTENTION-002: independent review and dispositions

One fresh-context adversarial reviewer (a Claude model; a surrogate, not a human) reviewed the change twice, each time in its own copy of
the branch with a fresh `HOME`, without modifying the worktree. "Reproduced" means the study turned the finding into a test in
`tests/develop-attention-planned.test.ts` and saw it fail before fixing it. A reviewer's opinion alone was not taken as evidence.

## Round 1 (on `ad5b55993`)

| # | Finding (severity) | Disposition |
| :-- | :-- | :-- |
| 1 | A planned failure recorded in another (linked) worktree became a quiet "Run only in another working tree"; v0 flagged it (high) | **Reproduced (R2), fixed.** The entry carries its latest run and the plan's reading of it; a failure triages as failed. Also confirmed through the page (case E) |
| 2 | With HEAD unreadable, a recorded failure became "Not compared", with no flag (high) | **Reproduced (R1), fixed** the same way; the gate allows a named run behind `unavailable` |
| 3 | The per-task limit could cut a stale failure while listing passes (high) | **Reproduced (R3), fixed.** Ranking and `morePlanned` use the one triage rule, so the limit can only cut entries no worse than those it lists |
| 4 | An older attempt listed its unrun checks for ever, flagged the task after the newest attempt passed, and its lines did not say which attempt (medium) | **Reproduced (R4), fixed.** An older attempt lists only checks it ran, a newer attempt's run can supersede it (but see round 2), and lines name their attempt when more than one is listed |
| 5 | A planned pass beside unusable receipt files read as a current pass (medium) | **Reproduced (R5), fixed.** `incomplete`; the pass triages as unsettled, says so on the line, and a review rechecks it |
| 6 | The F1 wording said a receipt records the comparison with the plan; it records an exit status and an output digest (low) | **Fixed** in `endo attempt evidence` and the Task view |
| 7 | CLI: a silent null when the attempt records are unreadable; the derived reading reused the exit-status label; `outcomeIs` changes the JSON shape (low) | **Fixed** (a stderr notice; "The plan's reading of this run: …"). The shape change is additive and in the changelog |
| 8 | The design doc still named the v0 schema (low) | **Fixed** |
| - | Gate fuzz: 150 random stores × 3 HEAD readings, 0 of 450 views refused | Kept as evidence the gate accepts what the projection produces |
| - | The three U1 cases, through the built page | Confirmed fixed by the reviewer |

**Round 1 verdict:** not ready to merge, because findings 1 to 3 each brought back the error the change exists to remove.

## Round 2 (on `261ecef09`)

Findings 1 to 3 and 6 confirmed fixed. Finding 4 partly, finding 5 accepted as a stated choice. The gate fuzz was repeated: 0 of 450
refused. New:

| # | Finding (severity) | Disposition |
| :-- | :-- | :-- |
| C1 | An older attempt's later failure at HEAD was hidden by a newer attempt's earlier pass there: superseding compared attempts by preparation order, not by run time (high) | **Reproduced, fixed** |
| C2 | A pass in another worktree hid a failure here: the superseding key was the argv alone (high) | **Reproduced, fixed** |
| C3 | A stale pass hid a later failure at HEAD (high) | **Reproduced, fixed** |
| C4 | With HEAD unreadable, an earlier pass elsewhere hid a later failure (medium) | **Reproduced, fixed** |
| 5 | Outside review, an incomplete pass does not flag the row; the overview can read (0) with the gap line (low, accepted by the reviewer) | **Kept as a stated choice.** The line and the summary say a later result may be missing. It is a pilot-procedure item, not a flag |
| (d) | Other routes to "(0)" with a recorded planned failure: only an attempt whose receipts could not be read or were skipped, which v0 already reported as a gap | **Unchanged and stated** |

The fix: an older attempt's entry is superseded only by a newer attempt's **later** run of the same command (`endoReceiptLaterV0`, the
same "latest" rule as v0 and the ledger) that is **at least as current**: a clean HEAD, then a changed tree, then another commit, then
another worktree or no HEAD. A test also shows the positive case still holds: a newer attempt's later pass at HEAD supersedes an older
stale failure.

**Remaining limitation, documented:** two other worktrees count as equally current, so a later run in one can stand for an earlier run in
another.

**Round 2 verdict:** not ready to merge until C1 to C3 were fixed. They are fixed and tested. A third review round was not run.
