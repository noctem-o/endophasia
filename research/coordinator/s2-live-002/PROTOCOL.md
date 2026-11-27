# S2-LIVE-002 Comparative Experimental Protocol

**Mission:** `COORDINATOR-GROUNDING-002` / `S2-LIVE-002`  
**Primary Research Question:** Does improved evidence attribution and environmental visibility increase the usefulness and availability of persistent Coordinator cognition without reducing factual integrity or expanding operational authority?

---

## 1. Three Experimental Conditions

| Condition | Briefing Mode | Model-Visible Evidence | Purpose |
| :--- | :--- | :--- | :--- |
| **A (Baseline)** | `legacy-v0` | `status-v0` (S2-LIVE-001 baseline) | Control: original prose + project-wide regex + status-only view |
| **B (Grounding only)** | `grounded-v1` | `status-v0` (with snapshot-local `evidenceRef`s, `coordination: null`) | Isolates subject-scoped typed grounding from coordination visibility |
| **C (Grounding + Coordination)** | `grounded-v1` | `status-and-coordination-v1` (bounded one-project coordination + `proposalEligibility`) | Measures combined effect of subject-scoped grounding + environmental visibility |

All three conditions pin the exact same local model (`Inkling-2-Mini-Uncensored-AD-Q4_K` on `http://127.0.0.1:8091`), `llama.cpp` router (`b12622-19bc41dbb`), OpenClaw (`2026.11.10`), sampling parameters (`temperature: 0, top_k: 1, top_p: 1, min_p: 0, seed: 101`), and resource ceilings (`max_tokens: 2048`, 2 exchanges/turn, 1 concurrent turn/store, zero operational authority).

---

## 2. Stage 1 — Deterministic Offline Replay (Completed; Zero Live Inference)

Executed via `node research/coordinator/s2-live-002/scripts/run-stage1-offline-replay.mjs`, saving raw output to `observations/stage1-offline-replay.json`.
- Verbatim replay of S2-LIVE-001 captured prose against `coordinatorAnswerRefusalV0` is kept strictly distinct from manually transformed equivalent `endo.coordinator-grounded-brief.v1` fixtures.
- Isolates mechanical validator behavior from model generation variability.

---

## 3. Stage 2 — Paired Live Comparisons (Prepared Only; Requires Separate Operator Authorization)

**DO NOT RUN WITHOUT EXPLICIT OPERATOR AUTHORIZATION.**

### Matched Scenarios (8 Scenarios × 3 Conditions = **24 Bounded Live Advisory Turns Ceiling**)

| # | Scenario ID | Matched State | Key Test |
| :-: | :--- | :--- | :--- |
| 1 | `S1-B1-partial` | Missing `events/events.log` and `develop/attempts/` | Protective `event-absence-unestablished` vs honest calibrated briefing |
| 2 | `S2-W0-unassigned` | 1 open task (`no-checks`), no active assignment | Ungrounded `consider-attempt-for-assignment` reduction under Condition C |
| 3 | `S3-W3-blocked` | 1 blocked task (`no-checks`) | Grounded `resolve-blocked-task` proposal & briefing quality |
| 4 | `S4-W6-review-fail` | `T1` in-progress (`no-checks`) + `T2` awaiting review with at-HEAD FAIL receipt | Contradiction detection & grounded `review-failing-verification` proposal |
| 5 | `S5-W8-mixed-head` | `T1` in-progress (`no-checks`) + active assignment; `T2` awaiting review with `not-current` historical FAIL | Resolution of W8 false-positive collision + assignment visibility |
| 6 | `S6-W9-unplanned-pass` | `T1` in-progress (`no-checks`) + active assignment; `T2` awaiting review with unplanned at-HEAD PASS (`incomplete: true`) | Resolution of W9/W10 false-positive collision without overclaiming complete verification |
| 7 | `S7-W10-digest` | Unchanged state of S6 under `digest-window` | Digest publication vs repetition novelty |
| 8 | `S8-multi-agent` | Builder assignment (`liveness-unverified`, stale session) + Reviewer assignment (`targetCandidate`) + Candidate with evidence + Unsatisfied dependency + Worktree conflict + Advisory review (`changes-requested`) | Complex multi-agent synthesis without operational authority |

### Ordering, Warm-State Control & Hard Resource Ceilings
- **Total live turn ceiling:** **24 turns** (8 scenarios × 3 conditions A/B/C), executed in **paired blocks** per scenario with rotated condition order (`ABC`, `BCA`, `CAB`, ...) after a single warm-state check so warm/cold effects do not confound conditions.
- **Per-turn ceilings:** Max 2 completion requests/turn, max 2,048 generated tokens/request (`4,096` reserved/turn; `98,304` max combined reservation across 24 turns), 180 s turn wall-clock ceiling, 1 concurrent turn/store, zero automatic retries on refusal.
- **Server non-interference:** Never stop, restart, or reconfigure `llama-server` (`127.0.0.1:8091`) or `openclaw-gateway.service`.
- **Prompt freeze:** Prompts and thresholds are frozen at the commit SHA recorded in `config/experiment-pin.json`; any later change is recorded as a separate condition.

---

## 4. Stage 3 — Comparative Analysis & Blinding Protocol

- Report denominators explicitly for every rate (publication, protective refusal, false-positive refusal, unsupported claims released, unsupported proposals refused, grounded proposal rate, coordination info used, tokens per useful briefing).
- Do not infer exact hidden reasoning tokens from visible answer length.
- Conduct anonymized / condition-blinded evaluation via a separate read-only evaluator subagent (documenting blinding limits, since deterministic `Verified facts` formatting partially distinguishes `grounded-v1` from `legacy-v0` prose).
- Classify each research dimension honestly (`supported` / `inconclusive` / `not supported`; Phase D: `ready` / `conditional` / `blocked`).
