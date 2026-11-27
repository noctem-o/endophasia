# CI-RELIABILITY-001 — Baseline Infrastructure and Measurements

## 1. Starting Revision and Scope

- **Repository:** `noctem-o/endophasia`
- **Base commit (`origin/main`):** `2f730eb680e87d04d3a41bbb9d398e6b9a97794c` (Merge pull request #191 from `noctem-o/feat/coordinator-automation-s2`)
- **Working branch:** `feat/ci-reliability-001` (isolated worktree)
- **Date of baseline collection:** 2026-11-27 UTC
- **Open PRs audited (read-only, untouched):**
  - Research PRs: `#192` (`research/s2-live-001`, head `6d8d16421`), `#193` (`feat/coordinator-grounding-002`, head `efd8599cd`), `#194` (`research/coordinator-reasoning-001`, head `3c22f1a91`)
  - Production candidate PRs: `#195` (`feat/coordinator-consolidation-001`, head `e689071ad`), `#196` (`feat/coordinator-studio-f1-002`, head `77d7c03d5`)

## 2. Verified Current Infrastructure (`2f730eb68`)

Verified directly against `.github/workflows/ci.yml`, `vitest.config.ts`, `package.json`, `tests/global-setup.ts`, and `scripts/*`:

- **Test runner:** Vitest `4.1.9` (`vitest --run`), default `forks` pool, default file-level parallelism (`fileParallelism: true`), file isolation enabled (`isolate: true`).
- **Test discovery:** Single root include pattern `tests/**/*.test.ts` discovering **336** test files (**7,934** test cases across all 3 shards on `main` run `45956120688`).
- **Default test timeout:** `30_000` ms (`vitest.config.ts`), with per-test/per-hook overrides up to `240_000` ms in heavier suites.
- **Environment isolation (`vitest.config.ts` + `tests/global-setup.ts`):**
  - Creates a temporary scratch digest-key directory (`endo-vitest-digest-key-*`) per run, exported via `ENDO_DIGEST_KEY_FILE` and cleaned up in `tests/global-setup.ts` teardown.
  - Withholds `XDG_RUNTIME_DIR=""` and `DBUS_SESSION_BUS_ADDRESS=""` unless `ENDO_REAL_SCOPES=1`.
- **General CI shards:** 3 parallel `ubuntu-24.04` jobs (`Test (shard 1/3)`, `Test (shard 2/3)`, `Test (shard 3/3)`), `timeout-minutes: 20`, `fail-fast: false`, `ENDO_REQUIRE_BROWSER: "1"`, Node `22` (`actions/setup-node@v4` with `cache: npm`).
- **Specialist verification jobs (all must be preserved):**
  1. `trust-reader` (`ubuntu-22.04`, builds pinned bubblewrap `9ca3b05ec787acfb4b17bed37db5719fa777834f`, `ENDO_REQUIRE_TRUST_SANDBOX=1`, plus shallow-checkout guest archive reanalysis).
  2. `trust004-freeze` (`ubuntu-24.04`, `fetch-depth: 0`, `fetch-tags: true`, `TRUST004_FREEZE_CHECK=1`).
  3. `check` (`ubuntu-24.04`, `npm run typecheck`, `npm run lint`, Python + C++17 numerical probe unit tests).
  4. `live-scopes` (`ubuntu-24.04`, `ENDO_REAL_SCOPES=1`, `--no-file-parallelism` over 8 CLI suites with live `systemctl --user` scope polling + exact `jq` assertion over `tests/live-process-containment.test.ts`).
  5. `package` (`ubuntu-24.04`, Node `22`, `npm run build` + `npm run test:package` with `ENDO_REQUIRE_BROWSER=1`).
  6. `package-floor` (`ubuntu-24.04`, Node `22.19.0` matching `engines.node: ">=22.19.0"`, `npm run build` + `npm run test:package` with `ENDO_REQUIRE_BROWSER=1`).
  7. `acceptance` (`ubuntu-24.04`, installs pinned `@earendil-works/pi-coding-agent@1.0.0`, `npm run build` + `npm run test:acceptance` with `ENDO_REQUIRE_BROWSER=1`).
  8. `exchange` (`ubuntu-24.04`, `container: fedora:42`, verifies coreutils `mv --exchange` and runs `conformance-lab`, `prime-097-conformance`, `prime-097-review5`).
- **Branch protection:** None configured on `main` (`HTTP 404: Branch not protected` verified via GitHub API on 2026-11-27).
- **Prior mitigation reference:** PR #190 (`3385255c9`, merged in `ed2b9b5c6`) resolved the `thread/start` burst race in `tests/develop-codex-live.test.ts` via an explicit trigger-file handshake in `tests/fixtures/fake-codex-app-server.mjs`. Zero recurrences occurred after merge.

## 3. Historical CI Analysis (40 Completed Runs, 2026-11-25 to 2026-11-27)

Data source: `repos/noctem-o/endophasia/actions/workflows/ci.yml/runs` (40 most recent completed workflows covering both `pull_request` and `push` to `main`, retrieving **all original attempts** `1..N`, job timings, runner images, and all 28 failed job logs; see `historical-runs-40.json`).

### 3.1 Reliability Summary (Explicit Denominators)

| Metric | Raw Count | Rate | Notes |
|---|---:|---:|---|
| Total completed runs sampled | 40 | — | 30 `pull_request`, 10 `push` (`main`) |
| Cancelled on attempt 1 | 1 | 2.5% | Superseded by concurrency group (`45598558647`) |
| **First-attempt success (all decisive runs)** | **19 / 39** | **48.7%** | Includes 1 genuine regression and 6 branch-only env-incompatibility runs |
| **Eventual success (all decisive runs)** | **28 / 38** | **73.7%** | 1 run (`45799313532`) cancelled on attempt 2; 8 recent open PR runs not rerun |
| **Same-revision failure-to-pass rate** | **9 / 20** | **45.0%** | 9 of 10 rerun-to-completion failures passed without code changes (90.0% of reruns) |
| Genuine code/test regressions (attempt 1) | 1 / 39 | 2.6% | Run `45613171656` (PR #183 initial commit; fixed in next commit `92c685bbc`) |
| Branch-only env incompatibilities (attempt 1) | 6 / 39 | 15.4% | PR #193 (3x), PR #194 (2x), PR #195 (1x); note `46002763205` also hit a `main` flake on shard 3 |
| **Known-good decisive revisions (excl. 1 regression + 6 branch-only env runs)** | **19 / 32** | **59.4%** | 13 first-attempt failures caused exclusively by test/infra races on known-good code |
| **Known-good post-PR #190 (`ed2b9b5c6` onward)** | **8 / 11** | **72.7%** | 3 first-attempt failures on known-good code (`45878980507`, `45964716039`, `46016351646`); still far below 99% |

Every single one of the **28 failed jobs** across all 40 runs and all attempts occurred in the **3 general test shards** (`Test (shard 1/3)`, `Test (shard 2/3)`, `Test (shard 3/3)`). All 8 specialist jobs (`check`, `trust-reader`, `trust004-freeze`, `live-scopes`, `package`, `package-floor`, `acceptance`, `exchange`) had **100% pass rate (54/54 passing attempts each)** in this window.

### 3.2 Elapsed Time, Critical Path, and Resource Cost

Measured across all 594 job executions in the 40-run sample (runner images: `ubuntu-24.04@20261116.133.1`, `ubuntu-24.04@20261116.376.1`, `ubuntu-24.04@20261122.23.1`):

| Metric | Sample `n` | Median | p95 | Min | Max |
|---|---:|---:|---:|---:|---:|
| **Workflow elapsed time (passing attempts)** | 28 | **421.5 s (7m 02s)** | **532.0 s (8m 52s)** | 263.0 s | 547.0 s |
| Job queue time (all jobs) | 594 | 2.0 s | 3.0 s | 0.0 s | 5.0 s |
| Shard setup overhead (checkout + setup-node + `npm ci`) | 162 | 10.0 s | 15.0 s | 4.0 s | 17.0 s |
| Shard test execution (`npm test -- --shard=k/3`, passing) | 132 | 371.0 s | 509.0 s | 251.0 s | 533.0 s |
| **Test (shard 1/3)** (passing) | 49 | **379.0 s** | 531.0 s | 348.0 s | 545.0 s |
| **Test (shard 2/3)** (passing — **critical path**) | 45 | **426.0 s** | 512.0 s | 402.0 s | 516.0 s |
| **Test (shard 3/3)** (passing) | 38 | **290.0 s** | 407.0 s | 261.0 s | 419.0 s |
| Live process containment (`live-scopes`) | 54 | 161.0 s | 184.0 s | 145.0 s | 202.0 s |
| TRUST reader (`trust-reader`) | 54 | 71.0 s | 90.0 s | 50.0 s | 100.0 s |
| Clean-install acceptance (`acceptance`) | 54 | 50.5 s | 63.0 s | 35.0 s | 65.0 s |
| Packaged CLI (`package`) | 54 | 48.5 s | 56.0 s | 29.0 s | 59.0 s |
| Packaged CLI floor 22.19.0 (`package-floor`) | 54 | 46.5 s | 56.0 s | 34.0 s | 59.0 s |
| Reference exchange (`exchange`) | 54 | 35.0 s | 47.0 s | 28.0 s | 48.0 s |
| Typecheck and lint (`check`) | 54 | 30.0 s | 41.0 s | 21.0 s | 43.0 s |
| TRUST-004 freeze (`trust004-freeze`) | 54 | 19.0 s | 30.0 s | 13.0 s | 31.0 s |
| **Shard imbalance (`max - min` across 3 shards)** | 28 | **148.0 s** | — | — | **270.0 s** |

- **Total runner-minutes consumed (40 runs, all attempts):** **1,477.6 runner-minutes**
- **Rerun runner-minutes wasted (attempts `>= 2`):** **389.7 runner-minutes (26.4% of total CI compute)**

### 3.3 Slowest Individual Test Files (Hosted Runner `main` Run `45956120688`)

Across all **336** test files on `2f730eb68`, cumulative test-file time is **3,368.8 s** (Shard 1: 1,009.3 s / 357.0 s wall; Shard 2: 1,239.5 s / 430.1 s wall; Shard 3: 1,120.0 s / 391.8 s wall). Vitest's alphabetical `--shard=k/3` clusters multiple multi-minute files onto Shard 2:

| Rank | Test File | Hosted Time | Tests | Baseline Shard |
|---:|---|---:|---:|---|
| 1 | `tests/intervention.test.ts` | 249.78 s | 21 | Shard 2/3 |
| 2 | `tests/task-owned-provenance-aa.test.ts` | 193.16 s | 63 | Shard 2/3 |
| 3 | `tests/endo-workbench-interventions-live.test.ts` | 161.44 s | 12 | Shard 2/3 |
| 4 | `tests/initial-continuation-aa-reader.test.ts` | 156.79 s | 20 | Shard 3/3 |
| 5 | `tests/cassette-replay.test.ts` | 153.41 s | 46 | Shard 1/3 |
| 6 | `tests/aa-operator.test.ts` | 144.41 s | 35 | Shard 1/3 |
| 7 | `tests/aa-operator-cli.test.ts` | 127.41 s | 30 | Shard 1/3 |
| 8 | `tests/prime-097-review7.test.ts` | 94.79 s | 201 | Shard 1/3 |
| 9 | `tests/pi-attachment.test.ts` | 81.72 s | 24 | Shard 3/3 |
| 10 | `tests/endo-studio-tasks-browser.test.ts` | 78.39 s | 33 | Shard 3/3 |
| 11 | `tests/pi-lifecycle-surface.test.ts` | 75.78 s | 21 | Shard 2/3 |
| 12 | `tests/pi-lifecycle-session.test.ts` | 71.07 s | 12 | Shard 3/3 |
| 13 | `tests/initial-continuation.test.ts` | 67.13 s | 43 | Shard 2/3 |
| 14 | `tests/endo-studio-observe-browser.test.ts` | 62.81 s | 67 | Shard 2/3 |
| 15 | `tests/endo-studio-project-browser.test.ts` | 60.09 s | 40 | Shard 1/3 |

The **top 10 files** account for **1,441.3 s (42.8% of total test runtime)**; the **top 20 files** account for **2,044.1 s (60.7%)**. Meanwhile, **237 files take under 2 seconds each** (summing to under 115 s total).
