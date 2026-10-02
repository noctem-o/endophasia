import { describe, expect, it } from "vitest";
import { mapCogitatorWitnessV0 } from "../adapters/cogitator/mapping.ts";
import type { CogitatorWitnessInputV0 } from "../adapters/cogitator/shapes.ts";
import { mapDeadboltLeaseV0, mapDeadboltReceiptV0 } from "../adapters/deadbolt/mapping.ts";
import type { DeadboltLeaseInputV0, DeadboltReceiptInputV0 } from "../adapters/deadbolt/shapes.ts";
import { mapMagpieStandingV0 } from "../adapters/magpie/mapping.ts";
import type { MagpieStandingInputV0 } from "../adapters/magpie/shapes.ts";
import {
	validateEndoLeaseRecordV0,
	validateEndoReceiptRecordV0,
	validateEndoStandingRecordV0,
	validateEndoWitnessRecordV0,
} from "../protocol/trust.ts";

const DIGEST = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const OTHER_DIGEST = "0f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function witnessInput(overrides: Partial<CogitatorWitnessInputV0> = {}): CogitatorWitnessInputV0 {
	return { runId: "endo.run.r-1", witnessRoot: DIGEST, ...overrides };
}

function standingInput(overrides: Partial<MagpieStandingInputV0> = {}): MagpieStandingInputV0 {
	return {
		claimId: "magpie-claim-7",
		policy: "v2",
		standing: "supported",
		evidence: ["endo.evidence.res-1"],
		...overrides,
	};
}

function leaseInput(overrides: Partial<DeadboltLeaseInputV0> = {}): DeadboltLeaseInputV0 {
	return {
		route: "promotion.apply",
		capability: "apply the promoted candidate",
		boundTo: "endo.evidence.prom-1",
		signer: "ops-a",
		leaseDigest: DIGEST,
		...overrides,
	};
}

function receiptInput(overrides: Partial<DeadboltReceiptInputV0> = {}): DeadboltReceiptInputV0 {
	return { leaseId: "endo.evidence.lease-1", route: "promotion.apply", outcome: "committed", ...overrides };
}

describe("mapCogitatorWitnessV0", () => {
	it("maps a full bundle to a protocol-bound witness record", () => {
		const record = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-1",
			input: witnessInput({
				witnessAlgorithm: "blake3",
				policyDigest: DIGEST,
				recomputedRoot: DIGEST,
				expectedRoot: DIGEST,
				provenance: "bundle b-1",
			}),
		});
		expect(record).toEqual({
			schemaVersion: "endo.witness.v0",
			id: "endo.evidence.wit-1",
			runId: "endo.run.r-1",
			witnessRoot: DIGEST,
			witnessAlgorithm: "blake3",
			verification: "externally-confirmed",
			policyDigest: DIGEST,
			expectedRoot: DIGEST,
			provenance: "bundle b-1",
		});
		expect(validateEndoWitnessRecordV0(record)).toEqual(record);
	});

	it("derives the verification state across the derivation matrix", () => {
		expect(mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput() }).verification).toBe(
			"not-verified",
		);
		expect(
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ recomputedRoot: DIGEST }) })
				.verification,
		).toBe("recomputed-matched");
		expect(
			mapCogitatorWitnessV0({
				id: "endo.evidence.wit-1",
				input: witnessInput({ recomputedRoot: DIGEST, expectedRoot: DIGEST }),
			}).verification,
		).toBe("externally-confirmed");
		expect(
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ recomputedRoot: OTHER_DIGEST }) })
				.verification,
		).toBe("recomputed-mismatched");
		const externalMismatch = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-1",
			input: witnessInput({ recomputedRoot: DIGEST, expectedRoot: OTHER_DIGEST }),
		});
		expect(externalMismatch.verification).toBe("recomputed-mismatched");
		expect(externalMismatch.expectedRoot).toBe(OTHER_DIGEST);
	});

	it("keeps the expected root honestly recorded on an external mismatch", () => {
		const record = mapCogitatorWitnessV0({
			id: "endo.evidence.wit-1",
			input: witnessInput({ recomputedRoot: DIGEST, expectedRoot: OTHER_DIGEST }),
		});
		expect(record.expectedRoot).toBe(OTHER_DIGEST);
		expect(validateEndoWitnessRecordV0(record)).toEqual(record);
	});

	it("rejects a record id outside the evidence namespace", () => {
		expect(() => mapCogitatorWitnessV0({ id: "endo.model.wit-1", input: witnessInput() })).toThrow(TypeError);
	});

	it("rejects a run id outside the run namespace", () => {
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ runId: "endo.evidence.r-1" }) }),
		).toThrow(TypeError);
	});

	it("rejects a witness root that is not 64 lowercase hex", () => {
		expect(() =>
			mapCogitatorWitnessV0({
				id: "endo.evidence.wit-1",
				input: witnessInput({ witnessRoot: DIGEST.slice(0, 63) }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapCogitatorWitnessV0({
				id: "endo.evidence.wit-1",
				input: witnessInput({ witnessRoot: DIGEST.toUpperCase() }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ witnessRoot: undefined }) }),
		).toThrow(TypeError);
	});

	it("rejects a witness algorithm other than blake3", () => {
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ witnessAlgorithm: "sha256" }) }),
		).toThrow(TypeError);
	});

	it("rejects an optional digest outside the hex64 grammar", () => {
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ policyDigest: "nope" }) }),
		).toThrow(TypeError);
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ recomputedRoot: "x".repeat(64) }) }),
		).toThrow(TypeError);
		expect(() =>
			mapCogitatorWitnessV0({
				id: "endo.evidence.wit-1",
				input: witnessInput({ expectedRoot: DIGEST.slice(0, 65) }),
			}),
		).toThrow(TypeError);
	});

	it("rejects an over-long provenance note", () => {
		expect(() =>
			mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: witnessInput({ provenance: "x".repeat(4097) }) }),
		).toThrow(TypeError);
	});

	it("rejects a non-object input", () => {
		expect(() => mapCogitatorWitnessV0({ id: "endo.evidence.wit-1", input: null })).toThrow(TypeError);
	});
});

describe("mapMagpieStandingV0", () => {
	it("maps a standing to a protocol-bound record", () => {
		const record = mapMagpieStandingV0({
			id: "endo.evidence.stand-1",
			input: standingInput({ qualifications: ["deterministic direct support"], provenance: "magpie replay" }),
		});
		expect(record).toEqual({
			schemaVersion: "endo.standing.v0",
			id: "endo.evidence.stand-1",
			claimId: "magpie-claim-7",
			policy: "v2",
			standing: "supported",
			evidence: ["endo.evidence.res-1"],
			qualifications: ["deterministic direct support"],
			provenance: "magpie replay",
		});
		expect(validateEndoStandingRecordV0(record)).toEqual(record);
	});

	it("defaults empty qualifications to an empty list", () => {
		expect(mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: standingInput() }).qualifications).toEqual([]);
	});

	it("maps every policy inside its ceiling", () => {
		expect(
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v0", standing: "unassessed" }),
			}),
		).not.toBeNull();
		expect(
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v1", standing: "settled" }),
			}),
		).not.toBeNull();
		expect(
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v4", standing: "refuted" }),
			}),
		).not.toBeNull();
	});

	it("rejects a standing outside the ceiling of its policy", () => {
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v0", standing: "supported" }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v2", standing: "settled" }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v2", standing: "refuted" }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v3", standing: "refuted" }),
			}),
		).toThrow(TypeError);
	});

	it("rejects a policy or standing outside the closed sets", () => {
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ policy: "v5", standing: "unassessed" }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: standingInput({ standing: "contradicted" }) }),
		).toThrow(TypeError);
	});

	it("rejects a claim id outside its grammar", () => {
		expect(() => mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: standingInput({ claimId: "" }) })).toThrow(
			TypeError,
		);
		expect(() =>
			mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: standingInput({ claimId: "x".repeat(257) }) }),
		).toThrow(TypeError);
	});

	it("rejects evidence entries outside the evidence namespace", () => {
		expect(() =>
			mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: standingInput({ evidence: ["endo.model.res-1"] }) }),
		).toThrow(TypeError);
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: { ...standingInput(), evidence: "res-1" } as unknown as MagpieStandingInputV0,
			}),
		).toThrow(TypeError);
	});

	it("rejects an over-long qualification", () => {
		expect(() =>
			mapMagpieStandingV0({
				id: "endo.evidence.stand-1",
				input: standingInput({ qualifications: ["x".repeat(257)] }),
			}),
		).toThrow(TypeError);
	});

	it("rejects a record id outside the evidence namespace or a non-object input", () => {
		expect(() => mapMagpieStandingV0({ id: "endo.model.stand-1", input: standingInput() })).toThrow(TypeError);
		expect(() => mapMagpieStandingV0({ id: "endo.evidence.stand-1", input: null })).toThrow(TypeError);
	});
});

describe("mapDeadboltLeaseV0", () => {
	it("maps a lease to a protocol-bound record", () => {
		const record = mapDeadboltLeaseV0({
			id: "endo.evidence.lease-1",
			input: leaseInput({ expiresAt: "2026-12-01T00:00:00Z", provenance: "signed by the promotion authority" }),
		});
		expect(record).toEqual({
			schemaVersion: "endo.lease.v0",
			id: "endo.evidence.lease-1",
			route: "promotion.apply",
			capability: "apply the promoted candidate",
			boundTo: "endo.evidence.prom-1",
			signer: "ops-a",
			leaseDigest: DIGEST,
			expiresAt: "2026-12-01T00:00:00Z",
			provenance: "signed by the promotion authority",
		});
		expect(validateEndoLeaseRecordV0(record)).toEqual(record);
	});

	it("rejects a route outside the dotted-kind grammar", () => {
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ route: "Promote.apply" }) }),
		).toThrow(TypeError);
		expect(() => mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ route: "a..b" }) })).toThrow(
			TypeError,
		);
	});

	it("rejects a binding outside the evidence namespace", () => {
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ boundTo: "endo.model.prom-1" }) }),
		).toThrow(TypeError);
	});

	it("rejects a capability, signer, or expiry outside its grammar", () => {
		expect(() => mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ capability: "" }) })).toThrow(
			TypeError,
		);
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ capability: "x".repeat(257) }) }),
		).toThrow(TypeError);
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ signer: "x".repeat(257) }) }),
		).toThrow(TypeError);
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ expiresAt: "x".repeat(257) }) }),
		).toThrow(TypeError);
	});

	it("rejects a lease digest that is not 64 lowercase hex", () => {
		expect(() =>
			mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: leaseInput({ leaseDigest: DIGEST.slice(0, 63) }) }),
		).toThrow(TypeError);
	});

	it("rejects a record id outside the evidence namespace or a non-object input", () => {
		expect(() => mapDeadboltLeaseV0({ id: "endo.model.lease-1", input: leaseInput() })).toThrow(TypeError);
		expect(() => mapDeadboltLeaseV0({ id: "endo.evidence.lease-1", input: null })).toThrow(TypeError);
	});
});

describe("mapDeadboltReceiptV0", () => {
	it("maps a committed receipt with a strict JSON result", () => {
		const record = mapDeadboltReceiptV0({
			id: "endo.evidence.rcpt-1",
			input: receiptInput({ result: { steps: 3, note: "committed" } }),
		});
		expect(record).toEqual({
			schemaVersion: "endo.receipt.v0",
			id: "endo.evidence.rcpt-1",
			leaseId: "endo.evidence.lease-1",
			route: "promotion.apply",
			outcome: "committed",
			result: { steps: 3, note: "committed" },
		});
		expect(validateEndoReceiptRecordV0(record)).toEqual(record);
	});

	it("maps a rollback receipt that supersedes its predecessor", () => {
		const record = mapDeadboltReceiptV0({
			id: "endo.evidence.rcpt-2",
			input: receiptInput({ outcome: "rolled-back", rollbackOf: "endo.evidence.rcpt-1" }),
		});
		expect(record.outcome).toBe("rolled-back");
		expect(record.rollbackOf).toBe("endo.evidence.rcpt-1");
	});

	it("maps each closed outcome", () => {
		for (const outcome of ["committed", "rolled-back", "refused"] as const) {
			expect(mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ outcome }) }).outcome).toBe(
				outcome,
			);
		}
	});

	it("rejects a lease id or rollback target outside the evidence namespace", () => {
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ leaseId: "endo.model.lease-1" }) }),
		).toThrow(TypeError);
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ rollbackOf: "endo.model.rcpt-0" }) }),
		).toThrow(TypeError);
	});

	it("rejects an outcome outside the closed set", () => {
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ outcome: "aborted" }) }),
		).toThrow(TypeError);
	});

	it("rejects a route outside the dotted-kind grammar", () => {
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ route: "Promote" }) }),
		).toThrow(TypeError);
	});

	it("rejects a result that is not strict JSON", () => {
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ result: { a: undefined } }) }),
		).toThrow(TypeError);
		expect(() =>
			mapDeadboltReceiptV0({
				id: "endo.evidence.rcpt-1",
				input: receiptInput({ result: { a: Number.POSITIVE_INFINITY } }),
			}),
		).toThrow(TypeError);
		expect(() =>
			mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: receiptInput({ result: new Date() }) }),
		).toThrow(TypeError);
	});

	it("rejects a record id outside the evidence namespace or a non-object input", () => {
		expect(() => mapDeadboltReceiptV0({ id: "endo.model.rcpt-1", input: receiptInput() })).toThrow(TypeError);
		expect(() => mapDeadboltReceiptV0({ id: "endo.evidence.rcpt-1", input: null })).toThrow(TypeError);
	});
});
