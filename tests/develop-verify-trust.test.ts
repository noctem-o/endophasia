// DEVELOP-VERIFY-TRUST-001 (research/develop-verify-trust/): the committed evidence still says what the report says. No sandbox, no
// process: the oracle is the pinned one, and every committed record re-reads, through the study's own reader, to the class in cases.json.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readRecord } from "../research/develop-verify-trust/verify.ts";

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
});
