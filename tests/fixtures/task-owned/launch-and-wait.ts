// Fixture-only launcher process: starts a task-owned fake server, reports its pid, then waits to be killed.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { launchTaskOwnedServerV0 } from "../../../research/governed-initial-continuation/aa/task-owned-server.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../../../storage/digest-key.ts";

const [studyFile, executablePath, modelPath, port, workingDirectory] = process.argv.slice(2);
if (!studyFile || !executablePath || !modelPath || !port || !workingDirectory) throw new Error("arguments required");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const server = await launchTaskOwnedServerV0(
	loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPath()),
	studyFile,
	{
		executablePath,
		executableSha256: sha(executablePath),
		modelPath,
		modelSha256: sha(modelPath),
		modelAlias: "task-owned-fake",
		gpuLayers: "12",
		port: Number(port),
		readinessTimeoutMs: 20000,
		workingDirectory,
	},
	async (_plan, phrase) => phrase,
);
process.stdout.write(`ready ${server.provenance.process.pid}\n`);
setInterval(() => {}, 1000);

function endoFixtureDigestKeyPath() {
	return endoFixtureDigestKeyPathV0();
}
