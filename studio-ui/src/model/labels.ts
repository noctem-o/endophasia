// The page's wording for every closed vocabulary of the contract, and the contract versions it can read.
//
// The types come from protocol/ (`import type` only: nothing of the protocol runs in the browser). Each table is a `Record` over
// the protocol's own union, so a vocabulary that grows breaks the typecheck here, and tests/endo-studio-ui-contract.test.ts
// pins the runtime copies (versions, the withheld sentinel) against the protocol's exports. A value this build does not know is
// shown as what it is, in code type, and never given a meaning (see `known`).
import type {
	EndoCockpitBasisV0,
	EndoCockpitCategoryV0,
	EndoCockpitFlagV0,
	EndoCockpitLimitCodeV0,
	EndoCockpitNoteCodeV0,
	EndoCockpitSourceStateV0,
} from "../../../protocol/cockpit.ts";
import type { EndoConformanceClassificationV0 } from "../../../protocol/evaluation.ts";
import type { EndoEventSourceV0 } from "../../../protocol/event.ts";
import type {
	EndoCapabilityCheckKindV0,
	EndoCapabilityStatusV0,
	EndoHarnessChangeKindV0,
	EndoHarnessDifferenceV1,
	EndoHarnessIdentityConfidenceV0,
	EndoHarnessNotificationKindV0,
	EndoHarnessVersionOrderV0,
} from "../../../protocol/harness.ts";

/** The projection versions this page can read. A response declaring another is refused, never read as this one. */
export const SUPPORTED_PROJECTIONS = {
	snapshot: "cockpit-snapshot.3",
	runtimeIdentity: "cockpit-runtime-identity.4",
	capabilityState: "cockpit-capability-state.3",
	sessionTimeline: "cockpit-session-timeline.3",
} as const;

/** The text the privacy policy puts in place of a value it withholds. */
export const WITHHELD_TEXT = "withheld: looks like a path, address or credential";

/** The token of a generated stand-in for an identifier or kind the policy would not present: `withheld-` and 32 lowercase hex digits. */
export const ALIAS_PATTERN = /withheld-[0-9a-f]{32}/;

/**
 * The whole-value forms the generator emits, and nothing else: an identifier `endo.<namespace>.withheld-<hex>`, a bare kind
 * `withheld-<hex>`, and an event kind `other.withheld-<hex>`. A longer text that merely contains such a token is ordinary text.
 */
export const ALIAS_FORMS: readonly RegExp[] = [
	/^endo\.[a-z][a-z0-9-]*\.withheld-[0-9a-f]{32}$/,
	/^withheld-[0-9a-f]{32}$/,
	/^other\.withheld-[0-9a-f]{32}$/,
];

/** The meaning of `key` in `table`, or null when this build does not know it (a newer contract's value). */
export function known<K extends string, V>(table: Readonly<Record<K, V>>, key: string): V | null {
	return Object.hasOwn(table, key) ? table[key as K] : null;
}

export interface Described {
	label: string;
	meaning: string;
}

export const SOURCE_STATE: Readonly<Record<EndoCockpitSourceStateV0, Described>> = {
	absent: { label: "absent", meaning: "Nothing exists at this source's location. Reading never creates it." },
	empty: { label: "empty", meaning: "The source exists and holds no records." },
	readable: { label: "readable", meaning: "Every stored record was read and verified." },
	degraded: {
		label: "degraded",
		meaning:
			"A prefix is readable and the source ends in a torn tail or at a record that failed verification. A torn tail can be a write in progress.",
	},
	unopenable: {
		label: "unopenable",
		meaning: "The source exists but could not be opened. Nothing is shown from it, and it is not an empty source.",
	},
};

export const BASIS: Readonly<Record<EndoCockpitBasisV0 | "unavailable", Described & { short: string }>> = {
	observed: { label: "observed", short: "OBS", meaning: "Observed directly by Endophasia." },
	reported: { label: "reported", short: "REP", meaning: "Reported by the runtime. Not independently verified." },
	derived: { label: "derived", short: "DER", meaning: "Computed from other recorded values." },
	inferred: { label: "inferred", short: "INF", meaning: "Inferred. No version of the contract produces this yet." },
	unavailable: { label: "unavailable", short: "N/A", meaning: "There is no value, for the reason shown." },
};

export const NOTE_TEXT: Readonly<Record<EndoCockpitNoteCodeV0, string>> = {
	"no-fingerprint-recorded": "The registry records no runtime fingerprint, so no identity can be shown.",
	"latest-change-not-for-latest-fingerprint":
		"The latest recorded change does not describe the latest recorded fingerprint.",
	"latest-change-is-collection-failure": "The latest recorded change is a failed collection, not an observation.",
	"notification-change-missing": "The latest notification names a change that is not among the recorded changes.",
	"runtime-disagreement": "The recorded fingerprints and changes name more than one runtime family.",
	"foreign-attachment-record": "A record naming another attachment was set aside.",
	"duplicate-record-id": "A record that repeats an earlier record's identifier was set aside.",
	"duplicate-capability": "A capability recorded more than once in the state was set aside after its first entry.",
	"state-without-fingerprint": "A capability state is recorded, but no fingerprint is.",
	"no-capability-state-recorded": "The registry records no capability state.",
	"source-not-projectable": "The registry could not be opened, so nothing is projected from it.",
};

export const LIMIT_TEXT: Readonly<Record<EndoCockpitLimitCodeV0, string>> = {
	"state-not-for-latest-fingerprint": "The state was recorded for an older fingerprint than the latest recorded one.",
	"state-without-fingerprint":
		"A state is recorded but no fingerprint is, so what the state describes cannot be identified.",
	"status-classification-mismatch": "The recorded status is not the one the recorded classification maps to.",
	"state-fingerprint-not-recorded": "The fingerprint the state names is not in the registry.",
	"runtime-differs":
		"The state records one runtime family, and its evidence or a fingerprint it names records another.",
	"evidence-record-missing": "The state cites no evidence record, or the one it cites is not in the registry.",
	"evidence-check-insufficient": "The cited evidence comes from a cheaper kind of check than the capability requires.",
	"evidence-capability-differs": "The cited evidence record is for a different capability.",
	"evidence-classification-differs": "The cited evidence's own classification differs from the one the state records.",
	"evidence-identity-differs":
		"The evidence was recorded against a different identity than the fingerprint the state names.",
	"evidence-confidence-differs":
		"The evidence's identity confidence differs from that of the identity record it names.",
	"evidence-reduced-identity": "The evidence is carried across observations on an identity of reduced confidence.",
};

export const STATUS: Readonly<Record<EndoCapabilityStatusV0, Described>> = {
	admitted: { label: "admitted", meaning: "Recorded as admitted: current evidence classifies it exact or qualified." },
	"admitted-partial": {
		label: "admitted, partial",
		meaning:
			"Recorded as admitted: current evidence classifies it partial, so it is usable only within its recorded limitations.",
	},
	unavailable: {
		label: "unavailable",
		meaning: "Recorded as unavailable: current evidence classifies it so. Not offered.",
	},
	mismatch: { label: "mismatch", meaning: "Recorded as a mismatch: current evidence classifies it so. Not offered." },
	unverified: {
		label: "unverified",
		meaning:
			"Recorded without current evidence (none yet, invalidated by a change, or a live study pending). Not offered, whatever earlier evidence said.",
	},
};

export const CLASSIFICATION: Readonly<Record<EndoConformanceClassificationV0, string>> = {
	EXACT: "exact",
	QUALIFIED: "qualified",
	PARTIAL: "partial",
	UNAVAILABLE: "unavailable",
	MISMATCH: "mismatch",
};

export const CHECK_KIND: Readonly<Record<EndoCapabilityCheckKindV0, string>> = {
	"static-surface": "static surface check",
	"local-protocol": "local protocol check",
	"live-study": "live study",
};

export const CONFIDENCE: Readonly<Record<EndoHarnessIdentityConfidenceV0, string>> = {
	strong: "strong identity",
	reduced: "reduced identity",
};

export const CHANGE_KIND: Readonly<Record<EndoHarnessChangeKindV0, string>> = {
	"first-observation": "first observation",
	unchanged: "unchanged",
	changed: "changed",
	"collection-failed": "collection failed",
};

export const DIFFERENCE: Readonly<Record<EndoHarnessDifferenceV1, string>> = {
	realPath: "install path",
	entrypoint: "entrypoint",
	package: "package",
	version: "version",
	runtimeContent: "runtime files",
	confidence: "identity confidence",
	identityBasis: "identity basis (digests not comparable)",
};

export const VERSION_ORDER: Readonly<Record<EndoHarnessVersionOrderV0, string>> = {
	higher: "higher version (semver precedence)",
	lower: "lower version (semver precedence)",
	equal: "same version",
	incomparable: "not comparable (a version is not semver)",
	unknown: "unknown (a version is missing)",
};

export const NOTIFICATION_KIND: Readonly<Record<EndoHarnessNotificationKindV0, string>> = {
	"runtime-first-observed": "runtime first observed",
	"runtime-changed": "runtime changed",
	"runtime-unidentified": "runtime unidentified",
};

export const CATEGORY: Readonly<Record<EndoCockpitCategoryV0, string>> = {
	lifecycle: "lifecycle",
	agent: "agent",
	message: "message",
	tool: "tool",
	session: "session",
	queue: "queue",
	compaction: "compaction",
	retry: "retry",
	harness: "harness",
	control: "control",
	other: "other",
};

export const FLAG: Readonly<Record<EndoCockpitFlagV0, Described>> = {
	interruption: {
		label: "interruption",
		meaning: "Its kind records a run or process being interrupted, detached or exited.",
	},
	discontinuity: {
		label: "discontinuity",
		meaning:
			"Its kind marks a resumption or a runtime change, or it records a store reopened after damage: a break in continuity.",
	},
	anomaly: {
		label: "anomaly",
		meaning:
			"Its kind records a fault, a mismatch or a malformed event, or the event carries conflicting runtime session references.",
	},
	unrecognized: {
		label: "unrecognized",
		meaning:
			"The projection does not list its kind among those Endophasia's producers record, or the event reports one it could not recognize.",
	},
};

export const EVENT_SOURCE: Readonly<Record<EndoEventSourceV0, string>> = {
	"runtime-fact": "runtime fact",
	interpretation: "interpretation",
	hypothesis: "hypothesis",
	"evaluation-result": "evaluation result",
	"policy-conclusion": "policy conclusion",
	"authority-decision": "authority decision",
};
