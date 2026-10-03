// The Pi attachment's evidence rules: comparing fingerprints, wording notifications, building evidence records, and
// deciding which evidence still applies. Pure functions over protocol records; the attachment service (attachment.ts)
// persists what they return.
//
// Evidence validity, explicitly. A capability evidence record applies to the current attachment only when ALL hold:
//   1. the current runtime was identified (a fingerprint exists for this attachment now);
//   2. its identity digest equals the current identity digest;
//   3. its identity was "strong" and the current identity is "strong" — or it was recorded against the very
//      fingerprint record that is current (same observation). Reduced identities are never carried across
//      observations: two different runtimes could share a reduced digest;
//   4. adapterVersion, mappingVersion and suiteVersion equal the current adapter's;
//   5. its check's definition digest equals the current definition of that check (one changed check invalidates only
//      its own evidence);
//   6. its configuration digest equals the current configuration digest for that check kind. Every kind depends on
//      the digest of Pi's user configuration that changes behaviour (configuration.ts: settings, models, MCP servers,
//      system-prompt files, extensions); a live study also depends on provider, model and tool selection;
//   7. its extension dependency equals the current one (none in this adapter version).
//
// Combining the records that apply (derivePiCapabilityStateV0). No check kind outranks another by default: a live
// study is narrower in scope (one provider, one model, one scratch workspace) as often as it is stronger, so it must
// not silently replace broader protocol evidence. Per capability:
//   a. take the latest applicable record of each check (a re-run replaces that check's earlier result);
//   b. drop a record only when another remaining record's check explicitly declares, in its definition, that it
//      supersedes that check for this capability (`supersedes`; the declaration is part of the definition digest, so
//      changing it invalidates the declaring check's evidence);
//   c. the most conservative classification among what remains decides: MISMATCH, then UNAVAILABLE, PARTIAL,
//      QUALIFIED, EXACT; ties go to the latest record. Disagreeing results are named in the reason.
// When no record applies the capability is UNVERIFIED, whatever older evidence said and whether or not Pi starts. A
// version string is never enough: it is one input to the identity digest, not a substitute for it.

import type { EndoConformanceClassificationV0 } from "../../protocol/evaluation.ts";
import {
	type EndoCapabilityCheckKindV0,
	type EndoCapabilityDependenciesV0,
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateEntryV0,
	type EndoCapabilityStateV0,
	type EndoHarnessChangeV0,
	type EndoHarnessDifferenceV0,
	type EndoHarnessFingerprintV0,
	type EndoHarnessNotificationV0,
	type EndoHarnessObservationRefV0,
	type EndoHarnessVersionOrderV0,
	endoCapabilityStatusForV0,
	validateEndoCapabilityEvidenceV0,
	validateEndoCapabilityStateV0,
	validateEndoHarnessChangeV0,
	validateEndoHarnessNotificationV0,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { PI_CAPABILITIES_V0 } from "./capabilities.ts";
import {
	compareSemverV0,
	PI_ADAPTER_VERSION,
	PI_MAPPING_VERSION,
	PI_SUITE_VERSION,
	parseSemverV0,
	piVersionStandingV0,
} from "./version.ts";

function contentId(prefix: string, body: unknown): string {
	return `endo.evidence.${prefix}.${sha256HexV0(canonicalEndoJsonV0(body))}`;
}

function observationRef(fingerprint: EndoHarnessFingerprintV0): EndoHarnessObservationRefV0 {
	return {
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		confidence: fingerprint.identity.confidence,
		version: fingerprint.reported.version,
		realPath: fingerprint.local.realPath,
	};
}

function versionOrder(previous: string | null, current: string | null): EndoHarnessVersionOrderV0 {
	if (previous === null || current === null) return "unknown";
	const a = parseSemverV0(previous);
	const b = parseSemverV0(current);
	if (a === null || b === null) return "incomparable";
	const order = compareSemverV0(b, a);
	return order === 0 ? "equal" : order > 0 ? "higher" : "lower";
}

/** Which identity facts differ between two fingerprints, in a fixed order. */
export function piFingerprintDifferencesV0(
	previous: EndoHarnessFingerprintV0,
	current: EndoHarnessFingerprintV0,
): EndoHarnessDifferenceV0[] {
	const differences: EndoHarnessDifferenceV0[] = [];
	if (previous.local.realPath !== current.local.realPath) differences.push("realPath");
	if ((previous.local.entrypoint?.sha256 ?? null) !== (current.local.entrypoint?.sha256 ?? null))
		differences.push("entrypoint");
	if (
		(previous.local.package?.name ?? null) !== (current.local.package?.name ?? null) ||
		(previous.local.package?.version ?? null) !== (current.local.package?.version ?? null)
	)
		differences.push("package");
	if (previous.reported.version !== current.reported.version) differences.push("version");
	if (previous.identity.confidence !== current.identity.confidence) differences.push("confidence");
	return differences;
}

/**
 * Compare the current observation with the last recorded one. Deterministic: the same inputs give the same record
 * (the id is content-addressed). `current` null means collection failed, with `failure` saying why.
 */
export function piChangeV0(args: {
	attachment: string;
	previous: EndoHarnessFingerprintV0 | null;
	current: EndoHarnessFingerprintV0 | null;
	failure?: string;
	at: string;
}): EndoHarnessChangeV0 {
	const { attachment, previous, current, at } = args;
	let body: Omit<EndoHarnessChangeV0, "id">;
	if (current === null) {
		body = {
			schemaVersion: "endo.harness-change.v0",
			attachment,
			runtime: "pi",
			at,
			kind: "collection-failed",
			previous: previous === null ? null : observationRef(previous),
			current: null,
			differences: [],
			versionOrder: "unknown",
			failure: (args.failure ?? "the runtime could not be identified").slice(0, 2048),
		};
	} else if (previous === null) {
		body = {
			schemaVersion: "endo.harness-change.v0",
			attachment,
			runtime: "pi",
			at,
			kind: "first-observation",
			previous: null,
			current: observationRef(current),
			differences: [],
			versionOrder: "unknown",
		};
	} else {
		const same = previous.identity.digest === current.identity.digest;
		const differences = same ? [] : piFingerprintDifferencesV0(previous, current);
		// A differing digest with no listed difference cannot happen for digests computed from the listed facts; if it
		// ever did, the record would fail validation rather than claim "changed" without saying what changed.
		body = {
			schemaVersion: "endo.harness-change.v0",
			attachment,
			runtime: "pi",
			at,
			kind: same ? "unchanged" : "changed",
			previous: observationRef(previous),
			current: observationRef(current),
			differences,
			versionOrder: versionOrder(previous.reported.version, current.reported.version),
		};
	}
	const record = { ...body, id: contentId("pi-change", body) };
	const validated = validateEndoHarnessChangeV0(record);
	if (validated === null) throw new TypeError("the Pi runtime change record failed validation");
	return validated;
}

function describe(ref: EndoHarnessObservationRefV0 | null): string {
	if (ref === null) return "nothing recorded";
	return `${ref.version ?? "version unknown"} / fingerprint ${ref.identityDigest.slice(0, 12)} (${ref.confidence} identity)${
		ref.realPath === null ? "" : ` at ${ref.realPath}`
	}`;
}

/** The fixed sentence every notification ends with: Endophasia does not manage the runtime. */
export const PI_NOT_MANAGED_LINE =
	"Endophasia will not install, update, downgrade or replace Pi. If you want a different version, use your normal installation method.";

/**
 * The operator notice for a change, or null when nothing changed. The wording is neutral: a different fingerprint
 * says the runtime differs, never why, and never that an update is available or needed.
 */
export function piNotificationV0(change: EndoHarnessChangeV0): EndoHarnessNotificationV0 | null {
	if (change.kind === "unchanged") return null;
	let kind: EndoHarnessNotificationV0["kind"];
	let title: string;
	let lines: string[];
	if (change.kind === "collection-failed") {
		kind = "runtime-unidentified";
		title = "Pi runtime could not be identified";
		lines = [
			`Failure: ${change.failure}`,
			`Last recorded: ${describe(change.previous)}`,
			"No earlier conformance evidence is applied while the runtime is unidentified. Every capability is unverified.",
			PI_NOT_MANAGED_LINE,
		];
	} else if (change.kind === "first-observation") {
		kind = "runtime-first-observed";
		title = "Pi runtime observed for the first time";
		const standing = piVersionStandingV0(change.current?.version ?? null);
		lines = [
			`Detected: ${describe(change.current)}`,
			`Version standing: ${standing} (informational; no capability is admitted or refused because of the version)`,
			"No conformance evidence exists yet. Capabilities are unverified until checks record evidence.",
			PI_NOT_MANAGED_LINE,
		];
	} else {
		kind = "runtime-changed";
		title = "Pi runtime changed";
		const standing = piVersionStandingV0(change.current?.version ?? null);
		lines = [
			`Previously observed: ${describe(change.previous)}`,
			`Currently detected: ${describe(change.current)}`,
			`Differences: ${change.differences.join(", ")}; version order: ${change.versionOrder}; version standing: ${standing}`,
			"Previous conformance evidence may no longer apply. Capabilities dependent on that evidence are now unverified.",
			PI_NOT_MANAGED_LINE,
		];
	}
	const body = {
		schemaVersion: "endo.harness-notification.v0" as const,
		attachment: change.attachment,
		at: change.at,
		kind,
		changeId: change.id,
		title,
		lines,
	};
	const record = { ...body, id: contentId("pi-notification", body) };
	const validated = validateEndoHarnessNotificationV0(record);
	if (validated === null) throw new TypeError("the Pi notification failed validation");
	return validated;
}

/** A conformance check's declared definition. Its digest is the check's evidence dependency. */
export interface PiCheckDefinitionV0 {
	readonly name: string;
	readonly version: string;
	readonly kind: EndoCapabilityCheckKindV0;
	readonly capabilities: readonly string[];
	/** What the check sends and asserts, in words; part of the digest, so rewording a check is a new definition. */
	readonly procedure: string;
	/**
	 * Per capability, the checks whose results this check supersedes because it re-tests the same property in a
	 * strictly broader way. Only listed pairs are superseded; everything else is combined conservatively.
	 */
	readonly supersedes?: Readonly<Record<string, readonly string[]>>;
}

export function piCheckDefinitionDigestV0(definition: PiCheckDefinitionV0): string {
	const supersedes: Record<string, string[]> = {};
	for (const [capability, checks] of Object.entries(definition.supersedes ?? {})) supersedes[capability] = [...checks];
	return sha256HexV0(canonicalEndoJsonV0({ ...definition, capabilities: [...definition.capabilities], supersedes }));
}

/**
 * The configuration a check kind depends on. Every kind depends on the digest of Pi's behaviour-relevant user
 * configuration (configuration.ts); a live study also on provider, model and tool selection.
 */
export function piConfigurationDigestV0(
	kind: EndoCapabilityCheckKindV0,
	configuration: {
		provider?: string;
		model?: string;
		tools?: readonly string[] | "default" | "none";
		/** piUserConfigurationDigestV0() of the environment Pi runs with; null when it could not be read. */
		piConfiguration?: string | null;
	},
): string {
	const piConfiguration = configuration.piConfiguration ?? null;
	if (kind !== "live-study") return sha256HexV0(canonicalEndoJsonV0({ kind, piConfiguration }));
	return sha256HexV0(
		canonicalEndoJsonV0({
			kind,
			piConfiguration,
			provider: configuration.provider ?? null,
			model: configuration.model ?? null,
			tools: Array.isArray(configuration.tools) ? [...configuration.tools] : (configuration.tools ?? "default"),
		}),
	);
}

/** The current dependency values for one check against one fingerprint. */
export function piDependenciesV0(
	fingerprint: EndoHarnessFingerprintV0,
	configurationDigest: string,
): EndoCapabilityDependenciesV0 {
	return {
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		confidence: fingerprint.identity.confidence,
		adapterVersion: PI_ADAPTER_VERSION,
		mappingVersion: PI_MAPPING_VERSION,
		suiteVersion: PI_SUITE_VERSION,
		configurationDigest,
		extension: null,
	};
}

/** Build one validated evidence record. Its id is content-addressed. */
export function piEvidenceV0(args: {
	attachment: string;
	capability: string;
	definition: PiCheckDefinitionV0;
	dependencies: EndoCapabilityDependenciesV0;
	inputs: unknown;
	expected: string;
	observed: string;
	classification: EndoConformanceClassificationV0;
	evidence: string[];
	limitations: string[];
	at: string;
}): EndoCapabilityEvidenceV0 {
	const body = {
		schemaVersion: "endo.capability-evidence.v0" as const,
		attachment: args.attachment,
		runtime: "pi",
		capability: args.capability,
		check: {
			name: args.definition.name,
			version: args.definition.version,
			kind: args.definition.kind,
			definitionDigest: piCheckDefinitionDigestV0(args.definition),
		},
		dependencies: args.dependencies,
		inputsDigest: sha256HexV0(canonicalEndoJsonV0(args.inputs ?? null)),
		expected: args.expected.slice(0, 4096),
		observed: args.observed.slice(0, 4096),
		classification: args.classification,
		evidence: args.evidence,
		limitations: args.limitations.map((limitation) => limitation.slice(0, 4096)),
		at: args.at,
	};
	const record = { ...body, id: contentId("pi-capability", body) };
	const validated = validateEndoCapabilityEvidenceV0(record);
	if (validated === null) throw new TypeError(`the ${args.capability} evidence record failed validation`);
	return validated;
}

/** Why one evidence record does or does not apply to the current attachment (rules 1-7 in the module header). */
export function piEvidenceValidityV0(
	evidence: EndoCapabilityEvidenceV0,
	current: {
		fingerprint: EndoHarnessFingerprintV0 | null;
		definitions: ReadonlyMap<string, PiCheckDefinitionV0>;
		configurationDigest: (kind: EndoCapabilityCheckKindV0) => string;
	},
): { valid: true } | { valid: false; reason: string } {
	const { fingerprint } = current;
	if (fingerprint === null) return { valid: false, reason: "the current runtime is unidentified" };
	const dependencies = evidence.dependencies;
	if (dependencies.identityDigest !== fingerprint.identity.digest) {
		return { valid: false, reason: "recorded against a different runtime fingerprint" };
	}
	const sameObservation = dependencies.fingerprintId === fingerprint.id;
	if (!sameObservation && (dependencies.confidence !== "strong" || fingerprint.identity.confidence !== "strong")) {
		return { valid: false, reason: "a reduced-confidence identity cannot carry evidence across observations" };
	}
	if (dependencies.adapterVersion !== PI_ADAPTER_VERSION) return { valid: false, reason: "adapter version changed" };
	if (dependencies.mappingVersion !== PI_MAPPING_VERSION) return { valid: false, reason: "mapping version changed" };
	if (dependencies.suiteVersion !== PI_SUITE_VERSION) return { valid: false, reason: "conformance suite changed" };
	const definition = current.definitions.get(evidence.check.name);
	if (definition === undefined) return { valid: false, reason: `the check ${evidence.check.name} no longer exists` };
	if (piCheckDefinitionDigestV0(definition) !== evidence.check.definitionDigest) {
		return { valid: false, reason: `the check ${evidence.check.name} definition changed` };
	}
	if (dependencies.configurationDigest !== current.configurationDigest(evidence.check.kind)) {
		return { valid: false, reason: "the relevant configuration changed" };
	}
	if (dependencies.extension !== null) return { valid: false, reason: "the extension dependency changed" };
	return { valid: true };
}

const CONSERVATIVE_ORDER: Record<EndoConformanceClassificationV0, number> = {
	MISMATCH: 0,
	UNAVAILABLE: 1,
	PARTIAL: 2,
	QUALIFIED: 3,
	EXACT: 4,
};

/**
 * Derive the capability state from the evidence history (steps a-c in the module header). A pending live study, a
 * runtime or configuration change, or an unidentified runtime all leave capabilities UNVERIFIED.
 */
export function derivePiCapabilityStateV0(args: {
	attachment: string;
	at: string;
	fingerprint: EndoHarnessFingerprintV0 | null;
	evidence: readonly EndoCapabilityEvidenceV0[];
	definitions: ReadonlyMap<string, PiCheckDefinitionV0>;
	configurationDigest: (kind: EndoCapabilityCheckKindV0) => string;
}): EndoCapabilityStateV0 {
	const capabilities: EndoCapabilityStateEntryV0[] = PI_CAPABILITIES_V0.map((capability) => {
		let lastInvalid: string | null = null;
		// a. the latest applicable record of each check, remembering its position for tie-breaking.
		const latest = new Map<string, { record: EndoCapabilityEvidenceV0; index: number }>();
		for (let index = args.evidence.length - 1; index >= 0; index -= 1) {
			const record = args.evidence[index]!;
			if (record.capability !== capability.id || latest.has(record.check.name)) continue;
			const validity = piEvidenceValidityV0(record, args);
			if (!validity.valid) {
				lastInvalid ??= validity.reason;
				continue;
			}
			latest.set(record.check.name, { record, index });
		}
		// b. explicit supersession only, declared by a check that is itself present.
		const superseded = new Set<string>();
		for (const name of latest.keys()) {
			for (const target of args.definitions.get(name)?.supersedes?.[capability.id] ?? []) {
				if (target !== name) superseded.add(target);
			}
		}
		const remaining = [...latest.values()].filter(({ record }) => !superseded.has(record.check.name));
		if (remaining.length > 0) {
			// c. the most conservative classification decides; ties go to the latest record.
			remaining.sort(
				(a, b) =>
					CONSERVATIVE_ORDER[a.record.classification] - CONSERVATIVE_ORDER[b.record.classification] ||
					b.index - a.index,
			);
			const { record } = remaining[0]!;
			const others = remaining.slice(1).map(({ record: other }) => `${other.check.name}=${other.classification}`);
			const reason = [
				`${record.check.kind} check ${record.check.name}`,
				others.length === 0
					? null
					: `${others.some((other) => !other.endsWith(`=${record.classification}`)) ? "most conservative of" : "agrees with"} ${others.join(", ")}`,
				superseded.size === 0 ? null : `supersedes ${[...superseded].join(", ")}`,
				record.limitations.length === 0 ? null : `limits: ${record.limitations.join(" ")}`,
			]
				.filter((part) => part !== null)
				.join("; ")
				.slice(0, 2048);
			return {
				capability: capability.id,
				status: endoCapabilityStatusForV0(record.classification),
				classification: record.classification,
				evidenceId: record.id,
				reason,
				requires: capability.requires,
			};
		}
		const pending =
			capability.requires === "live-study"
				? "needs a live study (explicit operator request: it may cost provider usage and runs agent work)"
				: capability.requires === "local-protocol"
					? "needs the automatic local protocol checks"
					: "needs the documented-surface review of this release, or the live study";
		return {
			capability: capability.id,
			status: "unverified",
			classification: null,
			evidenceId: null,
			reason:
				lastInvalid === null
					? `no evidence yet; ${pending}`
					: `earlier evidence invalid: ${lastInvalid}; ${pending}`,
			requires: capability.requires,
		};
	});
	const state = {
		schemaVersion: "endo.capability-state.v0" as const,
		attachment: args.attachment,
		runtime: "pi",
		at: args.at,
		fingerprintId: args.fingerprint?.id ?? null,
		capabilities,
	};
	const validated = validateEndoCapabilityStateV0(state);
	if (validated === null) throw new TypeError("the derived capability state failed validation");
	return validated;
}
