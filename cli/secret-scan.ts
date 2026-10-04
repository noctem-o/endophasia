/**
 * The secret scan: a hard gate before cassettes (or any captured run data) are committed. It reads every captured
 * byte the cassette would publish, decoded: request bodies, response wire bytes, workspace snapshot archives (each
 * file's content), prompts, recorded headers, and the session's events and evidence. It looks for:
 *
 *   api-key          provider and platform key shapes (sk-…, sk-ant-…, ghp_/gho_/ghs_…, github_pat_…, xox?-…, AKIA…,
 *                    AIza…, hf_…, glpat-…)
 *   private-key      PEM private key blocks
 *   jwt              three base64url segments starting eyJ
 *   bearer-token     Authorization or Bearer values other than the scratch placeholder `local`
 *   secret-env       NAME=value where NAME names a key, token, secret, password or credential
 *   auth-header      a raw Authorization / Proxy-Authorization / Cookie / X-Api-Key header line with a value
 *   path-outside-scratch  an absolute path under no allowed root (the run's scratch roots, and the allow-list)
 *
 * Usernames, hostnames, kernel strings and dates are not secrets and are not gated (the operator consented to them in
 * committed cassettes); they are reported elsewhere. A finding never prints the matched secret: only the kind, where,
 * and a masked excerpt.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonValueV0 } from "../protocol/primitives.ts";

export interface EndoSecretFindingV0 {
	kind: "api-key" | "private-key" | "jwt" | "bearer-token" | "secret-env" | "auth-header" | "path-outside-scratch";
	where: string;
	/** The match with everything but its first 4 characters masked. */
	masked: string;
}

export interface EndoSecretScanV0 {
	passed: boolean;
	scanned: { items: number; bytes: number };
	findings: EndoSecretFindingV0[];
	/** Absolute-path roots allowed, and how many paths each covered. */
	allowedPaths: Record<string, number>;
}

const PATTERNS: [EndoSecretFindingV0["kind"], RegExp][] = [
	[
		"api-key",
		/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpsr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,})/g,
	],
	["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
	["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
	["bearer-token", /\bBearer\s+(?!local\b)[A-Za-z0-9._~+/=-]{8,}/g],
	["secret-env", /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)=(?!local\b)[^\s"'\\]{4,}/g],
	["auth-header", /(?:^|\\r\\n|\r\n|\n)(?:authorization|proxy-authorization|cookie|x-api-key)\s*:\s*\S+/gi],
];

const PATH =
	/(?<![A-Za-z0-9_.~-])\/(?:home|root|Users|tmp|var|etc|opt|usr|srv|mnt|media|run|private)(?:\/[A-Za-z0-9._@+-]+)+/g;

function mask(text: string): string {
	return text.length <= 4 ? "****" : `${text.slice(0, 4)}${"*".repeat(Math.min(12, text.length - 4))}`;
}

/** Scan named texts. `allowedRoots`: absolute path prefixes that may appear (scratch roots, the Pi install). */
export function endoSecretScanV0(
	items: Iterable<{ where: string; text: string }>,
	allowedRoots: readonly string[],
): EndoSecretScanV0 {
	const findings: EndoSecretFindingV0[] = [];
	const allowedPaths: Record<string, number> = Object.fromEntries(allowedRoots.map((root) => [root, 0]));
	let count = 0;
	let bytes = 0;
	for (const { where, text } of items) {
		count += 1;
		bytes += Buffer.byteLength(text);
		for (const [kind, pattern] of PATTERNS)
			for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags)))
				findings.push({ kind, where, masked: mask(match[0].trim()) });
		for (const match of text.matchAll(PATH)) {
			const root = allowedRoots.find((allowed) => match[0] === allowed || match[0].startsWith(`${allowed}/`));
			if (root !== undefined) allowedPaths[root] = (allowedPaths[root] ?? 0) + 1;
			else findings.push({ kind: "path-outside-scratch", where, masked: match[0] });
		}
	}
	// A path is not a secret by itself: it is reported in full so the operator can judge it (no masking).
	return { passed: findings.length === 0, scanned: { items: count, bytes }, findings, allowedPaths };
}

/** The decoded texts of a strict-JSON value, for scanning: every string, with base64 file contents decoded too. */
export function* endoScanTextsV0(where: string, value: JsonValueV0): Generator<{ where: string; text: string }> {
	if (typeof value === "string") yield { where, text: value };
	else if (Array.isArray(value))
		for (const [index, entry] of value.entries()) yield* endoScanTextsV0(`${where}[${index}]`, entry);
	else if (value !== null && typeof value === "object")
		for (const [key, entry] of Object.entries(value)) {
			if (key === "base64" && typeof entry === "string")
				yield { where: `${where}.${key}`, text: Buffer.from(entry, "base64").toString("utf8") };
			else yield* endoScanTextsV0(`${where}.${key}`, entry as JsonValueV0);
		}
}

/**
 * Scan a directory exactly as it would be committed (an exported cassette fixture, or any directory): every file, as
 * UTF-8; a JSON blob (a workspace archive) is walked, so each archived file's content is scanned decoded. Nothing is
 * skipped: what is not scanned is not committed.
 */
export function endoSecretScanDirectoryV0(dir: string, allowedRoots: readonly string[]): EndoSecretScanV0 {
	const files = (root: string): string[] =>
		readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
			entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)],
		);
	function* items(): Generator<{ where: string; text: string }> {
		for (const file of files(dir).sort()) {
			const where = relative(dir, file);
			const text = readFileSync(file).toString("utf8");
			let parsed: JsonValueV0 | undefined;
			if (!file.endsWith(".jsonl"))
				try {
					parsed = JSON.parse(text) as JsonValueV0;
				} catch {
					parsed = undefined;
				}
			if (parsed !== undefined && typeof parsed === "object" && parsed !== null)
				yield* endoScanTextsV0(where, parsed);
			else yield { where, text };
		}
	}
	return endoSecretScanV0(items(), allowedRoots);
}
