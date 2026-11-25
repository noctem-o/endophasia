# DEVELOP-CODEX-LIVE-001: Live Codex App Server Integration & Empirical Research Report

* **Status:** implemented on branch `feat/develop-codex-live-001` (draft PR against `origin/main` `c44a71327f97d1c677f2523532cb2d48b5de15ed`).
* **Authoritative operational contract:** `endo.develop-adapter.v0` ([develop-adapter-contract.md](develop-adapter-contract.md), `protocol/develop-adapter.ts`, `runtime/contracts/develop-adapter.ts`).
* **Coordination design reference:** [coordinator-assignment.md](coordinator-assignment.md) (merged in PR #181; out of scope for implementation here).
* **Guiding principle:** Integrate Codex as Codex. Preserve Codex's native thread/turn/item/approval semantics rather than forcing Codex to look like Pi, and admit only empirically demonstrated capabilities.

---

## 1. Epistemic classification of evidence

This report keeps six evidence categories strictly separate and never promotes one into another:

| Category | What it covers in this milestone | What it does NOT prove |
| :--- | :--- | :--- |
| **1. Fake-server deterministic validation** | `tests/develop-codex-live.test.ts` running `runDevelopAdapterConformanceSuiteV0` (`mode: "production"`) + protocol/security regressions against `tests/fixtures/fake-codex-app-server.mjs`. | Does not prove real Codex CLI protocol compatibility, live model behavior, or real-world approval triggering. |
| **2. Real offline protocol validation** | `node cli/index.ts codex check` against `/usr/bin/codex` (`codex-cli 0.171.0`) with zero model calls (`initialize`, `config/read`, ephemeral `thread/start`, `thread/read`, `thread/unsubscribe`, linked Git worktree test). | Does not prove live model execution, streaming deltas, or live server-initiated approval callbacks. |
| **3. Real authenticated model execution** | Bounded 4-turn trial on one fresh ephemeral owned thread (`gpt-6.2-sol`, `reasoningEffort: "low"`) in a disposable synthetic fixture against commit `b28292b6f30e9c110106ba91ac90c48f40e3588c`. | Does not prove general developer productivity, verifier soundness, live server-initiated approval prompts (none were triggered inside `workspaceWrite`), or multi-agent safety. |
| **4. Agent-reported qualitative feedback** | Sol 6.2's Trial 4 text response describing what it observed and inferred from inside the session. | **Zero verification standing.** The model cannot observe Endophasia's controller internals, canonical store, or protocol framing. |
| **5. Controller-observed evidence** | Canonical `endo.event.v0` + derived `lifecycle.*` records in `<root>/events/events.log`, `harness/<attachment>/records.log`, `ProcessCleanupV0`, and wire/policy checks performed by Endophasia. | Subject to same-uid host limits (`unsigned-local-record`); workstation **H0 remains BLOCKED**. |
| **6. Independent verification** | Independent `git diff`, `node --test`, read-only `reduceEndoSessionOverviewV0`, `replayEndoEventRecordV0`, and independent read-only adversarial code review (`research` subagent). | Does not constitute a protected sandbox verification result (H0 BLOCKED). |

---

## 2. Installed workstation runtimes & protocol discovery

Inspected read-only without modifying operator configuration, authentication, or existing threads:

* **Standalone Codex CLI:**
  * Path: `/usr/bin/codex` → `/usr/lib/openai-codex/bin/codex` (Arch package `openai-codex 0.171.0-1`).
  * Version: `codex-cli 0.171.0` (`/usr/lib/openai-codex/codex-package.json`: `version: "0.171.0+arch.1"`, `target: "x86_64-unknown-linux-gnu"`, `entrypoint: "bin/codex"`).
  * Entrypoint binary: ELF 64-bit PIE x86-64, `333,403,064` bytes, SHA-256 `1dbb7b243541b470d56f20d851e24f0c0e70906e7438329b7192a56c869c2b88`.
  * Generated schemas: `codex app-server generate-ts` (798 TypeScript files) and `codex app-server generate-json-schema` (331 JSON schema files) into disposable scratch storage.
  * Protocol surface in schema: 113 `ClientRequest` methods, 89 `ServerNotification` methods, 10 `ServerRequest` methods (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, plus legacy `applyPatchApproval` and `execCommandApproval`).
* **Desktop application (optional comparison surface, never depended on):**
  * Installed at `/usr/lib/chatgpt/` (Arch package `chatgpt-bin 26.1117.41037-1`), bundling `/usr/lib/chatgpt/resources/codex` (`codex-cli 0.171.0-alpha.13`) and sharing `codexHome: "/home/noctem/.codex"`.
  * Endophasia spawns the user-selected `/usr/bin/codex` directly over `stdio://` and never depends on desktop UI internals or takes control of existing desktop/CLI threads. Because our live trial used `ephemeral: true` to avoid polluting operator thread history, desktop UI comparison against a persisted thread was intentionally omitted (non-destructive isolation prioritized).

### Critical empirical discoveries from the real binary

1. **Wire format omits `"jsonrpc": "2.0"`:** Real `codex app-server --listen stdio://` omits `"jsonrpc"` on responses and notifications (`{"id":1,"result":{...}}`). `CodexAppServerClientV0` accepts optional `"jsonrpc": "2.0"` while still rejecting any invalid `jsonrpc` value.
2. **Deprecated `approval_policy = "untrusted"` fails at startup:** Although `"untrusted"` remains in generated `AskForApproval.ts`, `codex-cli 0.171.0` exits immediately with `Error: approval_policy = "untrusted" is no longer supported; remove this setting`. Endophasia uses `"on-request"` and verifies effective policy from `ThreadStartResponse`.
3. **Permissive user config inheritance & TOML table deep-merge:**
   * The workstation's `~/.codex/config.toml` sets `approval_policy = "never"`, `sandbox_mode = "danger-full-access"`, `model_reasoning_effort = "high"`, and enabled MCP servers (`firecrawl`, `node_repl`).
   * Passing `-c mcp_servers={}` deep-merges in TOML and leaves inherited MCP servers enabled!
   * Endophasia passes explicit `-c` overrides (`approval_policy="on-request"`, `approvals_reviewer="user"`, `sandbox_mode="workspace-write"`, `web_search="disabled"`, `analytics.enabled=false`, `features.hooks=false`, `features.memories=false`, `features.remote_control=false`, `features.remote_plugin=false`), reads `config/read` to discover inherited MCP server names, explicitly disables them via `mcp_servers.<name>.enabled = false` in `thread/start` `config`, and **verifies the effective `ThreadStartResponse` policy** (failing closed on `approvalPolicy === "never"`, `approvalsReviewer !== "user"`, or `sandbox.type === "dangerFullAccess"`).
   * *Remaining observation:* Because `codex app-server` reads global config at process startup before `thread/start`, `mcpServer/startupStatus/updated` notifications still fire during process startup for inherited MCP servers unless disabled via CLI `-c` flags at spawn time (documented as a follow-up hardening item).
4. **Linked Git worktree behavior (answering `COORDINATOR-ASSIGNMENT-001` §15 #5):**
   * Offline Stage A `endo codex check` with `--cwd` pointing at a freshly created linked Git worktree succeeded cleanly: `ThreadStartResponse.cwd` and `thread.cwd` both resolved to the linked worktree path, `sandbox` resolved cleanly to `workspaceWrite` (`writableRoots: []`, `networkAccess: false`), and `thread/read` + `thread/unsubscribe` succeeded.
   * `thread.gitInfo` was `null` on the synthetic linked worktree (confirming Endophasia's own read-only `GitRevisionObserverV0` must remain authoritative for Git commit/tree/worktree identity in E2).

---

## 3. Architecture implemented

| Component | Module(s) | Summary |
| :--- | :--- | :--- |
| **D1 — App Server Transport** | `adapters/codex/app-server-client.ts` | Direct `ProcessGroupV0` (+ optional `ProcessScopeV0`) spawn over `stdio://`, `JsonlDecoderV0` bounded framing, separate bounded stderr diagnostics, request/response correlation, interleaved notifications, duplicate in-flight `ServerRequest` ID rejection, bounded pending queues, and bounded `close()` returning honest `ProcessCleanupV0`. Zero shell/fs RPC methods exposed. |
| **D2 — Identity & Offline Checks** | `adapters/codex/identity.ts`, `capabilities.ts`, `checks.ts` | Resolves executable, hashes entrypoint SHA-256, parses `--version`, reads `codex-package.json`/`package.json`, preserves honest **`reduced`** confidence (`runtimeContent: null` gap for standalone ELF binary), and runs offline `local-protocol` checks (`initialize`, `config/read`, ephemeral `thread/start`, effective policy verification, `thread/read`, `thread/unsubscribe`) persisted in `storage/harness-registry.ts`. Reduced-confidence evidence applies **only to the exact observation (`fingerprintId`)**, never carried across observations. |
| **D3 — Owned Thread & Canonical Events** | `adapters/codex/develop-adapter.ts`, `events.ts` | Implements `CodexDevelopAdapterV0` behind `EndoDevelopLiveAdapterV0` (`source: "codex-live"`, `synthetic: false`, `everydayGrantEligible: false`). Launches one explicitly owned fresh thread; isolates foreign-thread notifications/requests; maps lifecycle/turns/items/usage/approvals/faults into privacy-safe canonical `endo.event.v0` + deterministic `lifecycle.*` interpretations (`codexLifecycleStepV0`) and memory-only `EndoDevelopObservationV0` / `liveView()`. Reasoning summaries stay `reasoningKind: "reasoning-summary"`, never `"raw-thinking"`; missing usage/cost stays `null`/`unavailable`, never `0`. |
| **D4 — Governed Controller** | `adapters/codex/controller.ts`, `runtime/contracts/develop-adapter.ts`, `cli/codex.ts`, `cli/index.ts` | Strict-only `CodexLiveControllerV0` registered as `"codex-live-controller"` in `ENDO_GOVERNED_CONTROL_PATHS_V0` and `protocol/develop-session.ts` `GOVERNED_PATHS`. Enforces explicit per-action operator confirmation (`APPROVE PROMPT` / `APPROVE STOP`), single-use `authorizationId` consumption, exact `(threadId, turnId)` targeting for `turn/interrupt`, and refuses `session-grant`, `queue`, `native-command`, and `resume`. CLI provides `endo codex check` and controlling-terminal `endo codex session`. |
| **D5 — Fail-Closed Native Approvals** | `adapters/codex/native-approvals.ts`, `develop-adapter.ts` | Schema-accurate parser & response encoder for every `codex-cli 0.171.0` `ServerRequest` method. Enforces `endoEvaluateNativeApprovalV0` with `allowSessionOrPolicyScope: false`, single-use per `requestId`, exact `(threadId, turnId, itemId, instanceId)` binding, non-blocking async operator prompts, cancellation on disconnect/turn completion/`serverRequest/resolved`, zero-permission refusal (`{ permissions: {}, scope: "turn" }`) for `item/permissions/requestApproval`, and JSON-RPC `-32601` for unknown methods. |
| **Event-Store Exclusivity** | `storage/writer-lock.ts`, `storage/event-store.ts`, `adapters/pi/attachment.ts` | Extracted `<root>/events/session-attachment.lock` into shared `storage/writer-lock.ts` (`EndoStoreLockedErrorV0`; `PiStoreLockedErrorV0 extends EndoStoreLockedErrorV0`) so Pi and Codex share ONE single-writer lock domain. Made `logPath` injectable on `createEndoDurableEventStoreV0` for future E4 without implementing E4 now. |
| **Minimal DEVELOP Presentation** | `protocol/develop-session.ts`, `studio-ui/src/model/develop-session.ts` | Added pure `presentLiveCodex()` projector and optional `codexLive` argument to `developSurface()`—validated by `endoDevelopSessionProblemV0` / `endoDevelopSurfaceProblemV0`, keeping Codex distinct from Pi (`queue` and `resume` explicitly `unsupported`) with zero Studio UI redesign or new fetch routes. |

### Capability standing matrix (honest separation)

| Operation / Surface | Documented (schema) | Observed offline (`codex check`) | Tested deterministically (fake server) | Tested live (`gpt-6.2-sol`) | Admitted standing in v0 |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `initialize` / `initialized` | Yes | Yes | Yes | Yes | **`admitted`** (`EXACT`) |
| `config/read` | Yes | Yes | Yes | Yes | **`admitted`** (`EXACT`) |
| `thread/start` + `thread/unsubscribe` | Yes | Yes (incl. linked worktree) | Yes | Yes (ephemeral) | **`admitted`** (`EXACT`) |
| `prompt` (`turn/start`) | Yes | Policy + thread only | Yes (conformance + anti-replay) | Yes (4 turns) | **`admitted-partial`** (Strict-only, per-turn operator proof) |
| `stop` (`turn/interrupt`) | Yes | Thread only | Yes (exact + stale turnId) | Yes (Trial 3 interrupted) | **`admitted-partial`** (targeted `turnId` required; ack ≠ process exit) |
| `steer` (`turn/steer`) | Yes | Not invoked | Guarded by capability state | Not invoked | **`unverified`** by default (requires live-study evidence) |
| `queue` (Pi `follow_up` equiv.) | No | — | Refused `operation-unsupported` | — | **`unsupported`** |
| `resume` (`thread/resume`) | Yes | Not invoked | Refused `operation-unsupported` | — | **`unsupported`** in v0 (fresh owned threads only) |
| `native-command` (`/voice`, shell) | No | — | Refused `native-command-unsupported` | — | **`unsupported`** (`allowsArbitraryShell: false`) |
| `nativeApprovals` (`ServerRequest`) | Yes | Not triggered offline | Yes (cmd, file, permissions, unknown, broadening) | **Not triggered inside `workspaceWrite`** | **Fail-closed implemented** (one-time cmd/file only; permissions/unknown declined) |
| Everyday `session-grant` | No | — | Refused `session-grant-not-permitted` | — | **`unsupported`** (`everydayGrantEligible: false`) |

---

## 4. Real workstation validation evidence

### 4.1 Stage A — Offline real binary (`node cli/index.ts codex check`)

* **Endophasia commit:** `b28292b6f30e9c110106ba91ac90c48f40e3588c`
* **Executable:** `/usr/bin/codex` → `/usr/lib/openai-codex/bin/codex` (`codex-cli 0.171.0`, SHA-256 `1dbb7b243541b470d56f20d851e24f0c0e70906e7438329b7192a56c869c2b88`, `333,403,064` bytes).
* **Fixture:** Disposable synthetic Git repository + linked worktree (`/tmp/endo-stage-a-cli-PWi5gX/linked-wt`).
* **Observed fingerprint:** `endo.evidence.codex-fingerprint.16d4c66a0d39793c304025cfb968422218cfab3de1435a7d94277adb6f5f71ac`, basis `runtime-content.v1`, **`confidence: "reduced"`** (explicit `runtimeContent` gap).
* **Observed effective policy:** `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, `sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false }`, `disabledMcpServers: ["firecrawl", "node_repl"]`, `ok: true`.
* **Observed cleanup:** `{ boundary: "process-group", result: "unverified" }`.

### 4.2 Stage B — Bounded live authenticated trial (`gpt-6.2-sol`)

* **Endophasia commit:** `b28292b6f30e9c110106ba91ac90c48f40e3588c`
* **Model:** `gpt-6.2-sol` (`displayName: "GPT-6.2-Sol"`, discovered via `model/list`, `modelContextWindow: 475000`, `reasoningEffort: "low"`).
* **Fixture:** Disposable synthetic Git repo (`/tmp/endo-codex-live-trial-44xmkA/fixture-repo`, initial HEAD `f5424da6180d9eaaebf62c1f2c2e40647a4803ae`) with `parser.mjs` (falsy-zero bug) + `parser.test.mjs` (`node --test`).
* **Owned thread:** `threadId = sessionTreeId = 01a211a3-b3a5-7790-aaa6-611df3ff3cc5` (`ephemeral: true`, attachment `codex.trial`, `instanceId: e0cc8fea1c25cdcc`).
* **Effective policy verified:** `approvalPolicy: "on-request"`, `approvalsReviewer: "user"`, `sandbox: { type: "workspaceWrite", networkAccess: false }`, `disabledMcpServers: ["firecrawl", "node_repl"]`.
* **Observed notifications (13 distinct methods):** `account/rateLimits/updated`, `account/updated`, `item/agentMessage/delta`, `item/completed`, `item/started`, `mcpServer/startupStatus/updated`, `remoteControl/status/changed`, `thread/started`, `thread/status/changed`, `thread/tokenUsage/updated`, `turn/completed`, `turn/diff/updated`, `turn/started`.
* **Native approval callbacks triggered:** `0` (`[]`) — under `on-request` + `workspaceWrite`, Codex executed in-workspace reads, edits, and `node --test` without sending `ServerRequest` approval callbacks.

| Trial | Turn ID | Elapsed | Outcome | Observed activity / results | Last-turn usage (`costUsd: null`) |
| :---: | :--- | :---: | :--- | :--- | :--- |
| **1. Observation** | `01a211a3-b3e6-7f22-984c-eef5e008bcd1` | 16.9 s | `completed` | 5 `commandExecution` items (3× exit `0`, 2× exit `1` reproducing failing test); accurately diagnosed falsy `!value` zero bug; zero files modified. | `in=21,734` (`21,120` cached), `out=188`, `reasoning=0`, `total=21,922` |
| **2. Bounded fix** | `01a211a3-f5c9-7f72-8c84-bb3c0a999b78` | 9.6 s | `completed` | 1 `fileChange(1)` (`completed`) + 2 `commandExecution` (`exit=0`). Independent `git diff` verified 1-line fix; independent `node --test` exited `0` (3/3 pass). | `in=32,212` (`31,872` cached), `out=66`, `reasoning=0`, `total=32,278` |
| **3. Targeted interrupt** | `01a211a4-1b32-7280-a170-99fe5f79b6c1` | 0.72 s | `interrupted` | `requestStop(turnId)` returned `{ status: "accepted", disposition: "interrupt-accepted", consequenceObserved: false }`; subsequent `turn/completed` reported `status: "interrupted"`. Thread remained healthy for Trial 4. | *(no new tokenUsage emitted on interrupted turn)* |
| **4. Sol 6.2 feedback** | `01a211a4-1dff-71c0-a40c-2dc1d5bc184b` | 10.6 s | `completed` | Zero tool/file actions; returned structured qualitative feedback separating direct observation from inference (see §4.3). | `in=32,475` (`32,128` cached), `out=359`, `reasoning=0`, `total=32,834` |

* **Cumulative reported usage (4 turns):** `inputTokens: 233,722` (`cachedInputTokens: 200,192`), `outputTokens: 919`, `reasoningTokens: 0`, `totalTokens: 234,641`, `costUsd: null` (not reported by Codex).
* **Independent post-trial canonical store & privacy verification:**
  * `80` canonical `endo.event.v0` events recorded in `<root>/events/events.log`.
  * `reduceEndoSessionOverviewV0`: `runtime: "codex"`, `runs: 4`, `turns: 4`, `completed: 3`, `aborted: 1`, `stopsRequested: 1`, `stopsAccepted: 1`, `state: "detached"`, `anomalies: []`, `unrecognized: []`, `duplicatesIgnored: 0`.
  * `replayEndoEventRecordV0`: `events: "exact"`, `derived: "exact"`, digest `1bdbb86d4ee7b8ec6b4db017591bfb02d4d8a4e0d51e518d7222d014987c27a2`.
  * Privacy checks: zero prompt text and zero fixture code text present in `<root>/events/events.log`.
  * Teardown: `closeOutcome = { closed: true, cleanup: { boundary: "process-group", result: "unverified", remainingProcesses: null, scopeName: null } }`; `<root>/events/session-attachment.lock` cleanly removed.
  * Neutral DEVELOP presentation: `endoDevelopSessionProblemV0(presentLiveCodex(controller.status())) === null`.

### 4.3 Sol 6.2 qualitative feedback (agent-reported — NOT verification)

> *Classification: **Agent-reported qualitative feedback only** (zero verification standing; model cannot inspect Endophasia's controller, protocol framing, or event store).*

Summary of Sol 6.2's Trial 4 response:
* **Directly observed by the model:** Could read `parser.mjs`/`parser.test.mjs`, run Node, inspect `git diff`, apply the 1-line edit, and see `node --test` exit cleanly. Noted that Trial 3 was interrupted before answering or calling a tool, an explicit interruption notice appeared, and context remained intact for Trial 4. Explicitly noted that no approval prompt or restriction error occurred during its in-workspace actions, so it had no direct evidence of approval/denial UI behavior.
* **Inferred (explicitly distinguished by the model):** Could not tell which controls were enforced by Codex versus Endophasia, or what Endophasia recorded.
* **Suggested improvements:** (1) surface active write boundary and approval status together clearly, (2) have interruption notices clarify whether any tool calls remain active/cancellable, and (3) preserve granular test failure output when test runners summarize at file level.

---

## 5. Deferred requirements for E1/E2 and `E4 — EVENT-STORE-CONCURRENT-001`

Per Mission §10 and [coordinator-assignment.md](coordinator-assignment.md):

1. **Prepared attempts (deferred to E2):** `CodexDevelopAdapterV0` does NOT touch `<root>/develop/attempt-routes/` and does NOT present prepared attempts as native dispatches. Harness-neutral attempt authorization (`develop/adapter-authorizations/`), widened `EndoDevelopAttemptRouteV0` (`"adapter-live"`), `coordination.lock.<n>` dispatch linearisation, and `registeredWorktrees[]` sibling worktree support belong to E1/E2.
2. **Concurrent event storage (deferred to `E4 — EVENT-STORE-CONCURRENT-001`):** Phase D preserves single-writer `<root>/events/events.log` (`storage/writer-lock.ts`) while keeping `logPath` injectable on `createEndoDurableEventStoreV0`. Deferred E4 requirements explicitly carried forward:
   1. **Bidirectional legacy ↔ E4 writer exclusion**, including blocking a legacy binary starting *after* an E4 writer (e.g., via a permanent non-PID `per-attachment-v1` sentinel at `events/session-attachment.lock` that baseline `acquireWriterLock` refuses fail-closed).
   2. **Preservation of legitimate same-attachment historical causal references** across legacy→E4 migration (including seeding `#seen`/`#cursor` on same-attachment resume).
   3. **Per-stream failure isolation** (a sealed/corrupt attachment log must never degrade healthy attachments).
   4. **One shared store-root-wide attempt-route reservation domain** (`<root>/develop/attempt-routes/`).

---

## 6. Remaining limitations & follow-ups

* **Reduced-confidence standalone fingerprint:** Standalone `/usr/lib/openai-codex/bin/codex` has no package-scoped JS runtime-content tree, so its `v1` fingerprint stays honestly `"reduced"` and requires per-observation offline checks (never carrying evidence across observations).
* **Live server-initiated approval callback not triggered in-workspace:** Deterministic fake-server tests thoroughly cover `commandExecution`, `fileChange`, `permissions`, `unknown`, and scope-broadening refusals, but real in-workspace edits/commands under `on-request` + `workspaceWrite` did not emit a live `ServerRequest`. Validating a real out-of-sandbox/escalation `ServerRequest` callback remains an explicit bounded live follow-up.
* **Startup MCP initialization:** Inherited MCP servers from `~/.codex/config.toml` are disabled on `thread/start`, but `codex app-server` still emits `mcpServer/startupStatus/updated` on startup unless disabled via spawn-time `-c` flags.
* **No Studio HTTP workbench server for Codex yet:** Neutral presentation (`presentLiveCodex` + `developSurface`) and the controlling-terminal CLI (`endo codex session`) are delivered; wiring a multi-harness Studio HTTP endpoint is deferred to avoid a speculative Studio redesign.
* **Process containment:** `cli/codex.ts` wires `liveContainmentV0()` / `liveScopeV0()` matching `cli/harness.ts` (reporting `scope / confirmed` when host user systemd scopes succeed, and `process-group / unverified` when `CodexDevelopAdapterV0` is used without a `ProcessScopeV0`; workstation **H0 remains BLOCKED** and `ENDO_REAL_SCOPES=1` remains strictly opt-in per #179).

---

## 7. Independent adversarial review & remediations

An independent read-only adversarial code review (`82169716-f337-4b4a-bd31-f8cadb2ab661`) audited the complete `DEVELOP-CODEX-LIVE-001` diff against every safety, authority, privacy, transport, and lifecycle invariant, raising **18 substantiated findings** (`6 HIGH`, `9 MEDIUM`, `3 LOW`). Every finding was remediated and covered by deterministic regression tests:

* **HIGH (6/6 remediated):**
  1. **Strict effective-policy allowlist (`adapters/codex/checks.ts`):** Added `sandbox_workspace_write.network_access=false` and `sandbox_workspace_write.writable_roots=[]` to conservative overrides; replaced permissive denylist checks in `verifyCodexEffectivePolicyV0` with a strict allowlist (`approvalPolicy === "on-request"`, `approvalsReviewer === "user"`, `sandbox.type ∈ {"workspaceWrite", "readOnly"}`, `networkAccess === false`, empty `writableRoots`); fail-closed on enabled MCP server names outside `/^[A-Za-z0-9_-]+$/`.
  2. **Sealed event store fail-closed (`adapters/codex/develop-adapter.ts`):** `open()` now inspects `store.recovery().state === "sealed"` and fails closed (releasing the writer lock and closing child/store); `#recordCanonical` no longer silently drops events on a sealed store.
  3. **Removed unkeyed prompt/steer `payloadDigest` from canonical logs (`adapters/codex/develop-adapter.ts`):** Stopped persisting unkeyed SHA-256 prompt/steer digests in `codex.prompt-dispatched` / `codex.steer-dispatched` events (preventing low-entropy offline dictionary reversal in `<root>/events/events.log`).
  4. **Turn-dispatch & completion race hardening (`adapters/codex/develop-adapter.ts`):** Added synchronous `#promptInFlight` mutex preventing concurrent `dispatch({ kind: "prompt" })` races; added bounded `#completedTurns` map so same-chunk `turn/start` + `turn/completed` never resurrects a zombie `#activeTurn` and `waitForTurnCompletion()` returns the exact terminal state (`"completed" | "interrupted" | "failed"`).
  5. **Native approval binding & non-interactive reply path (`adapters/codex/develop-adapter.ts`):** `handleNativeApproval` now fails closed when `pending === undefined`, evaluates strictly against authoritative `pending.parsed.normalized` (never trusting caller-supplied fields), always passes `activeTurnId` (so idle-state approvals fail closed), restricts `knownKinds` to `CODEX_INTERACTIVE_APPROVAL_KINDS_V0`, requires `parsed.threadId === this.#threadId` (non-null), and routes all pending requests through one unified reply/cleanup/record path.
  6. **Serialized terminal prompt queue (`cli/codex.ts`):** Serialized all `rl.question()` calls (`codex>`, `approval>`, `native-approval>`) behind a single prompt queue with clean idle-REPL preemption so concurrent prompts never collide on stdin.
* **MEDIUM (9/9 remediated):**
  7. **Thread-scoped notification filtering & `serverRequest/resolved` handling (`adapters/codex/develop-adapter.ts`):** Filtered thread-scoped notifications (`item/*`, `turn/*`, `thread/*`, `serverRequest/resolved`) before `thread/start` or with missing/foreign `threadId`; emitted resolved native-approval observation + canonical event on `serverRequest/resolved`.
  8. **Closed-state & `rotateInstance()` ordering (`adapters/codex/develop-adapter.ts`):** Guarded `#onServerRequest`/`#onNotification` against post-close emission; `rotateInstance()` cancels pending native approvals before rotating `#instanceId`/`#guard`.
  9. **Pre-aborted `AbortSignal` enforcement (`adapters/codex/controller.ts`):** Checked `signal?.aborted` both before invoking `approveOperation` and after awaiting it before calling `adapter.dispatch()`.
  10. **C1 control & Unicode bidi stripping (`adapters/codex/native-approvals.ts`, `controller.ts`, `develop-adapter.ts`):** Stripped C1 controls (`\u0080-\u009f`) and bidi overrides (`\u202a-\u202e`, `\u2066-\u2069`) and bounded/sanitized untrusted Codex string fields (`threadId`, `turnId`, `itemId`, `method`, `toolName`, error info).
  11. **Safe integer validation on token usage (`adapters/codex/develop-adapter.ts`):** Switched token usage checks from `isFinite` to `Number.isSafeInteger`.
  12. **Exit-race & cleanup preservation (`adapters/codex/app-server-client.ts`, `develop-adapter.ts`):** Waited up to 50 ms on stdout `end` for `#group.exited` so exit code/signal is preserved; `close()` preserves earlier `#cleanup` when `rawCleanup === null` and emits `expected: true` `codex.connection-lost` only if previously connected.
  13. **CLI live containment & signal teardown (`cli/codex.ts`):** Wired `liveContainmentV0()` / `liveScopeV0()` in `endo codex check` and `endo codex session` plus `SIGINT`/`SIGTERM` graceful shutdown. Post-remediation offline recheck against `/usr/bin/codex` (`0.171.0`) confirmed `cleanup: { boundary: "scope", result: "confirmed", unit: "endo-live-..." }` and `effectivePolicy.ok: true` with zero model calls.
  14. **Neutral DEVELOP presentation invariants (`studio-ui/src/model/develop-session.ts`):** Gated `codexControl` on `connected && status.threadId !== null` and mapped `connection: "not-applicable"` to `"unknown"` when `observation.mode === "unavailable"`.
  15. **Writer-lock ownership token & atomic stale-lock quarantine (`storage/writer-lock.ts`):** Added random per-acquisition `token` checked on release so stale release closures cannot unlink a newer holder's lock; replaced racy stale-lock `rmSync` with atomic `renameSync` quarantine + dead-PID re-verification.
* **LOW (3/3 remediated):**
  16. **Runtime `reasoningEffort` validation (`cli/codex.ts`, `adapters/codex/develop-adapter.ts`):** Validated against `low | medium | high | xhigh | max | ultra` in both CLI flag parsing and adapter constructor/`open()`.
  17. **Duplicate-server-request & idle/missing-thread hardening (`adapters/codex/develop-adapter.ts`):** Verified single fail-closed handling and duplicate rejection without leaking state.
  18. **Expanded deterministic regression suite (`tests/develop-codex-live.test.ts`, `tests/fixtures/fake-codex-app-server.mjs`):** Added 30 total tests including real `PiAttachmentV0.openSession()` ↔ `CodexDevelopAdapterV0.open()` bidirectional contention, `duplicate-server-req`, `turn/steer`, all remaining fail-closed `ServerRequest` methods, `serverRequest/resolved`, sealed-store refusal, same-chunk `turn/completed(failed)`, concurrent prompt dispatch, pre-aborted `AbortSignal`, mock `ProcessScopeV0` cleanup, allowlist policy rejection variants, and `presentLiveCodex` edge states.
