# CI-RELIABILITY-001 — Verification Results and Assessment

## 1. Summary of Changes by Commit

1. **Baseline and failure inventory (`b97b23cf4`):** Recorded 40-run historical CI metrics (`BASELINE.md`, `FAILURE-INVENTORY.md`, `historical-runs-40.json`, `hosted-file-durations-main-2f730eb68.json`), classifying all 28 failed jobs across 8 distinct root causes with zero unknowns.
2. **Confirmed fixture, synchronization, lifecycle, and build fixes (`a1b1ea092`):**
   - **B1:** Atomic temp+rename barrier helpers (`tests/helpers/atomic-barrier.ts`), updated all barriers and child reaping in `tests/writer-lock-concurrency.test.ts`, added non-atomic vs atomic regression test.
   - **B2:** Per-call `closeSession({ timeoutMs })` in `adapters/acp/client-v2.ts`, `init-delay=<ms>` in `tests/fixtures/fake-acp-v2-agent.ts`, decoupled `tests/acp-v2-adapter.test.ts` + added regression test.
   - **B3:** Zombie-safe `isProcessRunningV0`, isolated non-ephemeral loopback port allocator, and `absentFdForPidV0` (`tests/helpers/process-lifecycle.ts`); tightened `task-owned-server.ts` (`pidAlive` zombie check + `pidOwnsListenerPort` FD-inode check) and `linux-host-inspection.ts` (transient non-listener `ENOENT` handling).
   - **B4:** Reusable `tests/helpers/host-capabilities.ts` and `tests/host-capabilities.test.ts`.
   - **B5:** Byte-identical skip + atomic staging swap in `scripts/build-studio-ui.mjs`, single prebuild in `tests/global-setup.ts`, `ensureSharedStudioUiDir()` across all 38 CLI/browser/host consumers.
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

*Pending initial draft PR hosted CI run — to be populated immediately after pushing `feat/ci-reliability-001` and observing the draft PR workflow execution.*

## 3. Honest Assessment (Pre-Hosted Validation)

- **Coverage equivalence:** **Established** — all 336 baseline test files plus 3 new CI-reliability unit test files (339 total, 8,037 cases) execute across disjoint partitions verified automatically in CI (`npm run test:inventory`), and all 8 specialist jobs remain unchanged.
- **Reliability improvement:** **Supported for confirmed defects; long-term `>= 99%` fleet rate pending post-merge sample (`n >= 20–30` hosted runs)** — all 5 active `main` failure modes (F3, F4, F5, F6, F7) and the Studio UI race (B5) have root-cause fixes with deterministic regressions and 72/72 passing local repetition/contention trials.
- **Performance improvement:** **Projected ~35–43% median elapsed reduction on hosted runners; pending hosted CI measurement on draft PR** — local workstation timings do not prove hosted GitHub Actions speedup; hosted validation will confirm actual `test-fast`, `test-browser`, and `test-process 1/4..4/4` durations and shard balance.
- **Production promotion:** **Conditional** on green initial hosted CI validation on the draft PR and operator review.
