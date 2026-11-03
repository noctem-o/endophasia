// A child process for the receipts' concurrency test: it writes one receipt (given as JSON in a file) through its own store object, as a
// second `endo attempt check` process would. It reports "ready" once loaded, waits for the go-file, then writes once and prints its answer.
import { existsSync, readFileSync } from "node:fs";
import { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";

const [root, receiptFile, go] = process.argv.slice(2) as [string, string, string];
const store = new DevelopReceiptsStoreV0(root);
const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
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
process.stdout.write(`${store.write(receipt)}\n`);
