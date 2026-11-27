// Store-local durable S2 advisory storage (`<root>/develop/automation/advisory/`, docs/designs/coordinator-automation-s2-implementation.md).
//
//   advisory/schedules.json                     endo.develop-advisory-schedules.v0      (atomic temp + fsync + rename)
//   advisory/authorizations.json                endo.develop-advisory-authorizations.v0 (atomic)
//   advisory/lease.json                         endo.develop-automation-lease.v0        (atomic; the advisory duty lease)
//   advisory/observations.json                  endo.develop-advisory-observations.v0   (atomic)
//   advisory/fires/<key>.(claimed|outcome).json write-once link(2)
//   advisory/turns/<id>.(admitted|dispatched|briefing).json write-once link(2)
//   advisory/proposals/<id>.json, <id>.(acknowledged|dismissed).json write-once link(2)
//
// Invariants (carried from S1):
// - Mutations run only inside `withAdvisoryLockSync`, which takes the SAME `automation.lock.<n>` as S1 and a strictly synchronous
//   callback: no model request, probe, status read or subprocess can run while it is held. It never acquires or nests
//   `tasks.lock.<n>`, `coordination.lock.<n>` or `events/session-attachment.lock`.
// - Every read is lstat + O_NOFOLLOW|O_NONBLOCK + fstat + size cap + duplicate-key rejection + closed schema; a malformed or unsafe
//   file fails closed and is never repaired or overwritten by a reader.
// - Write-once records are never replaced. Retention never deletes an unresolved claim or an unsettled turn.

import { closeSync, constants, fsyncSync, lstatSync, opendirSync, openSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ENDO_ADVISORY_LIMITS_V0,
	ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0,
	ENDO_ADVISORY_VERSION_TABLES_V0,
	type EndoAdvisoryAuthorizationsFileV0,
	type EndoAdvisoryBriefingV0,
	type EndoAdvisoryFireClaimV0,
	type EndoAdvisoryFireOutcomeV0,
	type EndoAdvisoryObservationsFileV0,
	type EndoAdvisoryProposalDispositionV0,
	type EndoAdvisoryProposalStateV0,
	type EndoAdvisoryProposalV0,
	type EndoAdvisorySchedulesFileV0,
	type EndoAdvisoryTurnAdmissionV0,
	type EndoAdvisoryTurnDispatchV0,
	validateEndoAdvisoryAuthorizationsFileV0,
	validateEndoAdvisoryBriefingV0,
	validateEndoAdvisoryFireClaimV0,
	validateEndoAdvisoryFireOutcomeV0,
	validateEndoAdvisoryLeaseV0,
	validateEndoAdvisoryObservationsFileV0,
	validateEndoAdvisoryProposalStateV0,
	validateEndoAdvisoryProposalV0,
	validateEndoAdvisorySchedulesFileV0,
	validateEndoAdvisoryTurnAdmissionV0,
	validateEndoAdvisoryTurnDispatchV0,
} from "../protocol/develop-advisory.ts";
import type { EndoDevelopAutomationLeaseV0 } from "../protocol/develop-automation.ts";
import { type EndoVersionTableV0, readEndoVersionedV0 } from "../protocol/versioned.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import type { EndoAdvisoryLedgerTurnV0 } from "../runtime/contracts/develop-advisory.ts";
import {
	ENDO_DEVELOP_AUTOMATION_DIRECTORY_V0,
	ENDO_DEVELOP_AUTOMATION_LOCK_V0,
	type EndoAtomicReplaceOutcomeV0,
	type EndoAutomationFileReadV0,
	type EndoAutomationReadProblemV0,
	readBoundedValidatedJsonSync,
	replaceJsonAtomicSync,
} from "./develop-automation.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import { acquireEndoNumberedLockV0, type EndoNumberedLockHooksV0 } from "./numbered-lock.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readDirectoryNamesAtMostV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_ADVISORY_DIRECTORY_V0 = "advisory";
const L = ENDO_ADVISORY_LIMITS_V0;
const HEX64 = /^[0-9a-f]{64}$/;
const FIRE_FILE = /^([0-9a-f]{64})\.(claimed|outcome)\.json$/;
const TURN_FILE = /^([0-9a-f]{64})\.(admitted|dispatched|briefing)\.json$/;
const PROPOSAL_FILE = /^([0-9a-f]{64})(?:\.(acknowledged|dismissed))?\.json$/;
const ATOMIC_TEMP = /^\.tmp-[a-z0-9._-]+-[0-9]+-[0-9a-f]{12}$/;

export interface EndoDevelopAdvisoryStoreOptionsV0 {
	readonly now?: () => number;
	readonly lockWaitMs?: number;
	readonly lockHooks?: EndoNumberedLockHooksV0;
	/** Test hook: runs inside a write-once write before link(2) (a throw there is a failure at that point). */
	readonly beforeRecordLink?: (fileName: string) => void;
	readonly beforeDirectorySync?: (directory: string) => void;
}

export type EndoAdvisoryWriteOnceV0 = "created" | "exists" | "failed" | "commit-uncertain";

export interface EndoAdvisoryFireEntryV0 {
	readonly idempotencyKey: string;
	readonly claim: EndoAdvisoryFireClaimV0 | null;
	readonly outcome: EndoAdvisoryFireOutcomeV0 | null;
}

export interface EndoAdvisoryListingV0<T> {
	readonly ok: true;
	readonly entries: readonly T[];
	readonly problems: readonly { readonly name: string; readonly reason: EndoAutomationReadProblemV0 }[];
}
export interface EndoAdvisoryListingFailureV0 {
	readonly ok: false;
	readonly reason: "unsafe-path" | "too-many" | "io";
}

export interface EndoAdvisoryProposalEntryV0 {
	readonly proposal: EndoAdvisoryProposalV0;
	readonly dispositions: readonly EndoAdvisoryProposalStateV0[];
	/**
	 * When this proposal was last derived from a published briefing: its creation, or the latest re-derivation recorded in the
	 * proposal grounding index. Supersession, the pending projection and retention all order by it.
	 */
	readonly groundedAtMs: number;
}

const PROPOSAL_GROUNDING_SCHEMA = "endo.develop-advisory-proposal-grounding.v0";

/** Synchronous storage handle exposed ONLY inside `withAdvisoryLockSync`. */
export interface EndoAdvisoryLockedSessionV0 {
	readonly store: DevelopAdvisoryStoreV0;
	writeSchedules(file: EndoAdvisorySchedulesFileV0): EndoAtomicReplaceOutcomeV0;
	writeAuthorizations(file: EndoAdvisoryAuthorizationsFileV0): EndoAtomicReplaceOutcomeV0;
	writeLease(lease: EndoDevelopAutomationLeaseV0): EndoAtomicReplaceOutcomeV0;
	writeObservations(file: EndoAdvisoryObservationsFileV0): EndoAtomicReplaceOutcomeV0;
	writeFireClaimOnce(claim: EndoAdvisoryFireClaimV0): EndoAdvisoryWriteOnceV0;
	writeFireOutcomeOnce(outcome: EndoAdvisoryFireOutcomeV0): EndoAdvisoryWriteOnceV0;
	writeAdmissionOnce(admission: EndoAdvisoryTurnAdmissionV0): EndoAdvisoryWriteOnceV0;
	writeDispatchOnce(dispatch: EndoAdvisoryTurnDispatchV0): EndoAdvisoryWriteOnceV0;
	writeBriefingOnce(briefing: EndoAdvisoryBriefingV0): EndoAdvisoryWriteOnceV0;
	writeProposalOnce(proposal: EndoAdvisoryProposalV0): EndoAdvisoryWriteOnceV0;
	writeProposalStateOnce(state: EndoAdvisoryProposalStateV0): EndoAdvisoryWriteOnceV0;
	/** Record that an existing proposal was re-derived from a published briefing at `groundedAtMs` (proposal records are write-once). */
	recordProposalGrounding(proposalId: string, groundedAtMs: number): EndoAtomicReplaceOutcomeV0;
	/** Bounded retention; never removes an unresolved fire claim, an unsettled turn, or a pending proposal. */
	pruneRetained(nowMs: number): { readonly fires: number; readonly turns: number; readonly proposals: number };
}

const versioned =
	<T>(t: EndoVersionTableV0<T>) =>
	(raw: unknown) =>
		readEndoVersionedV0(t, raw);

export class DevelopAdvisoryStoreV0 {
	readonly #developDir: string;
	readonly #automationDir: string;
	readonly #dir: string;
	readonly #firesDir: string;
	readonly #turnsDir: string;
	readonly #proposalsDir: string;
	readonly #options: EndoDevelopAdvisoryStoreOptionsV0;
	readonly #now: () => number;

	constructor(root: string, options: EndoDevelopAdvisoryStoreOptionsV0 = {}) {
		this.#developDir = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#automationDir = join(this.#developDir, ENDO_DEVELOP_AUTOMATION_DIRECTORY_V0);
		this.#dir = join(this.#automationDir, ENDO_ADVISORY_DIRECTORY_V0);
		this.#firesDir = join(this.#dir, "fires");
		this.#turnsDir = join(this.#dir, "turns");
		this.#proposalsDir = join(this.#dir, "proposals");
		this.#options = options;
		this.#now = options.now ?? Date.now;
	}

	get dir(): string {
		return this.#dir;
	}
	get firesDir(): string {
		return this.#firesDir;
	}
	get turnsDir(): string {
		return this.#turnsDir;
	}
	get proposalsDir(): string {
		return this.#proposalsDir;
	}
	get schedulesPath(): string {
		return join(this.#dir, "schedules.json");
	}
	get authorizationsPath(): string {
		return join(this.#dir, "authorizations.json");
	}
	get leasePath(): string {
		return join(this.#dir, "lease.json");
	}
	get observationsPath(): string {
		return join(this.#dir, "observations.json");
	}

	#base(): string[] {
		return [this.#developDir, this.#automationDir, this.#dir];
	}

	#syncDirectory(dir: string): void {
		this.#options.beforeDirectorySync?.(dir);
		const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}

	/** Fsync `dir` and each ancestor up to the directory holding the develop store, so newly created directories are durable. */
	#syncParents(dir: string): void {
		const stop = dirname(resolve(this.#developDir));
		for (let path = resolve(dir); ; path = dirname(path)) {
			this.#syncDirectory(path);
			if (path === stop || dirname(path) === path) break;
		}
	}

	/** The proposal grounding index: proposal id to the time it was last re-derived. Bounded by the retained proposals. */
	readProposalGrounding(): EndoAutomationFileReadV0<ReadonlyMap<string, number>> {
		return readBoundedValidatedJsonSync(
			this.#base(),
			join(this.#dir, "proposal-grounding.json"),
			L.maxFileBytes,
			(raw) => {
				const bad = { ok: false, kind: "invalid", message: "invalid proposal grounding index" } as const;
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad;
				const v = raw as Record<string, unknown>;
				if (
					Object.keys(v).length !== 2 ||
					v.schemaVersion !== PROPOSAL_GROUNDING_SCHEMA ||
					!Array.isArray(v.entries)
				)
					return bad;
				const map = new Map<string, number>();
				for (const x of v.entries) {
					if (typeof x !== "object" || x === null || Array.isArray(x)) return bad;
					const r = x as Record<string, unknown>;
					if (
						Object.keys(r).length !== 2 ||
						typeof r.proposalId !== "string" ||
						!/^[0-9a-f]{64}$/.test(r.proposalId) ||
						typeof r.groundedAtMs !== "number" ||
						!Number.isSafeInteger(r.groundedAtMs) ||
						r.groundedAtMs < 0 ||
						map.has(r.proposalId)
					)
						return bad;
					map.set(r.proposalId, r.groundedAtMs);
				}
				return { ok: true, schemaVersion: PROPOSAL_GROUNDING_SCHEMA, value: map };
			},
		);
	}

	#writeProposalGrounding(map: ReadonlyMap<string, number>): EndoAtomicReplaceOutcomeV0 {
		const entries = [...map]
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([proposalId, groundedAtMs]) => ({ proposalId, groundedAtMs }));
		return replaceJsonAtomicSync(
			this.#dir,
			"proposal-grounding.json",
			{ schemaVersion: PROPOSAL_GROUNDING_SCHEMA, entries },
			L.maxFileBytes,
			{},
		);
	}

	#readBudgetFloor(): EndoAutomationFileReadV0<number> {
		return readBoundedValidatedJsonSync(this.#base(), join(this.#dir, "budget-floor.json"), 1024, (raw) => {
			if (typeof raw !== "object" || raw === null || Array.isArray(raw))
				return { ok: false, kind: "invalid", message: "invalid budget floor" };
			const value = raw as Record<string, unknown>;
			if (
				Object.keys(value).length !== 2 ||
				value.schemaVersion !== "endo.advisory-budget-floor.v0" ||
				typeof value.nowMs !== "number" ||
				!Number.isSafeInteger(value.nowMs) ||
				value.nowMs < 0
			)
				return { ok: false, kind: "invalid", message: "invalid budget floor" };
			return { ok: true, schemaVersion: value.schemaVersion, value: value.nowMs };
		});
	}

	#read<T>(dirs: readonly string[], path: string, max: number, t: EndoVersionTableV0<T>): EndoAutomationFileReadV0<T> {
		return readBoundedValidatedJsonSync(dirs, path, max, versioned(t));
	}

	// ---- Lock-free reads (create nothing) ------------------------------------------------------------------------------------------

	readSchedules(): EndoAutomationFileReadV0<EndoAdvisorySchedulesFileV0> {
		return this.#read(this.#base(), this.schedulesPath, L.maxFileBytes, ENDO_ADVISORY_VERSION_TABLES_V0.schedules);
	}
	readAuthorizations(): EndoAutomationFileReadV0<EndoAdvisoryAuthorizationsFileV0> {
		return this.#read(
			this.#base(),
			this.authorizationsPath,
			L.maxFileBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.authorizations,
		);
	}
	readLease(): EndoAutomationFileReadV0<EndoDevelopAutomationLeaseV0> {
		return this.#read(this.#base(), this.leasePath, 16 * 1024, ENDO_ADVISORY_VERSION_TABLES_V0.lease);
	}
	readObservations(): EndoAutomationFileReadV0<EndoAdvisoryObservationsFileV0> {
		return this.#read(
			this.#base(),
			this.observationsPath,
			L.maxFileBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.observations,
		);
	}
	readFireClaim(key: string): EndoAutomationFileReadV0<EndoAdvisoryFireClaimV0> {
		if (!HEX64.test(key)) return { ok: false, reason: "unsafe-path", detail: "unsafe fire key" };
		return this.#read(
			[...this.#base(), this.#firesDir],
			join(this.#firesDir, `${key}.claimed.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.fireClaim,
		);
	}
	readFireOutcome(key: string): EndoAutomationFileReadV0<EndoAdvisoryFireOutcomeV0> {
		if (!HEX64.test(key)) return { ok: false, reason: "unsafe-path", detail: "unsafe fire key" };
		return this.#read(
			[...this.#base(), this.#firesDir],
			join(this.#firesDir, `${key}.outcome.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.fireOutcome,
		);
	}
	readAdmission(turnId: string): EndoAutomationFileReadV0<EndoAdvisoryTurnAdmissionV0> {
		if (!HEX64.test(turnId)) return { ok: false, reason: "unsafe-path", detail: "unsafe turn id" };
		return this.#read(
			[...this.#base(), this.#turnsDir],
			join(this.#turnsDir, `${turnId}.admitted.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.admission,
		);
	}
	readDispatch(turnId: string): EndoAutomationFileReadV0<EndoAdvisoryTurnDispatchV0> {
		if (!HEX64.test(turnId)) return { ok: false, reason: "unsafe-path", detail: "unsafe turn id" };
		return this.#read(
			[...this.#base(), this.#turnsDir],
			join(this.#turnsDir, `${turnId}.dispatched.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.dispatch,
		);
	}
	readBriefing(turnId: string): EndoAutomationFileReadV0<EndoAdvisoryBriefingV0> {
		if (!HEX64.test(turnId)) return { ok: false, reason: "unsafe-path", detail: "unsafe turn id" };
		return this.#read(
			[...this.#base(), this.#turnsDir],
			join(this.#turnsDir, `${turnId}.briefing.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.briefing,
		);
	}
	readProposal(proposalId: string): EndoAutomationFileReadV0<EndoAdvisoryProposalV0> {
		if (!HEX64.test(proposalId)) return { ok: false, reason: "unsafe-path", detail: "unsafe proposal id" };
		return this.#read(
			[...this.#base(), this.#proposalsDir],
			join(this.#proposalsDir, `${proposalId}.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.proposal,
		);
	}
	readProposalState(
		proposalId: string,
		disposition: EndoAdvisoryProposalDispositionV0,
	): EndoAutomationFileReadV0<EndoAdvisoryProposalStateV0> {
		if (!HEX64.test(proposalId)) return { ok: false, reason: "unsafe-path", detail: "unsafe proposal id" };
		return this.#read(
			[...this.#base(), this.#proposalsDir],
			join(this.#proposalsDir, `${proposalId}.${disposition}.json`),
			L.maxRecordBytes,
			ENDO_ADVISORY_VERSION_TABLES_V0.proposalState,
		);
	}

	#names(dir: string, max: number = L.maxDirectoryEntries): string[] | EndoAdvisoryListingFailureV0 {
		const state = checkDirectoriesSyncV0([...this.#base(), dir]);
		if (state === "missing") return [];
		if (state !== "ok") return { ok: false, reason: state === "unsafe-path" ? "unsafe-path" : "io" };
		try {
			const names = readDirectoryNamesAtMostV0(dir, max);
			return names === null ? { ok: false, reason: "too-many" } : names;
		} catch {
			return { ok: false, reason: "io" };
		}
	}

	listFires(): EndoAdvisoryListingV0<EndoAdvisoryFireEntryV0> | EndoAdvisoryListingFailureV0 {
		const names = this.#names(this.#firesDir);
		if (!Array.isArray(names)) return names;
		const keys = new Set<string>();
		const problems: { name: string; reason: EndoAutomationReadProblemV0 }[] = [];
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const m = FIRE_FILE.exec(name);
			if (m === null) problems.push({ name, reason: "unsafe-path" });
			else keys.add(m[1] as string);
		}
		const entries: EndoAdvisoryFireEntryV0[] = [];
		for (const key of keys) {
			const claim = this.readFireClaim(key);
			const outcome = this.readFireOutcome(key);
			if (!claim.ok) problems.push({ name: `${key}.claimed.json`, reason: claim.reason });
			if (!outcome.ok) problems.push({ name: `${key}.outcome.json`, reason: outcome.reason });
			const c = claim.ok && claim.exists && claim.value.idempotencyKey === key ? claim.value : null;
			const o = outcome.ok && outcome.exists && outcome.value.idempotencyKey === key ? outcome.value : null;
			if (c === null && o === null) continue;
			entries.push(Object.freeze({ idempotencyKey: key, claim: c, outcome: o }));
		}
		const at = (e: EndoAdvisoryFireEntryV0) => e.outcome?.completedAtMs ?? e.claim?.claimedAtMs ?? 0;
		entries.sort((a, b) => at(b) - at(a) || (a.idempotencyKey < b.idempotencyKey ? -1 : 1));
		return { ok: true, entries, problems };
	}

	/**
	 * Every turn in the ledger, streamed. The bound is `maxTurnLedgerEntries`, derived from the budget ceilings and the retention window, not
	 * the generic directory bound; past it the listing fails closed (`too-many`) rather than undercounting.
	 */
	listTurns(nowMs = this.#now()): EndoAdvisoryListingV0<EndoAdvisoryLedgerTurnV0> | EndoAdvisoryListingFailureV0 {
		const names = this.#names(this.#turnsDir, L.maxTurnLedgerEntries);
		if (!Array.isArray(names)) return names;
		const ids = new Set<string>();
		const problems: { name: string; reason: EndoAutomationReadProblemV0 }[] = [];
		const floor = this.#readBudgetFloor();
		if (!floor.ok || (floor.exists && (!Number.isSafeInteger(nowMs) || nowMs < floor.value)))
			problems.push({ name: "budget-floor.json", reason: floor.ok ? "invalid" : floor.reason });
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const m = TURN_FILE.exec(name);
			if (m === null) problems.push({ name, reason: "unsafe-path" });
			else ids.add(m[1] as string);
		}
		const entries: EndoAdvisoryLedgerTurnV0[] = [];
		for (const id of ids) {
			const admission = this.readAdmission(id);
			const dispatch = this.readDispatch(id);
			const briefing = this.readBriefing(id);
			for (const [kind, read] of [
				["admitted", admission],
				["dispatched", dispatch],
				["briefing", briefing],
			] as const) {
				if (!read.ok) problems.push({ name: `${id}.${kind}.json`, reason: read.reason });
				else if (read.exists && read.value.turnId !== id)
					problems.push({ name: `${id}.${kind}.json`, reason: "invalid" });
			}
			if (!admission.ok || !admission.exists || admission.value.turnId !== id) {
				if (admission.ok && !admission.exists) problems.push({ name: `${id}.admitted.json`, reason: "invalid" });
				continue;
			}
			for (const [kind, read] of [
				["dispatched", dispatch],
				["briefing", briefing],
			] as const) {
				if (
					read.ok &&
					read.exists &&
					(read.value.leaseEpoch !== admission.value.leaseEpoch ||
						read.value.holderId !== admission.value.holderId ||
						read.value.authorizationId !== admission.value.authorizationId ||
						read.value.scheduleRevision !== admission.value.scheduleRevision ||
						(read.value.resourceProfileSha256 ?? null) !== (admission.value.resourceProfileSha256 ?? null))
				)
					problems.push({ name: `${id}.${kind}.json`, reason: "invalid" });
			}
			entries.push(
				Object.freeze({
					admission: admission.value,
					dispatch: dispatch.ok && dispatch.exists && dispatch.value.turnId === id ? dispatch.value : null,
					briefing: briefing.ok && briefing.exists && briefing.value.turnId === id ? briefing.value : null,
				}),
			);
		}
		entries.sort(
			(a, b) =>
				b.admission.admittedAtMs - a.admission.admittedAtMs || (a.admission.turnId < b.admission.turnId ? -1 : 1),
		);
		return { ok: true, entries, problems };
	}

	listProposals(): EndoAdvisoryListingV0<EndoAdvisoryProposalEntryV0> | EndoAdvisoryListingFailureV0 {
		const names = this.#names(this.#proposalsDir);
		if (!Array.isArray(names)) return names;
		const ids = new Set<string>();
		const problems: { name: string; reason: EndoAutomationReadProblemV0 }[] = [];
		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			const m = PROPOSAL_FILE.exec(name);
			if (m === null) problems.push({ name, reason: "unsafe-path" });
			else if (m[2] === undefined) ids.add(m[1] as string);
		}
		const grounding = this.readProposalGrounding();
		if (!grounding.ok) problems.push({ name: "proposal-grounding.json", reason: grounding.reason });
		const groundedAt = grounding.ok && grounding.exists ? grounding.value : new Map<string, number>();
		const entries: EndoAdvisoryProposalEntryV0[] = [];
		for (const id of ids) {
			const read = this.readProposal(id);
			if (!read.ok || !read.exists || read.value.proposalId !== id) {
				problems.push({ name: `${id}.json`, reason: read.ok ? "invalid" : read.reason });
				continue;
			}
			const dispositions: EndoAdvisoryProposalStateV0[] = [];
			for (const d of ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0) {
				const s = this.readProposalState(id, d);
				if (!s.ok) problems.push({ name: `${id}.${d}.json`, reason: s.reason });
				else if (s.exists && s.value.proposalId === id && s.value.disposition === d) dispositions.push(s.value);
			}
			entries.push(
				Object.freeze({
					proposal: read.value,
					dispositions: Object.freeze(dispositions),
					groundedAtMs: Math.max(read.value.generatedAtMs, groundedAt.get(id) ?? 0),
				}),
			);
		}
		// Most recently grounded first: the first entry per dedup key is the current recommendation for every reader.
		entries.sort(
			(a, b) =>
				b.groundedAtMs - a.groundedAtMs ||
				b.proposal.generatedAtMs - a.proposal.generatedAtMs ||
				(a.proposal.proposalId < b.proposal.proposalId ? -1 : 1),
		);
		return { ok: true, entries, problems };
	}

	// ---- Synchronous critical section ----------------------------------------------------------------------------------------------

	withAdvisoryLockSync<T>(
		fn: (session: EndoAdvisoryLockedSessionV0) => T,
	):
		| { readonly ok: true; readonly result: T }
		| { readonly ok: false; readonly code: "busy" | "unsafe-path" | "storage-failed" } {
		if (!ensureDirectoriesSyncV0(this.#base())) {
			const state = checkDirectoriesSyncV0(this.#base());
			return { ok: false, code: state === "unsafe-path" ? "unsafe-path" : "storage-failed" };
		}
		try {
			this.#syncParents(this.#dir);
		} catch {
			return { ok: false, code: "storage-failed" };
		}
		const release = acquireEndoNumberedLockV0(this.#automationDir, ENDO_DEVELOP_AUTOMATION_LOCK_V0, {
			waitMs: this.#options.lockWaitMs ?? 2_000,
			now: this.#now,
			...(this.#options.lockHooks === undefined ? {} : { hooks: this.#options.lockHooks }),
		});
		if (release === "busy") return { ok: false, code: "busy" };
		if (release === "failed") return { ok: false, code: "storage-failed" };
		try {
			const replace = (name: string, value: unknown): EndoAtomicReplaceOutcomeV0 =>
				replaceJsonAtomicSync(this.#dir, name, value, L.maxFileBytes, {});
			const once = (dir: string, name: string, value: unknown): EndoAdvisoryWriteOnceV0 => {
				if (!ensureDirectoriesSyncV0([...this.#base(), dir])) return "failed";
				try {
					this.#syncParents(dir);
				} catch {
					return "failed";
				}
				const bytes = Buffer.from(`${canonicalEndoJsonV0(value as never)}\n`, "utf8");
				if (bytes.length > L.maxRecordBytes) return "failed";
				const hook = this.#options.beforeRecordLink;
				const outcome = writeOnceSyncV0(dir, name, bytes, hook === undefined ? undefined : () => hook(name));
				if (outcome !== "created") return outcome;
				try {
					this.#syncDirectory(dir);
					return "created";
				} catch {
					return "commit-uncertain";
				}
			};
			const session: EndoAdvisoryLockedSessionV0 = {
				store: this,
				writeSchedules: (file) => replace("schedules.json", validateEndoAdvisorySchedulesFileV0(file)),
				writeAuthorizations: (file) =>
					replace("authorizations.json", validateEndoAdvisoryAuthorizationsFileV0(file)),
				writeLease: (lease) => replace("lease.json", validateEndoAdvisoryLeaseV0(lease)),
				writeObservations: (file) => replace("observations.json", validateEndoAdvisoryObservationsFileV0(file)),
				writeFireClaimOnce: (claim) => {
					const v = validateEndoAdvisoryFireClaimV0(claim);
					return once(this.#firesDir, `${v.idempotencyKey}.claimed.json`, v);
				},
				writeFireOutcomeOnce: (outcome) => {
					const v = validateEndoAdvisoryFireOutcomeV0(outcome);
					return once(this.#firesDir, `${v.idempotencyKey}.outcome.json`, v);
				},
				writeAdmissionOnce: (admission) => {
					const v = validateEndoAdvisoryTurnAdmissionV0(admission);
					return once(this.#turnsDir, `${v.turnId}.admitted.json`, v);
				},
				writeDispatchOnce: (dispatch) => {
					const v = validateEndoAdvisoryTurnDispatchV0(dispatch);
					return once(this.#turnsDir, `${v.turnId}.dispatched.json`, v);
				},
				writeBriefingOnce: (briefing) => {
					const v = validateEndoAdvisoryBriefingV0(briefing);
					return once(this.#turnsDir, `${v.turnId}.briefing.json`, v);
				},
				writeProposalOnce: (proposal) => {
					const v = validateEndoAdvisoryProposalV0(proposal);
					return once(this.#proposalsDir, `${v.proposalId}.json`, v);
				},
				writeProposalStateOnce: (state) => {
					const v = validateEndoAdvisoryProposalStateV0(state);
					return once(this.#proposalsDir, `${v.proposalId}.${v.disposition}.json`, v);
				},
				recordProposalGrounding: (proposalId, groundedAtMs) => {
					const current = this.readProposalGrounding();
					if (!current.ok) return "storage-failed";
					const live = this.listProposals();
					if (!live.ok) return "storage-failed";
					const retained = new Set(live.entries.map((e) => e.proposal.proposalId));
					if (!retained.has(proposalId)) return "storage-failed";
					const next = new Map([...(current.exists ? current.value : [])].filter(([id]) => retained.has(id)));
					next.set(proposalId, Math.max(next.get(proposalId) ?? 0, groundedAtMs));
					return this.#writeProposalGrounding(next);
				},
				pruneRetained: (nowMs) => this.#pruneUnderLock(nowMs),
			};
			return { ok: true, result: fn(session) };
		} finally {
			release();
		}
	}

	/**
	 * Retention, under the lock:
	 * - fires: terminal pairs beyond the newest 256 are removed; a claim without an outcome is never removed.
	 * - turns: a settled turn is removed only when older than the longest budget period (7 days) and beyond the newest 512 settled turns;
	 *   an admitted-only or dispatched-only turn is never removed (its accounting stays conservative).
	 * - proposals: beyond 256 records, the oldest non-pending ones (dismissed, acknowledged or superseded) are removed with their
	 *   dispositions; pending proposals are never removed by retention.
	 */
	#pruneUnderLock(nowMs: number): { fires: number; turns: number; proposals: number } {
		const removed = { fires: 0, turns: 0, proposals: 0 };
		const rm = (path: string) => {
			const info = lstatSync(path, { throwIfNoEntry: false });
			if (info?.isFile() === true) rmSync(path, { force: true });
		};
		const fires = this.listFires();
		if (fires.ok) {
			const terminal = fires.entries.filter((e) => e.claim !== null && e.outcome !== null);
			for (const e of terminal.slice(256)) {
				rm(join(this.#firesDir, `${e.idempotencyKey}.outcome.json`));
				rm(join(this.#firesDir, `${e.idempotencyKey}.claimed.json`));
				removed.fires += 1;
			}
			const orphanMissed = fires.entries.filter((e) => e.claim === null && e.outcome !== null);
			for (const e of orphanMissed.slice(256)) {
				rm(join(this.#firesDir, `${e.idempotencyKey}.outcome.json`));
				removed.fires += 1;
			}
		}
		const floor = this.#readBudgetFloor();
		if (
			floor.ok &&
			Number.isSafeInteger(nowMs) &&
			nowMs >= 0 &&
			(!floor.exists || nowMs >= floor.value) &&
			checkDirectoriesSyncV0([...this.#base(), this.#turnsDir]) === "ok"
		) {
			const scan = (visit: (admission: EndoAdvisoryTurnAdmissionV0, neverDispatched: boolean) => void) => {
				const dir = opendirSync(this.#turnsDir);
				try {
					for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
						const match = TURN_FILE.exec(entry.name);
						if (match === null || match[2] !== "admitted") continue;
						const id = match[1] as string;
						const a = this.readAdmission(id);
						const b = this.readBriefing(id);
						const d = this.readDispatch(id);
						if (
							!a.ok ||
							!a.exists ||
							a.value.turnId !== id ||
							!b.ok ||
							!b.exists ||
							b.value.turnId !== id ||
							!d.ok ||
							(d.exists && d.value.turnId !== id)
						)
							continue;
						if (
							[b.value, ...(d.exists ? [d.value] : [])].some(
								(v) =>
									v.leaseEpoch !== a.value.leaseEpoch ||
									v.holderId !== a.value.holderId ||
									v.authorizationId !== a.value.authorizationId ||
									v.scheduleRevision !== a.value.scheduleRevision ||
									(v.resourceProfileSha256 ?? null) !== (a.value.resourceProfileSha256 ?? null),
							)
						)
							continue;
						visit(a.value, !d.exists && b.value.availability === "not-dispatched");
					}
				} finally {
					dir.closeSync();
				}
			};
			try {
				const all: { readonly admittedAtMs: number; readonly turnId: string }[] = [];
				scan((a) => all.push({ admittedAtMs: a.admittedAtMs, turnId: a.turnId }));
				const count = all.length;
				const newest = all
					.sort((a, b) => b.admittedAtMs - a.admittedAtMs || a.turnId.localeCompare(b.turnId))
					.slice(0, L.maxTerminalTurnsRetained);
				if (
					count > L.maxTerminalTurnsRetained &&
					replaceJsonAtomicSync(
						this.#dir,
						"budget-floor.json",
						{ schemaVersion: "endo.advisory-budget-floor.v0", nowMs },
						1024,
						{},
					) === "committed"
				) {
					this.#syncParents(this.#dir);
					const keep = new Set(newest.map((a) => a.turnId));
					// A never-dispatched turn is charged nothing, so it may go at any age; a dispatched one only after the budget window.
					scan((a, neverDispatched) => {
						if (keep.has(a.turnId) || (!neverDispatched && a.admittedAtMs >= nowMs - L.maxBudgetPeriodMs)) return;
						for (const kind of ["briefing", "dispatched", "admitted"])
							rm(join(this.#turnsDir, `${a.turnId}.${kind}.json`));
						removed.turns += 1;
					});
				}
			} catch {
				return removed;
			}
		}
		const proposals = this.listProposals();
		if (proposals.ok && proposals.entries.length > L.maxProposalsRetained) {
			const newestByKey = new Map<string, string>();
			for (const e of proposals.entries)
				if (!newestByKey.has(e.proposal.dedupKey)) newestByKey.set(e.proposal.dedupKey, e.proposal.proposalId);
			const prunable = proposals.entries
				.filter((e) => e.dispositions.length > 0 || newestByKey.get(e.proposal.dedupKey) !== e.proposal.proposalId)
				.reverse();
			let excess = proposals.entries.length - L.maxProposalsRetained;
			for (const e of prunable) {
				if (excess <= 0) break;
				for (const d of ENDO_ADVISORY_PROPOSAL_DISPOSITIONS_V0)
					rm(join(this.#proposalsDir, `${e.proposal.proposalId}.${d}.json`));
				rm(join(this.#proposalsDir, `${e.proposal.proposalId}.json`));
				removed.proposals += 1;
				excess -= 1;
			}
			const grounding = this.readProposalGrounding();
			if (removed.proposals > 0 && grounding.ok && grounding.exists) {
				const after = this.listProposals();
				if (after.ok) {
					const retained = new Set(after.entries.map((e) => e.proposal.proposalId));
					this.#writeProposalGrounding(new Map([...grounding.value].filter(([id]) => retained.has(id))));
				}
			}
		}
		for (const dir of [this.#dir]) {
			try {
				for (const name of readDirectoryNamesAtMostV0(dir, L.maxDirectoryEntries) ?? []) {
					if (!ATOMIC_TEMP.test(name)) continue;
					const p = join(dir, name);
					const info = lstatSync(p, { throwIfNoEntry: false });
					if (info?.isFile() === true && Date.now() - info.mtimeMs >= 60_000) rmSync(p, { force: true });
				}
			} catch {
				// best effort
			}
		}
		return removed;
	}
}
