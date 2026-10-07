# ACP v2 experimental conformance study

**Status: experimental. ACP v2 is a Draft protocol.** This study attaches Endophasia to ACP v2 agents over the *baseline*
v2 surface, pinned to one exact schema and SDK revision, and records what the mapping to Endophasia's event and lifecycle
contracts keeps and loses. It is evidence for a decision, not a production path: nothing here is stable, nothing in
`protocol/` or `runtime/` knows ACP exists, and the stable v1 adapter ([docs/acp-v1-slice.md](acp-v1-slice.md)) is
untouched.

## What is pinned

| | |
| --- | --- |
| Protocol | ACP v2, **Draft** (`protocolVersion: 2`) |
| SDK | `@agentclientprotocol/sdk` **1.7.0**, entry `@agentclientprotocol/sdk/experimental/v2` (imported by `adapters/acp/client-v2.ts` only) |
| Baseline schema | `adapters/acp/schema-v2/schema.json`, **vendored**, sha256 `98b51a64b02e757e013948d88b73d990b4ad11b507d8a3dfd6fcd7f9f3b08dee` |
| Upstream revision | `agentclientprotocol/agent-client-protocol` commit `836266379de98194b848b897207939d19d240a9d`, path `schema/v2/schema.json` |
| SDK's layered schema | `@agentclientprotocol/sdk/schema/v2/schema.unstable.json`, sha256 `75b2aa359dd26cd9d0468674be96482b14a2d181bc8e3ea8c91a8e598f63e3b5` (byte-identical to that upstream commit's `schema.unstable.json`) |
| Mapping | `acp-v2-mapping.0` |

**Why the baseline is vendored.** The migration guide says the baseline lives in `schema/v2/schema.json` and draft
features in `schema/v2/schema.unstable.json`. SDK 1.7.0 publishes only the second, which layers every UNSTABLE feature
over the baseline and is not what a baseline-only claim can validate against. The study therefore commits the upstream
baseline file, taken from the commit that the SDK's own layered schema is byte-identical to (found by comparing digests
across the upstream history of that file), and pins both. "Baseline" means that file, not "the layered schema minus what is
marked UNSTABLE": the markers are not uniform (`plan_update` is baseline and unmarked; `PlanFile` and `PlanMarkdown` are
marked), and the two sets are asserted apart in `tests/acp-v2-schema.test.ts`. A future SDK update changes the layered
schema's digest and fails that test; it cannot silently change what this study means.

The vendored baseline validates every message this client reads (`adapters/acp/schema-v2.ts`). Validation is stricter
than the reference deserializer, which drops a bad optional field and skips a bad list item
(`x-deserialize-default-on-error`, `x-deserialize-skip-invalid-items`): here the **raw** wire value is validated, taken off
the stream before the SDK parses it, so a response the SDK would have repaired is a protocol fault instead (the test suite
shows this for `session/list` and `session/resume`).

## Supported baseline surface

Negotiation (`initialize`, role-neutral `info`/`capabilities`) and the seven baseline session methods as one contract:
`session/new`, `session/list`, `session/resume`, `session/close`, `session/prompt`, `session/cancel`, `session/update`;
plus the client-side `session/request_permission`. Update variants translated: `user_message[_chunk]`,
`agent_message[_chunk]`, `agent_thought[_chunk]`, `state_update`, `tool_call_update`, `tool_call_content_chunk`,
`terminal_update`, `terminal_output_chunk`, `plan_update`, `available_commands_update`, `config_option_update`,
`session_info_update`, `usage_update` (the sixteen baseline variants).

An agent advertising `capabilities.session` as an object (`{}` included) is treated as supporting the whole baseline
session surface; absent or `null` means no session surface and the client fails closed before `session/new`. Optional and
unstable capabilities (`delete`, `additionalDirectories`, `fork`, `providers`, `nes`, `positionEncoding`) are never
inferred or called; if advertised they are recorded by name as ignored.

## Explicitly not supported

| surface | why |
| --- | --- |
| session/delete, session/fork | optional or unstable: not advertised-gated here and never called |
| session/set_config_option | a baseline method name, but configuration is observation only: no control path |
| auth/login, auth/logout | no authentication flow; an agent that requires one refuses session/new, which is recorded |
| elicitation/* | not advertised by the client, so never requested |
| fs/*, terminal/* | not served; agent-owned terminals are display-only updates |
| additionalDirectories | an optional session capability: never sent |
| providers/*, nes/*, document/*, mcp/message | UNSTABLE upstream and absent from the baseline |
| session/update variants only in the SDK's layered schema | plan_removed, notice, compaction_*, subagent_update, session_message*: observed by name and digest only |
| session/load | removed in v2; session/resume with replayFrom replaces it |

Nothing is implemented merely to raise coverage. Unsupported is not lossy: nothing is projected and nothing is called.

## v1 and v2 coexistence and negotiation

The versions are separate modules: `client.ts` speaks v1 only and is unchanged; `client-v2.ts` speaks v2 only. The v2
client requests `protocolVersion: 2` and accepts only 2; any other answer is a typed `AcpVersionNegotiationErrorV0`
(`agent-answered-v1`, `unsupported-version` or `incoherent`) plus a recorded `unsupported-protocol-version` fault, and no
session opens. The answer is classified from the raw wire message, because the SDK's own failure for a v1-shaped answer is
an uninformative schema error. The v1 client likewise refuses a v2 answer.

Falling back to v1 is a separate, opt-in operation (`connectAcpNegotiatedV0`, `adapters/acp/negotiate.ts`). It happens only
when the caller supplied v1 options **and** the agent answered exactly `1`; anything else is thrown, never retried. It is
a **relaunch**, not a continuation: the SDK's v2 client cannot continue a connection the agent answered in v1, and v1 must
stay what it was, so the agent is closed and launched again. The agent therefore sees a v2 `initialize` first and a fresh
v1 one second. A request for history replay is refused rather than downgraded (v1 `session/resume` cannot replay).

## Prompt lifecycle: accepted is not completed

ACP v1 kept `session/prompt` pending until the turn ended. In v2 the response means only that the message was inserted
into the conversation (`{ messageId }`); foreground work is reported separately by `state_update` (`running`,
`requires_action`, `idle` with an optional `stopReason`). The mapping follows that and invents no turn:

- `prompt()` resolves on **acceptance** with the message id and a `completed` promise; no lifecycle event is derived from
  the acceptance (`agent.prompt-accepted` is recorded alone).
- The run **starts on the agent's `running`** (`lifecycle.run-started`, basis `agent-state-update`) and **ends on its next
  `idle`**. `completed` settles on that idle, rejects on exit or close, and times out without inventing an end.
- Idle with `end_turn` is `run-completed`; `cancelled` is `run-aborted`; `max_tokens`, `max_turn_requests`, `refusal`, any
  custom stop reason (and the `error` the migration prose mentions, which the baseline schema does not list) are
  `run-unclassified`. An idle with no stop reason, or with a stop reason but no preceding `running`, is `run-unclassified`
  and never a completion. An idle that ended nothing is recorded only.
- A `state_update` carries no message or run id, so attributing an idle to a prompt is **by order only**
  (`attribution: client-prompt-by-order`); foreground work the client did not request is a run with attribution `none`.
  The unavailable-field declaration says so, and no run id or turn id is made up.
- The `user_message` echo may arrive before or after the response; both orders are tested. Custom or unstable states
  (including `unknown`) are observed, never interpreted. Replayed states are history and drive nothing. Cancellation sends
  `session/cancel`, answers pending permission requests `cancelled`, and ends on the agent's idle; an agent that never goes
  idle leaves the run open (timeout), not aborted.

## Resume and replay

`session/resume` without `replayFrom` must not replay; any message traffic before the response is a recorded
`history-replayed-without-request` fault and is applied to no state. With `replayFrom: { type: "start" }` the agent must
replay retained history as `session/update`s **before responding**; the client treats everything before the response, in
wire order, as replay, and reconstructs it into a state separate from live state. Every event recorded while the replay is in flight (a replayed tool-call completion, say) carries `phase: replay`, so it is not read as a second live one. Updates after the response are live, even
if an agent wrongly sends history there (indistinguishable, and tested as such).

**Reconstruction** (`adapters/acp/conversation-v2.ts`, in memory, digests only, bounded): messages and thoughts keyed by
`messageId` (an `*_message` content array replaces everything accumulated, chunks included; `null` clears; omitted is
unchanged; chunks append; one id is one kind); tool calls keyed by `toolCallId` (patch semantics; `null` and `[]` clear;
content chunks append).

**Equivalence** (`compareAcpV2ReplayV0`): a replay is equivalent to the live session iff (1) neither reconstruction
recorded a contradiction or hit a bound; (2) every replayed message exists live with the same kind and the same canonical
content, and no message is invented; (3) replayed messages appear in the live first-appearance order; (4) every replayed
tool call exists live with an identical reconstructed record. Messages the live session had and the replay lacks are
allowed and reported (`liveOnly`): ACP does not require an agent to retain everything, and live-only messages may be
absent. Byte-identical update streams are not required: whole messages, an empty message followed by chunks, repeated
upserts and a stale chunk later replaced are all equivalent when they reconstruct the same state, and are tested so.
Malformed, contradictory, mutated, retyped and invented replays are rejected.

## Permission safety

The v2 request carries a required `title`, optional `description` and optional structured `subject`, kept apart from any
tool call's displayed state. None of that copy, no command, no working directory and no option label ever enters an event.
Behaviour is default deny / fail closed, as in v1:

- no handler: the agent's own `reject_once` is selected; with none offered, a JSON-RPC error (the agent gets no approval and no false cancellation: `cancelled` means work was cancelled, and is returned only when it was, or as the handler's own explicit decision);
- a handler may select **only an offered option id**; anything else, a throwing handler, ambiguous (duplicate) option ids,
  a run being cancelled, or a closing session selects nothing: `cancelled` when work is being cancelled or the
  session is closing or gone, otherwise the JSON-RPC error above;
- subjects `none`, `tool_call` and `command` reach the handler; a **custom (`_`-prefixed) or future subject is never
  shown to the handler and never approved**; a request the baseline rejects (including a known subject type that fails its
  definition, such as a command without `cwd`) is refused with JSON-RPC invalid-params and recorded as `malformed`;
- cancelling work answers every pending request `cancelled`, even if the handler later approves;
- a command subject is evidence for the operator's decision. **Endophasia never executes it** (tested with a sentinel
  command and an approving handler). Permission authorizes the agent to run it, not Endophasia.

## Loss accounting

`adapters/acp/loss-v2.ts` is the machine-readable table (separate from v1's, same four verdicts), checked by
`tests/acp-v2-loss-accounting.test.ts` against the vendored baseline: every baseline update variant, every event kind the v2
sources can emit and every definition the client reads has an entry, and every baseline property an entry does not
project is listed in `lost` by construction. This document's table is checked against it.

| id | verdict | source | preserved | lost | qualification |
| --- | --- | --- | --- | --- | --- |
| `negotiation.initialize` | QUALIFIED | initialize (protocolVersion 2, role-neutral info and capabilities) | the negotiated protocolVersion (2); agent-reported name and version (by reference); capabilities (verbatim up to 8 KiB, always a digest); auth method ids; the session surface this client will use, and the optional or unstable capabilities it ignored, by name | auth method names; capability fields over the size bound; info.title | `info` is the agent's own claim, not a verified identity of the executable. Only protocolVersion 2 is accepted: any other answer is a recorded unsupported-protocol-version fault and a typed error, never a reinterpretation. |
| `negotiation.v1-fallback` | QUALIFIED | initialize answered with protocolVersion 1 to an offer of 2 | the offered and the answered version; that the v2 attempt ended before any session was opened | — | opt-in, and a relaunch: the agent is closed and launched again, so it sees a v2 initialize first and a fresh v1 one second. It is not a continuation of the same connection, and a request for history replay is refused rather than downgraded. |
| `capability.session-surface` | QUALIFIED | initialize response capabilities.session | baseline (an object, `{}` included) or none (absent or null); the names of optional session capabilities that were advertised and are not used | capability field values; the prompt and MCP capability objects | an advertised session surface is read as the seven baseline methods together (new, list, resume, close, prompt, cancel, update), not guessed per method; none means no session is opened. The baseline schema's own wording is inconsistent about this (AgentCapabilities.session lists four methods, SessionCapabilities lists seven); the seven-method reading follows SessionCapabilities and the migration guide. Optional and unstable capabilities are never inferred or called. |
| `session.identity` | QUALIFIED | ACP SessionId (agent-local opaque string) | the id, verbatim when short and printable, else a sha256 reference | — | an ACP session id is unique to nothing but the agent that issued it: the coordinate carries the launched process instance. No relation between coordinates is asserted. |
| `session.open.new` | QUALIFIED | session/new | session id reference; process instance; that the session was opened by session/new | working directory; mcp server list | ACP v2 reports no run id, turn id or turn count; they are declared UNAVAILABLE on lifecycle.session-started, never zero. |
| `session.open.resume` | QUALIFIED | session/resume (replayFrom omitted) | requested session id reference; that the session was opened by session/resume; historyReplay: not-requested | working directory; the relation to the earlier attachment | reattaches without replay; the agent MUST NOT replay history, and message traffic that arrives before the response is recorded as a protocol fault and not applied. The new process instance gets a new coordinate and lifecycle.session-started, not lifecycle.session-resumed: Endophasia holds no record of the earlier attachment under this coordinate. |
| `session.open.resume-replay` | QUALIFIED | session/resume (replayFrom: {type: start}) | that replay was requested; how many updates arrived before the response; per-message digests (replayState()); a `phase: replay` tag on every event recorded while the replay was in flight, so a replayed tool-call completion is not read as a second live one | message and tool-call content (held in memory for the comparison, never recorded); the replay's update order | replay is the updates received before the response; state replayed is reconstructed apart from live state and judged by equivalence (conversation-v2.ts), not by update bytes. A retained history may omit live-only messages, which is not a violation. Replay traffic after the response is indistinguishable from live traffic and is treated as live. |
| `session.list` | LOSSY | session/list | number of sessions in the page; whether a next cursor was reported; a JSON-RPC refusal, by code | session ids; working directories; additional directories; titles; update times; the cursor | the caller receives the agent-reported fields in returnedToCaller; the durable record keeps counts only. |
| `session.close` | QUALIFIED | session/close | that the client asked; that the agent answered without error | — | the agent must cancel the session's work as if session/cancel had been sent; a response is its acceptance, not proof that work stopped or resources were freed. Pending permission requests are answered cancelled. No lifecycle end is derived from the response. |
| `prompt.request` | QUALIFIED | session/prompt (client request) | that the client sent one prompt | the prompt text, by design | sending a prompt is not starting a run: ACP v2 has no run-start notification the client can wait for, and the run starts on the agent's own `running` state_update. |
| `prompt.accepted` | QUALIFIED | session/prompt response (messageId) | the id of the message the agent says it inserted (by reference); whether foreground work was already open | — | the agent MUST echo the message as a user_message in the live session (before or after the response); an accepted prompt whose echo never arrives is recorded as a `prompt-echo-missing` protocol fault once acceptance and the end of foreground work are both known, and changes no lifecycle outcome. Acceptance is NOT completion and NOT a run start: it says the prompt was inserted into the conversation, not that it was processed. No lifecycle run event is derived from it. The user_message update carrying the same id may arrive before or after the response; both orders are tolerated. |
| `prompt.refused` | LOSSY | session/prompt JSON-RPC error | the JSON-RPC error code | the error message and data | a refusal means the agent did not insert the message: no run is claimed and no lifecycle event is derived. A failure after acceptance is reported only by the agent's idle state_update, and the baseline stop reasons have no `error` (a custom stop reason is unclassified). |
| `prompt.timeout` | EXACT | the client's own bound on waiting for the agent's idle | the bound | — | — |
| `run.lifecycle` | QUALIFIED | state_update (running, idle with an optional stopReason) | running, requires_action and idle as reported; the reported stop reason; whether the client had requested a stop | the update's _meta; unstable idle usage | the run starts on `running` and ends on the next `idle`; foreground work the client did not request is a run too (attribution: none). An idle with a stop reason but no preceding running, or without a stop reason, is run-unclassified, never completed. Idle updates that end nothing (an initial idle) are recorded only. Replayed state_updates are history and drive nothing. Background activity while idle is not run activity. |
| `run.attribution` | UNREPRESENTABLE | which prompt or message a state_update belongs to | — | any link from an idle or a stop reason to a prompt, a message or a run id | a state_update carries no message id and ACP v2 has no run id: attributing an idle to a prompt can only be by order (the next idle after the prompt), which the run-started event states as `client-prompt-by-order`. No run id or turn id is invented. |
| `state.requires-action` | QUALIFIED | session/update:state_update (requires_action) | that the agent reported foreground work blocked on user action | what action it waits for (a permission request is separate evidence) | recorded as reported; it is not a lifecycle transition and is not taken as evidence that a permission request exists. |
| `state.unrecognized` | LOSSY | session/update:state_update (custom, future, or unstable `unknown` state) | that a state the baseline does not name was received; the state name when printable; a digest and size of the raw payload | the raw payload | never interpreted as foreground activity, and `unknown` (UNSTABLE upstream) is not translated. |
| `stop-reason` | QUALIFIED | IdleStateUpdate.stopReason | the reported stop reason | — | end_turn is the agent's report that work ended, not proof that provider work happened; cancelled is the agent's report and whether the operator's request caused it is not inferred; max_tokens, max_turn_requests, refusal and any custom reason are run-unclassified, not failures. |
| `cancel` | QUALIFIED | session/cancel (client notification) | that the client sent the notification while foreground work was open | — | a notification with no acknowledgement; the agent's answer is an idle state_update whose stop reason it should set to cancelled, and a run whose idle never arrives stays open (the wait is bounded by promptTimeoutMs). It names the session, not one run (stop.target is UNAVAILABLE). Pending permission requests are answered `cancelled`. |
| `conversation.reconstruction` | QUALIFIED | message upserts and chunks keyed by messageId; tool-call patches keyed by toolCallId | per messageId: kind, and a digest of the reconstructed content, in first-appearance order; per toolCallId: a digest of the reconstructed record; contradictions (one id under two kinds) | the content itself (never recorded); the order of chunks versus replacements | applied in received order: an `*_message` content array replaces everything accumulated (chunks included), null clears, an omitted content is unchanged, later chunks append; tool-call fields patch, null and [] clear. Bounded: past the bound the state claims nothing. In memory only; it is a comparison aid, not a durable record. |
| `replay.equivalence` | QUALIFIED | a replayed conversation versus the live session it replays | whether every replayed message and tool call matches the live one | messages the agent did not retain (reported as liveOnly, allowed) | equivalence is defined over reconstructed state, not update bytes: same kind and same canonical content for every replayed id, replayed ids in the live first-appearance order, no invented message, no contradiction. Absence is not a violation; the comparison says nothing about what both sides lack. |
| `replay.unrequested` | LOSSY | message updates received during session/resume without replayFrom | that history arrived without being asked for, and the variant | the replayed content (not applied to any state) | the agent MUST NOT replay on a resume without replayFrom; such updates are not applied. |
| `update.unrecognized` | LOSSY | session/update with a variant the baseline does not describe (unknown, `_`-prefixed, or unstable-only) | the variant name when printable; schemaStatus (unstable or unknown); a digest and size of the raw payload | the raw payload | observed, accounted for, and not interpreted: ACP says a receiver that does not understand a variant should preserve its raw payload where it stores or proxies history; Endophasia does neither, so it keeps a digest and the bytes are not retained. Nothing unstable is translated. |
| `update.malformed` | LOSSY | session/update that fails the baseline schema, or names no variant | that a malformed update arrived, and the variant when printable | the payload | recorded, never counted as activity, never repaired into evidence. |
| `permission.request` | LOSSY | session/request_permission | the subject kind; offered option kinds; whether a description was given; whether foreground work was open; whether the session matched | the permission title and description (copy); option ids and names | the title is required and the description optional, and both are prompt copy separate from any tool call's displayed state: neither is recorded. Authority is decided on the offered option kinds, never on the copy. |
| `permission.subject.tool_call` | LOSSY | RequestPermissionSubject type tool_call | that the subject is a tool call; its id (by reference) | the tool call's title, content, kind, status, locations and raw input and output | the embedded tool call is a display aid for the operator's handler (which receives the whole request), not evidence of what the tool will do. |
| `permission.subject.command` | LOSSY | RequestPermissionSubject type command | that the subject is a command; the associated tool call id (by reference) | the command text; its working directory; its terminal id | permission authorizes the AGENT to run the command; Endophasia never executes, shell-parses or validates it. The operator's handler receives it as text to decide on. |
| `permission.subject.unrecognized` | UNREPRESENTABLE | RequestPermissionSubject with a custom (`_`-prefixed) or future type | — | the subject's meaning | interpreting it would be claiming to understand an operation this client cannot read: it is recorded as subjectKind unrecognized, is never shown to the operator's handler, and is answered with the agent's own reject_once (else cancelled). It is never approved. |
| `permission.subject.malformed` | UNREPRESENTABLE | a session/request_permission whose shape the baseline rejects (including a subject of a known type that fails its definition) | — | everything the request claimed | a request that does not satisfy the baseline is not interpreted at all: recorded as subjectKind malformed, answered with a JSON-RPC invalid-params error (the SDK's own refusal, or this adapter's), never shown to the handler, never approved. |
| `permission.decision` | LOSSY | the permission response the client returned | selected, cancelled or error; the selected option's kind; decidedBy (adapter default or handler); whether a handler was consulted; the subject kind | the selected option id | fail-closed: absent a valid handler selection of an offered option the answer is the agent's reject_once; with none selectable and the work not being cancelled, a JSON-RPC error (the agent receives no approval and no false cancellation); cancelled only when work is being cancelled or the session is closing or gone, or as the handler's own explicit decision. A handler may select only an option actually offered; an unrecognized or malformed subject never reaches it. |
| `permission.outcome-cancelled` | QUALIFIED | RequestPermissionOutcome cancelled | that the request was answered cancelled | — | the baseline defines `cancelled` as "active session work was cancelled" and requires it for every pending request when work is cancelled. It is returned only when that is true (a stop requested, the session closing or gone) or as an explicit decision of the operator handler, which does not cancel the work: that outcome is the handler claim, not evidence that work was cancelled. |
| `message.late` | EXACT | traffic after the process exit, a stream close, close() or session close | the method; why it is late | — | — |
| `process.exit` | EXACT | the agent process ending | exit code or signal; whether it was expected; whether foreground work was open | — | — |
| `process.containment` | QUALIFIED | descendants of the agent process | a process group this attachment owns, ended on close() | — | on Windows the shared ProcessGroupV0 has no job-object containment: only the launched command is ended and descendants are not. On POSIX a descendant that deliberately leaves the group (setsid(2), or a child spawned detached) can survive close(). This study does not change either limit. |
| `update.user_message_chunk` | LOSSY | session/update:user_message_chunk | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.user_message` | LOSSY | session/update:user_message | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.agent_message_chunk` | LOSSY | session/update:agent_message_chunk | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.agent_message` | LOSSY | session/update:agent_message | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.agent_thought_chunk` | LOSSY | session/update:agent_thought_chunk | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.agent_thought` | LOSSY | session/update:agent_thought | that the update occurred, counted per variant; per-message digests in memory (conversation.reconstruction) | the content; content block types | text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction. |
| `update.state_update` | QUALIFIED | session/update:state_update | see run.lifecycle | see run.lifecycle | the entry for this variant's semantics is run.lifecycle, state.requires-action and state.unrecognized. |
| `update.tool_call_content_chunk` | LOSSY | session/update:tool_call_content_chunk | that a chunk occurred; the reconstructed tool-call digest in memory | the content | — |
| `update.tool_call_update` | LOSSY | session/update:tool_call_update | tool call id (reference); tool name (by reference), kind and status when reported; content and location counts; whether raw input / output were carried | title; content; locations; raw input and output values | an upsert patch: an absent field means unchanged, an explicit null clears it, and `content: []` and `null` both clear. |
| `update.terminal_update` | LOSSY | session/update:terminal_update | terminal id (reference); whether it exited or had its exit status cleared; whether output was carried or cleared | the command; the working directory; the output bytes; the exit code and signal | an agent-owned, display-only terminal: Endophasia holds no terminal, serves no terminal/* method, and runs nothing. |
| `update.terminal_output_chunk` | LOSSY | session/update:terminal_output_chunk | that a chunk occurred, counted per variant | the bytes; the terminal id | — |
| `update.plan_update` | LOSSY | session/update:plan_update | plan id (reference); content type; for item plans: entry count and counts by status | entry text; priorities | file and markdown plan content are UNSTABLE upstream and are counted by type only. |
| `update.available_commands_update` | LOSSY | session/update:available_commands_update | command count | command names, descriptions and input hints | — |
| `update.config_option_update` | QUALIFIED | session/update:config_option_update | config ids, kinds, categories, current values and choice counts (no labels) | option names and descriptions; choice values and labels | observed state after the agent changed its configuration, as the agent reports it (v2 names the option `configId`, not v1's `id`); not evidence of effect on later requests. |
| `update.session_info_update` | LOSSY | session/update:session_info_update | whether a title was set or cleared | the title; the update time | — |
| `update.usage_update` | QUALIFIED | session/update:usage_update | context tokens used; context window size; cumulative cost with its currency, when reported | — | session context-window state, not a per-run token ledger: the unstable per-run usage on an idle state_update is not read, and nothing is split into input, output, cache or reasoning tokens. |

`session.list` additionally returns the full validated page to the caller; the durable record keeps counts only
(`returnedToCaller` in the table).

## Deterministic conformance evidence

No live provider is needed. `tests/fixtures/fake-acp-v2-agent.ts` is a raw JSON-RPC fake agent (it imports nothing, so it
can send what an SDK agent would refuse to), driven by flags: version answers, session-surface variants, hold/cancel,
ack ordering, every stop reason, replay retention strategies and hostile replays, unknown/unstable/malformed updates, and
every permission subject. Suites: `tests/acp-v2-adapter.test.ts` (negotiation, fallback, surface, lifecycle, replay,
permissions, process ownership, and the v2 event streams reduced by the unchanged `reduceEndoSessionOverviewV0` with no anomalies), `tests/acp-v2-conversation.test.ts` (reconstruction and equivalence, no process),
`tests/acp-v2-schema.test.ts` (pins and baseline validation), `tests/acp-v2-loss-accounting.test.ts`, and the amended
`tests/acp-boundary.test.ts`. The v1 suites are unchanged. Mutation checks performed for this study are listed in the pull
request description.

## Known limitations

- **Draft.** The baseline can change; the pin is the only thing that keeps this study's meaning fixed, and a bump is a
  deliberate re-study.
- **Fallback is a relaunch** (above): the agent is launched twice.
- **Replay after the response is live**, by definition; a misbehaving agent that replays late is not detected as one.
- **Equivalence is over digests held in memory** for one process; the durable record has none of the content, so it cannot
  re-judge a replay later.
- **Baseline wording is inconsistent upstream**: `AgentCapabilities.session` lists four methods where
  `SessionCapabilities` and the migration guide list seven. The seven-method reading is followed.
- **`AbsolutePath` is a plain string in the schema**; "must be absolute" is prose. The schema is not strengthened, and a
  command's `cwd` is never acted on.
- **64-bit integers** beyond 2^53 are rejected as not exactly representable (never rounded into evidence).
- **No real-agent smoke** is part of the acceptance. As a record only: the OpenCode installed when this was written
  (`opencode` 2.0.23, `opencode acp`, no experimental flag) answers `protocolVersion: 1` to an offer of 2, so the v2
  client refuses it with `agent-answered-v1` (observed once, by hand; no session was opened and nothing was forced into
  v2). Its work-in-progress v2 support sits behind a feature flag that was not tried.
- Windows descendant containment is unchanged from v1 (`process.containment`).
