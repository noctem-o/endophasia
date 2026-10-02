import { describe, expect, it } from "vitest";
import { buildEndoArtifactV0, createEndoEvidenceLedgerV0, replayEndoEvidenceLedgerV0 } from "../evolution/index.ts";
import type { EndoEvaluationProfileV0, EndoEvaluationResultV0, EndoTrialResultV0 } from "../protocol/evaluation.ts";
import type {
	EndoExperimentRecordV0,
	EndoPromotionDecisionV0,
	EndoPromotionRequestV0,
	EndoSelectionDecisionV0,
} from "../protocol/evolution.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function experimentRecord(): EndoExperimentRecordV0 {
	return { schemaVersion: "endo.experiment.v0", id: "endo.experiment.exp-1", evaluator: "eval-1", grader: "grade-1" };
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
		trialCount: 2,
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
		derived: { score: 0.5 + i * 0.1 },
	});
	return {
		schemaVersion: "endo.evaluation-result.v0",
		id: "endo.evidence.res-1",
		profile,
		trials: [trial(0), trial(1)],
		resultBundleDigest: DIGEST,
		selectionPolicy: "policy-p",
		promotionState: "candidate",
	};
}

function selection(): EndoSelectionDecisionV0 {
	return {
		schemaVersion: "endo.selection-decision.v0",
		id: "endo.evidence.sel-1",
		experimentId: "endo.experiment.exp-1",
		policy: { schemaVersion: "endo.selection-policy.v0", name: "highest-score" },
		outcome: "selected",
		candidateId: "endo.candidate.c-1",
		conditions: [{ schemaVersion: "endo.selection-condition.v0", name: "mean-score-above-floor", met: true }],
		evidence: ["endo.evidence.res-1"],
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

function promotionDecision(): EndoPromotionDecisionV0 {
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

function witnessRecord() {
	return {
		schemaVersion: "endo.witness.v0",
		id: "endo.evidence.wit-1",
		runId: "endo.run.r0",
		witnessRoot: DIGEST,
		witnessAlgorithm: "blake3",
		verification: "recomputed-matched",
	};
}

function standingRecord(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "endo.standing.v0",
		id: "endo.evidence.stand-1",
		claimId: "magpie-claim-7",
		policy: "v2",
		standing: "supported",
		evidence: ["endo.evidence.res-1"],
		qualifications: [],
		...overrides,
	};
}

function leaseRecord(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "endo.lease.v0",
		id: "endo.evidence.lease-1",
		route: "promotion.apply",
		capability: "apply the promoted candidate",
		boundTo: "endo.evidence.prom-1",
		signer: "ops-a",
		leaseDigest: DIGEST,
		...overrides,
	};
}

function receiptRecord(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: "endo.receipt.v0",
		id: "endo.evidence.rcpt-1",
		leaseId: "endo.evidence.lease-1",
		route: "promotion.apply",
		outcome: "committed",
		...overrides,
	};
}

describe("the trust records in the evidence ledger", () => {
	it("derives the ledger kind for every trust schema version", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(evaluationResult());
		const witnessEntry = ledger.append(witnessRecord());
		expect(witnessEntry.sequence).toBe(2);
		expect(witnessEntry.kind).toBe("witness");
		expect(witnessEntry.recordId).toBe("endo.evidence.wit-1");
		const standingEntry = ledger.append(standingRecord());
		expect(standingEntry.kind).toBe("standing");
		expect(standingEntry.recordId).toBe("endo.evidence.stand-1");
		ledger.append(selection());
		ledger.append(promotionRequest());
		ledger.append(promotionDecision());
		const leaseEntry = ledger.append(leaseRecord());
		expect(leaseEntry.kind).toBe("lease");
		expect(leaseEntry.recordId).toBe("endo.evidence.lease-1");
		const receiptEntry = ledger.append(receiptRecord());
		expect(receiptEntry.kind).toBe("receipt");
		expect(receiptEntry.recordId).toBe("endo.evidence.rcpt-1");
		expect(ledger.length).toBe(8);
	});

	it("appends a witness first, since it references no ledger record", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const entry = ledger.append(witnessRecord());
		expect(entry.sequence).toBe(1);
	});

	it("rejects a standing that cites evidence not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(standingRecord({ evidence: ["endo.evidence.res-9"] }))).toThrow(TypeError);
	});

	it("rejects a lease that binds a record not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(leaseRecord({ boundTo: "endo.evidence.prom-9" }))).toThrow(TypeError);
	});

	it("rejects a receipt that cites a lease not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		expect(() => ledger.append(receiptRecord())).toThrow(TypeError);
	});

	it("rejects a rollback receipt that supersedes a receipt not yet appended", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(evaluationResult());
		ledger.append(selection());
		ledger.append(promotionRequest());
		ledger.append(promotionDecision());
		ledger.append(leaseRecord());
		ledger.append(receiptRecord({ id: "endo.evidence.rcpt-0" }));
		expect(() =>
			ledger.append(
				receiptRecord({
					id: "endo.evidence.rcpt-1",
					outcome: "rolled-back",
					rollbackOf: "endo.evidence.rcpt-9",
				}),
			),
		).toThrow(TypeError);
	});

	it("rejects a duplicate record id", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(witnessRecord());
		expect(() => ledger.append(witnessRecord())).toThrow(TypeError);
	});

	it("replays a ledger carrying the full trust chain", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(evaluationResult());
		ledger.append(witnessRecord());
		ledger.append(standingRecord());
		ledger.append(selection());
		ledger.append(promotionRequest());
		ledger.append(promotionDecision());
		ledger.append(leaseRecord());
		ledger.append(receiptRecord());
		const persisted = ledger.ledger();
		expect(persisted.entries).toHaveLength(8);
		expect(replayEndoEvidenceLedgerV0(persisted)).toEqual(persisted);
	});
	it("builds a content-addressed identity for an id-less conformance suite before trust records", () => {
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		const entry = ledger.append({
			schemaVersion: "endo.conformance-suite.v0",
			subject: "prime",
			version: "0.9.7",
			studies: [
				{
					schemaVersion: "endo.conformance-study.v0",
					subject: "prime",
					version: "0.9.7",
					scenario: "s-1",
					decoder: "pi",
					predicate: "the run replays",
					expected: "the replay matches",
					observed: "the replay matched",
					classification: "EXACT",
					evidence: [],
					limitations: [],
				},
			],
		});
		expect(entry.recordId.startsWith("endo.evidence.")).toBe(true);
		expect(ledger.append(witnessRecord()).sequence).toBe(2);
		expect(ledger.append(standingRecord({ evidence: [] })).sequence).toBe(3);
		expect(ledger.append(receiptRecord({ leaseId: entry.recordId })).sequence).toBe(4);
	});

	it("keeps the trust records reachable from the artifact builder", () => {
		const artifact = buildEndoArtifactV0({
			id: "endo.evidence.art-1",
			kind: "prompt",
			content: { system: "Be concise." },
		});
		expect(artifact.id).toBe("endo.evidence.art-1");
		const ledger = createEndoEvidenceLedgerV0("endo.evidence.ledger-1", experimentRecord());
		ledger.append(artifact);
		ledger.append(witnessRecord());
		expect(ledger.length).toBe(2);
	});
});
