// The harness attachment v0 schemas: what Endophasia records about an agent harness the user installed and manages
// (README "How it attaches"). Endophasia never installs, updates, downgrades, patches or rebuilds a harness; these
// records only say what was observed, what changed since the last observation, what was checked against the observed
// runtime, and which capabilities that evidence supports.
//
// Five records, deliberately separate (fingerprint and change also have a v1; v0 records stay readable and unchanged):
// - endo.harness-fingerprint.v0: one observation of an installed runtime. It keeps facts gathered from the local
//   installation (paths, an entrypoint digest, package metadata) apart from facts the runtime reported about itself
//   (its version output), and lists every fact it could not collect instead of filling it in.
// - endo.harness-change.v0: the comparison of one observation with the previous one for the same attachment. A change
//   says the runtime differs; it never says why (upgrade, downgrade, rebuild, reinstall and replacement all look
//   alike) and never that an update is available.
// - endo.capability-evidence.v0: one check of one capability against one fingerprint, with every dependency the
//   result rests on, so it can be invalidated precisely when any of them changes.
// - endo.capability-state.v0: the derived capability view at one moment. Derived state, not authority: an admitted
//   capability is one current evidence supports, nothing more. It grants no execution permission.
// - endo.harness-notification.v0: the operator-facing notice a change produces.
//
// Plus the opaque source reference a harness adapter attaches to the events it maps (endo.source-entry-ref.v0): a
// runtime's own entry identifier, kept opaque and separate from Endophasia's event identity and storage sequence.

import { ENDO_CONFORMANCE_CLASSIFICATIONS_V0, type EndoConformanceClassificationV0 } from "./evaluation.ts";
import { isEndoIdentifierV0, isWellFormedKindV0 } from "./identity.ts";
import { isIso8601UtcV0, isPlainJsonObjectV0 } from "./primitives.ts";
import { defineEndoVersionTableV0 } from "./versioned.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && SHA256_HEX.test(value);
}

function isText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isPlain(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && isPlainJsonObjectV0(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isEvidenceId(value: unknown): value is string {
	return typeof value === "string" && isEndoIdentifierV0(value, "evidence");
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------------------------------

/** How a fingerprint fact was collected. A fingerprint lists exactly the methods it used. */
export type EndoHarnessFingerprintMethodV0 =
	| "explicit-path"
	| "path-search"
	| "realpath"
	| "entrypoint-sha256"
	| "package-manifest"
	| "version-command";

export const ENDO_HARNESS_FINGERPRINT_METHODS_V0 = [
	"explicit-path",
	"path-search",
	"realpath",
	"entrypoint-sha256",
	"package-manifest",
	"version-command",
] as const satisfies readonly EndoHarnessFingerprintMethodV0[];

/** A fact a fingerprint may lack. Each missing fact is listed in `gaps` with the reason it is missing. */
export type EndoHarnessFingerprintFactV0 = "resolvedPath" | "realPath" | "entrypoint" | "package" | "version";

export const ENDO_HARNESS_FINGERPRINT_FACTS_V0 = [
	"resolvedPath",
	"realPath",
	"entrypoint",
	"package",
	"version",
] as const satisfies readonly EndoHarnessFingerprintFactV0[];

/**
 * How strongly the identity digest identifies the runtime. "strong": the entrypoint's content digest and the reported
 * version are both present. "reduced": at least one of them is missing, so two different runtimes could share the
 * digest; evidence recorded under a reduced identity is never reused for a later attachment.
 */
export type EndoHarnessIdentityConfidenceV0 = "strong" | "reduced";

/** Facts gathered from the local installation, never from the runtime's own report. */
export interface EndoHarnessLocalFactsV0 {
	/** What the operator asked for: an explicit path, or the command name searched on PATH. */
	requested: string;
	/** The executable path the request resolved to, or null when resolution failed. */
	resolvedPath: string | null;
	/** The resolved path with every symlink followed, or null. */
	realPath: string | null;
	/**
	 * The SHA-256 and size of the file at realPath (the entrypoint), or null. Scope: that one file. When the
	 * entrypoint loads other files (a launcher script, a bundle's dependencies), their content is not covered.
	 */
	entrypoint: { sha256: string; bytes: number } | null;
	/** The nearest package manifest above the entrypoint, when one was found and declared a name and version. */
	package: { name: string; version: string; root: string } | null;
}

/** Facts the runtime reported about itself. */
export interface EndoHarnessReportedFactsV0 {
	/** The trimmed output of the version command, bounded, or null when it did not run or printed nothing. */
	versionText: string | null;
	/** The version parsed from versionText (semver grammar), or null when it does not parse. */
	version: string | null;
}

export interface EndoHarnessFingerprintV0 {
	schemaVersion: "endo.harness-fingerprint.v0";
	/** Content-addressed endo.evidence.* identifier of this observation. */
	id: string;
	/** The configured attachment this observation belongs to, e.g. `pi.default`. Comparisons are per attachment. */
	attachment: string;
	/** The runtime family, e.g. `pi`. */
	runtime: string;
	/** When the facts were collected, ISO-8601 UTC. */
	observedAt: string;
	/** The collection methods used, in collection order. */
	methods: EndoHarnessFingerprintMethodV0[];
	local: EndoHarnessLocalFactsV0;
	reported: EndoHarnessReportedFactsV0;
	/** Every fact that is null above, with why. A fact is never fabricated to close a gap. */
	gaps: { fact: EndoHarnessFingerprintFactV0; reason: string }[];
	identity: {
		/** SHA-256 over the canonical identity basis: runtime, realPath, entrypoint digest, package, version. */
		digest: string;
		confidence: EndoHarnessIdentityConfidenceV0;
	};
}

const FINGERPRINT_KEYS = [
	"schemaVersion",
	"id",
	"attachment",
	"runtime",
	"observedAt",
	"methods",
	"local",
	"reported",
	"gaps",
	"identity",
];

/** The basis the identity digest is computed over; exported so producers and checkers hash the same thing. */
export function endoHarnessIdentityBasisV0(fingerprint: {
	runtime: string;
	local: EndoHarnessLocalFactsV0;
	reported: EndoHarnessReportedFactsV0;
}): Record<string, string | null> {
	return {
		runtime: fingerprint.runtime,
		realPath: fingerprint.local.realPath,
		entrypointSha256: fingerprint.local.entrypoint?.sha256 ?? null,
		packageName: fingerprint.local.package?.name ?? null,
		packageVersion: fingerprint.local.package?.version ?? null,
		version: fingerprint.reported.version,
	};
}

/** The confidence a fingerprint's facts support. */
export function endoHarnessIdentityConfidenceV0(fingerprint: {
	local: EndoHarnessLocalFactsV0;
	reported: EndoHarnessReportedFactsV0;
}): EndoHarnessIdentityConfidenceV0 {
	return fingerprint.local.entrypoint !== null && fingerprint.reported.version !== null ? "strong" : "reduced";
}

/**
 * Validates a fingerprint. Rejects unknown fields, a non-ISO-8601-UTC time, unknown or repeated methods, a gap list
 * that disagrees with the null facts (every null fact listed, no present fact listed), a confidence the facts do not
 * support, and a fingerprint that identifies nothing (neither a real path nor a reported version). It does not
 * recompute digests: the producer and the registry do. Returns the value unchanged, or null.
 */
export function validateEndoHarnessFingerprintV0(value: unknown): EndoHarnessFingerprintV0 | null {
	if (!isPlain(value) || !onlyKeys(value, FINGERPRINT_KEYS)) return null;
	const v = value;
	if (v.schemaVersion !== "endo.harness-fingerprint.v0") return null;
	if (!isEvidenceId(v.id)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.observedAt !== "string" || !isIso8601UtcV0(v.observedAt)) return null;
	if (!Array.isArray(v.methods) || v.methods.length === 0) return null;
	const methods = new Set<string>();
	for (const method of v.methods) {
		if (!(ENDO_HARNESS_FINGERPRINT_METHODS_V0 as readonly unknown[]).includes(method)) return null;
		if (methods.has(method as string)) return null;
		methods.add(method as string);
	}
	if (!isPlain(v.local) || !onlyKeys(v.local, ["requested", "resolvedPath", "realPath", "entrypoint", "package"]))
		return null;
	const local = v.local;
	if (!isText(local.requested, 4096)) return null;
	if (local.resolvedPath !== null && !isText(local.resolvedPath, 4096)) return null;
	if (local.realPath !== null && !isText(local.realPath, 4096)) return null;
	if (local.entrypoint !== null) {
		if (!isPlain(local.entrypoint) || !onlyKeys(local.entrypoint, ["sha256", "bytes"])) return null;
		if (!isSha256Hex(local.entrypoint.sha256) || !isNonNegativeInteger(local.entrypoint.bytes)) return null;
	}
	if (local.package !== null) {
		if (!isPlain(local.package) || !onlyKeys(local.package, ["name", "version", "root"])) return null;
		if (!isText(local.package.name, 256) || !isText(local.package.version, 256) || !isText(local.package.root, 4096))
			return null;
	}
	if (!isPlain(v.reported) || !onlyKeys(v.reported, ["versionText", "version"])) return null;
	const reported = v.reported;
	if (reported.versionText !== null && !isText(reported.versionText, 1024)) return null;
	if (reported.version !== null && !isText(reported.version, 256)) return null;
	if (reported.version !== null && reported.versionText === null) return null;
	if (!Array.isArray(v.gaps)) return null;
	const nullFacts = new Set<string>();
	if (local.resolvedPath === null) nullFacts.add("resolvedPath");
	if (local.realPath === null) nullFacts.add("realPath");
	if (local.entrypoint === null) nullFacts.add("entrypoint");
	if (local.package === null) nullFacts.add("package");
	if (reported.version === null) nullFacts.add("version");
	const listed = new Set<string>();
	for (const gap of v.gaps) {
		if (!isPlain(gap) || !onlyKeys(gap, ["fact", "reason"])) return null;
		if (!(ENDO_HARNESS_FINGERPRINT_FACTS_V0 as readonly unknown[]).includes(gap.fact)) return null;
		if (!isText(gap.reason, 1024)) return null;
		if (listed.has(gap.fact as string)) return null;
		listed.add(gap.fact as string);
	}
	if (listed.size !== nullFacts.size || [...nullFacts].some((fact) => !listed.has(fact))) return null;
	if (local.realPath === null && reported.version === null) return null;
	if (!isPlain(v.identity) || !onlyKeys(v.identity, ["digest", "confidence"])) return null;
	if (!isSha256Hex(v.identity.digest)) return null;
	const confidence = endoHarnessIdentityConfidenceV0({
		local: local as unknown as EndoHarnessLocalFactsV0,
		reported: reported as unknown as EndoHarnessReportedFactsV0,
	});
	if (v.identity.confidence !== confidence) return null;
	return value as unknown as EndoHarnessFingerprintV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Fingerprint v1: the runtime-content identity basis
// ---------------------------------------------------------------------------------------------------------------
//
// v0 hashes one file, the entrypoint. For an npm install of Pi that file is a 160-byte launcher that is byte-identical
// across releases, so v0 identifies the version string and the path, not the code. v1 keeps every v0 fact and adds a
// digest over the files in the directory the entrypoint sits in (its "scope"; see adapters/pi/runtime-content.ts).
//
// v0 is not migrated and not reinterpreted: a v0 digest keeps meaning "entrypoint file + manifest facts + reported
// version" forever, and a v1 digest is computed over a basis that names itself, so the two can never be equal.
// Identities on different bases are NOT comparable: equal paths or versions do not make them the same runtime, and a
// differing digest across bases is not evidence that the runtime's code changed.

/** The identity bases this reader knows. v0 fingerprints carry no tag; they are, by definition, "entrypoint.v0". */
export type EndoHarnessIdentityBasisNameV1 = "entrypoint.v0" | "runtime-content.v1";

export const ENDO_HARNESS_IDENTITY_BASES_V1 = [
	"entrypoint.v0",
	"runtime-content.v1",
] as const satisfies readonly EndoHarnessIdentityBasisNameV1[];

/** The tag mixed into the v1 digest, so the digest depends on the basis it was computed under. */
export const ENDO_HARNESS_RUNTIME_CONTENT_BASIS_TAG_V1 = "endo.harness-identity.runtime-content.v1";

/** The scheme that produced a runtime-content digest. */
export const ENDO_RUNTIME_CONTENT_SCHEME_V1 = "endo.runtime-content.v1";

export type EndoHarnessFingerprintMethodV1 = EndoHarnessFingerprintMethodV0 | "runtime-content-sha256";

export const ENDO_HARNESS_FINGERPRINT_METHODS_V1 = [
	...ENDO_HARNESS_FINGERPRINT_METHODS_V0,
	"runtime-content-sha256",
] as const satisfies readonly EndoHarnessFingerprintMethodV1[];

export type EndoHarnessFingerprintFactV1 = EndoHarnessFingerprintFactV0 | "runtimeContent";

export const ENDO_HARNESS_FINGERPRINT_FACTS_V1 = [
	...ENDO_HARNESS_FINGERPRINT_FACTS_V0,
	"runtimeContent",
] as const satisfies readonly EndoHarnessFingerprintFactV1[];

/**
 * A digest over the regular files of one directory tree (the scope), as adapters/pi/runtime-content.ts defines it.
 * Present only when the whole scope was covered: a scope that could not be read completely, or a layout with no
 * supported scope, is a gap (`runtimeContent`), never a partial digest.
 */
export interface EndoHarnessRuntimeContentV1 {
	scheme: typeof ENDO_RUNTIME_CONTENT_SCHEME_V1;
	/** The covered directory, relative to `local.package.root`, with "/" separators. */
	scope: string;
	/** How many entries (regular files and symbolic links) the digest covers. */
	files: number;
	/** The total bytes of the regular files covered. */
	bytes: number;
	/** The manifest digest (path, type, size and SHA-256 per entry, domain-separated). */
	sha256: string;
}

export interface EndoHarnessLocalFactsV1 extends EndoHarnessLocalFactsV0 {
	/** The runtime-content digest, or null with a `runtimeContent` gap. Never covers anything outside its scope. */
	runtimeContent: EndoHarnessRuntimeContentV1 | null;
}

export interface EndoHarnessFingerprintV1 {
	schemaVersion: "endo.harness-fingerprint.v1";
	id: string;
	attachment: string;
	runtime: string;
	observedAt: string;
	methods: EndoHarnessFingerprintMethodV1[];
	local: EndoHarnessLocalFactsV1;
	reported: EndoHarnessReportedFactsV0;
	gaps: { fact: EndoHarnessFingerprintFactV1; reason: string }[];
	identity: {
		/** The basis the digest was computed under. */
		basis: "runtime-content.v1";
		/** SHA-256 over the canonical v1 identity basis (see endoHarnessIdentityBasisV1). */
		digest: string;
		confidence: EndoHarnessIdentityConfidenceV0;
	};
}

/** A fingerprint of any version this reader knows. Fields both versions carry are read directly; v1-only ones need a guard. */
export type EndoHarnessFingerprintRecordV0 = EndoHarnessFingerprintV0 | EndoHarnessFingerprintV1;

/** The identity basis a fingerprint's digest was computed under. */
export function endoHarnessIdentityBasisNameV0(
	fingerprint: EndoHarnessFingerprintRecordV0,
): EndoHarnessIdentityBasisNameV1 {
	return fingerprint.schemaVersion === "endo.harness-fingerprint.v1" ? fingerprint.identity.basis : "entrypoint.v0";
}

/** The runtime-content digest of a fingerprint, or null (a v0 fingerprint has none; a v1 one may lack it). */
export function endoHarnessRuntimeContentV0(
	fingerprint: EndoHarnessFingerprintRecordV0,
): EndoHarnessRuntimeContentV1 | null {
	return fingerprint.schemaVersion === "endo.harness-fingerprint.v1" ? fingerprint.local.runtimeContent : null;
}

/** The basis the v1 identity digest is computed over; exported so producers and checkers hash the same thing. */
export function endoHarnessIdentityBasisV1(fingerprint: {
	runtime: string;
	local: EndoHarnessLocalFactsV1;
	reported: EndoHarnessReportedFactsV0;
}): Record<string, string | null> {
	return {
		basis: ENDO_HARNESS_RUNTIME_CONTENT_BASIS_TAG_V1,
		runtime: fingerprint.runtime,
		realPath: fingerprint.local.realPath,
		entrypointSha256: fingerprint.local.entrypoint?.sha256 ?? null,
		runtimeContentScope: fingerprint.local.runtimeContent?.scope ?? null,
		runtimeContentSha256: fingerprint.local.runtimeContent?.sha256 ?? null,
		packageName: fingerprint.local.package?.name ?? null,
		packageVersion: fingerprint.local.package?.version ?? null,
		version: fingerprint.reported.version,
	};
}

/**
 * The confidence v1 facts support. "strong" additionally requires complete runtime-content coverage: a launcher-only
 * observation is "reduced" however well the version is known.
 */
export function endoHarnessIdentityConfidenceV1(fingerprint: {
	local: EndoHarnessLocalFactsV1;
	reported: EndoHarnessReportedFactsV0;
}): EndoHarnessIdentityConfidenceV0 {
	return fingerprint.local.entrypoint !== null &&
		fingerprint.local.runtimeContent !== null &&
		fingerprint.reported.version !== null
		? "strong"
		: "reduced";
}

const FINGERPRINT_KEYS_V1 = FINGERPRINT_KEYS.map((key) => key);

function isRelativeScope(value: unknown): value is string {
	if (!isText(value, 512)) return false;
	if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Validates a v1 fingerprint under the v0 rules plus: `identity.basis` is "runtime-content.v1"; `runtimeContent` is a
 * well-formed digest or a listed gap; a present digest requires the package and entrypoint it was taken from and the
 * `runtime-content-sha256` method (and an absent one forbids it); the confidence is the v1 confidence. It does not
 * recompute digests. Returns the value unchanged, or null.
 */
export function validateEndoHarnessFingerprintV1(value: unknown): EndoHarnessFingerprintV1 | null {
	if (!isPlain(value) || !onlyKeys(value, FINGERPRINT_KEYS_V1)) return null;
	const v = value;
	if (v.schemaVersion !== "endo.harness-fingerprint.v1") return null;
	if (!isEvidenceId(v.id)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.observedAt !== "string" || !isIso8601UtcV0(v.observedAt)) return null;
	if (!Array.isArray(v.methods) || v.methods.length === 0) return null;
	const methods = new Set<string>();
	for (const method of v.methods) {
		if (!(ENDO_HARNESS_FINGERPRINT_METHODS_V1 as readonly unknown[]).includes(method)) return null;
		if (methods.has(method as string)) return null;
		methods.add(method as string);
	}
	if (
		!isPlain(v.local) ||
		!onlyKeys(v.local, ["requested", "resolvedPath", "realPath", "entrypoint", "package", "runtimeContent"])
	)
		return null;
	const local = v.local;
	if (!isText(local.requested, 4096)) return null;
	if (local.resolvedPath !== null && !isText(local.resolvedPath, 4096)) return null;
	if (local.realPath !== null && !isText(local.realPath, 4096)) return null;
	if (local.entrypoint !== null) {
		if (!isPlain(local.entrypoint) || !onlyKeys(local.entrypoint, ["sha256", "bytes"])) return null;
		if (!isSha256Hex(local.entrypoint.sha256) || !isNonNegativeInteger(local.entrypoint.bytes)) return null;
	}
	if (local.package !== null) {
		if (!isPlain(local.package) || !onlyKeys(local.package, ["name", "version", "root"])) return null;
		if (!isText(local.package.name, 256) || !isText(local.package.version, 256) || !isText(local.package.root, 4096))
			return null;
	}
	if (local.runtimeContent !== null) {
		const content = local.runtimeContent;
		if (!isPlain(content) || !onlyKeys(content, ["scheme", "scope", "files", "bytes", "sha256"])) return null;
		if (content.scheme !== ENDO_RUNTIME_CONTENT_SCHEME_V1 || !isRelativeScope(content.scope)) return null;
		if (!isNonNegativeInteger(content.files) || content.files < 1 || !isNonNegativeInteger(content.bytes))
			return null;
		if (!isSha256Hex(content.sha256)) return null;
		// The digest was taken from the entrypoint's directory inside this package: both must be recorded.
		if (local.package === null || local.entrypoint === null || local.realPath === null) return null;
	}
	if (methods.has("runtime-content-sha256") !== (local.runtimeContent !== null)) return null;
	if (!isPlain(v.reported) || !onlyKeys(v.reported, ["versionText", "version"])) return null;
	const reported = v.reported;
	if (reported.versionText !== null && !isText(reported.versionText, 1024)) return null;
	if (reported.version !== null && !isText(reported.version, 256)) return null;
	if (reported.version !== null && reported.versionText === null) return null;
	if (!Array.isArray(v.gaps)) return null;
	const nullFacts = new Set<string>();
	if (local.resolvedPath === null) nullFacts.add("resolvedPath");
	if (local.realPath === null) nullFacts.add("realPath");
	if (local.entrypoint === null) nullFacts.add("entrypoint");
	if (local.package === null) nullFacts.add("package");
	if (local.runtimeContent === null) nullFacts.add("runtimeContent");
	if (reported.version === null) nullFacts.add("version");
	const listed = new Set<string>();
	for (const gap of v.gaps) {
		if (!isPlain(gap) || !onlyKeys(gap, ["fact", "reason"])) return null;
		if (!(ENDO_HARNESS_FINGERPRINT_FACTS_V1 as readonly unknown[]).includes(gap.fact)) return null;
		if (!isText(gap.reason, 1024)) return null;
		if (listed.has(gap.fact as string)) return null;
		listed.add(gap.fact as string);
	}
	if (listed.size !== nullFacts.size || [...nullFacts].some((fact) => !listed.has(fact))) return null;
	if (local.realPath === null && reported.version === null) return null;
	if (!isPlain(v.identity) || !onlyKeys(v.identity, ["basis", "digest", "confidence"])) return null;
	if (v.identity.basis !== "runtime-content.v1") return null;
	if (!isSha256Hex(v.identity.digest)) return null;
	const confidence = endoHarnessIdentityConfidenceV1({
		local: local as unknown as EndoHarnessLocalFactsV1,
		reported: reported as unknown as EndoHarnessReportedFactsV0,
	});
	if (v.identity.confidence !== confidence) return null;
	return value as unknown as EndoHarnessFingerprintV1;
}

// ---------------------------------------------------------------------------------------------------------------
// Change
// ---------------------------------------------------------------------------------------------------------------

/** What a comparison found. "collection-failed": no fingerprint could be taken, so nothing was compared. */
export type EndoHarnessChangeKindV0 = "first-observation" | "unchanged" | "changed" | "collection-failed";

export const ENDO_HARNESS_CHANGE_KINDS_V0 = [
	"first-observation",
	"unchanged",
	"changed",
	"collection-failed",
] as const satisfies readonly EndoHarnessChangeKindV0[];

/** Which identity facts differ. */
export type EndoHarnessDifferenceV0 = "realPath" | "entrypoint" | "package" | "version" | "confidence";

export const ENDO_HARNESS_DIFFERENCES_V0 = [
	"realPath",
	"entrypoint",
	"package",
	"version",
	"confidence",
] as const satisfies readonly EndoHarnessDifferenceV0[];

/**
 * The order of the two reported versions under semver precedence, as information only. "lower" is not an error and
 * "higher" is not an upgrade the user was offered: both are simply a different runtime. "unknown" when either version
 * is missing; "incomparable" when either does not parse as semver.
 */
export type EndoHarnessVersionOrderV0 = "higher" | "lower" | "equal" | "incomparable" | "unknown";

export const ENDO_HARNESS_VERSION_ORDERS_V0 = [
	"higher",
	"lower",
	"equal",
	"incomparable",
	"unknown",
] as const satisfies readonly EndoHarnessVersionOrderV0[];

/** The summary of one side of a comparison. */
export interface EndoHarnessObservationRefV0 {
	fingerprintId: string;
	identityDigest: string;
	confidence: EndoHarnessIdentityConfidenceV0;
	version: string | null;
	realPath: string | null;
}

export interface EndoHarnessChangeV0 {
	schemaVersion: "endo.harness-change.v0";
	/** Content-addressed endo.evidence.* identifier. */
	id: string;
	attachment: string;
	runtime: string;
	/** When the comparison was made, ISO-8601 UTC. */
	at: string;
	kind: EndoHarnessChangeKindV0;
	/** The last recorded observation for this attachment, or null on the first. */
	previous: EndoHarnessObservationRefV0 | null;
	/** The current observation, or null when collection failed. */
	current: EndoHarnessObservationRefV0 | null;
	/** The identity facts that differ; empty unless kind is "changed". */
	differences: EndoHarnessDifferenceV0[];
	versionOrder: EndoHarnessVersionOrderV0;
	/** Why collection failed; present exactly when kind is "collection-failed". */
	failure?: string;
}

function validateObservationRef(value: unknown): EndoHarnessObservationRefV0 | null {
	if (!isPlain(value) || !onlyKeys(value, ["fingerprintId", "identityDigest", "confidence", "version", "realPath"]))
		return null;
	if (!isEvidenceId(value.fingerprintId) || !isSha256Hex(value.identityDigest)) return null;
	if (value.confidence !== "strong" && value.confidence !== "reduced") return null;
	if (value.version !== null && !isText(value.version, 256)) return null;
	if (value.realPath !== null && !isText(value.realPath, 4096)) return null;
	return value as unknown as EndoHarnessObservationRefV0;
}

/**
 * Validates a change record and its kind's doors: a first observation has no previous; unchanged has equal digests
 * and no differences; changed has different digests and at least one difference; a failed collection has no current,
 * a failure reason and an "unknown" version order. Returns the value unchanged, or null.
 */
export function validateEndoHarnessChangeV0(value: unknown): EndoHarnessChangeV0 | null {
	if (
		!isPlain(value) ||
		!onlyKeys(value, [
			"schemaVersion",
			"id",
			"attachment",
			"runtime",
			"at",
			"kind",
			"previous",
			"current",
			"differences",
			"versionOrder",
			"failure",
		])
	)
		return null;
	const v = value;
	if (v.schemaVersion !== "endo.harness-change.v0") return null;
	if (!isEvidenceId(v.id)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.at !== "string" || !isIso8601UtcV0(v.at)) return null;
	if (!(ENDO_HARNESS_CHANGE_KINDS_V0 as readonly unknown[]).includes(v.kind)) return null;
	const previous = v.previous === null ? null : validateObservationRef(v.previous);
	if (v.previous !== null && previous === null) return null;
	const current = v.current === null ? null : validateObservationRef(v.current);
	if (v.current !== null && current === null) return null;
	if (!Array.isArray(v.differences)) return null;
	const differences = new Set<string>();
	for (const difference of v.differences) {
		if (!(ENDO_HARNESS_DIFFERENCES_V0 as readonly unknown[]).includes(difference)) return null;
		if (differences.has(difference as string)) return null;
		differences.add(difference as string);
	}
	if (!(ENDO_HARNESS_VERSION_ORDERS_V0 as readonly unknown[]).includes(v.versionOrder)) return null;
	if (v.failure !== undefined && !isText(v.failure, 2048)) return null;
	switch (v.kind) {
		case "first-observation":
			if (previous !== null || current === null || differences.size !== 0 || v.failure !== undefined) return null;
			if (v.versionOrder !== "unknown") return null;
			break;
		case "unchanged":
			if (previous === null || current === null || differences.size !== 0 || v.failure !== undefined) return null;
			if (previous.identityDigest !== current.identityDigest) return null;
			break;
		case "changed":
			if (previous === null || current === null || differences.size === 0 || v.failure !== undefined) return null;
			if (previous.identityDigest === current.identityDigest) return null;
			break;
		case "collection-failed":
			if (current !== null || differences.size !== 0 || v.failure === undefined) return null;
			if (v.versionOrder !== "unknown") return null;
			break;
	}
	return value as unknown as EndoHarnessChangeV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Change v1
// ---------------------------------------------------------------------------------------------------------------
//
// The v0 change record cannot say "the digests differ because the identity basis differs", and it cannot name a
// runtime-content difference. v1 adds both, and records the basis of each side. Kinds are unchanged: a comparison
// across bases is a "changed" record whose differences include "identityBasis", and which never lists
// "runtimeContent" (the two sides are not comparable on content). It states that the identities differ, not that the
// runtime's code did.

export type EndoHarnessDifferenceV1 = EndoHarnessDifferenceV0 | "runtimeContent" | "identityBasis";

export const ENDO_HARNESS_DIFFERENCES_V1 = [
	"realPath",
	"entrypoint",
	"package",
	"version",
	"runtimeContent",
	"confidence",
	"identityBasis",
] as const satisfies readonly EndoHarnessDifferenceV1[];

export interface EndoHarnessObservationRefV1 extends EndoHarnessObservationRefV0 {
	/** The basis `identityDigest` was computed under. */
	basis: EndoHarnessIdentityBasisNameV1;
}

export interface EndoHarnessChangeV1 {
	schemaVersion: "endo.harness-change.v1";
	id: string;
	attachment: string;
	runtime: string;
	at: string;
	kind: EndoHarnessChangeKindV0;
	previous: EndoHarnessObservationRefV1 | null;
	current: EndoHarnessObservationRefV1 | null;
	differences: EndoHarnessDifferenceV1[];
	versionOrder: EndoHarnessVersionOrderV0;
	failure?: string;
}

/** A change record of any version this reader knows. */
export type EndoHarnessChangeRecordV0 = EndoHarnessChangeV0 | EndoHarnessChangeV1;

/** An observation reference of any version. */
export type EndoHarnessObservationRefRecordV0 = EndoHarnessObservationRefV0 | EndoHarnessObservationRefV1;

/** The basis of a side of a change record ("entrypoint.v0" for a v0 reference, which carries none). */
export function endoHarnessObservationBasisV0(ref: EndoHarnessObservationRefRecordV0): EndoHarnessIdentityBasisNameV1 {
	return "basis" in ref ? ref.basis : "entrypoint.v0";
}

function validateObservationRefV1(value: unknown): EndoHarnessObservationRefV1 | null {
	if (
		!isPlain(value) ||
		!onlyKeys(value, ["fingerprintId", "identityDigest", "confidence", "version", "realPath", "basis"])
	)
		return null;
	if (!(ENDO_HARNESS_IDENTITY_BASES_V1 as readonly unknown[]).includes(value.basis)) return null;
	const { basis: _basis, ...rest } = value;
	if (validateObservationRef(rest) === null) return null;
	return value as unknown as EndoHarnessObservationRefV1;
}

/**
 * Validates a v1 change record under the v0 rules, with the v1 difference vocabulary and two more doors: a "changed"
 * record lists "identityBasis" exactly when the two sides' bases differ, and lists "runtimeContent" only when they
 * share a basis that has runtime content. An "unchanged" record has the same digest and the same basis.
 */
export function validateEndoHarnessChangeV1(value: unknown): EndoHarnessChangeV1 | null {
	if (
		!isPlain(value) ||
		!onlyKeys(value, [
			"schemaVersion",
			"id",
			"attachment",
			"runtime",
			"at",
			"kind",
			"previous",
			"current",
			"differences",
			"versionOrder",
			"failure",
		])
	)
		return null;
	const v = value;
	if (v.schemaVersion !== "endo.harness-change.v1") return null;
	if (!isEvidenceId(v.id)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.at !== "string" || !isIso8601UtcV0(v.at)) return null;
	if (!(ENDO_HARNESS_CHANGE_KINDS_V0 as readonly unknown[]).includes(v.kind)) return null;
	const previous = v.previous === null ? null : validateObservationRefV1(v.previous);
	if (v.previous !== null && previous === null) return null;
	const current = v.current === null ? null : validateObservationRefV1(v.current);
	if (v.current !== null && current === null) return null;
	if (!Array.isArray(v.differences)) return null;
	const differences = new Set<string>();
	for (const difference of v.differences) {
		if (!(ENDO_HARNESS_DIFFERENCES_V1 as readonly unknown[]).includes(difference)) return null;
		if (differences.has(difference as string)) return null;
		differences.add(difference as string);
	}
	if (!(ENDO_HARNESS_VERSION_ORDERS_V0 as readonly unknown[]).includes(v.versionOrder)) return null;
	if (v.failure !== undefined && !isText(v.failure, 2048)) return null;
	switch (v.kind) {
		case "first-observation":
			if (previous !== null || current === null || differences.size !== 0 || v.failure !== undefined) return null;
			if (v.versionOrder !== "unknown") return null;
			break;
		case "unchanged":
			if (previous === null || current === null || differences.size !== 0 || v.failure !== undefined) return null;
			if (previous.identityDigest !== current.identityDigest || previous.basis !== current.basis) return null;
			break;
		case "changed": {
			if (previous === null || current === null || differences.size === 0 || v.failure !== undefined) return null;
			if (previous.identityDigest === current.identityDigest) return null;
			const crossBasis = previous.basis !== current.basis;
			if (differences.has("identityBasis") !== crossBasis) return null;
			if (differences.has("runtimeContent") && (crossBasis || current.basis !== "runtime-content.v1")) return null;
			break;
		}
		case "collection-failed":
			if (current !== null || differences.size !== 0 || v.failure === undefined) return null;
			if (v.versionOrder !== "unknown") return null;
			break;
	}
	return value as unknown as EndoHarnessChangeV1;
}

// ---------------------------------------------------------------------------------------------------------------
// Capability evidence
// ---------------------------------------------------------------------------------------------------------------

/**
 * What kind of check produced the evidence.
 * - "static-surface": classified from the documented protocol surface of the observed version (e.g. "no command
 *   exposes this"); no runtime interaction.
 * - "local-protocol": a deterministic exchange with the runtime that starts no agent run, calls no model provider and
 *   persists no session. Safe to run automatically.
 * - "live-study": runs agent work (prompts, tools, provider calls) and may cost money or change state. Only on an
 *   explicit operator request.
 */
export type EndoCapabilityCheckKindV0 = "static-surface" | "local-protocol" | "live-study";

export const ENDO_CAPABILITY_CHECK_KINDS_V0 = [
	"static-surface",
	"local-protocol",
	"live-study",
] as const satisfies readonly EndoCapabilityCheckKindV0[];

/**
 * Everything a result depends on. Evidence is valid for a later attachment only while every one of these is equal to
 * the current value; the attachment's evidence rules decide (see adapters/pi/evidence.ts).
 */
export interface EndoCapabilityDependenciesV0 {
	/** The fingerprint the check ran against. */
	fingerprintId: string;
	identityDigest: string;
	confidence: EndoHarnessIdentityConfidenceV0;
	/** The adapter's version (transport and command handling). */
	adapterVersion: string;
	/** The version of the mapping from runtime records to Endophasia events. */
	mappingVersion: string;
	/** The conformance suite's version. */
	suiteVersion: string;
	/** SHA-256 over the relevant configuration subset (e.g. provider and model for a live study). */
	configurationDigest: string;
	/** The optional runtime extension the check relied on, or null when none. */
	extension: { id: string; version: string } | null;
}

export interface EndoCapabilityEvidenceV0 {
	schemaVersion: "endo.capability-evidence.v0";
	/** Content-addressed endo.evidence.* identifier. */
	id: string;
	attachment: string;
	runtime: string;
	/** The capability, a dotted kind, e.g. `control.model`. */
	capability: string;
	check: {
		name: string;
		version: string;
		kind: EndoCapabilityCheckKindV0;
		/** SHA-256 over the check's declared definition: changing a check invalidates only its own evidence. */
		definitionDigest: string;
	};
	dependencies: EndoCapabilityDependenciesV0;
	/** SHA-256 over the exact inputs the check sent. */
	inputsDigest: string;
	/** The expected semantic meaning, in words. */
	expected: string;
	/** What was observed, in words. */
	observed: string;
	classification: EndoConformanceClassificationV0;
	/** Digests or endo.evidence.* references the classification rests on (e.g. the exchange transcript's digest). */
	evidence: string[];
	limitations: string[];
	/** When the check finished, ISO-8601 UTC. */
	at: string;
}

const EVIDENCE_KEYS = [
	"schemaVersion",
	"id",
	"attachment",
	"runtime",
	"capability",
	"check",
	"dependencies",
	"inputsDigest",
	"expected",
	"observed",
	"classification",
	"evidence",
	"limitations",
	"at",
];

const DEPENDENCY_KEYS = [
	"fingerprintId",
	"identityDigest",
	"confidence",
	"adapterVersion",
	"mappingVersion",
	"suiteVersion",
	"configurationDigest",
	"extension",
];

function validateDependencies(value: unknown): EndoCapabilityDependenciesV0 | null {
	if (!isPlain(value) || !onlyKeys(value, DEPENDENCY_KEYS)) return null;
	if (!isEvidenceId(value.fingerprintId) || !isSha256Hex(value.identityDigest)) return null;
	if (value.confidence !== "strong" && value.confidence !== "reduced") return null;
	if (!isText(value.adapterVersion, 64) || !isText(value.mappingVersion, 64) || !isText(value.suiteVersion, 64))
		return null;
	if (!isSha256Hex(value.configurationDigest)) return null;
	if (value.extension !== null) {
		if (!isPlain(value.extension) || !onlyKeys(value.extension, ["id", "version"])) return null;
		if (!isText(value.extension.id, 256) || !isText(value.extension.version, 256)) return null;
	}
	return value as unknown as EndoCapabilityDependenciesV0;
}

/**
 * Validates a capability evidence record: the closed classification vocabulary of endo.conformance-study.v0, the
 * closed check kinds, complete dependencies, digests in grammar, and written expectations and observations. Returns
 * the value unchanged, or null.
 */
export function validateEndoCapabilityEvidenceV0(value: unknown): EndoCapabilityEvidenceV0 | null {
	if (!isPlain(value) || !onlyKeys(value, EVIDENCE_KEYS)) return null;
	const v = value;
	if (v.schemaVersion !== "endo.capability-evidence.v0") return null;
	if (!isEvidenceId(v.id)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.capability !== "string" || !isWellFormedKindV0(v.capability)) return null;
	if (!isPlain(v.check) || !onlyKeys(v.check, ["name", "version", "kind", "definitionDigest"])) return null;
	if (!isText(v.check.name, 256) || !isText(v.check.version, 64)) return null;
	if (!(ENDO_CAPABILITY_CHECK_KINDS_V0 as readonly unknown[]).includes(v.check.kind)) return null;
	if (!isSha256Hex(v.check.definitionDigest)) return null;
	if (validateDependencies(v.dependencies) === null) return null;
	if (!isSha256Hex(v.inputsDigest)) return null;
	if (!isText(v.expected, 4096) || !isText(v.observed, 4096)) return null;
	if (!(ENDO_CONFORMANCE_CLASSIFICATIONS_V0 as readonly unknown[]).includes(v.classification)) return null;
	if (!Array.isArray(v.evidence) || !v.evidence.every((entry) => isSha256Hex(entry) || isEvidenceId(entry)))
		return null;
	if (!Array.isArray(v.limitations) || !v.limitations.every((entry) => isText(entry, 4096))) return null;
	if (typeof v.at !== "string" || !isIso8601UtcV0(v.at)) return null;
	return value as unknown as EndoCapabilityEvidenceV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Capability state
// ---------------------------------------------------------------------------------------------------------------

/**
 * A capability's standing at one moment.
 * - "admitted": current evidence classifies it EXACT or QUALIFIED.
 * - "admitted-partial": current evidence classifies it PARTIAL; usable only within its recorded limitations.
 * - "unavailable" / "mismatch": current evidence classifies it so; not offered.
 * - "unverified": no current evidence (none yet, invalidated by a change, or a live study is pending). Not offered,
 *   even if earlier evidence said otherwise and even if the runtime starts.
 */
export type EndoCapabilityStatusV0 = "admitted" | "admitted-partial" | "unavailable" | "mismatch" | "unverified";

export const ENDO_CAPABILITY_STATUSES_V0 = [
	"admitted",
	"admitted-partial",
	"unavailable",
	"mismatch",
	"unverified",
] as const satisfies readonly EndoCapabilityStatusV0[];

/** The status a classification maps to; the only mapping a capability state may use. */
export function endoCapabilityStatusForV0(classification: EndoConformanceClassificationV0): EndoCapabilityStatusV0 {
	switch (classification) {
		case "EXACT":
		case "QUALIFIED":
			return "admitted";
		case "PARTIAL":
			return "admitted-partial";
		case "UNAVAILABLE":
			return "unavailable";
		case "MISMATCH":
			return "mismatch";
	}
}

export interface EndoCapabilityStateEntryV0 {
	capability: string;
	status: EndoCapabilityStatusV0;
	/** The classification of the current evidence, or null when unverified. */
	classification: EndoConformanceClassificationV0 | null;
	/** The current evidence's identifier, or null when unverified. */
	evidenceId: string | null;
	/** Why the capability stands where it does, in words (e.g. which dependency invalidated earlier evidence). */
	reason: string;
	/** The check kind that can establish the capability; "live-study" means it needs an explicit operator request. */
	requires: EndoCapabilityCheckKindV0;
}

export interface EndoCapabilityStateV0 {
	schemaVersion: "endo.capability-state.v0";
	attachment: string;
	runtime: string;
	at: string;
	/** The fingerprint the state was derived for, or null when the runtime could not be identified. */
	fingerprintId: string | null;
	capabilities: EndoCapabilityStateEntryV0[];
}

/**
 * Validates a capability state: every entry's status follows from its classification exactly as
 * endoCapabilityStatusForV0 says, an unverified entry carries neither a classification nor evidence, no capability
 * appears twice, and an unidentified runtime admits nothing. Returns the value unchanged, or null.
 */
export function validateEndoCapabilityStateV0(value: unknown): EndoCapabilityStateV0 | null {
	if (
		!isPlain(value) ||
		!onlyKeys(value, ["schemaVersion", "attachment", "runtime", "at", "fingerprintId", "capabilities"])
	)
		return null;
	const v = value;
	if (v.schemaVersion !== "endo.capability-state.v0") return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.runtime !== "string" || !isWellFormedKindV0(v.runtime)) return null;
	if (typeof v.at !== "string" || !isIso8601UtcV0(v.at)) return null;
	if (v.fingerprintId !== null && !isEvidenceId(v.fingerprintId)) return null;
	if (!Array.isArray(v.capabilities)) return null;
	const seen = new Set<string>();
	for (const entry of v.capabilities) {
		if (
			!isPlain(entry) ||
			!onlyKeys(entry, ["capability", "status", "classification", "evidenceId", "reason", "requires"])
		)
			return null;
		if (typeof entry.capability !== "string" || !isWellFormedKindV0(entry.capability)) return null;
		if (seen.has(entry.capability)) return null;
		seen.add(entry.capability);
		if (!(ENDO_CAPABILITY_STATUSES_V0 as readonly unknown[]).includes(entry.status)) return null;
		if (!isText(entry.reason, 2048)) return null;
		if (!(ENDO_CAPABILITY_CHECK_KINDS_V0 as readonly unknown[]).includes(entry.requires)) return null;
		if (entry.status === "unverified") {
			if (entry.classification !== null || entry.evidenceId !== null) return null;
		} else {
			if (!(ENDO_CONFORMANCE_CLASSIFICATIONS_V0 as readonly unknown[]).includes(entry.classification)) return null;
			if (!isEvidenceId(entry.evidenceId)) return null;
			if (endoCapabilityStatusForV0(entry.classification as EndoConformanceClassificationV0) !== entry.status)
				return null;
			if (v.fingerprintId === null) return null;
		}
	}
	return value as unknown as EndoCapabilityStateV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------------------------------------------

/** What an operator is told. There is no "update available" kind: a fingerprint comparison cannot establish one. */
export type EndoHarnessNotificationKindV0 = "runtime-first-observed" | "runtime-changed" | "runtime-unidentified";

export const ENDO_HARNESS_NOTIFICATION_KINDS_V0 = [
	"runtime-first-observed",
	"runtime-changed",
	"runtime-unidentified",
] as const satisfies readonly EndoHarnessNotificationKindV0[];

export interface EndoHarnessNotificationV0 {
	schemaVersion: "endo.harness-notification.v0";
	id: string;
	attachment: string;
	at: string;
	kind: EndoHarnessNotificationKindV0;
	/** The change record the notice reports. */
	changeId: string;
	title: string;
	/** The notice's lines, in display order. */
	lines: string[];
}

/** Validates a notification. Returns the value unchanged, or null. */
export function validateEndoHarnessNotificationV0(value: unknown): EndoHarnessNotificationV0 | null {
	if (
		!isPlain(value) ||
		!onlyKeys(value, ["schemaVersion", "id", "attachment", "at", "kind", "changeId", "title", "lines"])
	)
		return null;
	const v = value;
	if (v.schemaVersion !== "endo.harness-notification.v0") return null;
	if (!isEvidenceId(v.id) || !isEvidenceId(v.changeId)) return null;
	if (typeof v.attachment !== "string" || !isWellFormedKindV0(v.attachment)) return null;
	if (typeof v.at !== "string" || !isIso8601UtcV0(v.at)) return null;
	if (!(ENDO_HARNESS_NOTIFICATION_KINDS_V0 as readonly unknown[]).includes(v.kind)) return null;
	if (!isText(v.title, 256)) return null;
	if (!Array.isArray(v.lines) || v.lines.length === 0 || !v.lines.every((line) => isText(line, 1024))) return null;
	return value as unknown as EndoHarnessNotificationV0;
}

// ---------------------------------------------------------------------------------------------------------------
// Source entry reference
// ---------------------------------------------------------------------------------------------------------------

/**
 * A runtime's own identifier for a durable entry, carried in the payload of the events an adapter maps from it. Both
 * identifiers are opaque: never parsed, never ordered, never converted to a number. Endophasia's event id and the
 * store's sequence are separate and authoritative for Endophasia; this reference is what catch-up resumes from and
 * what duplicate detection keys on.
 */
export interface EndoSourceEntryRefV0 {
	schemaVersion: "endo.source-entry-ref.v0";
	/** The runtime family, e.g. `pi`. */
	runtime: string;
	/** The runtime's session identifier, as the runtime reported it. */
	sessionId: string;
	/** The runtime's entry identifier, as the runtime reported it. */
	entryId: string;
}

/** Validates a source entry reference. Returns the value unchanged, or null. */
export function validateEndoSourceEntryRefV0(value: unknown): EndoSourceEntryRefV0 | null {
	if (!isPlain(value) || !onlyKeys(value, ["schemaVersion", "runtime", "sessionId", "entryId"])) return null;
	if (value.schemaVersion !== "endo.source-entry-ref.v0") return null;
	if (typeof value.runtime !== "string" || !isWellFormedKindV0(value.runtime)) return null;
	if (!isText(value.sessionId, 256) || !isText(value.entryId, 256)) return null;
	return value as unknown as EndoSourceEntryRefV0;
}

/** A harness-registry record of any kind this reader knows. */
export type EndoHarnessRegistryRecordV0 =
	| EndoHarnessFingerprintV0
	| EndoHarnessFingerprintV1
	| EndoHarnessChangeV0
	| EndoHarnessChangeV1
	| EndoCapabilityEvidenceV0
	| EndoCapabilityStateV0
	| EndoHarnessNotificationV0;

/** The harness-registry record versions this reader knows, each read by its own validator. */
export const ENDO_HARNESS_REGISTRY_RECORD_VERSIONS_V0 = defineEndoVersionTableV0<EndoHarnessRegistryRecordV0>(
	"endo.harness-registry-record",
	[
		["endo.harness-fingerprint.v0", validateEndoHarnessFingerprintV0],
		["endo.harness-fingerprint.v1", validateEndoHarnessFingerprintV1],
		["endo.harness-change.v0", validateEndoHarnessChangeV0],
		["endo.harness-change.v1", validateEndoHarnessChangeV1],
		["endo.capability-evidence.v0", validateEndoCapabilityEvidenceV0],
		["endo.capability-state.v0", validateEndoCapabilityStateV0],
		["endo.harness-notification.v0", validateEndoHarnessNotificationV0],
	],
);
