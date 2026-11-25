/**
 * Milestone D3 — Privacy-preserving canonical event mapping (`endo.event.v0`) and deterministic lifecycle fold
 * (`lifecycle.*`) for Codex App Server (`codex-live`).
 *
 * Privacy invariants (matching `adapters/pi/mapping.ts`):
 * - NO prompt text, assistant text, reasoning summary/raw text, command arguments/stdout, file contents/patches,
 *   or raw error messages ever cross into canonical `endo.event.v0` payloads.
 * - Only opaque native identifiers (`threadId`, `sessionTreeId`, `turnId`, `itemId`, `requestId`), closed kinds/phases,
 *   nullable exit codes, token counts (omitted/unavailable when missing — NEVER fabricated as 0), and digests are recorded.
 * - Live transcript text and reasoning summaries remain memory-only on the live adapter view.
 *
 * Lifecycle fold (`codexLifecycleStepV0`):
 * - Pure deterministic fold from `codex-app-server:<attachment>` events into `codex-lifecycle:<attachment>` canonical
 *   `lifecycle.*` interpretations (`derivedFrom: [sourceEvent.id]`), readable independently by `reduceEndoSessionOverviewV0`
 *   and `replayEndoEventRecordV0`.
 */

import { type EndoEventSourceV0, type EndoEventV0, validateEndoEventV0 } from "../../protocol/event.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	type EndoLifecycleKindV0,
	type EndoUnavailableFieldV0,
	endoReportedV0,
	endoUnavailableV0,
} from "../../protocol/session-lifecycle.ts";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";

export const CODEX_RECORDING_PRODUCER_PREFIX_V0 = "codex-app-server:";
export const CODEX_LIFECYCLE_PRODUCER_PREFIX_V0 = "codex-lifecycle:";

const LOCAL_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** Canonical `endo.session.*` coordinate for a Codex thread ID. */
export function codexEndoSessionIdV0(threadId: string): string {
	return LOCAL_ID.test(threadId)
		? `endo.session.codex.${threadId}`
		: `endo.session.codex.sha256-${sha256HexV0(threadId).slice(0, 48)}`;
}

/** Canonical `endo.run.*` coordinate for a Codex turn ID. */
export function codexEndoRunIdV0(turnId: string): string {
	return LOCAL_ID.test(turnId)
		? `endo.run.codex.${turnId}`
		: `endo.run.codex.sha256-${sha256HexV0(turnId).slice(0, 48)}`;
}

/** Facts Codex App Server does not report, declared explicitly on `lifecycle.session-started`. */
export const CODEX_LIFECYCLE_UNAVAILABLE_V0: readonly EndoUnavailableFieldV0[] = Object.freeze([
	{
		field: "usage.costUsd",
		reason: "Codex App Server thread/tokenUsage/updated reports token counts without USD cost",
	},
	{
		field: "queue.followUp",
		reason: "Codex App Server exposes no Pi-equivalent follow_up RPC",
	},
	{
		field: "nativeCommand",
		reason: "Codex App Server exposes no typed programmatic slash-command RPC",
	},
]);

export interface CodexEventContextV0 {
	readonly attachment: string;
	readonly instanceId: string;
	readonly threadId: string | null;
	readonly turnId?: string | null;
	nextSequence(): number;
	nextLive(): number;
	now(): string;
}

export function buildCodexCanonicalEventV0(args: {
	readonly context: CodexEventContextV0;
	readonly kind: string;
	readonly source?: EndoEventSourceV0;
	readonly payload: Record<string, JsonValueV0>;
	readonly turnId?: string | null;
	readonly derivedFrom?: readonly string[];
}): EndoEventV0 {
	const seq = args.context.nextSequence();
	const live = args.context.nextLive();
	const threadId = args.context.threadId;
	const turnId = args.turnId ?? args.context.turnId ?? null;
	const id = `endo.event.codex-live.${sha256HexV0(`${args.context.attachment}\u0000${args.context.instanceId}\u0000${live}\u0000${args.kind}`).slice(0, 48)}`;
	const coordinates: EndoEventV0["coordinates"] = {
		...(threadId !== null ? { sessionId: codexEndoSessionIdV0(threadId) } : {}),
		...(turnId !== null ? { runId: codexEndoRunIdV0(turnId) } : {}),
	};
	const event: EndoEventV0 = {
		schemaVersion: "endo.event.v0",
		id,
		kind: args.kind,
		source: args.source ?? "runtime-fact",
		sequence: seq,
		at: args.context.now(),
		coordinates,
		producer: `${CODEX_RECORDING_PRODUCER_PREFIX_V0}${args.context.attachment}`,
		derivedFrom: [...(args.derivedFrom ?? [])],
		payload: args.payload,
	};
	const validated = validateEndoEventV0(event);
	if (validated === null) {
		throw new TypeError(`Codex canonical event (${args.kind}) failed endo.event.v0 validation`);
	}
	return validated;
}

export interface CodexLifecycleStateV0 {
	readonly attachment: string;
	readonly attached: boolean;
	readonly activeTurnId: string | null;
	readonly stopRequestedForTurn: boolean;
	readonly emitted: number;
}

export function codexLifecycleInitialStateV0(attachment: string): CodexLifecycleStateV0 {
	return {
		attachment,
		attached: false,
		activeTurnId: null,
		stopRequestedForTurn: false,
		emitted: 0,
	};
}

export function codexLifecycleEventIdV0(sourceId: string, kind: string, index: number): string {
	return `endo.event.codex-lifecycle.${sha256HexV0(`${sourceId}\u0000${kind}\u0000${index}`).slice(0, 48)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deterministic fold from one recorded `codex-app-server:<attachment>` event into canonical `lifecycle.*`
 * interpretations readable by `reduceEndoSessionOverviewV0`.
 */
export function codexLifecycleStepV0(
	state: CodexLifecycleStateV0,
	event: EndoEventV0,
): { state: CodexLifecycleStateV0; events: EndoEventV0[] } {
	if (event.producer !== `${CODEX_RECORDING_PRODUCER_PREFIX_V0}${state.attachment}`) {
		return { state, events: [] };
	}
	const payload = isRecord(event.payload) ? event.payload : {};
	let next = state;
	const out: EndoEventV0[] = [];

	const emit = (kind: EndoLifecycleKindV0, body: Record<string, JsonValueV0>): void => {
		const seq = next.emitted + 1;
		const lifecycle: EndoEventV0 = {
			schemaVersion: "endo.event.v0",
			id: codexLifecycleEventIdV0(event.id, kind, out.length),
			kind,
			source: "interpretation",
			sequence: seq,
			at: event.at,
			coordinates: { ...event.coordinates },
			producer: `${CODEX_LIFECYCLE_PRODUCER_PREFIX_V0}${state.attachment}`,
			derivedFrom: [event.id],
			payload: body,
		};
		const validated = validateEndoEventV0(lifecycle);
		if (validated === null) {
			throw new TypeError(`Codex lifecycle event (${kind}) failed endo.event.v0 validation`);
		}
		out.push(validated);
		next = { ...next, emitted: seq };
	};

	switch (event.kind) {
		case "codex.thread-started": {
			const threadId = typeof payload.threadId === "string" ? payload.threadId : null;
			const instance = typeof payload.instanceId === "string" ? payload.instanceId : null;
			if (threadId !== null) {
				next = { ...next, attached: true, activeTurnId: null, stopRequestedForTurn: false };
				emit("lifecycle.session-started", {
					runtime: "codex",
					runtimeSessionId: threadId,
					...(instance === null ? {} : { instance }),
					unavailable: CODEX_LIFECYCLE_UNAVAILABLE_V0.map((u) => ({ field: u.field, reason: u.reason })),
				});
			}
			break;
		}
		case "codex.turn-started": {
			const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
			const instance = typeof payload.instanceId === "string" ? payload.instanceId : null;
			next = { ...next, activeTurnId: turnId, stopRequestedForTurn: false };
			emit("lifecycle.run-started", {
				...(instance === null ? {} : { instance }),
				...(turnId === null ? {} : { turnId }),
			});
			emit("lifecycle.turn-started", {
				turn: 1,
				...(turnId === null ? {} : { turnId }),
			});
			break;
		}
		case "codex.turn-completed": {
			const status = typeof payload.status === "string" ? payload.status : "unclassified";
			const stopRequested = next.stopRequestedForTurn;
			if (next.activeTurnId === null) {
				emit("lifecycle.anomaly", {
					observed: event.kind,
					problem: "codex.turn-completed observed with no open turn",
				});
				break;
			}
			emit("lifecycle.turn-completed", {
				turn: 1,
				stopReason: endoReportedV0(status),
			});
			if (status === "completed") {
				emit("lifecycle.run-completed", {
					turns: 1,
					stopReason: endoReportedV0("completed"),
					stopRequested,
				});
			} else if (status === "interrupted") {
				emit("lifecycle.run-aborted", {
					turns: 1,
					stopReason: endoReportedV0("interrupted"),
					stopRequested,
				});
			} else if (status === "failed") {
				emit("lifecycle.run-failed", {
					turns: 1,
					stopReason: endoReportedV0("failed"),
					cause: {
						source: "codex-turn-error",
						codexErrorInfo: typeof payload.codexErrorInfo === "string" ? payload.codexErrorInfo : null,
					},
					stopRequested,
				});
			} else {
				emit("lifecycle.run-unclassified", {
					turns: 1,
					stopReason: endoUnavailableV0(`unclassified Codex turn status (${status})`),
					reason: status,
				});
			}
			next = { ...next, activeTurnId: null, stopRequestedForTurn: false };
			break;
		}
		case "codex.stop-requested": {
			const runOpen = next.activeTurnId !== null;
			if (runOpen) next = { ...next, stopRequestedForTurn: true };
			emit("lifecycle.stop-requested", { runOpen });
			break;
		}
		case "codex.stop-accepted": {
			emit("lifecycle.stop-accepted", { runOpen: next.activeTurnId !== null });
			break;
		}
		case "codex.stop-refused": {
			emit("lifecycle.stop-refused", { runOpen: next.activeTurnId !== null });
			break;
		}
		case "codex.thread-compacted": {
			emit("lifecycle.compacted", {
				reason: "codex-thread-compacted",
				firstKeptEntryId: null,
				tokensBefore: null,
			});
			break;
		}
		case "codex.connection-lost": {
			const instance = typeof payload.instanceId === "string" ? payload.instanceId : null;
			const runOpen = next.activeTurnId !== null;
			const stopRequested = next.stopRequestedForTurn;
			if (runOpen || payload.expected !== true) {
				emit("lifecycle.interrupted", {
					cause: "runtime-exited",
					...(instance === null ? {} : { instance }),
					runOpen,
					turnOpen: runOpen,
					turns: runOpen ? 1 : 0,
					stopRequested,
					exit: isRecord(payload.exit) ? (payload.exit as JsonValueV0) : null,
				});
			} else {
				emit("lifecycle.detached", {
					...(instance === null ? {} : { instance }),
					expected: true,
					exit: isRecord(payload.exit) ? (payload.exit as JsonValueV0) : null,
				});
			}
			next = { ...next, activeTurnId: null, stopRequestedForTurn: false };
			break;
		}
		case "codex.unrecognized-notification": {
			emit("lifecycle.unrecognized-runtime-event", {
				runtimeEvent: typeof payload.method === "string" ? payload.method : "unknown",
			});
			break;
		}
		default:
			break;
	}

	return { state: next, events: out };
}
