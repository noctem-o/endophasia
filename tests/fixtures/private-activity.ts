// SYNTHETIC contract fixtures. Each shape is inspired by what another harness's protocol documents (Codex App Server items, Claude Agent
// SDK tool_use / tool_result, ACP tool_call updates). None is a captured native trace, none comes from a running harness, and none is
// evidence that Endophasia integrates with one: every source is named `synthetic-*` so it cannot be mistaken for a real integration.
import type { ActivityDescriptor, PrivateActivity } from "../../protocol/private-activity.ts";

export const unknownDescriptor: ActivityDescriptor = {
	observation: {
		nativeSessionIdentity: "unknown",
		stableCallIdentity: "unknown",
		toolBoundaries: "unknown",
		argumentPreview: "unknown",
		resultPreview: "unknown",
		fileChanges: "unknown",
		subagents: "unknown",
	},
	providerControls: {
		interrupt: "unknown",
		steer: "unknown",
		approvals: "unknown",
		toolCancellation: "unknown",
		resume: "unknown",
	},
};

/** A descriptor that claims every control feature: it must still enable nothing. */
export const claimingDescriptor: ActivityDescriptor = {
	observation: { ...unknownDescriptor.observation, fileChanges: "advertised" },
	providerControls: {
		interrupt: "assessed",
		steer: "assessed",
		approvals: "advertised",
		toolCancellation: "advertised",
		resume: "advertised",
	},
};

const base: { turn: null; fields: PrivateActivity["fields"] } = { turn: null, fields: [] };
export const syntheticActivities: PrivateActivity[] = [
	// Codex-like fileChange item: started, then completed, under the provider's own item id. A report of a change, not a tool call.
	{
		...base,
		kind: "file-change",
		source: "synthetic-codex",
		category: "file-change",
		seq: 1,
		occurrence: 1,
		turn: 1,
		nativeRef: "fc_fixture",
		status: "in-progress",
		fields: [{ label: "Path", state: "reported", text: "README.md" }],
	},
	{
		...base,
		kind: "file-change",
		source: "synthetic-codex",
		category: "file-change",
		seq: 2,
		occurrence: 1,
		turn: 1,
		nativeRef: "fc_fixture",
		status: "completed",
		fields: [{ label: "Edits", state: "counted", text: "2" }],
	},
	// Claude-like tool_use with no result yet: a requested tool call.
	{
		...base,
		kind: "tool",
		source: "synthetic-claude",
		category: "file-read",
		seq: 3,
		occurrence: 3,
		name: "Read",
		callId: "toolu_fixture",
		status: "requested",
		fields: [{ label: "Path", state: "withheld" }],
	},
	// ACP-like tool_call: in progress, then an update with no recognisable outcome.
	{
		...base,
		kind: "tool",
		source: "synthetic-acp",
		category: "command",
		seq: 4,
		occurrence: 4,
		name: "execute",
		callId: "call_fixture",
		status: "running",
	},
	{
		...base,
		kind: "tool",
		source: "synthetic-acp",
		category: "command",
		seq: 5,
		occurrence: 4,
		name: "execute",
		callId: "call_fixture",
		status: "unknown",
	},
	// Codex-like webSearch item: other structured activity, one report, no lifecycle.
	{
		...base,
		kind: "activity",
		source: "synthetic-codex",
		category: "retrieval",
		seq: 6,
		occurrence: 6,
		name: "webSearch",
		nativeRef: "ws_fixture",
		status: "reported",
		fields: [{ label: "Arguments", state: "withheld" }],
	},
	// A file-change report with no native reference at all: it stays its own row and never correlates.
	{
		...base,
		kind: "file-change",
		source: "synthetic-codex",
		category: "file-change",
		seq: 7,
		occurrence: 7,
		nativeRef: null,
		status: "reported",
		fields: [{ label: "Path", state: "withheld" }],
	},
];
