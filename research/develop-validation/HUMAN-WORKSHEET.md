# DEVELOP-VALIDATION-001: questions only the operator can answer

This study could not settle these questions, because each needs a human at the controlling terminal or a human judgment. Answer them in
any order. Nothing here replaces REVIEW-PILOT-001's own worksheet ([research/review-pilot/worksheet.md](../review-pilot/worksheet.md)),
which is still pending and unchanged by this study.

## 1. REVIEW-PILOT-001 (pending since 2026-11-08)

- [ ] Fill in that pilot's worksheet for run 2 **before** deciding, then move the task's status yourself.
- [ ] Note whether you used anything outside `endo` output and the diff. If you did, what record would have replaced it?

## 2. One real-Pi attempt with a behavioural plan

The study could not run this, because a send needs you to type `APPROVE ATTEMPT …` at the workbench terminal.

- [ ] Prepare an attempt with a plan that has at least one `expect`, send it from the workbench, and let the run end.
- [ ] Did `endo attempt provenance` show an observation **before the send** and one **when the run ended**? (yes / no / only one)
- [ ] After your checks, did the Task view and `endo attempt evidence` agree on every criterion? (yes / no: which)
- [ ] Did the overview's "Needs your attention" agree with the Task view? (Expected **no** for an exit-0 behavioural failure: U1.)

## 3. Judgments the study could not make for you

- [ ] **B2.** A criterion like "rejected inputs stay rejected" reads *Planned checks passed* when its samples pass. Is that wording
      acceptable to you, or should a criterion state how much of it the checks sample?
- [ ] **B1.** `endo attempt check` says "passed" for an exit-0 program with wrong output. Would you read `attempt evidence` every
      time, or do you need the check command itself to say the plan disagrees?
- [ ] **C8.** Where will the store live during the pilot, and can the agent write there? (Default: `~/.local/share/endophasia/store`,
      writable by an unsandboxed Pi.)
- [ ] **D.** All four model reviewers wanted a record naming the candidate revision. Did you, in practice?

## 4. The pilot procedure (please confirm or change)

- [ ] Stop the agent before running checks, and again before deciding.
- [ ] Run checks from a clean shell with `NODE_OPTIONS` and similar variables unset (F1).
- [ ] Count the receipts against the checks you ran yourself; treat any extra one as the agent's (F1).
- [ ] Read verdicts from `endo attempt evidence` or the Task view, never from `attempt check`'s exit status or the overview (B1, U1).
- [ ] Re-read the evidence immediately before moving the task's status.

## 5. Your decision

- [ ] The study's decision is NOT READY until the overview reads the plan (U1). Start the human pilot after that PR and the
      procedure above, start it now with the overview ignored, or wait for something else (say what).
