// Store-local durable automation storage (`<root>/develop/automation/`, S1-B,
// docs/designs/coordinator-automation.md Appendix B, docs/designs/coordinator-automation-s1-implementation.md).
//
// Files under `<root>/develop/automation/`:
//   - `automation.lock.<n>`                    short-lived numbered writer mutex (storage/numbered-lock.ts)
//   - `schedules.json`                         `endo.develop-schedules.v0` (atomic temp + fsync + rename)
//   - `lease.json`                             `endo.develop-automation-lease.v0` (expiring duty lease + monotonic epoch)
//   - `resources.json`                         `endo.develop-resource-observation.v0` (fenced by leaseEpoch)
//   - `declarations.json`                      `endo.develop-resource-declarations.v0` (operator-declared windows)
//   - `fires/<idempotencyKey>.claimed.json`    `endo.develop-schedule-fire-claim.v0` (write-once link(2))
//   - `fires/<idempotencyKey>.outcome.json`    `endo.develop-schedule-fire-outcome.v0` (write-once link(2))
//
// Invariants:
// - NEVER acquires or nests `tasks.lock.<n>`, `coordination.lock.<n>`, or `events/session-attachment.lock`.
// - `withAutomationLockSync` takes a strictly synchronous callback: network probes and async observations
//   are structurally prevented from running while `automation.lock.<n>` is held.
// - All reads use lstat + O_RDONLY|O_NOFOLLOW|O_NONBLOCK + fstat + size cap + duplicate-key rejection + closed schema.
// - Malformed, unsafe, oversized, or unknown-version files fail closed and are never overwritten or repaired.
// - Retention pruning NEVER deletes unresolved `claimed-incomplete` claims and NEVER allows pruned windows to replay.
// - Same-host, same-UID cooperative threat model (consistent with storage/numbered-lock.ts and storage/write-once.ts).

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	opendirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_AUTOMATION_LIMITS_V0,
	ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
	ENDO_PROVIDER_ID_PATTERN_V0,
	ENDO_SCHEDULE_ID_PATTERN_V0,
	ENDO_SHA256_HEX_PATTERN_V0,
	type EndoAllowanceWindowKindV0,
	type EndoDevelopAutomationLeaseV0,
	type EndoDevelopResourceDeclarationsFileV0,
	type EndoDevelopResourceObservationV0,
	type EndoDevelopRetiredScheduleCursorV0,
	type EndoDevelopScheduleFireClaimV0,
	type EndoDevelopScheduleFireOutcomeV0,
	type EndoDevelopSchedulesFileV0,
	type EndoDevelopScheduleV0,
	type EndoOperatorDeclarableStandingV0,
	type EndoOperatorResourceWindowDeclarationV0,
	type EndoProviderSurfaceKindV0,
	type EndoScheduleActionKindV0,
	type EndoScheduleFireProjectedStateV0,
	type EndoScheduleMissedRunPolicyV0,
	type EndoScheduleTriggerV0,
	emptyEndoDevelopResourceDeclarationsFileV0,
	emptyEndoDevelopSchedulesFileV0,
	readEndoDevelopAutomationLeaseV0,
	readEndoDevelopResourceDeclarationsFileV0,
	readEndoDevelopResourceObservationV0,
	readEndoDevelopScheduleFireClaimV0,
	readEndoDevelopScheduleFireOutcomeV0,
	readEndoDevelopSchedulesFileV0,
	validateEndoDevelopAutomationLeaseV0,
	validateEndoDevelopResourceDeclarationsFileV0,
	validateEndoDevelopResourceObservationV0,
	validateEndoDevelopScheduleFireClaimV0,
	validateEndoDevelopScheduleFireOutcomeV0,
	validateEndoDevelopSchedulesFileV0,
	validateEndoScheduleTriggerV0,
} from "../protocol/develop-automation.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	type EndoEffectiveProviderAllowanceV0,
	type EndoObservationFreshnessV0,
	endoEffectiveProviderAllowanceV0,
	endoObservationFreshnessV0,
} from "../runtime/contracts/develop-automation.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import { writeExactSyncV0 } from "./log.ts";
import {
	acquireEndoNumberedLockV0,
	type EndoNumberedLockHooksV0,
	endoNumberedLockPatternsV0,
} from "./numbered-lock.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readDirectoryNamesAtMostV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_AUTOMATION_DIRECTORY_V0 = "automation";
export const ENDO_DEVELOP_AUTOMATION_FIRES_DIRECTORY_V0 = "fires";
export const ENDO_DEVELOP_AUTOMATION_LOCK_V0 = "automation.lock";
export const ENDO_DEVELOP_SCHEDULES_FILE_V0 = "schedules.json";
export const ENDO_DEVELOP_LEASE_FILE_V0 = "lease.json";
export const ENDO_DEVELOP_RESOURCES_FILE_V0 = "resources.json";
export const ENDO_DEVELOP_DECLARATIONS_FILE_V0 = "declarations.json";

export type EndoAutomationReadProblemV0 =
	| "unsafe-path"
	| "too-large"
	| "malformed"
	| "duplicate-key"
	| "unsupported-version"
	| "invalid"
	| "io";

export type EndoAutomationFileReadV0<T> =
	| { readonly ok: true; readonly exists: true; readonly value: T }
	| { readonly ok: true; readonly exists: false; readonly value: null }
	| { readonly ok: false; readonly reason: EndoAutomationReadProblemV0; readonly detail: string };

export type EndoAutomationRefusalCodeV0 =
	| "not-found"
	| "duplicate"
	| "stale-revision"
	| "bad-request"
	| "limit"
	| "unreadable"
	| "unsafe-path"
	| "busy"
	| "storage-failed"
	| "commit-uncertain";

export type EndoAutomationMutationResultV0<T> =
	| { readonly ok: true; readonly value: T; readonly commit: "committed" | "unchanged" }
	| {
			readonly ok: false;
			readonly code: EndoAutomationRefusalCodeV0;
			readonly detail?: string;
	  };

export interface EndoDevelopAutomationStoreOptionsV0 {
	readonly now?: () => number;
	readonly lockWaitMs?: number;
	readonly lockHooks?: EndoNumberedLockHooksV0;
	/** Test hook: runs after temp file is written & fsynced, before atomic rename. */
	readonly beforeReplace?: (fileName: string) => void;
	/** Test hook: runs after atomic rename, before directory fsync (throws -> commit-uncertain). */
	readonly afterReplace?: (fileName: string) => void;
	/** Test hook: runs inside writeOnceSyncV0 before link(2). */
	readonly beforeFireLink?: (fileName: string) => void;
}

export interface EndoProjectedFireEntryV0 {
	readonly idempotencyKey: string;
	readonly state: EndoScheduleFireProjectedStateV0;
	readonly claim: EndoDevelopScheduleFireClaimV0 | null;
	readonly outcome: EndoDevelopScheduleFireOutcomeV0 | null;
}

export interface EndoAutomationFiresReadV0 {
	readonly ok: true;
	readonly entries: readonly EndoProjectedFireEntryV0[];
	readonly problems: readonly { readonly name: string; readonly reason: EndoAutomationReadProblemV0 }[];
	readonly truncated: boolean;
}

export interface EndoAutomationFiresReadFailureV0 {
	readonly ok: false;
	readonly reason: "unsafe-path" | "too-many" | "io";
}

export interface EndoAutomationProjectionV0 {
	readonly schemaVersion: "endo.develop-automation-projection.v0";
	readonly observedAtMs: number;
	readonly schedules:
		| { readonly state: "ready"; readonly file: EndoDevelopSchedulesFileV0 }
		| { readonly state: "absent" }
		| { readonly state: "unreadable"; readonly reason: EndoAutomationReadProblemV0; readonly detail: string };
	readonly lease:
		| { readonly state: "ready"; readonly lease: EndoDevelopAutomationLeaseV0; readonly active: boolean }
		| { readonly state: "absent" }
		| { readonly state: "unreadable"; readonly reason: EndoAutomationReadProblemV0; readonly detail: string };
	readonly resources:
		| {
				readonly state: "ready";
				readonly observation: EndoDevelopResourceObservationV0;
				readonly freshness: EndoObservationFreshnessV0;
				readonly effectiveProviders: readonly EndoEffectiveProviderAllowanceV0[];
		  }
		| { readonly state: "absent" }
		| { readonly state: "unreadable"; readonly reason: EndoAutomationReadProblemV0; readonly detail: string };
	readonly declarations:
		| { readonly state: "ready"; readonly file: EndoDevelopResourceDeclarationsFileV0 }
		| { readonly state: "absent" }
		| { readonly state: "unreadable"; readonly reason: EndoAutomationReadProblemV0; readonly detail: string };
	readonly fires:
		| {
				readonly state: "ready";
				readonly entries: readonly EndoProjectedFireEntryV0[];
				readonly incompleteCount: number;
				readonly problemCount: number;
				readonly truncated: boolean;
		  }
		| { readonly state: "absent" }
		| { readonly state: "unreadable"; readonly reason: "unsafe-path" | "too-many" | "io" };
}

const TEMP_REPLACE_PATTERN = /^\.tmp-[a-z0-9._-]+-[0-9]+-[0-9a-f]{12}$/;
const FIRE_FILE_PATTERN = /^([0-9a-f]{64})\.(claimed|outcome)\.json$/;
const LOCK_TEMPORARY_PATTERN = endoNumberedLockPatternsV0(ENDO_DEVELOP_AUTOMATION_LOCK_V0).temporary;
const L = ENDO_DEVELOP_AUTOMATION_LIMITS_V0;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** Reject duplicate keys at any depth in a valid JSON string (mirrors M1's readCoordinatorModelPoolFileV0). */
function jsonKeysRepeat(text: string): boolean {
	const stack: (Set<string> | null)[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			const keys = stack.at(-1);
			if (keys) {
				let k = j + 1;
				while (k < text.length && /\s/.test(text[k] as string)) k += 1;
				if (text[k] === ":") {
					const key = JSON.parse(text.slice(i, j + 1)) as string;
					if (keys.has(key)) return true;
					keys.add(key);
				}
			}
			i = j;
		} else if (ch === "{") stack.push(new Set());
		else if (ch === "[") stack.push(null);
		else if (ch === "}" || ch === "]") stack.pop();
	}
	return false;
}

function readBoundedValidatedJsonSync<T>(
	dirs: readonly string[],
	filePath: string,
	maxBytes: number,
	readVersioned: (
		raw: unknown,
	) =>
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly kind: string; readonly message: string },
): EndoAutomationFileReadV0<T> {
	const dirState = checkDirectoriesSyncV0(dirs);
	if (dirState === "missing") return { ok: true, exists: false, value: null };
	if (dirState !== "ok")
		return {
			ok: false,
			reason: dirState === "unsafe-path" ? "unsafe-path" : "io",
			detail: `directory check: ${dirState}`,
		};

	let entry: ReturnType<typeof lstatSync>;
	try {
		const info = lstatSync(filePath, { throwIfNoEntry: false });
		if (info === undefined) return { ok: true, exists: false, value: null };
		entry = info;
	} catch (error) {
		const code = errno(error);
		return {
			ok: false,
			reason: code === "ELOOP" || code === "ENOTDIR" ? "unsafe-path" : "io",
			detail: `lstat failed (${code ?? "error"})`,
		};
	}

	if (!entry.isFile()) return { ok: false, reason: "unsafe-path", detail: "path is not a regular file" };
	if (entry.size > maxBytes) return { ok: false, reason: "too-large", detail: `file exceeds ${maxBytes} bytes` };

	let fd: number;
	try {
		fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = errno(error);
		return {
			ok: false,
			reason: code === "ELOOP" || code === "ENOTDIR" ? "unsafe-path" : "io",
			detail: `open failed (${code ?? "error"})`,
		};
	}

	let text: string;
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile())
			return { ok: false, reason: "unsafe-path", detail: "opened descriptor is not a regular file" };
		if (opened.size > maxBytes) return { ok: false, reason: "too-large", detail: `file exceeds ${maxBytes} bytes` };
		const buf = Buffer.alloc(opened.size);
		let at = 0;
		while (at < buf.length) {
			const n = readSync(fd, buf, at, buf.length - at, at);
			if (n === 0) break;
			at += n;
		}
		if (at !== buf.length) return { ok: false, reason: "io", detail: "short read" };
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
		} catch {
			return { ok: false, reason: "malformed", detail: "not valid UTF-8" };
		}
	} finally {
		closeSync(fd);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "malformed", detail: "not valid JSON" };
	}
	if (jsonKeysRepeat(text)) return { ok: false, reason: "duplicate-key", detail: "JSON repeats a key" };

	const validated = readVersioned(parsed);
	if (!validated.ok) {
		const reason: EndoAutomationReadProblemV0 =
			validated.kind === "unsupported-version" ? "unsupported-version" : "invalid";
		return { ok: false, reason, detail: validated.message };
	}
	return { ok: true, exists: true, value: validated.value };
}

function sweepAutomationTempsSync(dir: string): void {
	try {
		for (const name of readdirSync(dir)) {
			if (!TEMP_REPLACE_PATTERN.test(name) && !LOCK_TEMPORARY_PATTERN.test(name)) continue;
			const p = join(dir, name);
			const info = lstatSync(p, { throwIfNoEntry: false });
			if (info?.isFile() === true && Date.now() - info.mtimeMs >= 60_000) rmSync(p, { force: true });
		}
	} catch {
		// best effort
	}
}

export type EndoAtomicReplaceOutcomeV0 = "committed" | "storage-failed" | "commit-uncertain";

/**
 * Atomic file replacement inside an already-verified directory while holding `automation.lock.<n>`.
 * Distinguishes failure before rename (`storage-failed`, old file untouched) from failure after rename
 * (`commit-uncertain`, new file visible but directory fsync unconfirmed).
 */
function replaceJsonAtomicSync(
	dir: string,
	fileName: string,
	payload: unknown,
	maxBytes: number,
	options: EndoDevelopAutomationStoreOptionsV0,
): EndoAtomicReplaceOutcomeV0 {
	sweepAutomationTempsSync(dir);
	const bytes = Buffer.from(`${canonicalEndoJsonV0(payload as never)}\n`, "utf8");
	if (bytes.length > maxBytes) return "storage-failed";
	const targetPath = join(dir, fileName);
	// Never overwrite a non-regular file (e.g., symlink or FIFO placed at targetPath).
	const existing = lstatSync(targetPath, { throwIfNoEntry: false });
	if (existing !== undefined && !existing.isFile()) return "storage-failed";

	const tempPath = join(dir, `.tmp-${fileName}-${process.pid}-${randomBytes(6).toString("hex")}`);
	let fd: number | undefined;
	let renamed = false;
	try {
		fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		writeExactSyncV0(fd, bytes, tempPath);
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		options.beforeReplace?.(fileName);
		renameSync(tempPath, targetPath);
		renamed = true;
		options.afterReplace?.(fileName);
		const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return "committed";
	} catch {
		return renamed ? "commit-uncertain" : "storage-failed";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed
			}
		}
		if (!renamed) {
			try {
				rmSync(tempPath, { force: true });
			} catch {
				// swept later
			}
		}
	}
}

export interface AddEndoScheduleInputV0 {
	readonly scheduleId: string;
	readonly actionKind: EndoScheduleActionKindV0;
	readonly trigger: EndoScheduleTriggerV0;
	readonly missedRunPolicy?: EndoScheduleMissedRunPolicyV0;
	readonly label?: string | null;
	readonly enabled?: boolean;
	readonly expectedRevision?: number;
}

export interface ReviseEndoScheduleInputV0 {
	readonly scheduleId: string;
	readonly expectedRevision?: number;
	readonly actionKind?: EndoScheduleActionKindV0;
	readonly trigger?: EndoScheduleTriggerV0;
	readonly missedRunPolicy?: EndoScheduleMissedRunPolicyV0;
	readonly label?: string | null;
}

export interface DeclareEndoResourceWindowInputV0 {
	readonly providerId: string;
	readonly resetAtMs: number;
	readonly surfaceKind?: EndoProviderSurfaceKindV0;
	readonly quotaPoolId?: string | null;
	readonly windowKind?: EndoAllowanceWindowKindV0;
	readonly standing?: EndoOperatorDeclarableStandingV0;
	readonly note?: string | null;
}

/** Synchronous storage handle exposed ONLY inside `withAutomationLockSync`. */
export interface EndoAutomationLockedSessionV0 {
	readSchedules(): EndoAutomationFileReadV0<EndoDevelopSchedulesFileV0>;
	writeSchedules(file: EndoDevelopSchedulesFileV0): EndoAtomicReplaceOutcomeV0;
	readLease(): EndoAutomationFileReadV0<EndoDevelopAutomationLeaseV0>;
	writeLease(lease: EndoDevelopAutomationLeaseV0): EndoAtomicReplaceOutcomeV0;
	readResources(): EndoAutomationFileReadV0<EndoDevelopResourceObservationV0>;
	writeResources(obs: EndoDevelopResourceObservationV0): EndoAtomicReplaceOutcomeV0;
	readDeclarations(): EndoAutomationFileReadV0<EndoDevelopResourceDeclarationsFileV0>;
	writeDeclarations(file: EndoDevelopResourceDeclarationsFileV0): EndoAtomicReplaceOutcomeV0;
	readFireClaim(idempotencyKey: string): EndoAutomationFileReadV0<EndoDevelopScheduleFireClaimV0>;
	writeFireClaimOnce(claim: EndoDevelopScheduleFireClaimV0): "created" | "exists" | "failed";
	writeFireOutcomeOnce(outcome: EndoDevelopScheduleFireOutcomeV0): "created" | "exists" | "failed";
	pruneRetainedFires(maxRetainedPairs?: number): {
		readonly prunedKeys: readonly string[];
		readonly keptIncompleteCount: number;
	};
}

export class DevelopAutomationStoreV0 {
	readonly #root: string;
	readonly #developDir: string;
	readonly #dir: string;
	readonly #firesDir: string;
	readonly #options: EndoDevelopAutomationStoreOptionsV0;
	readonly #now: () => number;

	constructor(root: string, options: EndoDevelopAutomationStoreOptionsV0 = {}) {
		this.#root = root;
		this.#developDir = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#dir = join(this.#developDir, ENDO_DEVELOP_AUTOMATION_DIRECTORY_V0);
		this.#firesDir = join(this.#dir, ENDO_DEVELOP_AUTOMATION_FIRES_DIRECTORY_V0);
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get root(): string {
		return this.#root;
	}
	get dir(): string {
		return this.#dir;
	}
	get firesDir(): string {
		return this.#firesDir;
	}
	get schedulesPath(): string {
		return join(this.#dir, ENDO_DEVELOP_SCHEDULES_FILE_V0);
	}
	get leasePath(): string {
		return join(this.#dir, ENDO_DEVELOP_LEASE_FILE_V0);
	}
	get resourcesPath(): string {
		return join(this.#dir, ENDO_DEVELOP_RESOURCES_FILE_V0);
	}
	get declarationsPath(): string {
		return join(this.#dir, ENDO_DEVELOP_DECLARATIONS_FILE_V0);
	}

	// ---- Lock-Free Read-Only Accessors (Create Nothing) ----------------------------------------------------------------------------

	readSchedules(): EndoAutomationFileReadV0<EndoDevelopSchedulesFileV0> {
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir],
			this.schedulesPath,
			L.maxFileBytes,
			readEndoDevelopSchedulesFileV0,
		);
	}

	readLease(): EndoAutomationFileReadV0<EndoDevelopAutomationLeaseV0> {
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir],
			this.leasePath,
			L.maxLeaseFileBytes,
			readEndoDevelopAutomationLeaseV0,
		);
	}

	readResources(): EndoAutomationFileReadV0<EndoDevelopResourceObservationV0> {
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir],
			this.resourcesPath,
			L.maxFileBytes,
			readEndoDevelopResourceObservationV0,
		);
	}

	readDeclarations(): EndoAutomationFileReadV0<EndoDevelopResourceDeclarationsFileV0> {
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir],
			this.declarationsPath,
			L.maxFileBytes,
			readEndoDevelopResourceDeclarationsFileV0,
		);
	}

	readFireClaim(idempotencyKey: string): EndoAutomationFileReadV0<EndoDevelopScheduleFireClaimV0> {
		if (!ENDO_SHA256_HEX_PATTERN_V0.test(idempotencyKey))
			return { ok: false, reason: "unsafe-path", detail: "idempotencyKey must be 64 lowercase hex chars" };
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir, this.#firesDir],
			join(this.#firesDir, `${idempotencyKey}.claimed.json`),
			L.maxFireRecordBytes,
			readEndoDevelopScheduleFireClaimV0,
		);
	}

	readFireOutcome(idempotencyKey: string): EndoAutomationFileReadV0<EndoDevelopScheduleFireOutcomeV0> {
		if (!ENDO_SHA256_HEX_PATTERN_V0.test(idempotencyKey))
			return { ok: false, reason: "unsafe-path", detail: "idempotencyKey must be 64 lowercase hex chars" };
		return readBoundedValidatedJsonSync(
			[this.#developDir, this.#dir, this.#firesDir],
			join(this.#firesDir, `${idempotencyKey}.outcome.json`),
			L.maxFireRecordBytes,
			readEndoDevelopScheduleFireOutcomeV0,
		);
	}

	readFires(maxEntries = L.maxFireDirectoryEntries): EndoAutomationFiresReadV0 | EndoAutomationFiresReadFailureV0 {
		const dirState = checkDirectoriesSyncV0([this.#developDir, this.#dir, this.#firesDir]);
		if (dirState === "missing") return { ok: true, entries: [], problems: [], truncated: false };
		if (dirState !== "ok") return { ok: false, reason: dirState === "unsafe-path" ? "unsafe-path" : "io" };

		const names = readDirectoryNamesAtMostV0(this.#firesDir, maxEntries);
		if (names === null) return { ok: false, reason: "too-many" };

		const claims = new Map<string, EndoDevelopScheduleFireClaimV0>();
		const outcomes = new Map<string, EndoDevelopScheduleFireOutcomeV0>();
		const problems: { name: string; reason: EndoAutomationReadProblemV0 }[] = [];

		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const match = FIRE_FILE_PATTERN.exec(name);
			if (match === null) {
				problems.push({ name, reason: "unsafe-path" });
				continue;
			}
			const key = match[1]!;
			const kind = match[2] as "claimed" | "outcome";
			if (kind === "claimed") {
				const read = this.readFireClaim(key);
				if (!read.ok) problems.push({ name, reason: read.reason });
				else if (read.exists) {
					if (read.value.idempotencyKey !== key) problems.push({ name, reason: "invalid" });
					else claims.set(key, read.value);
				}
			} else {
				const read = this.readFireOutcome(key);
				if (!read.ok) problems.push({ name, reason: read.reason });
				else if (read.exists) {
					if (read.value.idempotencyKey !== key) problems.push({ name, reason: "invalid" });
					else outcomes.set(key, read.value);
				}
			}
		}

		const keys = [...new Set([...claims.keys(), ...outcomes.keys()])].sort();
		const entries: EndoProjectedFireEntryV0[] = [];
		for (const idempotencyKey of keys) {
			const claim = claims.get(idempotencyKey) ?? null;
			const outcome = outcomes.get(idempotencyKey) ?? null;
			let state: EndoScheduleFireProjectedStateV0;
			if (claim !== null && outcome === null) {
				state = "claimed-incomplete";
			} else if (outcome !== null && claim === null) {
				state = outcome.status === "missed-skipped" ? "missed-skipped" : "orphan-outcome";
			} else if (outcome !== null) {
				state = outcome.status;
			} else {
				continue;
			}
			entries.push(Object.freeze({ idempotencyKey, state, claim, outcome }));
		}
		entries.sort((a, b) => {
			const ta = a.outcome?.completedAtMs ?? a.claim?.claimedAtMs ?? 0;
			const tb = b.outcome?.completedAtMs ?? b.claim?.claimedAtMs ?? 0;
			return tb !== ta
				? tb - ta
				: a.idempotencyKey < b.idempotencyKey
					? -1
					: a.idempotencyKey > b.idempotencyKey
						? 1
						: 0;
		});
		return { ok: true, entries: Object.freeze(entries), problems: Object.freeze(problems), truncated: false };
	}

	// ---- Synchronized Lock Critical Section (Strictly Synchronous — Never Held Across Async Probes) --------------------------------

	withAutomationLockSync<T>(
		fn: (session: EndoAutomationLockedSessionV0) => T,
	):
		| { readonly ok: true; readonly result: T }
		| { readonly ok: false; readonly code: "busy" | "unsafe-path" | "storage-failed" } {
		if (!ensureDirectoriesSyncV0([this.#developDir, this.#dir])) {
			const state = checkDirectoriesSyncV0([this.#developDir, this.#dir]);
			return { ok: false, code: state === "unsafe-path" ? "unsafe-path" : "storage-failed" };
		}
		const release = acquireEndoNumberedLockV0(this.#dir, ENDO_DEVELOP_AUTOMATION_LOCK_V0, {
			waitMs: this.#options.lockWaitMs ?? 2_000,
			now: this.#now,
			...(this.#options.lockHooks === undefined ? {} : { hooks: this.#options.lockHooks }),
		});
		if (release === "busy") return { ok: false, code: "busy" };
		if (release === "failed") return { ok: false, code: "storage-failed" };
		try {
			const session: EndoAutomationLockedSessionV0 = {
				readSchedules: () => this.readSchedules(),
				writeSchedules: (file) => {
					const validated = validateEndoDevelopSchedulesFileV0(file);
					return replaceJsonAtomicSync(
						this.#dir,
						ENDO_DEVELOP_SCHEDULES_FILE_V0,
						validated,
						L.maxFileBytes,
						this.#options,
					);
				},
				readLease: () => this.readLease(),
				writeLease: (lease) => {
					const validated = validateEndoDevelopAutomationLeaseV0(lease);
					return replaceJsonAtomicSync(
						this.#dir,
						ENDO_DEVELOP_LEASE_FILE_V0,
						validated,
						L.maxLeaseFileBytes,
						this.#options,
					);
				},
				readResources: () => this.readResources(),
				writeResources: (obs) => {
					const validated = validateEndoDevelopResourceObservationV0(obs);
					return replaceJsonAtomicSync(
						this.#dir,
						ENDO_DEVELOP_RESOURCES_FILE_V0,
						validated,
						L.maxFileBytes,
						this.#options,
					);
				},
				readDeclarations: () => this.readDeclarations(),
				writeDeclarations: (file) => {
					const validated = validateEndoDevelopResourceDeclarationsFileV0(file);
					return replaceJsonAtomicSync(
						this.#dir,
						ENDO_DEVELOP_DECLARATIONS_FILE_V0,
						validated,
						L.maxFileBytes,
						this.#options,
					);
				},
				readFireClaim: (idempotencyKey) => this.readFireClaim(idempotencyKey),
				writeFireClaimOnce: (claim) => {
					const validated = validateEndoDevelopScheduleFireClaimV0(claim);
					if (!ensureDirectoriesSyncV0([this.#developDir, this.#dir, this.#firesDir])) return "failed";
					const fileName = `${validated.idempotencyKey}.claimed.json`;
					const bytes = Buffer.from(`${canonicalEndoJsonV0(validated as never)}\n`, "utf8");
					if (bytes.length > L.maxFireRecordBytes) return "failed";
					return writeOnceSyncV0(
						this.#firesDir,
						fileName,
						bytes,
						this.#options.beforeFireLink === undefined
							? undefined
							: () => this.#options.beforeFireLink?.(fileName),
					);
				},
				writeFireOutcomeOnce: (outcome) => {
					const validated = validateEndoDevelopScheduleFireOutcomeV0(outcome);
					if (!ensureDirectoriesSyncV0([this.#developDir, this.#dir, this.#firesDir])) return "failed";
					const fileName = `${validated.idempotencyKey}.outcome.json`;
					const bytes = Buffer.from(`${canonicalEndoJsonV0(validated as never)}\n`, "utf8");
					if (bytes.length > L.maxFireRecordBytes) return "failed";
					return writeOnceSyncV0(
						this.#firesDir,
						fileName,
						bytes,
						this.#options.beforeFireLink === undefined
							? undefined
							: () => this.#options.beforeFireLink?.(fileName),
					);
				},
				pruneRetainedFires: (maxRetainedPairs = L.maxFirePairsRetained) =>
					this.#pruneRetainedFiresUnderLock(maxRetainedPairs),
			};
			return { ok: true, result: fn(session) };
		} finally {
			release();
		}
	}

	/**
	 * Prune terminal fire records past `maxRetainedPairs` (oldest completedAtMs first).
	 * CRITICAL RETENTION INVARIANTS (S1-D / S1-AT10 / Adversarial H5):
	 * - Streams `fires/` directly so accumulated `claimed-incomplete` or `.tmp-*` entries can never deadlock terminal pruning.
	 * - Unresolved `claimed-incomplete` records (`.claimed.json` without `.outcome.json`) are NEVER removed.
	 * - `schedules.json` retains `cursor.lastConsumedWindowStartMs` and `retiredCursors`,
	 *   so pruned windows can NEVER become eligible again.
	 */
	#pruneRetainedFiresUnderLock(maxRetainedPairs: number): {
		readonly prunedKeys: readonly string[];
		readonly keptIncompleteCount: number;
	} {
		const dirState = checkDirectoriesSyncV0([this.#developDir, this.#dir, this.#firesDir]);
		if (dirState !== "ok") return { prunedKeys: [], keptIncompleteCount: 0 };

		const claimedKeys = new Set<string>();
		const outcomeKeys = new Set<string>();
		const MAX_PRUNE_SCAN = 16_384;
		let scanned = 0;

		try {
			const dir = opendirSync(this.#firesDir, { bufferSize: 32 });
			try {
				for (let next = dir.readSync(); next !== null && scanned < MAX_PRUNE_SCAN; next = dir.readSync()) {
					scanned += 1;
					const name = next.name;
					if (WRITE_ONCE_TEMPORARY_V0.test(name)) {
						const p = join(this.#firesDir, name);
						const info = lstatSync(p, { throwIfNoEntry: false });
						if (info?.isFile() === true && Date.now() - info.mtimeMs >= 60_000) rmSync(p, { force: true });
						continue;
					}
					const match = FIRE_FILE_PATTERN.exec(name);
					if (match === null) continue;
					const key = match[1]!;
					if (match[2] === "claimed") claimedKeys.add(key);
					else outcomeKeys.add(key);
				}
			} finally {
				dir.closeSync();
			}
		} catch {
			return { prunedKeys: [], keptIncompleteCount: 0 };
		}

		let keptIncompleteCount = 0;
		for (const key of claimedKeys) {
			if (!outcomeKeys.has(key)) keptIncompleteCount += 1;
		}

		const terminal: { key: string; completedAtMs: number; hasClaim: boolean }[] = [];
		for (const key of outcomeKeys) {
			const hasClaim = claimedKeys.has(key);
			const read = this.readFireOutcome(key);
			if (!read.ok || !read.exists) continue;
			if (read.value.idempotencyKey !== key) continue;
			// Preserve orphan outcomes (non-missed-skipped without a claim) for operator diagnosis
			if (!hasClaim && read.value.status !== "missed-skipped") continue;
			terminal.push({ key, completedAtMs: read.value.completedAtMs, hasClaim });
		}

		if (terminal.length <= maxRetainedPairs) {
			return { prunedKeys: [], keptIncompleteCount };
		}

		terminal.sort((a, b) =>
			b.completedAtMs !== a.completedAtMs
				? b.completedAtMs - a.completedAtMs
				: a.key < b.key
					? -1
					: a.key > b.key
						? 1
						: 0,
		);
		const toPrune = terminal.slice(maxRetainedPairs);
		const prunedKeys: string[] = [];
		for (const entry of toPrune) {
			const claimPath = join(this.#firesDir, `${entry.key}.claimed.json`);
			const outcomePath = join(this.#firesDir, `${entry.key}.outcome.json`);
			try {
				if (entry.hasClaim) rmSync(claimPath, { force: true });
				rmSync(outcomePath, { force: true });
				prunedKeys.push(entry.key);
			} catch {
				// leave for next retention pass
			}
		}
		return { prunedKeys, keptIncompleteCount };
	}

	// ---- Operator Schedule Mutations -----------------------------------------------------------------------------------------------

	addSchedule(input: AddEndoScheduleInputV0): EndoAutomationMutationResultV0<{
		readonly schedule: EndoDevelopScheduleV0;
		readonly file: EndoDevelopSchedulesFileV0;
	}> {
		if (!ENDO_SCHEDULE_ID_PATTERN_V0.test(input.scheduleId)) {
			return {
				ok: false,
				code: "bad-request",
				detail: "scheduleId must be 1-64 lowercase letters, digits, or inner ._-",
			};
		}
		let trigger: EndoScheduleTriggerV0;
		try {
			trigger = validateEndoScheduleTriggerV0(input.trigger, "trigger");
		} catch (error) {
			return { ok: false, code: "bad-request", detail: error instanceof Error ? error.message : String(error) };
		}
		const locked = this.withAutomationLockSync((s) => {
			const currentRead = s.readSchedules();
			if (!currentRead.ok) {
				return {
					ok: false as const,
					code: "unreadable" as const,
					detail: `${currentRead.reason}: ${currentRead.detail}`,
				};
			}
			const file = currentRead.exists ? currentRead.value : emptyEndoDevelopSchedulesFileV0();
			if (input.expectedRevision !== undefined && file.revision !== input.expectedRevision) {
				return {
					ok: false as const,
					code: "stale-revision" as const,
					detail: `expected revision ${input.expectedRevision}, found ${file.revision}`,
				};
			}
			if (file.schedules.some((sc) => sc.scheduleId === input.scheduleId)) {
				return {
					ok: false as const,
					code: "duplicate" as const,
					detail: `schedule ${input.scheduleId} already exists`,
				};
			}
			if (file.schedules.length >= L.maxSchedules) {
				return {
					ok: false as const,
					code: "limit" as const,
					detail: `maximum ${L.maxSchedules} schedules reached`,
				};
			}
			const nowMs = this.#now();
			const retired = file.retiredCursors.find((c) => c.scheduleId === input.scheduleId);
			const nextRetired =
				retired === undefined
					? [...file.retiredCursors]
					: file.retiredCursors.filter((c) => c.scheduleId !== input.scheduleId);

			const schedule: EndoDevelopScheduleV0 = {
				scheduleId: input.scheduleId,
				label: input.label ?? null,
				revision: 1,
				enabled: input.enabled ?? true,
				actionKind: input.actionKind,
				missedRunPolicy: input.missedRunPolicy ?? "skip-and-report",
				trigger,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
				cursor: {
					lastEvaluatedAtMs: null,
					// Inherit retired cursor floor so deleting and re-creating the same scheduleId never resurrects pruned windows.
					lastConsumedWindowStartMs: retired?.lastConsumedWindowStartMs ?? null,
					completedOnce: false,
					lastFireIdempotencyKey: null,
					lastFireStatus: null,
				},
			};
			const nextFileCandidate: EndoDevelopSchedulesFileV0 = {
				schemaVersion: ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: [...file.schedules, schedule].sort((a, b) =>
					a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0,
				),
				retiredCursors: nextRetired,
			};
			let validated: EndoDevelopSchedulesFileV0;
			try {
				validated = validateEndoDevelopSchedulesFileV0(nextFileCandidate);
			} catch (error) {
				return {
					ok: false as const,
					code: "bad-request" as const,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			const outcome = s.writeSchedules(validated);
			if (outcome !== "committed") return { ok: false as const, code: outcome };
			const created = validated.schedules.find((sc) => sc.scheduleId === input.scheduleId)!;
			return { ok: true as const, value: { schedule: created, file: validated }, commit: "committed" as const };
		});
		if (!locked.ok) return { ok: false, code: locked.code };
		return locked.result;
	}

	setScheduleEnabled(
		scheduleId: string,
		enabled: boolean,
		expectedRevision?: number,
	): EndoAutomationMutationResultV0<{
		readonly schedule: EndoDevelopScheduleV0;
		readonly file: EndoDevelopSchedulesFileV0;
	}> {
		if (!ENDO_SCHEDULE_ID_PATTERN_V0.test(scheduleId)) {
			return { ok: false, code: "bad-request", detail: "invalid scheduleId" };
		}
		const locked = this.withAutomationLockSync((s) => {
			const currentRead = s.readSchedules();
			if (!currentRead.ok) {
				return {
					ok: false as const,
					code: "unreadable" as const,
					detail: `${currentRead.reason}: ${currentRead.detail}`,
				};
			}
			if (!currentRead.exists) return { ok: false as const, code: "not-found" as const, detail: scheduleId };
			const file = currentRead.value;
			const target = file.schedules.find((sc) => sc.scheduleId === scheduleId);
			if (target === undefined) return { ok: false as const, code: "not-found" as const, detail: scheduleId };
			if (expectedRevision !== undefined && target.revision !== expectedRevision) {
				return {
					ok: false as const,
					code: "stale-revision" as const,
					detail: `expected schedule revision ${expectedRevision}, found ${target.revision}`,
				};
			}
			if (target.enabled === enabled) {
				return { ok: true as const, value: { schedule: target, file }, commit: "unchanged" as const };
			}
			const nowMs = Math.max(this.#now(), target.createdAtMs);
			const updatedSchedule: EndoDevelopScheduleV0 = {
				...target,
				enabled,
				revision: target.revision + 1,
				updatedAtMs: nowMs,
			};
			const nextFile = validateEndoDevelopSchedulesFileV0({
				...file,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: file.schedules.map((sc) => (sc.scheduleId === scheduleId ? updatedSchedule : sc)),
			});
			const outcome = s.writeSchedules(nextFile);
			if (outcome !== "committed") return { ok: false as const, code: outcome };
			const saved = nextFile.schedules.find((sc) => sc.scheduleId === scheduleId)!;
			return { ok: true as const, value: { schedule: saved, file: nextFile }, commit: "committed" as const };
		});
		if (!locked.ok) return { ok: false, code: locked.code };
		return locked.result;
	}

	reviseSchedule(input: ReviseEndoScheduleInputV0): EndoAutomationMutationResultV0<{
		readonly schedule: EndoDevelopScheduleV0;
		readonly file: EndoDevelopSchedulesFileV0;
	}> {
		if (!ENDO_SCHEDULE_ID_PATTERN_V0.test(input.scheduleId)) {
			return { ok: false, code: "bad-request", detail: "invalid scheduleId" };
		}
		let validatedTrigger: EndoScheduleTriggerV0 | undefined;
		if (input.trigger !== undefined) {
			try {
				validatedTrigger = validateEndoScheduleTriggerV0(input.trigger, "trigger");
			} catch (error) {
				return { ok: false, code: "bad-request", detail: error instanceof Error ? error.message : String(error) };
			}
		}
		const locked = this.withAutomationLockSync((s) => {
			const currentRead = s.readSchedules();
			if (!currentRead.ok) {
				return {
					ok: false as const,
					code: "unreadable" as const,
					detail: `${currentRead.reason}: ${currentRead.detail}`,
				};
			}
			if (!currentRead.exists) return { ok: false as const, code: "not-found" as const, detail: input.scheduleId };
			const file = currentRead.value;
			const target = file.schedules.find((sc) => sc.scheduleId === input.scheduleId);
			if (target === undefined) return { ok: false as const, code: "not-found" as const, detail: input.scheduleId };
			if (input.expectedRevision !== undefined && target.revision !== input.expectedRevision) {
				return {
					ok: false as const,
					code: "stale-revision" as const,
					detail: `expected schedule revision ${input.expectedRevision}, found ${target.revision}`,
				};
			}
			const nowMs = Math.max(this.#now(), target.createdAtMs);
			const nextCursor =
				validatedTrigger === undefined
					? target.cursor
					: {
							...target.cursor,
							completedOnce: false,
							lastConsumedWindowStartMs:
								validatedTrigger.kind === "calendar"
									? Math.max(target.cursor.lastConsumedWindowStartMs ?? 0, nowMs - 1)
									: target.cursor.lastConsumedWindowStartMs,
						};
			const updatedSchedule: EndoDevelopScheduleV0 = {
				...target,
				actionKind: input.actionKind ?? target.actionKind,
				trigger: validatedTrigger ?? target.trigger,
				missedRunPolicy: input.missedRunPolicy ?? target.missedRunPolicy,
				label: input.label !== undefined ? input.label : target.label,
				revision: target.revision + 1,
				updatedAtMs: nowMs,
				cursor: nextCursor,
			};
			let nextFile: EndoDevelopSchedulesFileV0;
			try {
				nextFile = validateEndoDevelopSchedulesFileV0({
					...file,
					revision: file.revision + 1,
					updatedAtMs: nowMs,
					schedules: file.schedules.map((sc) => (sc.scheduleId === input.scheduleId ? updatedSchedule : sc)),
				});
			} catch (error) {
				return {
					ok: false as const,
					code: "bad-request" as const,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			const outcome = s.writeSchedules(nextFile);
			if (outcome !== "committed") return { ok: false as const, code: outcome };
			const saved = nextFile.schedules.find((sc) => sc.scheduleId === input.scheduleId)!;
			return { ok: true as const, value: { schedule: saved, file: nextFile }, commit: "committed" as const };
		});
		if (!locked.ok) return { ok: false, code: locked.code };
		return locked.result;
	}

	removeSchedule(
		scheduleId: string,
		expectedRevision?: number,
	): EndoAutomationMutationResultV0<{
		readonly removed: EndoDevelopScheduleV0;
		readonly file: EndoDevelopSchedulesFileV0;
	}> {
		if (!ENDO_SCHEDULE_ID_PATTERN_V0.test(scheduleId)) {
			return { ok: false, code: "bad-request", detail: "invalid scheduleId" };
		}
		const locked = this.withAutomationLockSync((s) => {
			const currentRead = s.readSchedules();
			if (!currentRead.ok) {
				return {
					ok: false as const,
					code: "unreadable" as const,
					detail: `${currentRead.reason}: ${currentRead.detail}`,
				};
			}
			if (!currentRead.exists) return { ok: false as const, code: "not-found" as const, detail: scheduleId };
			const file = currentRead.value;
			const target = file.schedules.find((sc) => sc.scheduleId === scheduleId);
			if (target === undefined) return { ok: false as const, code: "not-found" as const, detail: scheduleId };
			if (expectedRevision !== undefined && target.revision !== expectedRevision) {
				return {
					ok: false as const,
					code: "stale-revision" as const,
					detail: `expected schedule revision ${expectedRevision}, found ${target.revision}`,
				};
			}
			const nowMs = Math.max(this.#now(), file.updatedAtMs);
			const existingRetired = file.retiredCursors.find((c) => c.scheduleId === scheduleId);
			const retiredCursors: EndoDevelopRetiredScheduleCursorV0[] = file.retiredCursors.filter(
				(c) => c.scheduleId !== scheduleId,
			);
			if (target.cursor.lastConsumedWindowStartMs !== null) {
				if (existingRetired === undefined && retiredCursors.length >= L.maxRetiredCursors) {
					// Conservative refusal (Adversarial H4): never silently evict a retired cursor floor, which could allow window resurrection.
					return {
						ok: false as const,
						code: "limit" as const,
						detail: `retired cursor limit (${L.maxRetiredCursors}) reached; refusing removal to prevent window resurrection`,
					};
				}
				retiredCursors.push({
					scheduleId,
					lastConsumedWindowStartMs: Math.max(
						existingRetired?.lastConsumedWindowStartMs ?? 0,
						target.cursor.lastConsumedWindowStartMs,
					),
					retiredAtMs: nowMs,
				});
			}
			retiredCursors.sort((a, b) => (a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0));
			const nextFile = validateEndoDevelopSchedulesFileV0({
				...file,
				revision: file.revision + 1,
				updatedAtMs: nowMs,
				schedules: file.schedules.filter((sc) => sc.scheduleId !== scheduleId),
				retiredCursors,
			});
			const outcome = s.writeSchedules(nextFile);
			if (outcome !== "committed") return { ok: false as const, code: outcome };
			return { ok: true as const, value: { removed: target, file: nextFile }, commit: "committed" as const };
		});
		if (!locked.ok) return { ok: false, code: locked.code };
		return locked.result;
	}

	// ---- Operator Resource Window Declaration --------------------------------------------------------------------------------------

	declareResourceWindow(input: DeclareEndoResourceWindowInputV0): EndoAutomationMutationResultV0<{
		readonly declaration: EndoOperatorResourceWindowDeclarationV0;
		readonly file: EndoDevelopResourceDeclarationsFileV0;
	}> {
		if (!ENDO_PROVIDER_ID_PATTERN_V0.test(input.providerId)) {
			return {
				ok: false,
				code: "bad-request",
				detail: "providerId must be 1-64 lowercase letters, digits, or inner ._-",
			};
		}
		if (input.providerId === "local-inference") {
			return {
				ok: false,
				code: "bad-request",
				detail: 'providerId "local-inference" is reserved for controller-observed local endpoint health',
			};
		}
		const locked = this.withAutomationLockSync((s) => {
			const currentRead = s.readDeclarations();
			if (!currentRead.ok) {
				return {
					ok: false as const,
					code: "unreadable" as const,
					detail: `${currentRead.reason}: ${currentRead.detail}`,
				};
			}
			const file = currentRead.exists ? currentRead.value : emptyEndoDevelopResourceDeclarationsFileV0();
			const nowMs = this.#now();
			const windowKind = input.windowKind ?? "rolling-5h";
			const declaration: EndoOperatorResourceWindowDeclarationV0 = {
				providerId: input.providerId,
				surfaceKind: input.surfaceKind ?? "subscription-window",
				quotaPoolId: input.quotaPoolId ?? null,
				windowKind,
				standing: input.standing ?? "exhausted-until-reset",
				resetAtMs: input.resetAtMs,
				declaredAtMs: nowMs,
				basis: "operator-declared",
				note: input.note ?? null,
			};
			const existingIdx = file.declarations.findIndex(
				(d) => d.providerId === input.providerId && d.windowKind === windowKind,
			);
			const nextDeclarations =
				existingIdx >= 0
					? file.declarations.map((d, i) => (i === existingIdx ? declaration : d))
					: [...file.declarations, declaration];
			if (nextDeclarations.length > L.maxDeclarations) {
				return {
					ok: false as const,
					code: "limit" as const,
					detail: `maximum ${L.maxDeclarations} declarations reached`,
				};
			}
			const distinctProviders = new Set(nextDeclarations.map((d) => d.providerId));
			if (distinctProviders.size > L.maxProvidersObserved) {
				return {
					ok: false as const,
					code: "limit" as const,
					detail: `maximum ${L.maxProvidersObserved} distinct declared providers reached`,
				};
			}
			nextDeclarations.sort((a, b) =>
				a.providerId !== b.providerId
					? a.providerId < b.providerId
						? -1
						: 1
					: a.windowKind < b.windowKind
						? -1
						: a.windowKind > b.windowKind
							? 1
							: 0,
			);
			let validated: EndoDevelopResourceDeclarationsFileV0;
			try {
				validated = validateEndoDevelopResourceDeclarationsFileV0({
					schemaVersion: ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0,
					revision: file.revision + 1,
					updatedAtMs: nowMs,
					declarations: nextDeclarations,
				});
			} catch (error) {
				return {
					ok: false as const,
					code: "bad-request" as const,
					detail: error instanceof Error ? error.message : String(error),
				};
			}
			const outcome = s.writeDeclarations(validated);
			if (outcome !== "committed") return { ok: false as const, code: outcome };
			const saved = validated.declarations.find(
				(d) => d.providerId === input.providerId && d.windowKind === windowKind,
			)!;
			return { ok: true as const, value: { declaration: saved, file: validated }, commit: "committed" as const };
		});
		if (!locked.ok) return { ok: false, code: locked.code };
		return locked.result;
	}
}

// ---- Read-Only Projection Seam for CLI & Future F1 Mission Board -------------------------------------------------------------------

/**
 * Strictly read-only, lock-free snapshot of `<root>/develop/automation/` with live freshness evaluation.
 * Creates zero files or directories and never acquires `automation.lock.<n>` or `session-attachment.lock`.
 */
export function readEndoAutomationProjectionV0(
	root: string,
	options: { readonly now?: () => number; readonly includeFires?: boolean } = {},
): EndoAutomationProjectionV0 {
	const nowMs = (options.now ?? Date.now)();
	const store = new DevelopAutomationStoreV0(root, { now: () => nowMs });

	const schedulesRead = store.readSchedules();
	const schedules: EndoAutomationProjectionV0["schedules"] = !schedulesRead.ok
		? { state: "unreadable", reason: schedulesRead.reason, detail: schedulesRead.detail }
		: schedulesRead.exists
			? { state: "ready", file: schedulesRead.value }
			: { state: "absent" };

	const leaseRead = store.readLease();
	const lease: EndoAutomationProjectionV0["lease"] = !leaseRead.ok
		? { state: "unreadable", reason: leaseRead.reason, detail: leaseRead.detail }
		: leaseRead.exists
			? {
					state: "ready",
					lease: leaseRead.value,
					active: leaseRead.value.releasedAtMs === null && nowMs < leaseRead.value.expiresAtMs,
				}
			: { state: "absent" };

	const resourcesRead = store.readResources();
	const resources: EndoAutomationProjectionV0["resources"] = !resourcesRead.ok
		? { state: "unreadable", reason: resourcesRead.reason, detail: resourcesRead.detail }
		: resourcesRead.exists
			? {
					state: "ready",
					observation: resourcesRead.value,
					freshness: endoObservationFreshnessV0(
						resourcesRead.value.observedAtMs,
						resourcesRead.value.staleAfterMs,
						nowMs,
					),
					effectiveProviders: resourcesRead.value.providers.map((p) => endoEffectiveProviderAllowanceV0(p, nowMs)),
				}
			: { state: "absent" };

	const declRead = store.readDeclarations();
	const declarations: EndoAutomationProjectionV0["declarations"] = !declRead.ok
		? { state: "unreadable", reason: declRead.reason, detail: declRead.detail }
		: declRead.exists
			? { state: "ready", file: declRead.value }
			: { state: "absent" };

	let fires: EndoAutomationProjectionV0["fires"];
	if (options.includeFires === false) {
		fires = { state: "absent" };
	} else {
		const firesRead = store.readFires();
		if (!firesRead.ok) {
			fires = { state: "unreadable", reason: firesRead.reason };
		} else if (firesRead.entries.length === 0 && firesRead.problems.length === 0) {
			fires = { state: "absent" };
		} else {
			fires = {
				state: "ready",
				entries: firesRead.entries,
				incompleteCount: firesRead.entries.filter((e) => e.state === "claimed-incomplete").length,
				problemCount: firesRead.problems.length,
				truncated: firesRead.truncated,
			};
		}
	}

	return Object.freeze({
		schemaVersion: "endo.develop-automation-projection.v0",
		observedAtMs: nowMs,
		schedules,
		lease,
		resources,
		declarations,
		fires,
	});
}

export {
	ENDO_DEVELOP_AUTOMATION_LEASE_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_DECLARATIONS_SCHEMA_V0,
	ENDO_DEVELOP_RESOURCE_OBSERVATION_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_CLAIM_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULE_FIRE_OUTCOME_SCHEMA_V0,
	ENDO_DEVELOP_SCHEDULES_SCHEMA_V0,
};
