// LIVE-PROCESS-CONTAINMENT-001 test fixture: a controller that owns one contained process group, whose command starts a detached
// descendant (its own process group, as Pi's bash tool does) and writes that descendant's pid to argv[2]. Once the pid is there, the
// controller prints {unit, keeper, descendant} as one JSON line and waits to be killed: the test then kills it, and with "both" also
// its keeper, to show what happens when the owner (and the keeper) die unexpectedly.
import { existsSync, readFileSync } from "node:fs";
import { ProcessGroupV0 } from "../../adapters/rpc-jsonl/process-group.ts";
import { detectContainmentV0, liveScopeV0 } from "../../adapters/sandbox/containment.ts";

const pidFile = process.argv[2] as string;
const detected = await detectContainmentV0();
if (!detected.ok) {
	process.stderr.write(`${detected.detail}\n`);
	process.exit(3);
}
const command = `const c = require("node:child_process").spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); c.unref(); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
const group = new ProcessGroupV0(process.execPath, ["-e", command], {
	cwd: "/",
	env: { PATH: process.env.PATH ?? "/usr/bin" },
	stderr: "ignore",
	scope: liveScopeV0(detected.containment),
});
while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") await new Promise((r) => setTimeout(r, 20));
process.stdout.write(
	`${JSON.stringify({ unit: group.scopeUnit, keeper: group.groupId, descendant: Number(readFileSync(pidFile, "utf8")) })}\n`,
);
setInterval(() => {}, 1000);
