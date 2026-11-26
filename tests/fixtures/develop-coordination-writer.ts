// A child process for the coordination store's concurrency test: it confirms N read-only assignments through its own store object, as a
// second `endo assign create` would, re-reading the file revision after each stale refusal. It reports "ready" once loaded, then waits
// for the go-file before its first write, so that every writer starts together.
import { existsSync } from "node:fs";
import { DevelopCoordinationStoreV0 } from "../../storage/develop-coordination.ts";

const [root, projectId, taskId, path, tag, count, go] = process.argv.slice(2) as [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
];
const store = new DevelopCoordinationStoreV0(root, { lockWaitMs: 30_000 });
process.stdout.write("ready\n");
const pause = new Int32Array(new SharedArrayBuffer(4));
const give = Date.now() + 30_000;
while (!existsSync(go)) {
	if (Date.now() > give) {
		process.stderr.write("no start signal\n");
		process.exit(1);
	}
	Atomics.wait(pause, 0, 0, 2);
}
let stale = 0;
for (let i = 0; i < Number(count); i += 1) {
	for (;;) {
		const read = store.read();
		if (!read.ok) {
			process.stderr.write(`unreadable: ${read.reason}\n`);
			process.exit(1);
		}
		const made = store.createAssignment({
			expectedFileRevision: read.file.revision,
			projectId,
			taskId,
			participant: { participantId: `w${tag}-${i}`, role: "reviewer", intendedHarnessFamily: null },
			workspace: {
				worktreePath: path,
				registration: "project-path",
				accessIntent: "read-only-intended",
				pathHints: [],
				allowSharedWorktree: false,
			},
			targetCandidate: null,
		});
		if (made.ok) break;
		if (made.code !== "stale-revision") {
			process.stderr.write(`refused: ${made.code} ${made.detail ?? ""}\n`);
			process.exit(1);
		}
		stale += 1;
	}
}
process.stdout.write(`stale ${stale}\n`);
