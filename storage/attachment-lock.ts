import { dirname, join, resolve } from "node:path";
import { endoEventStreamPathV0 } from "./event-stream-path.ts";
import { acquireEndoWriterLockHandleV0, type EndoEventStoreWriterLockTestHooksV0 } from "./writer-lock.ts";

export interface EndoAttachmentLockHandleV0 {
	readonly attachmentId: string;
	release(): void;
}

const held = new WeakMap<EndoAttachmentLockHandleV0, { root: string; assertHeld(): void }>();

export function acquireEndoAttachmentLockV0(
	root: string,
	attachmentId: string,
	testHooks?: EndoEventStoreWriterLockTestHooksV0,
): EndoAttachmentLockHandleV0 {
	const log = endoEventStreamPathV0(root, { kind: "attachment", attachmentId });
	const lock = acquireEndoWriterLockHandleV0(root, attachmentId, {
		lockPath: join(dirname(log), "attachment.lock"),
		testHooks,
	});
	const handle = Object.freeze({
		attachmentId,
		release() {
			held.delete(handle);
			lock.release();
		},
	});
	held.set(handle, { root: resolve(root), assertHeld: lock.assertHeld });
	return handle;
}

export function assertEndoAttachmentLockV0(root: string, attachment: string, handle: EndoAttachmentLockHandleV0): void {
	const lock = held.get(handle);
	if (lock === undefined || lock.root !== resolve(root) || handle.attachmentId !== attachment)
		throw new TypeError("a live attachment lock for this root and attachment is required");
	lock.assertHeld();
}
