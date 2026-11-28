import fs, { readSync, writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { attachEndoEventStoreWriterV0, migrateEndoEventStoreV0 } from "../../storage/store-format-write.ts";
import { acquireEndoEventStoreWriterLockV0 } from "../../storage/writer-lock.ts";
import { concurrentEvent } from "../helpers/concurrent-event-fixture.ts";

const [root, mode, attachment] = process.argv.slice(2) as [string, string, string];
const say = (value: string) => writeSync(1, `${value}\n`);
const pause = (at: string) => {
	say(at);
	if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("fixture controller closed the barrier");
};
try {
	if (mode === "legacy") {
		const release = acquireEndoEventStoreWriterLockV0(root, attachment);
		try {
			pause("held:legacy");
		} finally {
			release();
		}
	} else if (mode === "migrate") {
		migrateEndoEventStoreV0(root, true, { onMigrationLock: () => pause("held:migrate") });
		say("migrated");
	} else {
		let tick = 0;
		const writer = attachEndoEventStoreWriterV0(root, attachment, {
			announce: say,
			testHooks: {
				...(mode === "init-pause" ? { onInitialisationLock: () => pause("held:init") } : {}),
				...(mode === "wait"
					? { onInitialisationWait: () => (tick++ === 0 ? pause("waiting:init") : undefined) }
					: {}),
				...(mode === "hung" ? { nowMs: () => 5_000 * tick++ } : {}),
			},
		});
		try {
			writer.store.ingest(concurrentEvent(attachment));
			pause(`held:${writer.mode}`);
			if (mode === "crash") {
				const original = fs.writeSync;
				fs.writeSync = (fd: number, buffer: string | NodeJS.ArrayBufferView) => {
					if (!Buffer.isBuffer(buffer)) throw new TypeError("expected a framed append buffer");
					original(fd, buffer.subarray(0, 9));
					process.kill(process.pid, "SIGKILL");
					throw new Error("expected SIGKILL");
				};
				syncBuiltinESMExports();
				writer.store.ingest(concurrentEvent(attachment, 2));
			}
		} finally {
			writer.close();
		}
	}
} catch (error) {
	say(`refused:${(error as Error).message}`);
	process.exitCode = 1;
}
