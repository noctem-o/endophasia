import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI, trustedPiInstallation } from "../../adapters/sandbox/pi-runtime.ts";
import { readEndoProtectedSpecV0 } from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { codingFixtureSpec } from "../develop-isolate-004/pilot.ts";
import { makePiAgentDirectoryV1 } from "../protected-eval/model-connected/pi-condition.ts";

const [out, mode] = process.argv.slice(2);
if (!out || !mode || !["pi", "unchanged", "reference", "timeout"].includes(mode))
	throw new Error("usage: prepare.ts NEW-DIR pi|unchanged|reference|timeout");
const root = resolve(out);
mkdirSync(root, { mode: 0o700 });
mkdirSync(join(root, "home"), { mode: 0o700 });
const agent = join(root, "agent");
const objective =
	"Read count.mjs. Fix countPositive(values) to count only strictly positive numbers, excluding zero. Use edit, then stop.";
const start = "export function countPositive(values) { return values.filter(x => x >= 0).length; }\n";
const base = codingFixtureSpec(agent);
if (mode === "pi") {
	if (!trustedPiInstallation()) throw new Error("trusted Pi 1.5.2 required");
	makePiAgentDirectoryV1(join(PI, "dist"), agent, objective);
} else {
	mkdirSync(agent);
	const reference = readFileSync(new URL("./checks/reference/count.mjs", import.meta.url), "utf8");
	writeFileSync(
		join(agent, "fixture.mjs"),
		mode === "timeout"
			? "setInterval(() => {}, 1000);\n"
			: mode === "unchanged"
				? 'console.log("PASS");\n'
				: `import {writeFileSync} from "node:fs"; writeFileSync("count.mjs",${JSON.stringify(reference)});\n`,
	);
}
const evaluator = fileURLToPath(new URL("./checks/evaluator.json", import.meta.url));
const { modelAccess, ...offline } = base;
const { memoryMaxBytes: _memory, cpuQuotaPercent: _cpu, ...limits } = base.limits;
if (mode === "timeout") limits.agentTimeoutMs = 1500;
const checked = readEndoProtectedSpecV0({
	...offline,
	...(mode === "pi"
		? { modelAccess }
		: { schemaVersion: "endo.protected-experiment-spec.v0", runtime: { executables: ["/usr/bin/node"] }, limits }),
	id: `endo.experiment.acceptance-${randomUUID()}`,
	description: objective,
	tasks: [
		{
			id: "strict-positive",
			workspace: { "count.mjs": start },
			submission: ["count.mjs"],
			evaluator: { file: evaluator, sha256: sha256HexV0(readFileSync(evaluator)) },
		},
	],
	conditions:
		mode === "pi"
			? base.conditions
			: [
					{
						id: mode,
						description: "Deterministic offline process control",
						agent: { directory: agent, argv: ["/usr/bin/node", "/agent/fixture.mjs"] },
					},
				],
});
if (!checked.ok) throw new Error(checked.message);
const serialized = canonicalEndoJsonV0(checked.value);
writeFileSync(join(root, "spec.json"), serialized, { flag: "wx" });
console.log(sha256HexV0(serialized));
