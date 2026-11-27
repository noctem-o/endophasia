# `COORDINATOR-REASONING-001` — Complete Research & Operational Report (Phases A, B & C)

**Mission:** Establish Local Coordinator Competence Through Governed Cognitive Resource Allocation  
**Branch:** `research/coordinator-reasoning-001` (PR #194, stacked on PR #193 `feat/coordinator-grounding-002` @ `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`)  
**Status:** **Phases A, B (`R3 = 16,384`) & C (`R1 = 4,096`, `R2 = 8,192`) COMPLETE** (`6` live turns executed; `R4 = 24,576` skipped per `PROTOCOL.md` §3 stop rule; Phase D naturalistic deployment remains **blocked**).

---

## 1. Executive Summary

`S2-LIVE-002` (PR #193) showed that all `16/16` live grounded-v1 turns on `Inkling-2-Mini-Uncensored-AD-Q4_K` exhausted the `2,048`-token completion ceiling inside internal reasoning before emitting visible JSON. `COORDINATOR-REASONING-001` tested whether raising compute ceilings through a **governed cognitive resource policy** (`endo.coordinator-resource-policy.v1`) — while keeping the entire grounded-v1 cognition architecture strictly frozen (§9) — would establish live local Coordinator competence.

### What We Built & Verified (Phase A)
1. **Governed Cognitive Resource Policy (`endo.coordinator-resource-policy.v1`, commit `4891a680a`):** Explicit, opt-in, closed tiers (`reflex: 0`, `light: 4,096`, `deliberate: 8,192`, `deep: 16,384`, `extended: 24,576`) enforcing strict deadline, lease, context-window, and relay transfer-byte invariants across protocol, storage, S2 tick, OpenClaw, protected relay, and CLI while leaving V0 pools/grants and S1 leases 100% untouched.
2. **Structured Termination Diagnostics (`endo.coordinator-brief-diagnostics.v1`, commit `eabbe7f4f`):** Accurately distinguishes `reasoning-budget-exhausted`, `generation-limit`, `inference-timeout`, `unsupported-reasoning-control`, `grounding-refused`, and `runtime-unavailable` while guaranteeing zero raw reasoning text is stored (`rawReasoningStored: false`).
3. **Independent Adversarial Review & Remediations (`ADVERSARIAL-REVIEW.md`, commit `9724183b4`):** Remediated all 10 substantiated findings (`F1`–`F10`, including closed top-level wire allowlist, Phase A→C lease TOCTOU fencing, S2 `inference-timeout` classification, `publicationReserveMs` usability, and `spawn` stdout-ignore) and verified `224/224` tests with installed `OpenClaw 2026.11.10` + `9/9` fake-provider dry-run cells (`b742f8103`).

### What Live Execution Proved (Phases B & C — 6 Live Turns, `47,077` Charged Tokens, `13.85 min`)
Executing the frozen Condition C (`grounded-v1` + `status-and-coordination-v1`, `reasoningControl: "unchanged"`) against `Inkling-2-Mini-Uncensored-AD-Q4_K` (`http://127.0.0.1:8091`, `llama.cpp b12622-19bc41dbb`) yielded a **decisive two-part empirical result**:

1. **Raising the completion ceiling to `R3 = 16,384` completely eliminated reasoning starvation (`2/2` finished cleanly with `finishReason: "stop"`):**
   - `R0` (`2,048`, S2-LIVE-002): `0/2` escaped internal reasoning.
   - `R1` (`4,096`): `0/2` escaped internal reasoning (`2/2` accurately diagnosed as `reasoning-budget-exhausted`).
   - `R2` (`8,192`): `1/2` escaped (`S5` finished at `8,000` Ex2 tokens with `5,426` visible chars; `S8` hit `reasoning-budget-exhausted` at `8,192` tokens).
   - `R3` (`16,384`): **`2/2` finished cleanly** (`S5`: `13,666` Ex2 tokens, `5,430` visible chars, `231.5 s`; `S8`: `8,602` Ex2 tokens, `6,503` visible chars, `152.8 s`). Because both completed cleanly below `16,384`, `R4` (`24,576`) was skipped per `PROTOCOL.md` §3.
2. **Even with full room to think and finish (`3/3` completed responses across `S5::R2`, `S5::R3`, `S8::R3`), `Inkling-2-Mini` published `0/6` valid grounded-v1 briefings:**
   - **`S5::R2` and `S5::R3`** both passed JSON/schema parsing and were refused by subject-scoped claim verification (**`grounding-claim-unsupported`**).
   - **`S8::R3`** was refused at schema parsing (**`grounding-malformed`**).
   - Every refusal preserved epistemic integrity (`0` ungrounded briefings published, `0` ungrounded proposals emitted, `0` authority violations, `100%` accurate accounting & diagnostics).

**Bottom-line scientific takeaway:** Completion-budget starvation (`2,048`) was a real primary blocker preventing Inkling-2-Mini from emitting visible output, **but removing it was NOT sufficient to establish grounded-v1 competence**. We have now cleanly separated compute starvation from **schema/grounding adherence** as the next true bottleneck for local small-model Coordinator cognition.

---

## 2. §18 Evidence-Backed Claim Classifications (Final — Post Phases B & C)

| Claim Area | Final Classification | Evidence Summary |
|---|---|---|
| **1. Governed cognitive resource policy mechanism** | **`supported`** | Proven across protocol/storage/tick/relay/OpenClaw/CLI implementation, 10/10 remediated adversarial findings (`F1`–`F10`), 224/224 tests with installed `OpenClaw 2026.11.10`, 9/9 fake-provider dry-run cells, and **6/6 live turns** with exact `4,096 / 8,192 / 16,384` wire enforcement, `100%` `usageReportComplete`, zero timeouts, zero lease/accounting defects, and `rawReasoningStored: false`. |
| **2. Completion-budget limitation hypothesis (`R0` -> `R3`)** | **`partially supported`** | `2,048` (`R0`) and `4,096` (`R1`) definitively starved Inkling-2-Mini (`0/2` completed at `R0` and `R1`; `1/2` at `R2`; **`2/2` completed with `finishReason: "stop"` and `5,430–6,503` visible chars at `R3 = 16,384`**). However, unblocking completion did not achieve grounded-v1 publication (`0/3` completed outputs passed validation). |
| **3. Live local grounded-v1 competence (`Inkling-2-Mini`, Condition C)** | **`refuted` (under frozen `grounded-v1` on `Inkling-2-Mini-Uncensored-AD-Q4_K`)** | `0/6` published across `R1`/`R2`/`R3`, including `0/3` among completed `finishReason: "stop"` turns (`S5::R2` and `S5::R3` -> `grounding-claim-unsupported`; `S8::R3` -> `grounding-malformed`). |
| **4. Advisory intelligence value beyond deterministic rules** | **`refuted` / `not demonstrated` (for `Inkling-2-Mini` under frozen `grounded-v1`)** | After `47,077` generated tokens and `13.85` min of GPU inference, `0/6` briefings published; the zero-token deterministic status summary, relational coordination projection, and static priority ruleset (`< 0.1 s`) strictly dominated on both `S5` and `S8`. |
| **5. Reasoning-control efficiency improvement (`reasoning_effort` / `reasoning_budget_tokens`)** | **`inconclusive` (deferred per §13)** | Per the guiding principle ("establish competence before optimizing efficiency"), live reasoning-control sweeps were intentionally not run because baseline `unchanged` competence was not achieved. Passive audit (`REASONING-CONTROL-CAPABILITIES.md`) remains valid for future competent models. |
| **6. 24-hour naturalistic deployment readiness** | **`blocked`** | Blocked on (a) establishing reliable local grounded-v1 competence (`0/6` published on `Inkling-2-Mini`), (b) demonstrating value beyond deterministic baselines, and (c) adding renewable lease heartbeats before unattended multi-schedule operation at `840–1,200 s` ceilings. |

---

## 3. Recommended Next Research Directions

1. **Add bounded, non-text grounding failure telemetry (`groundingFailurePath` / `groundingFailureCode`):** Record *which* schema field or `(subjectKind, predicate, rationaleCode)` failed validation inside `EndoCoordinatorBriefDiagnosticsV1` (zero raw model prose or reasoning) so live `grounding-malformed` and `grounding-claim-unsupported` failures are immediately actionable.
2. **Test whether the bottleneck is model capability vs `grounded-v1` schema complexity:**
   - Compare a stronger local reasoning/structured-output model under the exact same frozen `grounded-v1` + `R3 = 16,384` protocol (`COORDINATOR-MODEL-BENCH-001`), **and/or**
   - Evaluate grammar-constrained / simplified structured-output decoding or a narrower structured schema if `Inkling-2-Mini` specifically is targeted.
3. **Defer reasoning-control efficiency optimization (§13)** (`reasoning_effort: "low" | "medium"` and positive `reasoning_budget_tokens`) until at least one local model achieves reliable live `grounded-v1` competence at `unchanged`.

---

## 4. Package Inventory

- [RESOURCE-POLICY-DESIGN.md](./RESOURCE-POLICY-DESIGN.md) — End-to-end limit audit, tier definitions, deadline/lease/transfer invariants, and abandoned-lease analysis.
- [REASONING-CONTROL-CAPABILITIES.md](./REASONING-CONTROL-CAPABILITIES.md) — Passive audit of `llama.cpp b12622`, Inkling-2-Mini GGUF Jinja template, and `REASONING-BUDGET-001` evidence.
- [PROTOCOL.md](./PROTOCOL.md) — Staged Phase A/B/C/D protocol, §9 freeze, §12 deterministic baselines, stop rules, and deferred §13 optimization design.
- [ADVERSARIAL-REVIEW.md](./ADVERSARIAL-REVIEW.md) — Independent read-only review findings (`F1`–`F10`, `N1`–`N2`), remediations, and regression tests.
- [COMPARATIVE-EVALUATION.md](./COMPARATIVE-EVALUATION.md) — `R0` historical baseline, deterministic baselines, 9-cell fake-provider dry run, and complete 6-turn live Phase B & C results.
- [config/experiment-pin.json](./config/experiment-pin.json) — Pinned commit SHAs, frozen prompt digests, and exact tier ceilings.
- [scripts/run-reasoning-001.mjs](./scripts/run-reasoning-001.mjs) — Reproducible `--preflight`, `--dry-run`, and gated `flock` + append-only ledger live runner.
- [observations/preflight-manifest.json](./observations/preflight-manifest.json) — Zero-inference preflight manifest.
- [observations/dry-run-fake-provider.jsonl](./observations/dry-run-fake-provider.jsonl) — 9-cell installed-OpenClaw fake-provider dry-run ledger.
- [observations/live-ledger.jsonl](./observations/live-ledger.jsonl) — Append-only durable ledger of all 6 live Phase B & C turns (`turn-intent` + `turn-result`).
