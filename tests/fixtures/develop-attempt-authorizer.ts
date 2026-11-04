// A child process for the attempt-execution concurrency test: it checks one attempt through its own dispatcher, as a second workbench on
// the same store would, reports "ready", waits for the go-file, then tries to write the attempt's authorisation once and prints its answer.
import { existsSync } from "node:fs";
import { DevelopAttemptDispatchV0 } from "../../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";

const [root, projectId, launchDirectory, attemptId, tag, go] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
	string,
];
const dispatch = new DevelopAttemptDispatchV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root), {
	projectId,
	launchDirectory,
});
const checked = dispatch.check(attemptId);
if (!checked.ok) {
	process.stdout.write(`ready\n${checked.code}\n`);
	process.exit(0);
}
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
const hex = Number(tag).toString(16).padStart(16, "0");
const done = dispatch.authorize(checked.value, {
	session: "endo.session.pi.0b6f6c0e-1111-4c4c-9e9e-123456789abc",
	attachment: "pi.default",
	launchId: hex,
	proposalId: `endo.evidence.workbench-prompt-${hex.repeat(2)}`,
	proposalDigest: hex.repeat(4),
	authorizationEventId: `endo.event.writer-${tag}`,
	message: { digest: { algorithm: "hmac-sha256", keyId: "endo.key.test", value: "a".repeat(64) }, bytes: 100 },
});
process.stdout.write(`${done.ok ? "created" : done.code}\n`);
