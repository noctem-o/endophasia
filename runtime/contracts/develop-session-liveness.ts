// Controller-observed session liveness and termination evidence (E2-E).
//
// Pure observation layer over `EndoDevelopLiveAdapterV0` (`describe()` + `snapshot()`) and offline recorded event
// metadata. Establishes the structured observation foundation that a future heartbeat service (S1+) can consume,
// without introducing any background timer or daemon in E2.
//
// Invariants:
// - Live observation differentiates: `connected`, `running`, `disconnected`, `termination-confirmed`,
//   `liveness-unknown`, `stale-observation`, `unsupported-observation`.
// - `termination-confirmed` requires verified OS containment cleanup (`boundary: "scope"`, `result: "confirmed"`,
//   `remainingProcesses: 0`). A disconnected or paused adapter NEVER yields `termination-confirmed`.
// - Offline projections NEVER emit `connected`, `running`, or `termination.confirmed: true`.

import { endoAdapterSessionKeyV0 } from "../../protocol/develop-adapter.ts";
import {
	ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
	type EndoOfflineSessionLivenessStateV0,
	type EndoSessionLivenessObservationV0,
	type EndoSessionLivenessStateV0,
	validateEndoSessionLivenessObservationV0,
} from "../../protocol/develop-session-liveness.ts";
import type { EndoDevelopLiveAdapterV0 } from "./develop-adapter.ts";

export const DEFAULT_LIVE_LIVENESS_STALE_AFTER_MS_V0 = 60_000;

/**
 * Derive a controller-observed liveness and termination observation from an in-process live adapter.
 * Read-only and deterministic: takes no locks, sends no prompts, starts no timers.
 */
export function endoObserveAdapterLivenessV0(
	adapter: Pick<EndoDevelopLiveAdapterV0, "describe" | "snapshot">,
	options: { nowMs?: number; staleAfterMs?: number } = {},
): EndoSessionLivenessObservationV0 {
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_LIVE_LIVENESS_STALE_AFTER_MS_V0;
	const d = adapter.describe();
	const s = adapter.snapshot();
	const nowMs = options.nowMs ?? Date.now();
	const sessionKey = endoAdapterSessionKeyV0(d.session);
	const parsedSnapshot = Date.parse(s.observedAt);
	const snapshotAtMs = Number.isFinite(parsedSnapshot) && parsedSnapshot >= 0 ? Math.trunc(parsedSnapshot) : null;
	const cleanup = s.processCleanup;
	const terminationConfirmed =
		s.connection.state === "disconnected" &&
		cleanup.boundary === "scope" &&
		cleanup.result === "confirmed" &&
		cleanup.remainingProcesses === 0;

	let state: EndoSessionLivenessStateV0;
	let reason: string | null = s.connection.reason;

	if (s.connection.state === "not-applicable") {
		state = "unsupported-observation";
		reason = reason ?? "Adapter does not support live connection observation.";
	} else if (snapshotAtMs === null || snapshotAtMs > nowMs + 5_000 || nowMs - snapshotAtMs > staleAfterMs) {
		state = "stale-observation";
		reason =
			snapshotAtMs === null
				? "Adapter snapshot timestamp is missing or invalid."
				: snapshotAtMs > nowMs + 5_000
					? "Adapter snapshot timestamp is ahead of controller clock."
					: `Adapter snapshot is older than ${staleAfterMs} ms (${nowMs - snapshotAtMs} ms).`;
	} else if (terminationConfirmed) {
		state = "termination-confirmed";
		reason = null;
	} else if (s.connection.state === "disconnected") {
		state = "disconnected";
		reason =
			reason ?? "Transport is disconnected; process termination is not confirmed without verified OS scope cleanup.";
	} else if (s.connection.state === "connected") {
		if (s.activeTurn !== null && s.activeTurn.state === "in-progress") {
			state = "running";
		} else {
			state = "connected";
		}
	} else {
		state = "liveness-unknown";
		reason = reason ?? `Connection state is ${s.connection.state}; current process liveness is unknown.`;
	}

	return validateEndoSessionLivenessObservationV0({
		schemaVersion: ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
		observedAtMs: nowMs,
		snapshotAtMs,
		staleAfterMs,
		observationMode: "live-controller",
		basis: "controller-observed",
		source: d.session.source,
		harnessFamily: d.harness.family,
		sessionKey,
		attachmentId: d.attachment.attachmentId,
		instanceId: d.attachment.instanceId,
		runtimeFingerprintId: d.runtimeFingerprint.status === "identified" ? d.runtimeFingerprint.fingerprintId : null,
		state,
		connectionState: s.connection.state,
		activeTurnState: s.activeTurn?.state ?? null,
		termination: {
			confirmed: state === "termination-confirmed",
			boundary: cleanup.boundary,
			result: cleanup.result,
			remainingProcesses: cleanup.remainingProcesses,
			scopeName: cleanup.scopeName,
		},
		reason,
	});
}

/**
 * Offline session liveness observation: NEVER claims `connected`, `running`, or `termination-confirmed`.
 * Reports freshness honestly from recorded events while keeping `termination.confirmed: false`.
 */
export function endoOfflineSessionLivenessV0(args: {
	observedAtMs: number;
	source: string;
	harnessFamily: string | null;
	sessionKey: string | null;
	attachmentId: string | null;
	instanceId: string | null;
	runtimeFingerprintId: string | null;
	lastRecordedAtMs: number | null;
	eventsAvailable: boolean;
	staleAfterMs?: number;
}): EndoSessionLivenessObservationV0 {
	const staleAfterMs = args.staleAfterMs ?? 600_000;
	let state: EndoOfflineSessionLivenessStateV0;
	let reason: string;
	if (!args.eventsAvailable) {
		state = "unsupported-observation";
		reason = "Offline projection with unavailable event log; live process state cannot be observed.";
	} else if (
		args.lastRecordedAtMs !== null &&
		(args.lastRecordedAtMs > args.observedAtMs || args.observedAtMs - args.lastRecordedAtMs > staleAfterMs)
	) {
		state = "stale-observation";
		reason = "Recorded session activity is stale; offline projection cannot establish live state or termination.";
	} else {
		state = "liveness-unknown";
		reason = "Offline projection cannot observe live process liveness or confirm termination.";
	}
	return validateEndoSessionLivenessObservationV0({
		schemaVersion: ENDO_SESSION_LIVENESS_OBSERVATION_SCHEMA_V0,
		observedAtMs: args.observedAtMs,
		snapshotAtMs: args.lastRecordedAtMs,
		staleAfterMs,
		observationMode: "offline-projection",
		basis: args.eventsAvailable ? "recorded" : "unavailable",
		source: args.source,
		harnessFamily: args.harnessFamily,
		sessionKey: args.sessionKey,
		attachmentId: args.attachmentId,
		instanceId: args.instanceId,
		runtimeFingerprintId: args.runtimeFingerprintId,
		state,
		connectionState: "unknown",
		activeTurnState: null,
		termination: {
			confirmed: false,
			boundary: "unverified",
			result: "unverified",
			remainingProcesses: null,
			scopeName: null,
		},
		reason,
	});
}
