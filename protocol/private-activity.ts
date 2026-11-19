// The private activity contract: how a harness adapter presents what a live session REPORTED it was doing, to the paired page only.
// Presentation, not evidence and not authority (docs/private-activity.md). Types only: Studio imports it as types, and the protocol
// imports nothing.
//
// `kind` is the type of observation the provider made, never inferred from how it is presented:
//   tool         the provider's lifecycle report for one tool invocation (a start, an end, or both). Only this kind has a tool-call id.
//   file-change  the provider's own structured report that files changed. Not a tool invocation, and not a filesystem observation.
//   activity     other structured activity the provider reported (a search, an MCP call, a plan step), named by its native type.
// `category` is only how the page groups and words a row; different kinds can share one.

export type ActivityField = {
	label:
		| "Command"
		| "Path"
		| "Directory"
		| "Offset"
		| "Limit"
		| "Timeout"
		| "Edits"
		| "Content"
		| "Arguments"
		| "Exit code"
		| "Output";
} & ({ state: "reported" | "counted" | "truncated"; text: string } | { state: "unavailable" | "withheld" });

export type ActivityCategory = "command" | "file-read" | "file-change" | "retrieval" | "external" | "other";

interface ActivityBase {
	/** This launch's transcript sequence: the order observations were received in. */
	seq: number;
	/** The seq of this activity's first observation, assigned by the adapter; equal to `seq` for a first or uncorrelated one. */
	occurrence: number;
	/** A launch-local turn ordinal, or null when no native turn boundary was seen. Not a native turn id, not a work attempt. */
	turn: number | null;
	/** The integration that presents it (`pi-live`, or a `synthetic-*` fixture source). */
	source: string;
	category: ActivityCategory;
	fields: ActivityField[];
}

/** A tool invocation as its lifecycle was reported. `requested` and `running` are open; the rest are what the end report said. */
export interface ToolActivity extends ActivityBase {
	kind: "tool";
	/** The native tool name, or a fixed placeholder when it was missing or not admitted. */
	name: string;
	/** The provider's tool-call id, kept as a reference; null when missing or malformed. Never an Endophasia identity. */
	callId: string | null;
	status: "requested" | "running" | "completed" | "failed" | "unknown";
}

/**
 * What a non-tool report said of itself. `reported`: one report with no lifecycle at all. `in-progress`: the provider said it started.
 * The terminal states are the provider's words: never a verified write, a verified result or an exit status.
 */
export type ReportedStatus = "reported" | "in-progress" | "completed" | "failed" | "declined" | "unknown";

export interface FileChangeActivity extends ActivityBase {
	kind: "file-change";
	/** The provider's own item reference when it gave one, else null. Not a tool-call id. */
	nativeRef: string | null;
	status: ReportedStatus;
}

export interface OtherActivity extends ActivityBase {
	kind: "activity";
	/** The provider's own activity type (for example `webSearch`), or a fixed placeholder. */
	name: string;
	nativeRef: string | null;
	status: ReportedStatus;
}

export type PrivateActivity = ToolActivity | FileChangeActivity | OtherActivity;

/**
 * How a descriptor value is known. `assessed`: admitted by the existing runtime assessment (the protocol/harness.ts capability state);
 * `observed`: seen on this live connection, which promises nothing about another; `advertised`: the provider claims it and nothing here
 * checked it; `unavailable`: this adapter has no path for it; `unknown`: not established either way.
 */
export type DescriptorBasis = "assessed" | "observed" | "advertised" | "unavailable" | "unknown";

/** What Endophasia can receive or present from this source. */
export type ObservationCapability =
	| "nativeSessionIdentity"
	| "stableCallIdentity"
	| "toolBoundaries"
	| "argumentPreview"
	| "resultPreview"
	| "fileChanges"
	| "subagents";

/**
 * What the provider claims or has demonstrated about acting on a run. DESCRIPTIVE ONLY: none of these authorises Endophasia to send
 * anything, bypasses an approval, enables protected execution or says a consequence is enforced. Whether an operation is permitted is
 * decided by the broker's offers, session control and execution protection, none of which reads this.
 */
export type ProviderControlFeature = "interrupt" | "steer" | "approvals" | "toolCancellation" | "resume";

export interface ActivityDescriptor {
	observation: Record<ObservationCapability, DescriptorBasis>;
	providerControls: Record<ProviderControlFeature, DescriptorBasis>;
}
