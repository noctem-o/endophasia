/**
 * Milestone D2 — Codex capability catalogue, evidence construction, and conservative state derivation.
 *
 * Reuses `protocol/harness.ts` (`endo.capability-evidence.v0`, `endo.capability-state.v0`, `endo.harness-change.v1`)
 * and enforces the exact reduced-confidence rule: evidence recorded against a reduced-confidence fingerprint applies
 * ONLY to that exact observation (`dependencies.fingerprintId === current.id`), never carried across observations.
 */

import type { EndoConformanceClassificationV0 } from "../../protocol/evaluation.ts";
import {
	type EndoCapabilityCheckKindV0,
	type EndoCapabilityDependenciesV0,
	type EndoCapabilityEvidenceV0,
	type EndoCapabilityStateEntryV0,
	type EndoCapabilityStateV0,
	type EndoHarnessChangeV1,
	type EndoHarnessDifferenceV1,
	type EndoHarnessFingerprintRecordV0,
	type EndoHarnessObservationRefV1,
	endoCapabilityStatusForV0,
	endoHarnessIdentityBasisNameV0,
	endoHarnessRuntimeContentV0,
	validateEndoCapabilityEvidenceV0,
	validateEndoCapabilityStateV0,
	validateEndoHarnessChangeV1,
} from "../../protocol/harness.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { CODEX_ADAPTER_VERSION_V0, CODEX_MAPPING_VERSION_V0, CODEX_SUITE_VERSION_V0 } from "./identity.ts";

export interface CodexCapabilityV0 {
	readonly id: string;
	readonly meaning: string;
	readonly requires: EndoCapabilityCheckKindV0;
	readonly control: boolean;
}

export const CODEX_CAPABILITIES_V0: readonly CodexCapabilityV0[] = Object.freeze([
	{
		id: "codex.protocol.initialize",
		meaning: "initialize + initialized handshake returns a valid InitializeResponse over stdio JSON-RPC",
		requires: "local-protocol",
		control: false,
	},
	{
		id: "codex.config.read",
		meaning: "config/read reports effective policy, reviewer, sandbox, and configured MCP server set",
		requires: "local-protocol",
		control: false,
	},
	{
		id: "codex.thread.lifecycle",
		meaning:
			"thread/start creates an owned thread with verified non-permissive policy and thread/unsubscribe cleans up",
		requires: "local-protocol",
		control: false,
	},
	{
		id: "codex.turn.start",
		meaning: "turn/start dispatches an operator-authorized prompt on an owned thread and returns a turnId",
		requires: "local-protocol",
		control: true,
	},
	{
		id: "codex.turn.interrupt",
		meaning: "turn/interrupt targets one active turn by (threadId, turnId)",
		requires: "local-protocol",
		control: true,
	},
	{
		id: "codex.turn.steer",
		meaning: "turn/steer injects steering input guarded by an active expectedTurnId precondition",
		requires: "live-study",
		control: true,
	},
]);

export interface CodexCheckDefinitionV0 {
	readonly name: string;
	readonly version: string;
	readonly kind: EndoCapabilityCheckKindV0;
	readonly capabilities: readonly string[];
	readonly procedure: string;
}

export const CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0: CodexCheckDefinitionV0 = Object.freeze({
	name: "codex-app-server-local-protocol",
	version: "1",
	kind: "local-protocol",
	capabilities: [
		"codex.protocol.initialize",
		"codex.config.read",
		"codex.thread.lifecycle",
		"codex.turn.start",
		"codex.turn.interrupt",
	],
	procedure:
		"Spawn codex app-server --listen stdio:// with conservative policy overrides; run initialize, initialized, config/read, ephemeral thread/start (zero model turns), verify effective approvalPolicy/approvalsReviewer/sandbox, run thread/read and thread/unsubscribe.",
});

export function codexCheckDefinitionDigestV0(definition: CodexCheckDefinitionV0): string {
	return sha256HexV0(canonicalEndoJsonV0({ ...definition, capabilities: [...definition.capabilities] }));
}

function contentId(prefix: string, body: unknown): string {
	return `endo.evidence.${prefix}.${sha256HexV0(canonicalEndoJsonV0(body))}`;
}

function observationRef(fingerprint: EndoHarnessFingerprintRecordV0): EndoHarnessObservationRefV1 {
	return {
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		confidence: fingerprint.identity.confidence,
		version: fingerprint.reported.version,
		realPath: fingerprint.local.realPath,
		basis: endoHarnessIdentityBasisNameV0(fingerprint),
	};
}

export function codexFingerprintDifferencesV0(
	previous: EndoHarnessFingerprintRecordV0,
	current: EndoHarnessFingerprintRecordV0,
): EndoHarnessDifferenceV1[] {
	const differences: EndoHarnessDifferenceV1[] = [];
	const crossBasis = endoHarnessIdentityBasisNameV0(previous) !== endoHarnessIdentityBasisNameV0(current);
	if (previous.local.realPath !== current.local.realPath) differences.push("realPath");
	if ((previous.local.entrypoint?.sha256 ?? null) !== (current.local.entrypoint?.sha256 ?? null))
		differences.push("entrypoint");
	if (
		(previous.local.package?.name ?? null) !== (current.local.package?.name ?? null) ||
		(previous.local.package?.version ?? null) !== (current.local.package?.version ?? null)
	)
		differences.push("package");
	if (previous.reported.version !== current.reported.version) differences.push("version");
	const contentKey = (fp: EndoHarnessFingerprintRecordV0) => {
		const rc = endoHarnessRuntimeContentV0(fp);
		return rc === null ? null : `${rc.scope}\n${rc.sha256}`;
	};
	if (!crossBasis && contentKey(previous) !== contentKey(current)) differences.push("runtimeContent");
	if (previous.identity.confidence !== current.identity.confidence) differences.push("confidence");
	if (crossBasis) differences.push("identityBasis");
	return differences;
}

export function codexChangeV0(args: {
	attachment: string;
	previous: EndoHarnessFingerprintRecordV0 | null;
	current: EndoHarnessFingerprintRecordV0 | null;
	failure?: string;
	at: string;
}): EndoHarnessChangeV1 {
	const { attachment, previous, current, at } = args;
	let body: Omit<EndoHarnessChangeV1, "id">;
	if (current === null) {
		body = {
			schemaVersion: "endo.harness-change.v1",
			attachment,
			runtime: "codex",
			at,
			kind: "collection-failed",
			previous: previous === null ? null : observationRef(previous),
			current: null,
			differences: [],
			versionOrder: "unknown",
			failure: (args.failure ?? "the Codex runtime could not be identified").slice(0, 2048),
		};
	} else if (previous === null) {
		body = {
			schemaVersion: "endo.harness-change.v1",
			attachment,
			runtime: "codex",
			at,
			kind: "first-observation",
			previous: null,
			current: observationRef(current),
			differences: [],
			versionOrder: "unknown",
		};
	} else {
		const same =
			previous.identity.digest === current.identity.digest &&
			endoHarnessIdentityBasisNameV0(previous) === endoHarnessIdentityBasisNameV0(current);
		const differences = same ? [] : codexFingerprintDifferencesV0(previous, current);
		body = {
			schemaVersion: "endo.harness-change.v1",
			attachment,
			runtime: "codex",
			at,
			kind: same ? "unchanged" : "changed",
			previous: observationRef(previous),
			current: observationRef(current),
			differences,
			versionOrder: "unknown",
		};
	}
	const record = { ...body, id: contentId("codex-change", body) };
	const validated = validateEndoHarnessChangeV1(record);
	if (validated === null) throw new TypeError("Codex harness change record failed protocol validation");
	return validated;
}

export function codexDependenciesV0(
	fingerprint: EndoHarnessFingerprintRecordV0,
	configurationDigest: string,
): EndoCapabilityDependenciesV0 {
	return {
		fingerprintId: fingerprint.id,
		identityDigest: fingerprint.identity.digest,
		confidence: fingerprint.identity.confidence,
		adapterVersion: CODEX_ADAPTER_VERSION_V0,
		mappingVersion: CODEX_MAPPING_VERSION_V0,
		suiteVersion: CODEX_SUITE_VERSION_V0,
		configurationDigest,
		extension: null,
	};
}

export function codexEvidenceV0(args: {
	attachment: string;
	capability: string;
	definition: CodexCheckDefinitionV0;
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
		runtime: "codex",
		capability: args.capability,
		check: {
			name: args.definition.name,
			version: args.definition.version,
			kind: args.definition.kind,
			definitionDigest: codexCheckDefinitionDigestV0(args.definition),
		},
		dependencies: args.dependencies,
		inputsDigest: sha256HexV0(canonicalEndoJsonV0(args.inputs as never)),
		expected: args.expected.slice(0, 4096),
		observed: args.observed.slice(0, 4096),
		classification: args.classification,
		evidence: [...args.evidence],
		limitations: args.limitations.map((l) => l.slice(0, 4096)),
		at: args.at,
	};
	const record = { ...body, id: contentId("codex-capability", body) };
	const validated = validateEndoCapabilityEvidenceV0(record);
	if (validated === null) throw new TypeError(`Codex capability evidence for ${args.capability} failed validation`);
	return validated;
}

const RANK: Readonly<Record<EndoConformanceClassificationV0, number>> = {
	MISMATCH: 0,
	UNAVAILABLE: 1,
	PARTIAL: 2,
	QUALIFIED: 3,
	EXACT: 4,
};

/**
 * Derive current `endo.capability-state.v0` for Codex.
 * Strictly enforces reduced-confidence non-carryover: if `currentFingerprint.identity.confidence === "reduced"`,
 * ONLY evidence with `dependencies.fingerprintId === currentFingerprint.id` applies.
 */
export function deriveCodexCapabilityStateV0(args: {
	attachment: string;
	currentFingerprint: EndoHarnessFingerprintRecordV0 | null;
	evidence: readonly EndoCapabilityEvidenceV0[];
	configurationDigest: string;
	expectedCheckDigests?: Readonly<Record<string, string>>;
	at: string;
}): EndoCapabilityStateV0 {
	const fp = args.currentFingerprint;
	const checkDigests = args.expectedCheckDigests ?? {
		[CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0.name]: codexCheckDefinitionDigestV0(CODEX_LOCAL_PROTOCOL_CHECK_DEF_V0),
	};

	const applies = (ev: EndoCapabilityEvidenceV0): boolean => {
		if (fp === null) return false;
		if (ev.attachment !== args.attachment || ev.runtime !== "codex") return false;
		if (ev.dependencies.identityDigest !== fp.identity.digest) return false;
		const sameObservation = ev.dependencies.fingerprintId === fp.id;
		if (!sameObservation && (fp.identity.confidence !== "strong" || ev.dependencies.confidence !== "strong")) {
			return false;
		}
		if (
			ev.dependencies.adapterVersion !== CODEX_ADAPTER_VERSION_V0 ||
			ev.dependencies.mappingVersion !== CODEX_MAPPING_VERSION_V0 ||
			ev.dependencies.suiteVersion !== CODEX_SUITE_VERSION_V0
		) {
			return false;
		}
		if (ev.dependencies.configurationDigest !== args.configurationDigest) return false;
		const expectedDigest = checkDigests[ev.check.name];
		if (expectedDigest !== undefined && ev.check.definitionDigest !== expectedDigest) return false;
		return true;
	};

	const applicable = args.evidence.filter(applies);

	const capabilities: EndoCapabilityStateEntryV0[] = CODEX_CAPABILITIES_V0.map((cap) => {
		if (fp === null) {
			return {
				capability: cap.id,
				status: "unverified",
				classification: null,
				evidenceId: null,
				reason: "No Codex runtime fingerprint has been observed.",
				requires: cap.requires,
			};
		}
		const matching = applicable.filter((e) => e.capability === cap.id);
		if (matching.length === 0) {
			return {
				capability: cap.id,
				status: "unverified",
				classification: null,
				evidenceId: null,
				reason: `No current conformance evidence exists for ${cap.id} on this observation.`,
				requires: cap.requires,
			};
		}
		// Take latest per check name, then pick most conservative classification.
		const latestByCheck = new Map<string, EndoCapabilityEvidenceV0>();
		for (const item of matching) latestByCheck.set(item.check.name, item);
		let chosen: EndoCapabilityEvidenceV0 | null = null;
		for (const item of latestByCheck.values()) {
			if (chosen === null || RANK[item.classification] <= RANK[chosen.classification]) {
				chosen = item;
			}
		}
		const c = chosen!;
		const status = endoCapabilityStatusForV0(c.classification);
		const reason =
			c.limitations.length > 0 ? `${c.observed} (${c.limitations[0]})`.slice(0, 512) : c.observed.slice(0, 512);
		return {
			capability: cap.id,
			status,
			classification: c.classification,
			evidenceId: c.id,
			reason,
			requires: cap.requires,
		};
	});

	const state: EndoCapabilityStateV0 = {
		schemaVersion: "endo.capability-state.v0",
		attachment: args.attachment,
		runtime: "codex",
		at: args.at,
		fingerprintId: fp?.id ?? null,
		capabilities,
	};
	const validated = validateEndoCapabilityStateV0(state);
	if (validated === null) throw new TypeError("derived Codex capability state failed protocol validation");
	return validated;
}
