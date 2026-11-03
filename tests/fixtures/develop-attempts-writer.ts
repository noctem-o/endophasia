// A child process for the attempts' concurrency test: it records an outcome (or a handoff) on one attempt through its own service object, as
// a second `endo attempt` process would. It reports "ready" once loaded, waits for the go-file, then writes once and prints its answer.
import { existsSync } from "node:fs";
import { DevelopAttemptsServiceV0 } from "../../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";

const [root, attemptId, kind, tag, go] = process.argv.slice(2) as [string, string, string, string, string];
const service = new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root));
process.stdout.write("ready\n");
const pause = new Int32Array(new SharedArrayBuffer(4));
const give = Date.now() + 30_000;
while (!existsSync(go)) {
	if (Date.now() > give) {
		process.stderr.write("no start signal\n");
		process.exit(1);
	}
	Atomics.wait(pause, 0, 0, 1);
}
const done =
	kind === "handoff"
		? service.handoff(attemptId, { target: `writer ${tag}` })
		: service.report(attemptId, `reported by writer ${tag}`);
process.stdout.write(`${done.ok ? "created" : done.code}\n`);
