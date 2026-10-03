// The Pi adapter's own versions and its Pi version policy.
//
// The versions below are dependencies of every capability evidence record (protocol/harness.ts): bumping one
// invalidates exactly the evidence that depends on it. Bump ADAPTER when transport or command handling changes,
// MAPPING when the RPC-to-endo.* mapping changes, SUITE when the set or meaning of conformance checks changes (a single
// check's definition change is caught by its own definition digest instead).
//
// The verified baseline. Pi is installed and updated by the user, never by Endophasia. Pi 1.0.0 is the release this
// adapter was built against and run against end to end: its documented RPC surface was reviewed, and the deterministic
// suite's fake Pi models its records. That makes it a baseline, not a whitelist: the version standing below is
// information for the operator and never admits, refuses or skips anything. Capabilities are admitted only on current
// evidence for the observed fingerprint, whatever the version; a non-baseline release earns admission through the same
// local checks and live study as the baseline. The one record tied to the baseline is the documented-surface review
// (checks.ts), which is evidence about the reviewed release's documentation and therefore applies only to that release;
// the live study observes the same absences on any release.
//
// - "verified-baseline": the reported version is a release whose surface was reviewed and recorded end to end.
// - "unverified-release": any other parseable release, newer or older. Nothing is assumed in either direction.
// - "unverified-prerelease": a parseable prerelease.
// - "unknown": no version was reported, or it does not parse (e.g. a local build). The identity is reduced unless the
//   entrypoint digest is present.

export const PI_ADAPTER_VERSION = "pi-rpc-adapter.2";
export const PI_MAPPING_VERSION = "pi-rpc-mapping.2";
export const PI_SUITE_VERSION = "pi-rpc-suite.2";

/** Releases whose documented RPC surface was reviewed and whose behaviour was recorded end to end. Not a whitelist. */
export const PI_VERIFIED_BASELINE_VERSIONS: readonly string[] = Object.freeze(["1.0.0"]);

export type PiVersionStandingV0 = "verified-baseline" | "unverified-release" | "unverified-prerelease" | "unknown";

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

/** The informational standing of one reported version (see the module header). It gates nothing. */
export function piVersionStandingV0(version: string | null): PiVersionStandingV0 {
	if (version === null) return "unknown";
	const parsed = parseSemverV0(version);
	if (parsed === null) return "unknown";
	if (PI_VERIFIED_BASELINE_VERSIONS.includes(version)) return "verified-baseline";
	return parsed.prerelease.length > 0 ? "unverified-prerelease" : "unverified-release";
}
