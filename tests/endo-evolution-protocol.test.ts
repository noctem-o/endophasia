import { describe, expect, it } from "vitest";
import {
	ENDO_CANDIDATE_STATES_V0,
	ENDO_MUTATION_OPERATIONS_V0,
	type EndoArtifactV0,
	type EndoCandidateStateV0,
	type EndoCandidateV0,
	type EndoEvidenceKindV0,
	type EndoEvidenceLedgerEntryV0,
	type EndoEvidenceLedgerV0,
	type EndoExperimentRecordV0,
	type EndoExperimentStateV0,
	type EndoExperimentTransitionV0,
	type EndoMutationV0,
	type EndoPromotionDecisionV0,
	type EndoPromotionRequestV0,
	type EndoSelectionConditionV0,
	type EndoSelectionDecisionV0,
	type EndoSelectionPolicyV0,
	validateEndoArtifactV0,
	validateEndoCandidateV0,
	validateEndoEvidenceLedgerEntryV0,
	validateEndoEvidenceLedgerV0,
	validateEndoExperimentRecordV0,
	validateEndoExperimentTransitionV0,
	validateEndoMutationV0,
	validateEndoPromotionDecisionV0,
	validateEndoPromotionRequestV0,
	validateEndoSelectionConditionV0,
	validateEndoSelectionDecisionV0,
	validateEndoSelectionPolicyV0,
} from "../protocol/evolution.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function validArtifact(withContent = true): EndoArtifactV0 {
	return {
		schemaVersion: "endo.artifact.v0",
		id: "endo.evidence.art-1",
		kind: "prompt",
		digest: DIGEST,
		...(withContent ? { content: { system: "Be concise." }, sourceRevision: "rev-1" } : {}),
	};
}

function validMutation(): EndoMutationV0 {
	return {
		schemaVersion: "endo.mutation.v0",
		id: "endo.evidence.mut-1",
		component: "prompt",
		operation: "replace",
		sourceRevision: "rev-1",
		targetRevision: "rev-2",
		artifactId: "endo.evidence.art-1",
		hypothesis: "A concise system prompt reduces verbosity.",
		expectedEffect: "lower cost per task",
		observedEffect: "fewer tokens",
		costDelta: { tokens: -12 },
		description: "tightened the system prompt",
	};
}

function validCandidate(): EndoCandidateV0 {
	return {
		schemaVersion: "endo.candidate.v0",
		id: "endo.candidate.c-1",
		parentCandidateId: "endo.candidate.c-0",
		sourceRevision: "rev-2",
		artifactId: "endo.evidence.art-1",
		model: "model-x",
		runtime: "runtime-a",
		environment: "env-ci",
		hypothesis: "tightened prompts improve score per token",
		mutations: ["endo.evidence.mut-1"],
		provenance: "built from c-0 under rev-2",
		state: "active",
		revision: "rev-2",
	};
}

function validExperimentRecord(): EndoExperimentRecordV0 {
	return {
		schemaVersion: "endo.experiment.v0",
		id: "endo.experiment.exp-1",
		environment: {
			schemaVersion: "endo.environment-profile.v0",
			environmentId: "env-ci",
			revision: "env-1",
			sandboxId: "sbx-1",
			simulated: false,
		},
		evaluator: "eval-1",
		grader: "grade-1",
		model: "model-x",
		budget: { maxTrials: 3 },
		provenance: "phase-6 smoke experiment",
	};
}

function validTransition(
	sequence: number,
	from: EndoExperimentStateV0,
	to: EndoExperimentStateV0,
): EndoExperimentTransitionV0 {
	return {
		schemaVersion: "endo.experiment-transition.v0",
		id: `endo.evidence.tr-${sequence}`,
		experimentId: "endo.experiment.exp-1",
		sequence,
		from,
		to,
		evidence: ["endo.evidence.res-1"],
		reason: "step",
	};
}

function validPolicy(): EndoSelectionPolicyV0 {
	return { schemaVersion: "endo.selection-policy.v0", name: "highest-score", revision: "v1" };
}

function validCondition(): EndoSelectionConditionV0 {
	return {
		schemaVersion: "endo.selection-condition.v0",
		name: "mean-score-above-floor",
		parameters: { floor: 0.4 },
		observed: { mean: 0.61 },
		met: true,
	};
}

function validDecision(): EndoSelectionDecisionV0 {
	return {
		schemaVersion: "endo.selection-decision.v0",
		id: "endo.evidence.sel-1",
		experimentId: "endo.experiment.exp-1",
		policy: validPolicy(),
		outcome: "selected",
		candidateId: "endo.candidate.c-1",
		conditions: [validCondition()],
		evidence: ["endo.evidence.res-1"],
		heldOutEvidence: ["endo.evidence.hold-1"],
		reason: "best score within budget",
	};
}

function validRequest(): EndoPromotionRequestV0 {
	return {
		schemaVersion: "endo.promotion-request.v0",
		id: "endo.evidence.req-1",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		selectionId: "endo.evidence.sel-1",
		artifactId: "endo.evidence.art-1",
		target: "staging",
		provenance: "requested by the operator",
	};
}

function validPromotionDecision(): EndoPromotionDecisionV0 {
	return {
		schemaVersion: "endo.promotion-decision.v0",
		id: "endo.evidence.prom-1",
		requestId: "endo.evidence.req-1",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		outcome: "granted",
		authority: "ops-a",
		evidence: ["endo.evidence.res-1"],
		reason: "all conditions met",
	};
}

function validEntry(sequence: number, kind: EndoEvidenceKindV0, recordId: string): EndoEvidenceLedgerEntryV0 {
	return { schemaVersion: "endo.evidence-ledger-entry.v0", sequence, kind, recordId };
}

function validLedger(): EndoEvidenceLedgerV0 {
	return {
		schemaVersion: "endo.evidence-ledger.v0",
		id: "endo.evidence.ledger-1",
		experimentId: "endo.experiment.exp-1",
		entries: [
			validEntry(1, "artifact", "endo.evidence.art-1"),
			validEntry(2, "mutation", "endo.evidence.mut-1"),
			validEntry(3, "candidate", "endo.candidate.c-1"),
		],
	};
}

describe("validateEndoArtifactV0", () => {
	it("accepts an artifact with content", () => {
		expect(validateEndoArtifactV0(validArtifact())).toEqual(validArtifact());
	});

	it("accepts an artifact without content", () => {
		expect(validateEndoArtifactV0(validArtifact(false))).toEqual(validArtifact(false));
	});

	it("rejects an unknown field", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(), label: "x" })).toBeNull();
	});

	it("rejects a wrong schemaVersion", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(), schemaVersion: "endo.artifact.v1" })).toBeNull();
	});

	it("rejects an id outside the evidence namespace", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(), id: "endo.model.art-1" })).toBeNull();
	});

	it("rejects a malformed digest", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(false), digest: DIGEST.toUpperCase() })).toBeNull();
		expect(validateEndoArtifactV0({ ...validArtifact(false), digest: "abc" })).toBeNull();
	});

	it.each([["Prompt"], ["prompt..x"], ["1bad"], [""]])("rejects a malformed kind %j", (kind) => {
		expect(validateEndoArtifactV0({ ...validArtifact(false), kind })).toBeNull();
	});

	it("rejects non-strict content", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(), content: { score: Number.NaN } })).toBeNull();
	});

	it("rejects an over-long source revision", () => {
		expect(validateEndoArtifactV0({ ...validArtifact(), sourceRevision: "r".repeat(257) })).toBeNull();
	});
});

describe("validateEndoMutationV0", () => {
	it("accepts a mutation", () => {
		expect(validateEndoMutationV0(validMutation())).toEqual(validMutation());
	});

	it("accepts the minimal mutation", () => {
		const minimal = {
			schemaVersion: "endo.mutation.v0",
			id: "endo.evidence.mut-2",
			component: "tool",
			operation: "add",
		};
		expect(validateEndoMutationV0(minimal)).toEqual(minimal);
	});

	it("rejects an unknown field", () => {
		expect(validateEndoMutationV0({ ...validMutation(), patch: "diff" })).toBeNull();
	});

	it("rejects an id outside the evidence namespace", () => {
		expect(validateEndoMutationV0({ ...validMutation(), id: "endo.candidate.mut-1" })).toBeNull();
	});

	it("rejects an operation outside the closed four-way", () => {
		expect(validateEndoMutationV0({ ...validMutation(), operation: "mutate" })).toBeNull();
	});

	it("accepts every documented operation", () => {
		for (const operation of ENDO_MUTATION_OPERATIONS_V0) {
			expect(validateEndoMutationV0({ ...validMutation(), operation })).not.toBeNull();
		}
	});

	it("rejects a malformed component", () => {
		expect(validateEndoMutationV0({ ...validMutation(), component: "Prompt" })).toBeNull();
	});

	it("rejects an artifact reference outside the evidence namespace", () => {
		expect(validateEndoMutationV0({ ...validMutation(), artifactId: "endo.model.art-1" })).toBeNull();
	});

	it("rejects non-strict cost deltas", () => {
		expect(
			validateEndoMutationV0({ ...validMutation(), costDelta: { tokens: Number.POSITIVE_INFINITY } }),
		).toBeNull();
	});

	it("rejects over-long statements", () => {
		expect(validateEndoMutationV0({ ...validMutation(), hypothesis: "h".repeat(4097) })).toBeNull();
		expect(validateEndoMutationV0({ ...validMutation(), expectedEffect: "e".repeat(4097) })).toBeNull();
		expect(validateEndoMutationV0({ ...validMutation(), observedEffect: "o".repeat(4097) })).toBeNull();
		expect(validateEndoMutationV0({ ...validMutation(), description: "d".repeat(4097) })).toBeNull();
	});
});

describe("validateEndoCandidateV0", () => {
	it("accepts a candidate", () => {
		expect(validateEndoCandidateV0(validCandidate())).toEqual(validCandidate());
	});

	it("accepts a base candidate with no parent and no mutations", () => {
		const base = { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c-0", mutations: [] as string[] };
		expect(validateEndoCandidateV0(base)).toEqual(base);
	});

	it("rejects an unknown field", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), patch: "x" })).toBeNull();
	});

	it("rejects an id outside the candidate namespace", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), id: "endo.evidence.c-1" })).toBeNull();
	});

	it("rejects a missing mutations array", () => {
		const { mutations: _mutations, ...rest } = validCandidate();
		expect(validateEndoCandidateV0(rest)).toBeNull();
	});

	it("rejects a mutation reference outside the evidence namespace", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), mutations: ["endo.model.mut-1"] })).toBeNull();
	});

	it("rejects a parent outside the candidate namespace", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), parentCandidateId: "endo.evidence.c-0" })).toBeNull();
	});

	it("rejects a state outside the closed three-way", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), state: "archived" })).toBeNull();
	});

	it("accepts every documented candidate state", () => {
		for (const state of ENDO_CANDIDATE_STATES_V0) {
			expect(validateEndoCandidateV0({ ...validCandidate(), state: state as EndoCandidateStateV0 })).not.toBeNull();
		}
	});

	it("rejects over-long identities", () => {
		expect(validateEndoCandidateV0({ ...validCandidate(), model: "m".repeat(257) })).toBeNull();
		expect(validateEndoCandidateV0({ ...validCandidate(), runtime: "r".repeat(257) })).toBeNull();
		expect(validateEndoCandidateV0({ ...validCandidate(), environment: "e".repeat(257) })).toBeNull();
	});
});

describe("validateEndoExperimentRecordV0", () => {
	it("accepts an experiment record", () => {
		expect(validateEndoExperimentRecordV0(validExperimentRecord())).toEqual(validExperimentRecord());
	});

	it("accepts the minimal record", () => {
		const minimal = { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-2" };
		expect(validateEndoExperimentRecordV0(minimal)).toEqual(minimal);
	});

	it("rejects an unknown field", () => {
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), budgetX: 1 })).toBeNull();
	});

	it("rejects an id outside the experiment namespace", () => {
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), id: "endo.evidence.exp-1" })).toBeNull();
	});

	it("rejects an invalid nested environment profile", () => {
		const record = {
			...validExperimentRecord(),
			environment: { ...validExperimentRecord().environment, simulated: "no" },
		};
		expect(validateEndoExperimentRecordV0(record)).toBeNull();
	});

	it("rejects non-strict budgets", () => {
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), budget: { max: Number.NaN } })).toBeNull();
	});

	it("rejects over-long names", () => {
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), evaluator: "e".repeat(257) })).toBeNull();
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), grader: "g".repeat(257) })).toBeNull();
		expect(validateEndoExperimentRecordV0({ ...validExperimentRecord(), model: "m".repeat(257) })).toBeNull();
	});
});

describe("validateEndoExperimentTransitionV0", () => {
	it("accepts a legal transition", () => {
		expect(validateEndoExperimentTransitionV0(validTransition(1, "created", "prepared"))).toEqual(
			validTransition(1, "created", "prepared"),
		);
	});

	it("accepts a transition without evidence or reason", () => {
		const { evidence: _evidence, reason: _reason, ...rest } = validTransition(1, "created", "prepared");
		expect(validateEndoExperimentTransitionV0(rest)).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(
			validateEndoExperimentTransitionV0({ ...validTransition(1, "created", "prepared"), note: "x" }),
		).toBeNull();
	});

	it("rejects ids outside the evidence namespace", () => {
		expect(
			validateEndoExperimentTransitionV0({ ...validTransition(1, "created", "prepared"), id: "endo.model.tr-1" }),
		).toBeNull();
	});

	it("rejects an experiment outside the experiment namespace", () => {
		expect(
			validateEndoExperimentTransitionV0({
				...validTransition(1, "created", "prepared"),
				experimentId: "endo.run.exp-1",
			}),
		).toBeNull();
	});

	it("rejects a sequence that is not a positive integer", () => {
		expect(
			validateEndoExperimentTransitionV0({ ...validTransition(0, "created", "prepared"), sequence: 0 }),
		).toBeNull();
		expect(
			validateEndoExperimentTransitionV0({ ...validTransition(1, "created", "prepared"), sequence: 1.5 }),
		).toBeNull();
	});

	it("rejects unknown states", () => {
		const from = "paused" as EndoExperimentStateV0;
		const to = "paused" as EndoExperimentStateV0;
		expect(validateEndoExperimentTransitionV0({ ...validTransition(1, "created", "prepared"), from, to })).toBeNull();
	});

	it("rejects an evidence reference outside the evidence namespace", () => {
		expect(
			validateEndoExperimentTransitionV0({
				...validTransition(1, "created", "prepared"),
				evidence: ["endo.model.res-1"],
			}),
		).toBeNull();
	});

	it("rejects a table-illegal from→to pair", () => {
		expect(validateEndoExperimentTransitionV0(validTransition(1, "created", "running"))).toBeNull();
		expect(validateEndoExperimentTransitionV0(validTransition(2, "running", "prepared"))).toBeNull();
		expect(validateEndoExperimentTransitionV0(validTransition(3, "promoted", "created"))).toBeNull();
	});
});

describe("validateEndoSelectionPolicyV0", () => {
	it("accepts a policy", () => {
		expect(validateEndoSelectionPolicyV0(validPolicy())).toEqual(validPolicy());
	});

	it("accepts a policy without a revision", () => {
		const { revision: _revision, ...rest } = validPolicy();
		expect(validateEndoSelectionPolicyV0(rest)).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoSelectionPolicyV0({ ...validPolicy(), weight: 1 })).toBeNull();
	});

	it("rejects an empty or over-long name", () => {
		expect(validateEndoSelectionPolicyV0({ ...validPolicy(), name: "" })).toBeNull();
		expect(validateEndoSelectionPolicyV0({ ...validPolicy(), name: "n".repeat(257) })).toBeNull();
	});

	it("rejects an over-long revision", () => {
		expect(validateEndoSelectionPolicyV0({ ...validPolicy(), revision: "r".repeat(257) })).toBeNull();
	});
});

describe("validateEndoSelectionConditionV0", () => {
	it("accepts a condition", () => {
		expect(validateEndoSelectionConditionV0(validCondition())).toEqual(validCondition());
	});

	it("accepts a condition without parameters or observations", () => {
		const minimal = { schemaVersion: "endo.selection-condition.v0", name: "no-leakage", met: false };
		expect(validateEndoSelectionConditionV0(minimal)).toEqual(minimal);
	});

	it("rejects an unknown field", () => {
		expect(validateEndoSelectionConditionV0({ ...validCondition(), weight: 2 })).toBeNull();
	});

	it("rejects a missing or non-boolean met flag", () => {
		const { met: _met, ...rest } = validCondition();
		expect(validateEndoSelectionConditionV0(rest)).toBeNull();
		expect(validateEndoSelectionConditionV0({ ...validCondition(), met: "yes" })).toBeNull();
	});

	it("rejects an empty or over-long name", () => {
		expect(validateEndoSelectionConditionV0({ ...validCondition(), name: "" })).toBeNull();
		expect(validateEndoSelectionConditionV0({ ...validCondition(), name: "n".repeat(257) })).toBeNull();
	});

	it("rejects non-strict parameters or observations", () => {
		expect(validateEndoSelectionConditionV0({ ...validCondition(), parameters: { floor: Number.NaN } })).toBeNull();
		expect(validateEndoSelectionConditionV0({ ...validCondition(), observed: { mean: Number.NaN } })).toBeNull();
	});
});

describe("validateEndoSelectionDecisionV0", () => {
	it("rejects an unknown field", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), gate: true })).toBeNull();
	});

	it("rejects an invalid nested policy", () => {
		expect(
			validateEndoSelectionDecisionV0({ ...validDecision(), policy: { schemaVersion: "endo.selection-policy.v0" } }),
		).toBeNull();
	});

	it("rejects an outcome outside the closed three-way", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), outcome: "promoted" })).toBeNull();
	});

	it("rejects a selected outcome without a candidate", () => {
		const { candidateId: _candidateId, ...rest } = validDecision();
		expect(validateEndoSelectionDecisionV0(rest)).toBeNull();
	});

	it("rejects a non-selected outcome that names a candidate", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), outcome: "rejected" })).toBeNull();
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), outcome: "inconclusive" })).toBeNull();
	});

	it("accepts a rejected outcome with no candidate and no evidence", () => {
		const rejected = {
			schemaVersion: "endo.selection-decision.v0",
			id: "endo.evidence.sel-2",
			experimentId: "endo.experiment.exp-1",
			policy: validPolicy(),
			outcome: "rejected",
			conditions: [validCondition()],
			evidence: [],
		};
		expect(validateEndoSelectionDecisionV0(rejected)).toEqual(rejected);
	});

	it("rejects empty conditions", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), conditions: [] })).toBeNull();
	});

	it("rejects an invalid nested condition", () => {
		expect(
			validateEndoSelectionDecisionV0({ ...validDecision(), conditions: [{ ...validCondition(), met: "yes" }] }),
		).toBeNull();
	});

	it("rejects a selected outcome with no evidence", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), evidence: [] })).toBeNull();
	});

	it("rejects evidence outside the evidence namespace", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), evidence: ["endo.model.res-1"] })).toBeNull();
	});

	it("rejects a non-array held-out evidence", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), heldOutEvidence: "hold" })).toBeNull();
	});

	it("rejects an over-long reason", () => {
		expect(validateEndoSelectionDecisionV0({ ...validDecision(), reason: "r".repeat(4097) })).toBeNull();
	});
});

describe("validateEndoPromotionRequestV0", () => {
	it("accepts a request", () => {
		expect(validateEndoPromotionRequestV0(validRequest())).toEqual(validRequest());
	});

	it("accepts a request without an artifact or target", () => {
		const { artifactId: _artifactId, target: _target, ...rest } = validRequest();
		expect(validateEndoPromotionRequestV0(rest)).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoPromotionRequestV0({ ...validRequest(), deploy: true })).toBeNull();
	});

	it("rejects wrong-namespace identifiers", () => {
		expect(validateEndoPromotionRequestV0({ ...validRequest(), id: "endo.model.req-1" })).toBeNull();
		expect(validateEndoPromotionRequestV0({ ...validRequest(), experimentId: "endo.evidence.exp-1" })).toBeNull();
		expect(validateEndoPromotionRequestV0({ ...validRequest(), candidateId: "endo.evidence.c-1" })).toBeNull();
		expect(validateEndoPromotionRequestV0({ ...validRequest(), selectionId: "endo.model.sel-1" })).toBeNull();
		expect(validateEndoPromotionRequestV0({ ...validRequest(), artifactId: "endo.model.art-1" })).toBeNull();
	});

	it("rejects an empty or over-long target", () => {
		expect(validateEndoPromotionRequestV0({ ...validRequest(), target: "" })).toBeNull();
		expect(validateEndoPromotionRequestV0({ ...validRequest(), target: "t".repeat(257) })).toBeNull();
	});

	it("rejects an over-long provenance", () => {
		expect(validateEndoPromotionRequestV0({ ...validRequest(), provenance: "p".repeat(4097) })).toBeNull();
	});
});

describe("validateEndoPromotionDecisionV0", () => {
	it("accepts a granted decision", () => {
		expect(validateEndoPromotionDecisionV0(validPromotionDecision())).toEqual(validPromotionDecision());
	});

	it("accepts a denied decision with no evidence", () => {
		const denied = {
			schemaVersion: "endo.promotion-decision.v0",
			id: "endo.evidence.prom-2",
			requestId: "endo.evidence.req-1",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c-1",
			outcome: "denied",
			authority: "ops-a",
			evidence: [],
		};
		expect(validateEndoPromotionDecisionV0(denied)).toEqual(denied);
	});

	it("rejects an unknown field", () => {
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), receipt: "r" })).toBeNull();
	});

	it("rejects wrong-namespace identifiers", () => {
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), id: "endo.model.prom-1" })).toBeNull();
		expect(
			validateEndoPromotionDecisionV0({ ...validPromotionDecision(), requestId: "endo.model.req-1" }),
		).toBeNull();
		expect(
			validateEndoPromotionDecisionV0({ ...validPromotionDecision(), experimentId: "endo.candidate.exp-1" }),
		).toBeNull();
		expect(
			validateEndoPromotionDecisionV0({ ...validPromotionDecision(), candidateId: "endo.evidence.c-1" }),
		).toBeNull();
	});

	it("rejects an outcome outside the closed two-way", () => {
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), outcome: "pending" })).toBeNull();
	});

	it("rejects a granted decision with no evidence", () => {
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), evidence: [] })).toBeNull();
	});

	it("rejects evidence outside the evidence namespace", () => {
		expect(
			validateEndoPromotionDecisionV0({ ...validPromotionDecision(), evidence: ["endo.model.res-1"] }),
		).toBeNull();
	});

	it("rejects an empty or over-long authority", () => {
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), authority: "" })).toBeNull();
		expect(validateEndoPromotionDecisionV0({ ...validPromotionDecision(), authority: "a".repeat(257) })).toBeNull();
	});
});

describe("validateEndoEvidenceLedgerEntryV0", () => {
	it("accepts an entry", () => {
		expect(validateEndoEvidenceLedgerEntryV0(validEntry(1, "artifact", "endo.evidence.art-1"))).toEqual(
			validEntry(1, "artifact", "endo.evidence.art-1"),
		);
	});

	it("rejects an unknown field", () => {
		expect(
			validateEndoEvidenceLedgerEntryV0({ ...validEntry(1, "artifact", "endo.evidence.art-1"), note: "x" }),
		).toBeNull();
	});

	it("rejects a sequence that is not a positive integer", () => {
		expect(
			validateEndoEvidenceLedgerEntryV0({ ...validEntry(1, "artifact", "endo.evidence.art-1"), sequence: 0 }),
		).toBeNull();
		expect(
			validateEndoEvidenceLedgerEntryV0({ ...validEntry(1, "artifact", "endo.evidence.art-1"), sequence: 1.5 }),
		).toBeNull();
	});

	it("rejects a kind outside the closed sixteen-way", () => {
		expect(
			validateEndoEvidenceLedgerEntryV0(validEntry(1, "proposal" as EndoEvidenceKindV0, "endo.evidence.x")),
		).toBeNull();
	});

	it("requires the candidate namespace only for candidate entries", () => {
		expect(validateEndoEvidenceLedgerEntryV0(validEntry(1, "candidate", "endo.candidate.c-1"))).not.toBeNull();
		expect(validateEndoEvidenceLedgerEntryV0(validEntry(1, "candidate", "endo.evidence.c-1"))).toBeNull();
		expect(validateEndoEvidenceLedgerEntryV0(validEntry(1, "mutation", "endo.candidate.mut-1"))).toBeNull();
	});

	it("rejects a record id in any other namespace", () => {
		expect(validateEndoEvidenceLedgerEntryV0(validEntry(1, "artifact", "endo.model.art-1"))).toBeNull();
	});
});

describe("validateEndoEvidenceLedgerV0", () => {
	it("accepts a ledger", () => {
		expect(validateEndoEvidenceLedgerV0(validLedger())).toEqual(validLedger());
	});

	it("accepts an empty ledger", () => {
		const { entries: _entries, ...rest } = validLedger();
		expect(validateEndoEvidenceLedgerV0({ ...rest, entries: [] })).not.toBeNull();
	});

	it("rejects an unknown field", () => {
		expect(validateEndoEvidenceLedgerV0({ ...validLedger(), sealed: true })).toBeNull();
	});

	it("rejects an id outside the evidence namespace", () => {
		expect(validateEndoEvidenceLedgerV0({ ...validLedger(), id: "endo.model.ledger-1" })).toBeNull();
	});

	it("rejects an experiment outside the experiment namespace", () => {
		expect(validateEndoEvidenceLedgerV0({ ...validLedger(), experimentId: "endo.candidate.exp-1" })).toBeNull();
	});

	it("rejects entries whose sequences are not exactly 1..n", () => {
		const ledger = {
			...validLedger(),
			entries: [validEntry(1, "artifact", "endo.evidence.art-1"), validEntry(3, "mutation", "endo.evidence.mut-1")],
		};
		expect(validateEndoEvidenceLedgerV0(ledger)).toBeNull();
	});

	it("rejects duplicate record ids", () => {
		const ledger = {
			...validLedger(),
			entries: [validEntry(1, "artifact", "endo.evidence.art-1"), validEntry(2, "artifact", "endo.evidence.art-1")],
		};
		expect(validateEndoEvidenceLedgerV0(ledger)).toBeNull();
	});

	it("rejects an invalid nested entry", () => {
		const ledger = { ...validLedger(), entries: [validEntry(1, "artifact", "endo.model.art-1")] };
		expect(validateEndoEvidenceLedgerV0(ledger)).toBeNull();
	});
});

describe("canonical JSON round-trip", () => {
	const roundTrips: Array<[string, unknown, (value: unknown) => unknown]> = [
		["artifact", validArtifact(), validateEndoArtifactV0],
		["mutation", validMutation(), validateEndoMutationV0],
		["candidate", validCandidate(), validateEndoCandidateV0],
		["experiment record", validExperimentRecord(), validateEndoExperimentRecordV0],
		["experiment transition", validTransition(1, "created", "prepared"), validateEndoExperimentTransitionV0],
		["selection policy", validPolicy(), validateEndoSelectionPolicyV0],
		["selection condition", validCondition(), validateEndoSelectionConditionV0],
		["selection decision", validDecision(), validateEndoSelectionDecisionV0],
		["promotion request", validRequest(), validateEndoPromotionRequestV0],
		["promotion decision", validPromotionDecision(), validateEndoPromotionDecisionV0],
		["ledger entry", validEntry(1, "artifact", "endo.evidence.art-1"), validateEndoEvidenceLedgerEntryV0],
		["ledger", validLedger(), validateEndoEvidenceLedgerV0],
	];

	it.each(roundTrips)("round-trips the %s record", (_name, instance) => {
		const revived = JSON.parse(canonicalEndoJsonV0(instance));
		expect(revived).toEqual(instance);
	});

	it.each(roundTrips)("%s revives as a valid value", (_name, instance, validator) => {
		const revived = JSON.parse(canonicalEndoJsonV0(instance));
		expect(validator(revived)).not.toBeNull();
	});
});
