import { describe, expect, it } from "vitest";
import { buildEndoArtifactV0, createEndoEvolutionCoreV0 } from "../evolution/index.ts";
import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function validArtifact(): EndoArtifactV0 {
	return {
		schemaVersion: "endo.artifact.v0",
		id: "endo.evidence.art-1",
		kind: "prompt",
		digest: DIGEST,
		content: { system: "Be concise." },
	};
}

function validMutation(): EndoMutationV0 {
	return {
		schemaVersion: "endo.mutation.v0",
		id: "endo.evidence.mut-1",
		component: "prompt",
		operation: "replace",
	};
}

function validCandidate(): EndoCandidateV0 {
	return {
		schemaVersion: "endo.candidate.v0",
		id: "endo.candidate.c-1",
		parentCandidateId: "endo.candidate.c-0",
		mutations: [],
	};
}

function validBaseCandidate(): EndoCandidateV0 {
	return { schemaVersion: "endo.candidate.v0", id: "endo.candidate.c-0", mutations: [] };
}

function validDecision(
	outcome: EndoSelectionDecisionV0["outcome"] = "selected",
	candidateId?: string,
): EndoSelectionDecisionV0 {
	return {
		schemaVersion: "endo.selection-decision.v0",
		id: "endo.evidence.sel-1",
		experimentId: "endo.experiment.exp-1",
		policy: { schemaVersion: "endo.selection-policy.v0", name: "highest-score" },
		outcome,
		...(candidateId === undefined && outcome === "selected"
			? { candidateId: "endo.candidate.c-1" }
			: candidateId === undefined
				? {}
				: { candidateId }),
		conditions: [{ schemaVersion: "endo.selection-condition.v0", name: "mean-score-above-floor", met: true }],
		evidence: outcome === "selected" ? ["endo.evidence.res-1"] : [],
	};
}

function validRequest(): EndoPromotionRequestV0 {
	return {
		schemaVersion: "endo.promotion-request.v0",
		id: "endo.evidence.req-1",
		experimentId: "endo.experiment.exp-1",
		candidateId: "endo.candidate.c-1",
		selectionId: "endo.evidence.sel-1",
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
	};
}

describe("buildEndoArtifactV0", () => {
	it("computes the digest over the canonical content", () => {
		const artifact = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		expect(artifact.digest).toBe(sha256HexV0(canonicalEndoJsonV0({ system: "Be concise." })));
	});

	it("is deterministic: the same content gives the same digest", () => {
		const first = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		const second = buildEndoArtifactV0({
			id: "endo.evidence.art-2",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		expect(first.digest).toBe(second.digest);
	});

	it("gives different content a different digest", () => {
		const first = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		const second = buildEndoArtifactV0({
			id: "endo.evidence.art-2",
			kind: "prompt",
			content: { system: "Be verbose." },
		});
		expect(first.digest).not.toBe(second.digest);
	});

	it("accepts an explicitly supplied matching digest", () => {
		const digest = sha256HexV0(canonicalEndoJsonV0({ system: "Be concise." }));
		const artifact = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
			digest,
		});
		expect(artifact.digest).toBe(digest);
	});

	it("rejects a supplied digest that does not match the content", () => {
		expect(() =>
			buildEndoArtifactV0({
				id: "endo.evidence.art-1",
				kind: "prompt",
				content: { system: "Be concise." },
				digest: DIGEST,
			}),
		).toThrow(TypeError);
	});

	it("requires a digest when the content is absent", () => {
		expect(() => buildEndoArtifactV0({ id: "endo.evidence.art-1", kind: "prompt" })).toThrow(TypeError);
	});

	it("accepts an absent content with a supplied digest", () => {
		const artifact = buildEndoArtifactV0({ id: "endo.evidence.art-1", kind: "prompt", digest: DIGEST });
		expect(artifact.content).toBeUndefined();
		expect(artifact.digest).toBe(DIGEST);
	});

	it("rejects an id outside the evidence namespace", () => {
		expect(() => buildEndoArtifactV0({ id: "endo.model.art-1", kind: "prompt", content: { system: "x" } })).toThrow(
			TypeError,
		);
	});

	it("rejects a malformed kind", () => {
		expect(() =>
			buildEndoArtifactV0({ id: "endo.evidence.art-1", kind: "Prompt", content: { system: "x" } }),
		).toThrow(TypeError);
	});

	it("rejects non-strict content", () => {
		expect(() =>
			buildEndoArtifactV0({ id: "endo.evidence.art-1", kind: "prompt", content: { score: Number.NaN } }),
		).toThrow(TypeError);
	});
});

describe("createEndoEvolutionCoreV0", () => {
	it("rejects a duplicate artifact id", () => {
		const core = createEndoEvolutionCoreV0();
		core.artifacts.add(validArtifact());
		expect(() => core.artifacts.add(validArtifact())).toThrow(TypeError);
	});

	it("rejects a duplicate mutation id", () => {
		const core = createEndoEvolutionCoreV0();
		core.artifacts.add(validArtifact());
		core.mutations.add(validMutation());
		expect(() => core.mutations.add(validMutation())).toThrow(TypeError);
	});

	it("rejects a duplicate candidate id", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		expect(() => core.candidates.add(validBaseCandidate())).toThrow(TypeError);
	});

	it("rejects a duplicate selection id", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		expect(() => core.selections.add(validDecision())).toThrow(TypeError);
	});

	it("rejects a duplicate promotion request id", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		core.promotionRequests.add(validRequest());
		expect(() => core.promotionRequests.add(validRequest())).toThrow(TypeError);
	});

	it("rejects a duplicate promotion decision id", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		core.promotionRequests.add(validRequest());
		core.promotionDecisions.add(validPromotionDecision());
		expect(() => core.promotionDecisions.add(validPromotionDecision())).toThrow(TypeError);
	});

	it("keeps registries queryable", () => {
		const core = createEndoEvolutionCoreV0();
		expect(core.candidates.get("endo.candidate.c-0")).toBeNull();
		expect(core.candidates.has("endo.candidate.c-0")).toBe(false);
		core.candidates.add(validBaseCandidate());
		expect(core.candidates.get("endo.candidate.c-0")).toEqual(validBaseCandidate());
		expect(core.candidates.has("endo.candidate.c-0")).toBe(true);
	});

	it("sorts lists by id", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add({ ...validBaseCandidate(), id: "endo.candidate.c-z" });
		core.candidates.add({ ...validBaseCandidate(), id: "endo.candidate.c-a" });
		expect(core.candidates.list().map((c) => c.id)).toEqual(["endo.candidate.c-a", "endo.candidate.c-z"]);
	});

	it("requires a registered parent distinct from the candidate", () => {
		const core = createEndoEvolutionCoreV0();
		expect(() => core.candidates.add(validCandidate())).toThrow(TypeError);
		expect(() => core.candidates.add({ ...validCandidate(), parentCandidateId: "endo.candidate.c-1" })).toThrow(
			TypeError,
		);
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		expect(core.candidates.has("endo.candidate.c-1")).toBe(true);
	});

	it("requires every named mutation to be registered exactly once", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		const noMutation = { ...validCandidate(), mutations: ["endo.evidence.mut-9"] };
		expect(() => core.candidates.add(noMutation)).toThrow(TypeError);
		core.mutations.add(validMutation());
		core.candidates.add({ ...validCandidate(), mutations: ["endo.evidence.mut-1"] });
		const duplicateMutations = {
			...validCandidate(),
			id: "endo.candidate.c-2",
			mutations: ["endo.evidence.mut-1", "endo.evidence.mut-1"],
		};
		expect(() => core.candidates.add(duplicateMutations)).toThrow(TypeError);
	});

	it("keeps a base candidate addressable after its descendants", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		expect(core.candidates.get("endo.candidate.c-0")).toEqual(validBaseCandidate());
		expect(core.candidates.list()).toHaveLength(2);
	});

	it("requires a registered candidate when a selection names one", () => {
		const core = createEndoEvolutionCoreV0();
		expect(() => core.selections.add(validDecision())).toThrow(TypeError);
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		expect(core.selections.has("endo.evidence.sel-1")).toBe(true);
	});

	it("accepts a non-selected decision without a candidate", () => {
		const core = createEndoEvolutionCoreV0();
		core.selections.add(validDecision("rejected"));
		expect(core.selections.has("endo.evidence.sel-1")).toBe(true);
	});

	it("requires a registered selection outcome of selected for a request", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		expect(() => core.promotionRequests.add(validRequest())).toThrow(TypeError);
		core.selections.add(validDecision("rejected"));
		expect(() => core.promotionRequests.add(validRequest())).toThrow(TypeError);
	});

	it("rejects a request naming a different candidate than its selection", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		expect(() => core.promotionRequests.add({ ...validRequest(), candidateId: "endo.candidate.c-9" })).toThrow(
			TypeError,
		);
	});

	it("rejects a request naming a different experiment than its selection", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		expect(() => core.promotionRequests.add({ ...validRequest(), experimentId: "endo.experiment.exp-2" })).toThrow(
			TypeError,
		);
	});

	it("requires a registered request matching experiment and candidate", () => {
		const core = createEndoEvolutionCoreV0();
		core.candidates.add(validBaseCandidate());
		core.candidates.add(validCandidate());
		core.selections.add(validDecision());
		core.promotionRequests.add(validRequest());
		expect(() => core.promotionDecisions.add(validPromotionDecision())).not.toThrow();
		expect(() =>
			core.promotionDecisions.add({
				...validPromotionDecision(),
				id: "endo.evidence.prom-2",
				experimentId: "endo.experiment.exp-2",
			}),
		).toThrow(TypeError);
		expect(() =>
			core.promotionDecisions.add({
				...validPromotionDecision(),
				id: "endo.evidence.prom-3",
				candidateId: "endo.candidate.c-9",
			}),
		).toThrow(TypeError);
	});
});
