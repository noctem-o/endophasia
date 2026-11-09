// A controller that is killed (SIGKILL, no cleanup) after a model-connected agent's sandbox ended and before its relay was closed: the
// recording's last writes may be lost with it. Used by tests/protected-model-run.test.ts to show what a resume then records.
//   node tests/fixtures/protected-kill-before-relay-close.ts <spec.json> <run dir>
import { readFileSync } from "node:fs";
import { runProtectedExperimentV0 } from "../../cli/experiment-protected.ts";
import { readEndoProtectedSpecV0 } from "../../protocol/protected-experiment.ts";

const [specPath, dir] = process.argv.slice(2) as [string, string];
const read = readEndoProtectedSpecV0(JSON.parse(readFileSync(specPath, "utf8")));
if (!read.ok) throw new Error(read.message);
await runProtectedExperimentV0({
	spec: read.value,
	dir,
	onAgentEnded: () => process.kill(process.pid, "SIGKILL"),
});
