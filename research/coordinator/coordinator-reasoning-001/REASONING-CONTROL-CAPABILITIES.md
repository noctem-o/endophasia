# Local Inference & Reasoning-Control Capability Audit (`COORDINATOR-REASONING-001`)

All findings in this document were obtained through **passive local inspection** (installed `llama.cpp` C++ server source, GGUF chat-template metadata, and prior recorded evidence in `REASONING-BUDGET-001`) with **zero live completion requests** sent to `http://127.0.0.1:8091`.

---

## 1. Audited Local Stack Identity

| Component | Verified Value | Inspection Basis |
|---|---|---|
| Local Endpoint | `http://127.0.0.1:8091` | Configured local loopback server (not contacted for inference) |
| Model Identity | `Inkling-2-Mini-Uncensored-AD-Q4_K` | GGUF metadata (`general.architecture = "inkling2_loop"`, `context_length = 1,048,576`) |
| Inference Server | `llama.cpp b12622` | Local source tree (`tools/server/server-schema.cpp`, `tools/server/server-common.cpp`) |
| Coordinator Harness | `OpenClaw 2026.11.10` | Installed package metadata + sandboxed fake-provider verification |
| Observed RTX 4090 Throughput | `~56–58 tok/s` | Prior local empirical measurements (`S2-LIVE-001`, `S2-LIVE-002`, `REASONING-BUDGET-001`) |

---

## 2. How `llama.cpp b12622` Handles Completion & Reasoning Parameters

### 2.1 Shared Completion Counter (`max_tokens` / `max_completion_tokens` / `n_predict`)
- In `tools/server/server-schema.cpp:48`, `max_tokens` and `max_completion_tokens` both alias `n_predict`.
- `llama.cpp` charges **reasoning tokens (`reasoning_content`), visible text (`content`), and `tool_calls`** against this single shared `n_predict` counter.
- There is **no separate server-side visible-answer token cap**. Consequently, `endo.coordinator-resource-policy.v1` marks `desiredVisibleAnswerTokens` with `desiredVisibleAnswerTokensAdvisoryOnly: true` and enforces final visible size deterministically on the host via `maxAnswerBytes = 4096`.

### 2.2 `reasoning_effort` vs Inkling-2-Mini's GGUF Chat Template
- Inkling-2-Mini's embedded Jinja chat template maps `reasoning_effort` via:
  `effort_map = {"none": 0.0, "minimal": 0.1, "low": 0.2, "medium": 0.7, "high": 0.9, "xhigh": 0.99, "max": 0.99}`
  and defaults an omitted `reasoning_effort` to **`0.9` (`high`)**!
- **Verified Bug with `reasoning_effort: "none"` on `llama.cpp b12622` + Inkling:**
  In `tools/server/server-common.cpp:1644-1646`, when the request passes `reasoning_effort: "none"`, `llama.cpp` sets `enable_thinking = false` and **erases `reasoning_effort`** from `chat_template_kwargs`. Because Inkling's Jinja template ignores `enable_thinking` and reads only `reasoning_effort`, omitting it causes Inkling to **silently revert to its default `0.9` (`high`)**!
- **Verified Working Levels (`"minimal"`, `"low"`, `"medium"`, `"high"`):**
  In `tools/server/server-common.cpp:1653`, non-`"none"` values are forwarded intact into `chat_template_kwargs`. Prior `REASONING-BUDGET-001` experiments measured `reasoning_effort: "low"` (`0.2`) reducing completion tokens by ~52% on a math reasoning probe while preserving accuracy.
- **Policy Enforcement:** `validateEndoCoordinatorReasoningControlV1` explicitly **excludes `"none"`** from `ENDO_COORDINATOR_REASONING_EFFORT_LEVELS_V1` (`["minimal", "low", "medium", "high"]`) so an operator cannot configure a silently broken `"none"` override.

### 2.3 `reasoning_budget_tokens` (Sampler-Layer Thinking Budget)
- In `tools/server/server-common.cpp:1668-1680`, `llama.cpp` accepts `reasoning_budget_tokens` and enforces it at the sampler layer by injecting the end-of-thinking boundary once the budget is reached.
- **Verified Failure Mode at `reasoning_budget_tokens: 0` on Inkling:**
  Prior `REASONING-BUDGET-001` testing demonstrated that `reasoning_budget_tokens: 0` causes Inkling-2-Mini to enter an infinite `<|message_model|><|content_thinking|><|end_message|>` tag loop until hitting `finish_reason: "length"`.
- **Verified Working Positive Budgets (`1 <= tokens <= maxOutputTokensPerRequest - 256`):**
  Positive `reasoning_budget_tokens` cleanly force-closes thinking and transitions into visible answer generation (`finish_reason: "stop"`), though overly tight caps can degrade reasoning quality.
- **Policy Enforcement:** `validateEndoCoordinatorReasoningControlV1` strictly rejects `tokens <= 0` and requires at least `256` tokens of visible-answer headroom (`tokens <= maxOutputTokens - 256`), enforced across resource profiles, V1 pool members, S2 budgets, and model targets (F7).

---

## 3. Telemetry & Diagnostic Capabilities

| Signal | Observed Availability on `llama.cpp b12622` | Endophasia Handling (`COORDINATOR-REASONING-001`) |
|---|---|---|
| `delta.reasoning_content` / `delta.reasoning` | Present during thinking SSE chunks | Counted (`sawReasoning`, `reasoningChars`); **raw reasoning text is NEVER stored** (`rawReasoningStored: false`). |
| `delta.content` | Present during visible output SSE chunks | Counted (`sawVisibleContent`, `visibleChars`) and validated by `grounded-v1` or `legacy-v0`. |
| `finish_reason` | `"stop"`, `"length"`, `"tool_calls"` | Sanitized to bounded safe token (F6). `finish === "length" && sawReasoning && !sawVisibleContent && !toolCalled` classifies as `"reasoning-budget-exhausted"`. |
| `usage.prompt_tokens` / `usage.completion_tokens` | Reported on final SSE chunk (`stream_options.include_usage`) | Recorded verbatim; missing usage on any exchange charges full reservation. |
| `usage.completion_tokens_details.reasoning_tokens` | Optional / backend-dependent | Recorded **only** when reported as a non-negative integer; otherwise strictly `null` (never estimated). |
| Unsupported control HTTP 400/422 | Server error JSON in HTTP body | Detected narrowly from HTTP response body when control was sent and body names `reasoning_effort` / `reasoning_budget_tokens` or reasoning-control rejection (F6). |

---

## 4. Wall-Clock Projections for Planned Live Phases

At Inkling-2-Mini's historically measured `~56 tok/s` local decode throughput on RTX 4090:

| Condition | Tier | `max_tokens` | Est. Max Decode Time (1 Full Exchange) | Member Timeout | Turn Deadline | Lease TTL |
|---|---|---|---|---|---|---|
| `R0` (historical) | V0 | `2,048` | ~37 s | `135 s` | `180 s` | `300 s` |
| `R1` (Phase C) | `light` | `4,096` | ~73 s | `360 s` | `420 s` | `480 s` |
| `R2` (Phase C) | `deliberate` | `8,192` | ~146 s | `480 s` | `540 s` | `600 s` |
| `R3` (Phase B) | `deep` | `16,384` | ~293 s (~4.9 min) | `720 s` (12 min) | `780 s` (13 min) | `840 s` (14 min) |
| `R4` (Optional D) | `extended` | `24,576` | ~439 s (~7.3 min) | `1,080 s` (18 min) | `1,140 s` (19 min) | `1,200 s` (20 min) |

Every tier provides >= 2.2x wall-clock safety margin over worst-case single-exchange decode time plus a dedicated `60 s` publication reserve (`publicationReserveMs`) for Phase G re-observation and Phase H publication.
