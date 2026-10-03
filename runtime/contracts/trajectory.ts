// Trajectory comparison: two `endo.trajectory.v0` records in, one `endo.trajectory-comparison.v0` out
// (protocol/trajectory.ts). Pure and deterministic: no store, runtime or network is read, and the same two records
// always give the same comparison, byte for byte, with the same digest.
//
// The rules are ENDO_TRAJECTORY_COMPARISON_RULES_V0, carried verbatim in every result:
// - Alignment is by position within each layer, never by timestamp.
// - lifecycle, tools and outcome are judged: EXACT, DIVERGED at the first differing position (with both entries and
//   the common-prefix length), or UNAVAILABLE.
// - usage is never judged. It reports deltas (b minus a) per aligned run and in total; deciding whether a delta is
//   noise needs a noise band, which belongs to the variance study, not here.
// - A difference in runtime fingerprint, version, mapping, configuration or model never changes a verdict; it is
//   listed in `flags` so a reader never mistakes a mixed comparison for a like-for-like one.
// - compare(b, a) is compare(a, b) with the sides swapped and the usage deltas negated.

import type { JsonValueV0 } from "../../protocol/primitives.ts";
import {
	ENDO_TRAJECTORY_COMPARISON_RULES_V0,
	type EndoTrajectoryComparisonV0,
	type EndoTrajectoryFlagV0,
	type EndoTrajectoryLayerV0,
	type EndoTrajectoryTokenDeltaV0,
	type EndoTrajectoryToolEntryV0,
	type EndoTrajectoryUsageComparisonV0,
	type EndoTrajectoryUsageEntryV0,
	type EndoTrajectoryUsageRunDeltaV0,
	type EndoTrajectoryV0,
	type EndoTrajectoryVerdictV0,
	validateEndoTrajectoryComparisonV0,
	validateEndoTrajectoryV0,
} from "../../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

/** The sha256 of a record's canonical JSON with its `digest` field left out. */
export function endoRecordDigestV0(record: Record<string, unknown>): string {
	const { digest: _digest, ...body } = record;
	return sha256HexV0(canonicalEndoJsonV0(body));
}

/** Seal a trajectory body with its digest and validate it; throws when the result is not a valid record. */
export function sealEndoTrajectoryV0(body: Omit<EndoTrajectoryV0, "digest">): EndoTrajectoryV0 {
	const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	const sealed = { ...plain, digest: endoRecordDigestV0(plain) };
	const valid = validateEndoTrajectoryV0(sealed, endoRecordDigestV0);
	if (valid === null) throw new TypeError("the projected trajectory failed endo.trajectory.v0 validation");
	return valid;
}

type Agreement = "equal" | "differ" | "unknown";

function same(a: unknown, b: unknown): boolean {
	return canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
}

const canonicalAgreement = (a: unknown, b: unknown): Agreement => (same(a, b) ? "equal" : "differ");

/**
 * Tool entries: every field must be equal, except that an argument digest the recording did not capture (UNAVAILABLE
 * on either side) leaves the entry unverifiable rather than equal. A difference in any other field is a divergence.
 */
function toolAgreement(a: EndoTrajectoryToolEntryV0, b: EndoTrajectoryToolEntryV0): Agreement {
	const { argsSha256: argsA, ...restA } = a;
	const { argsSha256: argsB, ...restB } = b;
	if (!same(restA, restB)) return "differ";
	if (argsA.status === "reported" && argsB.status === "reported")
		return argsA.value === argsB.value ? "equal" : "differ";
	return "unknown";
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
	const unverified: number[] = [];
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
		if (agreement === "unknown") unverified.push(index);
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

function tokenDelta(a: Record<string, number> | null, b: Record<string, number> | null): EndoTrajectoryTokenDeltaV0 {
	const out: EndoTrajectoryTokenDeltaV0 = {};
	for (const field of TOKEN_FIELDS) {
		const x = a?.[field];
		const y = b?.[field];
		if (x === undefined && y === undefined) continue;
		out[field] = x === undefined || y === undefined ? null : delta(x, y);
	}
	return out;
}

/** A side's totals over its runs: a field only when every run with reported tokens has it. */
function totals(entries: readonly EndoTrajectoryUsageEntryV0[]): {
	tokens: Record<string, number> | null;
	wallMs: number | null;
} {
	const reported = entries.flatMap((entry) =>
		entry.tokens.status === "reported" ? [entry.tokens.value as unknown as Record<string, number>] : [],
	);
	let tokens: Record<string, number> | null = null;
	if (reported.length > 0) {
		tokens = {};
		for (const field of TOKEN_FIELDS)
			if (reported.every((item) => field in item))
				tokens[field] = reported.reduce((total, item) => total + item[field]!, 0);
	}
	const walls = entries.map((entry) => (entry.wallMs.status === "reported" ? entry.wallMs.value : null));
	const wallMs = walls.length > 0 && walls.every((wall) => wall !== null) ? walls.reduce((x, y) => x! + y!, 0) : null;
	return { tokens, wallMs };
}

function usageDeltas(
	a: EndoTrajectoryLayerV0<EndoTrajectoryUsageEntryV0>,
	b: EndoTrajectoryLayerV0<EndoTrajectoryUsageEntryV0>,
): EndoTrajectoryUsageComparisonV0 {
	if (a.status === "UNAVAILABLE" || b.status === "UNAVAILABLE") {
		return {
			status: "UNAVAILABLE",
			a: a.status === "UNAVAILABLE" ? a.reason : null,
			b: b.status === "UNAVAILABLE" ? b.reason : null,
		};
	}
	const runs: EndoTrajectoryUsageRunDeltaV0[] = [];
	for (let index = 0; index < Math.max(a.entries.length, b.entries.length); index += 1) {
		const x = a.entries[index];
		const y = b.entries[index];
		const tokensX = x?.tokens.status === "reported" ? (x.tokens.value as unknown as Record<string, number>) : null;
		const tokensY = y?.tokens.status === "reported" ? (y.tokens.value as unknown as Record<string, number>) : null;
		runs.push({
			run: index + 1,
			present: { a: x !== undefined, b: y !== undefined },
			tokens: tokensX === null || tokensY === null ? null : tokenDelta(tokensX, tokensY),
			wallMs:
				x?.wallMs.status === "reported" && y?.wallMs.status === "reported"
					? delta(x.wallMs.value, y.wallMs.value)
					: null,
		});
	}
	const totalA = totals(a.entries);
	const totalB = totals(b.entries);
	return {
		status: "DELTAS",
		runs,
		totals: {
			tokens: totalA.tokens === null || totalB.tokens === null ? {} : tokenDelta(totalA.tokens, totalB.tokens),
			wallMs: totalA.wallMs === null || totalB.wallMs === null ? null : delta(totalA.wallMs, totalB.wallMs),
		},
	};
}

/** The distinct reported values of one attachment field, in attachment order; UNAVAILABLE ones as `null`. */
function distinct(trajectory: EndoTrajectoryV0, field: keyof EndoTrajectoryV0["environment"]["attachments"][number]) {
	const values: (string | null)[] = [];
	for (const attachment of trajectory.environment.attachments) {
		const item = attachment[field];
		const value = item.status === "reported" ? item.value : null;
		if (!values.includes(value)) values.push(value);
	}
	return values;
}

function flags(a: EndoTrajectoryV0, b: EndoTrajectoryV0): EndoTrajectoryFlagV0[] {
	const out: EndoTrajectoryFlagV0[] = [];
	const check = (kind: EndoTrajectoryFlagV0["kind"], x: JsonValueV0, y: JsonValueV0): void => {
		if (!same(x, y)) out.push({ kind, a: x, b: y });
	};
	check("runtime-fingerprint-differs", distinct(a, "identityDigest"), distinct(b, "identityDigest"));
	check("runtime-version-differs", distinct(a, "version"), distinct(b, "version"));
	check("mapping-differs", distinct(a, "mapping"), distinct(b, "mapping"));
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
				`trajectory ${side} is not a valid endo.trajectory.v0 record (or its digest does not match)`,
			);
	}
	const side = (trajectory: EndoTrajectoryV0) => ({
		store: trajectory.source.store,
		session: trajectory.source.session,
		eventsSha256: trajectory.source.eventsSha256,
		trajectoryDigest: trajectory.digest,
	});
	const body = {
		schemaVersion: "endo.trajectory-comparison.v0" as const,
		rules: { ...ENDO_TRAJECTORY_COMPARISON_RULES_V0 },
		a: side(a),
		b: side(b),
		flags: flags(a, b),
		layers: {
			lifecycle: judge(a.layers.lifecycle, b.layers.lifecycle, canonicalAgreement),
			tools: judge(a.layers.tools, b.layers.tools, toolAgreement),
			outcome: judge(a.layers.outcome, b.layers.outcome, canonicalAgreement),
			usage: usageDeltas(a.layers.usage, b.layers.usage),
		},
	};
	const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
	const sealed = { ...plain, digest: endoRecordDigestV0(plain) };
	const valid = validateEndoTrajectoryComparisonV0(sealed, endoRecordDigestV0);
	if (valid === null) throw new TypeError("the comparison failed endo.trajectory-comparison.v0 validation");
	return valid;
}
