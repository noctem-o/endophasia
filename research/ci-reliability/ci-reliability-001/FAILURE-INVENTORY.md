# CI-RELIABILITY-001 — Historical Failure Inventory and Root-Cause Classification

Every failed job (28 total) across the 40-run baseline window (`2026-11-25` to `2026-11-27`) was retrieved with full logs and classified by primary root cause. No failure was dismissed as "flaky" without log inspection.

## 1. Failure Signature Summary

| ID | Signature / Failing Test | Failed Jobs | Runs Affected | Category | Status on `main` (`2f730eb68`) |
|---|---|---:|---:|---|---|
| F1 | `tests/develop-codex-live.test.ts:1138` (`thread/start` burst race on idle native approval) | 13 | 9 | Test synchronization race | **Already fixed** by PR #190 (`3385255c9`) |
| F2 | `tests/coordinator-grounding-002.test.ts:2115` (`ENDO_COORDINATOR_OPENCLAW ?? "/home/noctem/.local/bin/openclaw"`) | 5 | 5 (PR #193 ×3, PR #194 ×2) | Environment incompatibility (workstation assumption) | **Branch-only** (not on `main`) |
| F3 | `tests/task-owned-provenance-aa.test.ts:894` & `tests/aa-operator-cli.test.ts` (`inspection CRITICAL_UNAVAILABLE: PROCESS_OR_FILE_UNAVAILABLE`) | 2 | 2 (`46016351646` PR #196, `45746315906`) | Process lifecycle / port bind-release-rebind & procfs inspection race | **Active on `main`** (remediated in Phase B3) |
| F4 | `tests/writer-lock-concurrency.test.ts:254` (`SyntaxError: Unexpected end of JSON input`) | 1 | 1 (`45964716039` PR #192) | Test synchronization race (non-atomic barrier file write) | **Active on `main`** (remediated in Phase B1) |
| F5 | `tests/acp-v2-adapter.test.ts:755` (`AcpTimeoutErrorV0: initialize did not complete within 300 ms`) | 1 | 1 (`45801472615`, docs-only PR) | Resource / timing sensitivity (startup coupled to 300 ms close timeout) | **Active on `main`** (remediated in Phase B2) |
| F6 | `tests/initial-child-execution.test.ts:463` (`expect(() => process.kill(pid!, 0)).toThrow()`) | 1 | 1 (`46002763205` PR #194 shard 3) | Process lifecycle observation race (zombie PID not yet reaped by PID 1) | **Active on `main`** (remediated in Phase B3) |
| F7 | `tests/endo-studio-workbench-interventions-browser.test.ts:149` (`expected 'No run is open...' to contain 'after the current turn...'`) | 1 | 1 (`45878980507` PR #189, passed on rerun) | Test synchronization race (`waitFor` predicate already true prior to refresh) | **Active on `main`** (remediated in Phase B) |
| F8 | `tests/coordinator-consolidation-001.test.ts:81` (`/usr/bin/bwrap unavailable or not executable`) | 1 | 1 (`46015555565` PR #195) | Environment incompatibility (host capability missing on general shard) | **Branch-only** (not on `main`) |
| F9 | `tests/develop-protected-attempt.test.ts:775` (`races six launcher processes`: 2 non-`already-launched` results) | 1 | 1 (`45739969428`, passed on rerun) | Product concurrency race (`check()` returned `already-authorized` instead of `already-launched`) | **Already fixed** on `main` by PR #186 (`2263b6306` / `aad2f6bcf`) |
| F10 | `tests/endo-pi-boundary.test.ts:102` & `tests/codex-workbench-broker.test.ts:537` | 2 | 1 (`45613171656` PR #183 commit 1) | Product regression (layering import + missing Studio UI build in test) | **Already fixed** in PR #183 commit 2 (`92c685bbc`) |

### Additional Confirmed Defects Identified by Code Audit & Local Execution on `main`

| ID | Location | Defect | Category | Remediation |
|---|---|---|---|---|
| A1 | 9 CLI/Studio test files writing to shared `studio-ui/dist/` + 29 additional per-suite `buildStudioUi` calls | Shared mutable `studio-ui/dist/` directory deleted and recreated via `rmSync(..., { recursive: true, force: true })` concurrently across workers (documented in `.github/workflows/ci.yml:150-151`); 38 redundant esbuild invocations per full run. | Shared mutable build output race | Build once atomically in `tests/global-setup.ts` and share immutable build output (Phase B5) |
| A2 | `tests/task-owned-provenance-aa.test.ts:847, 874` | Mutated `socketFd = String(Number(socketFd) + 40)` and asserted `/ENOENT/`. Fails deterministically whenever parent environment inherits >= 45 open file descriptors (reproduced locally on Run #1 of `task-owned-provenance-aa.test.ts`). | Test-fixture defect (ambient FD table assumption) | Select an explicitly absent FD (guaranteed absent from `/proc/${pid}/fd`) (Phase B3) |

## 2. Detailed Root-Cause Breakdown

### F3 — `PROCESS_OR_FILE_UNAVAILABLE` in `launchTaskOwnedServerV0` (`task-owned-provenance-aa.test.ts`, `aa-operator-cli.test.ts`)
- **Evidence:** Failed in Run `46016351646` (PR #196, shard 2/3) and Run `45746315906` (shard 1/3, passed on rerun).
- **Root cause (three interacting defects):**
  1. `freePort()` (`tests/task-owned-provenance-aa.test.ts:45` and `tests/fixtures/aa-operator-rig.ts:18`) reserves a port via `listen(0)` (selecting directly from Linux's active ephemeral range `32768–60999`), immediately closes it, and leaves a 100 ms–2 s window while hashing, approving, spawning the Node keeper, spawning `relay`, and executing `mmap` before `relay` calls `bind()`. Under parallel shard load, another worker's `listen(0)` or outbound socket can acquire that port.
  2. In `research/governed-initial-continuation/aa/task-owned-server.ts:237-238`, readiness Loop 1 polls `/proc/${pid}/net/tcp` (which is **network-namespace-wide**, not per-process!) and breaks as soon as *any* process listens on `request.port`. Because `relay.c` maps `model.gguf` *before* calling `bind()`, a colliding `relay` maps the model, fails `bind()` (`return 4`), and begins exiting — yet Loop 1 sees the other process's listener and Loop 2 sees `relay`'s mapping, entering `inspectLinuxHostOutcomeV0(serverPid)` right as `relay` exits and `/proc/${serverPid}/...` returns `ENOENT` (`PROCESS_OR_FILE_UNAVAILABLE`).
  3. In `research/governed-initial-continuation/aa/linux-host-inspection.ts:336-339`, `readlinkSync(/proc/${pid}/fd/${name})` throws uncaught `ENOENT` if any non-listener transient FD closes between `opendir` and `readlinkSync`.

### F4 — Non-atomic barrier publication (`tests/writer-lock-concurrency.test.ts`)
- **Evidence:** Run `45964716039` (PR #192, shard 1/3): `SyntaxError: Unexpected end of JSON input` at line 254 (`JSON.parse(await waitForFile(cAcquired))`).
- **Root cause:** Worker writes `writeFileSync(cfg.acquiredBarrier, JSON.stringify(out))` directly to the watched path while parent polls `existsSync(path)` and immediately calls `readFileSync(path, "utf8")`. Directory entry creation (`open(O_CREAT)`) is observable before `write()` completes, allowing the parent to read an empty or partial buffer. The same non-atomic pattern affects `readyFile`, `beforeRecoverSignal`, `afterUnlinkSignal`, `resultFile`, and parent barrier writes (`aResume`, `bRelease`, `startBarrier`, etc.). Additionally, child workers are not guaranteed to be terminated and reaped on failure paths before `afterEach` removes temp directories.

### F5 — ACP v2 initialization coupled to 300 ms `session/close` timeout (`tests/acp-v2-adapter.test.ts`)
- **Evidence:** Run `45801472615` att 1/3 (docs-only PR `docs/coordinator-automation-s0`, shard 2/3, passed on rerun): `AcpTimeoutErrorV0: initialize did not complete within 300 ms`.
- **Root cause:** `AcpClientV2` applies a single `requestTimeoutMs` option to `initialize`, `session/new`, and `session/close`. The test at line 752 passed `{ requestTimeoutMs: 300 }` solely to trigger a `session/close` timeout on `close-hang`, inadvertently giving the child process only 300 ms to spawn Node, load TypeScript, and complete `initialize`.

### F6 — Immediate `process.kill(pid, 0)` after `SIGKILL` (`tests/initial-child-execution.test.ts`, `task-owned-server.ts`)
- **Evidence:** Run `46002763205` (PR #194, shard 3/3): `AssertionError: expected [Function] to throw an error` at `tests/initial-child-execution.test.ts:463`.
- **Root cause:** `ProcessGroupV0.release()` (`adapters/rpc-jsonl/process-group.ts:374, 426`) SIGKILLs the process group (keeper + `fake-pi`), waits for the keeper to be reaped, and polls `liveGroupMembers(group)` until no non-zombie (`state !== "Z" && state !== "X"`) members remain. Once `fake-pi` is dead and reparented to PID 1 as a zombie (`Z`), `release()` returns cleanly — as documented in `process-group.ts:291-293`. However, on Linux, `kill(zombie_pid, 0)` succeeds (`0`, no `ESRCH`) until PID 1 finishes reaping the zombie. Raw `expect(() => process.kill(pid, 0)).toThrow()` (lines 150, 181, 236, 463 of `initial-child-execution.test.ts`, line 566 of `task-owned-provenance-aa.test.ts`, and `pidAlive()` in `task-owned-server.ts:131`) conflates an unreaped dead zombie with a running executable.

### F7 — Premature `waitFor` predicate in browser workbench test (`tests/endo-studio-workbench-interventions-browser.test.ts:143`)
- **Evidence:** Run `45878980507` att 1/2 (PR #189, shard 1/3, passed on rerun): received `"No run is open..."` instead of `"after the current turn's tool calls..."`.
- **Root cause:** Line 143 waited for `!document.querySelector('[data-testid=composer]').disabled` after clicking `#workbench-refresh`. Because the composer textarea is intentionally always editable even when no run is open (verified at lines 135 and 159), that predicate was *already true* before the async refresh completed, causing line 149 to read stale DOM text. Waiting for `!document.querySelector('[data-testid=send]').disabled` (which transitions from `true` at line 140 to `false` only after the refreshed `runActive: true` snapshot renders) synchronizes deterministically on the state transition.

## 3. Historical Research Preservation & Production PR Integration Notes (Do Not Modify Open Branches)

### Pinned Historical Research PRs — `#192`, `#193`, and `#194` (DO NOT REBASE OR MODIFY)
- **PR `#192`** (`research/s2-live-001`, pinned head `6d8d164215b4e80ae2ba6ed3cc60b80da548c639`): Run `45964716039` failed solely on pre-existing `main` defect `F4` (`tests/writer-lock-concurrency.test.ts:254`).
- **PR `#193`** (`feat/coordinator-grounding-002`, pinned head `efd8599cd2fdba7ede46cb12f53b3a91ea689feb`) and **PR `#194`** (`research/coordinator-reasoning-001`, pinned head `3c22f1a91da2e64f0c0488fae767ceb70c653995`):
  - **Failure (5 consecutive runs):** `tests/coordinator-grounding-002.test.ts:2110-2115` hardcodes:
    ```ts
    openclaw: process.env.ENDO_COORDINATOR_OPENCLAW ?? "/home/noctem/.local/bin/openclaw",
    ```
    and expects `{ ok: false, reason: "malformed-selector" }`. On GitHub Actions runners where `/home/noctem/.local/bin/openclaw` does not exist (and `/usr/bin/bwrap` is absent), `preflightOpenClawCoordinatorV0` checks runtime availability before checking `briefingMode`/`visibilityMode` compatibility and returns `"runtime-unavailable"`.
- **Preservation policy:** Do **not** rebase, amend, force-push, or modify `#192`, `#193`, or `#194`. Preserve their exact experimental commits, environmental limitations, and negative CI results. Any future successor branch carrying `#193`/`#194` forward should validate pure mode/selector invariants before host runtime probing in `adapters/coordinator/openclaw.ts` and remove the hardcoded `/home/noctem/.local/bin/openclaw` path in favor of a temp fixture or `resolveOptionalExecutableV0` from `tests/helpers/host-capabilities.ts`.

### PR #195 (`feat/coordinator-consolidation-001`)
- **Failure (Run `46015555565`, shard 2/3):** `tests/coordinator-consolidation-001.test.ts:62-97` calls `preflightOpenClawCoordinatorV0` with a scratch `openclaw.mjs` + `package.json` (`2026.11.10`) and asserts `{ ok: true, harness: "OpenClaw 2026.11.10" }`. On `ubuntu-24.04` general test shards, `/usr/bin/bwrap` is not installed, so lines 666–673 of `adapters/coordinator/openclaw.ts` return `{ ok: false, reason: "runtime-unavailable", detail: "/usr/bin/bwrap unavailable or not executable" }`.
- **Exact remediation for PR #195:**
  1. Do **not** add a production sandbox-bypass flag or weaken `/usr/bin/bwrap` enforcement in `preflightOpenClawCoordinatorV0`.
  2. Extract the pure, deterministic OpenClaw package/version verification logic (e.g., `verifyOpenClawPackageVersionV0(entryPath)` or a narrow read-only host-probe dependency `checkSandboxBinary` default-bound to `/usr/bin/bwrap` in an internal helper, OR split the test):
     - Test supported/unsupported OpenClaw versions (`2026.11.7`, `2026.11.10`, `2099.1.1`) deterministically against the version-verification function (or by passing a test-only `bwrapPath` only if restricted to an internal helper, never a production CLI/env override), **and**
     - Gate the full `preflightOpenClawCoordinatorV0` end-to-end assertion requiring real `/usr/bin/bwrap` with `existsSync("/usr/bin/bwrap")` (or run it in a bubblewrap-provisioned job such as `trust-reader`), while also adding a deterministic test verifying that when `/usr/bin/bwrap` is absent, `preflightOpenClawCoordinatorV0` fails closed with `reason: "runtime-unavailable"`.

### PR #196 (`feat/coordinator-studio-f1-002`)
- **Failure (Run `46016351646`, shard 2/3):** Failed in `tests/task-owned-provenance-aa.test.ts:894` (`PROCESS_OR_FILE_UNAVAILABLE`), which is **unrelated to PR #196** (F3 on `main`). All PR #196 tests (`tests/coordinator-studio-f1.test.ts` and `tests/coordinator-studio-f1-browser.test.ts`) passed.
- **Exact remediation for PR #196:**
  1. Rebase onto `main` once `CI-RELIABILITY-001` lands (which fixes F3).
  2. Optional speed/consistency follow-up once `CI-RELIABILITY-001` lands: switch `tests/coordinator-studio-f1-browser.test.ts:67-71` from per-file `buildStudioUi(dist)` to the shared immutable Studio UI build helper (`ensureSharedStudioUiDir()`). No manual manifest registration is needed: `scripts/test-inventory.mjs` automatically classifies `tests/coordinator-studio-f1-browser.test.ts` into `browser` and `tests/coordinator-studio-f1.test.ts` into `process`.
