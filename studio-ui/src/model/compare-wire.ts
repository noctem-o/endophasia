// Browser wire gate only. The server remains authoritative for evidence, privacy admission and comparison judgments.
// No protocol implementation runs in the browser. These checks cover every field the Compare renderer reads.
import type { EndoCockpitCompareCandidatesV0 } from "../../../protocol/cockpit-candidates.ts";
import type { EndoCockpitTrajectoryComparisonV0 } from "../../../protocol/cockpit-comparison.ts";

type Check = (v: unknown) => boolean;
type R = Record<string, unknown>;
const obj = (v: unknown): v is R => typeof v === "object" && v !== null && !Array.isArray(v);
const shape = (v: unknown, fields: Record<string, Check>): v is R =>
	obj(v) &&
	Object.keys(v).length === Object.keys(fields).length &&
	Object.entries(fields).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));
const list =
	(check: Check): Check =>
	(v) =>
		Array.isArray(v) && v.every(check);
const eitherNull =
	(check: Check): Check =>
	(v) =>
		v === null || check(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const bool = (v: unknown): boolean => typeof v === "boolean";
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const token = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const one =
	(...values: unknown[]): Check =>
	(v) =>
		values.includes(v);
const position = eitherNull((v) => count(v) && v > 0);
const publicSession = (v: unknown): v is string =>
	typeof v === "string" && v.length <= 269 && /^endo\.session\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v);
export const opaqueSelector = (v: unknown): v is string => typeof v === "string" && /^c1-[0-9a-f]{64}$/.test(v);
export const candidateCursor = (v: unknown): v is string =>
	typeof v === "string" && /^p1-([1-9][0-9]{0,3})-[0-9a-f]{64}$/.test(v) && Number(v.split("-")[1]) % 100 === 0;

export function readCandidates(v: unknown): EndoCockpitCompareCandidatesV0 | null {
	if (
		!shape(v, {
			schemaVersion: one("endo.cockpit-compare-candidates.v0"),
			projectionVersion: one("cockpit-compare-candidates.1"),
			generation: token,
			candidates: Array.isArray,
			page: obj,
		})
	)
		return null;
	if (
		!shape(v.page, {
			offset: count,
			total: (n) => count(n) && n <= 10000,
			hasMore: bool,
			nextCursor: eitherNull(candidateCursor),
		})
	)
		return null;
	const p = v.page as unknown as EndoCockpitCompareCandidatesV0["page"];
	const rows = v.candidates as unknown[];
	if (
		p.offset % 100 !== 0 ||
		(p.offset > 0 && p.offset >= p.total) ||
		rows.length !== Math.min(100, p.total - p.offset) ||
		p.hasMore !== p.offset + rows.length < p.total ||
		(p.hasMore
			? p.nextCursor === null || Number(p.nextCursor.split("-")[1]) !== p.offset + rows.length
			: p.nextCursor !== null)
	)
		return null;
	let previous = "";
	const selectors = new Set<string>();
	for (const row of rows) {
		if (
			!shape(row, {
				source: one("pi", "dsh"),
				session: publicSession,
				label: string,
				eligibility: one("selectable", "ambiguous", "insufficient"),
				selector: eitherNull(opaqueSelector),
			})
		)
			return null;
		if (
			row.label !== (row.source === "pi" ? "Pi recording" : "DSH recording") ||
			(row.eligibility === "ambiguous" && row.source !== "pi") ||
			(row.eligibility === "selectable") !== (row.selector !== null)
		)
			return null;
		const order = `${row.source}\u0000${row.session}`;
		if (order <= previous || (row.selector !== null && selectors.has(row.selector as string))) return null;
		previous = order;
		if (row.selector !== null) selectors.add(row.selector as string);
	}
	return v as unknown as EndoCockpitCompareCandidatesV0;
}

const text: Check = (v) =>
	shape(v, { kind: one("text"), text: string }) || shape(v, { kind: one("withheld", "token"), token });
const reported =
	(inner: Check): Check =>
	(v) =>
		shape(v, { status: one("reported"), value: inner }) || shape(v, { status: one("UNAVAILABLE"), reason: text });
const digest: Check = (v) =>
	shape(v, { status: one("reported"), keyId: string, value: token }) ||
	shape(v, { status: one("withheld"), token }) ||
	shape(v, { status: one("UNAVAILABLE"), reason: text });
const facts: Check = (v) =>
	shape(v, {
		items: (items) =>
			Array.isArray(items) &&
			items.length <= 32 &&
			items.every((item) =>
				shape(item, { path: string, value: (x) => x === null || bool(x) || finite(x) || text(x) }),
			),
		omitted: count,
		omittedToken: eitherNull(token),
	}) && (v.omitted === 0 ? v.omittedToken === null : token(v.omittedToken));
const lifecycle: Check = (v) => shape(v, { kind: string, recognized: bool, facts });
const calls: Check = (v) => shape(v, { run: position, turn: position, name: reported(text), args: digest });
const results: Check = (v) =>
	shape(v, {
		run: position,
		turn: position,
		name: reported(text),
		status: reported(one("ok", "error")),
		result: digest,
	});
const outcome: Check = (v) =>
	shape(v, {
		run: (x) => count(x) && x > 0,
		outcome: one("completed", "failed", "aborted", "interrupted", "unclassified", "open"),
		turns: count,
		stopReason: reported(text),
		stopRequested: bool,
		cause: facts,
	});
const lengths: Check = (v) => shape(v, { a: count, b: count });
const sides: Check = (v) => shape(v, { a: eitherNull(text), b: eitherNull(text) });
const unverified: Check = (v) =>
	shape(v, { code: one("digest-not-recorded"), sides: one("one", "both") }) ||
	shape(v, {
		code: one("digest-domains-differ"),
		domains: (x) => Array.isArray(x) && x.length === 2 && x.every(text),
	}) ||
	shape(v, { code: one("unrecognized"), text });
const verdict =
	(entry: Check): Check =>
	(v) => {
		if (shape(v, { status: one("EXACT"), length: count })) return true;
		if (
			shape(v, {
				status: one("UNAVAILABLE"),
				sides,
				unverified: list((u) => shape(u, { index: count, reason: unverified })),
				lengths: eitherNull(lengths),
			})
		) {
			const missing = (v.sides as R).a !== null || (v.sides as R).b !== null;
			const positions = v.unverified as { index: number }[];
			if (missing) return v.lengths === null && positions.length === 0;
			if (!obj(v.lengths) || positions.length === 0) return false;
			return positions.every(
				(p, i) =>
					p.index <
						Math.min((v.lengths as { a: number; b: number }).a, (v.lengths as { a: number; b: number }).b) &&
					(i === 0 || positions[i - 1]!.index < p.index),
			);
		}
		if (!shape(v, { status: one("DIVERGED"), index: count, commonPrefix: count, lengths, a: obj, b: obj }))
			return false;
		const l = v.lengths as { a: number; b: number };
		const index = v.index as number;
		const slot = (x: unknown, n: number) =>
			index < n ? shape(x, { present: one(true), entry }) : shape(x, { present: one(false) });
		return v.commonPrefix === index && index < Math.max(l.a, l.b) && slot(v.a, l.a) && slot(v.b, l.b);
	};
const quantity: Check = (v) =>
	shape(v, { status: one("DELTA"), value: finite }) || shape(v, { status: one("UNAVAILABLE") });
const tokenFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "reasoning", "costTotal"];
const tokens: Check = (v) =>
	shape(v, { status: one("UNAVAILABLE") }) ||
	shape(v, {
		status: one("DELTAS"),
		fields: (x) =>
			obj(x) &&
			Object.keys(x).length > 0 &&
			Object.entries(x).every(([k, n]) => tokenFields.includes(k) && quantity(n)),
	});
const presence: Check = (v) => shape(v, { a: bool, b: bool });
const unavailable: Check = (v) =>
	shape(v, { status: one("UNAVAILABLE"), sides }) && ((v.sides as R).a !== null || (v.sides as R).b !== null);
const deltaRuns =
	(field: string, check: Check): Check =>
	(v) =>
		Array.isArray(v) &&
		v.every(
			(r, i) =>
				shape(r, { run: (n) => n === i + 1, present: presence, [field]: check }) &&
				((r.present as R).a || (r.present as R).b) &&
				(((r.present as R).a && (r.present as R).b) || (r[field] as R).status === "UNAVAILABLE"),
		);
const usage: Check = (v) =>
	unavailable(v) ||
	shape(v, {
		status: one("DELTAS"),
		basis: one("runtime-reported"),
		direction: one("b-minus-a"),
		runs: deltaRuns("tokens", tokens),
		totals: tokens,
	});
const timing: Check = (v) =>
	unavailable(v) ||
	shape(v, {
		status: one("DELTAS"),
		basis: one("observer-measured"),
		clock: one("observer"),
		direction: one("b-minus-a"),
		runs: deltaRuns("wallMs", quantity),
		totals: (x) => shape(x, { wallMs: quantity }),
	});
const at: Check = (v) => shape(v, { index: count, run: position, turn: position });
const against: Check = (v) =>
	shape(v, {
		firstDivergentResult: eitherNull(at),
		firstDivergentCall: eitherNull(at),
		callsIdenticalUpToFirstDivergentInput: eitherNull(bool),
		reason: one(
			"calls-unavailable",
			"calls-identical",
			"calls-unverified",
			"results-unavailable-or-unverified",
			"calls-diverged-results-identical",
			"order-unknown",
			"call-in-later-turn-than-divergent-result",
			"call-not-after-divergent-result",
		),
	});
const flagSide: Check = (v) =>
	obj(v) &&
	Object.entries(v).every(([k, a]) => ["values", "user", "project"].includes(k) && list(eitherNull(text))(a));
const flag: Check = (v) =>
	shape(v, {
		kind: one(
			"runtime-fingerprint-differs",
			"runtime-version-differs",
			"mapping-differs",
			"digest-domain-differs",
			"configuration-differs",
			"configured-model-differs",
			"reported-model-differs",
			"projection-differs",
		),
		a: flagSide,
		b: flagSide,
	});
const side: Check = (v) => shape(v, { session: publicSession, eventsToken: token, trajectoryToken: token });

export function readComparison(v: unknown): EndoCockpitTrajectoryComparisonV0 | null {
	return shape(v, {
		schemaVersion: one("endo.cockpit-trajectory-comparison.v0"),
		projectionVersion: one("cockpit-trajectory-comparison.3"),
		comparisonRules: one("trajectory-comparison.3"),
		keyId: string,
		comparisonToken: token,
		a: side,
		b: side,
		flags: list(flag),
		toolCallsAgainstInputs: against,
		layers: (x) =>
			shape(x, {
				lifecycle: verdict(lifecycle),
				toolCalls: verdict(calls),
				toolResults: verdict(results),
				outcome: verdict(outcome),
				usage,
				timing,
			}),
	})
		? (v as unknown as EndoCockpitTrajectoryComparisonV0)
		: null;
}

export type CompareReply =
	| { kind: "candidates"; record: EndoCockpitCompareCandidatesV0 }
	| { kind: "comparison"; record: EndoCockpitTrajectoryComparisonV0 }
	| { kind: "failure"; message: string; invalid: boolean; retrySeconds: number | null };
const failures: Record<string, string> = {
	"source-absent": "No event store is present. Record evidence before discovering recordings.",
	"source-degraded": "The recorded source is degraded or incomplete; no verified inventory is available.",
	"source-unopenable": "The recorded source could not be opened or validated.",
	"too-many-candidates": "The store exceeds the candidate discovery limit (10,000 recordings).",
};
export function compareFailure(
	status: number,
	body: unknown,
	retry: string | null,
): Extract<CompareReply, { kind: "failure" }> {
	const code = obj(body) && typeof body.error === "string" ? body.error : "";
	const invalid = status === 404 || status === 409;
	return {
		kind: "failure",
		invalid,
		retrySeconds:
			status === 429 && retry !== null && /^(0|[1-9][0-9]{0,3})$/.test(retry) ? Math.min(3600, Number(retry)) : null,
		message: invalid
			? "This continuation or selection is no longer valid, or is unknown. This does not prove the source changed. Rediscover recordings."
			: status === 429
				? "The server is pacing reads. Wait for the requested pause, then retry explicitly."
				: Object.hasOwn(failures, code)
					? failures[code]!
					: "The request failed. No comparison was accepted.",
	};
}
