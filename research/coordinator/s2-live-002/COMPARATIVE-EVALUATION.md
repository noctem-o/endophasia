# S2-LIVE-002 Comparative Evaluation (Stage 1 Completed; Stage 2 Prepared & Awaiting Authorization)

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Live Inference Executed So Far:** **0 turns / 0 tokens** (Stage 2 paired live comparisons require separate explicit operator authorization before touching `http://127.0.0.1:8091`).

---

## 1. Stage 1 — Deterministic Offline Replay Results (Completed; 0 Live Inference)

Executed via `node research/coordinator/s2-live-002/scripts/run-stage1-offline-replay.mjs` against immutable S2-LIVE-001 captured snapshots under `research/coordinator/s2-live-001/`. Raw evidence: [observations/stage1-offline-replay.json](./observations/stage1-offline-replay.json).

> **Methodological distinction:** Verbatim replay of original S2-LIVE-001 prose against `coordinatorAnswerRefusalV0` is kept strictly separate from manually constructed equivalent `endo.coordinator-grounded-brief.v1` JSON claims. Stage 1 isolates **validator & visibility mechanics** from live model generation variability.

| Scenario (from S2-LIVE-001) | Fixture Kind | Condition A (`legacy-v0`, `status-v0`) | Condition B (`grounded-v1`, `status-v0`) | Condition C (`grounded-v1`, `status-and-coordination-v1`) | Mechanical Takeaway |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`B-1-partial-store`** (missing `events` & `attempts`) | Manually transformed equivalent claims | Refused (`event-absence-unestablished`) — **protective** | Unsupported `none-linked`: **refused** (`event-absence-unestablished`); calibrated `unknown-source-unavailable`: **published** (3 verified claims + host disclosure) | Same as B (coordination absent) | Protective event-absence refusal preserved mechanically; honest calibrated brief succeeds with unconditional host disclosure. |
| **`W0-initial-unassigned`** (open task, no assignment) | Exact verbatim replay + visibility check | Prose published (`refusal: null`), but proposal **refused** (`proposal-ungrounded`) because model guessed `consider-attempt-for-assignment` | `coordination: null`; `proposalEligibility = []` (guessing `consider-attempt-for-assignment` refused at grounding layer) | `coordination.sourceState = "absent"`; `proposalEligibility = []` explicitly disclosed to model | Eliminates host-vs-model asymmetry that caused repeated ungrounded `W0` proposals in S2-LIVE-001. |
| **`W6-verify-fail`** (`T2` awaiting review + at-HEAD FAIL; `T1` `no-checks`) | Exact verbatim replay + equivalent claims | Published (`refusal: null`), grounded `review-failing-verification` | Published (`ok: true`, `review-failing-verification`) | Published (`ok: true`, `review-failing-verification` on `T2`) | Preserves baseline high-value contradiction detection and grounded proposal behavior. |
| **`W8-coord-and-head`** (`T1` `no-checks` + active assignment; `T2` `not-current` historical FAIL) | Manually transformed equivalent claims | Original live & verbatim accurate prose: **refused** (`receipt-absence-unestablished`) — **false-positive collision #1** | **Published** (`ok: true`, 4 claims); attempting C's assignment claim under B is **refused** (`grounding-subject-unknown`) | **Published** (`ok: true`, 6 claims incl. active assignment) | Eliminates W8 false-positive collision while proving host-only coordination cannot validate Condition B claims. |
| **`W9-W10-unplanned-pass-and-no-checks`** (`T1` `no-checks` + active assignment; `T2` unplanned at-HEAD PASS `incomplete: true`) | Manually transformed equivalent claims | Original live (W9 & W10) & verbatim accurate prose: **refused** (`receipt-absence-unestablished`) — **false-positive collisions #2 & #3** | **Published** (`passing-incomplete` on `T2` + `none-recorded` on `T1`; claiming complete `passing` on `T2` refused) | **Published** (`ok: true`, 5 claims + active assignment + `verification-incomplete` uncertainty) | Eliminates W9/W10 false-positive collisions without weakening unplanned-PASS epistemic guardrails. |

### Stage 1 Summary Denominators (Deterministic Mechanics Only)
- **False-positive multi-task collisions resolved:** `3 / 3` (`W8`, `W9`, `W10` equivalent fixtures publish cleanly under B and C vs `0 / 3` under legacy regex).
- **Protective refusals preserved:** `1 / 1` (`B-1` unsupported `session-activity: "none-linked"` refused as `event-absence-unestablished`; additionally `4 / 4` states in acceptance item 3 refused as `receipt-absence-unestablished`).
- **Host-only validation isolation:** `1 / 1` (Condition C assignment claim rejected as `grounding-subject-unknown` under Condition B; Condition B guessing coordination proposal rejected as `grounding-claim-unsupported`).
- **Unsupported factual claims released:** `0 / 5` scenarios.

---

## 2. Stage 2 — Paired Live Comparisons (**NOT YET EXECUTED — AWAITING OPERATOR AUTHORIZATION**)

Harness prepared at [scripts/run-stage2-paired-live.mjs](./scripts/run-stage2-paired-live.mjs), gated behind `--authorize-live-stage2` so it cannot contact `http://127.0.0.1:8091` accidentally.

### Planned Comparative Scorecard (Denominators Frozen Before Execution)

| Metric | Denominator | Condition A (`legacy-v0`, `status-v0`) | Condition B (`grounded-v1`, `status-v0`) | Condition C (`grounded-v1`, `status-and-coordination-v1`) |
| :--- | :--- | :---: | :---: | :---: |
| **Briefing publication rate** | Published / 8 turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Schema / grounding malformed refusal rate** | `grounding-malformed` / 8 turns | N/A | _pending Stage 2_ | _pending Stage 2_ |
| **False-positive refusal rate** | False-positive refusals / 8 turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Protective refusal rate** | Protective refusals / unsupported attempts | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Unsupported factual claims released** | Count across published turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Grounded proposal rate** | Created proposals / proposal-eligible turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Ungrounded proposal refusal rate** | `proposal-ungrounded` / turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Coordination info used accurately** | Accurate coord claims / coord-present turns | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |
| **Mean latency & completion tokens / useful briefing** | Total tokens / useful published briefings | _pending Stage 2_ | _pending Stage 2_ | _pending Stage 2_ |

### Blinding & Qualitative Rating Protocol (Stage 3, Post-Stage-2)
- After Stage 2 completes, outputs from Conditions A, B, and C will be anonymized by scenario and condition label and graded by an independent read-only evaluator subagent against the S2-LIVE-001 6-dimension rubric (*Factually grounded*, *Relevant*, *Novel*, *Timely*, *Actionable*, *Calibrated about uncertainty*) plus deterministic-summary comparison.
- **Explicit blinding limitation:** Deterministic `Verified facts (snapshot ...):` formatting makes `grounded-v1` structurally distinguishable from `legacy-v0` prose (while Conditions B and C remain structurally identical when coordination claims are absent). This limitation will be disclosed explicitly alongside the Stage 3 scores.
- **Reasoning-token accounting honesty:** Reported completion tokens from `llama.cpp` will be recorded verbatim without inferring hidden reasoning tokens from visible output length.
