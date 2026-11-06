// Reading and sealing protected-experiment records (protocol/protected-experiment.ts) with their digests: a trial record's own digest,
// its submission manifest's digest, and a run record's spec digest. A reader that finds any of them wrong refuses the record, naming why:
// a truncated, edited or inconsistent record is never partly read.

import { readFileSync } from "node:fs";
import {
	type EndoProtectedRunV0,
	type EndoProtectedTrialV0,
	readEndoProtectedRunV0,
	readEndoProtectedTrialV0,
} from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "./canonical-json.ts";

export type EndoProtectedReadV0<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The digest a trial record carries: of its canonical JSON without `recordSha256`. */
export function endoProtectedTrialDigestV0(record: Omit<EndoProtectedTrialV0, "recordSha256">): string {
	const { recordSha256: _ignored, ...rest } = record as EndoProtectedTrialV0;
	return sha256HexV0(canonicalEndoJsonV0(rest as unknown as Record<string, unknown>));
}

/** A complete trial record, sealed with its digest. Throws if the result would not be read back (the writer is the reader's first user). */
export function sealEndoProtectedTrialV0(record: Omit<EndoProtectedTrialV0, "recordSha256">): EndoProtectedTrialV0 {
	const sealed = { ...record, recordSha256: endoProtectedTrialDigestV0(record) } as EndoProtectedTrialV0;
	const back = checkEndoProtectedTrialV0(sealed);
	if (!back.ok) throw new TypeError(`refusing to write an unreadable protected-trial record: ${back.reason}`);
	return sealed;
}

const manifestDigest = (files: EndoProtectedTrialV0["submission"]["files"]) =>
	sha256HexV0(canonicalEndoJsonV0(files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 }))));

/** A trial record value: its version's rules, then its digests. */
export function checkEndoProtectedTrialV0(value: unknown): EndoProtectedReadV0<EndoProtectedTrialV0> {
	const read = readEndoProtectedTrialV0(value);
	if (!read.ok) return { ok: false, reason: read.message };
	const r = read.value;
	if (endoProtectedTrialDigestV0(r) !== r.recordSha256)
		return { ok: false, reason: "the record's digest does not match its content" };
	if (r.submission.sha256 !== null && manifestDigest(r.submission.files) !== r.submission.sha256)
		return { ok: false, reason: "the submission's digest does not match its manifest" };
	return { ok: true, value: r };
}

/** A run record value: its version's rules, then the digest of the spec it embeds. */
export function checkEndoProtectedRunV0(value: unknown): EndoProtectedReadV0<EndoProtectedRunV0> {
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

export function readEndoProtectedTrialFileV0(path: string): EndoProtectedReadV0<EndoProtectedTrialV0> {
	try {
		return checkEndoProtectedTrialV0(parseFile(path));
	} catch {
		return { ok: false, reason: "the record is not readable JSON" };
	}
}

export function readEndoProtectedRunFileV0(path: string): EndoProtectedReadV0<EndoProtectedRunV0> {
	try {
		return checkEndoProtectedRunV0(parseFile(path));
	} catch {
		return { ok: false, reason: "the run record is not readable JSON" };
	}
}
