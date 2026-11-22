// Reading and sealing protected-experiment records (protocol/protected-experiment.ts) with their digests: a trial record's own digest,
// its submission manifest's digest, and a run record's spec digest. A reader that finds any of them wrong refuses the record, naming why:
// a truncated, edited or inconsistent record is never partly read.

import { readFileSync } from "node:fs";
import {
	ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2,
	ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2,
	type EndoProtectedChangeSetV2,
	type EndoProtectedRun,
	type EndoProtectedTrial,
	type EndoProtectedTrialV0,
	readEndoProtectedRunV0,
	readEndoProtectedTrialV0,
} from "../../protocol/protected-experiment.ts";
import {
	ENDO_CHANGESET_REFUSAL_REASONS_V0,
	type EndoChangeSetRefusalReasonV0,
	type EndoChangeSetRefusalV0,
} from "../../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

export type EndoProtectedReadV0<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The digest a trial record carries: of its canonical JSON without `recordSha256`. */
export function endoProtectedTrialDigestV0(record: Omit<EndoProtectedTrial, "recordSha256">): string {
	const { recordSha256: _ignored, ...rest } = record as EndoProtectedTrial;
	return sha256HexV0(canonicalEndoJsonV0(rest as unknown as Record<string, unknown>));
}

/**
 * A collector's refusals as a staged record lists them: the first `ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2` in the collector's order,
 * the count of the rest, and each path cut to `ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2` characters (never inside a surrogate pair)
 * with its full length and the SHA-256 of its UTF-8 bytes when it was cut, and every refusal counted by reason (`refusalCounts`), which is
 * what the record's invalidating conditions are derived from. Every refusal the collector can make is recorded this way.
 */
export function endoProtectedChangeSetRefusalsV2(
	refusals: readonly EndoChangeSetRefusalV0[],
): Pick<EndoProtectedChangeSetV2["collection"], "refusals" | "refusalsOmitted" | "refusalCounts"> {
	const max = ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2;
	return {
		refusals: refusals.slice(0, ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2).map(({ path, reason }) => {
			if (path.length <= max) return { path, reason, truncated: null };
			const cut = /[\uD800-\uDBFF]/.test(path[max - 1] as string) ? max - 1 : max;
			return { path: path.slice(0, cut), reason, truncated: { length: path.length, sha256: sha256HexV0(path) } };
		}),
		refusalsOmitted: Math.max(0, refusals.length - ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2),
		refusalCounts: Object.fromEntries(
			ENDO_CHANGESET_REFUSAL_REASONS_V0.map((k) => [k, refusals.filter((r) => r.reason === k).length]),
		) as Record<EndoChangeSetRefusalReasonV0, number>,
	};
}

/**
 * A complete trial record (either version), sealed with its digest. Throws if the result would not be read back (the writer is the reader's
 * first user).
 */
export function sealEndoProtectedTrialV0<T extends EndoProtectedTrial>(record: Omit<T, "recordSha256">): T {
	const sealed = {
		...record,
		recordSha256: endoProtectedTrialDigestV0(record as Omit<EndoProtectedTrial, "recordSha256">),
	} as T;
	const back = checkEndoProtectedTrialV0(sealed);
	if (!back.ok) throw new TypeError(`refusing to write an unreadable protected-trial record: ${back.reason}`);
	return sealed;
}

const manifestDigest = (files: EndoProtectedTrialV0["submission"]["files"]) =>
	sha256HexV0(canonicalEndoJsonV0(files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }))));

/** A trial record value: its version's rules, then its digests. */
export function checkEndoProtectedTrialV0(value: unknown): EndoProtectedReadV0<EndoProtectedTrial> {
	const read = readEndoProtectedTrialV0(value);
	if (!read.ok) return { ok: false, reason: read.message };
	const r = read.value;
	if (endoProtectedTrialDigestV0(r) !== r.recordSha256)
		return { ok: false, reason: "the record's digest does not match its content" };
	if ("submission" in r && r.submission.sha256 !== null && manifestDigest(r.submission.files) !== r.submission.sha256)
		return { ok: false, reason: "the submission's digest does not match its manifest" };
	return { ok: true, value: r };
}

/** A run record value: its version's rules, then the digest of the spec it embeds. */
export function checkEndoProtectedRunV0(value: unknown): EndoProtectedReadV0<EndoProtectedRun> {
	const read = readEndoProtectedRunV0(value);
	if (!read.ok) return { ok: false, reason: read.message };
	if (
		sha256HexV0(canonicalEndoJsonV0(read.value.spec as unknown as Record<string, unknown>)) !== read.value.specSha256
	)
		return { ok: false, reason: "specSha256 is not the digest of the embedded spec" };
	return { ok: true, value: read.value };
}

const parseFile = (path: string): unknown => {
	const text = readFileSync(path, "utf8");
	return JSON.parse(text);
};

export function readEndoProtectedTrialFileV0(path: string): EndoProtectedReadV0<EndoProtectedTrial> {
	try {
		return checkEndoProtectedTrialV0(parseFile(path));
	} catch {
		return { ok: false, reason: "the record is not readable JSON" };
	}
}

export function readEndoProtectedRunFileV0(path: string): EndoProtectedReadV0<EndoProtectedRun> {
	try {
		return checkEndoProtectedRunV0(parseFile(path));
	} catch {
		return { ok: false, reason: "the run record is not readable JSON" };
	}
}
