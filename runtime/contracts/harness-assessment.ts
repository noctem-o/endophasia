// The upstream-change assessment: what an operator needs to know after the runtime behind an attachment changed,
// derived from what the harness registry already records (protocol/harness.ts). Pure and deterministic. It reads
// fingerprints, changes, evidence and capability states; it writes nothing, starts nothing and examines no
// executable, so it can only say what was RECORDED. It is not a record itself and is never persisted.
//
// It adds no capability or authority concept. Each capability's effective standing is either its recorded standing
// or, when this build of Endophasia no longer accepts the evidence behind it, unverified: never anything stronger
// than what was recorded. Controls are gated by the attachment's own derivation (e.g. adapters/pi/evidence.ts), never
// by this report.
//
// Runtime-neutral. The runtime-specific parts are passed in: the adapter's current versions and check definitions
// (`build`), and the commands that re-establish evidence are worded by the caller. Nothing here knows any runtime's
// events, packages or configuration paths.

import type {
	EndoCapabilityCheckKindV0,
	EndoCapabilityDependenciesV0,
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateEntryV0,
	EndoCapabilityStateV0,
	EndoCapabilityStatusV0,
	EndoHarnessChangeV0,
	EndoHarnessDifferenceV0,
	EndoHarnessFingerprintV0,
	EndoHarnessVersionOrderV0,
} from "../../protocol/harness.ts";

/** What this build of the adapter accepts. Evidence recorded under other values does not apply (it is not wrong). */
export interface EndoHarnessBuildV0 {
	adapterVersion: string;
	mappingVersion: string;
	suiteVersion: string;
	/** The current definition digest of a check, or null when the check no longer exists. */
	definitionDigest(checkName: string): string | null;
}

/** A dependency an evidence record rests on, as named in an assessment. */
export type EndoEvidenceDependencyV0 =
	| "identity"
	| "confidence"
	| "adapter"
	| "mapping"
	| "suite"
	| "check-definition"
	| "configuration"
	| "extension";

export interface EndoAssessedObservationV0 {
	fingerprintId: string;
	identityDigest: string;
	confidence: "strong" | "reduced";
	version: string | null;
	realPath: string | null;
	observedAt: string;
}

/** How a capability can be re-established. Consent is the operator's, given per run; it is not a permission. */
export type EndoReestablishV0 = "offline-check" | "live-study-with-consent" | "release-review-or-live-study";

export interface EndoAssessedCapabilityV0 {
	capability: string;
	requires: EndoCapabilityCheckKindV0;
	/** The last recorded standing for the previous runtime, or null when none was recorded (or there is none). */
	previous: EndoCapabilityStatusV0 | null;
	/** The last recorded standing for the current runtime, or null when none has been derived for it yet. */
	recorded: EndoCapabilityStatusV0 | null;
	/** `recorded`, or unverified when this build no longer accepts its evidence; "not-derived" when nothing is recorded. */
	effective: EndoCapabilityStatusV0 | "not-derived";
	reason: string;
	/** The dependencies that differ between the evidence behind `previous` and what applies now, in a fixed order. */
	changed: EndoEvidenceDependencyV0[];
	/** How it can be re-established, or null when it stands on applicable evidence. */
	reestablish: EndoReestablishV0 | null;
}

/** The ladder of claims, each kept apart from the next. Reaching one never implies the one after it. */
export type EndoAssessmentLevelV0 =
	| "identity-observed"
	| "protocol-checked"
	| "capability-qualified"
	| "behaviour-compared"
	| "reproducibility-established";

export interface EndoHarnessAssessmentV0 {
	schemaVersion: "endo.harness-assessment.v0";
	attachment: string;
	runtime: string | null;
	/** Always "recorded": the report reads the registry and examines no executable. */
	basis: "recorded";
	current: EndoAssessedObservationV0 | null;
	/** The latest recorded observation with a different identity than the current one, or null. */
	previous: EndoAssessedObservationV0 | null;
	/** The recorded change between the two, when one was recorded. */
	change: {
		changeId: string;
		differences: EndoHarnessDifferenceV0[];
		versionOrder: EndoHarnessVersionOrderV0;
	} | null;
	levels: { level: EndoAssessmentLevelV0; reached: boolean; detail: string }[];
	capabilities: EndoAssessedCapabilityV0[];
	/** Whether runs recorded under the previous runtime must not be compared with current ones as like for like. */
	comparisons: { constrained: boolean; detail: string };
	limitations: string[];
}

const DEPENDENCY_ORDER: readonly EndoEvidenceDependencyV0[] = [
	"identity",
	"confidence",
	"adapter",
	"mapping",
	"suite",
	"check-definition",
	"configuration",
	"extension",
];

function sameExtension(a: EndoCapabilityDependenciesV0["extension"], b: EndoCapabilityDependenciesV0["extension"]) {
	return a === null || b === null ? a === b : a.id === b.id && a.version === b.version;
}

/**
 * Every dependency that differs between two evidence records, in a fixed order. Unlike a validity rule, which stops at
 * the first failure, this lists all of them, so a runtime change that came with a configuration or adapter change
 * says so. The observation (fingerprint id) is not a dependency: a strong identity carries across observations.
 */
export function endoEvidenceDependencyDiffV0(
	a: EndoCapabilityEvidenceV0,
	b: EndoCapabilityEvidenceV0,
): EndoEvidenceDependencyV0[] {
	const x = a.dependencies;
	const y = b.dependencies;
	const changed = new Set<EndoEvidenceDependencyV0>();
	if (x.identityDigest !== y.identityDigest) changed.add("identity");
	if (x.confidence !== y.confidence) changed.add("confidence");
	if (x.adapterVersion !== y.adapterVersion) changed.add("adapter");
	if (x.mappingVersion !== y.mappingVersion) changed.add("mapping");
	if (x.suiteVersion !== y.suiteVersion) changed.add("suite");
	if (a.check.name === b.check.name && a.check.definitionDigest !== b.check.definitionDigest)
		changed.add("check-definition");
	if (a.check.kind === b.check.kind && x.configurationDigest !== y.configurationDigest) changed.add("configuration");
	if (!sameExtension(x.extension, y.extension)) changed.add("extension");
	return DEPENDENCY_ORDER.filter((dependency) => changed.has(dependency));
}

/** The dependencies of one evidence record that this build, or the current identity, no longer matches. */
function staleAgainst(
	evidence: EndoCapabilityEvidenceV0,
	build: EndoHarnessBuildV0,
	current: EndoHarnessFingerprintV0 | null,
): { dependency: EndoEvidenceDependencyV0; detail: string }[] {
	const d = evidence.dependencies;
	const out: { dependency: EndoEvidenceDependencyV0; detail: string }[] = [];
	if (current !== null && d.identityDigest !== current.identity.digest)
		out.push({ dependency: "identity", detail: "recorded against a different runtime identity" });
	if (
		current !== null &&
		d.fingerprintId !== current.id &&
		(d.confidence !== "strong" || current.identity.confidence !== "strong")
	)
		out.push({
			dependency: "confidence",
			detail: "a reduced-confidence identity does not carry evidence across observations",
		});
	if (d.adapterVersion !== build.adapterVersion)
		out.push({ dependency: "adapter", detail: `adapter ${d.adapterVersion}; this build is ${build.adapterVersion}` });
	if (d.mappingVersion !== build.mappingVersion)
		out.push({ dependency: "mapping", detail: `mapping ${d.mappingVersion}; this build is ${build.mappingVersion}` });
	if (d.suiteVersion !== build.suiteVersion)
		out.push({ dependency: "suite", detail: `suite ${d.suiteVersion}; this build is ${build.suiteVersion}` });
	const definition = build.definitionDigest(evidence.check.name);
	if (definition === null)
		out.push({ dependency: "check-definition", detail: `the check ${evidence.check.name} no longer exists` });
	else if (definition !== evidence.check.definitionDigest)
		out.push({ dependency: "check-definition", detail: `the check ${evidence.check.name} was redefined` });
	return out;
}

function observation(fingerprint: EndoHarnessFingerprintV0): EndoAssessedObservationV0 {
	return {
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		confidence: fingerprint.identity.confidence,
		version: fingerprint.reported.version,
		realPath: fingerprint.local.realPath,
		observedAt: fingerprint.observedAt,
	};
}

/** The last recorded state that describes `fingerprint` (any same-identity observation, when the identity is strong). */
function stateFor(
	fingerprint: EndoHarnessFingerprintV0 | null,
	fingerprints: readonly EndoHarnessFingerprintV0[],
	states: readonly EndoCapabilityStateV0[],
): EndoCapabilityStateV0 | null {
	if (fingerprint === null) return null;
	const ids = new Set(
		fingerprint.identity.confidence === "strong"
			? fingerprints
					.filter((f) => f.identity.digest === fingerprint.identity.digest && f.identity.confidence === "strong")
					.map((f) => f.id)
			: [fingerprint.id],
	);
	for (let index = states.length - 1; index >= 0; index -= 1) {
		const state = states[index]!;
		if (state.fingerprintId !== null && ids.has(state.fingerprintId)) return state;
	}
	return null;
}

const REESTABLISH: Record<EndoCapabilityCheckKindV0, EndoReestablishV0> = {
	"local-protocol": "offline-check",
	"live-study": "live-study-with-consent",
	"static-surface": "release-review-or-live-study",
};

const ADMITTED = new Set<string>(["admitted", "admitted-partial"]);

/**
 * Assess the latest recorded runtime against the latest recorded runtime with a different identity. Records are
 * read in append order. `capabilities` is the adapter's catalogue order; a capability missing from the recorded
 * states is reported as not derived.
 */
export function assessEndoHarnessUpgradeV0(input: {
	attachment: string;
	capabilities: readonly { id: string; requires: EndoCapabilityCheckKindV0 }[];
	fingerprints: readonly EndoHarnessFingerprintV0[];
	changes: readonly EndoHarnessChangeV0[];
	evidence: readonly EndoCapabilityEvidenceV0[];
	states: readonly EndoCapabilityStateV0[];
	build: EndoHarnessBuildV0;
}): EndoHarnessAssessmentV0 {
	const { fingerprints, build } = input;
	const current = fingerprints.at(-1) ?? null;
	const previous =
		current === null
			? null
			: ([...fingerprints].reverse().find((f) => f.identity.digest !== current.identity.digest) ?? null);
	const byId = new Map(input.evidence.map((record) => [record.id, record]));
	const currentState = stateFor(current, fingerprints, input.states);
	const previousState = stateFor(previous, fingerprints, input.states);
	const change =
		current === null || previous === null
			? null
			: ([...input.changes]
					.reverse()
					.find(
						(c) =>
							c.kind === "changed" &&
							c.current?.identityDigest === current.identity.digest &&
							c.previous?.identityDigest === previous.identity.digest,
					) ?? null);

	const capabilities: EndoAssessedCapabilityV0[] = input.capabilities.map(({ id, requires }) => {
		const before: EndoCapabilityStateEntryV0 | null =
			previousState?.capabilities.find((entry) => entry.capability === id) ?? null;
		const now: EndoCapabilityStateEntryV0 | null =
			currentState?.capabilities.find((entry) => entry.capability === id) ?? null;
		const beforeEvidence = before?.evidenceId == null ? null : (byId.get(before.evidenceId) ?? null);
		const nowEvidence = now?.evidenceId == null ? null : (byId.get(now.evidenceId) ?? null);
		let effective: EndoAssessedCapabilityV0["effective"];
		let reason: string;
		if (now === null) {
			effective = "not-derived";
			reason =
				current === null
					? "no runtime has been identified for this attachment"
					: "no capability state has been derived for the current runtime yet";
		} else if (nowEvidence === null && now.evidenceId !== null) {
			// The state names evidence the registry does not hold: nothing stands on it.
			effective = "unverified";
			reason = "the recorded standing names evidence that is not in the registry";
		} else if (nowEvidence !== null) {
			const stale = staleAgainst(nowEvidence, build, current);
			effective = stale.length === 0 ? now.status : "unverified";
			reason =
				stale.length === 0
					? now.reason
					: `recorded ${now.status}, but this build does not accept that evidence: ${stale.map((s) => s.detail).join("; ")}`;
		} else {
			effective = now.status;
			reason = now.reason;
		}
		let changed: EndoEvidenceDependencyV0[] = [];
		if (beforeEvidence !== null) {
			changed =
				nowEvidence !== null
					? endoEvidenceDependencyDiffV0(beforeEvidence, nowEvidence)
					: DEPENDENCY_ORDER.filter((dependency) =>
							staleAgainst(beforeEvidence, build, current).some((s) => s.dependency === dependency),
						);
		}
		const stands = effective !== "not-derived" && effective !== "unverified";
		return {
			capability: id,
			requires,
			previous: before?.status ?? null,
			recorded: now?.status ?? null,
			effective,
			reason: reason.slice(0, 2048),
			changed,
			reestablish: stands ? null : REESTABLISH[requires],
		};
	});

	const standing = (kind: EndoCapabilityCheckKindV0) =>
		capabilities.filter((entry) => {
			if (entry.effective === "not-derived" || entry.effective === "unverified") return false;
			const evidenceId = currentState?.capabilities.find((c) => c.capability === entry.capability)?.evidenceId;
			return evidenceId != null && byId.get(evidenceId)?.check.kind === kind;
		});
	const local = standing("local-protocol");
	const live = standing("live-study");
	const reviewed = standing("static-surface");
	const qualified = [...local, ...live, ...reviewed].filter((entry) => ADMITTED.has(entry.effective));
	const levels: EndoHarnessAssessmentV0["levels"] = [
		{
			level: "identity-observed",
			reached: current !== null,
			detail:
				current === null
					? "no observation is recorded"
					: `recorded ${current.observedAt} (${current.identity.confidence} identity); this report did not examine the installed executable`,
		},
		{
			level: "protocol-checked",
			reached: local.length > 0,
			detail:
				local.length > 0
					? `${local.length} capabilities stand on local protocol checks of this identity (selected exchanges, no agent run)`
					: "no applicable local protocol check is recorded for this identity",
		},
		{
			level: "capability-qualified",
			reached: qualified.length > 0,
			detail: `${qualified.length} admitted: ${local.filter((e) => ADMITTED.has(e.effective)).length} by local checks, ${live.filter((e) => ADMITTED.has(e.effective)).length} by a live study, ${reviewed.filter((e) => ADMITTED.has(e.effective)).length} by a documented-surface review; each within its recorded limits`,
		},
		{
			level: "behaviour-compared",
			reached: false,
			detail:
				"not established by capability evidence: a check observes one property under stated conditions; it does not compare model outputs, tool decisions, compaction, retries or timing with the previous runtime",
		},
		{
			level: "reproducibility-established",
			reached: false,
			detail:
				"not established by capability evidence: reproducibility is a claim about a specific experiment and its own records",
		},
	];
	const lost = capabilities.filter(
		(entry) => entry.previous !== null && ADMITTED.has(entry.previous) && !ADMITTED.has(entry.effective),
	);
	const limitations = [
		"Read from recorded state only: the installed executable and the runtime's configuration were not re-examined. A fresh observation re-reads both.",
		"Inconclusive check results are not recorded, so a capability whose check could not decide stays unverified here without saying why.",
		"A capability's standing is only as broad as the evidence's recorded limits and conditions (one configuration, and for a live study one provider and model).",
	];
	if (current !== null && current.identity.confidence === "reduced")
		limitations.push(
			"The current identity is reduced-confidence: two different runtimes could share it, so no evidence carries across its observations.",
		);
	if (lost.length > 0 && change === null && previous !== null)
		limitations.push("No change record links the two runtimes, so which identity facts differ is not known.");
	return {
		schemaVersion: "endo.harness-assessment.v0",
		attachment: input.attachment,
		runtime: current?.runtime ?? null,
		basis: "recorded",
		current: current === null ? null : observation(current),
		previous: previous === null ? null : observation(previous),
		change:
			change === null
				? null
				: { changeId: change.id, differences: [...change.differences], versionOrder: change.versionOrder },
		levels,
		capabilities,
		comparisons:
			previous === null
				? { constrained: false, detail: "one runtime identity is recorded for this attachment" }
				: {
						constrained: true,
						detail:
							"runs recorded under the previous identity came from a different runtime: they are not like-for-like with current runs whatever the checks say, and trajectory comparisons flag runtime-fingerprint-differs",
					},
		limitations,
	};
}
