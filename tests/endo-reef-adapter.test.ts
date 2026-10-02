import { describe, expect, it } from "vitest";

import {
	mapReefArtifactToArtifactV0,
	mapReefCandidateToCandidateV0,
	mapReefMutationToMutationV0,
	mapReefReleaseToPromotionDecisionV0,
	mapReefReleaseToPromotionRequestV0,
	mapReefReportToEvaluationResultV0,
	mapReefScenarioToExperimentV0,
} from "../adapters/reef/mapping.ts";
import type {
	ReefArtifactV0,
	ReefMutationV0,
	ReefReleaseV0,
	ReefReportV0,
	ReefScenarioV0,
} from "../adapters/reef/shapes.ts";
import {
	buildEndoArtifactV0,
	createEndoEvidenceLedgerV0,
	createEndoEvolutionCoreV0,
	createEndoExperimentLifecycleV0,
	ENDO_HIGHEST_SCORE_POLICY_V0,
	replayEndoEvidenceLedgerV0,
	replayEndoExperimentLifecycleV0,
} from "../evolution/index.ts";
import type { EndoEvolutionPolicyContextV0 } from "../evolution/policies/ports.ts";
import { validateEndoEvaluationResultV0 } from "../protocol/evaluation.ts";
import {
	validateEndoCandidateV0,
	validateEndoExperimentRecordV0,
	validateEndoMutationV0,
	validateEndoPromotionDecisionV0,
	validateEndoPromotionRequestV0,
} from "../protocol/evolution.ts";

const EXPERIMENT_ID = "endo.experiment.reef-swe-bench-mini";
const CANDIDATE_ID = "endo.candidate.reef-cand-a";
const MUTATION_ID = "endo.evidence.reef-mut-1";

function scenario(): ReefScenarioV0 {
	return { name: "swe-bench-mini", recipe: "recipes/swe.yaml" };
}

function report(references: string[], overrides: Partial<ReefReportV0> = {}): ReefReportV0 {
	return { references, score: 0.87, feedback: "tests pass", ...overrides };
}

function environment() {
	return { schemaVersion: "endo.environment-profile.v0", environmentId: "env-ci", simulated: false } as const;
}

function mapReport(id: string, report: ReefReportV0, partition?: "evolve-set" | "held-out") {
	return mapReefReportToEvaluationResultV0({
		id,
		experimentId: EXPERIMENT_ID,
		candidateId: CANDIDATE_ID,
		partition,
		runtime: "runtime-a",
		model: "model-x",
		cognitionPolicy: "work",
		environment: environment(),
		report,
	});
}

describe("mapReefScenarioToExperimentV0", () => {
	it("maps a scenario to an experiment record", () => {
		const record = mapReefScenarioToExperimentV0({ scenario: scenario(), evaluator: "eval-1", grader: "grade-1" });
		expect(record.id).toBe(EXPERIMENT_ID);
		expect(record.provenance).toBe("reef scenario swe-bench-mini, recipe recipes/swe.yaml");
		expect(record.evaluator).toBe("eval-1");
		expect(record.grader).toBe("grade-1");
		expect(validateEndoExperimentRecordV0(record)).toEqual(record);
	});

	it("rejects a scenario name outside the local-part grammar", () => {
		expect(() =>
			mapReefScenarioToExperimentV0({ scenario: { name: "swe bench", recipe: "recipes/swe.yaml" } }),
		).toThrow(TypeError);
	});

	it("rejects a name that leaves no room for the reef- prefix", () => {
		expect(() => mapReefScenarioToExperimentV0({ scenario: { name: "a".repeat(256), recipe: "r" } })).toThrow(
			TypeError,
		);
	});
});

describe("mapReefReportToEvaluationResultV0", () => {
	it("maps a report to an evaluation result with one trial per receipt", () => {
		const result = mapReport("endo.evidence.reef-res-1", report(["rec-1", "rec-2"]), "evolve-set");
		expect(result.id).toBe("endo.evidence.reef-res-1");
		expect(result.trials).toHaveLength(2);
		expect(result.trials[0].coordinates.runId).toBe("endo.run.reef-rec-1");
		expect(result.trials[0].coordinates.trial).toBe(0);
		expect(result.trials[1].coordinates.runId).toBe("endo.run.reef-rec-2");
		expect(result.trials[1].coordinates.trial).toBe(1);
		expect(result.trials[0].coordinates.candidateId).toBe(CANDIDATE_ID);
		expect(result.trials[0].partition).toBe("evolve-set");
		expect(result.trials[0].derived).toEqual({ score: 0.87 });
		expect(result.trials[0].raw).toBe("tests pass");
		expect(result.trials[1].derived).toEqual({ score: 0.87 });
		expect(result.profile.candidateId).toBe(CANDIDATE_ID);
		expect(result.profile.trialCount).toBe(2);
		expect(validateEndoEvaluationResultV0(result)).toEqual(result);
	});

	it("rejects a report without receipts", () => {
		expect(() => mapReport("endo.evidence.reef-res-1", report([]))).toThrow(TypeError);
	});

	it("rejects a non-finite score", () => {
		expect(() => mapReport("endo.evidence.reef-res-1", report(["rec-1"], { score: Number.NaN }))).toThrow(TypeError);
	});

	it("rejects a non-strict feedback value", () => {
		expect(() => mapReport("endo.evidence.reef-res-1", report(["rec-1"], { feedback: new Date() }))).toThrow(
			TypeError,
		);
	});

	it("rejects a receipt outside the run identifier grammar", () => {
		expect(() => mapReport("endo.evidence.reef-res-1", report(["rec 1"]))).toThrow(TypeError);
	});

	it("omits derived and raw when the report carries no score or feedback", () => {
		const result = mapReport(
			"endo.evidence.reef-res-1",
			report(["rec-1"], { score: undefined, feedback: undefined }),
		);
		expect(result.trials[0].derived).toBeUndefined();
		expect(result.trials[0].raw).toBeUndefined();
	});
});

describe("mapReefMutationToMutationV0", () => {
	it("maps operations create, update, and remove to add, replace, and remove", () => {
		for (const [operation, mapped] of [
			["create", "add"],
			["update", "replace"],
			["remove", "remove"],
		] as const) {
			const mutation = mapReefMutationToMutationV0({
				id: MUTATION_ID,
				mutation: { operation, entry: "prompt/system" } satisfies ReefMutationV0,
			});
			expect(mutation.operation).toBe(mapped);
			expect(validateEndoMutationV0(mutation)).toEqual(mutation);
		}
	});

	it("maps the entry path to a dotted component kind", () => {
		const mutation = mapReefMutationToMutationV0({
			id: MUTATION_ID,
			mutation: { operation: "create", entry: "skills/fix-tests" },
		});
		expect(mutation.component).toBe("skills.fix-tests");
	});

	it("rejects an entry segment the kind grammar rejects", () => {
		expect(() =>
			mapReefMutationToMutationV0({ id: MUTATION_ID, mutation: { operation: "update", entry: "skills/SKILL.md" } }),
		).toThrow(TypeError);
		expect(() =>
			mapReefMutationToMutationV0({ id: MUTATION_ID, mutation: { operation: "update", entry: "a//b" } }),
		).toThrow(TypeError);
	});

	it("rejects an unknown operation", () => {
		expect(() =>
			mapReefMutationToMutationV0({
				id: MUTATION_ID,
				mutation: { operation: "rewrite", entry: "prompt" } as unknown as ReefMutationV0,
			}),
		).toThrow(TypeError);
	});
});

describe("mapReefCandidateToCandidateV0", () => {
	it("maps a candidate with its mapped mutations in composite-proposal order", () => {
		const candidate = mapReefCandidateToCandidateV0({
			id: CANDIDATE_ID,
			candidate: {
				name: "cand-a",
				mutations: [
					{ operation: "update", entry: "prompt/system" },
					{ operation: "create", entry: "skills/fix-tests" },
				],
				hypothesis: "tighter system prompt improves the test-fix rate",
			},
			mutations: ["endo.evidence.reef-mut-1", "endo.evidence.reef-mut-2"],
		});
		expect(candidate.id).toBe(CANDIDATE_ID);
		expect(candidate.mutations).toEqual(["endo.evidence.reef-mut-1", "endo.evidence.reef-mut-2"]);
		expect(candidate.provenance).toBe("reef candidate cand-a");
		expect(candidate.hypothesis).toBe("tighter system prompt improves the test-fix rate");
		expect(validateEndoCandidateV0(candidate)).toEqual(candidate);
	});

	it("rejects a mutation id outside the evidence namespace", () => {
		expect(() =>
			mapReefCandidateToCandidateV0({
				id: CANDIDATE_ID,
				candidate: { name: "cand-a", mutations: [] },
				mutations: ["endo.candidate.x"],
			}),
		).toThrow(TypeError);
	});
});

describe("mapReefArtifactToArtifactV0", () => {
	it("maps an artifact with content to the content-addressed record", () => {
		const artifact: ReefArtifactV0 = { contentId: "c-123", content: { rules: ["be concise"] } };
		const mapped = mapReefArtifactToArtifactV0({ id: "endo.evidence.reef-art-1", artifact, kind: "harness.prompt" });
		expect(mapped).toEqual(
			buildEndoArtifactV0({
				id: "endo.evidence.reef-art-1",
				kind: "harness.prompt",
				content: artifact.content,
				sourceRevision: "c-123",
			}),
		);
	});

	it("rejects an artifact without content", () => {
		expect(() =>
			mapReefArtifactToArtifactV0({
				id: "endo.evidence.reef-art-1",
				artifact: { contentId: "c-123" },
				kind: "harness.prompt",
			}),
		).toThrow(TypeError);
	});

	it("rejects an artifact without a content id", () => {
		expect(() =>
			mapReefArtifactToArtifactV0({
				id: "endo.evidence.reef-art-1",
				artifact: { content: { a: 1 } } as unknown as ReefArtifactV0,
				kind: "harness.prompt",
			}),
		).toThrow(TypeError);
	});
});

describe("mapReefReleaseToPromotionRequestV0", () => {
	function release(releaseId: string, contentId: string, parentReleaseId?: string): ReefReleaseV0 {
		const release: ReefReleaseV0 = { releaseId, components: [{ name: "harness", contentId }] };
		if (parentReleaseId !== undefined) release.parentReleaseId = parentReleaseId;
		return release;
	}

	it("maps a release to a promotion request with the default target", () => {
		const request = mapReefReleaseToPromotionRequestV0({
			id: "endo.evidence.reef-req-1",
			release: release("rel-01", "c-123"),
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			selectionId: "endo.evidence.reef-sel-1",
			artifactId: "endo.evidence.reef-art-1",
		});
		expect(request.target).toBe("reef release rel-01");
		expect(request.artifactId).toBe("endo.evidence.reef-art-1");
		expect(validateEndoPromotionRequestV0(request)).toEqual(request);
	});

	it("rejects a release id outside the local-part grammar", () => {
		expect(() =>
			mapReefReleaseToPromotionRequestV0({
				id: "endo.evidence.reef-req-1",
				release: release("rel 01", "c-123"),
				experimentId: EXPERIMENT_ID,
				candidateId: CANDIDATE_ID,
				selectionId: "endo.evidence.reef-sel-1",
			}),
		).toThrow(TypeError);
	});
});

describe("mapReefReleaseToPromotionDecisionV0", () => {
	it("maps a release to a granted decision with the default authority", () => {
		const decision = mapReefReleaseToPromotionDecisionV0({
			id: "endo.evidence.reef-dec-1",
			release: { releaseId: "rel-01", components: [{ name: "harness", contentId: "c-123" }] },
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			requestId: "endo.evidence.reef-req-1",
			evidence: ["endo.evidence.reef-res-1"],
		});
		expect(decision.outcome).toBe("granted");
		expect(decision.authority).toBe("reef-rel-01");
		expect(decision.evidence).toEqual(["endo.evidence.reef-res-1"]);
		expect(validateEndoPromotionDecisionV0(decision)).toEqual(decision);
	});

	it("rejects an empty evidence list", () => {
		expect(() =>
			mapReefReleaseToPromotionDecisionV0({
				id: "endo.evidence.reef-dec-1",
				release: { releaseId: "rel-01", components: [{ name: "harness", contentId: "c-123" }] },
				experimentId: EXPERIMENT_ID,
				candidateId: CANDIDATE_ID,
				requestId: "endo.evidence.reef-req-1",
				evidence: [],
			}),
		).toThrow(TypeError);
	});
});

describe("the REEF spine through the substrate", () => {
	it("records a release and a rollback as appended decisions, replayable end to end", () => {
		const experiment = mapReefScenarioToExperimentV0({
			scenario: scenario(),
			evaluator: "eval-1",
			grader: "grade-1",
		});
		const core = createEndoEvolutionCoreV0();
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-reef", experiment);
		const lifecycle = createEndoExperimentLifecycleV0(experiment);

		const baseArtifact = mapReefArtifactToArtifactV0({
			id: "endo.evidence.reef-art-base",
			artifact: { contentId: "c-base", content: { prompt: "base harness" } },
			kind: "harness.prompt",
		});
		core.artifacts.add(baseArtifact);
		ledger.append(baseArtifact);

		const mutation = mapReefMutationToMutationV0({
			id: MUTATION_ID,
			mutation: { operation: "update", entry: "harness/prompt" },
			artifactId: "endo.evidence.reef-art-base",
			hypothesis: "tighter prompt improves the test-fix rate",
		});
		core.mutations.add(mutation);
		ledger.append(mutation);

		const candidate = mapReefCandidateToCandidateV0({
			id: CANDIDATE_ID,
			candidate: {
				name: "cand-a",
				mutations: [{ operation: "update", entry: "harness/prompt" }],
				hypothesis: "tighter prompt",
			},
			mutations: [MUTATION_ID],
			artifactId: "endo.evidence.reef-art-base",
		});
		core.candidates.add(candidate);
		ledger.append(candidate);

		const evolve = mapReport("endo.evidence.reef-res-evolve", report(["rec-evolve-1"], { score: 0.9 }), "evolve-set");
		const heldOut = mapReport(
			"endo.evidence.reef-res-heldout",
			report(["rec-heldout-1"], { score: 0.8 }),
			"held-out",
		);
		ledger.append(evolve);
		ledger.append(heldOut);

		const advance = (id: string, to: string) => {
			lifecycle.transition({ id, to });
			ledger.append(lifecycle.transitions[lifecycle.transitions.length - 1]);
		};
		for (const to of ["prepared", "running", "evaluated", "compared"] as const)
			advance(`endo.evidence.tr-reef-${to}`, to);

		const context: EndoEvolutionPolicyContextV0 = {
			experiment,
			candidates: [candidate],
			mutations: [mutation],
			results: [evolve],
			heldOut: [heldOut],
			history: ledger.ledger().entries,
		};
		const selection = ENDO_HIGHEST_SCORE_POLICY_V0.decide(context, "endo.evidence.reef-sel-1");
		expect(selection.outcome).toBe("selected");
		expect(selection.candidateId).toBe(CANDIDATE_ID);
		core.selections.add(selection);
		ledger.append(selection);
		advance("endo.evidence.tr-reef-selected", "selected");

		const releasedArtifact = mapReefArtifactToArtifactV0({
			id: "endo.evidence.reef-art-released",
			artifact: { contentId: "c-a1", content: { prompt: "released harness" } },
			kind: "harness.prompt",
		});
		core.artifacts.add(releasedArtifact);
		ledger.append(releasedArtifact);

		const release1: ReefReleaseV0 = { releaseId: "rel-a1", components: [{ name: "harness", contentId: "c-a1" }] };
		const request1 = mapReefReleaseToPromotionRequestV0({
			id: "endo.evidence.reef-req-1",
			release: release1,
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			selectionId: "endo.evidence.reef-sel-1",
			artifactId: "endo.evidence.reef-art-released",
		});
		const decision1 = mapReefReleaseToPromotionDecisionV0({
			id: "endo.evidence.reef-dec-1",
			release: release1,
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			requestId: "endo.evidence.reef-req-1",
			evidence: selection.evidence,
		});
		core.promotionRequests.add(request1);
		ledger.append(request1);
		core.promotionDecisions.add(decision1);
		ledger.append(decision1);
		advance("endo.evidence.tr-reef-requested", "promotion-requested");
		advance("endo.evidence.tr-reef-promoted", "promoted");

		// Rollback: a new release on the same component pointing back at the base content.
		const rollback: ReefReleaseV0 = {
			releaseId: "rel-a1-rollback",
			parentReleaseId: "rel-a1",
			components: [{ name: "harness", contentId: "c-base" }],
		};
		const request2 = mapReefReleaseToPromotionRequestV0({
			id: "endo.evidence.reef-req-2",
			release: rollback,
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			selectionId: "endo.evidence.reef-sel-1",
			artifactId: "endo.evidence.reef-art-base",
		});
		const decision2 = mapReefReleaseToPromotionDecisionV0({
			id: "endo.evidence.reef-dec-2",
			release: rollback,
			experimentId: EXPERIMENT_ID,
			candidateId: CANDIDATE_ID,
			requestId: "endo.evidence.reef-req-2",
			evidence: selection.evidence,
			reason: "rollback to the base content after a regression",
		});
		expect(request2.artifactId).toBe("endo.evidence.reef-art-base");
		expect(decision2.outcome).toBe("granted");
		expect(decision2.id).not.toBe(decision1.id);
		core.promotionRequests.add(request2);
		ledger.append(request2);
		core.promotionDecisions.add(decision2);
		ledger.append(decision2);

		const entries = ledger.ledger().entries;
		expect(entries).toHaveLength(18);
		expect(entries.map((entry) => entry.sequence)).toEqual(entries.map((_entry, index) => index + 1));

		const replayedLedger = replayEndoEvidenceLedgerV0(ledger.ledger());
		expect(replayedLedger).toEqual(ledger.ledger());
		const replayedLifecycle = replayEndoExperimentLifecycleV0(experiment, lifecycle.transitions);
		expect(replayedLifecycle.state).toBe("promoted");
		expect(replayedLifecycle.transitions).toEqual(lifecycle.transitions);
	});
});
