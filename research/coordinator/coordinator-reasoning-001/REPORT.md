# `COORDINATOR-REASONING-001` — Phase A Research & Engineering Report

**Mission:** Establish Local Coordinator Competence Through Governed Cognitive Resource Allocation  
**Branch:** `research/coordinator-reasoning-001` (stacked on PR #193 `feat/coordinator-grounding-002` @ `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`)  
**Status:** **Phase A COMPLETE (Zero Live Inference Executed)** — Ready for Explicit Phase B / Phase C Live-Inference Authorization

---

## 1. Executive Summary

`S2-LIVE-002` (PR #193) proved that the subject-scoped grounding architecture (`endo.coordinator-grounded-brief.v1` + `endo.coordinator-model-view.v1`) functions mechanically, but all `16/16` live grounded-v1 turns hit the `2,048`-token completion ceiling inside Inkling-2-Mini's internal reasoning before emitting visible JSON.

In Phase A of `COORDINATOR-REASONING-001`, we:

1. **Audited every resource ceiling end-to-end** across protocol schemas, S2 budgets/leases, OpenClaw provider configuration (`contextWindow`), subprocess execution (`maxBuffer`), protected model relay (`maxTransferredBytes`), and wire gates, plus passively audited `llama.cpp b12622` and Inkling-2-Mini's GGUF Jinja chat template with zero live inference.
2. **Implemented `endo.coordinator-resource-policy.v1`** as an explicit, closed, versioned, opt-in governed resource policy (`reflex: 0`, `light: 4,096`, `deliberate: 8,192`, `deep: 16,384`, `extended: 24,576`) preserving 100% V0 backwards compatibility (`<= 2,048` tokens, `<= 135 s` member timeout, `<= 240 s` turn timeout, `<= 300 s` lease) and S1 non-interference.
3. **Implemented structured termination diagnostics (`endo.coordinator-brief-diagnostics.v1`)** distinguishing `reasoning-budget-exhausted`, `generation-limit`, `inference-timeout`, `unsupported-reasoning-control`, and `runtime-unavailable` while guaranteeing zero raw reasoning text is stored (`rawReasoningStored: false`).
4. **Preserved the §9 cognition architecture freeze untouched**: zero edits to `grounded-v1` schemas, prompts (`c50ada62...` / `1cbdd8ea...`), closed `rationaleCode`, validator, deterministic sampling (`temp=0, top_k=1, top_p=1, min_p=0, seed=101`), or `maxAnswerBytes = 4096`.
5. **Completed an independent read-only adversarial review (`ADVERSARIAL-REVIEW.md`)** that surfaced 10 substantiated findings (`0 CRITICAL`, `3 HIGH`, `5 MEDIUM`, `2 LOW`: `F1`–`F10`), remediated all 10 (including upgrading `wire.ts` to a closed top-level request allowlist, fixing Phase A→C lease TOCTOU, fixing S2 `inference-timeout` classification, making `publicationReserveMs` usable across Phase G+H, and replacing `execFile` with `spawn` to avoid 512 KiB stdout `maxBuffer` kills), and verified all 20 tests in `tests/coordinator-reasoning-001.test.ts` + 204 existing M1/S2/grounding tests with installed `OpenClaw 2026.11.10`.
6. **Verified the reproducible experimental harness (`scripts/run-reasoning-001.mjs`)** via `--preflight` and a 9-cell installed-OpenClaw fake-provider `--dry-run` (`observations/preflight-manifest.json`, `observations/dry-run-fake-provider.jsonl`) with **zero contact with `http://127.0.0.1:8091`**.

---

## 2. §18 Evidence-Backed Claim Classifications (Phase A Boundary)

| Claim Area | Classification | Honest Evidence Summary |
|---|---|---|
| **1. Governed cognitive resource policy mechanism** | **`supported`** | Proven by protocol/runtime/storage/CLI/relay/OpenClaw implementation, 10/10 remediated adversarial findings (`F1`–`F10`), 20/20 tests in `tests/coordinator-reasoning-001.test.ts`, 204/204 existing M1/S2/grounding tests, and 9/9 installed-OpenClaw `2026.11.10` fake-provider dry-run cells verifying exact `4,096 / 8,192 / 16,384 / 24,576` wire enforcement and refusal of unauthorized ceilings. |
| **2. Completion-budget limitation hypothesis (`R0` -> `R3`)** | **`inconclusive`** | Phase A intentionally performed zero live inference. Historical `S2-LIVE-002` data confirms `0/16` grounded-v1 turns escaped the 2,048-token ceiling, but live Phase B (`R3 = 16,384`) has not yet run. |
| **3. Live local grounded-v1 competence (`Inkling-2-Mini`)** | **`inconclusive`** | Awaiting authorized live Phase B (`S5`, `S8` under `R3 = 16,384`) and Phase C (`R1 = 4,096`, `R2 = 8,192`). |
| **4. Advisory intelligence value beyond deterministic rules** | **`inconclusive`** | Deterministic status, relational coordination, and static priority ruleset baselines are computed (`observations/preflight-manifest.json`), but live model briefings have not yet been generated for comparison. |
| **5. Reasoning-control efficiency improvement (`reasoning_effort` / `reasoning_budget_tokens`)** | **`inconclusive`** | Passive audit confirmed `llama.cpp b12622` + Inkling template behavior (`"none"` broken, `0` loops, `"low"`/`"medium"` & positive budgets supported); live Coordinator efficiency testing is strictly deferred until baseline competence is established (§13). |
| **6. 24-hour naturalistic deployment readiness** | **`blocked`** | Blocked on (a) establishing live competence in Phases B/C, (b) demonstrating value beyond deterministic baselines, and (c) addressing the shared unrenewed long-lease trade-off (`840–1,200 s` lease vs `600 s` `defaultOnTimeGraceMs`) before unattended multi-schedule operation. |

---

## 3. Package Inventory

- [RESOURCE-POLICY-DESIGN.md](./RESOURCE-POLICY-DESIGN.md) — End-to-end limit audit, tier definitions, deadline/lease/transfer invariants, and abandoned-lease analysis.
- [REASONING-CONTROL-CAPABILITIES.md](./REASONING-CONTROL-CAPABILITIES.md) — Passive audit of `llama.cpp b12622`, Inkling-2-Mini GGUF Jinja template, and `REASONING-BUDGET-001` evidence.
- [PROTOCOL.md](./PROTOCOL.md) — Staged Phase A/B/C/D protocol, §9 freeze, §12 deterministic baselines, stop rules, and deferred §13 optimization design.
- [ADVERSARIAL-REVIEW.md](./ADVERSARIAL-REVIEW.md) — Independent read-only review findings (`F1`–`F10`, `N1`–`N2`), remediations, and regression tests.
- [COMPARATIVE-EVALUATION.md](./COMPARATIVE-EVALUATION.md) — `R0` historical baseline, deterministic baselines, 9-cell OpenClaw fake-provider dry-run table, and unexecuted live Phase B/C/D templates.
- [config/experiment-pin.json](./config/experiment-pin.json) — Pinned commit SHAs, frozen prompt digests, and exact tier ceilings.
- [scripts/run-reasoning-001.mjs](./scripts/run-reasoning-001.mjs) — Reproducible `--preflight`, `--dry-run`, and gated `flock` + append-only ledger live runner.
- [observations/preflight-manifest.json](./observations/preflight-manifest.json) — Zero-inference preflight manifest.
- [observations/dry-run-fake-provider.jsonl](./observations/dry-run-fake-provider.jsonl) — 9-cell installed-OpenClaw fake-provider dry-run ledger.

---

## 4. Phase B / Phase C Live-Inference Authorization Request

Phase A has stopped cleanly before any live inference. To proceed, explicit operator authorization is requested for:

- **Target Model & Endpoint:** `Inkling-2-Mini-Uncensored-AD-Q4_K` at `http://127.0.0.1:8091` (`llama.cpp b12622`, already running; runner will not stop, restart, or reconfigure it).
- **Harness & Isolation:** Installed `OpenClaw 2026.11.10` inside `/usr/bin/bwrap` + protected model relay + exclusive operator-local `flock` + isolated temporary stores + zero operational authority (`advisoryOnly: true`, `authority.grants: "none"`).
- **Frozen Architecture:** Condition C (`grounded-v1` + `status-and-coordination-v1`), `reasoningControl: "unchanged"`, `temperature=0, top_k=1, top_p=1, min_p=0, seed=101`, `maxAnswerBytes = 4096`.
- **Phase B (Competence Probe — `R3 deep`):**
  - Scenarios: `S5-W8-mixed-head`, `S8-multi-agent`
  - Turns: **2** live advisory turns (max `2` completion requests/turn)
  - Per-request ceiling: `16,384` tokens (`32,768` reserved/turn; **65,536** max reserved across Phase B)
  - Deadlines: `720 s` member timeout, `780 s` turn deadline, `60 s` publication reserve, `840 s` advisory lease, `32 MiB` relay transfer cap
  - Estimated wall clock: `~4–12` minutes total
- **Phase C (Threshold Characterization — `R1 light` & `R2 deliberate`, conditional on Phase B competence):**
  - Scenarios: `S5-W8-mixed-head`, `S8-multi-agent` across `R1` (`4,096` tokens, `360s/420s/480s`, `16 MiB`) and `R2` (`8,192` tokens, `480s/540s/600s`, `24 MiB`)
  - Turns: **4** live advisory turns (**49,152** max reserved across Phase C)
  - Combined Phase B + C ceiling: **6** live turns, **114,688** max reserved tokens
- **Optional Phase D Fallback (`R4 extended`, ONLY if `R3` hits `reasoning-budget-exhausted`):**
  - Scenarios: `S5-W8-mixed-head`, `S8-multi-agent` under `R4` (`24,576` tokens, `1,080s/1,140s/1,200s`, `48 MiB`)
  - Turns: **2** live advisory turns (**98,304** max reserved tokens) — requires explicit confirmation or pre-authorization
- **Side Effects & Boundaries:** Zero writes to operator repos, zero changes to PR #192 or PR #193, zero systemd/service mutations, zero retries on uncertain/attempted cells, raw reasoning traces never persisted.
