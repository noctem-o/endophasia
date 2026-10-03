// The Continuity v0 schema: a payload-minimal, read-only projection of a session's main lane at one durable tip.
//
// Status: UNWIRED, planned protocol surface. Nothing in the tree produces or consumes it. Its producer (a capture
// inside Pi's fork-only Session worker) was removed with the vendored fork (docs/pi-attach-inventory.md §5). It is kept
// as the intended shape for the session lifecycle and replay work, and will be revised when a producer exists. Until
// then it describes no capability Endophasia has.
import type { ModelIdentityV0, ThinkingLevelV0 } from "./primitives.ts";

/**
 * The message roles a Session entry can carry: the provider message roles plus the harness-level custom message
 * roles. The neutral literal set is wire-identical to the AgentMessage role of the runtime it projects.
 */
type ContinuityMessageRoleV0 =
	| "assistant"
	| "bashExecution"
	| "branchSummary"
	| "compactionSummary"
	| "custom"
	| "system"
	| "toolResult"
	| "user";

interface ContinuityEntryBaseV0 {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
}

export type ContinuityEntryV0 =
	| (ContinuityEntryBaseV0 & {
			type: "message";
			role: ContinuityMessageRoleV0;
			stopReason?: string;
			terminate: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "compaction";
			tokensBefore: number;
			retainedTailCount: number;
			fromHook: boolean;
			hasSummary: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "branch_summary";
			fromId: string | null;
			fromHook: boolean;
			hasSummary: boolean;
	  })
	| (ContinuityEntryBaseV0 & {
			type: "custom";
			customType: string;
			hasData: boolean;
	  });

export interface ContinuitySnapshotV0 {
	schemaVersion: "continuity.v0";
	lane: string;
	tipId: string | null;
	configuration: {
		model: ModelIdentityV0;
		thinkingLevel: ThinkingLevelV0;
		activeToolNames: string[];
	};
	/** Committed ancestry of the captured tip, including history before compaction. */
	activePath: ContinuityEntryV0[];
	/** Pi's compaction-bounded source entries, not the final provider-visible prompt. */
	contextWindow: ContinuityEntryV0[];
	compaction: null | {
		entryId: string;
		tokensBefore: number;
		retainedTailCount: number;
		fromHook: boolean;
	};
	counts: {
		activePathEntries: number;
		contextWindowEntries: number;
		beforeContextWindow: number;
	};
}

/**
 * Largest Continuity snapshot, in UTF-8 bytes of its JSON, that the service returns. activePath is the tip's whole
 * durable ancestry and is unbounded; a larger snapshot fails the read instead of being truncated. A service result
 * reaches a Pi client in one frame (16 MiB by default), and a frame over the limit closes the client's whole
 * connection, so this leaves half the frame for the envelope and the encoding.
 */
export const CONTINUITY_REMOTE_BYTE_LIMIT = 8 * 1024 * 1024;
