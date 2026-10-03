/**
 * Phase 7 — REEF record shapes (README "## Phase 7 — RRSI + REEF providers": "build a REEF adapter
 * that maps its scenario, receipt, feedback, candidate, artifact, release, evaluation into
 * Endophasia's common experiment/evidence model").
 *
 * These are mirrors of the record shapes REEF (Human-Agent-Society/reef) stores and serves, kept in
 * Endophasia so the mapping is testable without a REEF deployment. Each mirrors the REEF glossary
 * term it represents (docs/reference/glossary.rst); field names follow REEF's documented records.
 * Nothing here is a REEF client: no serving, training, or release machinery is copied — the mapping
 * (adapters/reef/mapping.ts) is the whole adapter.
 */

/**
 * A REEF scenario (glossary: "Scenario"): one workload — its records, training state, and release
 * chain — isolated from every other scenario. The first request carrying a new scenario name creates
 * it and permanently binds its recipe.
 */
export interface ReefScenarioV0 {
	/** The scenario name. */
	name: string;
	/** The recipe reference the scenario is bound to (glossary: "Recipe", "Recipe reference"). */
	recipe: string;
}

/**
 * A REEF report (glossary: "Report", "Feedback", "Receipt"): the recorded feedback about one or more
 * served exchanges. REEF consumes each report at most once, including late and retried ones — the
 * Endophasia analogue is the evidence ledger's duplicate-recordId rejection.
 */
export interface ReefReportV0 {
	/** The numeric feedback channel, when one was sent (glossary: "Feedback"). */
	score?: number;
	/**
	 * The structured feedback channel, when one was sent: a string or a structured object such as a
	 * rubric breakdown. REEF's core stores it without interpreting it; the recipe decides what it
	 * means.
	 */
	feedback?: unknown;
	/**
	 * The receipts the report quotes: the ids of the stored inference records it is feedback about.
	 * A receipt names the exchange and the release that produced it.
	 */
	references: string[];
}

/**
 * A REEF mutation (glossary: "Mutation", "Harness tree"): one proposed edit to a harness tree —
 * create, update, or remove on a single root-level entry. A sequence of mutations applies as one
 * composite proposal under one verdict.
 */
export interface ReefMutationV0 {
	/** The operation on the entry. */
	operation: "create" | "update" | "remove";
	/** The root-level harness-tree entry the edit applies to: a path from the tree root. */
	entry: string;
}

/**
 * A REEF candidate (glossary: "Candidate selection", "Mutation"): one produced update — a composite
 * harness-tree proposal the recipe put forward for the gate.
 */
export interface ReefCandidateV0 {
	/** The candidate's identity within the scenario. */
	name: string;
	/** The composite proposal, in application order. */
	mutations: ReefMutationV0[];
	/** What the change claims to improve, when recorded. */
	hypothesis?: string;
}

/**
 * A REEF artifact (glossary: "Artifact", "Content ID"): the selected content — a model checkpoint,
 * live weights, or a harness tree — identified by its content_id, which identifies the content
 * independently of when or why REEF published it. A content_id is REEF's content identity, not a
 * digest: the mapping computes the Endophasia digest only when the content itself is present.
 */
export interface ReefArtifactV0 {
	/** REEF's content identity. */
	contentId: string;
	/** The selected content, when it was captured. */
	content?: unknown;
}

/**
 * One named component of a REEF release's content (glossary: "Component"), e.g. weights, harness, or
 * skills. A multi-component release keeps one directory per component and a manifest naming each
 * component's content_id.
 */
export interface ReefReleaseComponentV0 {
	/** The component name. */
	name: string;
	/** The component's content identity. */
	contentId: string;
}

/**
 * A REEF release (glossary: "Release", "Release chain"): one accepted publication decision in a
 * scenario. The release id names the link in the scenario history; the parent release id names its
 * parent. Rollback creates a new release that may point at an older content_id: history is appended,
 * never rewound — the same semantics the Endophasia promotion decision records (a new decision on
 * the same artifact, the old decision never amended).
 */
export interface ReefReleaseV0 {
	/** The release's identity in the scenario history. */
	releaseId: string;
	/** The parent release, when the release has one. */
	parentReleaseId?: string;
	/** The components the release binds, one content identity each. */
	components: ReefReleaseComponentV0[];
}
