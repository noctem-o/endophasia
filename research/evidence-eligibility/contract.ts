// MEM-000: the evidence-eligibility projection's contract (README.md). Research-only: nothing in the production layers imports it.
//
// A learning EXAMPLE is one decision with its later evidence: an experiment trial (the decision is the randomized condition assignment)
// or a DEVELOP prepared attempt (the decision is the operator's brief). Each example says, per learning OBJECTIVE, whether it is eligible
// and every reason it is not. There is no single quality score: a record can serve one objective and be inadmissible for another.
//
// Every reason is a closed code (REASONS below says what each means). Nothing here infers a fact the source did not record: an absent
// outcome is `outcome-missing`, never a failure; a digest without its content is `content-unavailable`, never text; a study's validity
// reading is the study's own (cited by file and digest), never re-derived.

export const ENDO_EVIDENCE_ELIGIBILITY_REPORT_V0 = "endo.evidence-eligibility-report.v0";
export const ENDO_EVIDENCE_ELIGIBILITY_MANIFEST_V0 = "endo.evidence-eligibility-manifest.v0";
export const ENDO_EVIDENCE_CORPUS_V0 = "endo.evidence-corpus.v0";
export const ENDO_LESSON_CANDIDATES_V0 = "endo.lesson-candidates.v0";
/** The projection's own version: a change to any rule below is a new version, and an old report keeps its own. */
export const ENDO_ELIGIBILITY_EXTRACTOR_V0 = { name: "endo.evidence-eligibility", version: "0.1.0" } as const;

/** What an example may be used for. */
export const OBJECTIVES = ["descriptive", "symptom", "lesson", "causal-policy"] as const;
export type Objective = (typeof OBJECTIVES)[number];

/**
 * Why an example is not eligible for an objective. Closed; the meaning of each is REASONS[code]. The objectives each code removes are fixed
 * by the rules in eligibility.ts, not by the code's name.
 */
export const REASONS = {
	"duplicate-record":
		"The same record (same bytes) was read from another location; it is counted once, at its canonical location.",
	"conflicting-duplicate":
		"Another location holds a record with the same coordinates and different bytes; neither is used.",
	"interrupted-execution":
		"An execution the runner moved aside as interrupted and never counted. It is an operational outcome, not a scored trial.",
	"outcome-missing":
		"No outcome was recorded (the trial ended in a runner error, or has no result). Missing is not failure.",
	"no-check": "The task defines no success check, so there is no outcome measure.",
	"check-output-absent": "The check's output file is not present beside the result, so the symptom cannot be read.",
	"check-output-mismatch":
		"The check's output file does not match the digest the result recorded; it is not that trial's output.",
	"check-output-unverifiable":
		"The output is under a digest key this projection does not hold (an installation key), so it is not bound to the result.",
	"content-unavailable":
		"Only digests and counts are present (no capture log or blobs): the semantic content behind them is not recoverable here.",
	"trial-excluded":
		"The study excluded this trial (for example, leakage of a hidden check). Cited from the study's own analysis.",
	"arm-invalid":
		"The study reported this condition invalid (a failed manipulation check). It supports no causal estimate.",
	"run-invalid":
		"The run is declared invalid by its study (cited document). None of its trials is evidence for the study's question.",
	"validity-undeclared":
		"The study has no machine-readable validity reading this projection can cite, so trial and arm validity are unknown.",
	"exclusions-unresolved":
		"The study reports excluded trials in this cell without naming them, so which trials are valid cannot be determined.",
	"validity-checks-incomplete":
		"The study's own manipulation checks did not all pass for this run; reported as the study recorded them, not reinterpreted.",
	"trial-attrition":
		"Some planned trials of this run have no usable result (never run, refused or missing): the counted ones are not the randomized set.",
	"single-condition":
		"The run assigned one condition only: there is no contrast between actions to evaluate a policy on.",
	"harness-identity-unavailable":
		"The run recorded no harness identity (Pi fingerprint), so the recipe cannot be held fixed.",
	"assignment-not-randomized":
		"The choice was the operator's; its assignment mechanism and probabilities are not recorded, so policy value is not identified.",
	"artifact-unbound":
		"No record binds an output artifact to this decision; a task or session association is not authorship.",
	"outcome-declared-only":
		"The only outcome is the operator's declaration (handoff/outcome note), not an observation.",
	"receipt-output-not-retained":
		"Receipts keep output byte counts, not the output, so no failure symptom can be read from them.",
	"receipt-link-operator-declared":
		"A receipt's link to the attempt is the operator's choice of attempt id when running the check, not an observed relation.",
	"receipt-revision-ambiguous":
		"The attempt's receipts were taken at different commits, so no one revision's outcome is the attempt's.",
	"receipt-predates-attempt":
		"A receipt was taken before the attempt was prepared: it cannot be evidence of the attempt's work.",
	"receipt-project-mismatch": "A receipt names a different project from its attempt.",
	"not-executed":
		"Endophasia never authorised sending the attempt, so no execution of it was observed (a handoff elsewhere is only a declaration).",
	"source-problems":
		"The source directory holds files that are not usable records; the example's completeness is in doubt.",
} as const;
export type Reason = keyof typeof REASONS;

/** Facts about an example that do not remove it from any objective but must travel with it. Closed. */
export const CAVEATS = {
	"pilot-stage": "A pilot run: randomized, but not the study's confirmatory data.",
	"task-examined": "The task was examined by a later analysis: it is development data now, never a holdout.",
	"arm-invalid": "Its condition was reported invalid: observations stand, causal estimates do not.",
	"rerun-after-interruption": "The counted trial is a rerun of an interrupted execution (kept separately).",
	"validity-checks-incomplete":
		"The study's manipulation checks did not all pass for this run; observations stand, causal use does not.",
	"symptoms-withheld": "Failure symptoms exist but are withheld from the report (not a public fixture digest domain).",
} as const;
export type Caveat = keyof typeof CAVEATS;

export interface Verdict {
	eligible: boolean;
	reasons: Reason[];
}

/** A keyed digest as the sources record it (key id, value, covered bytes). Two digests compare only under the same key id. */
export interface KeyedDigest {
	keyId: string;
	value: string;
	bytes: number;
}

/** What could be known when the decision was made: built only from records that precede it (eligibility.ts enforces the inputs). */
export type DecisionFeatures =
	| {
			kind: "condition-assignment";
			mechanism: "blocked-randomization";
			seed: number;
			ordering: string;
			specSha256: string;
			position: number;
			task: string;
			condition: string;
			/** sha256 of the condition's canonical JSON as the spec records it (what was assigned, not its text). */
			conditionSha256: string;
			trial: number;
	  }
	| {
			kind: "prepared-attempt";
			mechanism: "operator";
			preparedAtMs: number;
			projectId: string;
			taskId: string;
			taskRevision: number;
			/** The length of the brief rendered from the prepared record. Neither the text nor a plain digest of it is kept. */
			briefBytes: number;
	  };

export type Availability = "present" | "absent";

export interface ExampleSource {
	kind: "experiment-trial" | "develop-attempt";
	/** The source entry in the corpus this example came from. */
	sourceId: string;
	study: string | null;
	run: string | null;
	stage: string | null;
	/** Where, relative to its root: never an absolute path. */
	location: string;
	schemaVersion: string;
	/** sha256 of the record file's bytes. */
	recordSha256: string;
}

export interface Example {
	id: string;
	source: ExampleSource;
	decision: DecisionFeatures;
	identity: {
		/** As configured (spec provider/model, or the session's harness), a different fact from what the wire named. */
		configuredModel: string | null;
		/** The distinct models the requests named, in first-seen order; null when the record keeps no request parameters. */
		wireModels: string[] | null;
		harness: { name: string; version: string | null; identityDigest: string | null } | null;
	};
	content: {
		store: Availability;
		capture: Availability;
		checkOutput: "verified" | "mismatch" | "absent" | "unverifiable" | "not-applicable";
	};
	outcome:
		| { kind: "check"; passed: boolean; timedOut: boolean; scope: string }
		| { kind: "receipts"; outcomes: string[]; commits: string[]; scope: string }
		| { kind: "declared"; declared: string }
		| { kind: "none"; why: "no-check" | "missing" | "not-executed" };
	artifact: { kind: "workspace-digest"; digest: KeyedDigest; binding: "runner-observed" } | { kind: "none" };
	/** Failing checks named by the check's own output, when it is verified and public; null otherwise. */
	symptoms: string[] | null;
	/** How many distinct tests that output names, failing or passing; null when it was not read. */
	checksNamed: number | null;
	/** How many of them failed, counted before `symptoms` is bounded; null when the output was not read. */
	checksFailed: number | null;
	caveats: Caveat[];
	eligibility: Record<Objective, Verdict>;
	/** Links between examples: the canonical copy of a duplicate; on a counted rerun, the interrupted executions it replaced. */
	links: { duplicateOf?: string; interruptedCopies?: string[] };
}

export interface SourceProblem {
	sourceId: string;
	/** Relative to the source's root. */
	path: string;
	kind: "missing" | "refused" | "unsupported-version" | "unreadable" | "problem-file";
	detail: string;
}

export interface SourceEntry {
	id: string;
	kind: "experiment-run" | "develop-store";
	study: string | null;
	stage: string | null;
	location: string;
	path: string;
	status: "read" | "missing" | "refused";
	/** sha256 of each governing file read, by relative name (experiment.json, plan.json, analysis files, declared documents). */
	files: Record<string, string>;
	examples: number;
}
