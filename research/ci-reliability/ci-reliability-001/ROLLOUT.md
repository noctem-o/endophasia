# CI-RELIABILITY-001 — Rollout, Monitoring, and Rollback Plan

## 1. Rollout Strategy

1. **Draft PR validation (current phase):**
   - Branch `feat/ci-reliability-001` is opened as a **draft PR** targeting `main` (no merge, no branch-protection edits).
   - Initial hosted GitHub Actions run verifies all 11 CI job definitions (14 job executions: `trust-reader`, `trust004-freeze`, `check`, `test-fast`, `test-browser`, `test-process 1/4..4/4`, `live-scopes`, `package`, `package-floor`, `acceptance`, `exchange`) and uploads `ci-diagnostics-*.json` artifacts.
2. **Operator review and promotion:**
   - Review the six independently scoped commits (baseline/inventory, defect fixes, classification/accounting, workflow sharding, observability, verification/docs).
   - Once merged to `main`, observe at least **20–30 consecutive completed runs** across `main` and active PRs before declaring the long-term `>= 99%` first-attempt reliability target empirically established (a single passing run on the draft PR is necessary but statistically insufficient to prove 99% reliability).
3. **Branch-specific remediations for open PRs (untouched during this mission):**
   - **PR `#193` (`feat/coordinator-grounding-002`) & PR `#194` (`research/coordinator-reasoning-001`):**
     - *Observed defect:* `tests/coordinator-grounding-002.test.ts:2115` resolves OpenClaw via `process.env.ENDO_COORDINATOR_OPENCLAW ?? "/home/noctem/.local/bin/openclaw"`, expecting `malformed-selector`, whereas CI runners lack `/home/noctem/.local/bin/openclaw` and return `runtime-unavailable` (5 consecutive failures).
     - *Exact remediation on those branches:*
       1. For unit/contract tests of selector validation (`malformed-selector`), either validate selectors prior to runtime-executable probing in production code or inject a deterministic fake executable fixture inside a temp directory (never a hardcoded `/home/noctem/...` path).
       2. For real OpenClaw integration tests, use `resolveOptionalExecutableV0("ENDO_COORDINATOR_OPENCLAW")` + `requireOrSkipCapabilityV0(...)` from `tests/helpers/host-capabilities.ts`.
   - **PR `#195` (`feat/coordinator-consolidation-001`):**
     - *Observed defect:* `tests/coordinator-consolidation-001.test.ts:81` runs a real `/usr/bin/bwrap` preflight check on the general `ubuntu-24.04` test shards where `bwrap` is not installed.
     - *Exact remediation on that branch:*
       1. Gate the real-bwrap preflight assertion using `probeBwrapSandboxV0({ checkUserNamespace: true })` and `requireOrSkipCapabilityV0("bwrap sandbox", "ENDO_REQUIRE_TRUST_SANDBOX", ...)` from `tests/helpers/host-capabilities.ts`, and execute the real-sandbox assertion in the `trust-reader` (or a dedicated sandbox-provisioned) job where pinned `/usr/bin/bwrap` is installed.
       2. Keep pure preflight refusal/missing-binary unit tests running unconditionally on the general shards.
   - **PR `#196` (`feat/coordinator-studio-f1-002`):**
     - *Observed defect:* Run `46016351646` failed solely in `tests/task-owned-provenance-aa.test.ts:894` (a pre-existing `main` defect, F3). All PR `#196` tests passed.
     - *Exact remediation:* Rebase onto `main` after `feat/ci-reliability-001` merges; no branch-specific test fix required.
   - **PR `#192` (`research/s2-live-001`):**
     - *Observed defect:* Run `45964716039` failed solely in `tests/writer-lock-concurrency.test.ts:254` (a pre-existing `main` defect, F4).
     - *Exact remediation:* Rebase onto `main` after `feat/ci-reliability-001` merges; no branch-specific test fix required.

## 2. Ongoing Monitoring and Duration Hint Maintenance

- **Reliability tracking:** Run `npm run ci:analyze -- --live --limit=40` periodically to track first-attempt success rate, failure-to-pass rerun rate, median/p95 workflow elapsed time, shard imbalance, and runner-minutes consumed.
- **Refreshing duration hints (`tests/test-durations.json`):**
  - New test files work automatically without editing `tests/test-durations.json` (defaulting safely to `process` with `5000 ms` LPT weight).
  - Periodically (e.g., monthly or after adding major new suites), refresh `tests/test-durations.json` from the uploaded `ci-diagnostics-*.json` artifacts on a passing `main` run to keep LPT shard balance tight and promote newly added pure unit tests into `fast`.
  - If `test-browser` ever grows past ~300 s on hosted runners, splitting it into 2 LPT-balanced browser shards requires only adding a `matrix: { shard: [1, 2] }` to `test-browser` and updating the shard plan in `scripts/check-test-coverage-accounting.mjs`.

## 3. Rollback Plan

Every layer is independently revertible without disturbing the others:

1. **Workflow sharding rollback (Commit 4 + 5):** Reverting `.github/workflows/ci.yml` restores the original 3-shard `npm test -- --shard=k/3` job immediately while preserving all Phase B defect fixes (Commit 2) and local developer scripts (`npm test`, `test:fast`, `test:browser`, `test:process`, `test:inventory`).
2. **Individual Phase B fix rollback:** Each defect remediation (atomic barrier helper, ACP `closeSession({ timeoutMs })`, AA zombie/FD inspection, browser wait condition, atomic Studio UI prebuild) is self-contained and can be reverted independently without breaking test discovery or specialist jobs.
3. **No branch-protection lock-in:** Because repository branch protection is not configured on `main` (and not altered by this PR), renaming the general test jobs from `Test (shard k/3)` to `Test (fast)`, `Test (browser)`, and `Test (process k/4)` will not block merges; if branch protection is enabled later, require `Typecheck and lint`, `Test (fast)`, `Test (browser)`, `Test (process 1/4)`..`Test (process 4/4)`, and all 8 specialist jobs.
