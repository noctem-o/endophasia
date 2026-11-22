# Protected-Experiment Research Index

This document indexes the protected model-connected experiment programme carried out on Endophasia's `PI_RUNTIME_V1` sandbox and Pi 1.6.0 harness, closing out the Inkling reasoning-efficiency investigation as durable project knowledge.

For earlier live recordings and harness studies (Pi 1.0.1 / 1.0.4 / 1.5.0, cassette replays, variance/pinning, steering, discriminating tasks, completion cap, evidence eligibility, and `DEVELOP` work-cycle studies), see [`research/README.md`](../research/README.md).

## Programme Status

| Track | Status | Notes |
| :--- | :--- | :--- |
| Protected real-repo & capability disclosure (`PI-RUNTIME-*`) | **Completed** | Capability-consistent system prompt promoted via PR #166 (merged into `main` at `b1e62f0d54c164935368ceb62b41c69dace9cc2a`). |
| Reasoning-efficiency studies (`REASONING-BUDGET-001`, `REASONING-BUDGET-002`, `REASONING-TRANSFER-001`) | **Completed** | Mechanism, explicit effort control, and cross-task transfer characterised across 4 coding tasks and 32 controlled protected trials. |
| Further reasoning-budget & Inkling-specific research | **Deferred** | Deferred (not blocked or abandoned). Findings are sufficient for current engineering decisions, and the upstream llama.cpp high-reasoning discrepancy has since been fixed upstream. |

> **Artifact locality note:** Entries marked **(local artifact)** live in preserved local git worktrees or local experiment-output directories outside this repository's tracked tree. They are recorded here with verified SHA-256 digests for provenance and auditability, not as portable repository links.

---

## Study Overview

| Study ID | Title | Status | Headline Conclusion |
| :--- | :--- | :--- | :--- |
| `REAL-REPO-STAGED` | Protected Real-Repo Staged Validation (PR #165 baseline) | `completed` | 14/14 hidden evaluator pass on staged Endophasia task; surfaced unavailable-command retries and 16,384-token pressure. |
| `PI-RUNTIME-DISCOVERY-001` | Minimal Runtime Command Disclosure | `completed` | **Inconclusive for adoption.** Reduced unavailable-command attempts (6.0 → 2.0/trial) but exposed baseline 3/3 vs disclosed 2/3 and a 16,384-token truncation. |
| `PI-RUNTIME-DISCOVERY-002` | Capability-Consistent Prompting | `completed` | **Capability consistency verified (9/9 checks).** Replaced Pi's conflicting default tool claims with enforced `PI_RUNTIME_V1` inventory; throughput remained inconclusive due to 16,384-token truncations. |
| `PI-RUNTIME-CONSISTENCY-001` | Governed Runtime Capability Disclosure (PR #166) | `completed` (merged) | Promoted opt-in capability-consistent system prompt (`adapters/sandbox/runtime-prompt.ts`) into `main` at `b1e62f0d54c164935368ceb62b41c69dace9cc2a`. |
| `REASONING-BUDGET-001` | Reasoning Truncation, Inference Limits & Agent Reliability | `completed` | **Mechanism confirmed; raising completion cap not supported.** Default Inkling `reasoning_effort` (0.9) caused single-turn reasoning exhaustion at 16,384; raising cap to 24,576 caused 600 s timeouts (2/3) with 0/3 trials exceeding 16,384. |
| `REASONING-BUDGET-002` | Explicit Reasoning Effort & Verified Coding Outcomes | `completed` | **Strong single-task efficiency gain.** Lowering `reasoning_effort` (`0.9` → `0.5` → `0.2`) eliminated truncations (pooled pass: high 1/3, medium 3/3, low 3/3) and yielded 5.8×–6.2× useful throughput on `verify-result-bundle`. |
| `REASONING-TRANSFER-001` | Cross-Task Generalisation of Reasoning Effort | `completed` | **Transfer confirmed across 3 new tasks (18 trials).** Low effort (`0.2`) passed 5/6 (85/86 hidden cases, 0 truncations, 0 timeouts) vs medium 4/6 (64/86) and high 2/6 (42/86); surfaced one subtle algorithmic miss (`14/15` on `dep-resolver`). |

---

## Completed Reasoning-Efficiency Studies

All three reasoning studies ran on the same local hardware and model endpoint (`Inkling-2-Mini-Uncensored-AD-Q4_K` served via llama.cpp on `http://127.0.0.1:8091`), Pi 1.6.0, Endophasia's `PI_RUNTIME_V1` sandbox with capability-consistent prompting enabled, and independent hidden evaluators executed outside the sandbox.

### `REASONING-BUDGET-001` — Reasoning Truncation, Inference Limits and Agent Reliability

- **Research question:** Do the recurring 16,384-token completion truncations in protected Inkling runs arise from model reasoning behaviour, the completion-token ceiling, Pi's request construction, llama.cpp's reasoning handling, or their interaction — and does raising the completion ceiling (`16,384` → `24,576`) improve task reliability?
- **Status & conclusion:** `completed`.
  - **Mechanism:** **Confirmed.** Forensic wire-trace inspection and live backend probes showed Pi 1.6.0 omitted `reasoning_effort` in its OpenAI-compatible requests, causing the tested llama.cpp server + Inkling template to default to `reasoning_effort = 0.9`, spending entire completions in hidden reasoning tokens before emitting a tool call or edit. Backend probes also showed `reasoning_effort: "none"` was silently ignored/discarded by the tested llama.cpp build, whereas numeric/named effort levels and positive reasoning budgets were distinct interventions.
  - **Reliability from raising cap (`16,384` → `24,576`):** **Inconclusive** (0/3 arm-B trials actually exceeded 16,384 completion tokens).
  - **Efficiency from raising cap:** **Not supported** (2/3 arm-B trials timed out at the 600 s trial limit).
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
  - Simply raising `max_tokens` to 24,576 did not resolve instability and increased wall-clock timeout failures under the 600 s cap.
- **Explicit limitations:**
  - Small sample (1 pilot + 4 contemporaneous trials on a single task).
  - Single model, quantization, Pi version (1.6.0), and llama.cpp build.
- **Open follow-up questions:**
  - Would explicitly controlling `reasoning_effort` reduce truncation without degrading verified task correctness? (Addressed in `REASONING-BUDGET-002`.)
  - How do positive token-level reasoning budgets compare to scalar `reasoning_effort`? (Deferred.)

---

### `REASONING-BUDGET-002` — Explicit Reasoning Effort and Verified Coding Outcomes

- **Research question:** Does explicitly setting Inkling's `reasoning_effort` (`high` = 0.9, `medium` = 0.5, `low` = 0.2) via a validated request-control mechanism reduce fatal completion truncations and improve verified coding throughput without harming independently verified correctness?
- **Status & conclusion:** `completed`.
  - **Single-task conclusion:** Reducing `reasoning_effort` eliminated completion truncations on `verify-result-bundle` and increased useful verified throughput by ~5.8×–6.2× (`low` vs `high` in main controlled trials), with no observed correctness loss on that task.
- **Source commit / branch:** `dc78e5a66f16b6c2a0a0e7537888398df07edcd8` on branch `research/reasoning-budget-001` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-reasoning-budget/research/protected-eval/reasoning-budget-002/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/reasoning-budget-002/`
- **Verified SHA-256 pins:**
  - `preregistration.json`: `435b92ec5eab6a58c34536a5c541a12711914ebc2c86860be5bf7c6bf245a923`
  - `spec-pilots-abc.json`: `11ebaae3e3520cc800002473cd6d5ca22956e89aaa60ce3292706f4139ba1018`
  - `spec-abc-n2.json`: `34dd9631d2cc799677b1a640d2058c277e631a41c0d4c22cee3cdcda0caae808`
- **Principal findings (main 6-trial block; pooled 9 trials including 3 pilots):**
  - `effort-high` (0.9): Main **1/2** pass (14/28 hidden cases, 1 truncation, mean 22,711 completion tokens, mean 448.2 s wall, 2.20 passes / 100k completion tokens, 4.02 passes / wall-hr). Pooled **1/3** pass (14/42 cases, 2 truncations).
  - `effort-medium` (0.5): Main **2/2** pass (28/28 hidden cases, 0 truncations, mean 18,704 completion tokens, mean 365.1 s wall, 5.35 passes / 100k tokens, 9.86 passes / wall-hr). Pooled **3/3** pass (42/42 cases).
  - `effort-low` (0.2): Main **2/2** pass (28/28 hidden cases, 0 truncations, mean 7,369 completion tokens, mean 153.5 s wall, 13.57 passes / 100k tokens, 23.45 passes / wall-hr). Pooled **3/3** pass (42/42 cases).
  - Wire-level manipulation checks confirmed every trial delivered the intended `reasoning_effort` value and monotonically separated peak single-turn completion tokens (`high` max 16,384 vs `medium` max 7,084 vs `low` max 6,376 pooled).
- **Explicit limitations:**
  - All 9 trials used a single coding task (`verify-result-bundle`); generalisation across task types and difficulty could not be inferred.
  - Small per-arm sample size (`n = 2` main, `n = 3` pooled) and single model/backend stack.
- **Open follow-up questions:**
  - Does low reasoning effort transfer across genuinely distinct software-engineering tasks, or do harder tasks require medium/high effort? (Addressed in `REASONING-TRANSFER-001`.)

---

### `REASONING-TRANSFER-001` — Cross-Task Generalisation of Reasoning Effort

- **Research question:** Do the truncation-reduction and efficiency gains of lower `reasoning_effort` (`0.2` / `0.5` vs `0.9`) generalise across three new, independently qualified coding tasks of differing structure and difficulty (`dep-resolver`, `wal-recovery`, `policy-pipeline`), or does optimal effort depend on task characteristics?
- **Status & conclusion:** `completed`.
  - **Cross-task conclusion:** The reliability and throughput advantage of lower reasoning effort transferred strongly across all three tasks in the tested stack: `effort-low` achieved **5/6** full passes (**85/86** hidden cases, 0 truncations, 0 timeouts) vs `effort-medium` **4/6** (**64/86**, 2 truncations, 2 timeouts) and `effort-high` **2/6** (**42/86**, 4 truncations, 2 timeouts). However, `effort-low` is **not universally lossless**: it produced one subtle algorithmic defect (`14/15` on `dep-resolver`, a missing back-edge/cycle-detection edge case), whereas `effort-high` was dominated by truncation and timeout failures rather than algorithmic errors.
- **Source commit / branch:** `dc78e5a66f16b6c2a0a0e7537888398df07edcd8` on branch `research/reasoning-transfer-001` (local worktree).
- **Canonical report (local artifact):** `/home/noctem/projects/endophasia-reasoning-transfer/research/protected-eval/reasoning-transfer-001/REPORT.md`
- **Preserved artifacts (local artifact):** `/home/noctem/projects/endophasia-research/reasoning-transfer-001/`
- **Verified SHA-256 pins:**
  - `preregistration.json`: `1573e41641c0181e2a68827469a1a58ff58ab9a1dbcfa29e76d130dfd874d905`
  - `spec-block1.json`: `3abdce75ece606c370f21c8424696ab126879cd30d8d335abcb45fd7a5e22e02`
  - `spec-block2.json`: `d88edec1e4bf6d40faaac5f5aa64e3cd0c1d37c2f43dbd7fd1530ebc37bbe5d8`
  - `provenance-records.json`: `82823f273f8c478337f90780316173366269b3347806f7916e15c6cf1978dc11`
- **Principal findings (18 controlled trials across 2 randomised blocks × 3 tasks × 3 efforts):**
  - `effort-high` (0.9): **2/6** pass (42/86 hidden cases), 4 truncations, 2 timeouts, mean 20,927 completion tokens, mean 390.3 s wall, 1.59 passes / 100k tokens, 3.07 passes / wall-hr.
  - `effort-medium` (0.5): **4/6** pass (64/86 hidden cases), 2 truncations, 2 timeouts, mean 25,317 completion tokens, mean 457.5 s wall, 2.63 passes / 100k tokens, 5.25 passes / wall-hr.
  - `effort-low` (0.2): **5/6** pass (85/86 hidden cases), 0 truncations, 0 timeouts, mean 16,260 completion tokens, mean 288.1 s wall, 5.13 passes / 100k tokens, 10.41 passes / wall-hr.
  - All 18/18 trials passed protected evidence-integrity checks (zero refused records, clean wire provenance). Peak completion and reasoning volume cleanly separated `low` from `high` with zero overlap (exact permutation p = 0.00108).
- **Explicit limitations:**
  - Small per-cell sample (`n = 2` per task × effort cell; 18 total trials).
  - Single local model (`Inkling-2-Mini-Uncensored-AD-Q4_K`) and a llama.cpp build that exhibited a high-reasoning discrepancy subsequently fixed upstream; results must not be extrapolated to patched llama.cpp builds or other model families without re-verification.
  - Production inference defaults remain unchanged; no global default was promoted from this study.
- **Open follow-up questions:**
  - How much of the high-effort failure rate disappears under the fixed upstream llama.cpp build? (Deferred.)
  - Does the low-vs-medium accuracy/efficiency frontier hold on held-out tasks and other model families? (Deferred.)

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
3. **Old-versus-new llama.cpp compatibility comparison:** Re-run a paired comparison between the llama.cpp build used in `REASONING-BUDGET-001`..`REASONING-TRANSFER-001` and a patched upstream llama.cpp build that fixes the high-reasoning discrepancy, quantifying how much of the high-effort truncation rate was backend-induced vs intrinsic reasoning verbosity.
4. **Recoverable reasoning truncation:** Evaluate whether a bounded harness recovery policy (e.g., detecting a `finish_reason: "length"` reasoning-only turn and retrying or downgrading effort on the next turn) can rescue truncated attempts without weakening trust boundaries or contaminating experiment accounting.
5. **Positive reasoning-budget controls:** Compare explicit token-level reasoning budgets (positive `reasoning_budget` / `thinking_budget` caps) against scalar `reasoning_effort` levels, testing whether hard token caps prevent runaway turns more cleanly than scalar effort alone.
6. **Effective inference-configuration selection:** Determine whether Endophasia should expose a governed, experiment-declared inference profile (recording `reasoning_effort`, token caps, and backend build provenance in the protected-run contract) rather than hardcoding model-specific defaults.
