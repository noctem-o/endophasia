// The trajectory-comparison presentation (protocol/cockpit-comparison.ts), projected from two trajectories. Pure: no store, key
// file, clock, network or environment is read; the same two trajectories under the same key give the same bytes.
//
// The comparison itself is not done here. `compareEndoTrajectoriesV0` (runtime/contracts/trajectory.ts) is the one authority on
// what the two recordings establish, and this file only copies its verdicts into the presentation shape, withholding what the
// cockpit presentation boundary withholds. It takes the two TRAJECTORIES, not a comparison, so a comparison can never be paired
// with trajectories it was not made from: the comparison is made here, from exactly these two, and validated by the comparator.
//
// Entries of a DIVERGED verdict are untyped JSON in the comparison record, so each is read structurally and only allowlisted
// fields are copied; free text goes through the text policy and anything that commits to withheld content becomes a keyed token.

import {
	ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0,
	ENDO_COCKPIT_COMPARISON_MAX_FACT_DEPTH_V0,
	ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0,
	ENDO_COCKPIT_COMPARISON_OUTCOMES_V0,
	ENDO_COCKPIT_COMPARISON_TOKEN_FIELDS_V0,
	ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0,
	ENDO_COCKPIT_TRAJECTORY_COMPARISON_SCHEMA_V0,
	type EndoCockpitComparisonAgainstInputsReasonV0,
	type EndoCockpitComparisonAgainstInputsV0,
	type EndoCockpitComparisonDigestV0,
	type EndoCockpitComparisonFactsV0,
	type EndoCockpitComparisonFactValueV0,
	type EndoCockpitComparisonFlagSideV0,
	type EndoCockpitComparisonFlagV0,
	type EndoCockpitComparisonLifecycleEntryV0,
	type EndoCockpitComparisonOutcomeEntryV0,
	type EndoCockpitComparisonQuantityV0,
	type EndoCockpitComparisonReportedV0,
	type EndoCockpitComparisonSideV0,
	type EndoCockpitComparisonSlotV0,
	type EndoCockpitComparisonTextV0,
	type EndoCockpitComparisonTimingV0,
	type EndoCockpitComparisonTokenDeltasV0,
	type EndoCockpitComparisonTokenFieldV0,
	type EndoCockpitComparisonToolCallEntryV0,
	type EndoCockpitComparisonToolResultEntryV0,
	type EndoCockpitComparisonUnverifiedV0,
	type EndoCockpitComparisonUsageV0,
	type EndoCockpitComparisonVerdictV0,
	type EndoCockpitTrajectoryComparisonV0,
	validateEndoCockpitTrajectoryComparisonV0,
} from "../../protocol/cockpit-comparison.ts";
import {
	endoCockpitTextPresentableV0,
	isEndoCockpitDigestKeyIdV0,
	isEndoCockpitPublicIdV0,
} from "../../protocol/cockpit-fields.ts";
import { isEndoKeyedDigestV0 } from "../../protocol/keyed-digest-shape.ts";
import { isEndoLifecycleKindV0 } from "../../protocol/session-lifecycle.ts";
import type {
	EndoTrajectoryComparisonV0,
	EndoTrajectoryToolPositionV0,
	EndoTrajectoryV0,
	EndoTrajectoryVerdictV0,
} from "../../protocol/trajectory.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0 } from "../../runtime/contracts/trajectory.ts";
import {
	cockpitAliasesV0,
	cockpitTokenV0,
	compareCodeUnitsV0,
	type EndoCockpitAliasesV0,
	requireAdmittedKeyV0,
} from "./common.ts";

type R = Record<string, unknown>;
const isRecord = (value: unknown): value is R => typeof value === "object" && value !== null && !Array.isArray(value);
const HEX64 = /^[0-9a-f]{64}$/;

function malformed(what: string): never {
	throw new TypeError(`the trajectory comparison has a malformed ${what}`);
}

/** The comparator's own reason templates (runtime/contracts/trajectory.ts), mapped to codes. A wording change must fail a test. */
export const ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0: Readonly<
	Record<string, EndoCockpitComparisonAgainstInputsReasonV0>
> = Object.freeze({
	"the tool calls are unavailable on a side": "calls-unavailable",
	"the tool calls are identical throughout": "calls-identical",
	"some tool calls could not be verified": "calls-unverified",
	"the tool results are unavailable or unverifiable, so no divergent input can be located":
		"results-unavailable-or-unverified",
	"the tool calls diverged while every tool result was identical": "calls-diverged-results-identical",
	"a run or turn is unknown, so the order cannot be told": "order-unknown",
	"the first diverged call was made in a later turn than the first diverged result":
		"call-in-later-turn-than-divergent-result",
	"a call diverged no later than the first diverged result's turn, before that input could have been seen":
		"call-not-after-divergent-result",
});

const NOT_RECORDED = /^no (?:argument|result) digest was recorded on (either side|one side)$/;
const DOMAINS_DIFFER =
	/^different digest domains \(([^ ()]+) and ([^ ()]+)\); to compare across machines, share one key: docs\/trajectory\.md#comparing-across-machines$/;

/**
 * A string that reads as a digest in any common spelling (hex of any case and length from 128 bits, an algorithm prefix,
 * base64): it commits to content the cockpit may withhold, so it is only ever shown as a keyed token of itself.
 */
const DIGEST_LIKE = /^(?:sha(?:1|224|256|384|512)\s*[:=-]\s*)?(?:[0-9a-fA-F]{32,}|[A-Za-z0-9+/_-]{43,}={0,2})$/i;
/** A run of hex long enough to be a digest or a secret, anywhere in a name. */
const HEX_RUN = /[0-9a-fA-F]{16,}/;

class Presenter {
	readonly alias: EndoCockpitAliasesV0;
	readonly #key: EndoDigestKeyV0;
	constructor(key: EndoDigestKeyV0) {
		this.#key = key;
		this.alias = cockpitAliasesV0(key);
	}

	/** The trajectory contract permits arbitrary session strings. Preserve existing session aliases; other strings
	 * need a separate session-domain alias, never an event/evidence alias or a reinterpreted source identifier. */
	session(value: string): string {
		const alias = this.alias.id(value);
		return isEndoCockpitPublicIdV0(alias, "session")
			? alias
			: `endo.session.withheld-${cockpitTokenV0(this.#key, "endo.cockpit.comparison-session-alias.v0", { session: value }).slice(0, 32)}`;
	}

	/** A keyed token of a plain sha256 (or of any value, by its own sha256), equal for equal values under this key. */
	supporting(hex: string): string {
		return this.alias.digest("supporting", hex);
	}

	/** Free text whole when the policy admits it, else a keyed token of it: two withheld values that differ stay different. */
	text(text: string): EndoCockpitComparisonTextV0 {
		if (DIGEST_LIKE.test(text)) return { kind: "token", token: this.supporting(sha256HexV0(text)) };
		return endoCockpitTextPresentableV0(text)
			? { kind: "text", text }
			: { kind: "withheld", token: this.supporting(sha256HexV0(text)) };
	}

	/** A string that is itself a digest, as a keyed token; anything else as text. */
	digestOrText(purpose: "identity" | "configuration", value: string): EndoCockpitComparisonTextV0 {
		if (HEX64.test(value)) return { kind: "token", token: this.alias.digest(purpose, value) };
		return DIGEST_LIKE.test(value) ? { kind: "token", token: this.supporting(sha256HexV0(value)) } : this.text(value);
	}

	/** A digest key id: shown when it is one the cockpit admits, else withheld by token. */
	keyId(value: string): EndoCockpitComparisonTextV0 {
		return isEndoCockpitDigestKeyIdV0(value) && endoCockpitTextPresentableV0(value)
			? { kind: "text", text: value }
			: { kind: "withheld", token: this.supporting(sha256HexV0(value)) };
	}

	scalar(value: unknown): EndoCockpitComparisonFactValueV0 | undefined {
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
		if (typeof value !== "string") return undefined;
		if (HEX64.test(value)) return { kind: "token", token: this.supporting(value) };
		return DIGEST_LIKE.test(value) ? { kind: "token", token: this.supporting(sha256HexV0(value)) } : this.text(value);
	}

	/**
	 * A JSON value as a flat, bounded list of (dotted path, scalar) in code-unit order. A key outside the plain grammar, a value
	 * past the depth or count bound, or a non-finite number is not carried and is counted in `omitted`.
	 */
	facts(value: unknown): EndoCockpitComparisonFactsV0 {
		const items: { path: string; value: EndoCockpitComparisonFactValueV0 }[] = [];
		// What is not carried, with where it was: its count is shown, and a keyed token of it, so two entries that differ only in
		// what is left out still read as different.
		const left: { path: string; value: unknown }[] = [];
		const omit = (path: string[], what: unknown): void => {
			left.push({ path: path.join("."), value: what });
		};
		const walk = (current: unknown, path: string[]): void => {
			if (Array.isArray(current) || isRecord(current)) {
				if (path.length >= ENDO_COCKPIT_COMPARISON_MAX_FACT_DEPTH_V0) {
					omit(path, current);
					return;
				}
				const entries: [string, unknown][] = Array.isArray(current)
					? current.map((item, index) => [String(index), item])
					: Object.keys(current)
							.sort(compareCodeUnitsV0)
							.map((key) => [key, current[key]]);
				// No child scalar can carry an empty container's presence or type. Commit it as an omission,
				// including its path, so {} / [] / absence never collapse to indistinguishable evidence.
				if (entries.length === 0) omit(path, current);
				for (const [key, child] of entries) {
					// A name is carried only when it is plain, passes the text policy and is not a digest or secret in disguise: a name
					// is text a producer chose, as much as a value is.
					const plain = Array.isArray(current)
						? /^[0-9]{1,3}$/.test(key)
						: /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) &&
							endoCockpitTextPresentableV0(key) &&
							!HEX_RUN.test(key);
					// A path starts with a name, never an array index.
					if (!plain || (path.length === 0 && Array.isArray(current))) omit([...path, key], child);
					else walk(child, [...path, key]);
				}
				return;
			}
			const shown = this.scalar(current);
			if (shown === undefined || path.length === 0 || items.length >= ENDO_COCKPIT_COMPARISON_MAX_FACTS_V0)
				omit(path, current);
			else items.push({ path: path.join("."), value: shown });
		};
		walk(value, []);
		items.sort((x, y) => compareCodeUnitsV0(x.path, y.path));
		return {
			items,
			omitted: left.length,
			omittedToken: left.length === 0 ? null : this.supporting(sha256HexV0(canonicalEndoJsonV0(left))),
		};
	}
}

/** A value of `EndoReportedV0<string>` read from an entry. */
function reported(
	value: unknown,
	what: string,
): { status: "reported"; value: unknown } | { status: "UNAVAILABLE"; reason: string } {
	if (isRecord(value) && value.status === "reported" && Object.hasOwn(value, "value"))
		return { status: "reported", value: value.value };
	if (isRecord(value) && value.status === "UNAVAILABLE" && typeof value.reason === "string")
		return { status: "UNAVAILABLE", reason: value.reason };
	return malformed(what);
}

function reportedText(
	p: Presenter,
	value: unknown,
	what: string,
): EndoCockpitComparisonReportedV0<EndoCockpitComparisonTextV0> {
	const item = reported(value, what);
	if (item.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reason: p.text(item.reason) };
	if (typeof item.value !== "string") return malformed(what);
	return { status: "reported", value: p.text(item.value) };
}

function digestView(p: Presenter, value: unknown, what: string): EndoCockpitComparisonDigestV0 {
	const item = reported(value, what);
	if (item.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reason: p.text(item.reason) };
	if (!isEndoKeyedDigestV0(item.value)) return malformed(what);
	const { keyId, value: digest } = item.value;
	// The digest and its key id are shown together or not at all.
	return isEndoCockpitDigestKeyIdV0(keyId) && endoCockpitTextPresentableV0(keyId)
		? { status: "reported", keyId, value: digest }
		: // Withheld, but a token of the pair keeps two different digests from reading as one.
			{ status: "withheld", token: p.supporting(sha256HexV0(`${keyId}:${digest}`)) };
}

const position = (value: unknown, what: string): number | null =>
	value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1)
		? (value as number | null)
		: malformed(what);
const count = (value: unknown, what: string): number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : malformed(what);

function lifecycleEntry(p: Presenter, value: unknown): EndoCockpitComparisonLifecycleEntryV0 {
	if (!isRecord(value) || typeof value.kind !== "string" || typeof value.recognized !== "boolean")
		return malformed("lifecycle entry");
	// Known lifecycle kinds are shown; other kinds use the existing public-kind/alias policy. The source's
	// recognition flag is copied independently rather than rewritten to match this presenter's vocabulary.
	const kind = isEndoLifecycleKindV0(value.kind) ? value.kind : p.alias.kind(value.kind);
	return { kind, recognized: value.recognized, facts: p.facts(value.facts) };
}

function toolCallEntry(p: Presenter, value: unknown): EndoCockpitComparisonToolCallEntryV0 {
	if (!isRecord(value)) return malformed("tool call entry");
	return {
		run: position(value.run, "tool call run"),
		turn: position(value.turn, "tool call turn"),
		name: reportedText(p, value.name, "tool call name"),
		args: digestView(p, value.argsDigest, "tool call argument digest"),
	};
}

function toolResultEntry(p: Presenter, value: unknown): EndoCockpitComparisonToolResultEntryV0 {
	if (!isRecord(value)) return malformed("tool result entry");
	const status = reported(value.status, "tool result status");
	if (status.status === "reported" && status.value !== "ok" && status.value !== "error")
		return malformed("tool result status");
	return {
		run: position(value.run, "tool result run"),
		turn: position(value.turn, "tool result turn"),
		name: reportedText(p, value.name, "tool result name"),
		status:
			status.status === "reported"
				? { status: "reported", value: status.value as "ok" | "error" }
				: { status: "UNAVAILABLE", reason: p.text(status.reason) },
		result: digestView(p, value.resultDigest, "tool result digest"),
	};
}

function outcomeEntry(p: Presenter, value: unknown): EndoCockpitComparisonOutcomeEntryV0 {
	if (!isRecord(value)) return malformed("outcome entry");
	const outcome = (ENDO_COCKPIT_COMPARISON_OUTCOMES_V0 as readonly unknown[]).find((kind) => kind === value.outcome);
	if (outcome === undefined || typeof value.stopRequested !== "boolean") return malformed("outcome entry");
	return {
		run: position(value.run, "outcome run") ?? malformed("outcome run"),
		outcome: outcome as EndoCockpitComparisonOutcomeEntryV0["outcome"],
		turns: count(value.turns, "outcome turns"),
		stopReason: reportedText(p, value.stopReason, "outcome stop reason"),
		stopRequested: value.stopRequested,
		cause: p.facts(value.cause),
	};
}

function unverifiedReason(p: Presenter, reason: string): EndoCockpitComparisonUnverifiedV0 {
	const notRecorded = NOT_RECORDED.exec(reason);
	if (notRecorded !== null)
		return { code: "digest-not-recorded", sides: notRecorded[1] === "one side" ? "one" : "both" };
	const domains = DOMAINS_DIFFER.exec(reason);
	if (domains !== null)
		return { code: "digest-domains-differ", domains: [p.keyId(domains[1]!), p.keyId(domains[2]!)] };
	return { code: "unrecognized", text: p.text(reason) };
}

function verdict<E>(
	p: Presenter,
	source: EndoTrajectoryVerdictV0,
	entry: (p: Presenter, value: unknown) => E,
): EndoCockpitComparisonVerdictV0<E> {
	switch (source.status) {
		case "EXACT":
			return { status: "EXACT", length: source.length };
		case "DIVERGED": {
			// A null entry is the comparator's "past this side's end"; presented as an absent slot, never as an entry.
			const slot = (value: unknown, length: number): EndoCockpitComparisonSlotV0<E> =>
				source.index < length ? { present: true, entry: entry(p, value) } : { present: false };
			return {
				status: "DIVERGED",
				index: source.index,
				commonPrefix: source.commonPrefix,
				lengths: { ...source.lengths },
				a: slot(source.a, source.lengths.a),
				b: slot(source.b, source.lengths.b),
			};
		}
		case "UNAVAILABLE":
			return {
				status: "UNAVAILABLE",
				sides: {
					a: source.a === null ? null : p.text(source.a),
					b: source.b === null ? null : p.text(source.b),
				},
				unverified: source.unverified.map((item) => ({
					index: item.index,
					reason: unverifiedReason(p, item.reason),
				})),
				lengths: source.lengths === null ? null : { ...source.lengths },
			};
	}
}

const toPosition = (source: EndoTrajectoryToolPositionV0 | null) =>
	source === null ? null : { index: source.index, run: source.run, turn: source.turn };

function againstInputs(
	source: EndoTrajectoryComparisonV0["toolCallsAgainstInputs"],
): EndoCockpitComparisonAgainstInputsV0 {
	const reason = Object.hasOwn(ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0, source.reason)
		? ENDO_COCKPIT_AGAINST_INPUTS_REASON_CODES_V0[source.reason]
		: undefined;
	// A reason the projection has no code for is a comparator change this version does not know: refuse, never guess a code.
	if (reason === undefined) return malformed("calls-against-inputs reason");
	return {
		firstDivergentResult: toPosition(source.firstDivergentResult),
		firstDivergentCall: toPosition(source.firstDivergentCall),
		callsIdenticalUpToFirstDivergentInput: source.callsIdenticalUpToFirstDivergentInput,
		reason,
	};
}

const quantity = (value: number | null | undefined): EndoCockpitComparisonQuantityV0 =>
	typeof value === "number" ? { status: "DELTA", value } : { status: "UNAVAILABLE" };

function tokenDeltas(source: { [field: string]: number | null } | null): EndoCockpitComparisonTokenDeltasV0 {
	// `{}` is the comparator's total for "a side reported no tokens": an unavailable total, not an empty set of zero differences.
	if (source === null || Object.keys(source).length === 0) return { status: "UNAVAILABLE" };
	const fields: { [F in EndoCockpitComparisonTokenFieldV0]?: EndoCockpitComparisonQuantityV0 } = {};
	for (const field of ENDO_COCKPIT_COMPARISON_TOKEN_FIELDS_V0)
		if (Object.hasOwn(source, field)) fields[field] = quantity(source[field]);
	return { status: "DELTAS", fields };
}

function usage(p: Presenter, source: EndoTrajectoryComparisonV0["layers"]["usage"]): EndoCockpitComparisonUsageV0 {
	if (source.status === "UNAVAILABLE")
		return {
			status: "UNAVAILABLE",
			sides: { a: source.a === null ? null : p.text(source.a), b: source.b === null ? null : p.text(source.b) },
		};
	return {
		status: "DELTAS",
		basis: "runtime-reported",
		direction: "b-minus-a",
		runs: source.runs.map((run) => ({ run: run.run, present: { ...run.present }, tokens: tokenDeltas(run.tokens) })),
		totals: tokenDeltas(source.totals.tokens),
	};
}

function timing(p: Presenter, source: EndoTrajectoryComparisonV0["layers"]["timing"]): EndoCockpitComparisonTimingV0 {
	if (source.status === "UNAVAILABLE")
		return {
			status: "UNAVAILABLE",
			sides: { a: source.a === null ? null : p.text(source.a), b: source.b === null ? null : p.text(source.b) },
		};
	return {
		status: "DELTAS",
		basis: "observer-measured",
		clock: "observer",
		direction: "b-minus-a",
		runs: source.runs.map((run) => ({ run: run.run, present: { ...run.present }, wallMs: quantity(run.wallMs) })),
		totals: { wallMs: quantity(source.totals.wallMs) },
	};
}

/** One side of a flag: the comparator lists distinct values, `null` for one the recording did not report. */
function flagSide(
	p: Presenter,
	kind: (typeof ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0)[number],
	value: unknown,
): EndoCockpitComparisonFlagSideV0 {
	const list = (
		items: unknown,
		show: (text: string) => EndoCockpitComparisonTextV0,
	): (EndoCockpitComparisonTextV0 | null)[] => {
		if (!Array.isArray(items)) return malformed("flag value");
		return items.map((item) =>
			item === null ? null : typeof item === "string" ? show(item) : malformed("flag value"),
		);
	};
	switch (kind) {
		case "runtime-fingerprint-differs":
			return { values: list(value, (text) => p.digestOrText("identity", text)) };
		case "digest-domain-differs":
			return { values: list(value, (text) => p.keyId(text)) };
		case "configuration-differs": {
			if (!isRecord(value)) return malformed("flag value");
			return {
				user: list(value.user, (text) => p.digestOrText("configuration", text)),
				project: list(value.project, (text) => p.digestOrText("configuration", text)),
			};
		}
		case "projection-differs":
			return { values: typeof value === "string" ? [p.text(value)] : malformed("flag value") };
		default:
			return { values: list(value, (text) => p.text(text)) };
	}
}

function flags(p: Presenter, source: EndoTrajectoryComparisonV0["flags"]): EndoCockpitComparisonFlagV0[] {
	return source.map((flag) => {
		const kind = (ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0 as readonly string[]).find((known) => known === flag.kind);
		if (kind === undefined) return malformed("flag kind");
		const known = kind as (typeof ENDO_COCKPIT_COMPARISON_FLAG_KINDS_V0)[number];
		return { kind: known, a: flagSide(p, known, flag.a), b: flagSide(p, known, flag.b) };
	});
}

const sideOf = (p: Presenter, side: EndoTrajectoryComparisonV0["a"]): EndoCockpitComparisonSideV0 => ({
	session: p.session(side.session),
	eventsToken: p.supporting(side.eventsSha256),
	trajectoryToken: p.supporting(side.trajectoryDigest),
});

/**
 * The presentation of the comparison of two trajectories, under an explicit digest key (never created or loaded here). Throws a
 * TypeError for a trajectory that is not a valid `endo.trajectory.v1` record (the comparator checks both, digests included),
 * for a key a cockpit read does not admit, and for a comparison the projection does not know how to present. Its own output is
 * validated before it is returned.
 */
export function projectEndoCockpitTrajectoryComparisonV0(
	a: EndoTrajectoryV0,
	b: EndoTrajectoryV0,
	digestKey: EndoDigestKeyV0,
): EndoCockpitTrajectoryComparisonV0 {
	requireAdmittedKeyV0(digestKey);
	const comparison = compareEndoTrajectoriesV0(a, b);
	const p = new Presenter(digestKey);
	const projected: EndoCockpitTrajectoryComparisonV0 = {
		schemaVersion: ENDO_COCKPIT_TRAJECTORY_COMPARISON_SCHEMA_V0,
		projectionVersion: ENDO_COCKPIT_TRAJECTORY_COMPARISON_PROJECTION_V0,
		keyId: digestKey.keyId,
		comparisonRules: comparison.rules.version,
		comparisonToken: p.supporting(comparison.digest),
		a: sideOf(p, comparison.a),
		b: sideOf(p, comparison.b),
		flags: flags(p, comparison.flags),
		toolCallsAgainstInputs: againstInputs(comparison.toolCallsAgainstInputs),
		layers: {
			lifecycle: verdict(p, comparison.layers.lifecycle, lifecycleEntry),
			toolCalls: verdict(p, comparison.layers.toolCalls, toolCallEntry),
			toolResults: verdict(p, comparison.layers.toolResults, toolResultEntry),
			outcome: verdict(p, comparison.layers.outcome, outcomeEntry),
			usage: usage(p, comparison.layers.usage),
			timing: timing(p, comparison.layers.timing),
		},
	};
	// Plain data through the validator: a projection that fails its own contract is a defect here, not an input to forward.
	const plain = JSON.parse(canonicalEndoJsonV0(projected)) as unknown;
	const valid = validateEndoCockpitTrajectoryComparisonV0(plain);
	if (valid === null)
		throw new TypeError(
			"the trajectory comparison projection failed endo.cockpit-trajectory-comparison.v0 validation",
		);
	return valid;
}
