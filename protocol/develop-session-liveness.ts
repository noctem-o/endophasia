// Session liveness and termination observation schema (`endo.session-liveness-observation.v0`, E2-E).
//
// Establishes the observation vocabulary and honesty boundaries that live controllers expose today and a future
// heartbeat service (S1+) can consume, WITHOUT introducing a background heartbeat daemon in E2.
//
// Honesty invariants:
// - Offline projections NEVER claim `connected`, `running`, or `termination-confirmed`.
// - A transport disconnect or pause NEVER establishes process termination unless backed by confirmed OS containment
//   cleanup (`boundary: "scope"`, `result: "confirmed"`, `remainingProcesses: 0`).
// - Recorded activity is NOT proof of current process liveness.
// - Protocol imports only protocol.

import {
	ENDO_ADAPTER_BASES_V0,
	ENDO_ADAPTER_CLEANUP_BOUNDARIES_V0,
	ENDO_ADAPTER_CLEANUP_RESULTS_V0,
	ENDO_ADAPTER_CONNECTION_STATES_V0,
	ENDO_ADAPTER_TURN_STATES_V0,
	type EndoAdapterCleanupBoundaryV0,
	type EndoAdapterCleanupResultV0,
	type EndoAdapterConnectionStateV0,
	type EndoAdapterTurnStateV0,
} from "./develop-adapter.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0 = "endo.session-liveness-observation.v0";

export const ENDO_SESSION_LIVENESS_STATES_V0 = [
	"connected",
	"running",
	"disconnected",
	"termination-confirmed",
	"liveness-unknown",
	"stale-observation",
	"unsupported-observation",
] as const;
export type EndoSessionLivenessStateV0 = (typeof ENDO_SESSION_LIVENESS_STATES_V0)[number];

/** States an offline projection is permitted to emit (never live connection, active run, or confirmed termination). */
export const ENDO_OFFLINE_SESSION_LIVENESS_STATES_V0 = [
	"liveness-unknown",
	"stale-observation",
	"unsupported-observation",
] as const;
export type EndoOfflineSessionLivenessStateV0 = (typeof ENDO_OFFLINE_SESSION_LIVENESS_STATES_V0)[number];

export const ENDO_SESSION_LIVENESS_MODES_V0 = ["live-controller", "offline-projection"] as const;
export type EndoSessionLivenessModeV0 = (typeof ENDO_SESSION_LIVENESS_MODES_V0)[number];

export const ENDO_SESSION_LIVENESS_BASES_V0 = [...ENDO_ADAPTER_BASES_V0, "unavailable"] as const;
export type EndoSessionLivenessBasisV0 = (typeof ENDO_SESSION_LIVENESS_BASES_V0)[number];

export interface EndoSessionLivenessObservationV0 {
	schemaVersion: typeof ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0;
	observedAtMs: number;
	/** Snapshot timestamp when available; null if unavailable. */
	snapshotAtMs: number | null;
	/** Freshness window applied, or null if not applicable. */
	staleAfterMs: number | null;
	observationMode: EndoSessionLivenessModeV0;
	basis: EndoSessionLivenessBasisV0;
	source: string;
	harnessFamily: string | null;
	sessionKey: string | null;
	attachmentId: string | null;
	instanceId: string | null;
	runtimeFingerprintId: string | null;
	state: EndoSessionLivenessStateV0;
	connectionState: EndoAdapterConnectionStateV0;
	activeTurnState: EndoAdapterTurnStateV0 | null;
	termination: {
		confirmed: boolean;
		boundary: EndoAdapterCleanupBoundaryV0;
		result: EndoAdapterCleanupResultV0;
		remainingProcesses: number | null;
		scopeName: string | null;
	};
	reason: string | null;
}

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const SAFE_TOKEN = /^[\x21-\x7e]{1,256}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f]{1,512}$/;

function closed(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(value, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const k of keys) if (!Object.hasOwn(value, k)) return bad(`${what} lacks ${k}`);
	return value as Record<string, unknown>;
}

const oneOf = <T extends string>(v: unknown, values: readonly T[], what: string): T =>
	typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : bad(`${what} is not allowed`);

const nonNegInt = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is invalid`);

export function validateEndoSessionLivenessObservationV0(value: unknown): EndoSessionLivenessObservationV0 {
	const r = closed(
		value,
		[
			"schemaVersion",
			"observedAtMs",
			"snapshotAtMs",
			"staleAfterMs",
			"observationMode",
			"basis",
			"source",
			"harnessFamily",
			"sessionKey",
			"attachmentId",
			"instanceId",
			"runtimeFingerprintId",
			"state",
			"connectionState",
			"activeTurnState",
			"termination",
			"reason",
		],
		"session liveness observation",
	);
	if (r.schemaVersion !== ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0) bad("schemaVersion");
	const observationMode = oneOf(r.observationMode, ENDO_SESSION_LIVENESS_MODES_V0, "observationMode");
	const basis = oneOf(r.basis, ENDO_SESSION_LIVENESS_BASES_V0, "basis");
	const state = oneOf(r.state, ENDO_SESSION_LIVENESS_STATES_V0, "state");
	const connectionState = oneOf(r.connectionState, ENDO_ADAPTER_CONNECTION_STATES_V0, "connectionState");
	const activeTurnState =
		r.activeTurnState === null ? null : oneOf(r.activeTurnState, ENDO_ADAPTER_TURN_STATES_V0, "activeTurnState");

	const term = closed(
		r.termination,
		["confirmed", "boundary", "result", "remainingProcesses", "scopeName"],
		"termination",
	);
	if (typeof term.confirmed !== "boolean") return bad("termination.confirmed");
	const confirmed: boolean = term.confirmed;
	const boundary = oneOf(term.boundary, ENDO_ADAPTER_CLEANUP_BOUNDARIES_V0, "termination.boundary");
	const result = oneOf(term.result, ENDO_ADAPTER_CLEANUP_RESULTS_V0, "termination.result");
	const remainingProcesses =
		term.remainingProcesses === null ? null : nonNegInt(term.remainingProcesses, "termination.remainingProcesses");
	const scopeName =
		term.scopeName === null
			? null
			: typeof term.scopeName === "string" && SAFE_TOKEN.test(term.scopeName)
				? term.scopeName
				: bad("termination.scopeName");

	// Honesty enforcement:
	// 1. Offline projections NEVER claim connected, running, disconnected-live, or confirmed termination.
	if (observationMode === "offline-projection") {
		if (!(ENDO_OFFLINE_SESSION_LIVENESS_STATES_V0 as readonly string[]).includes(state))
			return bad("offline projection cannot claim live or confirmed-termination state");
		if (confirmed) return bad("offline projection cannot claim confirmed termination");
	}
	// 2. `termination.confirmed === true` is permitted ONLY when `state === "termination-confirmed"`, and requires
	//    verified OS scope cleanup with 0 remaining processes (Adversarial Finding #7A).
	if (confirmed !== (state === "termination-confirmed")) {
		return bad("termination.confirmed must be true if and only if state is termination-confirmed");
	}
	if (confirmed) {
		if (boundary !== "scope" || result !== "confirmed" || remainingProcesses !== 0)
			return bad("termination confirmation requires confirmed scope cleanup with zero remaining processes");
	}

	if (typeof r.source !== "string" || !SAFE_TOKEN.test(r.source)) return bad("source");
	const source: string = r.source;
	const optToken = (v: unknown, what: string): string | null =>
		v === null ? null : typeof v === "string" && SAFE_TOKEN.test(v) ? v : bad(what);
	const reason =
		r.reason === null ? null : typeof r.reason === "string" && SAFE_TEXT.test(r.reason) ? r.reason : bad("reason");

	return {
		schemaVersion: ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
		observedAtMs: nonNegInt(r.observedAtMs, "observedAtMs"),
		snapshotAtMs: r.snapshotAtMs === null ? null : nonNegInt(r.snapshotAtMs, "snapshotAtMs"),
		staleAfterMs: r.staleAfterMs === null ? null : nonNegInt(r.staleAfterMs, "staleAfterMs"),
		observationMode,
		basis,
		source,
		harnessFamily: optToken(r.harnessFamily, "harnessFamily"),
		sessionKey: optToken(r.sessionKey, "sessionKey"),
		attachmentId: optToken(r.attachmentId, "attachmentId"),
		instanceId: optToken(r.instanceId, "instanceId"),
		runtimeFingerprintId: optToken(r.runtimeFingerprintId, "runtimeFingerprintId"),
		state,
		connectionState,
		activeTurnState,
		termination: {
			confirmed,
			boundary,
			result,
			remainingProcesses,
			scopeName,
		},
		reason,
	};
}
