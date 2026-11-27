# Testing and Continuous Integration

This guide documents how Endophasia's test suite is organized locally and in GitHub Actions (`.github/workflows/ci.yml`), how to run fast feedback loops while developing, and the isolation rules required for reliable tests.

## Quick Commands

| Command | What it runs | Typical use |
|---|---|---|
| `npm run typecheck` | TypeScript checks (`tsconfig.json` and `studio-ui/tsconfig.json`) | Fast static verification |
| `npm run lint` | Biome formatting and lint checks (`biome check .`) | Style and lint hygiene |
| `npm run test:inventory` | Coverage-accounting and workstation-path check across all `tests/**/*.test.ts` | Verify classification, shard balance, and specialist invariants |
| `npm run test:fast` | All pure/lightweight unit test files (`fast` class) | Sub-minute developer feedback loop |
| `npm run test:browser` | All headless Chromium Studio UI and screenshot test files (`browser` class, `maxWorkers=2`) | Frontend and browser regression verification (set `ENDO_REQUIRE_BROWSER=1` to fail if Chromium is absent) |
| `npm run test:process` | All real child-process, fake-Pi, ACP, AA, CLI, and concurrency test files (`process` class) | Process integration verification (supports `-- --shard=k/n`) |
| `npm test` | Full Vitest suite (`tests/**/*.test.ts`, default `forks` pool with file isolation) | Complete local verification |
| `npm run build && npm run test:package` | Build distributable CLI, pack tarball, install into scratch prefix, and run smoke suite under `--no-strip-types` | Release and packaging verification |
| `npm run ci:analyze -- --live --limit=30` | Read-only GitHub Actions reliability, timing, and runner-minute analyzer | Track CI health across recent runs |

### Running a Single Test File or Pattern

```sh
npx vitest run tests/writer-lock-concurrency.test.ts
npx vitest run tests/acp-v2-adapter.test.ts -t "session/close"
node scripts/run-test-partition.mjs --class=process --shard=1/4
```

### Opt-in Host-Capability Suites

Some tests require host-specific tools or datasets and skip cleanly unless explicitly opted in or required:

- **Real Pi runtime:** `ENDO_PI_EXECUTABLE=/path/to/pi npm run test:pi-real`
- **Real Oh My Pi ACP:** `npm run test:acp-omp-real`
- **Real systemd user scopes:** `ENDO_REAL_SCOPES=1 npx vitest run tests/live-process-containment.test.ts` (run in the CI `live-scopes` job)
- **Real Bubblewrap reader sandbox:** `ENDO_REQUIRE_TRUST_SANDBOX=1 npx vitest run tests/develop-verify-trust-003-reader.test.ts` (run in the CI `trust-reader` job)
- **TRUST-004 operator freeze check:** `TRUST004_FREEZE_CHECK=1 npx vitest run tests/develop-verify-trust-004-freeze.test.ts` (run in the CI `trust004-freeze` job)
- **Visual screenshot capture:** `ENDO_SHOTS_DIR=/tmp/shots npx vitest run tests/endo-studio-atmosphere-shots.test.ts`

## Execution Classes and Sharding (`scripts/test-inventory.mjs`)

Every `tests/**/*.test.ts` file is deterministically assigned to exactly one general execution class:

- **`fast`**: pure/in-process suites with hosted duration `< 5 s` and no browser, child-process, server, or Studio UI build signals. Skips the Studio UI prebuild (`ENDO_SKIP_STUDIO_UI_PREBUILD=1`).
- **`browser`**: Chromium-driving suites (`*-browser.test.ts`, `*-shots.test.ts`, `tests/endo-workbench-attempt-page.test.ts`, or files calling `Browser.launch(`). Strictly capped at `maxWorkers=2` per runner to prevent browser memory/CPU contention.
- **`process`** *(conservative default)*: all child-process, fake-Pi, ACP, AA, HTTP/Unix server, CLI, concurrency, slow (`>= 5 s`), and newly added unmeasured non-browser tests. In CI, `process` is balanced across 4 shards using deterministic Longest-Processing-Time-first (LPT) bin-packing (`tests/test-durations.json`), scheduling the heaviest files first at `t = 0` with `maxWorkers=3` on 4-vCPU runners.

Newly added test files do **not** require manual manifest registration: non-browser files automatically run in `process` (with a conservative `5000 ms` weight) and browser files automatically run in `browser`. `npm run test:inventory` runs on every commit in CI (`check` job) to prove complete, disjoint coverage.

## Test Authoring and Isolation Rules

To keep first-attempt CI reliability high:

1. **Atomic multi-process synchronization:** Never synchronize OS processes by polling `existsSync(file)` on a file written with `writeFileSync` (file creation becomes visible before writes flush). Use `writeJsonAtomicallySync` and `waitForJsonBarrier` from `tests/helpers/atomic-barrier.ts` (with `AbortSignal` cleanup on `Promise.any` races).
2. **Decouple startup from per-request timeouts:** Never shrink initialization/handshake timeouts just to test a tight post-startup deadline. Use per-request timeout overrides (e.g., `closeSession({ timeoutMs })`) after explicit readiness.
3. **Process lifecycle & loopback ports:** Use `isProcessRunningV0` (treats Linux `Z`/`X` zombies as terminated; fails closed on `EPERM`), `allocateIsolatedLoopbackPortV0` (reduces ephemeral-range collisions; prefer `listen(0)` or inherited listeners where supported), and `absentFdForPidV0` from `tests/helpers/process-lifecycle.ts`. Always terminate and reap child processes in `afterEach`/`finally` before removing temp directories.
4. **Execution-owned Studio UI builds:** Never call `buildStudioUi("studio-ui/dist")` directly from individual test files.
   - In-process browser/host suites call `ensureSharedStudioUiDir()` from `tests/helpers/studio-ui-build.ts`, which returns the **unique, immutable, execution-owned temporary build directory** prepared by `tests/global-setup.ts` and verifies its manifest + SHA-256 against the current run's hash (failing closed in CI; never falling back to a stale `studio-ui/dist`).
   - Checkout CLI subprocess suites (spawning `node cli/index.ts`, where `cli/studio.ts` intentionally refuses env-var overrides) call `ensureCheckoutStudioUiDir()`, which validates `studio-ui/dist` against the current execution's manifest SHA-256.
   - `scripts/build-studio-ui.mjs` uses writer-serialized staged publication with byte-identical no-op skip and deterministic rollback (and does not claim atomic replacement of an existing differing directory).
5. **No workstation-specific paths or ambient state:** Never fall back to `/home/<user>/...` executable paths or rely on ambient `HOME`/`XDG_*` state. Use `resolveOptionalExecutableV0`, `probeBwrapSandboxV0`, `requireOrSkipCapabilityV0`, and `isolatedHomeEnvV0` from `tests/helpers/host-capabilities.ts`.
6. **Wait on actionable UI state in browser tests:** Avoid asserting readiness on elements that are already enabled prior to an async refresh; wait for the exact interactive state change (e.g., `!send.disabled` or updated DOM text).

## CI Execution Accounting, Merge Gate, and Confidential Diagnostics

Each general CI partition job (`Test (fast)`, `Test (browser)`, `Test (process 1/4..4/4)`) runs with `--strict-accounting`:
- Rejects passthrough arguments that weaken completeness or isolation (`-t`, `--no-isolate`, `--passWithNoTests`, etc.); targeted local runs (`npm run test:fast -- -t ...`) remain supported in `partial-local` mode.
- Reconciles the exact expected file set against a fresh, per-invocation Vitest JSON report (`scripts/reconcile-test-execution.mjs`), failing closed on missing/unexpected/duplicate files, corrupt/stale reports, zero-test files, inconsistent aggregate totals, or all-skipped mandatory suites (only the explicit 15-file optional allowlist `PERMITTED_OPTIONAL_WHOLE_FILE_SKIPS` may report all tests skipped on standard runners).
- Publishes a Markdown summary in `$GITHUB_STEP_SUMMARY` and a sanitized `ci-diagnostics-*.json` artifact (`retention-days: 7`, schema `endo.ci-diagnostics.v1`) containing host-generated failure categories, error class names, normalized paths, sanitized bounded labels, locations, and reconciliation results — **omitting raw assertion diffs, tokens, capability URLs, environment dumps, and transcripts** (full logs remain in standard GitHub Actions job logs).
- The aggregate **`CI verification`** job (`if: always()`) requires explicit `success` from all 11 upstream jobs (8 specialist jobs + `test-fast` + `test-browser` + `test-process` matrix), providing a single durable status check for branch protection without false-green skips.
