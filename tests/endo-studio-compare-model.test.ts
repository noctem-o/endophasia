import { describe, expect, it } from "vitest";
import { projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import { projectEndoCockpitTrajectoryComparisonV0 } from "../cockpit/index.ts";
import { projectEndoCockpitCompareCandidatesV0 } from "../cockpit-http/candidates.ts";
import { validateEndoCockpitTrajectoryComparisonV0 } from "../protocol/cockpit-comparison.ts";
import { type CompareState, candidateValue, initialCompare, reduceCompare } from "../studio-ui/src/model/compare.ts";
import { compareFailure, readCandidates, readComparison } from "../studio-ui/src/model/compare-wire.ts";
import { event } from "./cockpit-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { comparePiEvents, compareRecords } from "./studio-compare-fixtures.ts";

function loaded(): CompareState {
	const { candidates } = compareRecords();
	let s = reduceCompare(initialCompare(), { type: "start", id: 1, read: { kind: "discover" } });
	s = reduceCompare(s, { type: "finish", id: 1, reply: { kind: "candidates", record: candidates }, now: 0 });
	s = reduceCompare(s, {
		type: "choose",
		side: "a",
		value: candidateValue(candidates.candidates.find((c) => c.source === "pi")!),
	});
	return reduceCompare(s, {
		type: "choose",
		side: "b",
		value: candidateValue(candidates.candidates.find((c) => c.source === "dsh")!),
	});
}
const startComparison = (s: CompareState, id = 2) =>
	reduceCompare(s, {
		type: "start",
		id,
		read: { kind: "compare", generation: s.inventory!.generation, pair: { a: s.a!, b: s.b! } },
	});

describe("Compare wire gate", () => {
	it("rejects impossible unavailable layers and deltas with an absent side, as the authoritative wire validator does", () => {
		const record = compareRecords().comparison;
		const mutants = [
			{
				...record,
				layers: {
					...record.layers,
					lifecycle: { status: "UNAVAILABLE", sides: { a: null, b: null }, unverified: [], lengths: null },
				},
			},
			{
				...record,
				layers: {
					...record.layers,
					timing: {
						status: "DELTAS",
						basis: "observer-measured",
						clock: "observer",
						direction: "b-minus-a",
						runs: [{ run: 1, present: { a: false, b: true }, wallMs: { status: "DELTA", value: 5 } }],
						totals: { wallMs: { status: "DELTA", value: 5 } },
					},
				},
			},
			{
				...record,
				layers: {
					...record.layers,
					usage: {
						status: "DELTAS",
						basis: "runtime-reported",
						direction: "b-minus-a",
						runs: [
							{
								run: 1,
								present: { a: true, b: false },
								tokens: { status: "DELTAS", fields: { input: { status: "DELTA", value: 0 } } },
							},
						],
						totals: { status: "UNAVAILABLE" },
					},
				},
			},
		];
		for (const mutant of mutants) {
			expect(validateEndoCockpitTrajectoryComparisonV0(mutant)).toBeNull();
			expect(readComparison(mutant)).toBeNull();
		}
	});
	it("accepts actual Pi/DSH presentations unchanged, including qualifications and unavailable usage/timing", () => {
		const { candidates, comparison } = compareRecords();
		expect(readCandidates(candidates)).toBe(candidates);
		expect(readComparison(comparison)).toBe(comparison);
		expect(comparison.layers.timing.status).toBe("UNAVAILABLE");
		expect(comparison.flags.length).toBeGreaterThan(0);
	});
	it.each(["baseline-again", "tool-args-differ", "other-digest-domain"])(
		"accepts authoritative %s Pi verdicts byte for byte",
		(name) => {
			const events = [...comparePiEvents(), ...comparePiEvents(name, "endo.session.pi.b")];
			const a = projectPiTrajectoryV0(events, { session: "endo.session.pi.a", store: "test" });
			const b = projectPiTrajectoryV0(events, { session: "endo.session.pi.b", store: "test" });
			const record = projectEndoCockpitTrajectoryComparisonV0(a, b, OTHER_KEY);
			expect(readComparison(record)).toEqual(record);
		},
	);
	it("retains genuinely reported zero usage and timing deltas rather than marking them unavailable", () => {
		const trajectory = projectPiTrajectoryV0(comparePiEvents(), { session: "endo.session.pi.a", store: "test" });
		const record = projectEndoCockpitTrajectoryComparisonV0(trajectory, trajectory, OTHER_KEY);
		expect(readComparison(record)).toBe(record);
		expect(record.layers.usage.status).toBe("DELTAS");
		if (record.layers.usage.status === "DELTAS" && record.layers.usage.totals.status === "DELTAS") {
			expect(record.layers.usage.totals.fields.input).toEqual({ status: "DELTA", value: 0 });
		} else throw new Error("fixture must report usage totals");
		expect(record.layers.timing.status).toBe("DELTAS");
		if (record.layers.timing.status === "DELTAS")
			expect(record.layers.timing.totals.wallMs).toEqual({ status: "DELTA", value: 0 });
	});
	it("valid empty and ineligible inventories remain explicit; a null selector cannot be chosen", () => {
		expect(readCandidates(projectEndoCockpitCompareCandidatesV0([], OTHER_KEY))?.page.total).toBe(0);
		const rows = [
			...comparePiEvents(),
			event("harness.attached", {}, { producer: "pi-rpc-adapter:pi.second", session: "endo.session.pi.a" }),
		];
		const record = projectEndoCockpitCompareCandidatesV0(rows, OTHER_KEY);
		expect(readCandidates(record)?.candidates[0]?.eligibility).toBe("ambiguous");
		const s = { ...initialCompare(), inventory: record };
		expect(
			reduceCompare(s, { type: "choose", side: "a", value: candidateValue(record.candidates[0]!) }).a,
		).toBeNull();
	});
	it.each(["schemaVersion", "projectionVersion", "comparisonRules", "layers"])(
		"rejects invalid comparison %s",
		(field) => {
			const record = { ...compareRecords().comparison, [field]: "not-supported" };
			expect(readComparison(record)).toBeNull();
		},
	);
	it("rejects malformed nested evidence, quantities and absent slots, retaining reported zero and null", () => {
		const { comparison } = compareRecords();
		for (const changed of [
			{
				...comparison,
				layers: {
					...comparison.layers,
					lifecycle: {
						status: "DIVERGED",
						index: 0,
						commonPrefix: 0,
						lengths: { a: 0, b: 1 },
						a: { present: false, entry: {} },
						b: { present: true, entry: {} },
					},
				},
			},
			{ ...comparison, flags: [{ kind: "unknown", a: {}, b: {} }] },
			{
				...comparison,
				layers: {
					...comparison.layers,
					timing: {
						status: "DELTAS",
						basis: "observer-measured",
						clock: "observer",
						direction: "b-minus-a",
						runs: [],
						totals: { wallMs: { status: "DELTA", value: null } },
					},
				},
			},
		])
			expect(readComparison(changed)).toBeNull();
	});
	it("does not echo source text from refusal bodies; 404/409 do not assert a source mutation", () => {
		for (const status of [404, 409]) {
			const r = compareFailure(status, { error: "CANARY-secret" }, null);
			expect(r.invalid).toBe(true);
			expect(r.message).toContain("does not prove");
			expect(r.message).not.toContain("CANARY");
		}
		for (const error of ["toString", "constructor", "__proto__", "CANARY-private"]) {
			expect(compareFailure(503, { error }, null).message).toBe("The request failed. No comparison was accepted.");
		}
		expect(compareFailure(429, {}, "3").retrySeconds).toBe(3);
		expect(compareFailure(429, {}, "-1").retrySeconds).toBeNull();
		for (const code of ["source-absent", "source-degraded", "source-unopenable", "too-many-candidates"])
			expect(compareFailure(503, { error: code }, null).message).not.toBe(
				"The request failed. No comparison was accepted.",
			);
	});
});

describe("Compare identity and lifecycle", () => {
	it("a result is accepted only for the captured generation and pair; choosing clears it", () => {
		let s = startComparison(loaded());
		s = reduceCompare(s, {
			type: "finish",
			id: 2,
			reply: { kind: "comparison", record: compareRecords().comparison },
			now: 1,
		});
		expect(s.result).not.toBeNull();
		s = reduceCompare(s, { type: "choose", side: "a", value: candidateValue(s.b!) });
		expect(s.result).toBeNull();
		expect(s.a).toEqual(s.b);
	});
	it("late or canceled results cannot overwrite a new selection, rediscovery or request", () => {
		const pending = startComparison(loaded());
		for (const state of [
			reduceCompare(pending, { type: "choose", side: "a", value: "" }),
			reduceCompare(pending, { type: "cancel" }),
			reduceCompare(pending, { type: "start", id: 3, read: { kind: "discover" } }),
		]) {
			expect(
				reduceCompare(state, {
					type: "finish",
					id: 2,
					reply: { kind: "comparison", record: compareRecords().comparison },
					now: 0,
				}),
			).toBe(state);
		}
	});
	it("invalidation clears inventory, selection and result; ordinary failures retain selection but no applicable result", () => {
		for (const invalid of [false, true]) {
			const s = reduceCompare(startComparison(loaded()), {
				type: "finish",
				id: 2,
				reply: { kind: "failure", invalid, message: "failed", retrySeconds: null },
				now: 0,
			});
			expect(s.result).toBeNull();
			expect(s.inventory === null).toBe(invalid);
			expect(s.a === null).toBe(invalid);
		}
	});
	it("pacing records a monotonic deadline without creating a retry request", () => {
		const s = reduceCompare(startComparison(loaded()), {
			type: "finish",
			id: 2,
			reply: { kind: "failure", invalid: false, message: "paced", retrySeconds: 2 },
			now: 100,
		});
		expect(s.holdUntil).toBe(2100);
		expect(s.request).toBeNull();
		expect(reduceCompare(s, { type: "tick" }).request).toBeNull();
	});
	it("merges only correctly positioned pages from the same generation; duplicate/reordered continuations invalidate", () => {
		const events = Array.from({ length: 101 }, (_, i) =>
			event(
				"harness.attached",
				{},
				{ producer: "pi-rpc-adapter:pi.default", session: `endo.session.pi.s-${i.toString().padStart(3, "0")}` },
			),
		);
		const first = projectEndoCockpitCompareCandidatesV0(events, OTHER_KEY);
		const second = projectEndoCockpitCompareCandidatesV0(events, OTHER_KEY, first.page.nextCursor!);
		const s = reduceCompare(
			{ ...initialCompare(), inventory: first },
			{ type: "start", id: 1, read: { kind: "more", cursor: first.page.nextCursor!, generation: first.generation } },
		);
		const finish = (record: typeof second) =>
			reduceCompare(s, { type: "finish", id: 1, reply: { kind: "candidates", record }, now: 0 });
		expect(finish(second).inventory?.candidates).toHaveLength(101);
		for (const record of [
			{ ...second, generation: "0".repeat(64) },
			{ ...second, page: { ...second.page, offset: 0 } },
			{ ...second, candidates: [first.candidates[0]!] },
		])
			expect(finish(record).invalid).toBe(true);
		const duplicateSelector = {
			...second,
			candidates: [{ ...second.candidates[0]!, selector: first.candidates[0]!.selector }],
		};
		expect(readCandidates(duplicateSelector)).not.toBeNull(); // each page alone is well formed
		expect(finish(duplicateSelector).invalid).toBe(true); // combined inventory must reject retargeting
	});
});
