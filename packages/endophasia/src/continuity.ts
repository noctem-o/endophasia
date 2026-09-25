import type { AgentLane, Context, Entry, LaneSnapshot, ThinkingLevel } from "@earendil-works/pi-agent-core";

interface ContinuityEntryBaseV0 {
	id: string;
	parentId: string | null;
	seq: number;
	timestamp: number;
}

export type ContinuityEntryV0 =
	| (ContinuityEntryBaseV0 & {
			type: "message";
			role: Extract<Entry, { type: "message" }>["message"]["role"];
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
		model: { provider: string; modelId: string };
		thinkingLevel: ThinkingLevel;
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

function projectEntry(entry: Entry): ContinuityEntryV0 {
	const base = { id: entry.id, parentId: entry.parentId, seq: entry.seq, timestamp: entry.timestamp };
	switch (entry.type) {
		case "message":
			return {
				...base,
				type: "message",
				role: entry.message.role,
				...(entry.message.role === "assistant" ? { stopReason: entry.message.stopReason } : {}),
				terminate: entry.terminate === true,
			};
		case "compaction":
			return {
				...base,
				type: "compaction",
				tokensBefore: entry.tokensBefore,
				retainedTailCount: entry.retainedTail.length,
				fromHook: entry.fromHook,
				hasSummary: entry.summary.length > 0,
			};
		case "branch_summary":
			return {
				...base,
				type: "branch_summary",
				fromId: entry.fromId,
				fromHook: entry.fromHook,
				hasSummary: entry.summary.length > 0,
			};
		case "custom":
			return { ...base, type: "custom", customType: entry.customType, hasData: entry.data !== undefined };
	}
}

function projectContinuity(point: LaneSnapshot, ancestry: Entry[]): ContinuitySnapshotV0 {
	const boundary = point.transcript[0];
	return {
		schemaVersion: "continuity.v0",
		lane: point.lane,
		tipId: point.tipId,
		configuration: {
			model: { provider: point.configuration.model.provider, modelId: point.configuration.model.modelId },
			thinkingLevel: point.configuration.thinkingLevel,
			activeToolNames: [...point.configuration.activeToolNames],
		},
		activePath: ancestry.map(projectEntry),
		contextWindow: point.transcript.map(projectEntry),
		compaction:
			boundary?.type === "compaction"
				? {
						entryId: boundary.id,
						tokensBefore: boundary.tokensBefore,
						retainedTailCount: boundary.retainedTail.length,
						fromHook: boundary.fromHook,
					}
				: null,
		counts: {
			activePathEntries: ancestry.length,
			contextWindowEntries: point.transcript.length,
			beforeContextWindow: ancestry.length - point.transcript.length,
		},
	};
}

/** Capture a payload-minimal, read-only explanation of one lane at one durable tip. */
export async function captureContinuityV0(
	lane: Pick<AgentLane, "watch" | "findEntries">,
	context: Context,
): Promise<ContinuitySnapshotV0> {
	const watch = await lane.watch(context);
	try {
		const point = watch.snapshot;
		const ancestry =
			point.tipId === null ? [] : await lane.findEntries({ start: point.tipId, order: "oldestFirst" }, context);
		return projectContinuity(point, ancestry);
	} finally {
		watch.unsubscribe();
	}
}
