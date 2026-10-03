// Phase 12 — historical immutability of every append-only registry: the event store, the six
// evolution registries, the evidence ledger, the graph store (including the revision log), and
// the experiment lifecycle. Each registry stores the deep-frozen copy of an admitted record, so
// later mutation of the caller's object never moves stored history; and mutating a returned
// reference throws a TypeError in strict mode instead of silently rewriting the record the
// digests, sequences, and provenance chains point at.

import { describe, expect, it } from "vitest";
import { createEndoEvolutionCoreV0 } from "../evolution/core.ts";
import { createEndoEvidenceLedgerV0 } from "../evolution/evidence.ts";
import { createEndoExperimentLifecycleV0 } from "../evolution/experiment.ts";
import { createEndoGraphStoreV0 } from "../graph/store.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type {
	EndoArtifactV0,
	EndoCandidateV0,
	EndoExperimentRecordV0,
	EndoMutationV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";
import type { EndoObjectV0 } from "../protocol/object.ts";
import { createEndoEventStoreV0 } from "../runtime/contracts/event-store.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

/** An independent deep copy of strict-JSON data. */
function snapshotV0<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Asserts the value is frozen at every reachable level. */
function expectDeepFrozenV0(value: unknown): void {
	expect(Object.isFrozen(value)).toBe(true);
	if (typeof value !== "object" || value === null) return;
	for (const entry of Object.values(value as Record<string, unknown>)) expectDeepFrozenV0(entry);
}

function eventV0(id: string): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id,
		kind: "tool.completed",
		source: "runtime-fact",
		sequence: 1,
		at: "2026-10-02T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1", runId: "endo.run.r1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: { lane: "main", depth: { level: 2 } },
	};
}

describe("event store immutability", () => {
	it("a caller mutation after ingest does not rewrite the stored stream", () => {
		const store = createEndoEventStoreV0();
		const value = eventV0("endo.event.imm-1");
		const pristine = snapshotV0(value);
		store.ingest(value);
		value.payload = { tampered: true };
		value.coordinates.sessionId = "endo.session.tampered";
		expect(store.page().events).toEqual([pristine]);
		expect(Object.isFrozen(value)).toBe(false);
	});

	it("stores a deep-frozen copy distinct from the caller's object", () => {
		const store = createEndoEventStoreV0();
		const stored = store.ingest(eventV0("endo.event.imm-2"));
		expect(stored).not.toBe(eventV0("endo.event.imm-2"));
		expectDeepFrozenV0(stored);
		expectDeepFrozenV0(store.page().events[0]);
	});

	it("mutating a returned event throws a TypeError", () => {
		const store = createEndoEventStoreV0();
		const stored = store.ingest(eventV0("endo.event.imm-3"));
		expect(() => {
			stored.coordinates.sessionId = "endo.session.tampered";
		}).toThrow(TypeError);
		const payload = stored.payload as Record<string, unknown>;
		expect(() => {
			payload.tampered = true;
		}).toThrow(TypeError);
	});
});

describe("evolution core immutability", () => {
	it("every registry stores a deep-frozen copy that outlives caller mutation", () => {
		const core = createEndoEvolutionCoreV0();

		const mutation: EndoMutationV0 = {
			schemaVersion: "endo.mutation.v0",
			id: "endo.evidence.mut-1",
			component: "prompt",
			operation: "replace",
			costDelta: { tokens: 10, nested: { extra: 1 } },
		};
		const mutationPristine = snapshotV0(mutation);
		const storedMutation = core.mutations.add(mutation);
		mutation.hypothesis = "tampered";
		const callerDelta = mutation.costDelta as Record<string, unknown>;
		callerDelta.tampered = true;
		expect(core.mutations.get("endo.evidence.mut-1")).toEqual(mutationPristine);
		expect(core.mutations.get("endo.evidence.mut-1")).not.toBe(mutation);
		expectDeepFrozenV0(storedMutation);
		const storedDelta = storedMutation.costDelta as Record<string, unknown>;
		expect(() => {
			storedDelta.tampered = true;
		}).toThrow(TypeError);

		const artifact: EndoArtifactV0 = {
			schemaVersion: "endo.artifact.v0",
			id: "endo.evidence.art-1",
			kind: "prompt",
			digest: DIGEST,
			content: { system: "Be concise.", tone: { level: "direct" } },
		};
		const artifactPristine = snapshotV0(artifact);
		const storedArtifact = core.artifacts.add(artifact);
		artifact.content = { tampered: true };
		expect(core.artifacts.get("endo.evidence.art-1")).toEqual(artifactPristine);
		expectDeepFrozenV0(storedArtifact);
		const storedContent = storedArtifact.content as Record<string, unknown>;
		expect(() => {
			storedContent.tampered = true;
		}).toThrow(TypeError);

		core.candidates.add({ schemaVersion: "endo.candidate.v0", id: "endo.candidate.c-0", mutations: [] });
		const candidate: EndoCandidateV0 = {
			schemaVersion: "endo.candidate.v0",
			id: "endo.candidate.c-1",
			parentCandidateId: "endo.candidate.c-0",
			artifactId: "endo.evidence.art-1",
			mutations: ["endo.evidence.mut-1"],
			hypothesis: "sharper prompt",
		};
		const candidatePristine = snapshotV0(candidate);
		const storedCandidate = core.candidates.add(candidate);
		candidate.mutations.push("endo.evidence.mut-ghost");
		expect(core.candidates.get("endo.candidate.c-1")).toEqual(candidatePristine);
		expectDeepFrozenV0(storedCandidate);
		expect(() => {
			storedCandidate.mutations.push("endo.evidence.mut-ghost");
		}).toThrow(TypeError);

		const selection: EndoSelectionDecisionV0 = {
			schemaVersion: "endo.selection-decision.v0",
			id: "endo.evidence.sel-1",
			experimentId: "endo.experiment.exp-1",
			policy: { schemaVersion: "endo.selection-policy.v0", name: "highest-score" },
			outcome: "selected",
			candidateId: "endo.candidate.c-1",
			conditions: [{ schemaVersion: "endo.selection-condition.v0", name: "mean-score-above-floor", met: true }],
			evidence: ["endo.evidence.res-1"],
		};
		const selectionPristine = snapshotV0(selection);
		const storedSelection = core.selections.add(selection);
		selection.evidence.push("endo.evidence.res-tampered");
		expect(core.selections.get("endo.evidence.sel-1")).toEqual(selectionPristine);
		expectDeepFrozenV0(storedSelection);
		expect(() => {
			storedSelection.evidence.push("endo.evidence.res-tampered");
		}).toThrow(TypeError);

		const request: EndoPromotionRequestV0 = {
			schemaVersion: "endo.promotion-request.v0",
			id: "endo.evidence.req-1",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c-1",
			selectionId: "endo.evidence.sel-1",
		};
		const requestPristine = snapshotV0(request);
		const storedRequest = core.promotionRequests.add(request);
		request.candidateId = "endo.candidate.c-tampered";
		expect(core.promotionRequests.get("endo.evidence.req-1")).toEqual(requestPristine);
		expectDeepFrozenV0(storedRequest);
		expect(() => {
			storedRequest.selectionId = "endo.evidence.sel-tampered";
		}).toThrow(TypeError);

		const decision: EndoPromotionDecisionV0 = {
			schemaVersion: "endo.promotion-decision.v0",
			id: "endo.evidence.prom-1",
			requestId: "endo.evidence.req-1",
			experimentId: "endo.experiment.exp-1",
			candidateId: "endo.candidate.c-1",
			outcome: "granted",
			authority: "ops-a",
			evidence: ["endo.evidence.res-1"],
		};
		const decisionPristine = snapshotV0(decision);
		const storedDecision = core.promotionDecisions.add(decision);
		decision.evidence = [];
		expect(core.promotionDecisions.get("endo.evidence.prom-1")).toEqual(decisionPristine);
		expectDeepFrozenV0(storedDecision);
		expect(() => {
			storedDecision.outcome = "denied";
		}).toThrow(TypeError);
	});
});

describe("evidence ledger immutability", () => {
	it("stores the experiment record as a deep-frozen copy and freezes every appended entry", () => {
		const experiment: EndoExperimentRecordV0 = {
			schemaVersion: "endo.experiment.v0",
			id: "endo.experiment.exp-1",
			budget: { turns: 2, cap: { tokens: 100 } },
		};
		const experimentPristine = snapshotV0(experiment);
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-imm", experiment);
		const callerBudget = experiment.budget as Record<string, unknown>;
		callerBudget.tampered = true;
		expect(ledger.record).toEqual(experimentPristine);
		expect(ledger.record).not.toBe(experiment);
		expectDeepFrozenV0(ledger.record);
		const storedBudget = ledger.record.budget as Record<string, unknown>;
		expect(() => {
			storedBudget.tampered = true;
		}).toThrow(TypeError);

		const mutation: EndoMutationV0 = {
			schemaVersion: "endo.mutation.v0",
			id: "endo.evidence.mut-1",
			component: "prompt",
			operation: "replace",
		};
		const entry = ledger.append(mutation);
		mutation.hypothesis = "tampered";
		expect(ledger.ledger().entries).toEqual([
			{
				schemaVersion: "endo.evidence-ledger-entry.v0",
				sequence: 1,
				kind: "mutation",
				recordId: "endo.evidence.mut-1",
			},
		]);
		expectDeepFrozenV0(entry);
		expect(() => {
			entry.kind = "artifact";
		}).toThrow(TypeError);
	});
});

describe("graph store immutability", () => {
	it("stores objects and edges as deep-frozen copies, including the revision log", () => {
		const store = createEndoGraphStoreV0();
		const value: EndoObjectV0 = {
			schemaVersion: "endo.object.v0",
			id: "endo.node.session-1",
			kind: "session",
			payload: { lane: "main" },
			observedIn: "endo.event.session.started",
		};
		const valuePristine = snapshotV0(value);
		const stored = store.upsertObject(value);
		value.payload = { tampered: true };
		expect(store.getObject("endo.node.session-1")).toEqual(valuePristine);
		expect(store.getObject("endo.node.session-1")).not.toBe(value);
		expectDeepFrozenV0(stored);
		expectDeepFrozenV0(store.log()[0]);
		const storedPayload = stored.payload as Record<string, unknown>;
		expect(() => {
			storedPayload.tampered = true;
		}).toThrow(TypeError);

		const edge = {
			schemaVersion: "endo.edge.v0",
			id: "endo.edge.e1",
			source: "endo.node.session-1",
			target: "endo.node.run-1",
			relation: "derived-from",
			observedIn: "endo.event.session.started",
		};
		const storedEdge = store.upsertEdge(edge);
		edge.relation = "related-to";
		expect(store.getEdge("endo.edge.e1")).toEqual(snapshotV0({ ...edge, relation: "derived-from" }));
		expectDeepFrozenV0(storedEdge);
		expect(() => {
			storedEdge.relation = "tampered";
		}).toThrow(TypeError);
	});
});

describe("experiment lifecycle immutability", () => {
	it("freezes the record and every recorded transition", () => {
		const record: EndoExperimentRecordV0 = {
			schemaVersion: "endo.experiment.v0",
			id: "endo.experiment.exp-1",
			budget: { turns: 2, cap: { tokens: 100 } },
		};
		const recordPristine = snapshotV0(record);
		const lifecycle = createEndoExperimentLifecycleV0(record);
		const callerBudget = record.budget as Record<string, unknown>;
		callerBudget.tampered = true;
		expect(lifecycle.record).toEqual(recordPristine);
		expect(lifecycle.record).not.toBe(record);
		expectDeepFrozenV0(lifecycle.record);

		const storedTransition = lifecycle.transition({ id: "endo.evidence.tr-1", to: "prepared" });
		expect(lifecycle.transitions).toEqual([storedTransition]);
		expect(lifecycle.transitions[0]).toBe(storedTransition);
		expectDeepFrozenV0(storedTransition);
		expect(() => {
			storedTransition.reason = "tampered";
		}).toThrow(TypeError);
		expect(() => {
			storedTransition.to = "running";
		}).toThrow(TypeError);
	});
});
