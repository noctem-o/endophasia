/**
 * Phase 9 — the evidence-based runtime admission check (README "## Phase 9 — Runtime expansion":
 * "Runtime admission remains evidence-based").
 *
 * The check decides whether one runtime admission record's position holds against the conformance
 * suites presented to it. It is a derived report, not an effect: computing it installs no runtime,
 * confers no capability, and triggers no transport. The record's own doors (status grammar,
 * per-status requirements) are enforced by the protocol validator; the rules that need the suites
 * are enforced here:
 *
 * - every presented suite must name the record's exact subject and version — a suite for another
 *   subject or version is not evidence for this record;
 * - an "admitted" position requires at least one EXACT-classified study across the presented
 *   suites. The sealed Prime 0.9.7 study admitted no exact capability, and Prime is not admitted:
 *   a study that establishes nothing exactly cannot admit. A version bump alone is insufficient.
 *
 * The report exits through the protocol validator: a check that cannot produce a valid report
 * throws.
 */

import { validateEndoConformanceSuiteV0 } from "../protocol/evaluation.ts";
import type { EndoRuntimeAdmissionCheckV0 } from "../protocol/runtime.ts";
import { validateEndoRuntimeAdmissionCheckV0, validateEndoRuntimeAdmissionV0 } from "../protocol/runtime.ts";

/**
 * Check one runtime admission record against the conformance suites presented to it. Doors: the
 * record and every suite must validate (TypeError, never a repair). Returns the validated report
 * (see the header for the rules it enforces).
 */
export function runtimeAdmissionCheckV0(admission: unknown, suites: unknown[]): EndoRuntimeAdmissionCheckV0 {
	const checked = validateEndoRuntimeAdmissionV0(admission);
	if (checked === null) throw new TypeError("endo.runtime-admission.v0: invalid runtime admission record");
	const presented = suites.map((suite) => {
		const validated = validateEndoConformanceSuiteV0(suite);
		if (validated === null) throw new TypeError("endo.conformance-suite.v0: invalid conformance suite");
		return validated;
	});
	const violations: string[] = [];
	let exactStudies = 0;
	for (const suite of presented) {
		if (suite.subject !== checked.subject) {
			violations.push(`suite subject '${suite.subject}' does not name the record's subject '${checked.subject}'`);
		}
		if (suite.version !== checked.version) {
			violations.push(`suite version '${suite.version}' does not name the record's version '${checked.version}'`);
		}
		exactStudies += suite.studies.filter((study) => study.classification === "EXACT").length;
	}
	if (checked.status === "admitted" && exactStudies === 0) {
		violations.push("admitted requires an EXACT-classified study; the presented suites establish none");
	}
	const report: EndoRuntimeAdmissionCheckV0 = {
		schemaVersion: "endo.runtime-admission-check.v0",
		admissionId: checked.id,
		subject: checked.subject,
		version: checked.version,
		status: checked.status,
		suitesChecked: presented.length,
		exactStudies,
		violations,
		holds: violations.length === 0,
	};
	const validated = validateEndoRuntimeAdmissionCheckV0(report);
	if (validated === null) throw new TypeError("endo.runtime-admission-check.v0: invalid check report");
	return validated;
}
