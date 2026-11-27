# CI-RELIABILITY-001 — Controlled Validation Experiments

All local experiments below were executed on the operator's Arch Linux workstation (16 logical CPUs, 31 GiB RAM, kernel `7.3.5-arch1-1`, Node `v26.13.1`, Vitest `4.1.9`). Local wall-clock measurements are **not** substitutes for GitHub-hosted `ubuntu-24.04` (4 vCPU, 16 GiB RAM, Node 22.x) timings; hosted CI validation is recorded separately in `RESULTS.md`.

## G1. Focused Repetition of Remediated Defects

Each remediated suite was executed sequentially in bounded repetitions to test determinism of the Phase B fixes:

| Experiment | Target / Command | Reps | Passed | Failed | Min (s) | Median (s) | Max (s) | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **G1-B1** | `tests/writer-lock-concurrency.test.ts` (full file, incl. non-atomic vs atomic regression) | 20 | **20** | 0 | 1.091 | 1.107 | 1.135 | All multi-process lock/barrier assertions intact |
| **G1-B2** | `tests/acp-v2-adapter.test.ts -t "session/close\|decouples slow initialize"` | 20 | **20** | 0 | 2.558 | 2.578 | 2.599 | Includes `init-delay=350` + `closeSession({ timeoutMs: 150 })` regression |
| **G1-B3a** | `tests/initial-child-execution.test.ts` (full file) | 15 | **15** | 0 | 27.490 | 27.637 | 27.810 | Real child process-group termination and zombie-safe liveness checks |
| **G1-B5a** | 5 concurrent Studio UI CLI suites (`endo-studio-cli`, `endo-workspace-cli`, `codex-workbench-cli`, `endo-workbench-cli`, `endo-workbench-attempts-cli`) | 3 | **3** | 0 | 24.756 | 24.821 | 24.841 | Shared `studio-ui/dist` built once in `tests/global-setup.ts` |
| **G1-B3b** | `tests/aa-operator.test.ts` + `tests/aa-operator-cli.test.ts` | 1 | **1** | 0 | 146.483 | 146.483 | 146.483 | Isolated loopback port allocation + transient FD fix |
| **G1-B5b** | `npm run build && ENDO_REQUIRE_BROWSER=1 npm run test:package` | 1 | **1** | 0 | 17.547 | 17.547 | 17.547 | Full tarball build, pack, isolated install, and browser smoke |

**G1 Totals:** **60 / 60** runs passed with **0** failures and tight timing variance.

## G2. Sequential Parallelism Comparison (Local 16-vCPU Workstation)

Executed sequentially (one run at a time, never overlapping) to compare wall-clock scaling and stability across worker caps:

| Partition / Shard | `maxWorkers` | Exit Code | Wall Time (s) | Notes |
|---|---:|---:|---:|---|
| `fast` (160 files) | `4` *(4-vCPU CI default)* | `0` | **19.95 s** | Sub-20 s feedback on 3,421 unit tests |
| `fast` (160 files) | `8` *(16-vCPU local default)* | `0` | **11.81 s** | Clean scaling with zero failures |
| `browser` (27 files, `ENDO_REQUIRE_BROWSER=1`) | `2` *(CI default)* | `0` | **157.71 s** | Bounded Chromium concurrency; zero browser flakes |
| `browser` (27 files, `ENDO_REQUIRE_BROWSER=1`) | `4` | `0` | **83.88 s** | Scales cleanly on 16-vCPU host; CI keeps `2` for 4-vCPU RAM/CPU headroom |
| `process` shard `3/4` (35 files, LPT-balanced) | `2` | `0` | **304.00 s** | Under-utilizes available cores |
| `process` shard `3/4` (35 files, LPT-balanced) | `3` *(4-vCPU CI default)* | `0` | **199.94 s** | **-34.2%** vs `maxWorkers=2`, capturing 73% of available speedup while leaving `>= 1` vCPU headroom for child processes |
| `process` shard `3/4` (35 files, LPT-balanced) | `6` *(16-vCPU local default)* | `0` | **161.69 s** | Approaches single-file floor (`endo-workbench-interventions-live.test.ts`) |

*(Note: `/usr/bin/time` was not installed on the Arch host, so peak RSS was recorded as unavailable rather than estimated.)*

## G3. Bounded Contention Check

Six CPU-bound Python spinner subprocesses were launched in an isolated list and terminated strictly in `finally` (zero memory exhaustion, zero impact on operator services) while running the repaired synchronization suites:

| Suite under 6-core CPU load | Reps | Passed | Failed | Wall Times (s) |
|---|---:|---:|---:|---|
| `tests/writer-lock-concurrency.test.ts` | 5 | **5** | 0 | `1.21, 1.23, 1.20, 1.21, 1.20` |
| `tests/acp-v2-adapter.test.ts -t "session/close\|decouples slow initialize"` | 5 | **5** | 0 | `2.71, 2.70, 2.76, 2.72, 2.71` |
| `tests/initial-child-execution.test.ts` | 2 | **2** | 0 | `28.71, 29.10` |

**G3 Totals:** **12 / 12** runs passed under active 6-core CPU contention.

## G4. Full Local Verification Sweep

1. **Initial full sweep (`npm run typecheck`, `npm run lint`, `npm run test:inventory`, numerical probe Python + C++17, full `ENDO_REQUIRE_BROWSER=1 npm test`):**
   - `typecheck`, `lint`, `test:inventory`, Python unittest, and C++17 `core_test.cpp`: all **passed**.
   - Full `npm test` (339 test files, 8,037 test cases, 290.39 s wall time): **338 / 339 files passed** (7,825 passed, 211 skipped, **1 failure**).
   - **Genuine architectural boundary catch:** The single failure was `tests/task-owned-provenance-aa.test.ts:354`, which asserts that no file under `cli/` or `scripts/` references `task-owned|aa/operat|experiment-aa` (preserving the repository boundary that CLI/scripts never reach into research code). Our initial placement of `test-durations.json` under `scripts/` (listing `tests/task-owned-provenance-aa.test.ts`) and `"startTaskOwnedServer"` in `scripts/test-inventory.mjs` triggered this invariant.
2. **Remediation & targeted re-verification:**
   - Moved `scripts/test-durations.json` to `tests/test-durations.json` and removed `"startTaskOwnedServer"` from `scripts/test-inventory.mjs` (`tests/task-owned-provenance-aa.test.ts` remains in `process` via its `node:child_process` import and `193,163 ms` hosted duration).
   - Re-ran `typecheck`, `lint`, `test:inventory`, `tests/ci-test-inventory.test.ts`, `tests/ci-observability.test.ts`, `tests/release-readiness.test.ts`, full `tests/task-owned-provenance-aa.test.ts` (all 63 tests), `npm run build && ENDO_REQUIRE_BROWSER=1 npm run test:package`, and orphan process inspection.
   - **Coverage comparison against baseline (`2f730eb68`):** 339 files discovered vs 336 baseline (+3 new test files: `tests/host-capabilities.test.ts`, `tests/ci-test-inventory.test.ts`, `tests/ci-observability.test.ts`); 8,037 total test cases vs 7,934+ baseline (+12 new regression/inventory/observability test cases, 0 baseline tests removed).
