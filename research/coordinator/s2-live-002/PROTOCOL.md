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

All three conditions pin the exact same local model (`Inkling-2-Mini-Uncensored-AD-Q4_K` on `http://127.0.0.1:8091`), `llama.cpp` router (`b12622-19bc41dbb`), OpenClaw (`2026.11.10`), sampling parameters (`temperature: 0, top_k: 1, top_p: 1, min_p: 0, seed: 101`), pool member timeout (`135 s`, matching `protocol/coordinator-model-pool.ts` ceiling), separate S2 advisory turn wall-clock ceiling (`180 s`), and resource ceilings (`max_tokens: 2048`, 2 exchanges/turn, 1 concurrent turn/store, zero operational authority).

### Condition A Baseline Parity & Shared Runtime Note
Condition A retains the exact S2-LIVE-001 prompt (`ENDO_ADVISORY_INSTRUCTIONS_SHA256_V0 = d564ba57...`, `ENDO_ADVISORY_PROPOSAL_QUESTION_SHA256_V0 = 42da2baa...`), single-tool `endophasia_status` status-only payload (`modelViewV1 === null`), project-wide regex validator (`coordinatorAnswerRefusalV0`), and host proposal grounding. Because Condition A executes on the same commit as B and C, two shared runtime guards are present that did not exist in the original `2f730eb68` run: (1) Phase D.5 non-inference preflight (`preflightOpenClawCoordinatorV0`) runs before Phase E dispatch linearization (transparent on healthy runtimes; prevents token charge only on local runtime misconfiguration), and (2) explicit mode-combination refusal rejects `legacy-v0` + `status-and-coordination-v1` (not triggered by Condition A). Consequently, Condition A is a matched legacy-behavior control rather than an unmodified historical binary clone.

---

## 2. Stage 1 — Deterministic Offline Replay (Completed; Zero Live Inference)

Executed via `node research/coordinator/s2-live-002/scripts/run-stage1-offline-replay.mjs`, saving raw output to `observations/stage1-offline-replay.json`.
- Verbatim replay of S2-LIVE-001 captured prose against `coordinatorAnswerRefusalV0` is kept strictly distinct from manually transformed equivalent `endo.coordinator-grounded-brief.v1` fixtures.
- Isolates mechanical validator behavior from model generation variability.

---

## 3. Stage 2 — Zero-Inference Preflight (Completed) & Paired Live Comparisons (Awaiting Operator Authorization)

**DO NOT RUN `--authorize-live-stage2` WITHOUT EXPLICIT OPERATOR AUTHORIZATION.**

### Zero-Inference Harness Preflight & 24-Cell OpenClaw Dry Run (Completed)
Executed via `node research/coordinator/s2-live-002/scripts/run-stage2-paired-live.mjs --dry-run` against an ephemeral local fake provider (zero contact with `127.0.0.1:8091`):
- Verified all 8 scenarios × 3 conditions = 24 cells through real storage mutations (`open -> in-progress -> review` / `open -> blocked`), real `DevelopReceiptsServiceV0` host checks, real `defaultObserveAdvisoryProjectV0` snapshots, real installed OpenClaw `2026.11.10` + `/usr/bin/bwrap` + model relay, and automatic temp-dir cleanup.
- Verified exact normalized A/B/C structural semantic equivalence across all 8 scenarios (`observations/stage2-preflight-manifest.json`, `observations/stage2-dry-run.jsonl`).

### Matched Scenarios (8 Scenarios × 3 Conditions = **24 Bounded Live Advisory Turns Aggregate Ceiling**)

| # | Scenario ID | Observed Controller State (Verified in `stage2-preflight-manifest.json`) | Key Test |
| :-: | :--- | :--- | :--- |
| 1 | `S1-B1-partial` | Missing `events/events.log` and `develop/attempts/`; 1 `open` task (`unavailable`); `completeness: "partial"` (`permitPartialObservation: true`) | Protective `event-absence-unestablished` vs honest calibrated briefing + host source disclosures |
| 2 | `S2-W0-unassigned` | 1 `open` task (`no-checks`), `coordination.sourceState: "absent"`, `proposalEligibility: []` | Ungrounded `consider-attempt-for-assignment` reduction under Condition C |
| 3 | `S3-W3-blocked` | 1 `blocked` task (`no-checks`), `resolve-blocked-task` eligible | Grounded `resolve-blocked-task` proposal & briefing quality |
| 4 | `S4-W6-review-fail` | `T1` `in-progress` (`no-checks`) + `T2` `review` (`phase: "awaiting-review"`) with host FAIL receipt at HEAD (`verification: "failing"`) | Contradiction detection & grounded `review-failing-verification` proposal |
| 5 | `S5-W8-mixed-head` | `T1` `in-progress` (`no-checks`) + active builder assignment; `T2` `review` (`awaiting-review`) with `not-current` historical FAIL after HEAD advance | Resolution of W8 false-positive collision + assignment visibility |
| 6 | `S6-W9-unplanned-pass` | `T1` `in-progress` (`no-checks`) + active builder assignment; `T2` `review` (`awaiting-review`) with unplanned host PASS at HEAD (`incomplete: true`) | Resolution of W9/W10 false-positive collision without overclaiming complete verification |
| 7 | `S7-W10-digest` | Identical project state to S6, pre-seeded with a deterministic zero-inference prior considered briefing (`lastConsideredSemanticDigest === currentDigest`, verified `on-change` would skip as `skipped-unchanged` while `digest-window` admits) | Digest-window admission & publication on an already-considered unchanged state (cross-turn repetition/novelty evaluated separately by comparing S7 output against matched S6 live output, since `endophasia_status` does not disclose prior briefing text) |
| 8 | `S8-multi-agent` | Complete store (`completeness: "complete"`): revoked builder assignment (`hazard: "liveness-unverified"`, `session.liveness: "unknown"`, `terminationConfirmed: false`) + active builder assignment (declared session, `allowSharedWorktree: true`) + active reviewer assignment in registered sibling worktree (`targetCandidate: C1`) + current `git-commit` candidate `C1` (`receipts: "none"`) + unsatisfied dependency (`T1 -> T2`, `candidate-has-passing-receipt`) + 2 worktree conflicts (`shared-writable-worktree-acknowledged`, `worktree-liveness-unverified`) + advisory review (`changes-requested`, `high: 1, medium: 1`). Note: `defaultObserveAdvisoryProjectV0` observes only the primary project HEAD, so `C1.identity` and `worktrees[0].observation` are honestly reported as `"unavailable"`. | Multi-agent synthesis & liveness-hazard visibility under Condition C vs status-only visibility under A/B, without expanding operational authority |

### Ordering, Interrupt Safety, & Hard Aggregate Ceilings
- **Aggregate live ceiling:** **24 turns max across all runs/restarts**, enforced via a durable, append-only `fsyncSync` JSONL ledger (`observations/stage2-paired-live.jsonl`). Before each live turn begins, a `turn-intent` row is appended and synced; after completion, a `turn-result` row is appended. Interrupted runs (`SIGINT`/`SIGTERM` or crash) preserve all earlier evidence intact, skip already-attempted `(scenarioId, conditionId)` cells on restart, and count pre-dispatch intents conservatively so restarts can never exceed 24 aggregate live turns.
- **Per-turn ceilings:** Pool member `timeoutMs = 135,000` (schema ceiling), separate S2 advisory turn wall-clock deadline `maxTurnWallClockMs = 180,000`, max 2 completion requests/turn, max 2,048 generated tokens/request (`4,096` reserved/turn; `98,304` max combined reservation), 1 concurrent turn/store, zero automatic retries on refusal.
- **Server non-interference:** Never stop, restart, or reconfigure `llama-server` (`127.0.0.1:8091`) or `openclaw-gateway.service`.
- **Prompt freeze:** Prompts and thresholds remain frozen at commit `e9793b343` (`config/experiment-pin.json`).

---

## 4. Stage 3 — Comparative Analysis & Blinding Protocol

- Report denominators explicitly for every rate (publication, protective refusal, false-positive refusal, unsupported claims released, unsupported proposals refused, grounded proposal rate, coordination info used, tokens per useful briefing).
- **Critical synthesis trade-off evaluation:** Explicitly evaluate whether the closed `rationaleCode` vocabulary and deterministic host rendering improve factual integrity **at the cost of useful operator synthesis**. A higher publication rate alone is **not** sufficient evidence of improved intelligence.
- Do not infer exact hidden reasoning tokens from visible answer length.
- Conduct anonymized / condition-blinded evaluation via a separate read-only evaluator subagent (documenting blinding limits, since deterministic `Verified facts` formatting distinguishes `grounded-v1` from `legacy-v0` prose).
- Classify each research dimension honestly (`supported` / `inconclusive` / `not supported`; Phase D: `ready` / `conditional` / `blocked`).
