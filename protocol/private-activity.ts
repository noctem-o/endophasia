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

export interface PrivateActivity {
	kind: "tool";
	seq: number;
	occurrence: number;
	turn: number | null;
	callId: string | null;
	source: string;
	name: string;
	category: "command" | "file-read" | "file-change" | "retrieval" | "external" | "other";
	status: "requested" | "running" | "completed" | "failed" | "unknown";
	fields: ActivityField[];
}

export type ActivityCapabilities = Record<
	| "nativeSessionIdentity"
	| "stableCallIdentity"
	| "toolBoundaries"
	| "argumentPreview"
	| "resultPreview"
	| "toolCancellation"
	| "interrupt"
	| "steer"
	| "approvals"
	| "resume"
	| "fileChanges"
	| "subagents",
	"supported" | "unavailable" | "unverified"
>;
