// Codex-specific: the mapping from a recorded Codex app-server reading (adapters/codex/shapes.ts)
// into Endophasia's protocol-bound conformance study (README "## Phase 9 — Runtime expansion":
// "Codex conformance study").
// Every function is pure: it validates its input at the door (TypeError, never a repair), and it
// validates its output through the protocol — a mapping that cannot produce a valid record throws.
// Nothing here talks to a Codex app server; the shape is a mirror of the documented reading
// fields, and the subject is pinned to "codex" by the mapper — a Codex reading is never recorded
// under another subject.
//
// The fixed correspondence (reading field → endo.conformance-study.v0 field):
//   version         → version
//   scenario        → scenario
//   decoder         → decoder
//   predicate       → predicate
//   expected        → expected
//   observed        → observed
//   classification  → classification (the reading's own; the mapper records it, never classifies)
//   evidence        → evidence
//   limitations     → limitations
//   (pinned)        → subject: "codex"

import {
	ENDO_CONFORMANCE_CLASSIFICATIONS_V0,
	type EndoConformanceStudyV0,
	validateEndoConformanceStudyV0,
} from "../../protocol/evaluation.ts";
import { isEndoIdentifierV0 } from "../../protocol/identity.ts";

const HEX64_V0 = /^[0-9a-f]{64}$/;

/** A study evidence reference: a digest or an endo.evidence.* identifier. */
function evidenceEntryV0(label: string, value: unknown): string {
	if (typeof value !== "string" || !(HEX64_V0.test(value) || isEndoIdentifierV0(value, "evidence"))) {
		throw new TypeError(`${label} must be a 64-hex digest or an endo.evidence.* identifier`);
	}
	return value;
}

function profileTextV0(label: string, value: unknown, maxLength: number): string {
	if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
		throw new TypeError(`${label} must be a non-empty string of at most ${maxLength} characters`);
	}
	return value;
}

/**
 * Map a recorded Codex app-server reading to a conformance study. The subject is pinned to
 * "codex"; the classification is the reading's own, from the lab's closed five-way; the study
 * exits through `validateEndoConformanceStudyV0`.
 */
export function mapCodexReadingV0(reading: unknown): EndoConformanceStudyV0 {
	if (typeof reading !== "object" || reading === null || Array.isArray(reading)) {
		throw new TypeError("the Codex app-server reading must be an object");
	}
	const v = reading as Record<string, unknown>;
	const study: EndoConformanceStudyV0 = {
		schemaVersion: "endo.conformance-study.v0",
		subject: "codex",
		version: profileTextV0("the Codex reading version", v.version, 256),
		scenario: profileTextV0("the Codex reading scenario", v.scenario, 256),
		decoder: profileTextV0("the Codex reading decoder", v.decoder, 256),
		predicate: profileTextV0("the Codex reading predicate", v.predicate, 256),
		expected: profileTextV0("the Codex reading expected meaning", v.expected, 4096),
		observed: profileTextV0("the Codex reading observed result", v.observed, 4096),
		classification: v.classification as EndoConformanceStudyV0["classification"],
		evidence: Array.isArray(v.evidence)
			? v.evidence.map((entry) => evidenceEntryV0("a Codex reading evidence entry", entry))
			: [],
		limitations: Array.isArray(v.limitations)
			? v.limitations.map((entry) => profileTextV0("a Codex reading limitation", entry, 4096))
			: [],
	};
	if (
		typeof v.classification !== "string" ||
		!(ENDO_CONFORMANCE_CLASSIFICATIONS_V0 as readonly string[]).includes(v.classification as string)
	) {
		throw new TypeError(
			`the Codex reading classification must be one of: ${ENDO_CONFORMANCE_CLASSIFICATIONS_V0.join(", ")}`,
		);
	}
	const out = validateEndoConformanceStudyV0(study);
	if (out === null) {
		throw new TypeError("the mapped conformance study failed protocol validation");
	}
	return out;
}
