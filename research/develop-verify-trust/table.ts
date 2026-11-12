// DEVELOP-VERIFY-TRUST-001: the case table (results/cases.json), derived from a run's committed results, with every committed record
// re-read by the verifier's own reader against the committed oracle. Needs nothing outside this repository.
//
//   node research/develop-verify-trust/table.ts [results/run-1]      writes <dir>/../cases.json and prints a Markdown table

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRecord } from "./verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const run = resolve(process.argv[2] ?? join(HERE, "results/run-1"));
const PIN = "3dc2d86db7e8cb1b24a422ee1cebfd49eed61592bd6ff3442b05a28e23081d31";
const ORACLE = join(HERE, "oracle/manifest.json");

interface Row {
	id: string;
	title: string;
	candidate: string;
	condition: string;
	expected: Record<string, string>;
	observed: Record<string, string>;
	agree: Record<string, boolean>;
	detail: Record<string, any>;
}
const results = JSON.parse(readFileSync(join(run, "results.json"), "utf8")) as {
	rows: Row[];
	truth: Record<string, string>;
};
const records = join(run, "records");
const reread = Object.fromEntries(
	readdirSync(records)
		.filter((f) => f.endsWith(".json"))
		.map((f) => [f.replace(/\.json$/, ""), readRecord(join(records, f), ORACLE, PIN)]),
);

const evidenceOf = (r: Row): string[] => {
	const refs: string[] = [];
	if (r.detail.ordinary !== undefined) refs.push(`evidence/ordinary-${r.id}-evidence.json`);
	for (const m of ["filtered", "sandbox"])
		if (existsSync(join(records, `${r.id}-${m}.json`)) || existsSync(join(records, `${r.id}-${m}.journal`)))
			refs.push(`records/${r.id}-${m}.${existsSync(join(records, `${r.id}-${m}.json`)) ? "json" : "journal"}`);
	if (r.id === "9c") refs.push(...Object.keys(r.detail.variants).map((v) => `records/${v}.json`));
	if (r.id === "9d") refs.push("records/9d-forged.json");
	const base = r.candidate === "A-link" ? "A" : r.candidate;
	refs.push(`evidence/truth-${base}.txt`);
	return refs;
};

const cases = results.rows.map((r) => ({
	id: r.id,
	title: r.title,
	exploratory: r.detail.exploratory === true,
	candidate: r.candidate,
	condition: r.condition,
	truth: r.candidate === "A-link" ? results.truth.A : results.truth[r.candidate],
	ordinary:
		r.detail.ordinary === undefined
			? null
			: { ledger: r.detail.ordinary.ledger, criteria: r.detail.ordinary.criteria },
	filtered:
		r.detail.filtered === undefined
			? null
			: {
					verdict: r.detail.filtered.verdict,
					reason: r.detail.filtered.summary?.reason ?? null,
					reread: reread[`${r.id}-filtered`] ?? null,
				},
	sandbox:
		r.detail.sandbox === undefined
			? null
			: {
					verdict: r.detail.sandbox.verdict,
					reason: r.detail.sandbox.summary?.reason ?? null,
					preflight: r.detail.sandbox.summary?.preflight?.status ?? null,
					reread: reread[`${r.id}-sandbox`] ?? null,
				},
	reader:
		r.id === "9a" ? r.detail.reader : r.id === "9d" ? reread["9d-forged"] : r.id === "9c" ? r.detail.variants : null,
	expected: r.expected,
	observed: r.observed,
	agree: r.agree,
	evidence: evidenceOf(r).map((e) => `results/${run.split("/").at(-1)}/${e}`),
}));
// The committed records, re-read here, must say what the run's reader said.
const mismatch = cases.flatMap((c) =>
	(["filtered", "sandbox"] as const)
		.filter((m) => c[m] !== null && c[m]?.reread !== null)
		.filter((m) => {
			const runReader = results.rows.find((r) => r.id === c.id)?.detail[m]?.reader;
			return runReader !== undefined && JSON.stringify(runReader) !== JSON.stringify(c[m]?.reread);
		})
		.map((m) => `${c.id}-${m}`),
);
writeFileSync(
	join(run, "..", "cases.json"),
	`${JSON.stringify({ source: run.split("/").at(-1), rereadMismatches: mismatch, cases }, null, 2)}\n`,
);
const cell = (c: (typeof cases)[number], m: "O" | "F" | "S") =>
	c.expected[m] === undefined ? "—" : `${c.observed[m]}${c.agree[m] ? "" : ` (expected ${c.expected[m]})`}`;
process.stdout.write("| # | Case | Cand. | Truth | O | F | S |\n| :-- | :-- | :-- | :-- | :-- | :-- | :-- |\n");
for (const c of cases)
	process.stdout.write(
		`| ${c.id} | ${c.title} | ${c.candidate} | ${c.truth} | ${cell(c, "O")} | ${cell(c, "F")} | ${cell(c, "S")} |\n`,
	);
process.stdout.write(`\nre-read mismatches: ${JSON.stringify(mismatch)}\n`);
