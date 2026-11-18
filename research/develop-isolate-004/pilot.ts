import { join, resolve } from "node:path";
import { PI, trustedPiInstallation } from "../../adapters/sandbox/pi-runtime.ts";
import { readEndoProtectedSpecV0 } from "../../protocol/protected-experiment.ts";
import { makePiAgentDirectoryV1, piExampleSpecV1 } from "../protected-eval/model-connected/pi-condition.ts";

export const pilotSource = `export function mergeIntervals(list) {
	const sorted = list.map(pair => [...pair]).sort((a, b) => a[0] - b[0]);
	const result = [];
	for (const pair of sorted) {
		const last = result.at(-1);
		if (last && pair[0] < last[1]) last[1] = Math.max(last[1], pair[1]);
		else result.push(pair);
	}
	return result;
}
`;

export function codingFixtureSpec(directory: string) {
	const base = piExampleSpecV1({
		agentDirectory: directory,
		upstream: "http://127.0.0.1:8090",
		model: "Ornith-1.5-9B-Q8_0",
		maxExchanges: 5,
		maxCompletionTokens: 512,
	});
	const read = readEndoProtectedSpecV0(base);
	if (!read.ok || read.value.schemaVersion !== "endo.protected-experiment-spec.v1")
		throw new Error("invalid protected experiment template");
	const spec = read.value;
	const task = spec.tasks[0]!;
	const condition = spec.conditions[0]!;
	return {
		...spec,
		description: "Read/edit pilot on a disposable fixture; no interactive grant.",
		runtime: { executables: ["/usr/bin/node"], aliases: [] },
		limits: { ...spec.limits, agentTimeoutMs: 120_000 },
		modelAccess: { ...spec.modelAccess, maxRequestBytes: 96 * 1024, maxTransferredBytes: 2 * 1024 * 1024 },
		tasks: [{ ...task, workspace: { ...task.workspace, "src/interval.mjs": pilotSource } }],
		conditions: [
			{
				...condition,
				agent: {
					directory,
					argv: ["/usr/bin/node", "/agent/launch.mjs", "--read-edit-pilot"],
				},
			},
		],
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!trustedPiInstallation()) throw new Error("stock Pi 1.5.2 is required");
	if (process.argv.length !== 3) throw new Error("pass a new agent directory under your private experiment root");
	const directory = resolve(process.argv[2]!);
	makePiAgentDirectoryV1(
		join(PI, "dist"),
		directory,
		"Read src/interval.mjs. Touching intervals must merge. Use edit to fix the comparison in that file, then stop.",
	);
	process.stdout.write(JSON.stringify(codingFixtureSpec(directory)));
}
