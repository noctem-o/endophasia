import { describe, expect, it } from "vitest";
import {
	buildEndoArtifactV0,
	createEndoEvidenceLedgerV0,
	createEndoEvolutionCoreV0,
	createEndoExperimentLifecycleV0,
	replayEndoEvidenceLedgerV0,
	replayEndoExperimentLifecycleV0,
} from "../evolution/index.ts";
import type { EndoEvaluationProfileV0, EndoEvaluationResultV0, EndoTrialResultV0 } from "../protocol/evaluation.ts";
import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoEvidenceLedgerV0,
	EndoExperimentRecordV0,
	EndoExperimentStateV0,
	EndoExperimentTransitionV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
}

function artifact(): EndoArtifactV0 {
	return {
		schemaVersion: "endo.artifact.v0",
		id: "endo.evidence.art-1",
		kind: "prompt",
		digest: DIGEST,
		content: { system: "Be concise." },
	};
}

function mutation(): EndoMutationV0 {
	return {
		schemaVersion: "endo.mutation.v0",
		id: "endo.evidence.mut-1",
		component: "prompt",
		operation: "replace",
		artifactId: "endo.evidence.art-1",
	};
}

function candidate(mutations: string[] = ["endo.evidence.mut-1"]): EndoCandidateV0 {
	return {
		schemaVersion: "endo.candidate.v0",
		id: "endo.candidate.c-1",
		parentCandidateId: "endo.candidate.c-0",
		mutations,
	};
}

function baseCandidate(): EndoCandidateV0 {
	return { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c-0", mutations: [] };
}

function evaluationResult(): EndoEvaluationResultV0 {
	const profile: EndoEvaluationProfileV0 = {
		schemaVersion: "endo.evaluation-profile.v0",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		candidateRevision: "rev-3",
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false },
		evaluator: "eval-1",
		grader: "grade-1",
		seeds: [7, "seed-b"],
		trialCount: 3,
	};
	const trial = (i: number): EndoTrialResultV0 => ({
		schemaVersion: "endo.trial-result.v0",
		coordinates: {
			schemaVersion: "endo.trial.v0",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c-1",
			trial: i,
			runId: `endo.run.r${i}`,
		},
		partition: "held-out",
		raw: { ok: true },
		derived: { score: 0.5 },
	});
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id: "endo.evidence.res-1",
		profile,
		trials: [trial(0), trial(1), trial(2)],
		usage: { tokens: { input: 4, output: 6, total: 10 }, cost: { input: 1, output: 9, total: 10 }, durationMs: 5 },
		wallTimeMs: 42,
		resultBundleDigest: DIGEST,
		selectionPolicy: "policy-p",
		promotionState: "candidate",
	};
}

function conformanceSuite(version = "0.9.7"): unknown {
	return {
		schemaVersion: "endo.conformance-suite.v0",
		subject: "prime",
		version,
		studies: [
			{
				schemaVersion: "endo.conformance-study.v0",
				subject: "prime",
				version,
				scenario: "s1",
				decoder: "dec-1",
				predicate: "pred-1",
				expected: "the tool reports completion",
				observed: "the tool reported completion",
				classification: "EXACT",
				evidence: [DIGEST, "endo.evidence.e1"],
				limitations: ["single run"],
			},
		],
	};
}

function replayComparison(): unknown {
	return {
		schemaVersion: "endo.replay-comparison.v0",
		recordId: "endo.evidence.rec-1",
		events: "exact",
		derived: "reconstructed",
		computedDigest: DIGEST,
		graph: "exact",
		visualState: "exact",
	};
}

function experimentBundle(): unknown {
	return {
		schemaVersion: "endo.experiment-bundle.v0",
		id: "endo.evidence.bundle-1",
		result: evaluationResult(),
		digest: DIGEST,
	};
}

function selection(outcome: "selected" | "rejected" = "selected"): EndoSelectionDecisionV0 {
	return {
		schemaVersion: "endo.selection-decision.v0",
		id: "endo.evidence.sel-1",
		experimentId: "endo.experiment.exp-1",
		policy: { schemaVersion: "endo.selection-policy.v0", name: "highest-score" },
		outcome,
		...(outcome === "selected" ? { candidateId: "endo.candidate.c-1" } : {}),
		conditions: [{ schemaVersion: "endo.selection-condition.v0", name: "mean-score-above-floor", met: true }],
		evidence: outcome === "selected" ? ["endo.evidence.res-1"] : [],
	};
}

function promotionRequest(): EndoPromotionRequestV0 {
	return {
		schemaVersion: "endo.promotion-request.v0",
		id: "endo.evidence.req-1",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		selectionId: "endo.evidence.sel-1",
	};
}

function promotionDecision(outcome: "granted" | "denied" = "granted"): EndoPromotionDecisionV0 {
	return {
		schemaVersion: "endo.promotion-decision.v0",
		id: "endo.evidence.prom-1",
		requestId: "endo.evidence.req-1",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		outcome,
		authority: "ops-a",
		evidence: outcome === "granted" ? ["endo.evidence.res-1"] : [],
	};
}

function transition(
	id: string,
	sequence: number,
	from: EndoExperimentStateV0,
	to: EndoExperimentStateV0,
	evidence: string[] = ["endo.evidence.res-1"],
): EndoExperimentTransitionV0 {
	return {
		schemaVersion: "endo.experiment-transition.v0",
		id,
		experimentId: "endo.experiment.exp-1",
		sequence,
		from,
		to,
		evidence,
	};
}

const SPINE: Array<[EndoExperimentStateV0, EndoExperimentStateV0]> = [
	["created", "prepared"],
	["prepared", "running"],
	["running", "evaluated"],
	["evaluated", "compared"],
	["compared", "selected"],
	["selected", "promotion-requested"],
	["promotion-requested", "promoted"],
];

function spineTransitions(): EndoExperimentTransitionV0[] {
	return SPINE.map(([from, to], index) => transition(`endo.evidence.tr-${index + 1}`, index + 1, from, to));
}

describe("createEndoEvidenceLedgerV0", () => {
	it("rejects an invalid ledger id", () => {
		expect(() => createEndoEvidenceLedgerV0("endo.model.ledger-1", experimentRecord())).toThrow(TypeError);
	});

	it("rejects an invalid experiment record", () => {
		expect(() =>
			createEndoEvidenceLedgerV0("endo.evidence.ledger-1", {
				schemaVersion: "endo.experiment.v0",
				id: "endo.candidate.x",
			}),
		).toThrow(TypeError);
	});

	it("starts empty with the experiment record", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(ledger.length).toBe(0);
		expect(ledger.record).toEqual(experimentRecord());
	});

	it("derives the ledger kind for every closed schema version", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const sequence: Array<[unknown, string, string]> = [
			[artifact(), "artifact", "endo.evidence.art-1"],
			[mutation(), "mutation", "endo.evidence.mut-1"],
			[baseCandidate(), "candidate", "endo.candidate.c-0"],
			[candidate(), "candidate", "endo.candidate.c-1"],
			[evaluationResult(), "evaluation-result", "endo.evidence.res-1"],
			[selection("rejected"), "selection-decision", "endo.evidence.sel-1"],
			[promotionRequest(), "promotion-request", "endo.evidence.req-1"],
			[promotionDecision("denied"), "promotion-decision", "endo.evidence.prom-1"],
			[transition("endo.evidence.tr-1", 1, "created", "prepared"), "experiment-transition", "endo.evidence.tr-1"],
			[conformanceSuite(), "conformance-suite", ""],
			[replayComparison(), "replay-comparison", ""],
			[experimentBundle(), "experiment-bundle", "endo.evidence.bundle-1"],
		];
		for (const [index, [record, kind, recordId]] of sequence.entries()) {
			const entry = ledger.append(record);
			expect(entry.sequence).toBe(index + 1);
			expect(entry.kind).toBe(kind);
			if (recordId !== "") expect(entry.recordId).toBe(recordId);
		}
		expect(ledger.length).toBe(sequence.length);
	});

	it("assigns content-addressed identities to id-less records", () => {
		const first = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const entry = first.append(conformanceSuite());
		expect(entry.recordId).toMatch(/^endo\.evidence\.conformance-suite\.[0-9a-f]{64}$/);

		const second = createEndoEvidenceLedgerV0("endo.evidence.ledger-2", experimentRecord());
		const entry2 = second.append(replayComparison());
		expect(entry2.recordId).toMatch(/^endo\.evidence\.replay-comparison\.[0-9a-f]{64}$/);
	});

	it("treats identical id-less content as a duplicate", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(conformanceSuite());
		expect(() => ledger.append(conformanceSuite())).toThrow(TypeError);

		const other = conformanceSuite("0.9.8");
		expect(ledger.append(other).recordId).not.toBe(ledger.ledger().entries[0].recordId);
	});

	it("rejects a duplicate id-bearing record", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		expect(() => ledger.append(artifact())).toThrow(TypeError);
	});

	it("rejects a record with an unknown schema version", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append({ schemaVersion: "endo.unknown.v0" })).toThrow(TypeError);
		expect(() => ledger.append({ noSchema: true })).toThrow(TypeError);
	});

	it("rejects forward references for every referencing kind", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(candidate(["endo.evidence.mut-9"]))).toThrow(TypeError);
		expect(() => ledger.append(mutation())).toThrow(TypeError);
		expect(() => ledger.append(transition("endo.evidence.tr-1", 1, "created", "prepared"))).toThrow(TypeError);
		expect(() => ledger.append(selection("selected"))).toThrow(TypeError);
		expect(() => ledger.append(promotionRequest())).toThrow(TypeError);
		expect(() => ledger.append(promotionDecision("granted"))).toThrow(TypeError);
	});

	it("accepts a full causal chain appended in order", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		ledger.append(mutation());
		ledger.append(baseCandidate());
		ledger.append(candidate());
		ledger.append(evaluationResult());
		ledger.append(selection("selected"));
		ledger.append(promotionRequest());
		ledger.append(promotionDecision("granted"));
		for (const record of spineTransitions()) ledger.append(record);
		expect(ledger.length).toBe(15);
	});

	it("exposes an immutable ledger view", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		const snapshot = ledger.ledger();
		expect(snapshot.entries).toHaveLength(1);
		ledger.append(mutation());
		expect(snapshot.entries).toHaveLength(1);
		expect(ledger.ledger().entries).toHaveLength(2);
	});
});

describe("replayEndoEvidenceLedgerV0", () => {
	function ledgerWithEntries(entries: EndoEvidenceLedgerV0["entries"]): EndoEvidenceLedgerV0 {
		return {
			schemaVersion: "endo.evidence-ledger.v0",
			id: "endo.evidence.ledger-1",
			experimentId: "endo.experiment.exp-1",
			entries,
		};
	}

	it("replays a ledger built by the service", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		ledger.append(mutation());
		const replayed = replayEndoEvidenceLedgerV0(ledger.ledger());
		expect(replayed).toEqual(ledger.ledger());
	});

	it("rejects a tampered sequence gap", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		ledger.append(mutation());
		const tampered = ledger.ledger();
		tampered.entries[1] = { ...tampered.entries[1], sequence: 3 };
		expect(() => replayEndoEvidenceLedgerV0(tampered)).toThrow(TypeError);
	});

	it("rejects a duplicate record id", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		const tampered = ledger.ledger();
		tampered.entries.push({
			schemaVersion: "endo.evidence-ledger-entry.v0",
			sequence: 2,
			kind: "artifact",
			recordId: "endo.evidence.art-1",
		});
		expect(() => replayEndoEvidenceLedgerV0(tampered)).toThrow(TypeError);
	});

	it("rejects an unknown entry kind", () => {
		const ledger = ledgerWithEntries([
			{
				schemaVersion: "endo.evidence-ledger-entry.v0",
				sequence: 1,
				kind: "proposal" as EndoEvidenceLedgerV0["entries"][number]["kind"],
				recordId: "endo.evidence.x",
			},
		]);
		expect(() => replayEndoEvidenceLedgerV0(ledger)).toThrow(TypeError);
	});

	it("rejects a candidate entry with an evidence-namespace record id", () => {
		const ledger = ledgerWithEntries([
			{
				schemaVersion: "endo.evidence-ledger-entry.v0",
				sequence: 1,
				kind: "candidate",
				recordId: "endo.evidence.c-1",
			},
		]);
		expect(() => replayEndoEvidenceLedgerV0(ledger)).toThrow(TypeError);
	});

	it("rejects an artifact entry with a candidate-namespace record id", () => {
		const ledger = ledgerWithEntries([
			{
				schemaVersion: "endo.evidence-ledger-entry.v0",
				sequence: 1,
				kind: "artifact",
				recordId: "endo.candidate.art-1",
			},
		]);
		expect(() => replayEndoEvidenceLedgerV0(ledger)).toThrow(TypeError);
	});

	it("rejects a wrong ledger schema version", () => {
		const ledger = {
			schemaVersion: "endo.evidence-ledger.v1",
			id: "endo.evidence.ledger-1",
			experimentId: "endo.experiment.exp-1",
			entries: [],
		};
		expect(() => replayEndoEvidenceLedgerV0(ledger)).toThrow(TypeError);
	});

	it("rejects a non-object value", () => {
		expect(() => replayEndoEvidenceLedgerV0("ledger")).toThrow(TypeError);
	});
});

describe("cross-layer integration", () => {
	it("runs an evolution experiment from artifact to promotion and replays both ledgers", () => {
		// Core: build the candidate lineage.
		const core = createEndoEvolutionCoreV0();
		core.artifacts.add(
			buildEndoArtifactV0({ id: "endo.evidence.art-1", kind: "prompt", content: { system: "Be concise." } }),
		);
		core.mutations.add(mutation());
		core.candidates.add(baseCandidate());
		core.candidates.add(candidate());

		// Lifecycle: walk the experiment spine.
		const lifecycle = createEndoExperimentLifecycleV0(experimentRecord());
		for (const [index, [, to]] of SPINE.entries()) {
			lifecycle.transition({ id: `endo.evidence.tr-${index + 1}`, to, evidence: ["endo.evidence.res-1"] });
		}
		expect(lifecycle.state).toBe("promoted");

		// Ledger: append every record in causal order, then the transitions.
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact());
		ledger.append(mutation());
		ledger.append(baseCandidate());
		ledger.append(candidate());
		ledger.append(evaluationResult());
		ledger.append(selection("selected"));
		ledger.append(promotionRequest());
		ledger.append(promotionDecision("granted"));
		for (const record of spineTransitions()) ledger.append(record);
		expect(ledger.length).toBe(15);

		// Replays: the lifecycle and the ledger reconstruct.
		const replayedLifecycle = replayEndoExperimentLifecycleV0(experimentRecord(), spineTransitions());
		expect(replayedLifecycle.state).toBe("promoted");
		expect(replayedLifecycle.transitions).toEqual(lifecycle.transitions);

		const replayedLedger = replayEndoEvidenceLedgerV0(ledger.ledger());
		expect(replayedLedger).toEqual(ledger.ledger());
		expect(replayedLedger.entries.map((entry) => entry.kind)).toEqual([
			"artifact",
			"mutation",
			"candidate",
			"candidate",
			"evaluation-result",
			"selection-decision",
			"promotion-request",
			"promotion-decision",
			...SPINE.map(() => "experiment-transition"),
		]);

		// The ledger's promotion decision names the same candidate as the core.
		const decision = replayedLedger.entries[7];
		expect(decision.recordId).toBe("endo.evidence.prom-1");
		expect(core.candidates.get("endo.candidate.c-1")).not.toBeNull();
	});
});
