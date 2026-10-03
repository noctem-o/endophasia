import { describe, expect, it } from "vitest";
import type {
	EndoLeaseRecordV0,
	EndoPromotionClosureV0,
	EndoReceiptRecordV0,
	EndoStandingRecordV0,
	EndoWitnessCoverageV0,
	EndoWitnessRecordV0,
} from "../protocol/trust.ts";
import {
	ENDO_CLOSURE_DECISION_GRANTED_V0,
	ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0,
	ENDO_CLOSURE_LEASE_BINDS_DECISION_V0,
	ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0,
	ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0,
	ENDO_PROMOTION_CLOSURE_CONDITIONS_V0,
	ENDO_STANDING_CEILING_V0,
	validateEndoLeaseRecordV0,
	validateEndoPromotionClosureV0,
	validateEndoReceiptRecordV0,
	validateEndoStandingRecordV0,
	validateEndoWitnessCoverageV0,
	validateEndoWitnessRecordV0,
} from "../protocol/trust.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function witness(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.witness.v0",
		id: "endo.evidence.wit-1",
		runId: "endo.run.r-1",
		witnessRoot: DIGEST,
		witnessAlgorithm: "blake3",
		verification: "recomputed-matched",
		...overrides,
	};
}

function standing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.receipt.v0",
		id: "endo.evidence.rcpt-1",
		leaseId: "endo.evidence.lease-1",
		route: "promotion.apply",
		outcome: "committed",
		...overrides,
	};
}

function coverage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.witness-coverage.v0",
		experimentId: "endo.experiment.exp-1",
		trials: [
			{
				schemaVersion: "endo.witness-coverage-trial.v0",
				trial: 0,
				runId: "endo.run.r-1",
				witnessId: "endo.evidence.wit-1",
			},
			{ schemaVersion: "endo.witness-coverage-trial.v0", trial: 1, runId: null, witnessId: null },
		],
		...overrides,
	};
}

function closure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.promotion-closure.v0",
		decisionId: "endo.evidence.prom-1",
		closed: true,
		unmet: [],
		outcome: "committed",
		...overrides,
	};
}

describe("validateEndoWitnessRecordV0", () => {
	it("accepts the record and returns it unchanged", () => {
		expect(validateEndoWitnessRecordV0(witness())).toEqual(witness());
	});

	it("accepts an honest absence of the policy digest and provenance", () => {
		expect(validateEndoWitnessRecordV0(witness({ verification: "not-verified" }))).not.toBeNull();
	});

	it("accepts expectedRoot on externally-confirmed and recomputed-mismatched only", () => {
		expect(
			validateEndoWitnessRecordV0(witness({ verification: "externally-confirmed", expectedRoot: DIGEST })),
		).not.toBeNull();
		expect(
			validateEndoWitnessRecordV0(witness({ verification: "recomputed-mismatched", expectedRoot: DIGEST })),
		).not.toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ verification: "not-verified", expectedRoot: DIGEST }))).toBeNull();
		expect(
			validateEndoWitnessRecordV0(witness({ verification: "recomputed-matched", expectedRoot: DIGEST })),
		).toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ verification: "externally-confirmed" }))).toBeNull();
	});

	it("rejects a schema version outside the closed set", () => {
		expect(validateEndoWitnessRecordV0(witness({ schemaVersion: "endo.witness.v1" }))).toBeNull();
	});

	it("rejects a record id outside the evidence namespace", () => {
		expect(validateEndoWitnessRecordV0(witness({ id: "endo.model.wit-1" }))).toBeNull();
	});

	it("rejects a run id outside the run namespace", () => {
		expect(validateEndoWitnessRecordV0(witness({ runId: "endo.evidence.r-1" }))).toBeNull();
	});

	it("rejects a witness root that is not 64 lowercase hex", () => {
		expect(validateEndoWitnessRecordV0(witness({ witnessRoot: DIGEST.slice(0, 63) }))).toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ witnessRoot: `${DIGEST}a` }))).toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ witnessRoot: DIGEST.toUpperCase() }))).toBeNull();
	});

	it("rejects a witness algorithm outside the closed set", () => {
		expect(validateEndoWitnessRecordV0(witness({ witnessAlgorithm: "sha256" }))).toBeNull();
	});

	it("rejects a verification state outside the closed set", () => {
		expect(validateEndoWitnessRecordV0(witness({ verification: "verified" }))).toBeNull();
	});

	it("rejects an optional digest or provenance outside its grammar", () => {
		expect(validateEndoWitnessRecordV0(witness({ policyDigest: DIGEST.slice(0, 63) }))).toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ provenance: "" }))).toBeNull();
		expect(validateEndoWitnessRecordV0(witness({ provenance: "x".repeat(4097) }))).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoWitnessRecordV0(witness({ surprise: 1 }))).toBeNull();
	});
});

describe("validateEndoStandingRecordV0", () => {
	it("accepts the record and returns it unchanged", () => {
		expect(validateEndoStandingRecordV0(standing())).toEqual(standing());
	});

	it("accepts an empty evidence list", () => {
		expect(validateEndoStandingRecordV0(standing({ evidence: [] }))).not.toBeNull();
	});

	it("accepts the full v4 ceiling and the v0 floor", () => {
		expect(validateEndoStandingRecordV0(standing({ policy: "v0", standing: "unassessed" }))).not.toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v4", standing: "refuted" }))).not.toBeNull();
	});

	it("enforces the standing ceiling of every policy", () => {
		expect(ENDO_STANDING_CEILING_V0.v0).toEqual(["unassessed"]);
		expect(ENDO_STANDING_CEILING_V0.v1).toEqual(["unassessed", "supported", "settled"]);
		expect(ENDO_STANDING_CEILING_V0.v2).toEqual(["unassessed", "supported"]);
		expect(ENDO_STANDING_CEILING_V0.v3).toEqual(["unassessed", "supported"]);
		expect(ENDO_STANDING_CEILING_V0.v4).toEqual(["unassessed", "supported", "settled", "refuted"]);
		expect(validateEndoStandingRecordV0(standing({ policy: "v0", standing: "supported" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v0", standing: "settled" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v1", standing: "refuted" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v2", standing: "settled" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v2", standing: "refuted" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v3", standing: "settled" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ policy: "v3", standing: "refuted" }))).toBeNull();
	});

	it("rejects a policy outside the closed set", () => {
		expect(validateEndoStandingRecordV0(standing({ policy: "v5" }))).toBeNull();
	});

	it("rejects a standing outside the closed set", () => {
		expect(validateEndoStandingRecordV0(standing({ standing: "contradicted" }))).toBeNull();
	});

	it("rejects an empty or over-long claim id", () => {
		expect(validateEndoStandingRecordV0(standing({ claimId: "" }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ claimId: "x".repeat(257) }))).toBeNull();
	});

	it("rejects evidence entries outside the evidence namespace", () => {
		expect(validateEndoStandingRecordV0(standing({ evidence: ["endo.model.res-1"] }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ evidence: "res-1" }))).toBeNull();
	});

	it("rejects over-long qualifications or provenance", () => {
		expect(validateEndoStandingRecordV0(standing({ qualifications: ["x".repeat(257)] }))).toBeNull();
		expect(validateEndoStandingRecordV0(standing({ provenance: "x".repeat(4097) }))).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoStandingRecordV0(standing({ surprise: 1 }))).toBeNull();
	});
});

describe("validateEndoLeaseRecordV0", () => {
	it("accepts the record and returns it unchanged", () => {
		expect(validateEndoLeaseRecordV0(lease())).toEqual(lease());
	});

	it("accepts an absent expiry", () => {
		expect(validateEndoLeaseRecordV0(lease({}))).not.toBeNull();
	});

	it("rejects a route outside the dotted-kind grammar", () => {
		expect(validateEndoLeaseRecordV0(lease({ route: "Promote.apply" }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ route: "a..b" }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ route: "a." }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ route: `a.${"b.".repeat(64)}x` }))).toBeNull();
	});

	it("rejects a binding outside the evidence namespace", () => {
		expect(validateEndoLeaseRecordV0(lease({ boundTo: "endo.model.prom-1" }))).toBeNull();
	});

	it("rejects capability, signer, expiry, or provenance outside their grammars", () => {
		expect(validateEndoLeaseRecordV0(lease({ capability: "" }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ capability: "x".repeat(257) }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ signer: "x".repeat(257) }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ expiresAt: "x".repeat(257) }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ provenance: "x".repeat(4097) }))).toBeNull();
	});

	it("rejects a lease digest that is not 64 lowercase hex", () => {
		expect(validateEndoLeaseRecordV0(lease({ leaseDigest: DIGEST.slice(0, 63) }))).toBeNull();
		expect(validateEndoLeaseRecordV0(lease({ leaseDigest: DIGEST.toUpperCase() }))).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoLeaseRecordV0(lease({ surprise: 1 }))).toBeNull();
	});
});

describe("validateEndoReceiptRecordV0", () => {
	it("accepts the record and returns it unchanged", () => {
		expect(validateEndoReceiptRecordV0(receipt())).toEqual(receipt());
	});

	it("accepts a rollback receipt with a strict JSON result", () => {
		expect(
			validateEndoReceiptRecordV0(
				receipt({
					outcome: "rolled-back",
					rollbackOf: "endo.evidence.rcpt-0",
					result: { steps: 2, note: "rolled back" },
				}),
			),
		).not.toBeNull();
	});

	it("accepts an absent result", () => {
		expect(validateEndoReceiptRecordV0(receipt({}))).not.toBeNull();
	});

	it("rejects an outcome outside the closed set", () => {
		expect(validateEndoReceiptRecordV0(receipt({ outcome: "aborted" }))).toBeNull();
	});

	it("rejects a lease id or rollback target outside the evidence namespace", () => {
		expect(validateEndoReceiptRecordV0(receipt({ leaseId: "endo.model.lease-1" }))).toBeNull();
		expect(validateEndoReceiptRecordV0(receipt({ rollbackOf: "endo.model.rcpt-0" }))).toBeNull();
	});

	it("rejects a route outside the dotted-kind grammar", () => {
		expect(validateEndoReceiptRecordV0(receipt({ route: "Promote" }))).toBeNull();
		expect(validateEndoReceiptRecordV0(receipt({ route: "" }))).toBeNull();
	});

	it("rejects a result that is not strict JSON", () => {
		expect(validateEndoReceiptRecordV0(receipt({ result: { a: undefined } }))).toBeNull();
		expect(validateEndoReceiptRecordV0(receipt({ result: { a: Number.POSITIVE_INFINITY } }))).toBeNull();
		expect(validateEndoReceiptRecordV0(receipt({ result: new Date() }))).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoReceiptRecordV0(receipt({ surprise: 1 }))).toBeNull();
	});
});

describe("validateEndoWitnessCoverageV0", () => {
	it("accepts the report and returns it unchanged", () => {
		expect(validateEndoWitnessCoverageV0(coverage())).toEqual(coverage());
	});

	it("accepts an empty trial list", () => {
		expect(validateEndoWitnessCoverageV0(coverage({ trials: [] }))).not.toBeNull();
	});

	it("rejects an experiment id outside the experiment namespace", () => {
		expect(validateEndoWitnessCoverageV0(coverage({ experimentId: "endo.model.exp-1" }))).toBeNull();
	});

	it("rejects a trial that is not a 0-based integer", () => {
		expect(
			validateEndoWitnessCoverageV0(
				coverage({
					trials: [{ schemaVersion: "endo.witness-coverage-trial.v0", trial: -1, runId: null, witnessId: null }],
				}),
			),
		).toBeNull();
		expect(
			validateEndoWitnessCoverageV0(
				coverage({
					trials: [{ schemaVersion: "endo.witness-coverage-trial.v0", trial: 1.5, runId: null, witnessId: null }],
				}),
			),
		).toBeNull();
	});

	it("rejects a trial identifier outside its namespace", () => {
		expect(
			validateEndoWitnessCoverageV0(
				coverage({
					trials: [
						{
							schemaVersion: "endo.witness-coverage-trial.v0",
							trial: 0,
							runId: "endo.model.r-1",
							witnessId: null,
						},
					],
				}),
			),
		).toBeNull();
		expect(
			validateEndoWitnessCoverageV0(
				coverage({
					trials: [
						{
							schemaVersion: "endo.witness-coverage-trial.v0",
							trial: 0,
							runId: null,
							witnessId: "endo.model.wit-1",
						},
					],
				}),
			),
		).toBeNull();
	});

	it("rejects a trial schema version outside the closed set", () => {
		expect(
			validateEndoWitnessCoverageV0(
				coverage({
					trials: [{ schemaVersion: "endo.witness-coverage-trial.v1", trial: 0, runId: null, witnessId: null }],
				}),
			),
		).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoWitnessCoverageV0(coverage({ surprise: 1 }))).toBeNull();
	});
});

describe("validateEndoPromotionClosureV0", () => {
	it("accepts a closed report with an empty unmet list", () => {
		expect(validateEndoPromotionClosureV0(closure())).toEqual(closure());
	});

	it("accepts an open report whose unmet names the missing conditions", () => {
		expect(
			validateEndoPromotionClosureV0(
				closure({
					closed: false,
					unmet: [ENDO_CLOSURE_LEASE_BINDS_DECISION_V0, ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0],
					outcome: "refused",
				}),
			),
		).not.toBeNull();
	});

	it("names the closed conditions in the fixed order", () => {
		expect(ENDO_PROMOTION_CLOSURE_CONDITIONS_V0).toEqual([
			ENDO_CLOSURE_DECISION_GRANTED_V0,
			ENDO_CLOSURE_DECISION_MATCHES_REQUEST_V0,
			ENDO_CLOSURE_LEASE_BINDS_DECISION_V0,
			ENDO_CLOSURE_RECEIPT_CLOSES_LEASE_V0,
			ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0,
		]);
	});

	it("rejects a closed flag that disagrees with the unmet list", () => {
		expect(validateEndoPromotionClosureV0(closure({ closed: true, unmet: ["lease-binds-decision"] }))).toBeNull();
		expect(validateEndoPromotionClosureV0(closure({ closed: false, unmet: [] }))).toBeNull();
	});

	it("rejects a decision id outside the evidence namespace", () => {
		expect(validateEndoPromotionClosureV0(closure({ decisionId: "endo.model.prom-1" }))).toBeNull();
	});

	it("rejects an outcome outside the closed set", () => {
		expect(validateEndoPromotionClosureV0(closure({ outcome: "aborted" }))).toBeNull();
	});

	it("rejects an unmet entry outside its grammar", () => {
		expect(validateEndoPromotionClosureV0(closure({ closed: false, unmet: [""] }))).toBeNull();
		expect(validateEndoPromotionClosureV0(closure({ closed: false, unmet: ["x".repeat(257)] }))).toBeNull();
	});

	it("rejects an unknown key", () => {
		expect(validateEndoPromotionClosureV0(closure({ surprise: 1 }))).toBeNull();
	});
});

describe("the trust records under canonical JSON", () => {
	it("round-trips every record and report shape", () => {
		const witnessRecord: EndoWitnessRecordV0 = {
			schemaVersion: "endo.witness.v0",
			id: "endo.evidence.wit-1",
			runId: "endo.run.r-1",
			witnessRoot: DIGEST,
			witnessAlgorithm: "blake3",
			verification: "externally-confirmed",
			policyDigest: DIGEST,
			expectedRoot: DIGEST,
			provenance: "bundle b-1, recomputed against the external root",
		};
		const standingRecord: EndoStandingRecordV0 = {
			schemaVersion: "endo.standing.v0",
			id: "endo.evidence.stand-1",
			claimId: "magpie-claim-7",
			policy: "v4",
			standing: "refuted",
			evidence: ["endo.evidence.res-1", "endo.evidence.sel-1"],
			qualifications: ["deterministic direct refutation, subject-bound"],
			provenance: "magpie replay kernel",
		};
		const leaseRecord: EndoLeaseRecordV0 = {
			schemaVersion: "endo.lease.v0",
			id: "endo.evidence.lease-1",
			route: "promotion.apply",
			capability: "apply the promoted candidate",
			boundTo: "endo.evidence.prom-1",
			signer: "ops-a",
			leaseDigest: DIGEST,
			expiresAt: "2026-12-01T00:00:00Z",
			provenance: "signed by the promotion authority",
		};
		const receiptRecord: EndoReceiptRecordV0 = {
			schemaVersion: "endo.receipt.v0",
			id: "endo.evidence.rcpt-1",
			leaseId: "endo.evidence.lease-1",
			route: "promotion.apply",
			outcome: "committed",
			result: { steps: 3, note: "committed" },
			provenance: "adapter operation log",
		};
		const coverageReport: EndoWitnessCoverageV0 = {
			schemaVersion: "endo.witness-coverage.v0",
			experimentId: "endo.experiment.exp-1",
			trials: [
				{
					schemaVersion: "endo.witness-coverage-trial.v0",
					trial: 0,
					runId: "endo.run.r-1",
					witnessId: "endo.evidence.wit-1",
				},
				{ schemaVersion: "endo.witness-coverage-trial.v0", trial: 1, runId: null, witnessId: null },
			],
		};
		const closureReport: EndoPromotionClosureV0 = {
			schemaVersion: "endo.promotion-closure.v0",
			decisionId: "endo.evidence.prom-1",
			closed: false,
			unmet: [ENDO_CLOSURE_RECEIPT_ROUTE_MATCHES_V0],
			outcome: "rolled-back",
		};
		for (const record of [witnessRecord, standingRecord, leaseRecord, receiptRecord, coverageReport, closureReport]) {
			expect(JSON.parse(canonicalEndoJsonV0(record))).toEqual(record);
		}
	});
});
