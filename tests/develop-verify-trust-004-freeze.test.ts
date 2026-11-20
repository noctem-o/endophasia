import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// OPERATOR.md must never contradict the freeze it selects: every frozen-file digest it quotes must be that file's entry in
// FROZEN.sha256, and the selected source commit F must carry this same manifest and a document that passes the same check.
// TRUST004_FREEZE_CHECK=1 (the CI job with full history) makes a missing F a failure instead of a skip.
const T = "research/develop-verify-trust-004";
const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });

// Digests the document quotes that are not frozen files, each named for what it pins.
const EXTERNAL = new Map([
	[
		"794eb4889b39e1f0ed7d5ae998b2a1ed2137db8cf8c3476cf2962c7437ecb003",
		"protocol image Arch-Linux-x86_64-cloudimg-20261101.620452",
	],
	["26c0877e89bee49b47427f3a54b389fed78b6cd8284aa66cd11b60201febf18b", "attempt 1 overlay.qcow2"],
]);

const manifestOf = (text: string) =>
	new Map(
		text
			.trim()
			.split("\n")
			.map((l) => {
				const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
				if (m === null) throw new Error(`malformed manifest line: ${l}`);
				return [m[2] as string, m[1] as string] as const;
			}),
	);

/** Every way the document can be wrong about the manifest, as readable strings; empty when it is consistent. */
function contradictions(doc: string, manifest: Map<string, string>) {
	const problems: string[] = [];
	const byDigest = new Map([...manifest].map(([path, digest]) => [digest, path]));
	for (const m of doc.matchAll(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g)) {
		const digest = m[0];
		const line = doc.slice(0, m.index).split("\n").length;
		if (EXTERNAL.has(digest)) continue;
		const path = byDigest.get(digest);
		if (path === undefined) {
			problems.push(`line ${line}: ${digest} is neither a FROZEN.sha256 entry nor a declared external pin`);
			continue;
		}
		const name = path.split("/").pop() as string;
		if (!doc.slice(Math.max(0, m.index - 200), m.index).includes(name))
			problems.push(`line ${line}: ${digest} is ${path}'s digest but is not quoted next to that file's name`);
	}
	for (const [path, digest] of manifest) {
		const rel = path.startsWith(`${T}/`) ? path.slice(T.length + 1) : path;
		for (const m of doc.matchAll(new RegExp(`${rel.replace(/[.]/g, "\\.")}[^\n]*?([0-9a-f]{64})`, "g")))
			if (m[1] !== digest && !EXTERNAL.has(m[1] as string))
				problems.push(`${rel} is quoted as ${m[1]}, FROZEN.sha256 says ${digest}`);
	}
	for (const m of doc.matchAll(/\b(\d+) (?:frozen |manifest )?(?:entries|files)\b/g)) {
		const line = doc.slice(0, m.index).split("\n").length;
		if (Number(m[1]) !== manifest.size)
			problems.push(`line ${line}: quotes ${m[1]} entries, FROZEN.sha256 has ${manifest.size}`);
	}
	const f = /^F=([0-9a-f]{40}|refs\/tags\/trust004-amendment-\d+)$/m.exec(doc)?.[1];
	const selected = /\*\*Selected source commit:\*\* `([0-9a-f]{40}|refs\/tags\/trust004-amendment-\d+)`/.exec(
		doc,
	)?.[1];
	if (f === undefined || selected === undefined) problems.push("no F= line or no selected source commit");
	else if (f !== selected) problems.push(`F=${f} but the selected source commit is ${selected}`);
	return problems;
}

const doc = readFileSync(`${T}/OPERATOR.md`, "utf8");
const manifestText = readFileSync(`${T}/FROZEN.sha256`, "utf8");
const manifest = manifestOf(manifestText);
const F = /^F=([^\s]+)$/m.exec(doc)?.[1] ?? "";
const ref = /^FREEZE_REF=(refs\/tags\/trust004-amendment-\d+)$/m.exec(doc)?.[1] ?? "";
const haveF = git("cat-file", "-e", `${F}^{commit}`).status === 0;
const required = process.env.TRUST004_FREEZE_CHECK === "1";

describe("TRUST-004 OPERATOR.md agrees with its freeze", () => {
	it("is itself a frozen file, so the page inside F is the page the operator reads", () => {
		expect(manifest.has(`${T}/OPERATOR.md`)).toBe(true);
	});

	it("quotes only the manifest's own digests for frozen files", () => {
		expect(contradictions(doc, manifest)).toEqual([]);
		expect(doc).toContain(manifest.get(`${T}/guest/session.sh`));
	});

	it("catches a stale session.sh digest and an F that disagrees with the selected commit", () => {
		const stale = doc.replaceAll(
			manifest.get(`${T}/guest/session.sh`) as string,
			"43a348be67a002f14de87fa6769776742031b2ee348f67570d424079ea60896c",
		);
		expect(contradictions(stale, manifest).length).toBeGreaterThan(0);
		const staleCount = doc.replace("`frozen-check all N entries match`", "`frozen-check all 36 entries match`");
		expect(staleCount).not.toBe(doc);
		expect(contradictions(staleCount, manifest)).toContain(
			`line ${doc.slice(0, doc.indexOf("frozen-check all N")).split("\n").length}: quotes 36 entries, FROZEN.sha256 has ${manifest.size}`,
		);
		const otherF = doc.replace(/^F=\S+$/m, `F=${"0".repeat(40)}`);
		expect(contradictions(otherF, manifest)).toContain(`F=${"0".repeat(40)} but the selected source commit is ${F}`);
	});

	it("has F available when the full-history check is required", () => {
		if (!required) return;
		expect(haveF, `selected source commit ${F} is not in this clone`).toBe(true);
		expect(ref).not.toBe("");
		const tag = git("rev-parse", "--verify", `${ref}^{commit}`);
		expect(tag.status, tag.stderr).toBe(0);
		expect(tag.stdout).toBe(git("rev-parse", "--verify", `${F}^{commit}`).stdout);
	});

	it.runIf(haveF)(
		"selects an F that carries this manifest, verifies against it, and whose own document agrees with it",
		() => {
			const atF = git("show", `${F}:${T}/FROZEN.sha256`);
			expect(atF.status, atF.stderr).toBe(0);
			expect(atF.stdout).toBe(manifestText);
			const docAtF = git("show", `${F}:${T}/OPERATOR.md`);
			expect(docAtF.status, docAtF.stderr).toBe(0);
			expect(contradictions(docAtF.stdout, manifest)).toEqual([]);
			expect(docAtF.stdout).toContain(`\nF=${ref}\n`);
			expect(docAtF.stdout, "the operator page on the branch must be the page inside F").toBe(doc);
			for (const [path, digest] of manifest) {
				const blob = spawnSync("git", ["show", `${F}:${path}`]);
				expect(blob.status, path).toBe(0);
				expect(spawnSync("sha256sum", [], { input: blob.stdout, encoding: "utf8" }).stdout.slice(0, 64), path).toBe(
					digest,
				);
			}
		},
	);
});
