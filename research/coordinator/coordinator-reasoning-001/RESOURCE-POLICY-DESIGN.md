# Governed Cognitive Resource Policy Design (`COORDINATOR-REASONING-001`)

## 1. Motivation & Guiding Principle

**Establish competence before optimizing efficiency.**

In `S2-LIVE-002` (PR #193, `efd8599cd`), all 16 live grounded-v1 turns (`8` Condition B, `8` Condition C) failed to emit visible output because `Inkling-2-Mini-Uncensored-AD-Q4_K` spent the entire `2,048`-token completion ceiling inside internal reasoning (`reasoning_content`), ending with `finish_reason: "length"` and empty visible `content`.

The Coordinator operates asynchronously and does not share interactive chat latency requirements. Rather than loosening existing V0 safety defaults or altering grounded-v1 validation, `COORDINATOR-REASONING-001` introduces an **explicit, opt-in, closed, versioned cognitive resource policy** (`endo.coordinator-resource-policy.v1`) that governs compute, wall-clock deadlines, advisory leases, context declarations, and relay transfer caps cleanly across all layers.

---

## 2. End-to-End Resource Limit Audit

Every layer in the inference path was audited before implementation:

| Layer | File | Pre-existing V0 Limit | Governed V1 Behavior (Opt-In Only) |
|---|---|---|---|
| Model Pool Schema | `protocol/coordinator-model-pool.ts` | `maxOutputTokens: 256..2048`, `timeoutMs: 5_000..135_000` | `endo.coordinator-model-pool.v0` **unchanged**. Opt-in `endo.coordinator-model-pool.v1` embeds `resourceProfile` and bounds every member by `resourceProfile.maxOutputTokensPerRequest` and `resourceProfile.modelExecutionTimeoutMs`. |
| S2 Budget & Auth | `protocol/develop-advisory.ts`, `runtime/contracts/develop-advisory.ts` | `maxOutputTokensPerRequest <= 2048`, `maxTurnWallClockMs <= 240_000`, `maxGeneratedTokensPerPeriod <= 96 * 2 * 2048` | V0 grants without `resourceProfile` keep **exact V0 limits and exact V0 `authorizationId` digest**. Grants with `resourceProfile` + `resourceProfileSha256` bind the profile digest into `authorizationId` and enforce profile ceilings. |
| S1 Automation Lease | `protocol/develop-automation.ts`, `storage/develop-automation.ts` | `maxLeaseTtlMs = 300_000` | **Untouched** (`<= 300_000` ms). S1 remains zero-token. |
| S2 Advisory Lease | `protocol/develop-advisory.ts`, `storage/develop-advisory.ts`, `adapters/develop/advisory-tick.ts` | Shared S1 validator (`<= 300_000` ms), hardcoded `L.leaseTtlMs` | Dedicated `validateEndoAdvisoryLeaseV0` (`<= 1_200_000` ms) for S2 `advisory/lease.json` only. Phase A acquires `resourceProfile.advisoryLeaseTtlMs` **only** for a standing V1 grant (defaulting to `300_000` ms for V0) and fences exact TTL match in Phase C/E (F1). |
| Advisory Turn Admission / Dispatch / Briefing | `protocol/develop-advisory.ts`, `storage/develop-advisory.ts` | `generatedTokens <= 4096`, `wallClockMs <= 300_000`, `effectiveTimeoutMs <= 240_000` | Records **without** `resourceProfileSha256` keep strict V0 bounds. Records **with** `resourceProfileSha256` permit governed V1 bounds (`<= 49_152` reserved tokens, `<= 1_140_000` ms timeout, `<= 1_200_000` ms lease) and enforce cross-record `resourceProfileSha256` equality in `listTurns()`. |
| OpenClaw Provider Config | `adapters/coordinator/openclaw.ts` | Hardcoded `contextWindow: 32_768` | Uses `target.contextWindowTokens ?? 32_768` (`65_536` for `deep`, `131_072` for `extended`) so prompt + output never trips client-side context guards. |
| OpenClaw Subprocess Execution | `adapters/coordinator/openclaw.ts` | `execFile` with `maxBuffer: 512 * 1024` | Replaced with `spawn(..., { stdio: ["ignore", "ignore", "pipe"] })` with bounded 8 KiB stderr capture and explicit `SIGKILL` timer (F8), preventing discarded `--json` stdout from killing valid 24k-token runs. |
| Protected Model Relay | `adapters/coordinator/model-relay.ts` | Hardcoded `maxTransferredBytes: 8 MiB` | Scales by tier (`16–48 MiB`, hard ceiling `48 MiB`) to fit 2x SSE responses (~320 B/token on `llama.cpp`) while keeping `maxExchanges: 2`, `maxRequestBytes: 512 KiB`, and `maxAnswerBytes: 4096` unchanged. |
| Wire Request Gate | `adapters/coordinator/wire.ts` | Checked exact `inference` keys + blocked `n_predict`, `max_completion_tokens` | Upgraded to a **closed top-level request allowlist** (F3): permits only `model`, `messages`, `tools`, `stream`, `stream_options` (`{ include_usage?: boolean }`), `store: false`, `tool_choice: "auto"`, plus exact authorized `inference` keys. |
| Final Published Answer | `protocol/develop-advisory.ts`, `runtime/contracts/coordinator-grounding.ts`, `adapters/coordinator/openclaw.ts` | `maxAnswerBytes = 4096` (S2 & `grounded-v1`) | Enforced uniformly at `4,096` bytes across S2, `grounded-v1`, and `legacy-v0` (F5), regardless of reasoning/completion budget. |

---

## 3. Conceptual Cognitive Resource Tiers (`endo.coordinator-resource-policy.v1`)

| Tier | Inference Allowed | `maxOutputTokensPerRequest` | Reserved / Turn (`2x`) | `contextWindowTokens` (Preset) | `modelExecutionTimeoutMs` (Preset / Ceiling) | `advisoryTurnDeadlineMs` (Preset / Ceiling) | `publicationReserveMs` (Preset / Floor) | `advisoryLeaseTtlMs` (Preset / Ceiling) | `relayMaxTransferredBytes` (Preset / Ceiling) | `maxAnswerBytes` |
|---|---|---|---|---|---|---|---|---|---|---|
| `reflex` | **No** (0 tokens) | `0` | `0` | `0` | `0` / `0` | `0` / `0` | `0` / `0` | `0` / `0` | `0` / `0` | `4,096` |
| `light` | Yes | `4,096` | `8,192` | `32,768` | `360 s` / `720 s` | `420 s` / `780 s` | `60 s` / `20 s` | `480 s` / `840 s` | `16 MiB` / `16 MiB` | `4,096` |
| `deliberate` | Yes | `8,192` | `16,384` | `32,768` | `480 s` / `720 s` | `540 s` / `780 s` | `60 s` / `20 s` | `600 s` / `840 s` | `24 MiB` / `24 MiB` | `4,096` |
| `deep` | Yes | `16,384` | `32,768` | `65,536` | `720 s` / `720 s` | `780 s` / `780 s` | `60 s` / `20 s` | `840 s` / `840 s` | `32 MiB` / `32 MiB` | `4,096` |
| `extended` | Yes | `24,576` | `49,152` | `131,072` | `1,080 s` / `1,080 s` | `1,140 s` / `1,140 s` | `60 s` / `20 s` | `1,200 s` / `1,200 s` | `48 MiB` / `48 MiB` | `4,096` |

### Mandatory Schema Ordering Invariants

For every inference-capable tier (`light`, `deliberate`, `deep`, `extended`), `validateEndoCoordinatorResourceProfileV1` enforces:

1. `contextWindowTokens >= maxOutputTokensPerRequest + 8,192`
2. `5,000 <= modelExecutionTimeoutMs <= advisoryTurnDeadlineMs <= tier.maxTurnWallClockMs`
3. `20,000 <= publicationReserveMs <= 120,000`
4. `advisoryTurnDeadlineMs + publicationReserveMs <= advisoryLeaseTtlMs <= tier.maxLeaseTtlMs`
5. `maxAggregateGeneratedTokensPerTurn === 2 * maxOutputTokensPerRequest`
6. `desiredVisibleAnswerTokensAdvisoryOnly === true` (explicitly distinguishes desired visible length from server-enforced shared completion budgets)
7. `maxAnswerBytes === 4096`
8. `reflex` is refused by `parseEndoCoordinatorModelPoolV1`, `validateEndoAdvisoryBudgetV0`, `validateEndoAdvisoryAuthorizationV0`, and `coordinatorTargetFromMemberV0` — guaranteeing `reflex` can never authorize inference.

---

## 4. Deadline, Lease Fencing, Accounting & Abandoned-Lease Analysis

### Deadline Alignment
- **Phase A (Claim):** Acquires `advisory/lease.json` with `leaseTtlMs = standing.authorization.resourceProfile.advisoryLeaseTtlMs` (or `300,000` ms if V0/unauthorized). If `claimed === null`, the lease is released inside the **same** `automation.lock` critical section (F1).
- **Phase C (Admit):** Fences `activeLeaseTtlMs === authorizedLeaseTtlMs` so an out-of-band V1→V0 downgrade or V0→V1 upgrade between Phase A and Phase C refuses cleanly as `refused-insufficient-lease` (F1). Computes `turnDeadlineMs` from `min(budget.maxTurnWallClockMs, resourceProfile.advisoryTurnDeadlineMs, lease.expiresAtMs - publicationReserveMs)` and writes the durable admission reservation before any model contact.
- **Phase D.5 (Local Preflight):** Verifies OpenClaw version, `bwrap`, `XDG_RUNTIME_DIR`, prompt/status sizes, and reasoning-control validity **before** Phase E links `dispatched.json`, guaranteeing 0 token charge on local configuration errors.
- **Phase E (Dispatch Linearization):** Re-checks lease epoch, lease TTL equality, schedule revision, and `authorizationId`, then computes `effectiveTimeoutMs <= min(member.timeoutMs, remainingTurnDeadline, remainingLeaseMinusPublicationReserve)` and links `dispatched.json`.
- **Phase F (Inference):** Executes against the single selected member with `target.hostDeadline = true` and `target.timeoutMs = remainingInferenceMs` (no competing `options.signal` timer, ensuring timeouts classify as `inference-timeout`, F2). Records `inferenceWithinTurnDeadline` immediately after inference finishes so Phase G (re-observation) and Phase H (publication) can genuinely use `publicationReserveMs` inside `ownsLease` (F4).
- **Phase H (Publish):** Re-checks `ownsLease`, `inferenceWithinTurnDeadline`, schedule revision, `authorizationId` standing/revocation/expiry, and observation commitment. Any violation withholds the result (`availability: "withheld"`, `answer: null`) while charging confirmed usage (or full reservation if usage is incomplete/missing).

### Abandoned-Lease Operational Trade-Off
Because S2 uses a single store-wide `advisory/lease.json` without background lease renewal:
- Under `deep` (`840 s` lease) or `extended` (`1,200 s` lease), an abrupt `SIGKILL` during inference blocks subsequent advisory ticks in that store until the lease expires (`14–20` minutes), which exceeds the V0 `defaultOnTimeGraceMs` (`600 s`) for co-due `skip-and-report` schedules.
- This trade-off is acceptable for bounded, operator-supervised experimental runs and low-frequency asynchronous advisory schedules. Before any multi-project or 24-hour unattended deployment, a shorter renewable heartbeat lease (e.g., 120 s TTL renewed up to `advisoryLeaseTtlMs`) is recommended.
- S1 automation leases (`develop/automation/lease.json`) remain completely separate and strictly bounded to `<= 300 s`.
