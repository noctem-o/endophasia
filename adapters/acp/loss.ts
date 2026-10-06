// Explicit loss accounting for the ACP v1 -> endo.* mapping (ACP_MAPPING_VERSION), as data. One entry per ACP semantic
// this adapter claims to understand, each with a verdict on the Endophasia target it is projected into.
//
// Verdicts (the whole vocabulary; nothing else is a verdict):
//   EXACT          the Endophasia target preserves every semantic fact that target contract needs.
//   QUALIFIED      the same concept is representable, but its evidence basis or scope differs; the qualification
//                  travels with the entry (and, where it can, with the event).
//   LOSSY          a valid projection exists, but known source information is intentionally omitted or collapsed.
//   UNREPRESENTABLE  mapping it would invent semantics or claim more than the source supports; the adapter emits no
//                  such projection and keeps only the honest ACP observation.
//
// Availability is a different fact from the verdict and is kept apart: `availability` says whether an agent can be
// expected to produce the source at all ("baseline" ACP v1 requires it; a capability gate means the agent must have
// advertised it; "agent-initiated" means the agent chooses to send it). "The agent did not advertise it" is not
// "ACP cannot represent it".
//
// The table is checked by tests/acp-loss-accounting.test.ts: every stable update variant, every event kind the adapter
// source can emit, and every optional session method must have an entry, and the table is tied to the pinned schema.

import { ACP_SCHEMA_V0, ACP_STABLE_UPDATE_VARIANTS_V0, assertAcpSchemaDigestV0, readAcpSchemaV0 } from "./schema.ts";
import { ACP_MAPPING_VERSION } from "./translate.ts";

export const ACP_LOSS_VERDICTS_V0 = ["EXACT", "QUALIFIED", "LOSSY", "UNREPRESENTABLE"] as const;
export type AcpLossVerdictV0 = (typeof ACP_LOSS_VERDICTS_V0)[number];

export const ACP_LOSS_ACCOUNTING_VERSION_V0 = "endo.acp-loss-accounting.v0";

export type AcpAvailabilityV0 =
	| { readonly kind: "baseline" }
	| { readonly kind: "capability-gated"; readonly capability: string }
	| { readonly kind: "agent-initiated" }
	| { readonly kind: "adapter-observed" };

export interface AcpLossEntryV0 {
	readonly id: string;
	/** The ACP v1 semantic (a method, a `session/update:<variant>`, or an adapter-observed transport fact). */
	readonly source: string;
	/** The Endophasia contract or event the semantic is projected into. */
	readonly target: string;
	readonly verdict: AcpLossVerdictV0;
	readonly availability: AcpAvailabilityV0;
	/** Every event kind this entry's projection can emit (recorded and derived). Empty for an UNREPRESENTABLE entry. */
	readonly emits: readonly string[];
	readonly preserved: readonly string[];
	/**
	 * The ACP schema properties this projection carries (read into an event or used to decide), by definition. Every other
	 * property of those definitions is lost, and is listed in `lost` as `Definition.property`: derived from the pinned
	 * schema, so a field the schema defines cannot be silently unaccounted for. Prose items in `lost` add detail.
	 */
	readonly projects?: Readonly<Record<string, readonly string[]>>;
	readonly lost: readonly string[];
	/** Required unless EXACT: what a reader must not assume. */
	readonly qualification?: string;
}

const baseline: AcpAvailabilityV0 = { kind: "baseline" };
const initiated: AcpAvailabilityV0 = { kind: "agent-initiated" };
const observed: AcpAvailabilityV0 = { kind: "adapter-observed" };
const gated = (capability: string): AcpAvailabilityV0 => ({ kind: "capability-gated", capability });

const UPDATE_TARGET = "session.update-observed";

const declared: readonly AcpLossEntryV0[] = [
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
			"an ACP session id is unique to nothing but the agent that issued it: the coordinate carries the launched process instance, and two instances (or two agents) can issue the same id. No relation between coordinates is asserted.",
	},
	{
		id: "session.open.new",
		projects: {
			NewSessionRequest: ["cwd", "mcpServers"],
			NewSessionResponse: ["sessionId", "modes", "configOptions"],
		},
		source: "session/new",
		target: "harness.attached, lifecycle.session-started",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.attached", "lifecycle.session-started", "session.config-observed"],
		preserved: ["session id reference", "process instance", "that the session was opened by session/new"],
		lost: ["working directory", "mcp server list"],
		qualification:
			"ACP v1 reports no run id, turn id or turn count; they are declared UNAVAILABLE on lifecycle.session-started, never zero.",
	},
	{
		id: "session.open.resume",
		projects: {
			ResumeSessionRequest: ["sessionId", "cwd", "mcpServers"],
			ResumeSessionResponse: ["modes", "configOptions"],
		},
		source: "session/resume",
		target: "harness.attached, lifecycle.session-started",
		verdict: "QUALIFIED",
		availability: gated("agentCapabilities.sessionCapabilities.resume"),
		emits: ["harness.attached", "lifecycle.session-started", "session.config-observed", "control.refused"],
		preserved: [
			"requested session id reference",
			"that the session was opened by session/resume",
			"historyReplay: not-requested",
		],
		lost: ["working directory", "the relation to the earlier attachment"],
		qualification:
			"resume reattaches without the agent replaying history to the client (that is session/load, not implemented). The new process instance gets a new coordinate and lifecycle.session-started, not lifecycle.session-resumed: Endophasia holds no record of the earlier attachment under this coordinate, so previousInstance/previousEnd would be invented.",
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
		availability: gated("agentCapabilities.sessionCapabilities.list"),
		emits: ["session.listed", "control.refused"],
		preserved: [
			"number of sessions in the page",
			"whether a next cursor was reported",
			"a JSON-RPC refusal, by code (control.refused)",
		],
		lost: ["session ids", "working directories", "titles", "update times", "the cursor"],
		qualification: "the caller receives the full agent-reported page; the record keeps counts only.",
	},
	{
		id: "session.close",
		projects: { CloseSessionRequest: ["sessionId"] },
		source: "session/close",
		target: "control.requested, session.close-accepted",
		verdict: "QUALIFIED",
		availability: gated("agentCapabilities.sessionCapabilities.close"),
		emits: ["control.requested", "lifecycle.stop-requested", "session.close-accepted", "control.refused"],
		preserved: ["that the client asked", "that the agent answered without error"],
		lost: [],
		qualification:
			"a JSON-RPC response is the agent's acceptance, not proof that work was cancelled or resources freed. No lifecycle end is derived; the process end is recorded separately.",
	},
	{
		id: "capability.advertisement",
		projects: {
			InitializeResponse: ["protocolVersion", "agentInfo", "agentCapabilities", "authMethods"],
			Implementation: ["name", "version"],
			AuthMethodAgent: ["id"],
			AuthMethodTerminal: ["id"],
		},
		source: "initialize response (agentInfo, agentCapabilities, authMethods)",
		target: "harness.acp-initialized",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["harness.acp-initialized"],
		preserved: [
			"negotiated protocolVersion",
			"agent-reported name and version (by reference)",
			"capabilities (verbatim up to 8 KiB, always a digest)",
			"auth method ids",
			"which optional session methods are callable",
		],
		lost: ["auth method names", "capability fields over the size bound"],
		qualification: "agentInfo is the agent's own claim, not a verified identity of the executable.",
	},
	{
		id: "capability.unavailable",
		projects: {
			AgentCapabilities: ["sessionCapabilities"],
			SessionCapabilities: ["list", "resume", "close"],
		},
		source: "an optional method the agent did not advertise",
		target: "control.unavailable",
		verdict: "EXACT",
		availability: observed,
		emits: ["control.unavailable"],
		preserved: ["the method", "that nothing was sent"],
		lost: [],
		qualification:
			"only sessionCapabilities.list/resume/close are consulted to gate a call; the other AgentCapabilities and SessionCapabilities fields listed as lost here are not used for gating, and capability.advertisement records the capabilities verbatim (within its size bound).",
	},
	{
		id: "prompt.request",
		source: "session/prompt (client request)",
		target: "control.requested, lifecycle.run-started",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["control.requested", "lifecycle.run-started"],
		preserved: ["that the client sent one prompt turn"],
		lost: ["the prompt text, by design"],
		qualification:
			"ACP v1 has no run-start notification and no run or turn id: the run start is the client's own request (basis: client-sent-session-prompt).",
	},
	{
		id: "prompt.response",
		projects: { PromptResponse: ["stopReason"] },
		source: "session/prompt response (stopReason)",
		target: "agent.prompt-responded, lifecycle.run-completed | run-aborted | run-unclassified",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: [
			"agent.prompt-responded",
			"lifecycle.run-completed",
			"lifecycle.run-aborted",
			"lifecycle.run-unclassified",
		],
		preserved: [
			"the reported stop reason",
			"per-variant update counts for the turn",
			"whether the client had requested a stop",
		],
		lost: [],
		qualification:
			"end_turn is the agent's report that the turn ended, not proof that provider work happened; max_tokens, max_turn_requests and refusal are run-unclassified, not failures; a cancelled stop reason is the agent's report, and whether the operator's request caused it is not inferred.",
	},
	{
		id: "prompt.error",
		source: "session/prompt JSON-RPC error",
		target: "agent.prompt-failed, lifecycle.run-failed",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["agent.prompt-failed", "lifecycle.run-failed"],
		preserved: ["the JSON-RPC error code"],
		lost: ["the error message and data"],
		qualification: "cause is { source: jsonrpc-error, code }, not the Pi-shaped assistant-message cause.",
	},
	{
		id: "prompt.timeout",
		source: "the adapter's own prompt wait bound",
		target: "harness.prompt-timeout",
		verdict: "EXACT",
		availability: observed,
		emits: ["harness.prompt-timeout"],
		preserved: ["the bound"],
		lost: [],
	},
	{
		id: "cancel",
		source: "session/cancel (client notification)",
		target: "control.requested, lifecycle.stop-requested",
		verdict: "QUALIFIED",
		availability: baseline,
		emits: ["control.requested", "lifecycle.stop-requested"],
		preserved: ["that the client sent the notification during an open turn"],
		lost: [],
		qualification:
			"a notification: ACP gives no acknowledgement, and it names the session, not one turn (stop.target is UNAVAILABLE).",
	},
	{
		id: "permission.request",
		projects: {
			RequestPermissionRequest: ["sessionId", "toolCall", "options"],
			ToolCallUpdate: ["toolCallId"],
			PermissionOption: ["optionId", "kind"],
		},
		source: "session/request_permission",
		target: "permission.requested",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["permission.requested"],
		preserved: [
			"tool call id reference",
			"offered option kinds",
			"whether a turn was open",
			"whether the session matched",
		],
		lost: ["option ids and names", "the tool call title and content", "raw input"],
	},
	{
		id: "permission.decision",
		source: "the permission response the adapter returned",
		target: "permission.decided (authority-decision)",
		verdict: "LOSSY",
		availability: observed,
		emits: ["permission.decided"],
		preserved: [
			"selected or cancelled",
			"the selected option's kind",
			"decidedBy (adapter default or handler)",
			"whether a handler was consulted",
		],
		lost: ["the selected option id"],
		qualification:
			"fail-closed: absent a valid handler selection of an offered option the answer is the agent's reject_once, else cancelled. Traffic after exit, close or session close creates no authority event (see message.late).",
	},
	...ACP_STABLE_UPDATE_VARIANTS_V0.map((variant): AcpLossEntryV0 => updateEntry(variant)),
	{
		id: "update.unstable",
		source: "session/update variants the pinned schema marks UNSTABLE",
		target: "runtime.unrecognized-event, lifecycle.unrecognized-runtime-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.unrecognized-event", "lifecycle.unrecognized-runtime-event"],
		preserved: ["the variant name", "schemaStatus: unstable"],
		lost: ["every field"],
		qualification: "not translated: the schema says they may be removed or changed at any point.",
	},
	{
		id: "update.unknown",
		source: "a session/update variant outside the pinned schema",
		target: "runtime.unrecognized-event, lifecycle.unrecognized-runtime-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.unrecognized-event", "lifecycle.unrecognized-runtime-event"],
		preserved: ["the variant name when printable", "schemaStatus: unknown", "that it was counted as update activity"],
		lost: ["every field"],
		qualification: "not malformed merely because this adapter predates it.",
	},
	{
		id: "update.malformed",
		source:
			"a session/update that fails the pinned schema (stable variant), has no sessionUpdate discriminator, or names a session other than the open one",
		target: "runtime.malformed-event",
		verdict: "LOSSY",
		availability: initiated,
		emits: ["runtime.malformed-event"],
		preserved: [
			"the variant name when there is one",
			"problem: schema-invalid | no-sessionUpdate-variant | session-id-mismatch",
		],
		lost: ["every field"],
		qualification: "never counted as update activity.",
	},
	{
		id: "protocol.fault",
		source:
			"a response or transport the agent got wrong (schema-invalid initialize/session-new/resume/list/close/prompt response, unsupported version, malformed stop reason, failed prompt transport)",
		target: "harness.protocol-fault, lifecycle.run-unclassified",
		verdict: "LOSSY",
		availability: observed,
		emits: ["harness.protocol-fault", "lifecycle.run-unclassified"],
		preserved: ["which fault", "that an open turn ended unclassified"],
		lost: ["the offending message and its fields"],
		qualification: "a rejected initialize, session/new or session/resume response fails the attachment.",
	},
	{
		id: "message.late",
		source: "session/update or session/request_permission after exit, stream closure, close or session close",
		target: "harness.late-message",
		verdict: "LOSSY",
		availability: observed,
		emits: ["harness.late-message"],
		preserved: ["the method", "why it is late (exit, stream-closed, close, session-close)"],
		lost: ["everything the message carried"],
		qualification:
			"never counted, never decided: no update count, no permission.requested/decided, no handler call, no approval.",
	},
	{
		id: "config.observation",
		projects: {
			SessionModeState: ["currentModeId", "availableModes"],
			SessionConfigOption: ["id", "category"],
			SessionConfigSelect: ["currentValue", "options"],
			SessionConfigBoolean: ["currentValue"],
			SessionConfigSelectGroup: ["options"],
			SessionMode: [],
			SessionConfigSelectOption: [],
			ConfigOptionUpdate: ["configOptions"],
		},
		source: "configOptions (session/new, session/resume, config_option_update) and modes",
		target: "session.config-observed",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: ["session.config-observed"],
		preserved: [
			"option ids",
			"category (by reference)",
			"type and category",
			"the current value id (or boolean)",
			"number of selectable values",
			"current mode id and mode count",
		],
		lost: ["option names, descriptions and value labels", "the values themselves", "options past the 32nd"],
		qualification:
			"agent-reported session configuration: what the agent advertised and what it says is current. Not a verified model identity.",
	},
	{
		id: "config.model-identity",
		source: "a model-category config option's current value",
		target: "verified model or weights identity",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: [],
		qualification:
			"an agent's claim about a setting does not establish which weights served a request. No request to change an option is implemented (session/set_config_option is out of scope), so no request/effect pair exists either.",
	},
	{
		id: "usage.context-window",
		source: "usage_update used, size",
		target: "session.update-observed (contextTokensUsed, contextWindowSize)",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: [UPDATE_TARGET],
		preserved: ["tokens currently in context", "total context window size"],
		lost: [],
		qualification: "session/context-window state, not a count of tokens a turn consumed.",
	},
	{
		id: "usage.cost",
		source: "usage_update cost",
		target: "session.update-observed (cost)",
		verdict: "QUALIFIED",
		availability: initiated,
		emits: [UPDATE_TARGET],
		preserved: ["amount", "currency"],
		lost: [
			"a cost whose currency is not short printable ASCII: neither amount nor currency is carried (costOmitted: true)",
		],
		qualification:
			"cumulative cost for the session, not per message; an amount travels only with its currency; absent cost is absent, not zero.",
	},
	{
		id: "usage.ledger",
		source: "usage_update (and the per-turn PromptResponse.usage, which the pinned schema marks UNSTABLE)",
		target: "endophasia.usage.v0 per-message input/output/cache/reasoning ledger",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: [],
		qualification:
			"the stable ACP v1 surface reports no per-message token categories. The pinned schema also defines a per-turn `usage` object on the session/prompt response (input, output, thought, cached read/write, total tokens) but marks it UNSTABLE: it is validated as part of PromptResponse and not read, so nothing is split, summed or synthesized from it. lifecycle.session-started declares usage UNAVAILABLE. Taking that field would be a separate decision about unstable fields.",
	},
	{
		id: "tool.contract",
		source: "tool_call, tool_call_update",
		target: "Pi tool.started / tool.finished (keyed argument and result digests)",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: [],
		qualification:
			"ACP exposes an agent-chosen id, optional name, kind, status, and optional raw input/output values, with no start/finish boundary guarantee (a tool_call may arrive already completed) and no keyed digest. Digests are not fabricated from values ACP did not provide in that form; what is observed is kept at the session.update-observed level above.",
	},
	{
		id: "reasoning.content",
		source: "agent_thought_chunk content",
		target: "reasoning evidence or reasoning-token accounting",
		verdict: "UNREPRESENTABLE",
		availability: initiated,
		emits: [],
		preserved: [],
		lost: [],
		qualification:
			"thought chunks are agent-selected display content, not a reasoning-token ledger and not a verified chain of thought. Only their occurrence is counted.",
	},
	{
		id: "transport.closed",
		source: "ACP stream ended while the agent process lives",
		target: "harness.protocol-fault (connection-closed), teardown",
		verdict: "QUALIFIED",
		availability: observed,
		emits: ["harness.protocol-fault"],
		preserved: ["that the stream ended and the group was torn down"],
		lost: ["why it ended"],
		qualification: "the attachment is unusable from that moment, before the diagnostic wait.",
	},
	{
		id: "process.exit",
		source: "the owned agent process's exit",
		target: "harness.process-exited, lifecycle.detached | lifecycle.interrupted",
		verdict: "EXACT",
		availability: observed,
		emits: ["harness.process-exited", "lifecycle.detached", "lifecycle.interrupted"],
		preserved: ["exit code", "signal", "whether the exit was expected (close())", "whether a turn was open"],
		lost: [],
	},
	{
		id: "process.containment",
		source: "descendants of the agent process",
		target: "owned process-group teardown at close()",
		verdict: "QUALIFIED",
		availability: observed,
		emits: [],
		preserved: ["posix: the whole process group is ended and its members checked"],
		lost: [],
		qualification:
			"on Windows the shared ProcessGroupV0 has no job-object containment: only the launched command is ended and descendants are not. On POSIX a descendant that deliberately leaves the group (setsid(2), or a child spawned detached) is also outside what a process group can contain and can survive close(). This tranche does not change either limit.",
	},
];

function updateEntry(variant: string): AcpLossEntryV0 {
	const base = { source: `session/update:${variant}`, availability: initiated } as const;
	switch (variant) {
		case "user_message_chunk":
		case "agent_message_chunk":
		case "agent_thought_chunk":
			return {
				...base,
				id: `update.${variant}`,
				projects: { ContentChunk: [] },
				target: "an update count (no event)",
				verdict: "LOSSY",
				emits: [],
				preserved: ["that a chunk occurred, counted per variant"],
				lost: ["the content", "content block types", "message ids"],
				qualification: "text is never stored.",
			};
		case "tool_call":
		case "tool_call_update":
			return {
				...base,
				id: `update.${variant}`,
				projects: {
					[variant === "tool_call" ? "ToolCall" : "ToolCallUpdate"]: [
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
					"agent-reported; a tool_call_update is a partial update, so an absent field means unchanged, not empty.",
			};
		case "plan":
			return {
				...base,
				id: "update.plan",
				projects: { Plan: ["entries"], PlanEntry: ["status"] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: ["entry count", "counts by status"],
				lost: ["entry text", "priorities"],
			};
		case "available_commands_update":
			return {
				...base,
				id: "update.available_commands_update",
				projects: { AvailableCommandsUpdate: ["availableCommands"], AvailableCommand: [] },
				target: UPDATE_TARGET,
				verdict: "LOSSY",
				emits: [UPDATE_TARGET],
				preserved: ["command count"],
				lost: ["command names, descriptions and input hints"],
			};
		case "current_mode_update":
			return {
				...base,
				id: "update.current_mode_update",
				projects: { CurrentModeUpdate: ["currentModeId"] },
				target: UPDATE_TARGET,
				verdict: "QUALIFIED",
				emits: [UPDATE_TARGET],
				preserved: ["the mode id (reference)"],
				lost: [],
				qualification: "the agent's report of its own mode; its meaning is the agent's.",
			};
		case "config_option_update":
			return {
				...base,
				id: "update.config_option_update",
				projects: { ConfigOptionUpdate: ["configOptions"] },
				target: "session.config-observed",
				verdict: "QUALIFIED",
				emits: ["session.config-observed"],
				preserved: ["see config.observation"],
				lost: ["see config.observation"],
				qualification:
					"observed state after the agent changed its configuration; not evidence of effect on later requests.",
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
				preserved: ["see usage.context-window and usage.cost"],
				lost: [],
				qualification: "see usage.ledger for what it is not.",
			};
		default:
			// A stable variant added to ACP_STABLE_UPDATE_VARIANTS_V0 without a verdict fails here, at module load.
			throw new TypeError(`no loss verdict for the stable ACP update variant ${variant}`);
	}
}

// The loss lists are derived from the pinned schema, so it must be exactly the revision the table is labelled with.
const pinned = readAcpSchemaV0();
assertAcpSchemaDigestV0(pinned.sha256);
const schemaDefinitions = pinned.document.$defs as Record<string, { properties?: Record<string, unknown> }>;

/** The properties of a definition that an entry does not project, as `Definition.property`. */
export function acpUnprojectedFieldsV0(entry: Pick<AcpLossEntryV0, "projects">): string[] {
	const out: string[] = [];
	for (const [definition, carried] of Object.entries(entry.projects ?? {})) {
		const properties = Object.keys(schemaDefinitions[definition]?.properties ?? {});
		for (const property of properties) {
			if (property !== "_meta" && !carried.includes(property)) out.push(`${definition}.${property}`);
		}
	}
	return out;
}

const entries: readonly AcpLossEntryV0[] = declared.map((entry) => ({
	...entry,
	lost: [...entry.lost, ...acpUnprojectedFieldsV0(entry).filter((field) => !entry.lost.includes(field))],
}));

/** What this adapter does not implement. Unsupported is not lossy: nothing is projected and nothing is called. */
const unsupported: ReadonlyArray<{ readonly id: string; readonly reason: string }> = [
	{ id: "session/load", reason: "not implemented in this tranche; resume covers reattachment without history replay" },
	{ id: "session/fork, session/delete", reason: "not part of this tranche" },
	{
		id: "session/set_config_option, session/set_mode",
		reason: "observation only: no control path, no request/effect pair",
	},
	{ id: "authenticate, logout", reason: "no authentication flow" },
	{ id: "fs/*, terminal/*", reason: "not advertised and not served: the client offers neither" },
	{ id: "session/update variants marked UNSTABLE", reason: "observed by name only (update.unstable)" },
	{ id: "ACP v2", reason: "a separately pinned experimental study; this adapter negotiates version 1 only" },
];

const deepFreeze = <T>(value: T, seen = new Set<object>()): T => {
	if (typeof value === "object" && value !== null && !seen.has(value)) {
		seen.add(value);
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child, seen);
	}
	return value;
};

export const ACP_LOSS_ACCOUNTING_V0 = deepFreeze({
	schemaVersion: ACP_LOSS_ACCOUNTING_VERSION_V0,
	mapping: ACP_MAPPING_VERSION,
	acpSchema: ACP_SCHEMA_V0,
	verdicts: Object.freeze({
		EXACT: "the Endophasia target preserves every semantic fact that target contract needs",
		QUALIFIED: "representable, but the evidence basis or scope differs; the qualification travels with it",
		LOSSY: "a valid projection exists; known source information is intentionally omitted or collapsed",
		UNREPRESENTABLE: "mapping it would invent semantics or claim more than the source supports; not projected",
	}),
	entries: Object.freeze(entries),
	unsupported: Object.freeze(unsupported),
});

export function acpLossEntryV0(id: string): AcpLossEntryV0 | undefined {
	return ACP_LOSS_ACCOUNTING_V0.entries.find((entry) => entry.id === id);
}
