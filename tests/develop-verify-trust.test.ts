// DEVELOP-VERIFY-TRUST-001 (research/develop-verify-trust/): the committed evidence still says what the report says. No sandbox, no
// process: the oracle is the pinned one, and every committed record re-reads, through the study's own reader, to the class in cases.json.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exportCommit, readRecord } from "../research/develop-verify-trust/verify.ts";

const DIR = fileURLToPath(new URL("../research/develop-verify-trust/", import.meta.url));
const ORACLE = join(DIR, "oracle/manifest.json");
const PIN = "3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31";
const RECORDS = join(DIR, "results/run-1/records");
const cases = JSON.parse(readFileSync(join(DIR, "results/cases.json"), "utf8")) as {
	rereadMismatches: string[];
	cases: {
		id: string;
		observed: Record<string, string>;
		filtered: { reread: { class: string } | null } | null;
		sandbox: { verdict: string; reread: { class: string } | null } | null;
	}[];
};

describe("DEVELOP-VERIFY-TRUST-001 committed evidence", () => {
	it("pins the oracle the protocol names", () => {
		expect(createHash("sha256").update(readFileSync(ORACLE)).digest("hex")).toBe(PIN);
		expect(readFileSync(join(DIR, "PROTOCOL.md"), "utf8")).toContain(PIN);
	});

	it("re-reads every committed record to its recorded class", () => {
		expect(cases.rereadMismatches).toEqual([]);
		const reread = (name: string) => readRecord(join(RECORDS, `${name}.json`), ORACLE, PIN).class;
		for (const c of cases.cases) {
			if (c.filtered?.reread) expect(reread(`${c.id}-filtered`), `${c.id}-filtered`).toBe(c.filtered.reread.class);
			if (c.sandbox?.reread) expect(reread(`${c.id}-sandbox`), `${c.id}-sandbox`).toBe(c.sandbox.reread.class);
		}
		// The two preregistered demonstrations of what the reader cannot establish, and the ones it must refuse.
		expect(reread("2-sandbox")).toBe("FAIL");
		expect(reread("4c-sandbox")).toBe("UNKNOWN");
		expect(reread("9d-forged")).toBe("PASS");
		for (const v of ["verdict-flipped", "flipped-resealed", "case-removed", "truncated", "other-oracle"])
			expect(reread(`9c-${v}`)).toBe("UNKNOWN");
	});

	it("never reads an edited copy of a failing record as a pass", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-trust-"));
		try {
			const text = readFileSync(join(RECORDS, "2-sandbox.json"), "utf8");
			const edits = [
				text.replace('"verdict": "FAIL"', '"verdict": "PASS"'),
				text.replace(/"matched": false/g, '"matched": true'),
				text.slice(0, 100),
				"",
			];
			for (const [i, edited] of edits.entries()) {
				const file = join(dir, `${i}.json`);
				writeFileSync(file, edited);
				expect(readRecord(file, ORACLE, PIN).class, `edit ${i}`).toBe("UNKNOWN");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// Addendum 1, C2 (research/develop-verify-trust/addendum-1/ADDENDUM.md, R5): a genuine PASS is a PASS only for its own commit.
	it("binds a record to the commit it is read for", () => {
		const commits = (
			JSON.parse(readFileSync(join(DIR, "results/run-1/results.json"), "utf8")) as {
				commits: Record<string, string>;
			}
		).commits;
		const file = join(RECORDS, "1-sandbox.json");
		expect(readRecord(file, ORACLE, PIN).class).toBe("PASS");
		expect(readRecord(file, ORACLE, PIN, { commit: commits.A as string }).class).toBe("PASS");
		expect(readRecord(file, ORACLE, PIN, { commit: commits.B as string })).toEqual({
			class: "UNKNOWN",
			reason: "candidate-mismatch",
		});
	});
});

// Addendum 1, C1 (R1, R2): the candidate's repository is untrusted input to the controller's Git reads.
const GIT_TRUSTED = (() => {
	try {
		return statSync("/usr/bin/git").uid === 0;
	} catch {
		return false;
	}
})();

describe.skipIf(!GIT_TRUSTED)("DEVELOP-VERIFY-TRUST-001 addendum 1: exporting a commit", () => {
	const env = {
		PATH: "/usr/bin",
		HOME: "/nonexistent",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.invalid",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.invalid",
	};
	const git = (dir: string, args: string[], input?: Buffer) => {
		const r = spawnSync("/usr/bin/git", ["-C", dir, ...args], { env, input });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};
	const commitFile = (dir: string, content: string) => {
		writeFileSync(join(dir, "roman.mjs"), content);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "c"]);
		return git(dir, ["rev-parse", "HEAD"]).toString().trim();
	};
	const sha = (s: string) => createHash("sha256").update(s).digest("hex");

	it("exports the commit's own tree when a replace ref names another", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-trust-"));
		try {
			const repo = join(dir, "repo");
			mkdirSync(repo);
			git(repo, ["init", "-q"]);
			const wrong = commitFile(repo, "wrong\n");
			const right = commitFile(repo, "right\n");
			git(repo, ["replace", wrong, right]);
			const got = exportCommit(repo, wrong, join(dir, "staging"));
			expect(got.ok).toBe(true);
			if (got.ok)
				expect(got.candidate.files).toEqual([
					expect.objectContaining({ path: "roman.mjs", sha256: sha("wrong\n") }),
				]);
			expect(readFileSync(join(dir, "staging/roman.mjs"), "utf8")).toBe("wrong\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never runs a promisor remote's command to fetch a missing object", () => {
		const dir = mkdtempSync(join(tmpdir(), "endo-trust-"));
		try {
			const src = join(dir, "src");
			const lazy = join(dir, "lazy");
			const marker = join(dir, "marker");
			mkdirSync(src);
			git(src, ["init", "-q"]);
			const commit = commitFile(src, "program\n");
			git(dir, ["init", "-q", lazy]);
			for (const [type, oid] of [
				["tree", git(src, ["rev-parse", "HEAD^{tree}"]).toString().trim()],
				["commit", commit],
			] as const)
				git(lazy, ["hash-object", "-t", type, "-w", "--stdin"], git(src, ["cat-file", type, oid]));
			for (const [k, v] of [
				["core.repositoryformatversion", "1"],
				["extensions.partialClone", "origin"],
				["remote.origin.url", src],
				["remote.origin.promisor", "true"],
				["remote.origin.uploadpack", `touch ${marker}; git-upload-pack`],
			])
				git(lazy, ["config", k, v]);
			expect(exportCommit(lazy, commit, join(dir, "staging"))).toEqual({ ok: false, reason: "object-unreadable" });
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
