// The runtime identity projection: one attachment's recorded identity, last change and last notice, from the validated
// records of its harness registry. Pure and deterministic: no file, clock or environment is read, and the input is not
// modified. It repeats what the registry recorded and derives only comparisons between those records.
//
// What is presented, and the basis of each claim:
//  - the runtime family: observed (the attachment recorded it with the fingerprint);
//  - the identity digest and confidence: derived (computed by the attachment from the observed facts);
//  - the entrypoint digest and package name/version: observed locally;
//  - the version: reported by the runtime itself;
//  - a fact the fingerprint lists as a gap: unavailable, with a fixed reason (the recorded reason can name paths).
// What is withheld: local paths (requested, resolved, real, package root), the version command's raw output, a
// collection failure's text, and a notification's lines (they embed paths and failure text). A notification's title is
// presented unless it looks like it embeds a path, address or credential.

import {
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	type EndoCockpitChangeViewV0,
	type EndoCockpitClaimV0,
	type EndoCockpitFingerprintViewV0,
	type EndoCockpitNoteV0,
	type EndoCockpitNotificationViewV0,
	type EndoCockpitObservationViewV0,
	type EndoCockpitRuntimeIdentityV0,
} from "../../protocol/cockpit.ts";
import {
	ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0,
	ENDO_COCKPIT_NO_RUNTIME_REASON_V0,
	ENDO_COCKPIT_WITHHELD_FINGERPRINT_FIELDS_V0,
	endoCockpitTextPresentableV0,
	endoCockpitUnreadableRuntimeReasonV0,
} from "../../protocol/cockpit-fields.ts";
import type {
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
	EndoHarnessObservationRefV0,
} from "../../protocol/harness.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import {
	claimV0,
	cleanRegistryRecordsV0,
	type EndoCockpitAliasesV0,
	type EndoCockpitIndexedV0,
	type EndoCockpitRegistryInputV0,
	looksSensitiveTextV0,
	noteV0,
	presentableTextV0,
	registryAliasesV0,
	registryRefV0,
	unavailableV0,
} from "./common.ts";

const GAP_REASON = ENDO_COCKPIT_FINGERPRINT_GAP_REASON_V0;
const WITHHELD_TEXT = ENDO_COCKPIT_WITHHELD_TEXT_V0;

function observationView(alias: EndoCockpitAliasesV0, ref: EndoHarnessObservationRefV0): EndoCockpitObservationViewV0 {
	return {
		fingerprintId: alias.id(ref.fingerprintId),
		identityDigest: alias.digest("identity", ref.identityDigest),
		confidence: ref.confidence,
		version: ref.version === null ? null : presentableTextV0(ref.version),
	};
}

function fingerprintView(
	alias: EndoCockpitAliasesV0,
	attachment: string,
	item: EndoCockpitIndexedV0<EndoHarnessFingerprintV0>,
): EndoCockpitFingerprintViewV0 {
	const { record, index } = item;
	const ref = registryRefV0(alias, attachment, "fingerprint", index, record.id);
	const refs = [ref];
	return {
		ref,
		id: alias.id(record.id),
		observedAt: record.observedAt,
		identity: claimV0(
			"derived",
			{ digest: alias.digest("identity", record.identity.digest), confidence: record.identity.confidence },
			refs,
		),
		version:
			record.reported.version === null
				? unavailableV0(GAP_REASON, refs)
				: !endoCockpitTextPresentableV0(record.reported.version)
					? unavailableV0(WITHHELD_TEXT, refs)
					: claimV0("reported", record.reported.version, refs),
		entrypoint:
			record.local.entrypoint === null
				? unavailableV0(GAP_REASON, refs)
				: claimV0(
						"observed",
						{ sha256: record.local.entrypoint.sha256, bytes: record.local.entrypoint.bytes },
						refs,
					),
		package:
			record.local.package === null
				? unavailableV0(GAP_REASON, refs)
				: !endoCockpitTextPresentableV0(record.local.package.name) ||
						!endoCockpitTextPresentableV0(record.local.package.version)
					? unavailableV0(WITHHELD_TEXT, refs)
					: claimV0("observed", { name: record.local.package.name, version: record.local.package.version }, refs),
		withheld: [...ENDO_COCKPIT_WITHHELD_FINGERPRINT_FIELDS_V0],
	};
}

function changeView(
	alias: EndoCockpitAliasesV0,
	attachment: string,
	item: EndoCockpitIndexedV0<EndoHarnessChangeV0>,
): EndoCockpitChangeViewV0 {
	const { record, index } = item;
	return {
		ref: registryRefV0(alias, attachment, "change", index, record.id),
		id: alias.id(record.id),
		at: record.at,
		kind: record.kind,
		differences: [...record.differences],
		versionOrder: record.versionOrder,
		previous: record.previous === null ? null : observationView(alias, record.previous),
		current: record.current === null ? null : observationView(alias, record.current),
		failure: record.failure === undefined ? "none" : "withheld",
	};
}

function notificationView(
	alias: EndoCockpitAliasesV0,
	attachment: string,
	item: EndoCockpitIndexedV0<EndoHarnessNotificationV0>,
): EndoCockpitNotificationViewV0 {
	const { record, index } = item;
	return {
		ref: registryRefV0(alias, attachment, "notification", index, record.id),
		id: alias.id(record.id),
		at: record.at,
		kind: record.kind,
		changeId: alias.id(record.changeId),
		title: presentableTextV0(record.title),
		lineCount: record.lines.length,
		linesWithheld: true,
	};
}

/** The runtime identity projection of one attachment. */
export function projectEndoCockpitRuntimeIdentityV0(
	input: EndoCockpitRegistryInputV0,
	digestKey: EndoDigestKeyV0,
): EndoCockpitRuntimeIdentityV0 {
	const { source, records } = input;
	const alias = registryAliasesV0(source, digestKey);
	const attachment = source.attachment;
	const notes: EndoCockpitNoteV0[] = [];
	const base = {
		schemaVersion: "endo.cockpit-runtime-identity.v0" as const,
		projectionVersion: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.runtimeIdentity,
		source,
	};

	if (records === null) {
		notes.push(noteV0("source-not-projectable"));
		return {
			...base,
			runtime: unavailableV0(endoCockpitUnreadableRuntimeReasonV0(source.condition.state)),
			current: null,
			previousDifferent: null,
			lastChange: null,
			lastNotification: null,
			notes,
		};
	}

	const fingerprints = cleanRegistryRecordsV0(source, alias, "fingerprint", records.fingerprint, notes);
	const changes = cleanRegistryRecordsV0(source, alias, "change", records.change, notes);
	const notifications = cleanRegistryRecordsV0(source, alias, "notification", records.notification, notes);

	const current = fingerprints.at(-1) ?? null;
	let previousDifferent: EndoCockpitIndexedV0<EndoHarnessFingerprintV0> | null = null;
	if (current !== null) {
		for (let at = fingerprints.length - 2; at >= 0; at -= 1) {
			const candidate = fingerprints[at]!;
			if (candidate.record.identity.digest !== current.record.identity.digest) {
				previousDifferent = candidate;
				break;
			}
		}
	}
	const lastChange = changes.at(-1) ?? null;
	const lastNotification = notifications.at(-1) ?? null;

	if (current === null) notes.push(noteV0("no-fingerprint-recorded"));
	if (lastChange !== null && lastChange.record.kind === "collection-failed") {
		notes.push(
			noteV0("latest-change-is-collection-failure", [
				registryRefV0(alias, attachment, "change", lastChange.index, lastChange.record.id),
			]),
		);
	} else if (
		lastChange !== null &&
		current !== null &&
		lastChange.record.current?.fingerprintId !== current.record.id
	) {
		notes.push(
			noteV0("latest-change-not-for-latest-fingerprint", [
				registryRefV0(alias, attachment, "change", lastChange.index, lastChange.record.id),
				registryRefV0(alias, attachment, "fingerprint", current.index, current.record.id),
			]),
		);
	}
	if (lastNotification !== null && !changes.some((change) => change.record.id === lastNotification.record.changeId)) {
		notes.push(
			noteV0("notification-change-missing", [
				registryRefV0(alias, attachment, "notification", lastNotification.index, lastNotification.record.id),
			]),
		);
	}

	// The runtime family is one value per attachment; records that disagree are noted, and the latest fingerprint's wins.
	const families = new Map<
		string,
		EndoCockpitIndexedV0<{ runtime: string; id: string }> & { kind: "fingerprint" | "change" }
	>();
	for (const item of fingerprints) families.set(item.record.runtime, { ...item, kind: "fingerprint" });
	for (const item of changes)
		if (!families.has(item.record.runtime)) families.set(item.record.runtime, { ...item, kind: "change" });
	if (families.size > 1) {
		notes.push(
			noteV0(
				"runtime-disagreement",
				[...families.values()].map((item) =>
					registryRefV0(alias, attachment, item.kind, item.index, item.record.id),
				),
			),
		);
	}
	const recordedFamily = current?.record.runtime ?? lastChange?.record.runtime ?? null;
	// A family is a well-formed kind whatever it says; one the text policy flags is withheld, not presented.
	const familyWithheld = recordedFamily !== null && looksSensitiveTextV0(recordedFamily);
	const family = familyWithheld ? null : recordedFamily;
	const runtime: EndoCockpitClaimV0<string> =
		family === null
			? unavailableV0(familyWithheld ? WITHHELD_TEXT : ENDO_COCKPIT_NO_RUNTIME_REASON_V0)
			: claimV0(
					"observed",
					family,
					current !== null
						? [registryRefV0(alias, attachment, "fingerprint", current.index, current.record.id)]
						: [registryRefV0(alias, attachment, "change", lastChange!.index, lastChange!.record.id)],
				);

	return {
		...base,
		runtime,
		current: current === null ? null : fingerprintView(alias, attachment, current),
		previousDifferent: previousDifferent === null ? null : fingerprintView(alias, attachment, previousDifferent),
		lastChange: lastChange === null ? null : changeView(alias, attachment, lastChange),
		lastNotification: lastNotification === null ? null : notificationView(alias, attachment, lastNotification),
		notes,
	};
}
