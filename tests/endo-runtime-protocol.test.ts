import { describe, expect, it } from "vitest";
import type { EndoRuntimeAdmissionCheckV0, EndoRuntimeAdmissionV0 } from "../protocol/runtime.ts";
import {
	ENDO_RUNTIME_ADMISSION_STATUSES_V0,
	validateEndoRuntimeAdmissionCheckV0,
	validateEndoRuntimeAdmissionV0,
} from "../protocol/runtime.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";

const LONG_SUBJECT = "a".repeat(128);

function admission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.runtime-admission.v0",
		id: "endo.evidence.adm-1",
		subject: "prime",
		version: "0.9.7",
		status: "dormant",
		evidence: ["endo.evidence.suite-1"],
		blockers: ["durable operation/outcome identity"],
		...overrides,
	};
}

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "endo.runtime-admission-check.v0",
		admissionId: "endo.evidence.adm-1",
		subject: "prime",
		version: "0.9.7",
		status: "dormant",
		suitesChecked: 1,
		exactStudies: 0,
		violations: [],
		holds: true,
		...overrides,
	};
}

describe("the runtime admission record", () => {
	it("accepts a fully-formed dormant admission", () => {
		const record = admission();
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("records the four closed statuses", () => {
		expect([...ENDO_RUNTIME_ADMISSION_STATUSES_V0]).toEqual(["candidate", "dormant", "reference", "admitted"]);
	});

	it("accepts a candidate with no evidence and no blockers", () => {
		const record = admission({ status: "candidate", evidence: [], blockers: [] });
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("accepts a reference for the subject pi with no blockers", () => {
		const record = admission({
			id: "endo.evidence.adm-pi",
			subject: "pi",
			version: "1.0.0",
			status: "reference",
			evidence: [],
			blockers: [],
		});
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("accepts an admitted admission citing conformance evidence", () => {
		const record = admission({ status: "admitted", blockers: [] });
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("accepts an open well-formed subject for an additional runtime", () => {
		const record = admission({ subject: "future-runtime.two", status: "candidate", evidence: [], blockers: [] });
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("accepts a subject at the 128-character boundary", () => {
		const record = admission({ subject: LONG_SUBJECT, status: "candidate", evidence: [], blockers: [] });
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});

	it("rejects a subject over the 128-character bound", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ subject: "a".repeat(129) }))).toBeNull();
	});

	it("rejects a subject outside the dotted-kind grammar", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ subject: "Prime" }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ subject: "9lives" }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ subject: "pi." }))).toBeNull();
	});

	it("rejects unknown fields", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ transport: "rpc" }))).toBeNull();
	});

	it("rejects a wrong schema version", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ schemaVersion: "endo.runtime-admission.v1" }))).toBeNull();
	});

	it("rejects non-objects", () => {
		expect(validateEndoRuntimeAdmissionV0(null)).toBeNull();
		expect(validateEndoRuntimeAdmissionV0([])).toBeNull();
		expect(validateEndoRuntimeAdmissionV0("endo.runtime-admission.v0")).toBeNull();
	});

	it("rejects an id outside the endo.evidence.* namespace", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ id: "endo.run.adm-1" }))).toBeNull();
	});

	it("rejects an empty or over-long version", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ version: "" }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ version: "a".repeat(257) }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ version: "a".repeat(256) }))).toEqual(
			admission({ version: "a".repeat(256) }),
		);
	});

	it("rejects a status outside the closed set", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ status: "sealed" }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ status: "DORMANT" }))).toBeNull();
	});

	it("rejects evidence that is not an endo.evidence.* identifier", () => {
		expect(
			validateEndoRuntimeAdmissionV0(
				admission({ evidence: ["9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"] }),
			),
		).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ evidence: ["endo.run.suite-1"] }))).toBeNull();
	});

	it("rejects over-long blockers", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ blockers: ["a".repeat(513)] }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ blockers: ["a".repeat(512)] }))).toEqual(
			admission({ blockers: ["a".repeat(512)] }),
		);
	});

	it("rejects an over-long provenance", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ provenance: "a".repeat(4097) }))).toBeNull();
	});

	it("keeps the reference to the subject pi without blockers", () => {
		expect(
			validateEndoRuntimeAdmissionV0(admission({ subject: "prime", status: "reference", blockers: [] })),
		).toBeNull();
		expect(
			validateEndoRuntimeAdmissionV0(
				admission({ subject: "pi", status: "reference", evidence: [], blockers: ["a blocker"] }),
			),
		).toBeNull();
	});

	it("requires a sealed study behind a dormant line", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ evidence: [] }))).toBeNull();
		expect(validateEndoRuntimeAdmissionV0(admission({ blockers: [] }))).toBeNull();
	});

	it("requires evidence behind an admitted line", () => {
		expect(validateEndoRuntimeAdmissionV0(admission({ status: "admitted", evidence: [] }))).toBeNull();
	});

	it("records a candidate with no requirement", () => {
		const record = admission({ status: "candidate", evidence: [], blockers: [] });
		expect(validateEndoRuntimeAdmissionV0(record)).toEqual(record);
	});
});

describe("the runtime admission check report", () => {
	it("accepts a holding report with no violations", () => {
		const report = check();
		expect(validateEndoRuntimeAdmissionCheckV0(report)).toEqual(report);
	});

	it("accepts a violated report that names its violations", () => {
		const report = check({
			status: "admitted",
			suitesChecked: 1,
			violations: ["admitted requires an EXACT-classified study; the presented suites establish none"],
			holds: false,
		});
		expect(validateEndoRuntimeAdmissionCheckV0(report)).toEqual(report);
	});

	it("agrees holds with the violations list", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ violations: ["a violation"], holds: true }))).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0(check({ violations: [], holds: false }))).toBeNull();
	});

	it("rejects an admission id outside the endo.evidence.* namespace", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ admissionId: "endo.run.adm-1" }))).toBeNull();
	});

	it("rejects a subject outside the dotted-kind grammar", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ subject: "Prime" }))).toBeNull();
	});

	it("rejects a status outside the closed set", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ status: "sealed" }))).toBeNull();
	});

	it("rejects non-integral or negative counts", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ suitesChecked: -1 }))).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0(check({ exactStudies: 1.5 }))).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0(check({ suitesChecked: "1" }))).toBeNull();
	});

	it("rejects empty or over-long violations", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ violations: [""], holds: false }))).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0(check({ violations: ["a".repeat(4097)], holds: false }))).toBeNull();
	});

	it("rejects unknown fields and non-objects", () => {
		expect(validateEndoRuntimeAdmissionCheckV0(check({ extra: 1 }))).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0(null)).toBeNull();
		expect(validateEndoRuntimeAdmissionCheckV0([])).toBeNull();
	});
});

describe("the runtime admission records under canonical JSON", () => {
	it("round-trips the admission record and the check report", () => {
		const record: EndoRuntimeAdmissionV0 = {
			schemaVersion: "endo.runtime-admission.v0",
			id: "endo.evidence.adm-1",
			subject: "prime",
			version: "0.9.7",
			status: "dormant",
			evidence: ["endo.evidence.conformance-suite.9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
			blockers: [
				"durable operation/outcome identity",
				"complete lifecycle semantics",
				"committed Usage allocation/paging",
				"matching continuity/context semantics",
			],
			provenance: "sealed 0.9.7 study at 08ff1b2e2794ea9e8f4a08d12bc95408a66e1074, probe 0.14.7",
		};
		const report: EndoRuntimeAdmissionCheckV0 = {
			schemaVersion: "endo.runtime-admission-check.v0",
			admissionId: record.id,
			subject: "prime",
			version: "0.9.7",
			status: "dormant",
			suitesChecked: 1,
			exactStudies: 0,
			violations: [],
			holds: true,
		};
		for (const value of [record, report]) {
			expect(JSON.parse(canonicalEndoJsonV0(value))).toEqual(value);
		}
	});
});
