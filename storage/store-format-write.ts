import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isWellFormedKindV0 } from "../protocol/identity.ts";
import {
	ENDO_ATTACHMENT_STORE_FORMAT_V0,
	type EndoLegacySealV0,
	type EndoStoreFormatSentinelV0,
} from "../protocol/store-format.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { acquireEndoAttachmentLockV0, type EndoAttachmentLockHandleV0 } from "./attachment-lock.ts";
import {
	createEndoDurableEventStoreV0,
	type EndoDurableEventStoreV0,
	openEndoAttachmentEventStreamV0,
} from "./event-store.ts";
import { writeExactSyncV0 } from "./log.ts";
import {
	assertEndoLegacyStoreWritableV0,
	detectEndoStoreFormatV0,
	ENDO_FORMAT_TEMP_V0,
	ENDO_STORE_INIT_LABEL_V0,
	type EndoStoreBarrierV0,
	type EndoStoreFormatV0,
	endoStoreFormatPathsV0,
	hasEndoStoreSentinelV0,
	hashEndoLegacyLogV0,
	inspectEndoStoreBarrierV0,
	refuseEndoStoreBarrierV0,
} from "./store-format.ts";
import {
	acquireEndoEventStoreWriterLockV0,
	acquireEndoWriterLockHandleV0,
	EndoStoreLockedErrorV0,
	isEndoLockPidAliveV0,
} from "./writer-lock.ts";

const INIT_WAIT_MS = 5_000;
const initWait = new Int32Array(new SharedArrayBuffer(4));
const ATTACHMENT_LABEL = "store format per-attachment-v1: requires Endophasia E4 or later; never remove this sentinel";
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;

function syncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeSynced(path: string, content: string): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeExactSyncV0(fd, Buffer.from(content), path);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function createWitness(root: string, state: EndoStoreFormatV0): void {
	if (!hasEndoStoreSentinelV0(state) || state.witness !== "missing") return;
	const paths = endoStoreFormatPathsV0(root);
	mkdirSync(paths.streams, { recursive: true });
	const temporary = `${paths.witness}.tmp-${randomUUID()}`;
	try {
		writeSynced(temporary, state.raw);
		try {
			linkSync(temporary, paths.witness);
		} catch (error) {
			if (errno(error) !== "EEXIST") throw error;
		}
	} finally {
		rmSync(temporary, { force: true });
	}
	syncDirectory(paths.streams);
	syncDirectory(paths.events);
}

function install(
	root: string,
	lock: ReturnType<typeof acquireEndoWriterLockHandleV0>,
	legacy: EndoLegacySealV0 | null,
): void {
	const paths = endoStoreFormatPathsV0(root);
	const base = {
		schemaVersion: "endo.store-format.v0",
		format: ENDO_ATTACHMENT_STORE_FORMAT_V0,
		attachment: ATTACHMENT_LABEL,
		createdAt: new Date().toISOString(),
	} as const;
	const sentinel: EndoStoreFormatSentinelV0 =
		legacy === null ? { ...base, origin: "created", legacy } : { ...base, origin: "migrated", legacy };
	const temporary = `${paths.lock}.format-tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
	try {
		writeSynced(temporary, `${canonicalEndoJsonV0(sentinel)}\n`);
		lock.assertHeld();
		renameSync(temporary, paths.lock);
		syncDirectory(paths.events);
	} finally {
		rmSync(temporary, { force: true });
	}
	const state = inspectEndoStoreBarrierV0(root);
	refuseEndoStoreBarrierV0(root, state);
	createWitness(root, state);
}

function removeDeadTemps(events: string): void {
	for (const name of readdirSync(events)) {
		const match = ENDO_FORMAT_TEMP_V0.exec(name);
		if (match !== null && !isEndoLockPidAliveV0(Number(match[2]))) rmSync(join(events, name), { force: true });
	}
}

function sealLegacy(root: string): EndoLegacySealV0 {
	const { legacy } = endoStoreFormatPathsV0(root);
	if (lstatSync(legacy, { throwIfNoEntry: false }) === undefined) return { logPresent: false };
	const before = hashEndoLegacyLogV0(legacy);
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		const recovery = store.recovery();
		if (recovery.truncated || recovery.sealed)
			throw new TypeError("migration requires a clean legacy log; no recovery was performed");
		const digest = createHash("sha256");
		for (let afterSequence = 0; afterSequence < store.length; ) {
			const page = store.page({ afterSequence });
			for (const event of page.events) digest.update(`${sha256HexV0(canonicalEndoJsonV0(event))}\n`);
			afterSequence = page.nextAfterSequence;
		}
		const after = hashEndoLegacyLogV0(legacy);
		if (before.bytes !== after.bytes || before.sha256 !== after.sha256)
			throw new TypeError("the legacy log changed while computing its seal; stop every writer");
		return {
			bytes: after.bytes,
			frames: store.length,
			sha256: after.sha256,
			prefixDigest: digest.digest("hex"),
		};
	} finally {
		store.close();
	}
}

export function migrateEndoEventStoreV0(
	root: string,
	commit = false,
	testHooks?: { onMigrationLock?: () => void },
): { state: EndoStoreFormatV0; proposedSeal?: EndoLegacySealV0 } {
	const before = detectEndoStoreFormatV0(root);
	refuseEndoStoreBarrierV0(root, before);
	if (hasEndoStoreSentinelV0(before)) {
		if (commit) createWitness(root, before);
		return { state: before };
	}
	if (before.state !== "legacy-only" && before.state !== "legacy-uninitialised")
		throw new TypeError(`migration needs a legacy store; found ${before.state}`);
	if (before.residue.length > 0)
		throw new TypeError("migration refused: stale-lock recovery barrier requires operator inspection");
	if (!commit) return { state: before, proposedSeal: sealLegacy(root) };
	const lock = acquireEndoWriterLockHandleV0(root, `endo-store-migrate:${randomUUID()}`);
	try {
		testHooks?.onMigrationLock?.();
		const current = inspectEndoStoreBarrierV0(root);
		refuseEndoStoreBarrierV0(root, current);
		if (current.state !== "legacy-only" && current.state !== "legacy-uninitialised")
			throw new TypeError(`store format changed during migration: ${current.state}`);
		if (current.residue.length > 0)
			throw new TypeError("migration refused: stale-lock recovery barrier requires operator inspection");
		const seal = sealLegacy(root);
		removeDeadTemps(endoStoreFormatPathsV0(root).events);
		install(root, lock, seal);
		return { state: detectEndoStoreFormatV0(root) };
	} finally {
		lock.release();
	}
}

export function endoStoreCreatedLineV0(root: string): string {
	return `endo: created store ${root} (format: ${ENDO_ATTACHMENT_STORE_FORMAT_V0})`;
}

function initialise(root: string, state: EndoStoreBarrierV0, onLock?: () => void): boolean {
	const paths = endoStoreFormatPathsV0(root);
	const label = `${ENDO_STORE_INIT_LABEL_V0}${randomUUID()}`;
	const fresh = state.state === "absent";
	const lock = acquireEndoWriterLockHandleV0(
		root,
		label,
		{},
		fresh
			? (path, content) => {
					mkdirSync(root, { recursive: true });
					const staged = mkdtempSync(join(dirname(root), ".endo-store-init-"));
					try {
						writeSynced(join(staged, basename(path)), content);
						syncDirectory(staged);
						if (inspectEndoStoreBarrierV0(root).state !== "absent")
							throw new EndoStoreLockedErrorV0(path, "concurrent store initialiser");
						try {
							renameSync(staged, paths.events);
						} catch (error) {
							if (errno(error) === "EEXIST" || errno(error) === "ENOTEMPTY")
								throw new EndoStoreLockedErrorV0(path, "concurrent store initialiser");
							throw error;
						}
						syncDirectory(root);
						syncDirectory(dirname(root));
					} finally {
						rmSync(staged, { recursive: true, force: true });
					}
				}
			: undefined,
	);
	try {
		onLock?.();
		lock.assertHeld();
		const current = inspectEndoStoreBarrierV0(root);
		if (current.state !== "initialising" || current.pid !== process.pid) return false;
		if (current.residue.length > 0)
			throw new TypeError("initialisation refused: stale-lock recovery barrier requires operator inspection");
		removeDeadTemps(paths.events);
		install(root, lock, null);
		return true;
	} finally {
		lock.release();
	}
}

export function initEndoEventStoreV0(root: string): void {
	root = resolve(root);
	const current = inspectEndoStoreBarrierV0(root);
	refuseEndoStoreBarrierV0(root, current);
	if (current.state !== "absent" && (current.state !== "initialising" || isEndoLockPidAliveV0(current.pid)))
		throw new TypeError(`initialisation requires an absent store; found ${current.state}`);
	if (!initialise(root, current)) throw new TypeError("the store is no longer absent; nothing was initialised");
}

export function acquireEndoLegacyStoreWriterV0(root: string, attachment: string): () => void {
	const state = inspectEndoStoreBarrierV0(root);
	assertEndoLegacyStoreWritableV0(root, state);
	let release: () => void;
	try {
		release = acquireEndoEventStoreWriterLockV0(root, attachment);
	} catch (error) {
		if (!(error instanceof EndoStoreLockedErrorV0)) throw error;
		assertEndoLegacyStoreWritableV0(root);
		throw new EndoStoreLockedErrorV0(
			error.path,
			error.holder,
			`Concurrent sessions need per-attachment-v1. Nothing was changed. Inspect and migrate with endo store migrate --root ${JSON.stringify(root)} --to per-attachment-v1.`,
		);
	}
	try {
		assertEndoLegacyStoreWritableV0(root);
		return release;
	} catch (error) {
		release();
		throw error;
	}
}

export type EndoEventStoreWriterV0 = { readonly store: EndoDurableEventStoreV0; close(): void } & (
	| { readonly mode: "legacy" }
	| { readonly mode: "attachment"; readonly lock: EndoAttachmentLockHandleV0 }
);

export function attachEndoEventStoreWriterV0(
	root: string,
	attachment: string,
	options: {
		announce?: (line: string) => void;
		testHooks?: { onInitialisationLock?: () => void; onInitialisationWait?: () => void; nowMs?: () => number };
	} = {},
): EndoEventStoreWriterV0 {
	if (!isWellFormedKindV0(attachment)) throw new TypeError("attachment must be a well-formed dotted kind");
	root = resolve(root);
	const now = options.testHooks?.nowMs ?? (() => performance.now());
	const deadline = now() + INIT_WAIT_MS;
	for (;;) {
		const state = inspectEndoStoreBarrierV0(root);
		refuseEndoStoreBarrierV0(root, state);
		if (hasEndoStoreSentinelV0(state)) {
			createWitness(root, state);
			const lock = acquireEndoAttachmentLockV0(root, attachment);
			try {
				const store = openEndoAttachmentEventStreamV0(root, lock);
				return {
					mode: "attachment",
					lock,
					store,
					close: () => {
						store.close();
						lock.release();
					},
				};
			} catch (error) {
				lock.release();
				throw error;
			}
		}
		if (state.state === "legacy-only" || state.state === "legacy-uninitialised") {
			const release = acquireEndoLegacyStoreWriterV0(root, attachment);
			try {
				const store = createEndoDurableEventStoreV0(root);
				return {
					mode: "legacy",
					store,
					close: () => {
						store.close();
						release();
					},
				};
			} catch (error) {
				release();
				throw error;
			}
		}
		if (state.state === "absent" || (state.state === "initialising" && !isEndoLockPidAliveV0(state.pid))) {
			try {
				if (initialise(root, state, options.testHooks?.onInitialisationLock)) {
					const announce = options.announce ?? ((line) => process.stderr.write(`${line}\n`));
					announce(endoStoreCreatedLineV0(root));
				}
			} catch (error) {
				if (!(error instanceof EndoStoreLockedErrorV0)) throw error;
				if (inspectEndoStoreBarrierV0(root).state === "initialising" && now() >= deadline) throw error;
				Atomics.wait(initWait, 0, 0, 10);
			}
			continue;
		}
		if (state.state !== "initialising") throw new TypeError(`unexpected store format state: ${state.state}`);
		if (now() >= deadline)
			throw new TypeError(`store initialisation by pid ${state.pid} has not completed; nothing was changed`);
		options.testHooks?.onInitialisationWait?.();
		Atomics.wait(initWait, 0, 0, 10);
	}
}
