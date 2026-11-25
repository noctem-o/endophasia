# DEVELOP-ADAPTER-CONTRACT-001: harness-neutral operational adapter contract

* **Status:** implemented (`endo.develop-adapter.v0`). Pi is the reference live integration; Codex App Server (`codex-cli 0.171.0` schemas inspected offline) is the second design reference, exercised via a test-only deterministic conformance specimen. No live Codex adapter is implemented in this milestone.
* **Builds on:** runtime fingerprinting and capability evidence ([../attachment.md](../attachment.md), `protocol/harness.ts`), upstream assessment ([../harness-upgrades.md](../harness-upgrades.md), `runtime/contracts/harness-assessment.ts`), the canonical session lifecycle (`protocol/session-lifecycle.ts`, `protocol/session-overview.ts`), the live Pi workbench ([../develop-workbench.md](../develop-workbench.md)), live process containment ([../live-process-containment.md](../live-process-containment.md)), the neutral DEVELOP presentation surface ([../develop-session-surface.md](../develop-session-surface.md), `protocol/develop-session.ts`), and ACP semantic loss accounting (`adapters/acp/loss.ts`, `adapters/acp/loss-v2.ts`).
* **Scope:** the smallest practical operational boundary (`protocol/develop-adapter.ts`, `runtime/contracts/develop-adapter.ts`), thin production Pi integration (`adapters/pi/develop-adapter.ts`, wired into `adapters/pi/workbench.ts`), a non-Pi Codex-shaped conformance specimen (`tests/fixtures/codex-adapter-specimen.ts`), and a reusable conformance suite (`tests/helpers/develop-adapter-conformance.ts`, `tests/develop-adapter-contract.test.ts`). No live Codex adapter, no Coordinator delegation/scheduling, no Studio UI redesign, no new database or competing capability registry.

## 1. Problem solved

`endo.develop-session-surface.v0` (`protocol/develop-session.ts`) already solves harness-neutral **presentation** in DEVELOP: it distinguishes live vs recorded vs unavailable observations, direct vs external vs imported ownership, observed vs reported vs recorded claims, and supported vs unsupported vs unavailable capabilities. By design, it is not durable evidence and grants no authority.

Beneath that presentation layer, live operation remained coupled to Pi RPC (`PiSessionAttachmentV0` and `WorkbenchBrokerV0`). Adding a second real live harness—specifically Codex App Server—without an explicit operational boundary risked either:

1. duplicating authority, capability-evidence, and lifecycle checks inside each adapter, or
2. flattening Codex's thread/turn/item and server-initiated approval protocol onto Pi's session-oriented RPC model.

`endo.develop-adapter.v0` introduces the smallest operational contract beneath the presentation layer so that multiple live harnesses can share **authority enforcement, identity/staleness rules, evidence standing, and conformance testing** while **preserving their real native differences**.

## 2. Existing contracts that remain authoritative

This contract adds no competing registry, event store, or authority provider:

| Concern | Authoritative existing contract | Role in `endo.develop-adapter.v0` |
| :--- | :--- | :--- |
| Runtime identity & fingerprints | `protocol/harness.ts` (`endo.harness-fingerprint.v0`/`v1`) | Referenced by `runtimeFingerprint`; digests on different bases remain incomparable; reduced-confidence identities never carry evidence across observations. |
| Capability evidence & derivation | `protocol/harness.ts` (`endo.capability-evidence.v0`, `endo.capability-state.v0`), `runtime/contracts/harness-assessment.ts` | Validated directly by `endoDevelopCapabilityFromStateV0`; never replaced by a parallel registry. |
| Canonical durable events & lifecycle | `protocol/event.ts`, `protocol/session-lifecycle.ts`, `protocol/session-overview.ts` | Durable evidence remains unchanged; live adapter observations never overwrite canonical evidence. |
| Workbench prompt & intervention chains | `protocol/workbench.ts`, `protocol/intervention.ts`, `adapters/pi/workbench.ts`, `adapters/pi/workbench-interventions.ts` | Preserved intact; Pi's broker enforces the operational adapter gate at prompt dispatch without altering wire routes or record chains. |
| Bounded session control & execution protection | `runtime/contracts/session-control.ts`, `runtime/contracts/execution-protection.ts` | Reused directly by `endoEvaluateDevelopAdmissionV0`; Pi Everyday session-grant eligibility is never generalized to non-Pi runtimes. Workstation H0 remains **BLOCKED**. |
| Process containment & cleanup | `adapters/rpc-jsonl/process-group.ts` (`ProcessCleanupV0`), `docs/live-process-containment.md` | Surfaced explicitly via `processCleanup` (`scope`/`process-group`/`unverified`); process exit or connection loss is never conflated with confirmed cleanup. |
| DEVELOP presentation surface | `protocol/develop-session.ts`, `studio-ui/src/model/develop-session.ts` | Unchanged; remains strictly decoupled from operational code (`adapters/` and `runtime/` never import `protocol/develop-session.ts`). |
| Coordinator read-only status & briefing | `protocol/coordinator-status.ts`, `runtime/contracts/coordinator-brief.ts` | Unchanged; read-only standing preserved. |

## 3. Pi vs Codex comparative capability matrix

Grounded in:

* **Pi:** repository code (`adapters/pi/rpc.ts`, `adapters/pi/attachment.ts`, `adapters/pi/capabilities.ts`, `adapters/pi/evidence.ts`, `adapters/pi/workbench.ts`), local Pi binary observed at `1.6.0` (`/usr/bin/pi`), real-study baseline `1.0.1` (and historical `1.0.0` recording).
* **Codex App Server:** official documentation (`openai/codex` `codex-rs/app-server/README.md`, "Unlocking the Codex harness") and locally installed `codex-cli 0.171.0` (`/usr/bin/codex`) TypeScript schema generated offline via `codex app-server generate-ts` into a disposable scratch directory. **No live Codex App Server session or authenticated provider call was run.**

Standing labels kept strictly separate: **Documented** (upstream docs / generated schema) · **Observed** (seen on an installed binary) · **Tested** (exercised by deterministic tests/specimen) · **Admitted** (current conformance evidence permits operational use) · **Unsupported / Unestablished**. Documentation alone never admits a capability.

| Capability / Semantic | Pi (`pi --mode rpc`) | Codex App Server (`codex-cli 0.171.0` schema) | How `endo.develop-adapter.v0` preserves the difference |
| :--- | :--- | :--- | :--- |
| Transport & handshake | NDJSON stdio RPC (`pi --mode rpc`), `get_state` on open. **Admitted** (reference). | JSON-RPC 2.0 (`stdio://`, `unix://`, `ws://`), explicit `initialize` → `InitializeResponse`. **Documented / Observed in schema / Tested in specimen only** (not admitted live). | Adapter owns transport and handshake; contract models `connection` (`connected`/`disconnected`/`reconnecting`/`unknown`) independently of session state. |
| Session / Thread identity | Single persistent session per process (`--session-id`); `endo.session.pi.<id>`. **Admitted (exact)**. | Multiplexed `Thread` (UUIDv7 `threadId`, shared `sessionId` tree, `forkedFromId`, `parentThreadId`), `thread/start`, `thread/resume`, `thread/read`, `thread/list`. **Documented / Observed in schema / Specimen-tested**. | `session.nativeRef` distinguishes `pi-session` vs `codex-thread` (`threadId`, `sessionTreeId`); global identity key is always source-qualified `<source>:<scope>:<id>`; `alias` is display-only. |
| Run / Turn identity | None supplied by Pi RPC (`turnId: null`). **Unavailable** (static-surface). | Explicit UUIDv7 `Turn.id` returned by `turn/start`, tracked through `turn/started` → `turn/completed` (`completed`/`interrupted`/`failed`/`inProgress`). **Documented / Observed in schema / Specimen-tested**. | `activeTurn.turnId` and `dispatch().turnId` are nullable (`string \| null`); never fabricated for Pi, preserved verbatim for Codex. |
| Prompt / Turn start | `prompt` (idle-only in workbench; returns disposition `started`/`queued`/`handled`, no turn id). **Admitted** (baseline operator action). | `turn/start` (`{ threadId, input: UserInput[] }`), yields `turnId`. **Documented / Observed in schema / Specimen-tested** (not admitted live). | `operations.prompt` records `delivery` (`idle-only` vs `starts-turn`) and `yieldsTurnId`. |
| Steering | `steer` (in-turn after tool calls, before next model call; no receipt id, no target turn). **Admitted (partial)** after live study. | `turn/steer` (`{ threadId, input, expectedTurnId }`) requires active `expectedTurnId` precondition and fails on mismatch. **Documented / Observed in schema / Specimen-tested**. | `operations.steer` explicitly declares `delivery` (`in-turn-next-model-call` vs `active-turn-precondition`), `requiresTargetTurnId`, and `returnsReceiptId`. Admission gate enforces `targetTurnId` match when required. |
| Queue / Follow-up | `follow_up` (after current run has no more tool calls/steering; no receipt id). **Admitted (partial)** after live study. | No Pi-equivalent `follow_up` RPC; `thread/queue/changed` notification exists for server-side queue state. **Unsupported / Unestablished** as a direct follow-up verb. | `operations.queue` is explicitly `unsupported` on Codex specimen rather than aliasing `turn/steer` or fabricating parity. |
| Interruption / Stop | `abort` (untargeted session abort; Pi replies only once idle). **Admitted (partial)** after live study. | `turn/interrupt` (`{ threadId, turnId }`), explicitly targets one turn. **Documented / Observed in schema / Specimen-tested**. | `operations.stop` declares `targeting` (`untargeted-session-abort` vs `targeted-turn-interrupt`), `requiresTargetTurnId`, and `acknowledgementSemantics` (`on-idle` vs `on-interrupt-accepted`). |
| Resume | Persistent session reopened across restarts; live workbench `resume` **Unsupported**. | `thread/resume` (`{ threadId, excludeTurns? }`) with optional history hydration (`thread/turns/list`, `thread/items/list`). **Documented / Observed in schema / Specimen-tested**. | `operations.resume` records `mode` (`unsupported` vs `thread-resume`) and `replaysHistory` (`boolean \| "optional" \| "unknown"`). |
| Reasoning observation | Structured `thinking` content blocks (`raw-thinking`) or `redacted: true` (`redacted`). **Admitted** in private live transcript. | Separate `item/reasoning/summaryTextDelta` (`summary: string[]`) and `item/reasoning/textDelta` (`content: string[]`) on `ThreadItem` `reasoning`. **Documented / Observed in schema / Specimen-tested**. | `transcript` observations carry explicit `reasoningKind` (`raw-thinking` \| `reasoning-summary` \| `redacted` \| `unavailable`); a summary is never relabelled as raw thinking. |
| Tool / Item activity | `tool_execution_start` / `tool_execution_end` correlated by `toolCallId`. **Admitted (exact)** after live study. | Typed `ThreadItem` lifecycle (`item/started`, `item/completed`): `commandExecution`, `fileChange`, `mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`. **Documented / Observed in schema / Specimen-tested**. | `tool-activity` preserves `activityKind` (`tool-call`, `command-execution`, `file-change`, `mcp-tool`, `subagent-activity`), `itemId`/`callId`, and nullable `exitCode`. |
| Usage & Cost | Per-entry tokens + total USD cost (`get_entries`, `get_session_stats`). **Admitted** (exact per-entry, partial cost breakdown). | `thread/tokenUsage/updated` (`TokenUsageBreakdown`: input, cachedInput, cacheWriteInput, output, reasoningOutput, total; no USD cost). **Documented / Observed in schema / Specimen-tested**. | `usage` is `{ status: "reported"; value }` with nullable `costUsd` and `reasoningTokens`, or `{ status: "unavailable"; reason }`. Missing usage is never `0`. |
| Native approvals | `extension_ui_request` (`select`, `confirm`, `input`, `editor`)—cancelled automatically when unattended. **Observed / Implemented**. | Bidirectional `ServerRequest`: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`. **Documented / Observed in schema / Specimen-tested**. | `operations.nativeApprovals` + `endoEvaluateNativeApprovalV0`: fail closed on unknown kinds, never inherit prompt authority, never auto-approve, never broaden scope, never grant Endophasia authority. |
| Native commands | No dedicated programmatic slash-command RPC. **Unsupported**. | No dedicated typed slash-command RPC in `ClientRequest` (`thread/shellCommand` and `command/exec` are shell execution, explicitly refused as passthrough). **Unsupported**. | `operations.nativeCommand` (`allowsArbitraryShell: false`); unsupported native commands (e.g. `/voice on`) are refused as `native-command-unsupported`, never silently turned into ordinary prompt text. |
| Attachments | Message text only in Pi RPC. **Unsupported**. | Structured `UserInput` (`image`, `localImage`, `audio`, `localAudio`, `skill`, `mention`) and `thread/attachment/*`. **Documented / Observed in schema** (metadata described; delivery not implemented). | `operations.attachments` advertises supported kinds, delivery (`reference`/`embedded`), limits, `requiresExplicitAdmission: true`, and `allowsArbitraryPathRead: false`. |
| Coordination / Subagents | Single session, no native child threads. **Unsupported**. | `Thread.parentThreadId`, `collabAgentToolCall`, `subAgentActivity`. **Documented / Observed in schema / Specimen-tested** (read-only metadata only; delegation unsupported). | `coordination` exposes explicit attributed `parentSession`, `children`, and `taskBindings`; `delegationSupported: false`. Never inferred from names, paths, or timestamps. |
| Everyday session grant | Guarded local-model profile on pinned Pi 1.5.2 only (`DEVELOP-ISOLATE-003`). | **Not eligible / Unsupported.** | `everydayGrantEligible` is restricted by schema and gate to non-synthetic `pi` adapters with enforced workspace protection. |

## 4. Capability and authority semantics

The contract enforces the seven distinct facts structurally in `runtime/contracts/develop-adapter.ts`:

1. **Documented operation:** `documented-only` standing in `EndoAdapterCapabilityEntryV0`—never admitted.
2. **Evidence-backed standing:** `endoDevelopCapabilityFromStateV0` validates `endo.capability-state.v0` against the current `EndoHarnessFingerprintRecordV0` (refusing mismatched fingerprints, reduced-confidence carry-over across observations, stale evidence, and malformed/unknown claims). Only `admitted` and `admitted-partial` pass the capability check.
3. **Reachable current attachment:** `snapshot.connection.state === "connected"`, `ownership === "direct"`, and current `attachmentId` / `launchId` / `instanceId` / `projectScope`.
4. **Operator authorization:** `EndoDevelopAuthorityProofV0` bound to exact `operation`, `source`, `sessionKey` (never display `alias`), `attachmentId`, `launchId`, `instanceId`, `controlPath`, `projectScope`, canonical `payloadDigest`, `mechanism`, and `expiresAtMs`.
5. **Owning control-path admission:** `endoEvaluateDevelopAdmissionV0` refuses synthetic adapters in `"production"` mode, enforces source ownership of governed control paths (`pi-workbench-broker` → `pi-live` only), enforces native targeting preconditions (`targetTurnId`), and restricts `session-grant` strictly to Pi with observed workspace protection.
6. **Runtime acknowledgement:** `dispatch()` returns `{ status: "accepted", ..., consequenceObserved: false }`, `{ status: "refused", stage, code }`, or `{ status: "unknown", dispatched: true }` (on mid-request disconnect, timeout, or partial reply).
7. **Observed consequence:** Reported separately on the guarded observation stream (`EndoObservationGuardV0`), never claimed by dispatch acceptance.

### Native approval boundary (`endoEvaluateNativeApprovalV0`)

Harness-native approval requests (such as Codex's `item/commandExecution/requestApproval` or `item/fileChange/requestApproval`) are completely separate from Endophasia's prompt authorization:

* Missing operator decision → `declined` (`no-operator-decision`). Never auto-accepted.
* Prompt-derived basis → `declined` (`prompt-authority-not-inheritable`).
* Unknown or unlisted `approvalKind` → `declined` (`unknown-approval-kind`), even if an accept decision is supplied.
* Mismatched `requestId`, `source`, `sessionKey`, `instanceId`, `turnId`, or `itemId` → `declined` (`binding-mismatch` / `stale-attachment`).
* Scope broader than requested, or `session`/`policy-amendment` scope without explicit opt-in → `declined` (`scope-broadening-refused`).
* Every outcome carries `grantsEndophasiaAuthority: false`.

## 5. Production Pi integration

* `adapters/pi/develop-adapter.ts` implements `PiDevelopAdapterV0` as a thin wrapper over `PiSessionAttachmentV0` and `WorkbenchSessionV0`.
* `adapters/pi/workbench.ts` (`WorkbenchBrokerV0`) constructs `this.adapter = new PiDevelopAdapterV0(...)`:
  * Every live Pi RPC event flows through `this.adapter.observePiLiveEvent(event)` into the guarded observation stream.
  * `endSession()` marks the adapter disconnected without fabricating confirmed process termination.
  * Each prompt proposal captures `instanceId = this.adapter.instanceId` at `#open()` time; before binding any attempt or calling `session.prompt(text)`, `#run()` verifies the exact authorization proof through `this.adapter.admitOperation(...)` (and re-verifies after any `provenance.take()` await). If the attachment instance rotated or prerequisites changed while awaiting terminal approval, dispatch is refused before touching Pi.
* Existing Pi HTTP routes, `endo.workbench.v0` records, intervention chains, pairing grants, session-control grants, and Studio UI remain unchanged.

## 6. Lifecycle, connection, and observation semantics

* **Connection vs session vs turn vs process:** `connection.state === "disconnected"` clears live `stateClaims` and refuses dispatch (`not-connected`), while leaving `processCleanup.result` as `"unverified"` until teardown verifies cleanup (`ProcessCleanupV0`).
* **Instance rotation:** Reconnect, process restart, or runtime replacement calls `rotateInstance()`, which immediately invalidates any prior `EndoDevelopAuthorityProofV0` (`stale-attachment`) and configures `EndoObservationGuardV0` to reject late observations from superseded instances as explicit `late-event-from-prior-attachment` evidence gaps.
* **Ordering & deduplication:** `EndoObservationGuardV0` ignores duplicate `observationId`s with an explicit `duplicate-event` gap and flags sequence regressions with `out-of-order-event` while preserving provenance.

## 7. Conformance methodology, compatibility, and versioning

* `tests/helpers/develop-adapter-conformance.ts` exports `runDevelopAdapterConformanceSuiteV0(driver)`, a reusable suite that executes identity, capability-evidence, operational-semantics, fault, observation-guard, native-approval, and authority tests at the operational boundary.
* `tests/develop-adapter-contract.test.ts` runs that same suite against both the production `PiDevelopAdapterV0` (including a real `PiSessionAttachmentV0` + fake-Pi child process test and `WorkbenchBrokerV0` test) and the test-only `CodexAdapterSpecimenV0`.
* Source guards verify `tests/fixtures/codex-adapter-specimen.ts` is never imported by any production module, `protocol/develop-adapter.ts` imports only `protocol/`, and `runtime/contracts/develop-adapter.ts` imports no adapter, storage, or presentation module.
* **Versioning:** `endo.develop-adapter.v0`, `endo.develop-adapter-descriptor.v0`, and `endo.develop-adapter-observation.v0` are in-process operational contracts (not durable store schemas). Breaking changes after the first live Codex integration will bump to `.v1` without altering persisted store records.

## 8. Remaining limitations

* **No live Codex implementation yet:** `CodexAdapterSpecimenV0` is deterministic fixture evidence only and does not prove compatibility with a live Codex App Server process or model provider.
* **Pi broker interventions (`steer`/`queue`/`stop`):** Still flow through `PiInterventionDeskV0` and `WorkbenchInterventionsV0`; `PiDevelopAdapterV0` supports gating them directly when called through `adapter.dispatch()`, while `WorkbenchBrokerV0` currently wires `adapter.admitOperation()` on the prompt path and live event observation to avoid rewriting the intervention desk.
* **Attachments & native commands:** Only capability metadata and fail-closed admission/refusal semantics exist in v0. No governed attachment delivery pipeline or native slash-command dispatcher is implemented yet.
* **UI coexistence:** `studio-ui` still presents a single live Pi workbench session; multi-adapter DEVELOP UI wiring is deferred until a second live adapter exists.

## 9. Concrete plan for `DEVELOP-CODEX-LIVE-001`

Goal: ship the **smallest useful live Codex App Server integration** without expanding scope into Coordinator delegation, multi-harness UI redesign, or Everyday session-grant relaxation.

1. **Transport (`adapters/codex/app-server-client.ts`):**
   * Spawn user-installed `codex app-server --listen stdio://` directly via `ProcessGroupV0` (with optional injected `ProcessScopeV0` for `LIVE-PROCESS-CONTAINMENT-001`; never through a shell, never installing/upgrading Codex, never connecting to an external daemon or `ws://` listener by default).
   * Strict JSON-RPC 2.0 NDJSON framing over stdin/stdout (stderr captured separately as diagnostics), bounded frame sizes, request-id correlation, and explicit handling of bidirectional `ServerRequest` messages.
2. **Version discovery, fingerprinting & schema compatibility (`adapters/codex/identity.ts`, `adapters/codex/checks.ts`):**
   * Fingerprint the installed `codex` executable (`realPath`, `entrypoint-sha256`, `codex --version`, plus explicit `runtimeContent` gap when Codex is a single standalone binary → `reduced` confidence unless a verified package layout exists, handled honestly per `protocol/harness.ts`).
   * Offline local protocol check (`codex app-server` `initialize` + `thread/list` / `config/read` with zero model calls): verify `InitializeResponse` shape, pin expected protocol methods against the observed `codex-cli` version, and record `endo.capability-evidence.v0` in the existing harness registry.
3. **Milestone 1 — Read-only observation:**
   * Implement `CodexDevelopAdapterV0` (`source: "codex-live"`, `synthetic: false`, `everydayGrantEligible: false`) behind `EndoDevelopLiveAdapterV0`.
   * Map `thread/started`, `turn/started`, `turn/completed`, `item/started`, `item/completed` (`agentMessage`, `reasoning` summary vs raw content, `commandExecution`, `fileChange`, `mcpToolCall`), and `thread/tokenUsage/updated` into both canonical durable events (`adapters/codex/mapping.ts` extension) and guarded `EndoDevelopObservationV0` records (text withheld from canonical evidence, kept memory-only for live view).
4. **Milestone 2 — Owned-thread lifecycle:**
   * Launch and own one fresh thread via `thread/start` with explicit `cwd` and conservative `approvalPolicy` (never silently attaching to or controlling externally started Codex threads; `thread/resume` opt-in and explicitly tracked).
   * Enforce clean shutdown (`thread/unsubscribe` + stdin close + `ProcessGroupV0.release()` / systemd scope cleanup reporting).
5. **Milestone 3 — Governed prompt dispatch & targeted interruption:**
   * Wire `turn/start` (`prompt`) and `turn/interrupt` (`stop`, requiring exact active `turnId`) behind strict controlling-terminal approval (`APPROVE PROMPT` / `APPROVE STOP`, Strict mode only—`everydayGrantEligible: false`).
   * Optional follow-on once verified by live study: `turn/steer` with mandatory `expectedTurnId` precondition.
6. **Milestone 4 — Fail-closed native approval handling:**
   * Route `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, and `item/permissions/requestApproval` through `endoEvaluateNativeApprovalV0`.
   * Default policy in initial slice: explicit one-time controlling-terminal operator approval (`accept` once / `decline` / `cancel`) or immediate fail-closed `decline` when unattended; refuse `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`, and any unknown `ServerRequest` method.
7. **Explicitly unsupported in `DEVELOP-CODEX-LIVE-001`:**
   * `queue` (no Pi-style `follow_up` equivalence).
   * `native-command` passthrough and arbitrary shell RPCs (`command/exec`, `thread/shellCommand`, `fs/*` host file writes).
   * Attachment file transfers (`localImage`/`localAudio` path ingestion deferred until explicit workspace-scoped admission is designed).
   * Everyday / session-grant mode (remains Strict-only).
   * Coordinator task delegation / subagent spawning.
8. **Required security & conformance tests:**
   * Run `runDevelopAdapterConformanceSuiteV0` directly against `CodexDevelopAdapterV0` backed by a deterministic fake Codex App Server child process over stdio.
   * Verify bidirectional `ServerRequest` approval isolation (prompt approval never authorizes command/file approval; unknown `ServerRequest` method fails closed; disconnect mid-turn returns `unknown`).
   * Verify import boundaries (`adapters/codex/` reaches no `adapters/pi/`, `protocol/` stays zero-dependency, no shell spawn, no private text in canonical event store).
   * Opt-in local offline smoke (`ENDO_CODEX_EXECUTABLE=/usr/bin/codex`, `initialize` only, zero provider calls) kept separate from deterministic CI tests.
