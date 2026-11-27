# CI-RELIABILITY-001 — Follow-up Hardening & Production Promotion Review

## 1. Scope and Baselines

- **Branch / PR:** `feat/ci-reliability-001` — Draft PR `#197` targeting `main` (`2f730eb680e87d04d3a41bbb9d398e6b9a97794c`)
- **Starting head of follow-up:** `e791bb0bd1dbf93855d58315ba82a764003970b9`
- **Prior successful hosted candidate runs preserved:**
  - `46044910606` (head `7a8a989cf`, Attempt 1): **14 / 14 passed**, **315 s** elapsed, **30.3 runner-minutes**
  - `46045745413` (head `e791bb0bd`, Attempt 1): **14 / 14 passed**, **308 s** elapsed, **30.9 runner-minutes**
- **Pinned historical research PRs verified untouched:**
  - `#192` (`research/s2-live-001`): `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`
  - `#193` (`feat/coordinator-grounding-002`): `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`
  - `#194` (`research/coordinator-reasoning-001`): `3c22f1a91da2e64f0c0488fae767ceb70c653995`
- **Production candidate PRs inspected read-only (untouched):**
  - `#195` (`feat/coordinator-consolidation-001`): `e689071adfa50f1308bf7de423c5af870297e1df`
  - `#196` (`feat/coordinator-studio-f1-002`): `77d7c03d51a3fc6e95bdcbbc69847065a16c99a8`

---

## 2. Finding-by-Finding Remediation Matrix

| ID | Finding & Confirmed Mechanism | Remediation | Regression Evidence | Remaining Limitation |
|---|---|---|---|---|
| **F1** | `scripts/build-studio-ui.mjs:98-105` replaced `studio-ui/dist` via two renames (`renameSync(target, stale)` + `renameSync(stage, target)`) with a destructive `rmSync(target)` fallback on rename failure, creating a missing-directory window and misleading "atomic" comments. | 1. `tests/global-setup.ts` now builds into a **unique, immutable, per-Vitest-run directory** (`endo-vitest-studio-ui-*`) owned by that run and cleaned up in teardown.<br>2. `scripts/build-studio-ui.mjs` serializes writers via an exclusive lock file (`openSync(..., "wx")`), skips mutation on byte-identical targets, removes the destructive `rmSync(target)` fallback, and rolls back `stale -> target` deterministically on mid-swap failure.<br>3. Removed misleading atomicity claims. | `tests/studio-ui-publication.test.ts` (dual isolated contexts, byte-identical no-op inode check, deterministic lock-barrier writer serialization, interrupted publication, mid-swap rollback) + concurrent dual-Vitest run + `npm run build && npm run test:package`. | POSIX `rename(2)` cannot atomically swap two existing non-empty directories without Linux-only `renameat2(RENAME_EXCHANGE)`; therefore replacing an existing `studio-ui/dist` whose contents changed retains a brief writer-serialized swap interval (production `npm run build` runs offline without concurrent readers; in-process test consumers read only per-run immutable directories). |
| **F2** | `tests/helpers/studio-ui-build.ts:35-37` silently fell back to `studio-ui/dist` if `studio-ui.manifest.json` merely existed — accepting stale-but-internally-valid builds from earlier revisions without verifying ownership, integrity, or revision match. | Eliminated stale `DEFAULT_DIST` fallback. `verifyStudioUiArtifactDir()` runs full `loadEndoStudioUiFilesV0()` and checks `manifestSha256` against the current Vitest context's `studioUiManifestSha256`. CI (`CI=true`) fails closed when unprovided; standalone non-CI local calls build a fresh, process-owned temp dir cleaned up on exit. Checkout CLI tests call `ensureCheckoutStudioUiDir()`, which validates `studio-ui/dist` against the current run's `studioUiManifestSha256` while preserving `cli/studio.ts`'s no-env-override security rule. | `tests/studio-ui-publication.test.ts` (rejects stale-but-valid build, missing/corrupt manifest, missing file, bad hash, extra file, symlink, and unprovided CI context). | Checkout CLI subprocesses still read `studio-ui/dist` by design (`cli/studio.ts` intentionally forbids env overrides, pinned by `tests/endo-studio-cli.test.ts:193` and `tests/endo-studio-source.test.ts`). |
| **F3** | `scripts/check-test-coverage-accounting.mjs` proved planned allocation only; `scripts/run-test-partition.mjs` did not reconcile the exact expected file set against Vitest's actual completed JSON report or catch mandatory suites that Vitest marks `status: "passed"` when all tests are skipped. | Added `scripts/reconcile-test-execution.mjs` and `--strict-accounting` mode (enabled on all CI partition jobs and enforced by `scripts/test-inventory.mjs`). Reconciles fresh per-invocation JSON reports against exact expected file identities, rejects weakening passthrough args (`-t`, `--no-isolate`, `--passWithNoTests`, etc.), enforces a closed 15-file allowlist (`PERMITTED_OPTIONAL_WHOLE_FILE_SKIPS`) so any all-skipped mandatory suite fails closed, verifies aggregate totals, and never masks nonzero exit codes. | `tests/ci-execution-reconciliation.test.ts` (all 11 matrix failure/pass conditions + **real installed Vitest 4.1.9 integration test** against synthetic passing, all-skipped mandatory, and failing test files) + strict `--class=fast --strict-accounting` reconciling 148/148 files. | Non-strict local developer runs with passthrough args intentionally allow partial execution and explicitly announce `mode=partial-local`. |
| **F4** | Replacing `Test (shard 1/3..3/3)` with `Test (fast)`, `Test (browser)`, and `Test (process 1/4..4/4)` could break required status checks if branch protection/rulesets pin legacy names. | Inspected `main` via authorized read-only `gh api` (no 403): `branches/main/protection` returned **HTTP 404 (not protected)**, `rulesets` returned `[]`, `rules/branches/main` returned `[]`. Added stable fail-closed **`CI verification`** aggregate job (`if: always()`, requiring explicit `result === "success"` from all 11 upstream jobs) and cross-checked it in `scripts/test-inventory.mjs`. | YAML validation + `npm run test:inventory` + hosted PR `#197` execution of `CI verification`. | Operator must explicitly configure branch protection / rulesets if desired; not altered during this mission. |
| **F5** | Targeted safety audit of `task-owned-server.ts`, `linux-host-inspection.ts`, and `tests/helpers/process-lifecycle.ts`. | Verified fail-closed provenance and containment across zombie (`Z`/`X`), `EPERM`, transient non-listener `ENOENT`, `startTicks`, and FD-inode checks. Tightened `pidOwnsListenerPort` in `task-owned-server.ts` to also require `entry.address === "127.0.0.1"`. Corrected overstated comments in `tests/helpers/process-lifecycle.ts` so non-ephemeral port bucketing is accurately described as collision reduction, not exclusive OS reservation. | `tests/task-owned-provenance-aa.test.ts`, `tests/initial-child-execution.test.ts`, `tests/aa-operator.test.ts`, `tests/aa-operator-cli.test.ts`. | Pre-probed loopback ports (`allocateIsolatedLoopbackPortV0`) still have a residual bind-close-rebind window if another host process binds the identical non-ephemeral port before the fixture binds; callers supporting `listen(0)` or inherited sockets should prefer them. |
| **F6** | `ci-diagnostics-*.json` and `$GITHUB_STEP_SUMMARY` previously persisted up to 1,200 chars of raw assertion messages, which could include tokens, capability URLs, private payloads, or Markdown injection. | Replaced raw message persistence with closed host-generated failure categories (`assertion`, `timeout`, `filesystem`, `network`, `process-lifecycle`, `runtime-error`, `suite-error`, `unknown`), bounded error class names, normalized relative paths, ANSI/control-stripped sanitized labels, and Markdown-escaped summary cells. Full raw failure output remains in normal scoped GitHub Actions job logs. | `tests/ci-execution-reconciliation.test.ts` + `tests/ci-observability.test.ts` (real Vitest failure containing Bearer token, capability URL, and Markdown/HTML/ANSI injection verified absent from diagnostics JSON and escaped in summaries). | Does not claim universal secret redaction of arbitrary test names if a test title itself embeds a secret; prevents accidental raw assertion-value and Markdown/ANSI persistence. |
| **F7** | Original `ROLLOUT.md` implied 20–30 runs could establish 99% reliability and under-emphasized total runner-minutes (14–15 jobs vs 11). | Updated `ROLLOUT.md`, `RESULTS.md`, and this review with exact one-sided 95% Bernoulli lower confidence bounds (`p_lower = 0.05 ** (1 / n)`), i.i.d. limitations, and explicit runner-minute vs elapsed-time trade-off tables. | Documentation audit across `ROLLOUT.md`, `RESULTS.md`, `FOLLOW-UP-REVIEW.md`. | Long-term 99% reliability remains an operational objective to observe over natural post-merge history, not something proven by 2–3 candidate runs. |

---

## 3. Before / After Studio UI Artifact Lifecycle

- **Before (initial PR `#197` at `e791bb0bd`):**
  - `tests/global-setup.ts` built directly into `studio-ui/dist`, mutating the shared checkout path.
  - `scripts/build-studio-ui.mjs` performed `renameSync(target, stale)` -> `renameSync(stage, target)` with no writer lock and a destructive `rmSync(target)` fallback.
  - `ensureSharedStudioUiDir()` silently accepted `studio-ui/dist` whenever `studio-ui.manifest.json` existed, regardless of revision or integrity.
- **After (follow-up hardening):**
  - **In-process browser/host suites (29+ files):** `tests/global-setup.ts` builds once into a **unique, immutable, execution-owned temp directory** (`<tmpdir>/endo-vitest-studio-ui-<id>/bundle`), validates it with `loadEndoStudioUiFilesV0()`, provides `(studioUiDistDir, studioUiManifestSha256)` via Vitest context, and removes it on teardown only after all workers exit. `ensureSharedStudioUiDir()` verifies full manifest + file SHA-256 + `manifestSha256` match, fails closed in CI if unprovided, and builds a fresh process-owned temp dir for standalone local runs.
  - **Checkout CLI subprocess suites (9 files):** `tests/global-setup.ts` publishes the already-compiled bundle to `studio-ui/dist` via writer-locked `publishStudioUiDirectory()` (zero extra esbuild run; zero-mutation no-op when byte-identical; deterministic rollback on failure; no `rmSync(target)` fallback). The 9 CLI suites call `ensureCheckoutStudioUiDir()`, which validates `studio-ui/dist` against the current execution's `studioUiManifestSha256` (rejecting stale builds) while preserving `cli/studio.ts`'s no-env-override security boundary.
  - **Clean-build tests (`tests/endo-studio-ui.test.ts`):** Continue calling `buildStudioUi()` directly into isolated scratch directories.
  - **Production CLI build (`npm run build` -> `dist/studio-ui`):** Continues using `buildStudioUi()` offline after emptying `dist/`, verified end-to-end by `npm run test:package`.

---

## 4. Required-Check Migration Assessment (F4)

Verified via authorized read-only GitHub REST API (`gh api`):
- `GET /repos/noctem-o/endophasia/branches/main/protection` -> **HTTP 404 (`Branch not protected`)**
- `GET /repos/noctem-o/endophasia/rulesets` -> **`[]`**
- `GET /repos/noctem-o/endophasia/rules/branches/main` -> **`[]`**

### Before / After Check Mapping

| Legacy Check Name (`main`) | New Check Name (`feat/ci-reliability-001`) | Status |
|---|---|---|
| `Test (shard 1/3)`, `Test (shard 2/3)`, `Test (shard 3/3)` | `Test (fast)`, `Test (browser)`, `Test (process 1/4..4/4)` | Replaced (no active required check becomes pending because `main` has 0 required checks) |
| `Typecheck and lint`, `TRUST reader (real sandbox)`, `TRUST-004 operator freeze consistency`, `Live process containment (real user scopes)`, `Packaged CLI (build, pack, isolated install)`, `Packaged CLI on the supported Node floor (22.19.0)`, `Clean-install acceptance (real Pi, fake model endpoint)`, `Reference exchange (coreutils with mv --exchange)` | Identical names preserved | Preserved 1:1 |
| *(none)* | **`CI verification`** (`if: always()`, fails if any of the 11 upstream job IDs is not `success`) | New durable merge-gate identity |

**Recommended operator action (optional, after merging `#197`):** If enabling branch protection or a repository ruleset on `main`, pin **`CI verification`** (source: GitHub Actions) as the required status check so future internal shard-count adjustments never stall PRs or create temporary verification gaps. To roll back cleanly, revert `.github/workflows/ci.yml` and (if protection was enabled) switch the required check back to the individual job names before merging the revert.

---

## 5. Statistical Reliability Bounds & Compute Cost (F7)

Under an idealized independent Bernoulli model with zero failures in `n` runs, the one-sided exact 95% lower confidence bound is `p_lower = 0.05 ** (1 / n)`:

| Consecutive Passing Runs (`n`) | Exact 95% Lower Bound (`p_lower`) | Operational Interpretation |
|---:|---:|---|
| 2 | 22.4% | Initial candidate smoke (PR `#197` runs `46044910606`, `46045745413`) |
| 20 | 86.1% | Early operational signal (natural post-merge activity) |
| 30 | 90.5% | Early operational confidence; **cannot** prove 99% reliability |
| 100 | 97.0% | Strong operational evidence; still below 99% lower bound |
| 299 | 99.0% | Minimum zero-failure i.i.d. sample for 95% confidence at `>= 99%` |

**Non-i.i.d. caveat:** Real CI runs are **not** strictly independent and identically distributed — GitHub-hosted runner images roll weekly, test suites grow, and transient host load varies across time of day. Therefore `99%` first-attempt reliability is maintained as an ongoing operational objective monitored via `npm run ci:analyze -- --live`, never claimed from a small candidate sample.

### Elapsed Time vs Runner-Minute Trade-off

| Configuration | Jobs Executed | Workflow Elapsed Time | Runner-Minutes (Single Attempt) | Notes |
|---|---:|---:|---:|---|
| **Baseline (`2f730eb68`, 40 runs deduplicated)** | 11 | **443.0 s** median (Attempt-1 pass, `n=19`) / **531.5 s** p95 | ~**26.2 m** single passing attempt (+9.0% rerun waste across 40 runs: 1,196.0 m total / 108.2 m rerun) | Alphabetical shards; 148 s median / 270 s max shard imbalance |
| **Candidate Run `46044910606` (`7a8a989cf`)** | 14 | **315 s** (**-28.9%** vs Attempt-1 median) | **30.3 m** (+~4.1 m raw per attempt) | `Test (fast)` + `check` in **51 s**; 0 failures |
| **Candidate Run `46045745413` (`e791bb0bd`)** | 14 | **308 s** (**-30.5%** vs Attempt-1 median) | **30.9 m** (+~4.7 m raw per attempt) | `Test (fast)` + `check` in **51 s**; 0 failures |
| **Follow-up Candidate (+ `CI verification`)** | 15 | *(see final hosted run in `RESULTS.md`)* | *+~0.2 m for 3–10 s aggregate check* | Adds fail-closed execution accounting & stable merge gate |

Parallelizing into `fast` + `browser` + 4 `process` shards is **not free in runner-minutes**: each single passing attempt consumes ~4–5 more runner-minutes than a single passing 3-shard baseline attempt (additional VM setup + `npm ci` + separate `fast`/`browser` runners), trading modest raw compute for ~25–30% lower wall-clock time-to-feedback, sub-minute unit feedback, and elimination of confirmed infrastructure reruns.

---

## 6. Preservation of Historical Research Branches (Section 9)

The following research PR heads are **pinned historical experimental identities** and MUST NOT be rebased, amended, force-pushed, or modified:

- **PR `#192`** (`research/s2-live-001`): `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`
- **PR `#193`** (`feat/coordinator-grounding-002`): `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`
- **PR `#194`** (`research/coordinator-reasoning-001`): `3c22f1a91da2e64f0c0488fae767ceb70c653995`

Their negative CI results, environmental limitations, and exact source commits remain preserved as recorded. Future research work should pick up the hardened CI infrastructure on fresh descendant/successor branches after `#197` merges.

---

## 7. Production PR Integration Plans (`#197 -> #195 -> #196`)

Neither `#195` nor `#196` was modified during this mission. After the operator reviews and merges `#197`, apply the narrow plans below in order:

### 7.1 PR `#195` (`feat/coordinator-consolidation-001` @ `e689071ad`)

- **Observed failure:** `tests/coordinator-consolidation-001.test.ts:62-97` calls `preflightOpenClawCoordinatorV0` with a scratch `openclaw.mjs` (`2026.11.10`) and expects `{ ok: true, harness: "OpenClaw 2026.11.10" }`. On general `ubuntu-24.04` shards without `/usr/bin/bwrap`, `preflightOpenClawCoordinatorV0` correctly fails closed with `{ ok: false, reason: "runtime-unavailable" }`.
- **Exact narrow remediation on `#195` (after `#197` merges):**
  1. **Keep production sandbox enforcement unchanged:** Do not add any CLI/env flag that bypasses `/usr/bin/bwrap` in `preflightOpenClawCoordinatorV0`.
  2. **Extract pure version/package validation helper** in `adapters/coordinator/openclaw.ts` (e.g., `verifyOpenClawPackageVersionV0(openclawPath)`) called by `preflightOpenClawCoordinatorV0`, and test supported (`2026.11.7`, `2026.11.10`) and unsupported (`2099.1.1`) versions deterministically on general shards.
  3. **Add an unconditional fail-closed test** verifying that when `/usr/bin/bwrap` is absent, `preflightOpenClawCoordinatorV0` returns `{ ok: false, reason: "runtime-unavailable" }` (never silently passing).
  4. **Gate the full real-bwrap preflight assertion** using `probeBwrapSandboxV0({ checkUserNamespace: false })` + `requireOrSkipCapabilityV0("bwrap sandbox", "ENDO_REQUIRE_TRUST_SANDBOX", ...)` from `tests/helpers/host-capabilities.ts`, and execute that real-bwrap test case explicitly inside the `trust-reader` CI job (which installs pinned `/usr/bin/bwrap` and sets `ENDO_REQUIRE_TRUST_SANDBOX=1`) so real-bwrap coverage is **required**, not silently skipped.
  5. Rebase `#195` onto `main`; `tests/coordinator-consolidation-001.test.ts` will be picked up automatically in `process` with strict execution accounting (no manual manifest edit required).

### 7.2 PR `#196` (`feat/coordinator-studio-f1-002` @ `77d7c03d5`)

- **Observed state:** All `#196` tests (`tests/coordinator-studio-f1.test.ts`, `tests/coordinator-studio-f1-browser.test.ts`, `tests/endo-studio-ui-source.test.ts`) already passed on Run `46016351646` (which failed only on pre-existing `main` defect `F3`).
- **Exact narrow integration steps on `#196` (after `#197` and `#195` merge):**
  1. Rebase `#196` onto `main` (incorporating `#197` and `#195`).
  2. **Migrate `tests/coordinator-studio-f1-browser.test.ts:62-75`:** Replace the per-file `mkdtempSync("endo-f1-dist-")` + `buildStudioUi(dist)` call (and its `afterAll` `rmSync(dist)`) with `const dist = await ensureSharedStudioUiDir();` from `./helpers/studio-ui-build.ts` so it consumes the Vitest execution's verified immutable build artifact directly (saving a redundant esbuild build while preserving full `loadEndoStudioUiFilesV0()` integrity checks).
  3. Confirm `tests/coordinator-studio-f1.test.ts` and `tests/endo-studio-ui-source.test.ts` contain no direct `buildStudioUi` calls (verified read-only: none present).
  4. Verify full compatibility with `#195`'s diagnostic/refusal states (`EndoCoordinatorBriefDiagnosticsV1`, `overrideCoordinatorDiagnosticsOnRefusalV1`) while preserving all F1 invariants: project-scoped disclosure, host authorization & launch-grant checks (HTTP 401 -> unpaired), read-only operational projections, zero-inference Studio behavior (prohibited-route sentinel = 0 hits), and opt-in auto-refresh lifecycle (OFF by default).
  5. Note: `scripts/test-inventory.mjs` will automatically classify `tests/coordinator-studio-f1-browser.test.ts` into `browser` (with `ENDO_REQUIRE_BROWSER=1` and strict accounting) and `tests/coordinator-studio-f1.test.ts` into `process`; no manual test-list edit is required.
