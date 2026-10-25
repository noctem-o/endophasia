// Source-specific assembly stays outside cockpit/: only the existing pure adapter projectors are reached here.
// No adapter index, importer, attachment, harness, process, filesystem discovery, write, clock or key loader is used.
import {
	DSH_NATIVE_CHECKPOINT_PRODUCER_V0,
	DSH_NATIVE_RECORDING_PRODUCER_V0,
	isRecord,
} from "../adapters/dsh-native/mapping.ts";
import { projectDshTrajectoryV0 } from "../adapters/dsh-native/trajectory.ts";
import { piTrajectoryAttachmentsV0, projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import {
	type EndoDigestKeyV0,
	projectEndoCockpitTrajectoryComparisonV0,
	readEndoCockpitVerifiedEventsV0,
} from "../cockpit/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { isEndoIdentifierV0 } from "../protocol/identity.ts";

export interface EndoCockpitComparisonSelectionV0 {
	source: "pi" | "dsh";
	session: string;
}

/** Both maximum-length selections still fit the transport's existing 512-character raw path budget. */
export function endoCockpitComparisonSelectionV0(
	source: unknown,
	session: unknown,
): EndoCockpitComparisonSelectionV0 | null {
	if (source !== "pi" && source !== "dsh") return null;
	if (typeof session !== "string" || session.length > 220 || !isEndoIdentifierV0(session, "session")) return null;
	// DSH's projector requires this namespace. Pi accepts any explicit Endophasia coordinate; evidence producers decide
	// whether it is a Pi recording. Neither source is inferred from a coordinate prefix or accepted as a raw runtime id.
	if (source === "dsh" && (!session.startsWith("endo.session.dsh.") || session === "endo.session.dsh.")) return null;
	return { source, session };
}

type Failure =
	| "source-absent"
	| "source-degraded"
	| "source-unopenable"
	| "not-found"
	| "ambiguous-selection"
	| "continuation-invalid"
	| "too-many-candidates";

/** Expected refusals contain a closed code only: never a source exception, coordinate, path, identifier or cause. */
export class EndoCockpitComparisonRefusalV0 extends Error {
	readonly refusal: Failure;
	constructor(refusal: Failure) {
		super(refusal);
		this.refusal = refusal;
	}
}

/** Recording evidence, not timeline membership or a coordinate prefix, establishes the candidate's source. */
export function endoCockpitRecordingSourceV0(event: EndoEventV0): "pi" | "dsh" | null {
	const session = event.coordinates.sessionId;
	if (session === undefined || session === null) return null;
	if (event.producer === DSH_NATIVE_RECORDING_PRODUCER_V0) return "dsh";
	return piTrajectoryAttachmentsV0([event], session).length > 0 ? "pi" : null;
}

/** Shared admission and trajectory validation for raw comparison, discovery and opaque selection. */
export function projectEndoCockpitRecordingV0(events: EndoEventV0[], selection: EndoCockpitComparisonSelectionV0) {
	const { session, source } = selection;
	if (
		!isEndoIdentifierV0(session, "session") ||
		(source === "dsh" && (!session.startsWith("endo.session.dsh.") || session === "endo.session.dsh."))
	)
		throw new EndoCockpitComparisonRefusalV0("source-degraded");
	// A fixed provenance label is private to the trajectories: the presentation never carries it.
	const store = "configured-store";
	if (source === "pi") {
		const attachments = piTrajectoryAttachmentsV0(events, session);
		if (attachments.length === 0) throw new EndoCockpitComparisonRefusalV0("not-found");
		if (attachments.length !== 1) throw new EndoCockpitComparisonRefusalV0("ambiguous-selection");
		return projectPiTrajectoryV0(events, { store, session, attachment: attachments[0]! });
	}
	const recording = events.filter(
		(event) => event.coordinates.sessionId === session && event.producer === DSH_NATIVE_RECORDING_PRODUCER_V0,
	);
	if (recording.length === 0) throw new EndoCockpitComparisonRefusalV0("not-found");
	// The trajectory intentionally omits import checkpoints. Admit only a completed, clean recorded import observation:
	// otherwise even a verified Endophasia log could conceal a torn DSH source or an interrupted cold import.
	const checkpoints = events
		.filter(
			(event) => event.coordinates.sessionId === session && event.producer === DSH_NATIVE_CHECKPOINT_PRODUCER_V0,
		)
		.sort((a, b) => b.sequence - a.sequence);
	const checkpoint = checkpoints[0];
	let last: { id: string; seq: number } | undefined;
	for (const event of recording) {
		if (event.kind === "dsh.session-imported") continue;
		const source = isRecord(event.payload) ? event.payload.source : null;
		if (
			!isRecord(source) ||
			typeof source.dshSeq !== "number" ||
			!Number.isSafeInteger(source.dshSeq) ||
			source.dshSeq < 0
		)
			throw new EndoCockpitComparisonRefusalV0("source-degraded");
		if (last === undefined || source.dshSeq > last.seq) last = { id: event.id, seq: source.dshSeq };
	}
	if (
		checkpoint === undefined ||
		checkpoint.kind !== "dsh.import-checkpoint" ||
		checkpoints[1]?.sequence === checkpoint.sequence ||
		!isRecord(checkpoint.payload) ||
		checkpoint.payload.tail !== "clean" ||
		last === undefined ||
		checkpoint.payload.highWaterDshSeq !== last.seq ||
		checkpoint.derivedFrom.length !== 1 ||
		checkpoint.derivedFrom[0] !== last.id
	)
		throw new EndoCockpitComparisonRefusalV0("source-degraded");
	return projectDshTrajectoryV0(events, { store, session, sessionKind: "endo-coordinate" });
}

/** One configured store, one verified read, two source projections, one authoritative comparison presentation. */
export function readEndoCockpitComparisonV0(
	root: string,
	a: EndoCockpitComparisonSelectionV0,
	b: EndoCockpitComparisonSelectionV0,
	digestKey: EndoDigestKeyV0,
) {
	if (
		endoCockpitComparisonSelectionV0(a?.source, a?.session) === null ||
		endoCockpitComparisonSelectionV0(b?.source, b?.session) === null
	)
		throw new TypeError("invalid comparison selection");
	return withEndoCockpitComparisonEventsV0(root, digestKey, (events) =>
		projectEndoCockpitTrajectoryComparisonV0(
			projectEndoCockpitRecordingV0(events, a),
			projectEndoCockpitRecordingV0(events, b),
			digestKey,
		),
	);
}

/** A single verified read, closed before projection, with no source errors or causes exposed even to host diagnostics. */
export function withEndoCockpitComparisonEventsV0<T>(
	root: string,
	digestKey: EndoDigestKeyV0,
	use: (events: EndoEventV0[]) => T,
): T {
	try {
		const read = readEndoCockpitVerifiedEventsV0(root, digestKey);
		if (!read.ok) throw new EndoCockpitComparisonRefusalV0(`source-${read.condition}`);
		return use(read.events);
	} catch (error) {
		if (error instanceof EndoCockpitComparisonRefusalV0) throw error;
		// Unexpected adapter/projection failures are host defects (500), not a fabricated UNAVAILABLE layer. Even the host's
		// diagnostic hook receives no raw source error or cause: adapter errors can contain private recorded identifiers.
		throw new Error("comparison projection failed");
	}
}
