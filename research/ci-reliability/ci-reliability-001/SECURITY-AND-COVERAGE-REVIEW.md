# CI-RELIABILITY-001 — Security, Containment, and Coverage Equivalence Review

## 1. Coverage Equivalence Matrix

Every verification invariant present at `origin/main` (`2f730eb680e87d04d3a41bbb9d398e6b9a97794c`) is preserved without weakening assertions, adding blanket retries, setting `continue-on-error` on required jobs, disabling Vitest file isolation, or replacing real-host tests with mocks:

| Invariant / Specialist Gate | Baseline (`2f730eb68`) | `feat/ci-reliability-001` | Status |
|---|---|---|---|
| **General Vitest discovery & actual execution** | 336 files (`tests/**/*.test.ts`) across 3 alphabetical shards | 341 files (336 baseline + 5 CI-reliability suites) across `fast` (148) + `browser` (27) + `process` (166 across 4 LPT shards), proven complete & disjoint by `npm run test:inventory` AND reconciled fail-closed against actual Vitest JSON reports via `--strict-accounting` | **Preserved + Hardened** |
| **Vitest file isolation** | Default `isolate: true`, `forks` pool | Unchanged (`isolate: true`, `forks` pool); never disabled | **Preserved** |
| **Scratch digest key & session isolation** | `vitest.config.ts` scratch `ENDO_DIGEST_KEY_FILE`; `XDG_RUNTIME_DIR=""` & `DBUS_SESSION_BUS_ADDRESS=""` unless `ENDO_REAL_SCOPES=1` | Unchanged | **Preserved** |
| **`trust-reader` (real Bubblewrap sandbox)** | `ubuntu-22.04`, pinned `bwrap` commit `9ca3b05ec787acfb4b17bed37db5719fa777834f`, `ENDO_REQUIRE_TRUST_SANDBOX=1`, shallow-checkout guest reanalysis diff | Identical, untouched | **Preserved** |
| **`trust004-freeze` (operator freeze consistency)** | `ubuntu-24.04`, `fetch-depth: 0`, `fetch-tags: true`, `TRUST004_FREEZE_CHECK=1` | Identical, untouched | **Preserved** |
| **`check` (typecheck, lint, numerical probe)** | `npm run typecheck`, `npm run lint`, Python unittest + C++17 `core_test.cpp` | Identical + adds `npm run test:inventory` coverage-accounting gate | **Preserved + Strengthened** |
| **`live-scopes` (real systemd user scopes)** | `ENDO_REAL_SCOPES=1`, 8 CLI suites with live `systemctl --user` scope polling (`started > 0`) + exact `jq` assertion on `tests/live-process-containment.test.ts` | Identical, untouched | **Preserved** |
| **Chromium browser requirement (`ENDO_REQUIRE_BROWSER=1`)** | Set on all 3 general shards + `package`, `package-floor`, `acceptance` | Set on `test-browser` (proven by `test:inventory` to contain every browser-launching test file) + unchanged on `package`, `package-floor`, `acceptance` | **Preserved** |
| **`package` & `package-floor` (Node 22 & Node 22.19.0)** | `npm run build` + `npm run test:package` with `ENDO_REQUIRE_BROWSER=1` | Identical, untouched (verified by `tests/release-readiness.test.ts`) | **Preserved** |
| **`acceptance` (pinned real Pi 1.0.0)** | Installs `@earendil-works/pi-coding-agent@1.0.0`, runs `npm run test:acceptance` with `ENDO_REQUIRE_BROWSER=1` | Identical, untouched (verified by `tests/release-readiness.test.ts`) | **Preserved** |
| **`exchange` (`fedora:42` `mv --exchange`)** | Verifies `mv --exchange` and runs `conformance-lab`, `prime-097-conformance`, `prime-097-review5` | Identical, untouched | **Preserved** |
| **Deterministic research regressions** | Included in `tests/**/*.test.ts` | All included in `fast` or `process` partitions | **Preserved** |

## 2. Security and Containment Audit of Production Changes

Four production/build files were modified during Phase B; each was audited to ensure containment, provenance, and authority semantics were **strengthened or preserved**, never relaxed:

1. **`adapters/acp/client-v2.ts`**
   - *Change:* Added optional validated `timeoutMs` parameter to `closeSession(options?: { readonly timeoutMs?: number })`, threaded cleanly into `#requestOptional` / `#request`.
   - *Security/correctness check:* Validates `timeoutMs` via `checkTimeout` (`0..MAX_TIMER_MS`, rejecting negative/non-finite/oversized values with `RangeError`) before mutating session teardown state. Default behavior when omitted is byte-for-byte identical to `this.#requestTimeoutMs`. Does not alter session authorization, teardown, or waiter release invariants.
2. **`research/governed-initial-continuation/aa/task-owned-server.ts`**
   - *Change 1:* `pidAlive(pid)` now checks `/proc/<pid>/stat` process state and treats `Z` (zombie) and `X` (dead) as not running rather than alive.
   - *Change 2:* Startup listener readiness now checks `pidOwnsListenerPort(pid, port)` (matching `/proc/<pid>/net/tcp` listening socket inode against `/proc/<pid>/fd` `socket:[inode]` links) rather than trusting namespace-wide `/proc/<pid>/net/tcp` alone.
   - *Security/containment impact:* **Strictly stronger.** Previously, a foreign process listening on the same loopback port in the shared network namespace could fool startup readiness into advancing prematurely; now readiness requires confirmed socket-FD ownership by the launched PID itself. Zombie detection prevents a terminated, unreaped child from falsely reporting as alive during shutdown/readiness checks, while actual containment termination (`ProcessGroupV0.signalGroup` / `release`) remains unchanged.
3. **`research/governed-initial-continuation/aa/linux-host-inspection.ts`**
   - *Change:* Inside `inspectLinuxHostV0`, catching `ENOENT` on an individual transient file descriptor during `/proc/<pid>/fd` directory enumeration skips only that disappeared non-listener descriptor rather than aborting inspection with `PROCESS_OR_FILE_UNAVAILABLE`.
   - *Security/containment impact:* **Provenance verification remains strict.** Every matched listening socket descriptor is still explicitly re-verified (`readlinkSync` against `socket:[inode]`), process `startTicks` is verified before and after inspection, and if the target listener descriptor itself vanishes or changes, inspection still fails closed.
4. **`scripts/build-studio-ui.mjs`**
   - *Change:* Builds inside a private temp directory, serializes concurrent writers via an exclusive lock file (`openSync(..., "wx")`), skips overwriting `outDir` when regular files and manifest match byte-for-byte, removes the destructive `rmSync(target)` fallback, and rolls back `stale -> target` deterministically on swap failure (accurately documenting the brief non-atomic directory-swap window when replacing an existing differing directory; concurrent test consumers read per-execution immutable directories instead).
   - *Security/packaging impact:* Output file inventory, SHA-256 manifest, and third-party license notices (`studioUiNotices`) are unchanged. Verified end-to-end by `tests/endo-studio-ui.test.ts`, `tests/studio-ui-publication.test.ts`, and `npm run build && ENDO_REQUIRE_BROWSER=1 npm run test:package`.

## 3. GitHub Actions Permissions and Artifact Hygiene

- **Least privilege:** `.github/workflows/ci.yml` retains top-level `permissions: contents: read` with zero escalated write permissions (including the new `CI verification` aggregate job).
- **No blanket retries or failure masking:** Zero `retry` actions, zero `continue-on-error: true` on any required job or test step, `CI verification` runs under `if: always()` and fails if any dependency is missing, failed, cancelled, or skipped, and `scripts/run-test-partition.mjs` propagates Vitest's exact failing exit code while never letting exit 0 override failed `--strict-accounting` reconciliation.
- **Confidential diagnostic artifacts:** `ci-diagnostics-*.json` artifacts (`retention-days: 7`) and `$GITHUB_STEP_SUMMARY` tables contain only runner metadata, shard allocation, exact reconciliation counts, per-file durations, and **host-generated failure categories** (`assertion`, `timeout`, `filesystem`, `network`, `process-lifecycle`, `runtime-error`, `suite-error`, `unknown`), error class names, ANSI/control-stripped bounded labels (Markdown-escaped in summaries), and source locations. They **omit** raw assertion bodies/diffs, environment variables, tokens, capability URLs, and raw agent transcripts (without claiming universal secret redaction of arbitrary test titles).

## 4. Prohibited Anti-Patterns Check

| Prohibited Practice | Present? | Verification |
|---|---|---|
| Blanket retries / auto-rerun wrappers | **No** | Inspected `.github/workflows/ci.yml` and `scripts/run-test-partition.mjs` |
| `continue-on-error: true` on required jobs | **No** | Inspected `.github/workflows/ci.yml` |
| Disabling Vitest file isolation (`--no-isolate`) | **No** | `vitest.config.ts` & `scripts/run-test-partition.mjs` keep default `isolate: true` |
| Replacing real multi-process / host tests with mocks | **No** | All multi-process lock, ACP, AA, and browser tests run real processes/browsers |
| Arbitrary large timeout increases to hide races | **No** | Fixed root causes (atomic rename, per-request close timeout, zombie/FD checks, button readiness) |
| Broad path-filter exclusions skipping verification | **No** | All jobs trigger on every PR and push to `main` |
| Weakening containment, provenance, or liveness assertions | **No** | Containment/provenance checks preserved or tightened |
