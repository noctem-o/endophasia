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
//  - the recorded status does not follow from the recorded classification;
//  - the cited evidence came from a cheaper kind of check than the capability requires (the reverse is legitimate);
//  - the evidence's confidence differs from the identity record it names (even when it names the same fingerprint);
//  - the runtime family differs between the state, the cited evidence, the fingerprint the state names or the latest
//    fingerprint. Each record is valid alone (the registry checks attachment, not family), so this is the only place the
//    disagreement shows; the recorded status is still carried as recorded, never recomputed. Fingerprint ids are NOT
//    compared for this: the identity digest already covers the runtime, and evidence carried across observations is
//    legitimate while it holds.
// The evidence's written expectation and observation are not presented; its limitations (adapter-written) are, and so is
// the state's reason, each withheld whole when it looks like it embeds a local path, address or credential.

import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	type EndoCockpitCapabilityStateV0,
	type EndoCockpitCapabilityViewV0,
	type EndoCockpitEvidenceViewV0,
	type EndoCockpitNoteV0,
	type EndoCockpitRefV0,
} from "../../protocol/cockpit.ts";
import { ENDO_COCKPIT_CHECK_COST_V0, ENDO_COCKPIT_WITHHELD_EVIDENCE_FIELDS_V0 } from "../../protocol/cockpit-fields.ts";
import {
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateEntryV0,
	endoCapabilityStatusForV0,
} from "../../protocol/harness.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import {
	cleanRegistryRecordsV0,
	type EndoCockpitAliasesV0,
	type EndoCockpitIndexedV0,
	type EndoCockpitRegistryInputV0,
	noteV0,
	presentableTextV0,
	registryAliasesV0,
	registryRefV0,
} from "./common.ts";

function evidenceView(
	alias: EndoCockpitAliasesV0,
	attachment: string,
	item: EndoCockpitIndexedV0<EndoCapabilityEvidenceV0>,
): EndoCockpitEvidenceViewV0 {
	const { record, index } = item;
	return {
		ref: registryRefV0(alias, attachment, "evidence", index, record.id),
		id: alias.id(record.id),
		check: {
			name: presentableTextV0(record.check.name),
			version: presentableTextV0(record.check.version),
			kind: record.check.kind,
		},
		at: record.at,
		classification: record.classification,
		dependencies: {
			fingerprintId: alias.id(record.dependencies.fingerprintId),
			identityDigest: alias.digest("identity", record.dependencies.identityDigest),
			confidence: record.dependencies.confidence,
			adapterVersion: presentableTextV0(record.dependencies.adapterVersion),
			mappingVersion: presentableTextV0(record.dependencies.mappingVersion),
			suiteVersion: presentableTextV0(record.dependencies.suiteVersion),
			configurationDigest: alias.digest("configuration", record.dependencies.configurationDigest),
			extension:
				record.dependencies.extension === null
					? null
					: {
							id: presentableTextV0(record.dependencies.extension.id),
							version: presentableTextV0(record.dependencies.extension.version),
						},
		},
		supporting: record.evidence.map((item) =>
			/^[0-9a-f]{64}$/.test(item) ? alias.digest("supporting", item) : alias.id(item),
		),
		withheld: [...ENDO_COCKPIT_WITHHELD_EVIDENCE_FIELDS_V0],
	};
}

/** The capability state projection of one attachment. */
export function projectEndoCockpitCapabilityStateV0(
	input: EndoCockpitRegistryInputV0,
	digestKey: EndoDigestKeyV0,
): EndoCockpitCapabilityStateV0 {
	const { source, records } = input;
	const alias = registryAliasesV0(source, digestKey);
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

	const fingerprints = cleanRegistryRecordsV0(source, alias, "fingerprint", records.fingerprint, notes);
	const evidence = cleanRegistryRecordsV0(source, alias, "evidence", records.evidence, notes);
	// A state record has no id of its own, so only its attachment is checked.
	const states = cleanRegistryRecordsV0(source, alias, "state", records.state, notes);
	const latest = states.at(-1) ?? null;
	if (latest === null) {
		notes.push(noteV0("no-capability-state-recorded"));
		return { ...base, state: null, capabilities: [], notes };
	}

	const state = latest.record;
	const stateRef = registryRefV0(alias, attachment, "state", latest.index, null);
	const newest = fingerprints.at(-1) ?? null;
	const named = fingerprints.find((item) => item.record.id === state.fingerprintId) ?? null;
	const newestRef =
		newest === null ? null : registryRefV0(alias, attachment, "fingerprint", newest.index, newest.record.id);
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
			cited === null ? null : registryRefV0(alias, attachment, "evidence", cited.index, cited.record.id);

		if (entry.status !== "unverified") {
			if (currency === "stale")
				limits.push({ code: "state-not-for-latest-fingerprint", refs: [stateRef, newestRef!] });
			if (newest === null) limits.push({ code: "state-without-fingerprint", refs: [stateRef] });
			if (entry.classification !== null && endoCapabilityStatusForV0(entry.classification) !== entry.status)
				limits.push({ code: "status-classification-mismatch", refs: [stateRef] });
			if (state.fingerprintId !== null && named === null)
				limits.push({ code: "state-fingerprint-not-recorded", refs: [stateRef] });
			const differing: EndoCockpitRefV0[] = [];
			if (cited !== null && cited.record.runtime !== state.runtime) differing.push(citedRef!);
			if (named !== null && named.record.runtime !== state.runtime)
				differing.push(registryRefV0(alias, attachment, "fingerprint", named.index, named.record.id));
			if (newest !== null && newest !== named && newest.record.runtime !== state.runtime) differing.push(newestRef!);
			if (differing.length > 0) limits.push({ code: "runtime-differs", refs: [stateRef, ...differing] });
			if (cited === null) limits.push({ code: "evidence-record-missing", refs: [stateRef] });
			else {
				const refs = [stateRef, citedRef!];
				if (ENDO_COCKPIT_CHECK_COST_V0[cited.record.check.kind] < ENDO_COCKPIT_CHECK_COST_V0[entry.requires])
					limits.push({ code: "evidence-check-insufficient", refs });
				if (cited.record.capability !== entry.capability)
					limits.push({ code: "evidence-capability-differs", refs });
				if (cited.record.classification !== entry.classification)
					limits.push({ code: "evidence-classification-differs", refs });
				if (named !== null) {
					const namedRef = registryRefV0(alias, attachment, "fingerprint", named.index, named.record.id);
					if (cited.record.dependencies.identityDigest !== named.record.identity.digest)
						limits.push({ code: "evidence-identity-differs", refs: [...refs, namedRef] });
					// Same fingerprint id or not, the evidence's confidence is a claim about the identity record it names.
					if (cited.record.dependencies.confidence !== named.record.identity.confidence)
						limits.push({ code: "evidence-confidence-differs", refs: [...refs, namedRef] });
					const carried = cited.record.dependencies.fingerprintId !== named.record.id;
					if (
						carried &&
						(cited.record.dependencies.confidence === "reduced" || named.record.identity.confidence === "reduced")
					)
						limits.push({ code: "evidence-reduced-identity", refs: [...refs, namedRef] });
				}
			}
		}

		// One canonical order (ENDO_COCKPIT_LIMIT_CODES_V0): the contract has one form of a limit list.
		limits.sort((a, b) => ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(a.code) - ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(b.code));
		capabilities.push({
			capability: alias.kind(entry.capability),
			status: entry.status,
			classification: entry.classification,
			reason: presentableTextV0(entry.reason),
			requires: entry.requires,
			evidence: cited === null ? null : evidenceView(alias, attachment, cited),
			limitations: cited === null ? [] : cited.record.limitations.map(presentableTextV0),
			limits,
			ref: stateRef,
		});
	}

	return {
		...base,
		state: {
			ref: stateRef,
			recordedAt: state.at,
			fingerprintId: state.fingerprintId === null ? null : alias.id(state.fingerprintId),
			latestFingerprintId: newest === null ? null : alias.id(newest.record.id),
			currency,
		},
		capabilities,
		notes,
	};
}
