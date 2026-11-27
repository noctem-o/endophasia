# CI-RELIABILITY-001 — Test Execution Architecture Design

## 1. Design Principles

Endophasia's verification suite mixes three fundamentally different workloads under one root discovery pattern (`tests/**/*.test.ts`, 339 files on `feat/ci-reliability-001`):

1. **Pure and lightweight in-process tests (`fast`, 148 files, ~64.7 s cumulative hosted time):** protocol parsers, schema/projection contracts, model logic, digest/replay checks, and lightweight filesystem assertions.
2. **Real headless Chromium browser and screenshot suites (`browser`, 27 files, ~538.3 s cumulative hosted time):** full Studio UI flows served over loopback HTTP and driven over Chrome DevTools Protocol (`ENDO_REQUIRE_BROWSER=1`).
3. **Real child-process, RPC, containment, and concurrency suites (`process`, 164 files, ~2,767.4 s cumulative hosted time):** fake Pi RPC attachments, ACP v2 JSON-RPC agents, governed initial-continuation AA servers, multi-process lock/barrier concurrency tests, CLI end-to-end invocations, and HTTP/Unix control-socket suites.

Previously, CI ran all 336 files through Vitest's alphabetical `--shard=k/3` with default automatic worker parallelism (`forks` = 4 workers on 4-vCPU `ubuntu-24.04` runners). That architecture caused four compounding problems:

- **Severe shard imbalance:** alphabetical splitting clustered `intervention.test.ts` (249.8 s), `task-owned-provenance-aa.test.ts` (193.2 s), and `endo-workbench-interventions-live.test.ts` (161.4 s) onto Shard 2/3, creating a **148.0 s median (270.0 s max)** imbalance between shards and pinning workflow elapsed time to **421.5 s median / 532.0 s p95**.
- **Cross-class resource contention:** Chromium instances, fake Pi subprocesses, AA model-server loops, and esbuild Studio UI rebuilds contended simultaneously for the same 4 vCPUs, triggering scheduling jitter on timing-sensitive assertions.
- **Shared mutable frontend build races:** 9 CLI test files independently rebuilt `studio-ui/dist` in place (with `rmSync` before `esbuild`) while 29 browser/host suites redundantly rebuilt Studio UI into temp dirs.
- **Slow feedback on logic regressions:** developers waited 7+ minutes for alphabetical shards to finish before learning whether pure unit tests passed.

## 2. Target Architecture

### 2.1 Execution Classes (`scripts/test-inventory.mjs`)

Classification is deterministic from file path, static source signals, and hosted duration hints (`tests/test-durations.json`), with **zero manual registration required for new PRs**:

| Class | Selection Rule | Default `maxWorkers` (4-vCPU CI) | Isolation & Environment |
|---|---|---|---|
| `fast` | No browser signals, no child-process/server/Studio-UI signals, and hosted duration `< 5000 ms` | `4` (up to `8` locally) | Vitest `forks` with `isolate: true`; `ENDO_SKIP_STUDIO_UI_PREBUILD=1`; scratch `ENDO_DIGEST_KEY_FILE`; `XDG_RUNTIME_DIR=""` |
| `browser` | `*-browser.test.ts`, `*-shots.test.ts`, `endo-workbench-attempt-page.test.ts`, or `Browser.launch(` / `ENDO_REQUIRE_BROWSER` (excl. static `ci.yml` check in `release-readiness.test.ts`) | `2` (strictly capped) | Vitest `forks` with `isolate: true`; shared prebuilt `studio-ui/dist` from `tests/global-setup.ts`; `ENDO_REQUIRE_BROWSER=1` |
| `process` | **Safe conservative default** for all real child-process, RPC, server, AA, CLI, slow (`>= 5000 ms`), and newly added unmeasured non-browser tests | `3` (leaving `>= 1` vCPU headroom for child processes; up to `6` locally) | Vitest `forks` with `isolate: true`; shared prebuilt `studio-ui/dist` from `tests/global-setup.ts`; scratch `ENDO_DIGEST_KEY_FILE`; `XDG_RUNTIME_DIR=""` |

**Fail-safe property for new test files:** Any newly added `tests/**/*.test.ts` file without an entry in `tests/test-durations.json` automatically lands in `browser` (if browser-based) or `process` (conservative executed default with `5000 ms` LPT weight). No new test can ever be silently dropped, and feature branches (such as PRs `#192`–`#196`) never hit merge conflicts on a hardcoded test list.

### 2.2 Duration-Aware LPT Sharding (`scripts/test-inventory.mjs` + `scripts/run-test-partition.mjs`)

For multi-shard partitions (`process` across 4 shards in CI):

1. Files are weighted by their hosted `ubuntu-24.04` duration (`tests/test-durations.json`, defaulting to `5000 ms` for unmeasured files) and sorted descending by `(weightMs, relPath)`.
2. Longest-Processing-Time-first (LPT) assigns each file to the shard with minimum `(totalWeightMs, fileCount, shardIndex)`.
3. Within each shard, files are passed to Vitest in descending duration order so the longest files (`intervention.test.ts`, `task-owned-provenance-aa.test.ts`, `endo-workbench-interventions-live.test.ts`, `initial-continuation-aa-reader.test.ts`) start immediately at `t = 0`, minimizing worker tail stragglers.

On the 339-file suite:
- `fast` (1 shard): 148 files, **64.7 s** cumulative weight.
- `browser` (1 shard): 27 files, **538.3 s** cumulative weight.
- `process` (4 shards): 164 files, **2,767.4 s** cumulative weight, allocated as `[691.8 s, 691.8 s, 691.8 s, 691.8 s]` (**0.0 s imbalance**, down from 148.0 s median / 270.0 s max).

### 2.3 Shared Immutable Studio UI Prebuild (`scripts/build-studio-ui.mjs`, `tests/global-setup.ts`, `tests/helpers/studio-ui-build.ts`)

- `scripts/build-studio-ui.mjs` builds completely inside a private scratch directory, verifies whether the target `outDir` already matches every file's sha256 byte-for-byte (skipping destructive rewrites when unchanged), and otherwise swaps a sibling staging directory into place atomically.
- `tests/global-setup.ts` builds `studio-ui/dist` once before workers spawn (unless `ENDO_SKIP_STUDIO_UI_PREBUILD=1`, used solely by `fast`) and exposes the directory via Vitest's `provide("studioUiDistDir", ...)`.
- All 38 CLI/browser/host test files consume the shared build via `ensureSharedStudioUiDir()`, while `tests/endo-studio-ui.test.ts` continues invoking `buildStudioUi()` directly into scratch directories to preserve clean/repeatable build verification.

### 2.4 Deterministic Coverage Accounting (`scripts/check-test-coverage-accounting.mjs`)

Executed on every commit in the `check` CI job (`npm run test:inventory`) and unit-tested in `tests/ci-test-inventory.test.ts`. Verifies:
- Exact partition completeness: `fast ∪ browser ∪ process === all tests/**/*.test.ts on disk`.
- Pairwise disjointness across classes and across all LPT shards.
- Zero browser tests misplaced outside `browser`; zero Studio UI consumers inside `fast`.
- All specialist CI job test files (`trust-reader`, `trust004-freeze`, `live-scopes`, `exchange`) exist on disk.
- Zero hardcoded `/home/noctem/` workstation paths outside the documented raw-data fixture (`tests/steering-raw-data.test.ts`).

### 2.5 Specialist Jobs and Docs-Only Changes Policy

- **All 8 specialist verification jobs** (`trust-reader`, `trust004-freeze`, `check`, `live-scopes`, `package`, `package-floor`, `acceptance`, `exchange`) remain completely intact with their exact environments, pinned versions, and assertions.
- **Docs-only changes:** We intentionally **do not** add broad `paths-ignore` exclusions on `docs/**` or `*.md`, because tests such as `tests/release-readiness.test.ts` actively audit `README.md`, `CHANGELOG.md`, and `docs/release-*.md` for release-gate invariants. Instead, reliability fixes eliminate incidental failures on docs-only PRs, and `Test (fast)` + `Typecheck and lint` return feedback in under a minute while preserving full verification integrity.
- **Dependency caching and setup:** All Node jobs retain `actions/setup-node@v4` with `cache: npm` (measured median shard setup overhead is already only **10.0 s**, p95 **15.0 s** — not a material bottleneck).
