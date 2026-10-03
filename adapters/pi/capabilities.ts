// The Pi capability catalogue: every capability the attachment can offer, which check can establish it, and which
// capability of the retired fork adapter (adapters/pi before the RPC attachment) it replaces. The catalogue states
// what each capability MEANS; whether the observed runtime has it is decided only by evidence (evidence.ts).
//
// "requires" is the cheapest check kind that can establish the capability:
// - static-surface: classified from Pi's documented RPC surface for the tested version, with no runtime interaction.
//   Used only for absences that no exchange could disprove short of an undocumented command.
// - local-protocol: an automatic exchange with Pi that starts no agent run and calls no provider (checks.ts).
// - live-study: needs a prompt (provider cost, tool execution, session state changes): only on explicit request.

import type { EndoCapabilityCheckKindV0 } from "../../protocol/harness.ts";

export interface PiCapabilityV0 {
	/** The capability id, a dotted kind. */
	readonly id: string;
	/** What the capability means when admitted. */
	readonly meaning: string;
	readonly requires: EndoCapabilityCheckKindV0;
	/** The fork-era capability it replaces, if any, and how the guarantee changed. */
	readonly replaces: string | null;
	/** Whether the attachment offers an operator control gated on this capability. */
	readonly control: boolean;
}

export const PI_CAPABILITIES_V0: readonly PiCapabilityV0[] = Object.freeze([
	{
		id: "session.identity",
		meaning: "get_state reports a non-empty session id, stable for the life of a persistent session across processes",
		requires: "local-protocol",
		replaces: null,
		control: false,
	},
	{
		id: "session.entries-cursor",
		meaning:
			"get_entries returns every persisted entry with a unique opaque id; `since` returns exactly the entries strictly after that id; an unknown cursor is refused, not ignored",
		requires: "local-protocol",
		replaces: "endophasia.usage.v0 integer usage sequence (now an opaque entry cursor)",
		control: false,
	},
	{
		id: "continuity.active-path",
		meaning: "get_tree reports the session tree and a leaf id consistent with get_entries",
		requires: "local-protocol",
		replaces:
			"endophasia.continuity.v0 (active path; the context-window boundary is derived from compaction entries)",
		control: false,
	},
	{
		id: "session.overview",
		meaning: "get_state reports streaming, compacting and pending-message state of the single session",
		requires: "local-protocol",
		replaces: "endophasia.session-overview.v0 (one session, no lanes, no operation id)",
		control: false,
	},
	{
		id: "runtime.metrics",
		meaning: "get_session_stats reports cumulative tokens and total cost for the session",
		requires: "local-protocol",
		replaces: "endophasia.runtime-metrics.v0 (no per-category cost, no reasoning tokens)",
		control: false,
	},
	{
		id: "control.model",
		meaning: "set_model selects a model and get_state then reports that model",
		requires: "local-protocol",
		replaces: "Control Deck v0 model configuration",
		control: true,
	},
	{
		id: "control.thinking",
		meaning: "set_thinking_level selects an available level and get_state then reports it",
		requires: "local-protocol",
		replaces: "Control Deck v0 thinking configuration",
		control: true,
	},
	{
		id: "control.active-tools",
		meaning: "the active tool set can be read and changed during a session",
		requires: "local-protocol",
		replaces: "Control Deck v0 active tools",
		control: false,
	},
	{
		id: "lifecycle.trace",
		meaning:
			"a prompt produces agent_start, turn_start, message_end, turn_end, agent_end and agent_settled, in that order",
		requires: "live-study",
		replaces: "endophasia.mission-trace.v0 (no run or turn ids; no resume/suspend events)",
		control: false,
	},
	{
		id: "usage.entries",
		meaning: "each assistant entry carries its provider-reported usage, readable after the fact through get_entries",
		requires: "live-study",
		replaces: "endophasia.usage.v0 (per-entry usage behind an opaque cursor instead of an integer ledger)",
		control: false,
	},
	{
		id: "tool.activity",
		meaning: "tool_execution_start and tool_execution_end are emitted for a tool call, correlated by toolCallId",
		requires: "live-study",
		replaces: null,
		control: false,
	},
	{
		id: "steering.steer",
		meaning: "steer during a run is accepted and the message is later consumed by that run",
		requires: "live-study",
		replaces: "Steering v0 STEER (acceptance carries no receipt id)",
		control: true,
	},
	{
		id: "steering.follow-up",
		meaning: "follow_up during a run is accepted and runs after the current run",
		requires: "live-study",
		replaces: "Steering v0 QUEUE (acceptance carries no receipt id)",
		control: true,
	},
	{
		id: "steering.stop",
		meaning: "abort during a run ends the run",
		requires: "live-study",
		replaces: "Steering v0 STOP (untargeted: it cannot be confined to the observed run)",
		control: true,
	},
	{
		id: "run.identity",
		meaning: "runs and turns carry runtime-supplied identifiers",
		requires: "static-surface",
		replaces: "Mission Trace v0 runId/turnId",
		control: false,
	},
	{
		id: "operation.outcome",
		meaning: "an accepted operation has a durable, id-keyed terminal outcome that can be read later",
		requires: "static-surface",
		replaces: "endophasia.operation-outcome.v0",
		control: false,
	},
]);

export const PI_CAPABILITY_IDS_V0: readonly string[] = Object.freeze(PI_CAPABILITIES_V0.map((entry) => entry.id));

export function piCapabilityV0(id: string): PiCapabilityV0 {
	const found = PI_CAPABILITIES_V0.find((entry) => entry.id === id);
	if (found === undefined) throw new TypeError(`unknown Pi capability ${id}`);
	return found;
}
