/**
 * Prime-specific: the recorded outcome of one conformance scenario against the Prime transport
 * ingress (README "## Phase 9 — Runtime expansion": "Prime research adapter"; README "### Prime").
 *
 * The process/RPC ingress (`adapters/prime/transport/`) remains useful for research, EVOLVE
 * experiments and future conformance checks; transport ingress does not imply an admitted
 * runtime. A probe outcome is what the probe hands over for one scenario: what the scenario
 * claimed, what the ingress reported, and how the two stand — classified under the lab's closed
 * five-way. The outcome is a mirror of the probe's documented fields; the adapter records it,
 * never classifies it (the classification the probe reports is the classification recorded).
 */

import type { EndoConformanceClassificationV0 } from "../../protocol/evaluation.ts";

/**
 * The recorded outcome of one conformance scenario against the Prime transport ingress. The
 * subject is fixed by the adapter (prime); the fields below are the study's named inputs.
 */
export interface PrimeProbeOutcomeV0 {
	/** The Prime version the scenario ran against. */
	version: string;
	/** The scenario the study exercised. */
	scenario: string;
	/** The decoder's identity/revision that produced the observed reading. */
	decoder: string;
	/** The predicate's identity that the expected meaning is stated under. */
	predicate: string;
	/** The expected semantic meaning, in words. */
	expected: string;
	/** The observed result, in words. */
	observed: string;
	/** The probe's classification of the observed result against the expected meaning. */
	classification: EndoConformanceClassificationV0;
	/** The evidence the classification rests on: digests or endo.evidence.* references. */
	evidence: string[];
	/** The recorded limitations of the study, in words. */
	limitations: string[];
}
