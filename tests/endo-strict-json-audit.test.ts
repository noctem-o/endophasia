/**
 * Phase 12 — the strict-JSON audit: every hardened protocol validator must accept a plain object
 * literal and a null-prototype object, and must reject the non-strict-JSON shapes a hostile
 * process can hand it: a class instance wrapping the same fields, an unknown extra key, a
 * Date/Map/Set, and an array. The `JsonValueV0` fields must also reject non-finite numbers
 * (NaN/Infinity are not JSON).
 */

import { describe, expect, it } from "vitest";
import { validateEndoCollabRoomV0 } from "../protocol/collab.ts";
import { validateTrialCoordinatesV0 } from "../protocol/coordinates.ts";
import { validateEndoTrialResultV0 } from "../protocol/evaluation.ts";
import { validateEndoEventV0 } from "../protocol/event.ts";
import { validateEndoEventStreamSummaryV0 } from "../protocol/event-record.ts";
import { validateEndoCandidateV0 } from "../protocol/evolution.ts";
import { validateEndoGraphEdgeV0 } from "../protocol/graph.ts";
import { validateEndoModelProfileV0 } from "../protocol/models.ts";
import { validateEndoObjectV0 } from "../protocol/object.ts";
import { isPlainJsonObjectV0 } from "../protocol/primitives.ts";
import { validateEndoProviderUsageV0 } from "../protocol/provider.ts";
import { validateEndoRuntimeAdmissionV0 } from "../protocol/runtime.ts";
import { validateEndoWitnessRecordV0 } from "../protocol/trust.ts";
import { validateEndoVisualSignalV0 } from "../protocol/visualization.ts";

const TRIAL_COORDINATES_V0 = { schemaVersion: "endo.trial.v0", experimentId: "endo.experiment.a", trial: 0 };

interface AuditEntry {
	file: string;
	validate: (value: unknown) => unknown;
	sample: Record<string, unknown>;
}

const ENTRIES_V0: AuditEntry[] = [
	{
		file: "protocol/collab.ts",
		validate: validateEndoCollabRoomV0,
		sample: {
			schemaVersion: "endo.collab-room.v0",
			id: "endo.evidence.room-1",
			experimentId: "endo.experiment.a",
			title: "room",
			visibility: "open",
		},
	},
	{ file: "protocol/coordinates.ts", validate: validateTrialCoordinatesV0, sample: TRIAL_COORDINATES_V0 },
	{
		file: "protocol/evaluation.ts",
		validate: validateEndoTrialResultV0,
		sample: {
			schemaVersion: "endo.trial-result.v0",
			coordinates: TRIAL_COORDINATES_V0,
			partition: "held-out",
			raw: { ok: true },
			derived: { score: 1 },
		},
	},
	{
		file: "protocol/event-record.ts",
		validate: validateEndoEventStreamSummaryV0,
		sample: {
			schemaVersion: "endo.stream-summary.v0",
			count: 1,
			maxSequence: 1,
			sources: {
				"runtime-fact": 1,
				interpretation: 0,
				hypothesis: 0,
				"evaluation-result": 0,
				"policy-conclusion": 0,
				"authority-decision": 0,
			},
		},
	},
	{
		file: "protocol/event.ts",
		validate: validateEndoEventV0,
		sample: {
			schemaVersion: "endo.event.v0",
			id: "endo.event.e1",
			kind: "session.started",
			source: "runtime-fact",
			sequence: 0,
			at: "2026-10-02T11:00:00Z",
			coordinates: {},
			producer: "endo.session.s1",
			derivedFrom: [],
			payload: {},
		},
	},
	{
		file: "protocol/evolution.ts",
		validate: validateEndoCandidateV0,
		sample: { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c1", mutations: [] },
	},
	{
		file: "protocol/graph.ts",
		validate: validateEndoGraphEdgeV0,
		sample: {
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: "endo.node.n1",
			target: "endo.node.n2",
			relation: "derived-from",
			observedIn: "endo.event.e1",
		},
	},
	{
		file: "protocol/models.ts",
		validate: validateEndoModelProfileV0,
		sample: {
			schemaVersion: "endo.model-profile.v0",
			id: "endo.model.m1",
			name: "gpt-test",
			provider: "openai.gpt",
			deployment: "local",
			observation: "j-space",
			capabilities: ["chat"],
		},
	},
	{
		file: "protocol/object.ts",
		validate: validateEndoObjectV0,
		sample: {
			schemaVersion: "endo.object.v0",
			id: "endo.node.o1",
			kind: "claim",
			payload: { text: "x" },
			observedIn: "endo.event.e1",
		},
	},
	{
		file: "protocol/runtime.ts",
		validate: validateEndoRuntimeAdmissionV0,
		sample: {
			schemaVersion: "endo.runtime-admission.v0",
			id: "endo.evidence.adm1",
			subject: "pi.agent",
			version: "0.1.0",
			status: "candidate",
			evidence: [],
			blockers: [],
		},
	},
	{
		file: "protocol/trust.ts",
		validate: validateEndoWitnessRecordV0,
		sample: {
			schemaVersion: "endo.witness.v0",
			id: "endo.evidence.w1",
			runId: "endo.run.r1",
			witnessRoot: "a".repeat(64),
			witnessAlgorithm: "blake3",
			verification: "recomputed-matched",
		},
	},
	{
		file: "protocol/visualization.ts",
		validate: validateEndoVisualSignalV0,
		sample: {
			schemaVersion: "endo.visual-signal.v0",
			signal: "attention",
			availability: "available",
			value: { level: 0.5 },
			origin: "recorded",
		},
	},
	{
		file: "protocol/provider.ts",
		validate: validateEndoProviderUsageV0,
		sample: { schemaVersion: "endo.provider-usage.v0", inputTokens: 1, outputTokens: 1 },
	},
];

/** A null-prototype object with the same own keys and values. */
function nullPrototypeV0(sample: Record<string, unknown>) {
	return Object.assign(Object.create(null), sample);
}

/** A class instance carrying the same own keys and values: strict JSON must not treat it as plain. */
function classInstanceV0(sample: Record<string, unknown>) {
	class Wrapped {}
	return Object.assign(new Wrapped(), sample);
}

for (const entry of ENTRIES_V0) {
	describe(`strict JSON — ${entry.file}`, () => {
		const { validate, sample } = entry;

		it("accepts the plain object literal", () => {
			expect(validate(sample)).not.toBeNull();
		});

		it("accepts a null-prototype object with the same fields", () => {
			expect(validate(nullPrototypeV0(sample))).not.toBeNull();
		});

		it("rejects a class instance wrapping the same fields", () => {
			expect(validate(classInstanceV0(sample))).toBeNull();
		});

		it("rejects an unknown extra key", () => {
			expect(validate({ ...sample, notARecordKey: 1 })).toBeNull();
		});

		it("rejects a Date, a Map, a Set, and an array", () => {
			expect(validate(new Date(0))).toBeNull();
			expect(validate(new Map())).toBeNull();
			expect(validate(new Set([1]))).toBeNull();
			expect(validate([])).toBeNull();
		});
	});
}

describe("strict JSON — protocol/primitives.ts", () => {
	it("accepts a plain object literal and a null-prototype object", () => {
		expect(isPlainJsonObjectV0({ a: 1 })).toBe(true);
		expect(isPlainJsonObjectV0(Object.assign(Object.create(null), { a: 1 }))).toBe(true);
	});

	it("rejects a class instance, a Date, a Map, a Set, an array, and a scalar", () => {
		class Wrapped {}
		expect(isPlainJsonObjectV0(Object.assign(new Wrapped(), { a: 1 }))).toBe(false);
		expect(isPlainJsonObjectV0(new Date(0))).toBe(false);
		expect(isPlainJsonObjectV0(new Map())).toBe(false);
		expect(isPlainJsonObjectV0(new Set([1]))).toBe(false);
		expect(isPlainJsonObjectV0([])).toBe(false);
		expect(isPlainJsonObjectV0(1)).toBe(false);
	});
});

describe("strict JSON — non-finite numbers", () => {
	it("rejects NaN and Infinity in a JsonValueV0 numeric field", () => {
		const usage = { schemaVersion: "endo.provider-usage.v0", inputTokens: 1, outputTokens: 1 };
		expect(validateEndoProviderUsageV0({ ...usage, inputTokens: Number.NaN })).toBeNull();
		expect(validateEndoProviderUsageV0({ ...usage, inputTokens: Number.POSITIVE_INFINITY })).toBeNull();
	});

	it("rejects NaN in an event sequence and Infinity in a trial index", () => {
		const event = ENTRIES_V0.find((entry) => entry.file === "protocol/event.ts")!.sample;
		expect(validateEndoEventV0({ ...event, sequence: Number.NaN })).toBeNull();
		expect(validateTrialCoordinatesV0({ ...TRIAL_COORDINATES_V0, trial: Number.POSITIVE_INFINITY })).toBeNull();
	});
});
