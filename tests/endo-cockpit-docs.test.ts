// The integration recipe in docs/cockpit.md calls the public API with the signatures it really has. Every documented
// call carries the explicit digest key, and the same calls, typed here, run against a store.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	checkEndoCockpitSourceFreshnessV0,
	type EndoDigestKeyV0,
	readEndoCockpitRecordV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
} from "../cockpit/index.ts";
import { ATTACHMENT, ingestAll, lifecycleEvents, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

describe("docs/cockpit.md integration recipe", () => {
	it("shows every cockpit read and freshness call with its digest key", () => {
		const docs = readFileSync(new URL("../docs/cockpit.md", import.meta.url), "utf8");
		const calls =
			docs.match(
				/\b(?:readEndoCockpit(?:Timeline|Runtime|Snapshot)V0|checkEndoCockpitSourceFreshnessV0)\([^)]*\)\s*;/g,
			) ?? [];
		expect(calls.length).toBeGreaterThanOrEqual(4);
		for (const call of calls) expect(call, call).toContain("digestKey");
	});

	it("runs as documented, under one private key", () => {
		const root = tempRoot();
		ingestAll(root, lifecycleEvents("killed-and-resumed"));
		seedRegistry(root);
		const digestKey: EndoDigestKeyV0 = OTHER_KEY;
		const attachment = ATTACHMENT;
		const timeline = readEndoCockpitTimelineV0(root, { afterSequence: 0, limit: 10, digestKey });
		const runtime = readEndoCockpitRuntimeV0(root, attachment, digestKey);
		const snapshot = readEndoCockpitSnapshotV0(root, { limit: 10, attachments: [attachment], digestKey });
		const verdict = checkEndoCockpitSourceFreshnessV0(root, timeline.source, digestKey);
		expect(verdict).toBe("unchanged");
		expect(readEndoCockpitRecordV0(snapshot).ok).toBe(true);
		expect(runtime.identity.source.watermark!.keyId).toBe(digestKey.keyId);
	});

	it("keeps the projections and contracts free of storage, adapters and the filesystem", () => {
		const root = new URL("..", import.meta.url).pathname;
		const files = [
			...readdirSync(`${root}cockpit/projections`).map((name) => `cockpit/projections/${name}`),
			"protocol/cockpit.ts",
			"protocol/cockpit-comparison.ts",
			"protocol/cockpit-fields.ts",
			"protocol/cockpit-ledger.ts",
			"protocol/keyed-digest-shape.ts",
		];
		for (const file of files) {
			const source = readFileSync(`${root}${file}`, "utf8");
			expect(source, file).not.toMatch(
				/from "(?:\.\.\/)+(?:storage|adapters)\/|from "node:(?:fs|os|child_process|crypto)/,
			);
		}
	});
});
