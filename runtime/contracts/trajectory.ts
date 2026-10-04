// Trajectory comparison: two `endo.trajectory.v1` records in, one `endo.trajectory-comparison.v1` out
// (protocol/trajectory.ts). Pure and deterministic: no store, runtime or network is read, and the same two records
// always give the same comparison, byte for byte, with the same digest.
//
// The rules are ENDO_TRAJECTORY_COMPARISON_RULES_V0, carried verbatim in every result:
// - Alignment is by position within each layer, never by timestamp.
// - lifecycle, toolCalls, toolResults and outcome are judged: EXACT, DIVERGED at the first differing position (with both entries and
//   the common-prefix length), or UNAVAILABLE.
// - Tool argument and result digests compare only within one digest domain. Different key ids make an entry unverifiable
//   ("different digest domains"), never a divergence: two HMACs under different keys say nothing about equality.
// - usage (runtime-reported tokens) and timing (the observer's clock) are never judged. They report deltas (b minus a)
//   per aligned run and in total; deciding whether a delta is noise needs a noise band, which belongs to the variance
//   study, not here.
// - A difference in runtime fingerprint, version, mapping, digest domain, configuration or model never changes a
//   verdict; it is listed in `flags` so a reader never mistakes a mixed comparison for a like-for-like one.
// - compare(b, a) is compare(a, b) with the sides swapped and the usage and timing deltas negated.
// - The digest covers content identities and the result, not where the stores sit (`provenance`).

import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	ENDO_TRAJECTORY_COMPARISON_RULES_V0,
	type EndoTrajectoryComparisonV0,
	type EndoTrajectoryFlagV0,
	type EndoTrajectoryLayerV0,
	type EndoTrajectoryTimingComparisonV0,
	type EndoTrajectoryTimingEntryV0,
	type EndoTrajectoryTokenDeltaV0,
	type EndoTrajectoryToolCallEntryV0,
	type EndoTrajectoryToolCallsAgainstInputsV0,
	type EndoTrajectoryToolResultEntryV0,
	type EndoTrajectoryUsageComparisonV0,
	type EndoTrajectoryUsageEntryV0,
	type EndoTrajectoryV0,
	type EndoTrajectoryVerdictV0,
	validateEndoTrajectoryComparisonV0,
	validateEndoTrajectoryV0,
} from "../../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

/** The identity digest of a record: sha256 of its canonical JSON with `digest` and `provenance` left out. */
export function endoRecordDigestV0(record: Record<string, unknown>): string {
	const { digest: _digest, provenance: _provenance, ...body } = record;
	return sha256HexV0(canonicalEndoJsonV0(body));
}

/** Seal a trajectory body with its digest and validate it; throws when the result is not a valid record. */
export function sealEndoTrajectoryV0(body: Omit<EndoTrajectoryV0, "digest">): EndoTrajectoryV0 {
	const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	const sealed = { ...plain, digest: endoRecordDigestV0(plain) };
	const valid = validateEndoTrajectoryV0(sealed, endoRecordDigestV0);
	if (valid === null) throw new TypeError("the projected trajectory failed endo.trajectory.v1 validation");
	return valid;
}

/** Equal, differing, or not verifiable (with the reason). */
type Agreement = "equal" | "differ" | { unverified: string };

function same(a: unknown, b: unknown): boolean {
	return canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
}

/** Where the docs explain sharing one digest key between machines (storage/digest-key.ts). */
const CROSS_MACHINE_DOC = "docs/trajectory.md#comparing-across-machines";

const canonicalAgreement = (a: unknown, b: unknown): Agreement => (same(a, b) ? "equal" : "differ");

/** Two keyed digests of one field: equal, differing, or unverifiable (not recorded, or different digest domains). */
function digestAgreement(
	what: string,
	a: EndoTrajectoryToolCallEntryV0["argsDigest"],
	b: EndoTrajectoryToolCallEntryV0["argsDigest"],
): Agreement {
	// Reasons name no side, so that compare(b, a) is exactly compare(a, b) swapped.
	if (a.status !== "reported" || b.status !== "reported") {
		const both = a.status !== "reported" && b.status !== "reported";
		return { unverified: `no ${what} digest was recorded on ${both ? "either side" : "one side"}` };
	}
	if (a.value.keyId !== b.value.keyId)
		return {
			unverified: `different digest domains (${[a.value.keyId, b.value.keyId].sort().join(" and ")}); to compare across machines, share one key: ${CROSS_MACHINE_DOC}`,
		};
	return a.value.value === b.value.value ? "equal" : "differ";
}

/** The agreement of several digest agreements: differ if any differs, else unverifiable with every reason, else equal. */
function combine(agreements: Agreement[]): Agreement {
	if (agreements.includes("differ")) return "differ";
	const reasons = agreements.flatMap((agreement) => (typeof agreement === "object" ? [agreement.unverified] : []));
	return reasons.length === 0 ? "equal" : { unverified: [...new Set(reasons)].join("; ") };
}

/**
 * Tool calls: name and position facts must be equal; the argument digest compares only in one digest domain (a digest
 * one side did not record, or under another key id, leaves the entry unverifiable, never equal or diverged).
 */
function toolCallAgreement(a: EndoTrajectoryToolCallEntryV0, b: EndoTrajectoryToolCallEntryV0): Agreement {
	const { argsDigest: argsA, ...restA } = a;
	const { argsDigest: argsB, ...restB } = b;
	if (!same(restA, restB)) return "differ";
	return combine([digestAgreement("argument", argsA, argsB)]);
}

/** Tool results: name, status and position facts must be equal; the result digest under the same domain rule. */
function toolResultAgreement(a: EndoTrajectoryToolResultEntryV0, b: EndoTrajectoryToolResultEntryV0): Agreement {
	const { resultDigest: resultA, ...restA } = a;
	const { resultDigest: resultB, ...restB } = b;
	if (!same(restA, restB)) return "differ";
	return combine([digestAgreement("result", resultA, resultB)]);
}

type Position = { run: number | null; turn: number | null };

/** The earlier of two (run, turn) positions; a side past its end (undefined) is ignored. Symmetric in its arguments. */
function earlier(a: Position | undefined, b: Position | undefined): Position | null {
	const known = [a, b].filter((position): position is Position => position !== undefined);
	if (known.length === 0) return null;
	return known.reduce((x, y) => {
		if (x.run === null || x.turn === null || y.run === null || y.turn === null) return { run: null, turn: null };
		return x.run < y.run || (x.run === y.run && x.turn <= y.turn) ? x : y;
	});
}

/**
 * Did the tool calls stay identical until an input (a tool result) diverged? From the two judged layers: the first
 * diverged result and call, located at the earlier (run, turn) of the two sides (so the field is symmetric).
 */
function toolCallsAgainstInputs(
	a: EndoTrajectoryV0,
	b: EndoTrajectoryV0,
	calls: EndoTrajectoryVerdictV0,
	results: EndoTrajectoryVerdictV0,
): EndoTrajectoryToolCallsAgainstInputsV0 {
	const at = (layer: "toolCalls" | "toolResults", index: number) => {
		const entry = (side: EndoTrajectoryV0) => {
			const l = side.layers[layer];
			return l.status === "reported" ? (l.entries[index] as Position | undefined) : undefined;
		};
		const position = earlier(entry(a), entry(b));
		return { index, run: position?.run ?? null, turn: position?.turn ?? null };
	};
	const firstDivergentResult = results.status === "DIVERGED" ? at("toolResults", results.index) : null;
	const firstDivergentCall = calls.status === "DIVERGED" ? at("toolCalls", calls.index) : null;
	const base = { firstDivergentResult, firstDivergentCall };
	if (calls.status === "UNAVAILABLE" && calls.unverified.length === 0)
		return {
			...base,
			callsIdenticalUpToFirstDivergentInput: null,
			reason: "the tool calls are unavailable on a side",
		};
	if (calls.status === "EXACT")
		return {
			...base,
			callsIdenticalUpToFirstDivergentInput: true,
			reason: "the tool calls are identical throughout",
		};
	if (calls.status === "UNAVAILABLE")
		return { ...base, callsIdenticalUpToFirstDivergentInput: null, reason: "some tool calls could not be verified" };
	if (firstDivergentResult === null)
		return results.status === "UNAVAILABLE"
			? {
					...base,
					callsIdenticalUpToFirstDivergentInput: null,
					reason: "the tool results are unavailable or unverifiable, so no divergent input can be located",
				}
			: {
					...base,
					callsIdenticalUpToFirstDivergentInput: false,
					reason: "the tool calls diverged while every tool result was identical",
				};
	const call = firstDivergentCall!;
	if (
		call.run === null ||
		call.turn === null ||
		firstDivergentResult.run === null ||
		firstDivergentResult.turn === null
	)
		return {
			...base,
			callsIdenticalUpToFirstDivergentInput: null,
			reason: "a run or turn is unknown, so the order cannot be told",
		};
	const after =
		call.run > firstDivergentResult.run ||
		(call.run === firstDivergentResult.run && call.turn > firstDivergentResult.turn);
	return after
		? {
				...base,
				callsIdenticalUpToFirstDivergentInput: true,
				reason: "the first diverged call was made in a later turn than the first diverged result",
			}
		: {
				...base,
				callsIdenticalUpToFirstDivergentInput: false,
				reason:
					"a call diverged no later than the first diverged result's turn, before that input could have been seen",
			};
}

function judge<T>(
	a: EndoTrajectoryLayerV0<T>,
	b: EndoTrajectoryLayerV0<T>,
	agree: (x: T, y: T) => Agreement,
): EndoTrajectoryVerdictV0 {
	if (a.status === "UNAVAILABLE" || b.status === "UNAVAILABLE") {
		return {
			status: "UNAVAILABLE",
			a: a.status === "UNAVAILABLE" ? a.reason : null,
			b: b.status === "UNAVAILABLE" ? b.reason : null,
			unverified: [],
			lengths: null,
		};
	}
	const lengths = { a: a.entries.length, b: b.entries.length };
	const shared = Math.min(lengths.a, lengths.b);
	const unverified: { index: number; reason: string }[] = [];
	const diverged = (index: number): EndoTrajectoryVerdictV0 => ({
		status: "DIVERGED",
		index,
		commonPrefix: index,
		lengths,
		a: (a.entries[index] ?? null) as JsonValueV0,
		b: (b.entries[index] ?? null) as JsonValueV0,
	});
	for (let index = 0; index < shared; index += 1) {
		const agreement = agree(a.entries[index]!, b.entries[index]!);
		if (agreement === "differ") return diverged(index);
		if (agreement !== "equal") unverified.push({ index, reason: agreement.unverified });
	}
	if (lengths.a !== lengths.b) return diverged(shared);
	if (unverified.length > 0) return { status: "UNAVAILABLE", a: null, b: null, unverified, lengths };
	return { status: "EXACT", length: shared };
}

/** b minus a, rounded to 1e-9 so binary float noise in a cost sum does not show as a delta. */
function delta(a: number, b: number): number {
	return Math.round((b - a) * 1e9) / 1e9;
}

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "costTotal"] as const;

function tokenDelta(a: Record<string, number>, b: Record<string, number>): EndoTrajectoryTokenDeltaV0 {
	const out: EndoTrajectoryTokenDeltaV0 = {};
	for (const field of TOKEN_FIELDS) {
		const x = a[field];
		const y = b[field];
		if (x === undefined && y === undefined) continue;
		out[field] = x === undefined || y === undefined ? null : delta(x, y);
	}
	return out;
}

const tokensOf = (entry: EndoTrajectoryUsageEntryV0 | undefined): Record<string, number> | null =>
	entry?.tokens.status === "reported" ? (entry.tokens.value as unknown as Record<string, number>) : null;

/** A side's token totals over its runs: a field only when every run with reported tokens has it. */
function tokenTotals(entries: readonly EndoTrajectoryUsageEntryV0[]): Record<string, number> | null {
	const reported = entries.map(tokensOf).filter((item): item is Record<string, number> => item !== null);
	if (reported.length === 0) return null;
	const totals: Record<string, number> = {};
	for (const field of TOKEN_FIELDS)
		if (reported.every((item) => field in item))
			totals[field] = reported.reduce((total, item) => total + item[field]!, 0);
	return totals;
}

function bothReported<T>(
	a: EndoTrajectoryLayerV0<T>,
	b: EndoTrajectoryLayerV0<T>,
): { status: "UNAVAILABLE"; a: string | null; b: string | null } | null {
	if (a.status === "reported" && b.status === "reported") return null;
	return {
		status: "UNAVAILABLE",
		a: a.status === "UNAVAILABLE" ? a.reason : null,
		b: b.status === "UNAVAILABLE" ? b.reason : null,
	};
}

function usageDeltas(
	a: EndoTrajectoryLayerV0<EndoTrajectoryUsageEntryV0>,
	b: EndoTrajectoryLayerV0<EndoTrajectoryUsageEntryV0>,
): EndoTrajectoryUsageComparisonV0 {
	const unavailable = bothReported(a, b);
	if (unavailable !== null || a.status !== "reported" || b.status !== "reported") return unavailable!;
	const runs = [];
	for (let index = 0; index < Math.max(a.entries.length, b.entries.length); index += 1) {
		const x = tokensOf(a.entries[index]);
		const y = tokensOf(b.entries[index]);
		runs.push({
			run: index + 1,
			present: { a: a.entries[index] !== undefined, b: b.entries[index] !== undefined },
			tokens: x === null || y === null ? null : tokenDelta(x, y),
		});
	}
	const totalA = tokenTotals(a.entries);
	const totalB = tokenTotals(b.entries);
	return {
		status: "DELTAS",
		runs,
		totals: { tokens: totalA === null || totalB === null ? {} : tokenDelta(totalA, totalB) },
	};
}

const wallOf = (entry: EndoTrajectoryTimingEntryV0 | undefined): number | null =>
	entry?.wallMs.status === "reported" ? entry.wallMs.value : null;

function timingDeltas(
	a: EndoTrajectoryLayerV0<EndoTrajectoryTimingEntryV0>,
	b: EndoTrajectoryLayerV0<EndoTrajectoryTimingEntryV0>,
): EndoTrajectoryTimingComparisonV0 {
	const unavailable = bothReported(a, b);
	if (unavailable !== null || a.status !== "reported" || b.status !== "reported") return unavailable!;
	const runs = [];
	for (let index = 0; index < Math.max(a.entries.length, b.entries.length); index += 1) {
		const x = wallOf(a.entries[index]);
		const y = wallOf(b.entries[index]);
		runs.push({
			run: index + 1,
			present: { a: a.entries[index] !== undefined, b: b.entries[index] !== undefined },
			wallMs: x === null || y === null ? null : delta(x, y),
		});
	}
	// A total only when every run on both sides has a wall time: a partial sum would compare unlike things.
	const total = (entries: readonly EndoTrajectoryTimingEntryV0[]): number | null => {
		const walls = entries.map(wallOf);
		return walls.length > 0 && walls.every((wall) => wall !== null) ? walls.reduce((x, y) => x! + y!, 0) : null;
	};
	const totalA = total(a.entries);
	const totalB = total(b.entries);
	return {
		status: "DELTAS",
		clock: "observer",
		runs,
		totals: { wallMs: totalA === null || totalB === null ? null : delta(totalA, totalB) },
	};
}

type AttachmentField = keyof EndoTrajectoryV0["environment"]["attachments"][number];

/** The distinct reported values of one attachment field, in attachment order; UNAVAILABLE ones as `null`. */
function distinct(trajectory: EndoTrajectoryV0, field: AttachmentField, pick = (value: unknown) => value) {
	const values: JsonValueV0[] = [];
	for (const attachment of trajectory.environment.attachments) {
		const item = attachment[field];
		const value = (item.status === "reported" ? pick(item.value) : null) as JsonValueV0;
		if (!values.some((seen) => same(seen, value))) values.push(value);
	}
	return values;
}

function flags(a: EndoTrajectoryV0, b: EndoTrajectoryV0): EndoTrajectoryFlagV0[] {
	const out: EndoTrajectoryFlagV0[] = [];
	const check = (kind: EndoTrajectoryFlagV0["kind"], x: JsonValueV0, y: JsonValueV0): void => {
		if (!same(x, y)) out.push({ kind, a: x, b: y });
	};
	const keyId = (value: unknown) => (value as { keyId: string }).keyId;
	check("runtime-fingerprint-differs", distinct(a, "identityDigest"), distinct(b, "identityDigest"));
	check("runtime-version-differs", distinct(a, "version"), distinct(b, "version"));
	check("mapping-differs", distinct(a, "mapping"), distinct(b, "mapping"));
	check("digest-domain-differs", distinct(a, "digestKey", keyId), distinct(b, "digestKey", keyId));
	check(
		"configuration-differs",
		{ user: distinct(a, "userConfigurationDigest"), project: distinct(a, "projectConfigurationDigest") },
		{ user: distinct(b, "userConfigurationDigest"), project: distinct(b, "projectConfigurationDigest") },
	);
	check("configured-model-differs", distinct(a, "configuredModel"), distinct(b, "configuredModel"));
	check("reported-model-differs", a.environment.reportedModels, b.environment.reportedModels);
	check("projection-differs", a.projection, b.projection);
	return out;
}

/** Compare two trajectories under ENDO_TRAJECTORY_COMPARISON_RULES_V0. Throws on an invalid trajectory. */
export function compareEndoTrajectoriesV0(a: EndoTrajectoryV0, b: EndoTrajectoryV0): EndoTrajectoryComparisonV0 {
	for (const [side, trajectory] of [
		["a", a],
		["b", b],
	] as const) {
		if (validateEndoTrajectoryV0(JSON.parse(JSON.stringify(trajectory)), endoRecordDigestV0) === null)
			throw new TypeError(
				`trajectory ${side} is not a valid endo.trajectory.v1 record (or its digest does not match)`,
			);
	}
	const side = (trajectory: EndoTrajectoryV0) => ({
		session: trajectory.source.session,
		eventsSha256: trajectory.source.eventsSha256,
		trajectoryDigest: trajectory.digest,
	});
	const toolCalls = judge(a.layers.toolCalls, b.layers.toolCalls, toolCallAgreement);
	const toolResults = judge(a.layers.toolResults, b.layers.toolResults, toolResultAgreement);
	const body = {
		schemaVersion: "endo.trajectory-comparison.v1" as const,
		rules: { ...ENDO_TRAJECTORY_COMPARISON_RULES_V0 },
		a: side(a),
		b: side(b),
		flags: flags(a, b),
		toolCallsAgainstInputs: toolCallsAgainstInputs(a, b, toolCalls, toolResults),
		layers: {
			lifecycle: judge(a.layers.lifecycle, b.layers.lifecycle, canonicalAgreement),
			toolCalls,
			toolResults,
			outcome: judge(a.layers.outcome, b.layers.outcome, canonicalAgreement),
			usage: usageDeltas(a.layers.usage, b.layers.usage),
			timing: timingDeltas(a.layers.timing, b.layers.timing),
		},
		provenance: { a: { ...a.provenance }, b: { ...b.provenance } },
	};
	const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	const sealed = { ...plain, digest: endoRecordDigestV0(plain) };
	const valid = validateEndoTrajectoryComparisonV0(sealed, endoRecordDigestV0);
	if (valid === null) throw new TypeError("the comparison failed endo.trajectory-comparison.v1 validation");
	return valid;
}
