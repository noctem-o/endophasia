# Protected-Experiment Research Index

This document indexes the protected model-connected experiment programme carried out on Endophasia's `PI_RUNTIME_V1` sandbox and Pi 1.6.0 harness, closing out the Inkling reasoning-efficiency investigation as durable project knowledge.

For earlier live recordings and harness studies (Pi 1.0.1 / 1.0.4 / 1.5.0, cassette replays, variance/pinning, steering, discriminating tasks, completion cap, evidence eligibility, and `DEVELOP` work-cycle studies), see [`research/README.md`](../research/README.md).

## Programme Status

| Track | Status | Notes |
| :--- | :--- | :--- |
| Protected real-repo & capability disclosure (`PI-RUNTIME-*`) | **Completed** | Capability-consistent system prompt promoted via PR #166 (merged into `main` at `b1e62f0d54c164935368ceb62b41c69dace9cc2a`). |
| Reasoning-efficiency studies (`REASONING-BUDGET-001`, `REASONING-BUDGET-002`, `REASONING-TRANSFER-001`) | **Completed** | Request-control mechanism demonstrated; single-task observations and exploratory cross-task replication recorded across 4 coding tasks and 32 protected trials (4 pilots + 28 randomised block trials). Generalisation to unseen tasks remains unproven. |
| Further reasoning-budget & Inkling-specific research | **Deferred** | Deferred (not blocked or abandoned). Findings are sufficient for current engineering priorities. Upstream [`ggml-org/llama.cpp#32763`](https://github.com/ggml-org/llama.cpp/pull/32763) (`afe77e18fadc2e673c6a6299495a443e17378ce4`) subsequently fixed forwarding explicit `reasoning_effort: "none"` to supporting templates (including Inkling); it does not establish that high-effort truncation, latency, or the observed efficiency disadvantage has changed. |

> **Artifact locality note:** Entries marked **(local artifact)** live in preserved local git worktrees or local experiment-output directories outside this repository's tracked tree. They are recorded here with verified SHA-256 digests for provenance and auditability, not as portable repository links.

---

## Study Overview

| Study ID | Title | Status | Headline Conclusion |
| :--- | :--- | :--- | :--- |
| `REAL-REPO-STAGED` | Protected Real-Repo Staged Validation (PR #165 baseline) | `completed` | 14/14 hidden evaluator pass on staged Endophasia task; surfaced unavailable-command retries and 16,384-token pressure. |
| `PI-RUNTIME-DISCOVERY-001` | Minimal Runtime Command Disclosure | `completed` | **Inconclusive for adoption.** Reduced unavailable-command attempts (6.0 → 2.0/trial) but exposed baseline 3/3 vs disclosed 2/3 and a 16,384-token truncation. |
| `PI-RUNTIME-DISCOVERY-002` | Capability-Consistent Prompting | `completed` | **Capability consistency verified (9/9 checks).** Replaced Pi's conflicting default tool claims with enforced `PI_RUNTIME_V1` inventory; throughput remained inconclusive due to 16,384-token truncations. |
| `PI-RUNTIME-CONSISTENCY-001` | Governed Runtime Capability Disclosure (PR #166) | `completed` (merged) | Promoted opt-in capability-consistent system prompt (`adapters/sandbox/runtime-prompt.ts`) into `main` at `b1e62f0d54c164935368ceb62b41c69dace9cc2a`. |
| `REASONING-BUDGET-001` | Reasoning Truncation, Inference Limits & Agent Reliability | `completed` | **Mechanism demonstrated; raising completion cap not supported.** Default Inkling `reasoning_effort` (`0.9`) drove single-turn exhaustion at 16,384; raising cap to 24,576 caused 600 s timeouts (2/3) with 0/3 trials exceeding 16,384. |
| `REASONING-BUDGET-002` | Explicit Reasoning Effort & Verified Coding Outcomes | `completed` | **Observed single-task efficiency gain (`verify-result-bundle`, n = 2 main / n = 3 pooled).** Explicit `reasoning_effort` (`0.9` → `0.7` → `0.2`) eliminated truncations (pooled pass: high 1/3, medium 3/3, low 3/3) and yielded 5.8×–6.2× useful throughput on that single task. |
| `REASONING-TRANSFER-001` | Cross-Task Generalisation of Reasoning Effort | `completed` | **Exploratory cross-task replication across 3 new tasks (18 trials, n = 2/cell).** Low effort (`0.2`) passed 5/6 (85/86 hidden cases, 0 truncations, 0 timeouts, 6/6 clean exits) vs medium (`0.7`) 4/6 (64/86, 2 truncations, 2 timeouts) and high (`0.9`) 2/6 (42/86, 4 truncations, 2 timeouts, 0/6 clean exits); surfaced one algorithmic miss (`14/15` on `dep-resolver`). Generalisation to unseen tasks remains unproven. |

---

## Completed Reasoning-Efficiency Studies

All three reasoning studies ran on the same local hardware and model endpoint (`Inkling-2-Mini-Uncensored-AD-Q4_K` served via `llama.cpp b12622-19bc41dbb` on `http://127.0.0.1:8091`), Pi 1.6.0, Endophasia's `PI_RUNTIME_V1` sandbox with capability-consistent prompting enabled, and independent hidden evaluators executed outside the sandbox.

Verified Inkling Jinja template mapping (`effort_map`, confirmed via live `/apply-template` probes in `REASONING-BUDGET-001` and `REASONING-TRANSFER-001`):

| Wire `reasoning_effort` setting | Effective Inkling template value |
| :--- | :---: |
| `high` (and omitted default) | `0.9` |
| `medium` | `0.7` |
| `low` | `0.2` |

### Epistemic boundaries across the reasoning programme

- **Confirmed compatibility defect (tested backend):** `llama.cpp b12622` erased OpenAI `reasoning_effort: "none"` (`server-common.cpp:1644-1646`), causing Inkling's Jinja template to revert to its undefined default (`0.9`). Upstream PR [`ggml-org/llama.cpp#32763`](https://github.com/ggml-org/llama.cpp/pull/32763) (merge commit `afe77e18fadc2e673c6a6299495a443e17378ce4`) fixed forwarding `reasoning_effort: "none"` to templates that support it, including Inkling.
- **Observed performance behaviour (tested stack):** High reasoning effort (`0.9`) frequently exhausted the 16,384-token completion limit or the 600 s trial time budget. The upstream `"none"`-forwarding fix does **not** establish that high-effort truncation, high-effort latency, or the observed efficiency disadvantage has been resolved.
- **Unresolved questions:** Generalisation to unseen tasks, transfer to other model families, and whether the observed effort-vs-efficiency relationship changes under another backend build or inference configuration remain untested.

### `REASONING-BUDGET-001` — Reasoning Truncation, Inference Limits and Agent Reliability

- **Research question:** Do the recurring 16,384-token completion truncations in protected Inkling runs arise from model reasoning behaviour, the completion-token ceiling, Pi's request construction, llama.cpp's reasoning handling, or their interaction — and does raising the completion ceiling (`16,384` → `24,576`) improve task reliability?
- **Status & conclusion:** `completed`.
  - **Request-control & truncation mechanism (demonstrated):** Forensic wire-trace inspection and live backend probes showed Pi 1.6.0 omitted `reasoning_effort` in its OpenAI-compatible requests, causing Inkling's Jinja template on the tested `llama.cpp b12622` server to default to `reasoning_effort = 0.9` and spend entire 16,384-token completions inside hidden reasoning before emitting a tool call or edit. Backend probes also confirmed a compatibility defect in `llama.cpp b12622`: OpenAI `reasoning_effort: "none"` was erased (`server-common.cpp:1644-1646`), silently reverting Inkling back to `0.9` (subsequently fixed upstream in [`ggml-org/llama.cpp#32763`](https://github.com/ggml-org/llama.cpp/pull/32763), merge commit `afe77e18fadc2e673c6a6299495a443e17378ce4`), whereas named non-`"none"` effort levels (`low` = `0.2`, `medium` = `0.7`, `high` = `0.9`) and positive reasoning budgets acted as distinct controls.
  - **Reliability from raising cap (`16,384` → `24,576`, observed single-task):** **Inconclusive** (0/3 arm-B trials actually exceeded 16,384 completion tokens).
  - **Efficiency from raising cap (observed single-task):** **Not supported** (2/3 arm-B trials timed out at the 600 s trial limit).
- **Source commit / branch:** `dc78e5a66f16b6c2a0a0e7537888398df07edcd8` on branch `research/reasoning-budget-001` (local worktree, pre-merge PR #166 tip; merged into `main` at `b1e62f0d54c164935368ceb62b41c69dace9cc2a`).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-reasoning-budget/research/protected-eval/reasoning-budget-001/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/reasoning-budget-001/`
- **Verified SHA-256 pins:**
  - `preregistration.json`: `385b7ca8661e0f709e50ab3bc960febd2a276880ca9d75fb4defb431566069fa`
  - `spec-pilot-b-24576.json`: `98b583cf23765700ae9d47bf4f5af856cc31f6f4aaf2784e4cfd18e1e6d012e5`
  - `spec-b1s1-b-24576.json`: `60255c6a322716c8543cce9b581edff2ba1b309a5f9526cd46748acc178daff5`
  - `spec-b1s2-a-16384.json`: `7f4368dc851bc09c028213ca28c988f056a1460ac5c97973478e95d0c808eeed`
  - `spec-b2s1-b-24576.json`: `a95749c1f2a0fa51f35fb0e8deaf7467e5465995d20ca3c0d366f6cda46502dd`
  - `spec-b2s2-a-16384.json`: `593050cd6a5b3bae25416d98975a6898511a564e030d5867905fe562e3a753d7`
  - `analysis-all.json`: `c2070316e26b61456ae89cc153dd29e504853709ebf8f13bc3f9619e7237828b`
- **Principal findings:**
  - Truncations occurred inside long reasoning blocks when `reasoning_effort` was omitted (defaulting to `0.9`), not because final code edits required more than 16,384 tokens.
  - Raising `max_tokens` to 24,576 did not resolve instability on the tested task and coincided with wall-clock timeout failures under the 600 s cap.
- **Explicit limitations:**
  - Small sample (1 pilot + 4 contemporaneous trials on a single task).
  - Single model, quantization, Pi version (1.6.0), and `llama.cpp b12622` build.
- **Open follow-up questions:**
  - Would explicitly controlling `reasoning_effort` reduce truncation without degrading verified task correctness? (Examined on a single task in `REASONING-BUDGET-002`.)
  - How do positive token-level reasoning budgets compare to scalar `reasoning_effort`? (Deferred.)

---

### `REASONING-BUDGET-002` — Explicit Reasoning Effort and Verified Coding Outcomes

- **Research question:** Does explicitly setting Inkling's `reasoning_effort` (`high` = `0.9`, `medium` = `0.7`, `low` = `0.2`) via a validated request-control mechanism reduce fatal completion truncations and improve verified coding throughput without harming independently verified correctness on `verify-result-bundle`?
- **Status & conclusion:** `completed`.
  - **Request-control mechanism (demonstrated):** Wire-level manipulation checks confirmed every trial delivered the intended `reasoning_effort` value (`high` / `medium` / `low`) and separated single-turn synthesis length without overlap across all 9 trials (exact permutation p = 0.0119).
  - **Single-task outcome (observed, not generalisable alone):** Reducing `reasoning_effort` eliminated 16,384-token truncations on `verify-result-bundle` and increased observed verified throughput by 5.8×–6.2× (`low` vs `high` in the main 6-trial block; 2.4×–6.2× across `medium` and `low`), with no observed correctness loss on that task.
- **Source commit / branch:** `dc78e5a66f16b6c2a0a0e7537888398df07edcd8` on branch `research/reasoning-budget-001` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-reasoning-budget/research/protected-eval/reasoning-budget-002/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/reasoning-budget-002/`
- **Verified SHA-256 pins:**
  - `preregistration.json`: `435b92ec5eab6a58c34536a5c541a12711914ebc2c86860be5bf7c6bf245a923`
  - `spec-pilots-abc.json`: `11ebaae3e3520cc800002473cd6d5ca22956e89aaa60ce3292706f4139ba1018`
  - `spec-abc-n2.json`: `34dd9631d2cc799677b1a640d2058c277e631a41c0d4c22cee3cdcda0caae808`
- **Principal findings (main 6-trial block; pooled 9 trials including 3 pilots):**
  - `effort-high` (`0.9`): Main **1/2** pass (14/28 hidden cases, 1 truncation, mean 22,711 completion tokens, mean 448.2 s wall, 2.20 passes / 100k completion tokens, 4.02 passes / wall-hr). Pooled **1/3** pass (14/42 cases, 2 truncations).
  - `effort-medium` (`0.7`): Main **2/2** pass (28/28 hidden cases, 0 truncations, mean 18,704 completion tokens, mean 365.1 s wall, 5.35 passes / 100k tokens, 9.86 passes / wall-hr). Pooled **3/3** pass (42/42 cases).
  - `effort-low` (`0.2`): Main **2/2** pass (28/28 hidden cases, 0 truncations, mean 7,369 completion tokens, mean 153.5 s wall, 13.57 passes / 100k tokens, 23.45 passes / wall-hr). Pooled **3/3** pass (42/42 cases).
  - Peak single-turn completion tokens separated monotonically across pooled trials (`high` max 16,384 vs `medium` max 7,084 vs `low` max 6,376).
- **Explicit limitations:**
  - All 9 trials used a single coding task (`verify-result-bundle`); generalisation across task types and difficulty could not be inferred.
  - Small per-arm sample size (`n = 2` main, `n = 3` pooled) and single model/backend stack.
- **Open follow-up questions:**
  - Does the observed efficiency advantage of lower effort replicate across genuinely distinct software-engineering tasks, or do harder tasks require medium/high effort? (Examined in exploratory study `REASONING-TRANSFER-001`.)

---

### `REASONING-TRANSFER-001` — Cross-Task Generalisation of Reasoning Effort

- **Research question:** Do the truncation-reduction and efficiency gains observed with lower `reasoning_effort` (`0.2` / `0.7` vs `0.9`) replicate across three new, independently qualified coding tasks of differing structure and difficulty (`dep-resolver`, `wal-recovery`, `policy-pipeline`), or does optimal effort depend on task characteristics?
- **Status & conclusion:** `completed`.
  - **Exploratory cross-task replication (observed on 3 tasks, 18 trials; generalisation to unseen tasks remains unproven):** Across the three tested tasks, `effort-low` (`0.2`) achieved **5/6** full hidden-evaluator passes (**85/86** hidden cases, 0 truncations, 0 timeouts, 6/6 clean exit `0`) vs `effort-medium` (`0.7`) **4/6** (**64/86**, 2 truncations, 2 timeouts, 2/6 clean exit `0`) and `effort-high` (`0.9`) **2/6** (**42/86**, 4 truncations, 2 timeouts, 0/6 clean exit `0`). In both `high` (2/2 passing trials) and `medium` (2/4 passing trials), some passing candidates hit the 600 s timeout after writing passing code, underscoring the distinction between evaluated candidate correctness and clean process completion.
  - **Task-sensitivity caveat:** `effort-low` was **not lossless** — it produced the study's sole non-truncation logic defect (`14/15` on `dep-resolver`, a cyclic back-edge re-check miss), whereas `effort-high` failures were truncations/timeouts. Because binary pass-rate differences were underpowered (`n = 2` per task × effort cell; `low` 5/6 vs `high` 2/6 Fisher one-sided p = 0.1212 with wide overlapping CIs), these results support a larger confirmatory study rather than proving generalisation to unseen tasks or justifying a global default.
- **Source commit / branch:** `dc78e5a66f16b6c2a0a0e7537888398df07edcd8` on branch `research/reasoning-transfer-001` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-reasoning-transfer/research/protected-eval/reasoning-transfer-001/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/reasoning-transfer-001/`
- **Verified SHA-256 pins:**
  - `preregistration.json`: `1573e41641c0181e2a68827469a1a58ff58ab9a1dbcfa29e76d130dfd874d905`
  - `spec-block1.json`: `3abdce75ece606c370f21c8424696ab126879cd30d8d335abcb45fd7a5e22e02`
  - `spec-block2.json`: `d88edec1e4bf6d40faaac5f5aa64e3cd0c1d37c2f43dbd7fd1530ebc37bbe5d8`
  - `provenance-records.json`: `82823f273f8c478337f90780316173366269b3347806f7916e15c6cf1978dc11`
- **Principal findings (18 controlled trials across 2 randomised blocks × 3 tasks × 3 efforts):**
  - `effort-high` (`0.9`): **2/6** pass (42/86 hidden cases), 4 truncations, 2 timeouts, 0/6 clean exits, mean 20,927 completion tokens, mean 390.3 s wall, 1.59 passes / 100k tokens, 3.07 passes / wall-hr.
  - `effort-medium` (`0.7`): **4/6** pass (64/86 hidden cases), 2 truncations, 2 timeouts, 2/6 clean exits, mean 25,317 completion tokens, mean 457.5 s wall, 2.63 passes / 100k tokens, 5.25 passes / wall-hr.
  - `effort-low` (`0.2`): **5/6** pass (85/86 hidden cases), 0 truncations, 0 timeouts, 6/6 clean exits, mean 16,260 completion tokens, mean 288.1 s wall, 5.13 passes / 100k tokens, 10.41 passes / wall-hr.
  - All 18/18 trials passed protected evidence-integrity checks (zero refused records, clean wire provenance). Peak single-turn completion and estimated reasoning volume separated `low` from `high` with zero overlap (exact permutation p = 0.00108), and clean completion separated `low` (6/6) from `high` (0/6) (Fisher one-sided p = 0.0011).
- **Explicit limitations:**
  - Exploratory sample size (`n = 2` per task × effort cell; 18 total trials); generalisation to unseen tasks remains unproven.
  - Single local model (`Inkling-2-Mini-Uncensored-AD-Q4_K`) and single tested `llama.cpp b12622` build (whose `"none"`-forwarding defect was later addressed in [`ggml-org/llama.cpp#32763`](https://github.com/ggml-org/llama.cpp/pull/32763), commit `afe77e18fadc2e673c6a6299495a443e17378ce4`; whether high-effort truncation or latency changes on another backend build or configuration remains untested).
  - Production inference defaults remain unchanged; no global default was promoted from this study.
- **Open follow-up questions:**
  - Does the observed effort-vs-efficiency relationship — and explicit `reasoning_effort: "none"` once forwarded — change under an updated llama.cpp build or alternative backend? (Deferred.)
  - Does the low-vs-medium accuracy/efficiency trade-off hold on held-out tasks and other model families? (Deferred.)

---

## Foundational Protected-Experiment Studies (Predecessors)

These studies established the protected real-repo execution loop and runtime capability consistency that the reasoning programme built upon.

### `REAL-REPO-STAGED` — Protected Real-Repo Staged Validation

- **Research question:** Can a local coding agent complete a realistic staged Endophasia repository task inside `PI_RUNTIME_V1` with independent hidden evaluation and zero reporting attrition?
- **Status & conclusion:** `completed`. Reference run `run-v3-16384` passed **14/14** hidden evaluator cases with a verified three-file change set and zero reporting attrition, while surfacing 8–10 recovery exchanges from unavailable shell commands (`find`, `sed`, `tail`, `awk`, `wc`, `mkdir`) and relay-limit pressure.
- **Source commit / branch:** `42c9355bf03a368a6cf6709b9d7eccd9124a7540` on branch `research/protected-real-repo-exp` (local worktree; PR #165 base).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-protected-exp/research/protected-eval/real-repo-staged/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/protected-real-repo-exp-20261122/`
- **Verified SHA-256 pin:** `spec-v3-16384.json` = `0eff61e60148f98d080502c0fee1c0a6aea82542ada42cacf64c50b08d60baab`.
- **Limitations:** Single reference run on one task; motivated controlled disclosure and reasoning studies.

### `PI-RUNTIME-DISCOVERY-001` — Minimal Runtime Command Disclosure

- **Research question:** Does appending a minimal five-line disclosure of available sandbox commands improve agent efficiency without expanding sandbox permissions?
- **Status & conclusion:** `completed` — **Inconclusive for production adoption.** Unavailable-command attempts dropped from 6.0 to 2.0/trial, but task pass was 3/3 (baseline) vs 2/3 (disclosed) due to a 16,384-token completion truncation, and forensic audit uncovered a direct conflict with Pi 1.6.0's default system prompt (which recommends `find` and `rg`).
- **Source commit / branch:** `42c9355bf03a368a6cf6709b9d7eccd9124a7540` on branch `research/protected-real-repo-exp` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-protected-exp/research/protected-eval/pi-runtime-discovery-001/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/pi-runtime-discovery-001/`
- **Verified SHA-256 pin:** `spec-ab.json` = `57f1308cf4bccabf6ca15507f16f8df9d07a50ce521432dafb22828a5fbd0051`.
- **Limitations:** 6 trials on one task; confounded by Pi's contradictory default system prompt and 16,384-token truncation.

### `PI-RUNTIME-DISCOVERY-002` — Capability-Consistent Prompting

- **Research question:** Can the mismatch between Pi 1.6.0's advertised commands and `PI_RUNTIME_V1`'s enforced command allowlist be resolved directly from the enforced runtime configuration?
- **Status & conclusion:** `completed` — **Correctness verified; throughput inconclusive.** All 9 deterministic and real-sandbox validation checks passed, matching the enforced `PI_RUNTIME_V1` command inventory on the wire (`714b4af1...`). The 6-trial A/B/C pilot still suffered one 16,384-token truncation per arm, isolating truncation as a separate reasoning-budget phenomenon.
- **Source commit / branch:** `42c9355bf03a368a6cf6709b9d7eccd9124a7540` on branch `research/protected-real-repo-exp` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-protected-exp/research/protected-eval/pi-runtime-discovery-002/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/pi-runtime-discovery-002/`
- **Verified SHA-256 pins:**
  - `spec-pilot-c.json`: `16d5ba69f3b5fb15346075bf8b7c783bca25c158f51a98664e57e6e31b564cd6`
  - `spec-abc.json`: `e4cd49ad4740f6d40c9907535dc27387d61d366fcc0d6d66a211b182cb02b1f6`
- **Limitations:** Small pilot (`n = 2` per arm); validated correctness rather than claiming speedup.

### `PI-RUNTIME-CONSISTENCY-001` — Governed Runtime Capability Disclosure (PR #166)

- **Research question:** Promote the validated capability-consistent system prompt into an opt-in, trust-preserving component of Endophasia's protected model-connected experiment infrastructure.
- **Status & conclusion:** `completed` and **merged** into `main` (PR #166, merge commit `b1e62f0d54c164935368ceb62b41c69dace9cc2a`, commits `68b9f4730` and `dc78e5a66`).
- **Tracked implementation:** [`adapters/sandbox/runtime-prompt.ts`](../adapters/sandbox/runtime-prompt.ts) and [`research/protected-eval/model-connected/pi-condition.ts`](../research/protected-eval/model-connected/pi-condition.ts).
- **Preserved smoke artifact (local artifact):** `/home/noctem/projects/endophasia-research/pi-runtime-consistency-001-smoke/run-smoke` (7/7 pass, `refusedRecords: []`).
- **Limitations:** Opt-in correctness feature; does not alter sandbox permissions or default inference parameters.

---

## Deferred Future Investigations

Further Inkling tuning and llama.cpp reasoning-budget experimentation are **deferred** while development shifts toward surfacing existing protected-experiment infrastructure in Endophasia Studio. The following well-defined questions remain open if the reasoning track is resumed later:

1. **Held-out task replication:** Replicate the `REASONING-TRANSFER-001` protocol on a fresh set of held-out repository tasks with larger per-cell sample sizes (`n >= 5`) to bound pass-rate variance and measure the true frequency of low-effort algorithmic misses like `dep-resolver`'s `14/15` case.
2. **Transfer to another model family:** Repeat the explicit reasoning-effort comparison on at least one non-Inkling reasoning model family to separate Inkling-specific behaviour from general reasoning-model dynamics.
3. **Old-versus-new llama.cpp compatibility comparison:** Re-run a paired comparison between `llama.cpp b12622` and an updated upstream build incorporating [`ggml-org/llama.cpp#32763`](https://github.com/ggml-org/llama.cpp/pull/32763) (`afe77e18fadc2e673c6a6299495a443e17378ce4`), enabling controlled evaluation of explicit `reasoning_effort: "none"` forwarding and testing whether backend changes alter the observed high-effort truncation and latency relationship (which that PR does not itself establish).
4. **Recoverable reasoning truncation:** Evaluate whether a bounded harness recovery policy (e.g., detecting a `finish_reason: "length"` reasoning-only turn and retrying or downgrading effort on the next turn) can rescue truncated attempts without weakening trust boundaries or contaminating experiment accounting.
5. **Positive reasoning-budget controls:** Compare explicit token-level reasoning budgets (positive `reasoning_budget` / `thinking_budget` caps) against scalar `reasoning_effort` levels, testing whether hard token caps prevent runaway turns more cleanly than scalar effort alone.
6. **Effective inference-configuration selection:** Determine whether Endophasia should expose a governed, experiment-declared inference profile (recording `reasoning_effort`, token caps, and backend build provenance in the protected-run contract) rather than hardcoding model-specific defaults.
