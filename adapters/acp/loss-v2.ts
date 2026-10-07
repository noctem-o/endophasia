// Explicit loss accounting for the ACP v2 (Draft, baseline) -> endo.* mapping (ACP_V2_MAPPING_VERSION), as data, beside
// loss.ts (v1) and independent of it: the two tables share a vocabulary and a shape, not entries. One entry per ACP v2
// semantic this study claims to understand, each with a verdict on the Endophasia target it is projected into.
//
// Verdicts (the whole vocabulary; nothing else is a verdict):
//   EXACT            the Endophasia target preserves every semantic fact that target contract needs.
//   QUALIFIED        the same concept is representable, but its evidence basis or scope differs; the qualification
//                    travels with the entry.
//   LOSSY            a valid projection exists, but known source information is intentionally omitted or collapsed.
//   UNREPRESENTABLE  mapping it would invent semantics or claim more than the source supports; the adapter emits no
//                    such projection and keeps only the honest ACP observation.
//
// "A TypeScript type fits" is not a verdict: a field is EXACT only if the Endophasia contract it lands in needs nothing
// the source meant and the projection dropped. Most entries here are not EXACT, because the event payloads deliberately
// keep identifiers, counts and digests and never text.
//
// The table is checked by tests/acp-v2-loss-accounting.test.ts against the vendored baseline: every baseline update
// variant, every event kind the v2 sources can emit, and every definition the client reads must have an entry.

import type { AcpAvailabilityV0, AcpLossEntryV0, AcpLossVerdictV0 } from "./loss.ts";
import {
	ACP_SCHEMA_V2,
	ACP_V2_BASELINE_UPDATE_VARIANTS_V0,
	assertAcpSchemaV2Pins,
	readAcpBaselineSchemaV2,
} from "./schema-v2.ts";
import { ACP_V2_MAPPING_VERSION } from "./translate-v2.ts";

export const ACP_V2_LOSS_ACCOUNTING_VERSION_V0 = "endo.acp-v2-loss-accounting.v0";

const baseline: AcpAvailabilityV0 = { kind: "baseline" };
const initiated: AcpAvailabilityV0 = { kind: "agent-initiated" };
const observed: AcpAvailabilityV0 = { kind: "adapter-observed" };

const UPDATE_TARGET = "session.update-observed";

const declared: readonly AcpLossEntryV0[] = [
	{
		id: "negotiation.initialize",
		projects: {
			InitializeResponse: ["protocolVersion", "info", "capabilities", "authMethods"],
			Implementation: ["name", "version"],
			AuthMethodAgent: ["methodId"],
			AuthMethodTerminal: ["methodId"],
		},
		source: "initialize (protocolVersion 2, role-neutral info and capabilities)",
		target: "harness.acp-initialized",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.acp-initialized", "harness.protocol-fault"],
		preserved: [
			"the negotiated protocolVersion (2)",
			"agent-reported name and version (by reference)",
			"capabilities (verbatim up to 8 KiB, always a digest)",
			"auth method ids",
			"the session surface this client will use, and the optional or unstable capabilities it ignored, by name",
		],
		lost: ["auth method names", "capability fields over the size bound", "info.title"],
		qualification:
			"`info` is the agent's own claim, not a verified identity of the executable. Only protocolVersion 2 is accepted: any other answer is a recorded unsupported-protocol-version fault and a typed error, never a reinterpretation.",
	},
	{
		id: "negotiation.v1-fallback",
		source: "initialize answered with protocolVersion 1 to an offer of 2",
		target: "harness.protocol-fault, then an ordinary v1 attachment (client.ts)",
		verdict: "QUALIFIED",
		availability: observed,
		emits: ["harness.protocol-fault"],
		preserved: ["the offered and the answered version", "that the v2 attempt ended before any session was opened"],
		lost: [],
		qualification:
			"opt-in, and a relaunch: the agent is closed and launched again, so it sees a v2 initialize first and a fresh v1 one second. It is not a continuation of the same connection, and a request for history replay is refused rather than downgraded.",
	},
	{
		id: "capability.session-surface",
		projects: {
			AgentCapabilities: ["session"],
			SessionCapabilities: ["delete", "additionalDirectories"],
		},
		source: "initialize response capabilities.session",
		target: "harness.acp-initialized (sessionSurface), control.unavailable",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.acp-initialized", "control.unavailable"],
		preserved: [
			"baseline (an object, `{}` included) or none (absent or null)",
			"the names of optional session capabilities that were advertised and are not used",
		],
		lost: ["capability field values", "the prompt and MCP capability objects"],
		qualification:
			"an advertised session surface is read as the seven baseline methods together (new, list, resume, close, prompt, cancel, update), not guessed per method; none means no session is opened. The baseline schema's own wording is inconsistent about this (AgentCapabilities.session lists four methods, SessionCapabilities lists seven); the seven-method reading follows SessionCapabilities and the migration guide. Optional and unstable capabilities are never inferred or called.",
	},
	{
		id: "session.identity",
		source: "ACP SessionId (agent-local opaque string)",
		target: "endo.session.acp.<instance>.<id> coordinate",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.attached", "lifecycle.session-started"],
		preserved: ["the id, verbatim when short and printable, else a sha256 reference"],
		lost: [],
		qualification:
			"an ACP session id is unique to nothing but the agent that issued it: the coordinate carries the launched process instance. No relation between coordinates is asserted.",
	},
	{
		id: "session.open.new",
		projects: {
			NewSessionRequest: ["cwd", "mcpServers"],
			NewSessionResponse: ["sessionId", "configOptions"],
		},
		source: "session/new",
		target: "harness.attached, lifecycle.session-started",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.attached", "lifecycle.session-started", "session.config-observed", "control.refused"],
		preserved: ["session id reference", "process instance", "that the session was opened by session/new"],
		lost: ["working directory", "mcp server list"],
		qualification:
			"ACP v2 reports no run id, turn id or turn count; they are declared UNAVAILABLE on lifecycle.session-started, never zero.",
	},
	{
		id: "session.open.resume",
		projects: {
			ResumeSessionRequest: ["sessionId", "cwd", "mcpServers", "replayFrom"],
			ResumeSessionResponse: ["configOptions"],
		},
		source: "session/resume (replayFrom omitted)",
		target: "harness.attached, lifecycle.session-started",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.attached", "lifecycle.session-started", "session.config-observed", "control.refused"],
		preserved: [
			"requested session id reference",
			"that the session was opened by session/resume",
			"historyReplay: not-requested",
		],
		lost: ["working directory", "the relation to the earlier attachment"],
		qualification:
			"reattaches without replay; the agent MUST NOT replay history, and message traffic that arrives before the response is recorded as a protocol fault and not applied. The new process instance gets a new coordinate and lifecycle.session-started, not lifecycle.session-resumed: Endophasia holds no record of the earlier attachment under this coordinate.",
	},
	{
		id: "session.open.resume-replay",
		source: "session/resume (replayFrom: {type: start})",
		target: "harness.attached (historyReplay, replayedUpdates), the in-memory replay reconstruction",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.attached", "session.state-conflict"],
		preserved: [
			"that replay was requested",
			"how many updates arrived before the response",
			"per-message digests (replayState())",
			"a `phase: replay` tag on every event recorded while the replay was in flight, so a replayed tool-call completion is not read as a second live one",
		],
		lost: [
			"message and tool-call content (held in memory for the comparison, never recorded)",
			"the replay's update order",
		],
		qualification:
			"replay is the updates received before the response; state replayed is reconstructed apart from live state and judged by equivalence (conversation-v2.ts), not by update bytes. A retained history may omit live-only messages, which is not a violation. Replay traffic after the response is indistinguishable from live traffic and is treated as live.",
	},
	{
		id: "session.list",
		projects: {
			ListSessionsRequest: ["cwd", "cursor"],
			ListSessionsResponse: ["sessions", "nextCursor"],
			SessionInfo: ["sessionId", "cwd", "additionalDirectories", "title", "updatedAt"],
		},
		source: "session/list",
		target: "session.listed",
		verdict: "LOSSY",
		availability: baseline,
		emits: ["session.listed", "control.refused"],
		preserved: [
			"number of sessions in the page",
			"whether a next cursor was reported",
			"a JSON-RPC refusal, by code",
		],
		lost: ["session ids", "working directories", "additional directories", "titles", "update times", "the cursor"],
		returnedToCaller: [
			"SessionInfo.sessionId",
			"SessionInfo.cwd",
			"SessionInfo.additionalDirectories",
			"SessionInfo.title",
			"SessionInfo.updatedAt",
			"ListSessionsResponse.nextCursor",
		],
		qualification:
			"the caller receives the agent-reported fields in returnedToCaller; the durable record keeps counts only.",
	},
	{
		id: "session.close",
		projects: { CloseSessionRequest: ["sessionId"] },
		source: "session/close",
		target: "control.requested, session.close-accepted",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["control.requested", "lifecycle.stop-requested", "session.close-accepted", "control.refused"],
		preserved: ["that the client asked", "that the agent answered without error"],
		lost: [],
		qualification:
			"the agent must cancel the session's work as if session/cancel had been sent; a response is its acceptance, not proof that work stopped or resources were freed. Pending permission requests are answered cancelled. No lifecycle end is derived from the response.",
	},
	{
		id: "prompt.request",
		source: "session/prompt (client request)",
		target: "control.requested",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["control.requested"],
		preserved: ["that the client sent one prompt"],
		lost: ["the prompt text, by design"],
		qualification:
			"sending a prompt is not starting a run: ACP v2 has no run-start notification the client can wait for, and the run starts on the agent's own `running` state_update.",
	},
	{
		id: "prompt.accepted",
		projects: { PromptResponse: ["messageId"] },
		source: "session/prompt response (messageId)",
		target: "agent.prompt-accepted",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["agent.prompt-accepted"],
		preserved: [
			"the id of the message the agent says it inserted (by reference)",
			"whether foreground work was already open",
		],
		lost: [],
		qualification:
			"the agent MUST echo the message as a user_message in the live session (before or after the response); an accepted prompt whose echo never arrives is recorded as a `prompt-echo-missing` protocol fault once acceptance and the end of foreground work are both known, and changes no lifecycle outcome. Acceptance is NOT completion and NOT a run start: it says the prompt was inserted into the conversation, not that it was processed. No lifecycle run event is derived from it. The user_message update carrying the same id may arrive before or after the response; both orders are tolerated.",
	},
	{
		id: "prompt.refused",
		source: "session/prompt JSON-RPC error",
		target: "agent.prompt-refused",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["agent.prompt-refused", "harness.protocol-fault"],
		preserved: ["the JSON-RPC error code"],
		lost: ["the error message and data"],
		qualification:
			"a refusal means the agent did not insert the message: no run is claimed and no lifecycle event is derived. A failure after acceptance is reported only by the agent's idle state_update, and the baseline stop reasons have no `error` (a custom stop reason is unclassified).",
	},
	{
		id: "prompt.timeout",
		source: "the client's own bound on waiting for the agent's idle",
		target: "harness.prompt-timeout",
		verdict: "EXACT",
		availability: observed,
		emits: ["harness.prompt-timeout"],
		preserved: ["the bound"],
		lost: [],
	},
	{
		id: "run.lifecycle",
		projects: { IdleStateUpdate: ["stopReason"] },
		source: "state_update (running, idle with an optional stopReason)",
		target: "agent.state-reported, lifecycle.run-started | run-completed | run-aborted | run-unclassified",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: [
			"agent.state-reported",
			"lifecycle.run-started",
			"lifecycle.run-completed",
			"lifecycle.run-aborted",
			"lifecycle.run-unclassified",
		],
		preserved: [
			"running, requires_action and idle as reported",
			"the reported stop reason",
			"whether the client had requested a stop",
		],
		lost: ["the update's _meta", "unstable idle usage"],
		qualification:
			"the run starts on `running` and ends on the next `idle`; foreground work the client did not request is a run too (attribution: none). An idle with a stop reason but no preceding running, or without a stop reason, is run-unclassified, never completed. Idle updates that end nothing (an initial idle) are recorded only. Replayed state_updates are history and drive nothing. Background activity while idle is not run activity.",
	},
	{
		id: "run.attribution",
		source: "which prompt or message a state_update belongs to",
		target: "(none)",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: ["any link from an idle or a stop reason to a prompt, a message or a run id"],
		qualification:
			"a state_update carries no message id and ACP v2 has no run id: attributing an idle to a prompt can only be by order (the next idle after the prompt), which the run-started event states as `client-prompt-by-order`. No run id or turn id is invented.",
	},
	{
		id: "state.requires-action",
		source: "session/update:state_update (requires_action)",
		target: "agent.state-reported",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: ["agent.state-reported"],
		preserved: ["that the agent reported foreground work blocked on user action"],
		lost: ["what action it waits for (a permission request is separate evidence)"],
		qualification:
			"recorded as reported; it is not a lifecycle transition and is not taken as evidence that a permission request exists.",
	},
	{
		id: "state.unrecognized",
		source: "session/update:state_update (custom, future, or unstable `unknown` state)",
		target: "runtime.unrecognized-event, lifecycle.unrecognized-runtime-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.unrecognized-event", "lifecycle.unrecognized-runtime-event"],
		preserved: [
			"that a state the baseline does not name was received",
			"the state name when printable",
			"a digest and size of the raw payload",
		],
		lost: ["the raw payload"],
		qualification: "never interpreted as foreground activity, and `unknown` (UNSTABLE upstream) is not translated.",
	},
	{
		id: "stop-reason",
		source: "IdleStateUpdate.stopReason",
		target: "lifecycle.run-completed | run-aborted | run-unclassified",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: ["lifecycle.run-completed", "lifecycle.run-aborted", "lifecycle.run-unclassified"],
		preserved: ["the reported stop reason"],
		lost: [],
		qualification:
			"end_turn is the agent's report that work ended, not proof that provider work happened; cancelled is the agent's report and whether the operator's request caused it is not inferred; max_tokens, max_turn_requests, refusal and any custom reason are run-unclassified, not failures.",
	},
	{
		id: "cancel",
		source: "session/cancel (client notification)",
		target: "control.requested, lifecycle.stop-requested",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["control.requested", "lifecycle.stop-requested"],
		preserved: ["that the client sent the notification while foreground work was open"],
		lost: [],
		qualification:
			"a notification with no acknowledgement; the agent's answer is an idle state_update whose stop reason it should set to cancelled, and a run whose idle never arrives stays open (the wait is bounded by promptTimeoutMs). It names the session, not one run (stop.target is UNAVAILABLE). Pending permission requests are answered `cancelled`.",
	},
	{
		id: "conversation.reconstruction",
		projects: {
			ContentChunk: ["messageId", "content"],
			UserMessage: ["messageId", "content"],
			AgentMessage: ["messageId", "content"],
			AgentThought: ["messageId", "content"],
			ToolCallContentChunk: ["toolCallId", "content"],
		},
		source: "message upserts and chunks keyed by messageId; tool-call patches keyed by toolCallId",
		target: "an in-memory per-message and per-tool-call digest (liveState(), replayState())",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: ["session.state-conflict"],
		preserved: [
			"per messageId: kind, and a digest of the reconstructed content, in first-appearance order",
			"per toolCallId: a digest of the reconstructed record",
			"contradictions (one id under two kinds)",
		],
		lost: ["the content itself (never recorded)", "the order of chunks versus replacements"],
		qualification:
			"applied in received order: an `*_message` content array replaces everything accumulated (chunks included), null clears, an omitted content is unchanged, later chunks append; tool-call fields patch, null and [] clear. Bounded: past the bound the state claims nothing. In memory only; it is a comparison aid, not a durable record.",
	},
	{
		id: "replay.equivalence",
		source: "a replayed conversation versus the live session it replays",
		target: "compareAcpV2ReplayV0 (a function over digests)",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: [],
		preserved: ["whether every replayed message and tool call matches the live one"],
		lost: ["messages the agent did not retain (reported as liveOnly, allowed)"],
		qualification:
			"equivalence is defined over reconstructed state, not update bytes: same kind and same canonical content for every replayed id, replayed ids in the live first-appearance order, no invented message, no contradiction. Absence is not a violation; the comparison says nothing about what both sides lack.",
	},
	{
		id: "replay.unrequested",
		source: "message updates received during session/resume without replayFrom",
		target: "harness.protocol-fault (history-replayed-without-request)",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["harness.protocol-fault"],
		preserved: ["that history arrived without being asked for, and the variant"],
		lost: ["the replayed content (not applied to any state)"],
		qualification: "the agent MUST NOT replay on a resume without replayFrom; such updates are not applied.",
	},
	{
		id: "update.unrecognized",
		source: "session/update with a variant the baseline does not describe (unknown, `_`-prefixed, or unstable-only)",
		target: "runtime.unrecognized-event, lifecycle.unrecognized-runtime-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.unrecognized-event", "lifecycle.unrecognized-runtime-event"],
		preserved: [
			"the variant name when printable",
			"schemaStatus (unstable or unknown)",
			"a digest and size of the raw payload",
		],
		lost: ["the raw payload"],
		qualification:
			"observed, accounted for, and not interpreted: ACP says a receiver that does not understand a variant should preserve its raw payload where it stores or proxies history; Endophasia does neither, so it keeps a digest and the bytes are not retained. Nothing unstable is translated.",
	},
	{
		id: "update.malformed",
		source: "session/update that fails the baseline schema, or names no variant",
		target: "runtime.malformed-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.malformed-event"],
		preserved: ["that a malformed update arrived, and the variant when printable"],
		lost: ["the payload"],
		qualification: "recorded, never counted as activity, never repaired into evidence.",
	},
	{
		id: "permission.request",
		projects: {
			RequestPermissionRequest: ["sessionId", "description", "subject", "options"],
			PermissionOption: ["optionId", "kind"],
		},
		source: "session/request_permission",
		target: "permission.requested",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["permission.requested", "harness.late-message"],
		preserved: [
			"the subject kind",
			"offered option kinds",
			"whether a description was given",
			"whether foreground work was open",
			"whether the session matched",
		],
		lost: ["the permission title and description (copy)", "option ids and names"],
		qualification:
			"the title is required and the description optional, and both are prompt copy separate from any tool call's displayed state: neither is recorded. Authority is decided on the offered option kinds, never on the copy.",
	},
	{
		id: "permission.subject.tool_call",
		projects: { ToolCallPermissionSubject: ["toolCall"], ToolCallUpdate: ["toolCallId"] },
		source: "RequestPermissionSubject type tool_call",
		target: "permission.requested (subjectKind, toolCallId)",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["permission.requested"],
		preserved: ["that the subject is a tool call", "its id (by reference)"],
		lost: ["the tool call's title, content, kind, status, locations and raw input and output"],
		qualification:
			"the embedded tool call is a display aid for the operator's handler (which receives the whole request), not evidence of what the tool will do.",
	},
	{
		id: "permission.subject.command",
		projects: { CommandPermissionSubject: ["toolCallId"] },
		source: "RequestPermissionSubject type command",
		target: "permission.requested (subjectKind, toolCallId)",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["permission.requested"],
		preserved: ["that the subject is a command", "the associated tool call id (by reference)"],
		lost: ["the command text", "its working directory", "its terminal id"],
		qualification:
			"permission authorizes the AGENT to run the command; Endophasia never executes, shell-parses or validates it. The operator's handler receives it as text to decide on.",
	},
	{
		id: "permission.subject.unrecognized",
		source: "RequestPermissionSubject with a custom (`_`-prefixed) or future type",
		target: "(none)",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: ["the subject's meaning"],
		qualification:
			"interpreting it would be claiming to understand an operation this client cannot read: it is recorded as subjectKind unrecognized, is never shown to the operator's handler, and is answered with the agent's own reject_once (else cancelled). It is never approved.",
	},
	{
		id: "permission.subject.malformed",
		source:
			"a session/request_permission whose shape the baseline rejects (including a subject of a known type that fails its definition)",
		target: "(none)",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: ["everything the request claimed"],
		qualification:
			"a request that does not satisfy the baseline is not interpreted at all: recorded as subjectKind malformed, answered with a JSON-RPC invalid-params error (the SDK's own refusal, or this adapter's), never shown to the handler, never approved.",
	},
	{
		id: "permission.decision",
		source: "the permission response the client returned",
		target: "permission.decided (authority-decision)",
		verdict: "LOSSY",
		availability: observed,
		emits: ["permission.decided"],
		preserved: [
			"selected, cancelled or error",
			"the selected option's kind",
			"decidedBy (adapter default or handler)",
			"whether a handler was consulted",
			"the subject kind",
		],
		lost: ["the selected option id"],
		qualification:
			"fail-closed: absent a valid handler selection of an offered option the answer is the agent's reject_once; with none selectable and the work not being cancelled, a JSON-RPC error (the agent receives no approval and no false cancellation); cancelled only when work is being cancelled or the session is closing or gone, or as the handler's own explicit decision. A handler may select only an option actually offered; an unrecognized or malformed subject never reaches it.",
	},
	{
		id: "permission.outcome-cancelled",
		source: "RequestPermissionOutcome cancelled",
		target: "permission.decided (decision: cancelled)",
		verdict: "QUALIFIED",
		availability: observed,
		emits: ["permission.decided"],
		preserved: ["that the request was answered cancelled"],
		lost: [],
		qualification:
			'the baseline defines `cancelled` as "active session work was cancelled" and requires it for every pending request when work is cancelled. It is returned only when that is true (a stop requested, the session closing or gone) or as an explicit decision of the operator handler, which does not cancel the work: that outcome is the handler claim, not evidence that work was cancelled.',
	},
	{
		id: "message.late",
		source: "traffic after the process exit, a stream close, close() or session close",
		target: "harness.late-message",
		verdict: "EXACT",
		availability: observed,
		emits: ["harness.late-message"],
		preserved: ["the method", "why it is late"],
		lost: [],
	},
	{
		id: "process.exit",
		source: "the agent process ending",
		target: "harness.process-exited, lifecycle.detached | lifecycle.interrupted",
		verdict: "EXACT",
		availability: observed,
		emits: ["harness.process-exited", "lifecycle.detached", "lifecycle.interrupted"],
		preserved: ["exit code or signal", "whether it was expected", "whether foreground work was open"],
		lost: [],
	},
	{
		id: "process.containment",
		source: "descendants of the agent process",
		target: "(process group ownership)",
		verdict: "QUALIFIED",
		availability: observed,
		emits: [],
		preserved: ["a process group this attachment owns, ended on close()"],
		lost: [],
		qualification:
			"on Windows the shared ProcessGroupV0 has no job-object containment: only the launched command is ended and descendants are not. On POSIX a descendant that deliberately leaves the group (setsid(2), or a child spawned detached) can survive close(). This study does not change either limit.",
	},
];

function updateEntry(variant: string): AcpLossEntryV0 {
	const base = { source: `session/update:${variant}`, availability: initiated } as const;
	const message = (kind: string, withChunk: boolean): AcpLossEntryV0 => ({
		...base,
		id: `update.${variant}`,
		projects: withChunk ? { ContentChunk: ["messageId", "content"] } : { [kind]: ["messageId", "content"] },
		target: "an update count (no event) and the in-memory reconstruction",
		verdict: "LOSSY",
		emits: [],
		preserved: [
			"that the update occurred, counted per variant",
			"per-message digests in memory (conversation.reconstruction)",
		],
		lost: ["the content", "content block types"],
		qualification:
			"text is never stored in an event; the message id is a replay key, kept only inside the in-memory reconstruction.",
	});
	switch (variant) {
		case "user_message_chunk":
		case "agent_message_chunk":
		case "agent_thought_chunk":
			return message("ContentChunk", true);
		case "user_message":
			return message("UserMessage", false);
		case "agent_message":
			return message("AgentMessage", false);
		case "agent_thought":
			return message("AgentThought", false);
		case "state_update":
			return {
				...base,
				id: "update.state_update",
				target: "see run.lifecycle",
				verdict: "QUALIFIED",
				emits: [],
				preserved: ["see run.lifecycle"],
				lost: ["see run.lifecycle"],
				qualification:
					"the entry for this variant's semantics is run.lifecycle, state.requires-action and state.unrecognized.",
			};
		case "tool_call_content_chunk":
			return {
				...base,
				id: "update.tool_call_content_chunk",
				projects: { ToolCallContentChunk: ["toolCallId", "content"] },
				target: "an update count (no event) and the in-memory reconstruction",
				verdict: "LOSSY",
				emits: [],
				preserved: ["that a chunk occurred", "the reconstructed tool-call digest in memory"],
				lost: ["the content"],
			};
		case "tool_call_update":
			return {
				...base,
				id: "update.tool_call_update",
				projects: {
					ToolCallUpdate: [
						"toolCallId",
						"name",
						"kind",
						"status",
						"content",
						"locations",
						"rawInput",
						"rawOutput",
					],
				},
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: [
					"tool call id (reference)",
					"tool name (by reference), kind and status when reported",
					"content and location counts",
					"whether raw input / output were carried",
				],
				lost: ["title", "content", "locations", "raw input and output values"],
				qualification:
					"an upsert patch: an absent field means unchanged, an explicit null clears it, and `content: []` and `null` both clear.",
			};
		case "terminal_update":
			return {
				...base,
				id: "update.terminal_update",
				projects: { TerminalUpdate: ["terminalId", "output", "exitStatus"] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: [
					"terminal id (reference)",
					"whether it exited or had its exit status cleared",
					"whether output was carried or cleared",
				],
				lost: ["the command", "the working directory", "the output bytes", "the exit code and signal"],
				qualification:
					"an agent-owned, display-only terminal: Endophasia holds no terminal, serves no terminal/* method, and runs nothing.",
			};
		case "terminal_output_chunk":
			return {
				...base,
				id: "update.terminal_output_chunk",
				projects: { TerminalOutputChunk: [] },
				target: "an update count (no event)",
				verdict: "LOSSY",
				emits: [],
				preserved: ["that a chunk occurred, counted per variant"],
				lost: ["the bytes", "the terminal id"],
			};
		case "plan_update":
			return {
				...base,
				id: "update.plan_update",
				projects: { PlanUpdate: ["plan"], PlanItems: ["planId", "entries"], PlanEntry: ["status"] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: ["plan id (reference)", "content type", "for item plans: entry count and counts by status"],
				lost: ["entry text", "priorities"],
				qualification: "file and markdown plan content are UNSTABLE upstream and are counted by type only.",
			};
		case "available_commands_update":
			return {
				...base,
				id: "update.available_commands_update",
				projects: { AvailableCommandsUpdate: ["availableCommands"] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: ["command count"],
				lost: ["command names, descriptions and input hints"],
			};
		case "config_option_update":
			return {
				...base,
				id: "update.config_option_update",
				projects: {
					ConfigOptionUpdate: ["configOptions"],
					SessionConfigOption: ["configId", "category"],
					SessionConfigSelect: ["currentValue", "options"],
					SessionConfigSelectGroup: ["options"],
					SessionConfigBoolean: ["currentValue"],
				},
				target: "session.config-observed",
				verdict: "QUALIFIED",
				emits: ["session.config-observed"],
				preserved: ["config ids, kinds, categories, current values and choice counts (no labels)"],
				lost: ["option names and descriptions", "choice values and labels"],
				qualification:
					"observed state after the agent changed its configuration, as the agent reports it (v2 names the option `configId`, not v1's `id`); not evidence of effect on later requests.",
			};
		case "session_info_update":
			return {
				...base,
				id: "update.session_info_update",
				projects: { SessionInfoUpdate: ["title"] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: ["whether a title was set or cleared"],
				lost: ["the title", "the update time"],
			};
		case "usage_update":
			return {
				...base,
				id: "update.usage_update",
				projects: { UsageUpdate: ["used", "size", "cost"], Cost: ["amount", "currency"] },
				target: UPDATE_TARGET,
				verdict: "QUALIFIED",
				emits: [UPDATE_TARGET],
				preserved: [
					"context tokens used",
					"context window size",
					"cumulative cost with its currency, when reported",
				],
				lost: [],
				qualification:
					"session context-window state, not a per-run token ledger: the unstable per-run usage on an idle state_update is not read, and nothing is split into input, output, cache or reasoning tokens.",
			};
		default:
			// A baseline variant added to ACP_V2_BASELINE_UPDATE_VARIANTS_V0 without a verdict fails here, at module load.
			throw new TypeError(`no loss verdict for the baseline ACP v2 update variant ${variant}`);
	}
}

const pinned = readAcpBaselineSchemaV2();
assertAcpSchemaV2Pins(pinned.sha256);
const schemaDefinitions = pinned.document.$defs as Record<string, { properties?: Record<string, unknown> }>;

/** The properties of a baseline definition that an entry does not project, as `Definition.property`. */
export function acpV2UnprojectedFieldsV0(entry: Pick<AcpLossEntryV0, "projects">): string[] {
	const out: string[] = [];
	for (const [definition, carried] of Object.entries(entry.projects ?? {})) {
		const properties = Object.keys(schemaDefinitions[definition]?.properties ?? {});
		for (const property of properties) {
			if (property !== "_meta" && !carried.includes(property)) out.push(`${definition}.${property}`);
		}
	}
	return out;
}

const entries: readonly AcpLossEntryV0[] = [...declared, ...ACP_V2_BASELINE_UPDATE_VARIANTS_V0.map(updateEntry)].map(
	(entry) => ({
		...entry,
		lost: [...entry.lost, ...acpV2UnprojectedFieldsV0(entry).filter((field) => !entry.lost.includes(field))],
	}),
);

/** What this study does not implement. Unsupported is not lossy: nothing is projected and nothing is called. */
const unsupported: ReadonlyArray<{ readonly id: string; readonly reason: string }> = [
	{ id: "session/delete, session/fork", reason: "optional or unstable: not advertised-gated here and never called" },
	{
		id: "session/set_config_option",
		reason: "a baseline method name, but configuration is observation only: no control path",
	},
	{
		id: "auth/login, auth/logout",
		reason: "no authentication flow; an agent that requires one refuses session/new, which is recorded",
	},
	{ id: "elicitation/*", reason: "not advertised by the client, so never requested" },
	{ id: "fs/*, terminal/*", reason: "not served; agent-owned terminals are display-only updates" },
	{ id: "additionalDirectories", reason: "an optional session capability: never sent" },
	{ id: "providers/*, nes/*, document/*, mcp/message", reason: "UNSTABLE upstream and absent from the baseline" },
	{
		id: "session/update variants only in the SDK's layered schema",
		reason: "plan_removed, notice, compaction_*, subagent_update, session_message*: observed by name and digest only",
	},
	{ id: "session/load", reason: "removed in v2; session/resume with replayFrom replaces it" },
];

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
	if (typeof value === "object" && value !== null && !seen.has(value)) {
		seen.add(value);
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child, seen);
	}
	return value;
};

export const ACP_V2_LOSS_ACCOUNTING_V0 = deepFreeze({
	schemaVersion: ACP_V2_LOSS_ACCOUNTING_VERSION_V0,
	mapping: ACP_V2_MAPPING_VERSION,
	status: "Draft",
	acpSchema: ACP_SCHEMA_V2,
	verdicts: Object.freeze({
		EXACT: "the Endophasia target preserves every semantic fact that target contract needs",
		QUALIFIED: "representable, but the evidence basis or scope differs; the qualification travels with it",
		LOSSY: "a valid projection exists; known source information is intentionally omitted or collapsed",
		UNREPRESENTABLE: "mapping it would invent semantics or claim more than the source supports; not projected",
	} satisfies Record<AcpLossVerdictV0, string>),
	entries: Object.freeze(entries),
	unsupported: Object.freeze(unsupported),
});

export function acpV2LossEntryV0(id: string): AcpLossEntryV0 | undefined {
	return ACP_V2_LOSS_ACCOUNTING_V0.entries.find((entry) => entry.id === id);
}
