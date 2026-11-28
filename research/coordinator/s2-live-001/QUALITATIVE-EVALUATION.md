# S2-LIVE-001 Qualitative Advisory Evaluation

This document evaluates every live Coordinator turn and proposal across Phases B and C on the six required qualitative dimensions, compared side-by-side against the deterministic CLI summary (`endo coordinator status`), separately from mechanical S2 correctness.

**Total live dispatched turns measured:** 12 (`Phase B-1`: 1, `Phase B-2`: 1, `Phase C Run 1`: 3, `Phase C Run 2`: 7) + 1 pre-dispatch isolated outage refusal (`ctrl-outage`, 0 tokens) + 12 zero-token skipped/repeat ticks (`skipped-unchanged`, `skipped-already-attempted`, `missed-skipped`, `nothing due`).

---

## 1. Per-Turn Qualitative Matrix (All 12 Live Dispatched Turns)

Ratings: `pass`, `partial`, `fail`, `withheld` (backstop refused before release).  
Value delta vs deterministic `endo coordinator status`: `+2` (clear value add), `+1` (mild value add), `0` (neutral/parity), `-1` (net drag), `-2` (harmful/misleading).

| Turn | Phase / Window | Outcome & Tokens | Grounded | Relevant | Novel | Timely | Actionable | Uncertainty Calibrated | Delta vs Deterministic | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | B-1 (`smoke`, partial store, cold load) | `briefing-refused` (`event-absence-unestablished`), 675 tok, 36.6 s | withheld | withheld | withheld | withheld | withheld | fail (triggered backstop) | `-1` | Protective refusal: model overstated absence of session activity when `events/events.log` was absent (`events: unavailable`). Deterministic `coordinator status` clearly reported `events=unavailable/unavailable` in <400 ms. |
| 2 | B-2 (`smoke-complete`, complete store, warm) | `briefing-published`, 612 tok, 21.5 s | pass | partial | pass (first) | pass | pass | pass | `0` | Accurate 5-bullet summary of 1 open task with `no-checks`. Restates deterministic `coordinator status` cleanly without adding new synthesis. |
| 3 | C-Run1 `W0-initial` | `briefing-published`, 1,302 tok, 31.6 s; proposal `refused (proposal-ungrounded)` | pass (prose) / fail (proposal) | partial | pass (first) | pass | partial | pass | `0` | Prose accurately summarized 1 open task, but model emitted `PROPOSAL: consider-attempt-for-assignment` with no active assignment. S2 grounding correctly refused the ungrounded proposal. |
| 4 | C-Run1 `W3-task-blocked` | `briefing-published`, 1,192 tok, 30.5 s; proposal `created (resolve-blocked-task)` | pass | pass | pass | pass | pass | pass | `+1` | Correctly detected `open -> blocked` transition, distinguished absence of checks from failure, and emitted a grounded, actionable `resolve-blocked-task` proposal. |
| 5 | C-Run1 `W5-codue-1` (`ctrl-digest`, unchanged) | `briefing-published`, 1,361 tok, 32.6 s | pass | partial | fail (repetitive) | pass | pass | pass | `0` | Accurate digest on unchanged blocked state, but substantially repeats W3 prose; cost 32.6 s and caused co-due 1m `ctrl-on-change` to miss its 15 s grace (`missed-skipped`). |
| 6 | C-Run2 `W0-initial` | `briefing-published`, 984 tok, 26.8 s; proposal `refused (proposal-ungrounded)` | pass (prose) / fail (proposal) | partial | pass (first) | pass | partial | pass | `0` | Same pattern as Run 1 W0: grounded prose, but repeated ungrounded `PROPOSAL: consider-attempt-for-assignment` on an unassigned open task (caught and refused by S2). |
| 7 | C-Run2 `W3-task-blocked` | `briefing-published`, 1,463 tok, 34.8 s; proposal `created (resolve-blocked-task)` | pass | pass | pass | pass | pass | pass | `+1` | Reproducible success across both runs: detected blocked transition and created grounded `resolve-blocked-task` proposal (`8c41cf5a525e…`). |
| 8 | C-Run2 `W5-digest-1` (`ctrl-digest`, unchanged) | `briefing-published`, 772 tok, 23.5 s | pass | partial | fail (repetitive) | pass | pass | pass | `0` | Accurate restatement of unchanged blocked state; zero new signal beyond W3 or deterministic status. |
| 9 | C-Run2 `W6-verify-fail` | `briefing-published`, 1,166 tok, 30.0 s; proposal `created (review-failing-verification)` | pass | pass | pass | pass | pass | pass | `+1` | **Strongest advisory turn observed:** prioritized the multi-task contradiction (`status-contradicts-verification`: `T2` awaiting review with fresh controller-observed FAIL at HEAD) over `T1` (`in-progress`, `no-checks`), while keeping uncertainty calibrated, and emitted a valid grounded `review-failing-verification` proposal (`98a73d1d15e0…`). |
| 10 | C-Run2 `W8-coord-and-head` (`T2` `not-current` + `T1` `no-checks` + active assignment) | `briefing-refused` (`receipt-absence-unestablished`), 1,293 tok, 32.0 s | withheld | withheld | withheld | withheld | withheld | withheld (backstop collision) | `-1` | **Availability collapse #1:** Project-wide wording backstop withheld the briefing because `T2` was `not-current` while `T1` was `no-checks` (prompt instructs `"no check is recorded for this task"` for `no-checks`, which collides with the project-wide regex whenever any sibling task is `not-current`/`incomplete`/`not-read`). |
| 11 | C-Run2 `W9-verify-pass` (`T2` `incomplete` pass at HEAD + `T1` `no-checks`) | `briefing-refused` (`receipt-absence-unestablished`), 1,249 tok, 31.1 s | withheld | withheld | withheld | withheld | withheld | withheld (backstop collision) | `-1` | **Availability collapse #2:** Fresh controller-observed PASS at HEAD (`reading: unplanned`) sets `T2.verification.incomplete = true`; combined with `T1` (`no-checks`), the project-wide backstop withheld the briefing again. |
| 12 | C-Run2 `W10-digest-2` (`ctrl-digest`, same state as W9) | `briefing-refused` (`receipt-absence-unestablished`), 1,160 tok, 29.5 s | withheld | withheld | withheld | withheld | withheld | withheld (backstop collision) | `-1` | **Availability collapse #3:** Digest window on the exact same healthy multi-task state was also withheld, burning 1,160 tokens and 29.5 s for zero operator output. |

---

## 2. Per-Proposal Evaluation (All Emitted & Refused Proposals)

| Run / Window | Model Proposal Line | S2 Grounding Decision | Grounded | Relevant | Novel | Timely | Actionable | Calibrated | Lifecycle Observed |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| C-Run1 `W0` | `consider-attempt-for-assignment <T1>` | **Refused** (`proposal-ungrounded`) | fail | fail | n/a | n/a | fail | fail | Blocked before storage; zero queue pollution. |
| C-Run1 `W3` | `resolve-blocked-task <T1>` | **Created** (`0be920e0d267…`) | pass | pass | pass | pass | pass | pass | Grounded on `task-status-blocked` + `no-check-recorded`. |
| C-Run2 `W0` | `consider-attempt-for-assignment <T1>` | **Refused** (`proposal-ungrounded`) | fail | fail | n/a | n/a | fail | fail | Blocked before storage; reproduces Run 1 W0 behavior. |
| C-Run2 `W3` | `resolve-blocked-task <T1>` | **Created** (`8c41cf5a525e…`) | pass | pass | pass | pass | pass | pass | Created `pending`/`current`; automatically flipped to **`stale`** in W6 when `T1` moved to `in-progress`. |
| C-Run2 `W6` | `review-failing-verification <T2>` | **Created** (`98a73d1d15e0…`) | pass | pass | pass | pass | pass | pass | Grounded on `task-verification-failing` + `review-without-passing-check`; operator acknowledged in W7 (`queueState: acknowledged`, zero store/route mutations outside advisory namespace); automatically marked **`stale`** after W8 HEAD advance. |

---

## 3. Failure, Waste, and Contention Log

- **False alarms:** **0** published false alarms (2 ungrounded `consider-attempt-for-assignment` proposals in W0 were caught and blocked by S2 grounding before publication).
- **Missed opportunities:**
  - **W8 (coordination assignment + HEAD advance making prior FAIL historical)** and **W9 (fresh PASS receipt at HEAD)**: 3 consecutive live turns (`W8`, `W9`, `W10`) were withheld by the project-wide `receipt-absence-unestablished` wording backstop. The operator received zero advisory output for all three transitions while deterministic `endo coordinator status` surfaced them immediately.
  - **Coordination invisibility to the model:** Because `endophasia_status` delivers `status.view` (not `coordinator-coordination.v0`) to the model, the model cannot observe active assignments (`assign create`) when deciding whether to emit `consider-attempt-for-assignment` or `investigate-liveness-hazard`.
- **Stale recommendations:** **0** stale briefings published (`current-at-publication` held on 8/8 published briefings). Existing proposals (`resolve-blocked-task` after W6 unblock; `review-failing-verification` after W8 HEAD advance) were accurately marked `currency: "stale"` in `advisory proposals`.
- **Refusals (4 of 12 dispatched turns = 33.3%):**
  - 1 protective refusal (`B-1`: `event-absence-unestablished` on partial store with missing `events/events.log`).
  - 3 project-wide backstop availability-loss refusals (`C-Run2 W8, W9, W10`: `receipt-absence-unestablished` triggered on multi-task projects mixing a `no-checks` task with a `not-current` or `incomplete` task).
- **Resource contention:**
  - Cold-loading `Inkling-2-Mini-Uncensored-AD-Q4_K` (16.53 GB GGUF) added **~15.1 s** (`36.2 s` cold vs `21.1 s` warm) and spawned a persistent worker child (`1.50 GB` host RSS + GPU VRAM).
  - Warm turns averaged **29.7 s** (`21.1–34.8 s`) and **1,134 generated tokens** (`612–1,463`, up to 71.4% of the 2,048-token cap due to hidden deliberation tokens).
  - Co-due short-interval contention (`C-Run1 W5`): a 32.6 s digest turn caused a co-due 1m `on-change` schedule to miss its 15 s on-time grace (`missed-skipped`).
- **Unnecessary reasoning:**
  - **0** unnecessary `on-change` turns: 8/8 unchanged `on-change` idle ticks across Run 1 and Run 2 returned `skipped-unchanged` in `358–368 ms` with **0 tokens**.
  - **0** retry storms after refusal/outage: 3/3 post-refusal/post-outage ticks returned `skipped-already-attempted` in `363–372 ms` with **0 tokens**.
  - `digest-window` turns on unchanged single-task state (`C-Run1 W5`, `C-Run2 W5`) were authorized as designed, but yielded `0` value delta (pure repetition of prior briefing).
