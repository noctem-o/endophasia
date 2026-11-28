import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { acquireEndoAttachmentLockV0 } from "../storage/attachment-lock.ts";
import { createEndoDurableEventStoreV0, openEndoAttachmentEventStreamV0 } from "../storage/event-store.ts";
import { endoEventStreamKeyV0 } from "../storage/event-stream-path.ts";
import { initEndoEventStoreV0 } from "../storage/store-format-write.ts";

const roots: string[] = [];
function scratch() {
	const path = mkdtempSync(join(tmpdir(), "endo-stream-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("keeps the legacy stream distinct from an attachment named legacy", () => {
	expect(endoEventStreamKeyV0({ kind: "legacy" })).toBe("legacy");
	expect(endoEventStreamKeyV0({ kind: "attachment", attachmentId: "legacy" })).toBe("attachment:legacy");
	expect(() => acquireEndoAttachmentLockV0(scratch(), "../legacy")).toThrow(/well-formed/);
});

it("refuses forged, wrong-root, duplicate writer and expired attachment handles", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const wrongRoot = scratch();
	initEndoEventStoreV0(wrongRoot);
	const lock = acquireEndoAttachmentLockV0(root, "legacy");
	try {
		expect(() => openEndoAttachmentEventStreamV0(root, { ...lock })).toThrow(/attachment lock/);
		expect(() => openEndoAttachmentEventStreamV0(wrongRoot, lock)).toThrow(/attachment lock/);
		expect(() =>
			createEndoDurableEventStoreV0(root, { logPath: join(root, "events/attachments/legacy/events.log") }),
		).toThrow(/attachment writer lock/);
		const store = openEndoAttachmentEventStreamV0(root, lock);
		expect(() => openEndoAttachmentEventStreamV0(root, lock)).toThrow(/already has an open event writer/);
		store.close();
		const reopened = openEndoAttachmentEventStreamV0(root, lock);
		store.close();
		expect(() => openEndoAttachmentEventStreamV0(root, lock)).toThrow(/already has an open event writer/);
		lock.release();
		expect(() => reopened.ingest({})).toThrow(/attachment lock/);
		reopened.close();
	} finally {
		lock.release();
	}
});
