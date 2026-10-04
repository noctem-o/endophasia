// POST-HOC (not pre-registered), computed from the committed raw data after the pre-registered analysis: how the
// `implement-function` baseline varies across the 30 paths, and whether a STEER on that task was followed at the paths
// where it varied. Prints a summary and writes `analysis/post-hoc-implement-function-baseline.json`.
//
//   node research/path-sensitivity/1.0.1/post-hoc-baseline.ts

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEndoTrialRequestsV0 } from "../../../cli/experiment-checks.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../../runtime/contracts/canonical-json.ts";
import { endoFixtureDigestKeyPathV0 } from "../../../storage/digest-key.ts";
import { normalizeToolCallIds } from "../../pinned-environment/1.0.1/analyze.ts";
import { normalizePathText } from "./analyze.ts";

const D = fileURLToPath(new URL("./", import.meta.url));
const key = { kind: "fixture" as const, path: endoFixtureDigestKeyPathV0() };
const analysis = JSON.parse(readFileSync(`${D}analysis/main-analysis.json`, "utf8")) as {
	perPath: { label: string; outcomes: Record<string, string> }[];
};
const outcome = Object.fromEntries(analysis.perPath.map((path) => [path.label, path.outcomes]));

interface Row {
	label: string;
	names: string;
	first: string;
	firstText: string;
	codeDigest: string;
	codeLines: number;
	steer: string;
	toolSteer: string;
	requests: number;
}

const rows: Row[] = [];
for (const label of Object.keys(outcome).sort()) {
	const base = `${D}raw/main/${label}/trials/implement-function/base/0`;
	const result = JSON.parse(readFileSync(`${base}/result.json`, "utf8"));
	const requests = normalizeToolCallIds(loadEndoTrialRequestsV0(`${base}/store`, result, key).requests);
	const messages = (requests.at(-1)!.messages ?? []) as {
		role: string;
		tool_calls?: { function: { name: string; arguments: string } }[];
	}[];
	const calls = messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) =>
			(message.tool_calls ?? []).map(
				(call) => [call.function.name, normalizePathText(call.function.arguments)] as const,
			),
		);
	const write = calls.find((call) => call[0] === "write");
	const code = write === undefined ? "" : (JSON.parse(write[1]) as { content: string }).content;
	rows.push({
		label,
		names: calls.map((call) => call[0]).join(">"),
		first: sha256HexV0(canonicalEndoJsonV0(calls[0])).slice(0, 8),
		firstText: calls[0]![1].slice(0, 70),
		codeDigest: sha256HexV0(code).slice(0, 8),
		codeLines: code.split("\n").length,
		steer: outcome[label]!["implement-function/steer"]!,
		toolSteer: outcome[label]!["tool-use/steer"]!,
		requests: requests.length,
	});
}

const count = (key: (row: Row) => string) =>
	rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [key(row)]: (counts[key(row)] ?? 0) + 1 }), {});
const cross = (key: (row: Row) => string) => {
	const table: Record<string, Record<string, number>> = {};
	for (const row of rows) {
		const entry = (table[key(row)] ??= {});
		entry[row.steer] = (entry[row.steer] ?? 0) + 1;
	}
	return table;
};
const summary = {
	toolNameOrders: count((row) => row.names),
	distinctFirstCalls: Object.keys(count((row) => row.first)).length,
	distinctWrittenFiles: Object.keys(count((row) => row.codeDigest)).length,
	requests: count((row) => String(row.requests)),
	steerOutcomeByToolNameOrder: cross((row) => row.names),
	steerOutcomeByFirstCall: cross((row) => row.firstText),
};
console.log(JSON.stringify(summary, null, "\t"));
writeFileSync(
	`${D}analysis/post-hoc-implement-function-baseline.json`,
	`${JSON.stringify(
		{
			postHoc:
				"not pre-registered; computed from the committed raw data (raw/main/*/trials/implement-function/base/0), after the pre-registered analysis",
			note: "per path: the baseline trial 0's tool-name order, first tool call (path-normalized), a digest of the file it writes, and the steer outcomes",
			summary,
			rows,
		},
		null,
		"\t",
	)}\n`,
);
