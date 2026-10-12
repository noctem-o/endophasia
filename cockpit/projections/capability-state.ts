// The capability state projection: the latest recorded capability state of one attachment, each capability with the
// evidence record it cites, from the validated records of its harness registry. Pure and deterministic.
//
// It does NOT decide what a capability admits. The recorded status is carried verbatim; the admission policy lives with
// the attachment that wrote the state (endoCapabilityStatusForV0, adapters/*/evidence.ts) and is not repeated here with
// a new or weaker rule. What this projection adds are derived `limits`: disagreements between the records themselves,
// each tagged with the records involved, so a consumer can see when a recorded status cannot be taken at face value:
//  - the state is for an older fingerprint than the latest recorded one (the doctor's staleness rule);
//  - the state names a fingerprint that is not in the registry;
//  - the cited evidence record is not in the registry, names another capability, or classifies differently;
//  - the cited evidence was recorded under a different runtime identity than the one the state names. Evidence legitimately
//    outlives the observation it was recorded against while the identity digest is unchanged, so the observation id is
//    NOT compared, only the identity;
//  - the evidence is carried across observations on a reduced-confidence identity (the protocol's rule: such evidence is
//    never reused for a later observation);
//  - the recorded status does not follow from the recorded classification.
// The evidence's written expectation and observation are not presented; its limitations (adapter-written) are.

import {
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	type EndoCockpitCapabilityStateV0,
	type EndoCockpitCapabilityViewV0,
	type EndoCockpitEvidenceViewV0,
	type EndoCockpitNoteV0,
	type EndoCockpitRefV0,
} from "../../protocol/cockpit.ts";
import {
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateEntryV0,
	endoCapabilityStatusForV0,
} from "../../protocol/harness.ts";
import {
	cleanRegistryRecordsV0,
	type EndoCockpitIndexedV0,
	type EndoCockpitRegistryInputV0,
	noteV0,
	registryRefV0,
} from "./common.ts";

const WITHHELD_EVIDENCE_FIELDS = ["expected", "inputsDigest", "observed"];

function evidenceView(
	attachment: string,
	item: EndoCockpitIndexedV0<EndoCapabilityEvidenceV0>,
): EndoCockpitEvidenceViewV0 {
	const { record, index } = item;
	return {
		ref: registryRefV0(attachment, "evidence", index, record.id),
		id: record.id,
		check: { name: record.check.name, version: record.check.version, kind: record.check.kind },
		at: record.at,
		classification: record.classification,
		dependencies: {
			fingerprintId: record.dependencies.fingerprintId,
			identityDigest: record.dependencies.identityDigest,
			confidence: record.dependencies.confidence,
			adapterVersion: record.dependencies.adapterVersion,
			mappingVersion: record.dependencies.mappingVersion,
			suiteVersion: record.dependencies.suiteVersion,
			configurationDigest: record.dependencies.configurationDigest,
			extension: record.dependencies.extension === null ? null : { ...record.dependencies.extension },
		},
		supporting: [...record.evidence],
		withheld: [...WITHHELD_EVIDENCE_FIELDS],
	};
}

/** The capability state projection of one attachment. */
export function projectEndoCockpitCapabilityStateV0(input: EndoCockpitRegistryInputV0): EndoCockpitCapabilityStateV0 {
	const { source, records } = input;
	const attachment = source.attachment;
	const notes: EndoCockpitNoteV0[] = [];
	const base = {
		schemaVersion: "endo.cockpit-capability-state.v0" as const,
		projectionVersion: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.capabilityState,
		source,
	};
	if (records === null) {
		notes.push(noteV0("source-not-projectable"));
		return { ...base, state: null, capabilities: [], notes };
	}

	const fingerprints = cleanRegistryRecordsV0(source, "fingerprint", records.fingerprint, notes);
	const evidence = cleanRegistryRecordsV0(source, "evidence", records.evidence, notes);
	// A state record has no id of its own, so only its attachment is checked.
	const states = cleanRegistryRecordsV0(source, "state", records.state, notes);
	const latest = states.at(-1) ?? null;
	if (latest === null) {
		notes.push(noteV0("no-capability-state-recorded"));
		return { ...base, state: null, capabilities: [], notes };
	}

	const state = latest.record;
	const stateRef = registryRefV0(attachment, "state", latest.index, null);
	const newest = fingerprints.at(-1) ?? null;
	const named = fingerprints.find((item) => item.record.id === state.fingerprintId) ?? null;
	const newestRef = newest === null ? null : registryRefV0(attachment, "fingerprint", newest.index, newest.record.id);
	const currency =
		state.fingerprintId === null || newest === null
			? "unknown"
			: state.fingerprintId === newest.record.id
				? "current"
				: "stale";
	if (newest === null) notes.push(noteV0("state-without-fingerprint", [stateRef]));

	const byId = new Map(evidence.map((item) => [item.record.id, item]));
	const capabilities: EndoCockpitCapabilityViewV0[] = [];
	const seen = new Set<string>();
	for (const entry of state.capabilities as EndoCapabilityStateEntryV0[]) {
		if (seen.has(entry.capability)) {
			notes.push(noteV0("duplicate-capability", [stateRef]));
			continue;
		}
		seen.add(entry.capability);
		const limits: EndoCockpitCapabilityViewV0["limits"] = [];
		const cited = entry.evidenceId === null ? null : (byId.get(entry.evidenceId) ?? null);
		const citedRef: EndoCockpitRefV0 | null =
			cited === null ? null : registryRefV0(attachment, "evidence", cited.index, cited.record.id);

		if (entry.status !== "unverified") {
			if (currency === "stale")
				limits.push({ code: "state-not-for-latest-fingerprint", refs: [stateRef, newestRef!] });
			if (newest === null) limits.push({ code: "state-without-fingerprint", refs: [stateRef] });
			if (entry.classification !== null && endoCapabilityStatusForV0(entry.classification) !== entry.status)
				limits.push({ code: "status-classification-mismatch", refs: [stateRef] });
			if (state.fingerprintId !== null && named === null)
				limits.push({ code: "state-fingerprint-not-recorded", refs: [stateRef] });
			if (cited === null) limits.push({ code: "evidence-record-missing", refs: [stateRef] });
			else {
				const refs = [stateRef, citedRef!];
				if (cited.record.capability !== entry.capability)
					limits.push({ code: "evidence-capability-differs", refs });
				if (cited.record.classification !== entry.classification)
					limits.push({ code: "evidence-classification-differs", refs });
				if (named !== null) {
					const namedRef = registryRefV0(attachment, "fingerprint", named.index, named.record.id);
					if (cited.record.dependencies.identityDigest !== named.record.identity.digest)
						limits.push({ code: "evidence-identity-differs", refs: [...refs, namedRef] });
					const carried = cited.record.dependencies.fingerprintId !== named.record.id;
					if (
						carried &&
						(cited.record.dependencies.confidence === "reduced" || named.record.identity.confidence === "reduced")
					)
						limits.push({ code: "evidence-reduced-identity", refs: [...refs, namedRef] });
				}
			}
		}

		capabilities.push({
			capability: entry.capability,
			status: entry.status,
			classification: entry.classification,
			reason: entry.reason,
			requires: entry.requires,
			evidence: cited === null ? null : evidenceView(attachment, cited),
			limitations: cited === null ? [] : [...cited.record.limitations],
			limits,
			ref: stateRef,
		});
	}

	return {
		...base,
		state: {
			ref: stateRef,
			recordedAt: state.at,
			fingerprintId: state.fingerprintId,
			latestFingerprintId: newest?.record.id ?? null,
			currency,
		},
		capabilities,
		notes,
	};
}
