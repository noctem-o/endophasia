/**
 * Codex-specific: the pinned conformance study scaffold (README "## Phase 9 — Runtime expansion":
 * "Codex conformance study"; README "### Codex").
 *
 * Codex is a future runtime candidate. Its app-server protocol exposes threads, turns, items,
 * steering, interruption, forks, compaction, usage, review, approvals, and runtime settings;
 * Endophasia still needs a pinned conformance study before any of those become Endophasia
 * capabilities. The planned order is runtime-specific transport first, conformance evidence
 * second, capability admission last — this module is the conformance-evidence seam: a recorded
 * app-server reading, mapped to the lab's protocol-bound study record.
 *
 * Per the conformance lab's own note, a genuinely different second subject should inform any
 * later abstraction and sharing transport shape is insufficient: this scaffold keeps its own
 * scenarios, decoder, predicates, classifications and citations, and produces the same neutral
 * study record the lab already defines — no shared second-subject machinery.
 */

import type { EndoConformanceClassificationV0 } from "../../protocol/evaluation.ts";

/**
 * The app-server protocol surfaces the pinned Codex conformance study covers (README "### Codex"),
 * in the order the protocol names them. A documented vocabulary: a study's scenario need not be
 * one of these names, but the study's scenario catalog starts here.
 */
export const CODEX_APP_SERVER_SURFACES_V0 = [
	"threads",
	"turns",
	"items",
	"steering",
	"interruption",
	"forks",
	"compaction",
	"usage",
	"review",
	"approvals",
	"runtime-settings",
] as const satisfies readonly string[];

/**
 * The recorded reading of one conformance scenario against the Codex app-server protocol. The
 * subject is fixed by the adapter (codex); the fields below are the study's named inputs.
 */
export interface CodexAppServerReadingV0 {
	/** The Codex version the scenario ran against. */
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
	/** The reading's classification of the observed result against the expected meaning. */
	classification: EndoConformanceClassificationV0;
	/** The evidence the classification rests on: digests or endo.evidence.* references. */
	evidence: string[];
	/** The recorded limitations of the study, in words. */
	limitations: string[];
}
