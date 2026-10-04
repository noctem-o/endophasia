// Committed cassette fixtures: a recorded cassette session store exported to plain files, and materialized back into
// a store for replay.
//
//   <dir>/session.events.jsonl   the session's event store (what Pi did, through the attachment), one event per line
//   <dir>/capture.events.jsonl   the capture log (exchanges, the workspace snapshot, the driver's steps)
//   <dir>/evidence.jsonl         the capability evidence the session ran under (harness registry `evidence` records)
//   <dir>/blobs/<key id>/<hex>   the blob store: request bodies, response wire bytes, the snapshot archive, prompts
//
// Nothing is normalized: the capture log and the blobs hold the scratch paths Pi saw, and a replay needs them exactly.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endoCaptureRootV0 } from "../adapters/openai-proxy/capture-log.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";

export const PI_CASSETTE_FIXTURE_FILES_V0 = ["session.events.jsonl", "capture.events.jsonl", "evidence.jsonl"] as const;

function readAll(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		const events: EndoEventV0[] = [];
		let after = 0;
		for (;;) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		return events;
	} finally {
		store.close();
	}
}

/** One canonical-JSON record per line. */
export function jsonLinesV0(records: readonly unknown[]): string {
	return (
		records.map((record) => JSON.stringify(JSON.parse(canonicalEndoJsonV0(record)))).join("\n") +
		(records.length > 0 ? "\n" : "")
	);
}

function parseLines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line));
}

/** Export a recorded cassette session store to `dir`. Returns each file's sha256. */
export function exportPiCassetteFixtureV0(
	store: string,
	dir: string,
	attachment = "pi.default",
): Record<string, string> {
	mkdirSync(dir, { recursive: true });
	const files: Record<string, string> = {};
	const write = (name: string, content: string) => {
		writeFileSync(join(dir, name), content);
		files[name] = sha256HexV0(content);
	};
	write("session.events.jsonl", jsonLinesV0(readAll(store)));
	write("capture.events.jsonl", jsonLinesV0(readAll(endoCaptureRootV0(store))));
	write(
		"evidence.jsonl",
		jsonLinesV0(openEndoHarnessRegistryV0(store, attachment, { readOnly: true }).list("evidence")),
	);
	cpSync(join(endoCaptureRootV0(store), "blobs"), join(dir, "blobs"), { recursive: true });
	return files;
}

/** Build a store at `root` (new) from a fixture directory. */
export function materializePiCassetteFixtureV0(dir: string, root: string, attachment = "pi.default"): string {
	if (existsSync(root) && readdirSync(root).length > 0) throw new TypeError(`${root} is not empty`);
	mkdirSync(root, { recursive: true });
	const session = createEndoDurableEventStoreV0(root);
	for (const event of parseLines(join(dir, "session.events.jsonl"))) session.ingest(event);
	session.close();
	const capture = createEndoDurableEventStoreV0(endoCaptureRootV0(root));
	for (const event of parseLines(join(dir, "capture.events.jsonl"))) capture.ingest(event);
	capture.close();
	const registry = openEndoHarnessRegistryV0(root, attachment);
	for (const record of parseLines(join(dir, "evidence.jsonl"))) registry.append("evidence", record as never);
	cpSync(join(dir, "blobs"), join(endoCaptureRootV0(root), "blobs"), { recursive: true });
	return root;
}
