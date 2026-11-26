import { describe, expect, it } from "vitest";
import { eventLogPrefixDigestV0 } from "../cockpit/projections/common.ts";
import { projectEndoCockpitSessionTimelineV0 } from "../cockpit/projections/session-timeline.ts";
import { endoCockpitCategoryOfV0, validateEndoCockpitSessionTimelineV0 } from "../protocol/cockpit.ts";
import { ENDO_COCKPIT_WITHHELD_TEXT_V0 } from "../protocol/cockpit-fields.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";

const KEY = endoDigestKeyV0(new Uint8Array(32).fill(7), "endo.digest-key.codex-observe-test");

function makeEvent(seq: number, kind: string, payload: Record<string, unknown>): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.codex-live.${String(seq).padStart(16, "0")}`,
		kind,
		source: "runtime-fact",
		sequence: seq,
		at: `2026-11-26T00:00:${String(seq).padStart(2, "0")}.000Z`,
		coordinates: { sessionId: "endo.session.codex.thread-1", runId: "endo.run.codex.turn-1" },
		producer: "codex-app-server:codex.default",
		derivedFrom: [],
		payload: payload as EndoEventV0["payload"],
	};
}

function project(events: EndoEventV0[]) {
	const stored = events.map((event, i) => ({ storageSequence: i + 1, event }));
	const last = events[events.length - 1]!;
	return projectEndoCockpitSessionTimelineV0(
		{
			source: {
				domain: "event-log",
				condition: { state: "readable", tornTail: null, sealedAt: null, error: null },
				watermark: {
					length: events.length,
					lastEventId: last.id,
					prefixDigest: eventLogPrefixDigestV0(KEY, events),
					keyId: KEY.keyId,
				},
			},
			afterSequence: 0,
			events: stored,
		},
		KEY,
	);
}

describe("Observe timeline classification for Codex canonical events", () => {
	it("recognizes known codex.* kinds into semantic categories with allowlisted fields and preserves unrecognized flag on unknown notifications", () => {
		const events: EndoEventV0[] = [
			makeEvent(1, "codex.thread-started", {
				instanceId: "inst-1",
				threadId: "thread-1",
				ephemeral: true,
				model: "gpt-6.2-sol",
				modelProvider: "openai",
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
			}),
			makeEvent(2, "codex.prompt-dispatched", {
				instanceId: "inst-1",
				threadId: "thread-1",
				authorizationId: "auth-1",
			}),
			makeEvent(3, "codex.turn-started", { instanceId: "inst-1", threadId: "thread-1", turnId: "turn-1" }),
			makeEvent(4, "codex.item-completed", {
				instanceId: "inst-1",
				threadId: "thread-1",
				turnId: "turn-1",
				itemId: "item-1",
				itemType: "commandExecution",
				phase: "completed",
				exitCode: 0,
			}),
			makeEvent(5, "codex.token-usage-updated", {
				instanceId: "inst-1",
				threadId: "thread-1",
				turnId: "turn-1",
				inputTokens: 1200,
				cachedInputTokens: 800,
				outputTokens: 64,
				reasoningTokens: 17,
				totalTokens: 1264,
				modelContextWindow: 475000,
				costUsd: null,
			}),
			makeEvent(6, "codex.stop-requested", { instanceId: "inst-1", threadId: "thread-1", turnId: "turn-1" }),
			makeEvent(7, "codex.native-approval-requested", {
				instanceId: "inst-1",
				threadId: "thread-1",
				approvalKind: "command",
				nativeMethod: "item/commandExecution/requestApproval",
				proposesBroadening: false,
			}),
			makeEvent(8, "codex.native-approval-resolved", {
				instanceId: "inst-1",
				threadId: "thread-1",
				approvalKind: "command",
				nativeMethod: "item/commandExecution/requestApproval",
				resolution: "declined",
				code: "operator-declined",
			}),
			makeEvent(9, "codex.thread-compacted", { instanceId: "inst-1", threadId: "thread-1", turnId: "turn-1" }),
			makeEvent(10, "codex.transport-fault", {
				instanceId: "inst-1",
				threadId: "thread-1",
				faultKind: "oversized-record",
				byteLength: 2048,
			}),
			makeEvent(11, "codex.connection-lost", {
				instanceId: "inst-1",
				threadId: "thread-1",
				expected: false,
				cleanupBoundary: "process-group",
				cleanupResult: "confirmed",
				remainingProcesses: 0,
				exit: { code: 1, signal: null, spawnFailed: false },
			}),
			makeEvent(12, "codex.unrecognized-notification", {
				instanceId: "inst-1",
				threadId: "thread-1",
				method: "future/unknownEvent",
			}),
		];

		const timeline = project(events);
		expect(validateEndoCockpitSessionTimelineV0(timeline)).not.toBeNull();

		const byKind = new Map(timeline.entries.map((e) => [e.kind, e]));
		expect(byKind.get("codex.thread-started")).toMatchObject({
			category: "session",
			flags: [],
			fields: {
				model: { basis: "reported", value: "gpt-6.2-sol" },
				approvalPolicy: { basis: "reported", value: "on-request" },
			},
		});
		expect(byKind.get("codex.prompt-dispatched")).toMatchObject({ category: "control", flags: [] });
		expect(byKind.get("codex.item-completed")).toMatchObject({
			category: "agent",
			flags: [],
			fields: {
				itemType: { basis: "reported", value: "commandExecution" },
				exitCode: { basis: "reported", value: 0 },
			},
		});
		expect(byKind.get("codex.token-usage-updated")).toMatchObject({
			category: "agent",
			flags: [],
			fields: {
				inputTokens: { basis: "reported", value: 1200 },
				cachedInputTokens: { basis: "reported", value: 800 },
				reasoningTokens: { basis: "reported", value: 17 },
				modelContextWindow: { basis: "reported", value: 475000 },
			},
		});
		expect(byKind.get("codex.stop-requested")).toMatchObject({ category: "control", flags: [] });
		expect(byKind.get("codex.native-approval-requested")).toMatchObject({ category: "control", flags: [] });
		expect(byKind.get("codex.native-approval-resolved")).toMatchObject({
			category: "control",
			flags: [],
			fields: { resolution: { basis: "observed", value: "declined" } },
		});
		expect(byKind.get("codex.thread-compacted")).toMatchObject({ category: "compaction", flags: [] });
		expect(byKind.get("codex.transport-fault")).toMatchObject({ category: "harness", flags: ["anomaly"] });
		expect(byKind.get("codex.connection-lost")).toMatchObject({
			category: "harness",
			flags: ["interruption"],
			fields: { expected: { basis: "observed", value: false }, exitCode: { basis: "observed", value: 1 } },
		});
		expect(byKind.get("codex.unrecognized-notification")).toMatchObject({
			category: "other",
			flags: ["unrecognized"],
		});
		expect(endoCockpitCategoryOfV0("codex.unknown-future")).toBe("other");
	});

	it("withholds path-like or credential-like text in allowlisted codex fields", () => {
		const timeline = project([
			makeEvent(1, "codex.thread-started", {
				instanceId: "inst-1",
				model: "/home/secret/model.gguf",
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				ephemeral: true,
			}),
		]);
		expect(timeline.entries[0]?.fields.model).toEqual({
			basis: "unavailable",
			reason: ENDO_COCKPIT_WITHHELD_TEXT_V0,
		});
	});
});
