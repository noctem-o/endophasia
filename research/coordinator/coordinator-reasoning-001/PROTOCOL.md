# Experimental Protocol — `COORDINATOR-REASONING-001`

## 1. Experimental Hypothesis & Causal Isolation

**Primary Question:** Was the `0/16` grounded-v1 publication rate in `S2-LIVE-002` caused primarily by the `2,048`-token completion ceiling starving Inkling-2-Mini's reasoning, or does Inkling-2-Mini fail grounded-v1 cognition even when given ample governed cognitive resources?

### §9 Frozen Architecture (Single Independent Variable)

To isolate cognitive resource allocation cleanly, **nothing** in the grounded cognition architecture is altered from PR #193 (`efd8599cd`):

- **Condition:** Condition C only (`briefingMode: "grounded-v1"`, `visibilityMode: "status-and-coordination-v1"`).
- **Schemas:** `endo.coordinator-grounded-brief.v1` and `endo.coordinator-model-view.v1` unchanged.
- **Prompts:**
  - `ENDO_COORDINATOR_GROUNDED_INSTRUCTIONS_V1` SHA-256: `c50ada62528e0fe0b96c18cefa9bf2bddd7ed0da5db54e575508bd9cb23b6ecc`
  - `ENDO_ADVISORY_GROUNDED_PROPOSAL_QUESTION_V1` SHA-256: `1cbdd8ea2f6c18f9c979ec431d9ef9781e807dffae599c2759089939b07cc53d`
- **Closed Vocabulary & Validator:** Closed `rationaleCode` enum and subject-scoped validator unchanged.
- **Deterministic Sampling:** `temperature: 0`, `top_k: 1`, `top_p: 1`, `min_p: 0`, `seed: 101` (enforced by closed wire allowlist).
- **Reasoning Control during Competence Phases (B/C/D):** `reasoningControl: { mode: "unchanged" }` (no `reasoning_effort` or `reasoning_budget_tokens` overrides).
- **Output & Authority Ceilings:** `maxAnswerBytes = 4096`, `completionRequestsPerTurn = 2`, `advisoryOnly = true`, `authority.grants = "none"`.

---

## 2. Scenarios (Preserved Verbatim from `S2-LIVE-002`)

1. **`S5-W8-mixed-head`** (`wake: on-change`, `actionKind: emit-operator-proposal`):
   - Two tasks: `T1` (`in-progress`, `no-checks`, complete receipt read, active builder assignment) and `T2` (`awaiting-review`, `not-current` after commit advance following a failing check, gap `earlier-failure-not-current`).
   - Tests whether the Coordinator preserves mixed-verification distinction (task-scoped `no-checks` vs historical failure `not-current`) and recommends inspecting incomplete/non-current verification without false contradictions.
2. **`S8-multi-agent`** (`wake: on-change`, `actionKind: emit-operator-proposal`):
   - Full multi-agent coordination state: `T1` (`in-progress`, `no-checks`, ended prior builder with `liveness-unverified` hazard + new active builder with `allowSharedWorktree: true` creating a real `worktree-write-conflict` + git-commit candidate `C1` without passing receipt) and `T2` (`awaiting-review`, active reviewer targeting `C1` in a registered sibling worktree, unsatisfied dependency `T2 -> T1 (candidate-has-passing-receipt)`, and `changes-requested` advisory review on `C1`).
   - Tests whether the Coordinator synthesizes multi-entity relational coordination evidence (conflict + liveness hazard + unsatisfied dependency + advisory review) into accurate grounded claims, uncertainties, recommendations, and an eligible operator proposal.

---

## 3. Staged Execution Plan & Stop Rules

| Phase | Scope | Max Live Turns | Max Reserved Tokens | Authorization Status |
|---|---|---|---|---|
| **Phase A** | Implementation, adversarial review (`F1`–`F10`), acceptance suite, zero-inference preflight, 9-cell installed-OpenClaw fake-provider dry run | **0** | **0** | **Executed in Phase A** |
| **Phase B** | Competence probe: `S5` + `S8` under **`R3` (`deep`, `max_tokens = 16,384`, `reasoningControl = unchanged`)** | **2** | **65,536** | **Awaiting operator approval** |
| **Phase C** | Threshold characterization: `S5` + `S8` under **`R1` (`light`, `4,096`)** and **`R2` (`deliberate`, `8,192`)** | **4** | **49,152** | **Awaiting operator approval** |
| **Phase D (Optional R4)** | Extended fallback: `S5` + `S8` under **`R4` (`extended`, `24,576`)** | **2** | **98,304** | **Conditional ONLY on R3 exhausting reasoning** |

### Predefined Stop Rules
1. **R3 Competence Gate (after Phase B):**
   - If **both S5 and S8 publish valid grounded-v1 briefings under R3**: proceed to Phase C (`R1` + `R2`) to map the minimum competent token threshold. Do **not** run `R4`.
   - If **either S5 or S8 fails under R3 with `reasoning-budget-exhausted`**: stop before Phase C and request operator decision on the optional `R4` (`24,576`) fallback.
   - If **S5 or S8 completes visible output under R3 (`finish_reason: "stop"`) but fails grounding validation (`grounding-*`)**: record the exact structural/grounding failure class honestly; do **not** run `R4` (more tokens will not fix a schema/grounding misunderstanding) and evaluate whether Phase C adds value.
2. **Operational Safety:**
   - Every live run executes sequentially under an exclusive operator-local `flock` lock (`ENDO_REASONING_001_LOCKED=1`).
   - Every turn writes a durable `turn-intent` before execution and `turn-result` after execution to `observations/live-ledger.jsonl` with `fsync`.
   - Already-attempted or uncertain cells are **never retried**.
   - Hard aggregate turn ceiling of `8` turns across all phases and restarts.

---

## 4. Deterministic Evaluation Baselines (§12)

Every published live Coordinator briefing will be compared directly against **three zero-token deterministic baselines** computed over the exact same model-visible snapshot:

1. **Deterministic Status Summary (`status-v0`):** Task phases, verification states, gaps, and source readiness.
2. **Deterministic Relational Coordination Projection (`coordination-v0`):** Assignments, hazards, dependencies, candidates, worktrees, conflicts, and advisory reviews.
3. **Deterministic Static Priority Ruleset (`staticPriorityBaseline` in `run-reasoning-001.mjs`):**
   Fixed deterministic ranking without inference:
   - Priority 1: `resolve-worktree-conflict` (active worktree conflict)
   - Priority 2: `investigate-liveness-hazard` (`liveness-unverified`) & `review-failing-verification` (`failing` at HEAD)
   - Priority 3: `resolve-unsatisfied-dependency` (`unsatisfied` dependency)
   - Priority 4: `inspect-advisory-review` (`changes-requested` review)
   - Priority 5: `investigate-incomplete-verification` (`not-current` or `incomplete` verification)
   - Priority 6: `review-awaiting-review` (`awaiting-review` task)

For a live Coordinator briefing to demonstrate **advisory intelligence value**, it must not merely pass validation — it must add genuine multi-signal synthesis, honest uncertainty articulation, or prioritization clarity beyond what these three deterministic projections already provide at zero tokens.

---

## 5. Separate Follow-Up Design: Reasoning-Control Efficiency Study (§13)

**Strictly deferred until Phase B/C establishes baseline competence at `reasoningControl: "unchanged"`.**

Once a competent baseline tier (e.g., `R2` or `R3`) is empirically confirmed:
- Evaluate `reasoningControl: { mode: "reasoning-effort", effort: "low" }` and `{ mode: "reasoning-effort", effort: "medium" }` on `S5` and `S8` at the same `max_tokens` ceiling.
- Optionally evaluate positive `reasoningControl: { mode: "reasoning-budget-tokens", tokens: <N> }` (strictly `1 <= N <= max_tokens - 256`, never `0`).
- **Never** evaluate `reasoning_effort: "none"` (silently reverts to `high` on `llama.cpp b12622` + Inkling) or `reasoning_budget_tokens: 0` (triggers Inkling's infinite thinking-tag loop).
- Compare grounding pass rate, recommendation quality, completion tokens, and wall-clock latency against the `unchanged` baseline.
