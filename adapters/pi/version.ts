// The Pi adapter's own versions and its Pi version policy.
//
// The versions below are dependencies of every capability evidence record (protocol/harness.ts): bumping one
// invalidates exactly the evidence that depends on it. Bump ADAPTER when transport or command handling changes,
// MAPPING when the RPC-to-endo.* mapping changes, SUITE when the set or meaning of conformance checks changes (a single
// check's definition change is caught by its own definition digest instead).
//
// Version policy. Pi is installed and updated by the user, never by Endophasia. The policy only says how much
// evidence exists for a reported version; it never admits a capability on its own:
// - "tested": the adapter's local checks and live study were run against this exact version (see
//   docs/pi-attach-inventory.md, "Version policy"). Capabilities still need current evidence for the observed
//   fingerprint; a tested version is not a substitute for it.
// - "untested": a parseable release outside the tested list, newer or older, same major or not. Local checks run; live
//   capabilities stay unverified until the operator runs the live study.
// - "prerelease": a parseable prerelease (e.g. 1.1.0-beta.1). Treated as untested.
// - "unknown": no version was reported, or it does not parse. Treated as untested, and the identity is reduced unless
//   the entrypoint digest is present.

export const PI_ADAPTER_VERSION = "pi-rpc-adapter.1";
export const PI_MAPPING_VERSION = "pi-rpc-mapping.1";
export const PI_SUITE_VERSION = "pi-rpc-suite.1";

/** Exact Pi releases the deterministic suite and the real-runtime acceptance run were executed against. */
export const PI_TESTED_VERSIONS: readonly string[] = Object.freeze(["1.0.0"]);

export type PiVersionPolicyV0 = "tested" | "untested" | "prerelease" | "unknown";

export interface SemverV0 {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse a semver 2.0.0 string, or null. Build metadata is accepted and ignored for precedence. */
export function parseSemverV0(text: string): SemverV0 | null {
	const match = SEMVER.exec(text);
	if (match === null) return null;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (![major, minor, patch].every(Number.isSafeInteger)) return null;
	return { major, minor, patch, prerelease: match[4] === undefined ? [] : match[4].split(".") };
}

/** Semver precedence: negative, zero or positive. */
export function compareSemverV0(a: SemverV0, b: SemverV0): number {
	for (const key of ["major", "minor", "patch"] as const) {
		if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
	}
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const x = a.prerelease[index];
		const y = b.prerelease[index];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		if (x === y) continue;
		const xNumeric = /^\d+$/.test(x);
		const yNumeric = /^\d+$/.test(y);
		if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
		if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
		return x < y ? -1 : 1;
	}
	return 0;
}

/**
 * Extract the version from `pi --version` output. Pi 1.0.0 prints the bare version ("1.0.0"); a leading "v" or a
 * "pi " prefix is tolerated. Anything else is not guessed at: null.
 */
export function parsePiVersionOutputV0(output: string): string | null {
	const line = output.trim().split(/\r?\n/)[0]?.trim() ?? "";
	const candidate = line.replace(/^(?:pi\s+)?v?/i, "");
	return parseSemverV0(candidate) === null ? null : candidate;
}

/** The policy for one reported version (see the module header). */
export function piVersionPolicyV0(version: string | null): PiVersionPolicyV0 {
	if (version === null) return "unknown";
	const parsed = parseSemverV0(version);
	if (parsed === null) return "unknown";
	if (parsed.prerelease.length > 0) return "prerelease";
	return PI_TESTED_VERSIONS.includes(version) ? "tested" : "untested";
}
