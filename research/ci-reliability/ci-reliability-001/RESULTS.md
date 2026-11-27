# CI-RELIABILITY-001 — Verification Results and Assessment

## 1. Summary of Changes by Commit

1. **Baseline and failure inventory (`b97b23cf4`):** Recorded 40-run historical CI metrics (`BASELINE.md`, `FAILURE-INVENTORY.md`, `historical-runs-40.json`, `hosted-file-durations-main-2f730eb68.json`), classifying all 28 failed jobs across 8 distinct root causes with zero unknowns.
2. **Confirmed fixture, synchronization, lifecycle, and build fixes (`a1b1ea092`):**
   - **B1:** Atomic temp+rename barrier helpers (`tests/helpers/atomic-barrier.ts`), updated all barriers and child reaping in `tests/writer-lock-concurrency.test.ts`, added non-atomic vs atomic regression test.
   - **B2:** Per-call `closeSession({ timeoutMs })` in `adapters/acp/client-v2.ts`, `init-delay=<ms>` in `tests/fixtures/fake-acp-v2-agent.ts`, decoupled `tests/acp-v2-adapter.test.ts` + added regression test.
   - **B3:** Zombie-safe `isProcessRunningV0`, isolated non-ephemeral loopback port allocator, and `absentFdForPidV0` (`tests/helpers/process-lifecycle.ts`); tightened `task-owned-server.ts` (`pidAlive` zombie check + `pidOwnsListenerPort` FD-inode check) and `linux-host-inspection.ts` (transient non-listener `ENOENT` handling).
   - **B4:** Reusable `tests/helpers/host-capabilities.ts` and `tests/host-capabilities.test.ts`.
   - **B5 (hardened in follow-up F1/F2 `4c9085f51`):** Byte-identical skip + writer-locked staged swap with deterministic rollback in `scripts/build-studio-ui.mjs`, per-Vitest-run immutable temp prebuild in `tests/global-setup.ts`, `ensureSharedStudioUiDir()` across 29 in-process browser/host suites, and `ensureCheckoutStudioUiDir()` across 9 checkout CLI suites (eliminating stale fallback).
   - **F7:** Fixed premature `!composer.disabled` wait to `!send.disabled` in `tests/endo-studio-workbench-interventions-browser.test.ts`.
3. **Test classification, LPT sharding, and coverage accounting (`980b83167`):** `scripts/test-inventory.mjs`, `scripts/check-test-coverage-accounting.mjs`, `scripts/run-test-partition.mjs`, `tests/test-durations.json`, `tests/ci-test-inventory.test.ts`, and `package.json` scripts (`test:fast`, `test:browser`, `test:process`, `test:inventory`).
4. **CI workflow partitioning and duration balancing (`bd1909cbb`):** Replaced 3 unbalanced alphabetical shards in `.github/workflows/ci.yml` with `test-fast`, `test-browser` (`ENDO_REQUIRE_BROWSER=1`, `maxWorkers=2`), and 4 LPT-balanced `test-process` shards (`maxWorkers=3`), adding `npm run test:inventory` to `check` while preserving all 8 specialist jobs unchanged.
5. **CI observability and history analysis (`7d6fccfa4`):** Sanitized `endo.ci-diagnostics.v1` JSON artifacts (`actions/upload-artifact@v4`, 7-day retention), `$GITHUB_STEP_SUMMARY` tables, `scripts/analyze-ci-history.mjs`, and `tests/ci-observability.test.ts`.
6. **Independent review remediations, verification evidence, and documentation:** Addressed all 13 findings from the independent read-only audit (1 HIGH deduplication fix in `analyze-ci-history.mjs` and `BASELINE.md`, 5 MEDIUM hardening items including `.github/workflows/ci.yml` cross-checking and tightened `PROCESS_SIGNALS`, and 7 LOW hygiene/edge-case fixes), moved duration hints to `tests/test-durations.json` to preserve the `scripts/` research-boundary invariant, and completed engineering and developer docs (`docs/testing.md`, `README.md`, `docs/install.md`).

## 2. Before vs After Comparison

### 2.1 Local Verification Results (Arch Linux 16-vCPU / 31 GiB Workstation)

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | 0 errors (`tsconfig.json` + `studio-ui/tsconfig.json`) |
| `npm run lint` | **PASS** | 0 errors across 984 files |
| `npm run test:inventory` | **PASS** | 339/339 files partitioned cleanly (`fast` 148, `browser` 27, `process` 164 across 4 shards with **0.0 s** LPT imbalance); `.github/workflows/ci.yml` cross-checked |
| Numerical probe (Python + C++17) | **PASS** | All Python unittests and `core_test.cpp` passed |
| Focused repetitions (G1) | **60 / 60 PASS** | B1 20/20, B2 20/20, B3 `initial-child-execution` 15/15, B5 concurrent CLI 3/3, AA operator 1/1, `build+package` 1/1 |
| Parallelism sweep (G2) | **7 / 7 PASS** | `fast` 19.95 s (w=4) / 11.81 s (w=8); `browser` 157.71 s (w=2) / 83.88 s (w=4); `process 3/4` 304.0 s (w=2) / 199.94 s (w=3) / 161.69 s (w=6) |
| 6-core CPU contention (G3) | **12 / 12 PASS** | B1 5/5, B2 5/5, B3 2/2 under active 6-core CPU load |
| Full suite (`ENDO_REQUIRE_BROWSER=1 npm test`) | **339 / 339 PASS** | 8,037 test cases (7,826 passed, 211 opt-in skipped, 0 failed after moving `test-durations.json` out of `scripts/`; re-verified full `task-owned-provenance-aa.test.ts` 63/63 + `package-smoke`) |
| `npm run build && ENDO_REQUIRE_BROWSER=1 npm run test:package` | **PASS** | Full tarball pack, isolated install, browser acceptance, 0 leaked processes |

### 2.2 Hosted GitHub Actions Validation (`ubuntu-24.04` 4-vCPU Runners)

Measured directly on Draft PR `#197` (`feat/ci-reliability-001`, head `7a8a989cf`, GitHub Actions Run [`46044910606`](https://github.com/noctem-o/endophasia/actions/runs/46044910606), Attempt 1 — **14 / 14 jobs passed on first attempt**, **0 failures**, **0 reruns**):

| Job | Conclusion | Job Wall (s) | Vitest Wall (s) | `maxWorkers` | Files Reported | Tests Passed / Total (Skipped) | Slowest File |
|---|---|---:|---:|---:|---:|---|---|
| `Typecheck and lint` | **success** | **34 s** | — | — | — | `typecheck`, `lint`, `test:inventory`, Python + C++17 | — |
| `Test (fast)` | **success** | **51 s** | 34.6 s | 4 | 148 / 148 | 3,193 / 3,240 (47) | `tests/develop-attention.test.ts` (5.5 s) |
| `Test (browser)` | **success** | **262 s** | 248.6 s | 2 | 27 / 27 | 311 / 336 (25) | `tests/endo-studio-observe-browser.test.ts` (59.7 s) |
| `Test (process 1/4)` | **success** | **315 s** | 291.5 s | 3 | 39 / 39 | 1,065 / 1,139 (74) | `tests/intervention.test.ts` (247.7 s) |
| `Test (process 2/4)` | **success** | **228 s** | 211.8 s | 3 | 39 / 39 | 1,040 / 1,062 (22) | `tests/task-owned-provenance-aa.test.ts` (180.6 s) |
| `Test (process 3/4)` | **success** | **265 s** | 247.6 s | 3 | 43 / 43 | 896 / 931 (35) | `tests/endo-workbench-interventions-live.test.ts` (164.6 s) |
| `Test (process 4/4)` | **success** | **222 s** | 211.6 s | 3 | 43 / 43 | 1,275 / 1,329 (54) | `tests/cassette-replay.test.ts` (118.0 s) |
| `TRUST-004 operator freeze` | **success** | **20 s** | — | — | — | Full-history tag check | — |
| `Reference exchange` (`fedora:42`) | **success** | **34 s** | — | — | — | `mv --exchange` suites | — |
| `Packaged CLI floor (22.19.0)` | **success** | **51 s** | — | — | — | `build` + `test:package` (`ENDO_REQUIRE_BROWSER=1`) | — |
| `Clean-install acceptance` (Pi 1.0.0) | **success** | **52 s** | — | — | — | `build` + `test:acceptance` (`ENDO_REQUIRE_BROWSER=1`) | — |
| `Packaged CLI` (Node 22) | **success** | **60 s** | — | — | — | `build` + `test:package` (`ENDO_REQUIRE_BROWSER=1`) | — |
| `TRUST reader` (real `bwrap`) | **success** | **75 s** | — | — | — | Pinned `bwrap` + shallow guest reanalysis | — |
| `Live process containment` | **success** | **150 s** | — | — | — | Real `systemd --user` scopes + exact `jq` check | — |

**Hosted Totals & Baseline Comparison (`n = 1` vs `n = 19` Attempt-1 passing / `n = 28` all passing baseline):**
- **Hosted coverage equivalence:** **339 / 339 unique files**, **0 duplicates**, **8,037 total tests** (`7,780 passed`, `257 opt-in/host-capability skipped`, **0 failed**); all 6 sanitized `ci-diagnostics-*.json` artifacts uploaded cleanly (1.2–3.0 KB each, verified zero `/home/noctem` or secret leakage).
- **Workflow elapsed time:** **315 s (5m 15s)** vs Attempt-1 baseline median **443.0 s (7m 23s)** (**-28.9%, -128 s**) and all-passing baseline median **420.0 s (7m 00s)** (**-25.0%, -105 s**).
- **Fast feedback time (`Test (fast)` + `Typecheck and lint`):** **51 s** (down from waiting for full ~7m alphabetical shards).
- **Process shard imbalance (`max - min`):** **93 s job wall (79.9 s Vitest)** vs baseline **148.0 s median / 270.0 s max**; remaining gap is bounded by the single-file duration of `tests/intervention.test.ts` (247.7 s on `process 1/4`).
- **Single-attempt runner-minutes:** **30.3 runner-minutes** across all 14 jobs (vs ~26.2 runner-minutes median for a single passing baseline attempt + 9.0% wasted rerun compute).

**Subsequent Initial-Implementation Hosted Run (`46045745413`, head `e791bb0bd`, Attempt 1 — 14 / 14 passed):**
- **Workflow elapsed time:** **308 s (5m 08s)** (**-30.5%** vs Attempt-1 baseline median 443.0 s; **-26.7%** vs all-passing median 420.0 s).
- **Fast feedback (`Typecheck and lint` + `Test (fast)`):** **51 s** (33 s check, 51 s fast).
- **Partition walls:** `Test (browser)` 272 s, `Test (process 1/4)` 308 s, `Test (process 2/4)` 272 s, `Test (process 3/4)` 233 s, `Test (process 4/4)` 247 s.
- **Total runner-minutes:** **30.9 runner-minutes** across 14 jobs (+4.7 m raw per single passing attempt compared to ~26.2 m baseline single passing attempt; parallelization reduces wall-clock latency at modest additional raw compute per attempt).

### 2.3 Follow-Up Hardening Hosted Validation (`F1`–`F7`)

*Pending final hosted GitHub Actions run after pushing follow-up hardening commits (`F1`–`F7`) to PR `#197`.*

## 3. Honest Assessment

- **Coverage equivalence:** **Established** — proven both locally and on hosted GitHub Actions (`339 / 339` unique files on Run `46044910606`, expanded to `341 / 341` files with F1/F2 & F3/F6 regression suites), now enforced fail-closed on every CI partition via `--strict-accounting` reconciliation (`scripts/reconcile-test-execution.mjs`) and `.github/workflows/ci.yml` cross-checks, with all 8 specialist jobs preserved.
- **Reliability improvement:** **Supported for confirmed defects; statistical proof of `>= 99%` fleet reliability requires natural post-merge observation** — under an idealized i.i.d. Bernoulli model (`p_lower = 0.05 ** (1 / n)`), `n = 2` candidate runs yield only a 22.4% 95% lower bound (`n = 20` -> 86.1%, `n = 30` -> 90.5%, `n = 100` -> 97.0%, `n = 299` -> 99.0%), and real CI runs are non-i.i.d. All 5 active `main` failure modes (`F3`–`F7`), Studio UI publication/stale-build races (`F1`–`F2`), and accounting gaps (`F3` follow-up) now have deterministic root-cause fixes and regressions.
- **Performance improvement:** **Supported (hosted `n = 2`: 315 s and 308 s vs 443.0 s Attempt-1 median; 51 s fast feedback)** — explicitly noting the ~+4–5 raw runner-minute per-attempt trade-off for 14–15 parallel jobs vs 11 baseline jobs.
- **Production promotion:** **Conditional** on final hosted CI pass of the follow-up head on Draft PR `#197` and operator review.
