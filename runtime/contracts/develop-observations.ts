// The DEVELOP attempt-observations service (docs/designs/develop-candidate-provenance.md): taking and recording what Git showed of a
// working tree around an attempt, and reading those records back as the attempt's provenance.
//
//   callers: the live workbench broker (before the send, after the run: adapters/pi/workbench.ts), `endo attempt observe` (the operator's
//            own process), and every attempts view (read-only)
//   DevelopObservationsServiceV0
//     |-- DevelopTasksStoreV0          READ only: the attempt's project and its registered path
//     |-- DevelopAttemptsStoreV0       READ only: the attempt must exist
//     |-- DevelopObservationsStoreV0   write-once observations under develop/observations/<attempt>/
//     `-- reader                       injected: the read-only Git state reader (adapters/git/state-observer.ts)
//
// It runs no command and changes nothing in the repository: every Git read is the revision observer's fixed, hardened list. Git is only
// ever run in a directory the CALLER chose (the launch directory, the project's registered path, or the operator's --cwd): a path inside a
// record is never used to choose where to read.

import { randomBytes } from "node:crypto";
import { ENDO_ATTEMPT_ID_PATTERN_V0 } from "../../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_OBSERVATION_LIMITS_V0,
	ENDO_DEVELOP_OBSERVATION_SCHEMA_V0,
	type EndoComparableStateV0,
	type EndoDevelopObservationV0,
	type EndoObservationResultV0,
	type EndoObservedStateV0,
	endoComparableOfV0,
	validateEndoDevelopObservationV0,
} from "../../protocol/develop-observations.ts";
import {
	ENDO_NOT_COMPARED_TEXT_V0,
	ENDO_OBSERVATION_LIMITATIONS_V0,
	ENDO_OBSERVATION_POINT_LABELS_V0,
	ENDO_OBSERVATION_VIEW_MAX_PATHS_V0,
	ENDO_PROVENANCE_NOTE_TEXT_V0,
	type EndoAttemptProvenanceViewV0,
	type EndoHeadMoveV0,
	type EndoObservationPointV0,
	type EndoObservationTriggerV0,
	type EndoObservationViewV0,
	type EndoProvenanceBasisV0,
	type EndoProvenanceNoteV0,
	type EndoStateComparisonV0,
} from "../../protocol/develop-provenance.ts";
import type { EndoDevelopReceiptV0, EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import type { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import type { DevelopObservationsStoreV0, EndoObservationsReadV0 } from "../../storage/develop-observations.ts";
import type { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { sha256HexV0 } from "./canonical-json.ts";

/**
 * What the service needs of Git, injected (the CLI gives adapters/git/state-observer.ts's `gitStateReaderV0`): observe a state, compare two,
 * and how two commits stand to each other. This module reaches no adapter.
 */
export interface DevelopObservationReaderV0 {
	observeState(directory: string, options?: { within?: boolean }): Promise<EndoObservationResultV0>;
	compare(worktree: string, a: EndoComparableStateV0, b: EndoComparableStateV0): Promise<EndoStateComparisonV0>;
	ancestry(worktree: string, from: string, to: string): Promise<{ ahead: number; descends: boolean } | null>;
}

export interface DevelopObservationsServiceOptionsV0 {
	reader: DevelopObservationReaderV0;
	/** Endophasia's version, recorded as the observer's. */
	version: string;
	now?: () => number;
	/** How long one observation may take before it is recorded as `timed-out`. Default 30 000 ms. */
	timeoutMs?: number;
}

/** One observation taken, not yet recorded. */
export interface DevelopTakenObservationV0 {
	startedAtMs: number;
	endedAtMs: number;
	result: EndoObservationResultV0;
}

export type DevelopObservationRefusalV0 = "bad-request" | "not-found" | "unreadable" | "limit" | "storage-failed";

export type DevelopObservationRecordResultV0 =
	| { ok: true; observation: EndoDevelopObservationV0 }
	| { ok: false; code: DevelopObservationRefusalV0 };

/**
 * The reads one response shares: the attempts file and each attempt's observations, read at most once. Not a cache across responses: a
 * snapshot is made for one answer and dropped, so nothing it holds outlives the answer it was read for.
 */
export interface DevelopObservationsSnapshotV0 {
	attempts?: ReturnType<DevelopAttemptsStoreV0["read"]>;
	readonly reads: Map<string, EndoObservationsReadV0>;
}

export function developObservationsSnapshotV0(): DevelopObservationsSnapshotV0 {
	return { reads: new Map() };
}

export class DevelopObservationsServiceV0 {
	readonly #tasks: DevelopTasksStoreV0;
	readonly #attempts: DevelopAttemptsStoreV0;
	readonly #store: DevelopObservationsStoreV0;
	readonly #o: DevelopObservationsServiceOptionsV0;
	readonly #now: () => number;

	constructor(
		tasks: DevelopTasksStoreV0,
		attempts: DevelopAttemptsStoreV0,
		store: DevelopObservationsStoreV0,
		options: DevelopObservationsServiceOptionsV0,
	) {
		this.#tasks = tasks;
		this.#attempts = attempts;
		this.#store = store;
		this.#o = options;
		this.#now = options.now ?? Date.now;
	}

	get reader(): DevelopObservationReaderV0 {
		return this.#o.reader;
	}

	get store(): DevelopObservationsStoreV0 {
		return this.#store;
	}

	/** Observe the tree at `directory` now. Nothing is recorded. Bounded in time: past it, `timed-out` (what Git was doing is abandoned). */
	async take(directory: string, options: { within?: boolean } = {}): Promise<DevelopTakenObservationV0> {
		const startedAtMs = this.#now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<EndoObservationResultV0>((resolve) => {
			timer = setTimeout(() => resolve({ state: "unavailable", reason: "timed-out" }), this.#o.timeoutMs ?? 30_000);
			timer.unref?.();
		});
		const result = await Promise.race([
			this.#o.reader
				.observeState(directory, options)
				.catch((): EndoObservationResultV0 => ({ state: "unavailable", reason: "git-failed" })),
			timeout,
		]);
		clearTimeout(timer);
		return { startedAtMs, endedAtMs: Math.max(startedAtMs, this.#now()), result };
	}

	/** The attempt's project id and registered path, read now. */
	#attempt(
		attemptId: string,
	): { ok: true; projectId: string; path: string | null } | { ok: false; code: DevelopObservationRefusalV0 } {
		if (!ENDO_ATTEMPT_ID_PATTERN_V0.test(attemptId)) return { ok: false, code: "bad-request" };
		const read = this.#attempts.read();
		if (!read.ok) return { ok: false, code: "unreadable" };
		const entry = read.entries.find((e) => e.attempt.id === attemptId);
		if (entry === undefined) return { ok: false, code: "not-found" };
		const tasks = this.#tasks.read();
		const project = tasks.ok ? tasks.file.projects.find((p) => p.id === entry.attempt.projectId) : undefined;
		return { ok: true, projectId: entry.attempt.projectId, path: project?.path ?? null };
	}

	/** Record one taken observation for an attempt, once. */
	record(
		attemptId: string,
		input: {
			point: EndoObservationPointV0;
			trigger: EndoObservationTriggerV0;
			binding: EndoDevelopObservationV0["binding"];
			taken: DevelopTakenObservationV0;
		},
	): DevelopObservationRecordResultV0 {
		const attempt = this.#attempt(attemptId);
		if (!attempt.ok) return attempt;
		const existing = this.#store.read(attemptId);
		if (!existing.ok) return { ok: false, code: "unreadable" };
		if (existing.observations.length + existing.problems.length >= ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxPerAttempt)
			return { ok: false, code: "limit" };
		let observation: EndoDevelopObservationV0;
		try {
			observation = validateEndoDevelopObservationV0(
				{
					schemaVersion: ENDO_DEVELOP_OBSERVATION_SCHEMA_V0,
					id: `endo.observation.${randomBytes(16).toString("hex")}`,
					attemptId,
					projectId: attempt.projectId,
					point: input.point,
					trigger: input.trigger,
					recordedBy: input.point === "operator" ? "cli" : "workbench",
					binding: input.binding,
					observer: { tool: "endo", version: this.#o.version },
					startedAtMs: input.taken.startedAtMs,
					endedAtMs: input.taken.endedAtMs,
					result: input.taken.result,
				},
				sha256HexV0,
			);
		} catch {
			return { ok: false, code: "bad-request" };
		}
		const written = this.#store.write(observation);
		return written === "created" ? { ok: true, observation } : { ok: false, code: "storage-failed" };
	}

	/**
	 * The operator's `endo attempt observe`: observe the attempt's project's registered directory, or `cwd` (a working tree of the same
	 * repository), and record it as the operator's. An observation in another repository is refused, not recorded.
	 */
	async observeForOperator(
		attemptId: string,
		cwd?: string,
	): Promise<DevelopObservationRecordResultV0 | { ok: false; code: "other-repository" | "no-project" }> {
		const attempt = this.#attempt(attemptId);
		if (!attempt.ok) return attempt;
		if (attempt.path === null) return { ok: false, code: "no-project" };
		const taken = await this.take(cwd ?? attempt.path, { within: true });
		if (cwd !== undefined && taken.result.state === "observed") {
			const home = await this.take(attempt.path, { within: true });
			if (home.result.state !== "observed" || home.result.repository.commonDir !== taken.result.repository.commonDir)
				return { ok: false, code: "other-repository" };
		}
		return this.record(attemptId, { point: "operator", trigger: "operator-command", binding: null, taken });
	}

	read(attemptId: string): EndoObservationsReadV0 {
		return this.#store.read(attemptId);
	}

	/** An attempt's observations, read once per snapshot. */
	#read(attemptId: string, snapshot: DevelopObservationsSnapshotV0 | undefined): EndoObservationsReadV0 {
		if (snapshot === undefined) return this.#store.read(attemptId);
		let read = snapshot.reads.get(attemptId);
		if (read === undefined) {
			read = this.#store.read(attemptId);
			snapshot.reads.set(attemptId, read);
		}
		return read;
	}

	/** Whether there is anything to read for this attempt (an observation, a problem, or a directory that cannot be read). */
	has(attemptId: string, snapshot?: DevelopObservationsSnapshotV0): boolean {
		const read = this.#read(attemptId, snapshot);
		return !read.ok || read.observations.length + read.problems.length > 0;
	}

	/**
	 * One attempt's provenance, read now: its observations, compared with `now` (the reader's own directory, observed by the caller) and with
	 * the commits its receipts ran at. Null when the attempt is not in the store. Other attempts of the same project are read for overlaps.
	 * A caller building several attempts' provenance in one response passes one snapshot, so each directory is read once, not once per
	 * attempt (Codex, #140).
	 */
	async provenance(
		attemptId: string,
		now: DevelopTakenObservationV0 | null,
		receipts: readonly EndoDevelopReceiptV0[] | null,
		snapshot?: DevelopObservationsSnapshotV0,
	): Promise<EndoAttemptProvenanceViewV0 | null> {
		if (snapshot !== undefined) snapshot.attempts ??= this.#attempts.read();
		const read = snapshot?.attempts ?? this.#attempts.read();
		if (!read.ok) return null;
		const entry = read.entries.find((e) => e.attempt.id === attemptId);
		if (entry === undefined) return null;
		const others: { attemptId: string; observations: EndoDevelopObservationV0[] }[] = [];
		for (const other of read.entries) {
			if (other.attempt.id === attemptId || other.attempt.projectId !== entry.attempt.projectId) continue;
			const seen = this.#read(other.attempt.id, snapshot);
			if (seen.ok && seen.observations.length > 0)
				others.push({ attemptId: other.attempt.id, observations: seen.observations });
		}
		return endoAttemptProvenanceV0({
			reader: this.#o.reader,
			authorized:
				entry.authorized === null
					? null
					: {
							proposalId: entry.authorized.proposalId,
							authorizationEventId: entry.authorized.authorizationEventId,
						},
			read: this.#read(attemptId, snapshot),
			now,
			receipts,
			others,
		});
	}
}

/** What a receipts reader compares with, from an observed state: the same observation, so a page never mixes two reads of "now". */
export function endoReceiptCurrentOfV0(taken: DevelopTakenObservationV0 | null): EndoReceiptCurrentV0 | null {
	if (taken === null || taken.result.state !== "observed") return null;
	const s = taken.result;
	return {
		worktree: s.repository.worktree,
		commonDir: s.repository.commonDir,
		commit: s.revision.commit,
		clean: s.changes.length === 0 && !s.truncated && !s.flaggedEntries && !s.submodule,
	};
}

// ---- reading ----------------------------------------------------------------------------------------------------------------------

/** The input of one attempt's provenance: the records as read, and what the reader observed of ITS OWN directory now. */
export interface EndoProvenanceInputV0 {
	reader: DevelopObservationReaderV0;
	/** The attempt's authorisation's send, if it was authorised. */
	authorized: { proposalId: string; authorizationEventId: string } | null;
	read: EndoObservationsReadV0;
	/** The reader's working tree, observed now (null: the reader did not observe one). Git is run only there. */
	now: DevelopTakenObservationV0 | null;
	/** The attempt's receipts as read, or null when they could not be. */
	receipts: readonly EndoDevelopReceiptV0[] | null;
	/** Other attempts' observations, for overlapping frames. */
	others: readonly { attemptId: string; observations: readonly EndoDevelopObservationV0[] }[];
}

const bySecond = (a: EndoDevelopObservationV0, b: EndoDevelopObservationV0): number =>
	a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : 1);

function viewOf(
	o: EndoDevelopObservationV0,
	authorized: EndoProvenanceInputV0["authorized"],
	hereWorktree: string | null,
): EndoObservationViewV0 {
	const bound =
		o.binding === null
			? null
			: authorized !== null &&
					o.binding.proposalId === authorized.proposalId &&
					o.binding.authorizationEventId === authorized.authorizationEventId
				? ("this-send" as const)
				: ("other-send" as const);
	if (o.result.state === "unavailable")
		return {
			id: o.id,
			point: o.point,
			trigger: o.trigger,
			startedAtMs: o.startedAtMs,
			endedAtMs: o.endedAtMs,
			bound,
			state: "unavailable",
			reason: o.result.reason,
			commit: null,
			branch: null,
			here: null,
			changed: 0,
			complete: false,
			truncated: false,
			paths: [],
		};
	const s = o.result;
	return {
		id: o.id,
		point: o.point,
		trigger: o.trigger,
		startedAtMs: o.startedAtMs,
		endedAtMs: o.endedAtMs,
		bound,
		state: "observed",
		reason: null,
		commit: s.revision.commit,
		branch: s.revision.branch,
		here: hereWorktree === null ? null : s.repository.worktree === hereWorktree,
		changed: s.changes.length,
		complete: s.complete,
		truncated: s.truncated,
		paths: s.changes
			.slice(0, ENDO_OBSERVATION_VIEW_MAX_PATHS_V0)
			.map((c) => ({ path: c.path, areas: [...c.areas], content: c.content.kind })),
	};
}

const observedOf = (o: EndoDevelopObservationV0): EndoObservedStateV0 | null =>
	o.result.state === "observed" ? o.result : null;

/** The attempt's provenance as a reader shows it. Git is run only in the reader's own directory, and only when it is the same repository. */
export async function endoAttemptProvenanceV0(input: EndoProvenanceInputV0): Promise<EndoAttemptProvenanceViewV0> {
	const empty = (state: EndoAttemptProvenanceViewV0["state"]): EndoAttemptProvenanceViewV0 => ({
		state,
		observations: [],
		basis: null,
		start: null,
		end: null,
		head: null,
		span: null,
		now: null,
		checked: [],
		overlaps: [],
		notes: input.authorized !== null && state === "none" ? ["authorized-without-before"] : [],
	});
	if (!input.read.ok) return empty("unreadable");
	// Two writers can both pass the count check before either links its record (the limit is checked before writing, not enforced
	// atomically), so a directory can hold more than the limit. The earliest are used, the rest named in a note, so a successful write can
	// never make the page refuse the attempts answer (Codex, #140).
	const sorted = [...input.read.observations].sort(bySecond);
	const all = sorted.slice(0, ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxPerAttempt);
	const nowState = input.now?.result.state === "observed" ? input.now.result : null;
	const views = all.map((o) => viewOf(o, input.authorized, nowState?.repository.worktree ?? null));
	const notes = new Set<EndoProvenanceNoteV0>();
	if (input.read.problems.length > 0) notes.add("problems");
	if (sorted.length > all.length) notes.add("over-limit");
	if (all.length === 0) {
		const none = empty("none");
		return { ...none, notes: [...new Set([...none.notes, ...notes])] };
	}
	if (views.some((v) => v.bound === "other-send")) notes.add("other-send-observations");
	if (all.some((o) => o.result.state === "unavailable")) notes.add("observation-unavailable");

	const thisSend = (o: EndoDevelopObservationV0, i: number) =>
		views[i]?.bound === "this-send" && o.result.state === "observed";
	const before = all.find((o, i) => o.point === "before-send" && thisSend(o, i)) ?? null;
	const after =
		[...all]
			.reverse()
			.find(
				(o) =>
					o.point === "after-run" &&
					thisSend(o, all.indexOf(o)) &&
					(before === null || o.startedAtMs >= before.endedAtMs),
			) ?? null;
	const operator = all.filter((o) => o.point === "operator" && o.result.state === "observed");
	if (input.authorized !== null && before === null) notes.add("authorized-without-before");

	let basis: EndoProvenanceBasisV0;
	let start: EndoDevelopObservationV0 | null;
	let end: EndoDevelopObservationV0 | null;
	if (after?.trigger === "workbench-closing") notes.add("run-end-not-observed");
	if (before !== null && after !== null) [basis, start, end] = ["send-and-run", before, after];
	else if (before !== null) {
		notes.add("no-after-run");
		const later = operator.filter((o) => o.startedAtMs >= before.endedAtMs).at(-1) ?? null;
		[basis, start, end] = later === null ? ["send-only", before, null] : ["send-and-operator", before, later];
	} else if (after !== null) [basis, start, end] = ["run-only", null, after];
	else if (operator.length > 0) {
		// The latest operator observation that began after the first had ended: two that overlap (run at once) cannot frame anything.
		const first = operator[0] as EndoDevelopObservationV0;
		const last = operator.filter((o) => o !== first && o.startedAtMs >= first.endedAtMs).at(-1) ?? null;
		[basis, start, end] = ["operator", first, last];
	} else
		return {
			...empty("observed"),
			observations: views,
			notes: ORDER.filter((n) => notes.has(n)),
		};

	const s = start === null ? null : observedOf(start);
	const e = end === null ? null : observedOf(end);
	const latest = e ?? s;
	// Git is run only in the reader's own directory, and only when it holds the same repository as the observations.
	const dir =
		nowState !== null && latest !== null && nowState.repository.commonDir === latest.repository.commonDir
			? nowState.repository.worktree
			: null;
	if (latest !== null && nowState !== null && nowState.repository.worktree !== latest.repository.worktree)
		notes.add("frame-elsewhere");
	const unavailableHere: EndoStateComparisonV0 = {
		relation: "not-compared",
		reason: nowState === null ? "unavailable" : "other-repository",
	};
	const headMove = async (from: string, to: string): Promise<EndoHeadMoveV0> => {
		if (from === to) return { from, to, ahead: 0, descends: true };
		const a = dir === null ? null : await input.reader.ancestry(dir, from, to);
		return { from, to, ahead: a?.ahead ?? null, descends: a?.descends ?? null };
	};
	const compare = async (a: EndoComparableStateV0, b: EndoComparableStateV0): Promise<EndoStateComparisonV0> =>
		dir === null ? unavailableHere : input.reader.compare(dir, a, b);

	let head: EndoHeadMoveV0 | null = null;
	let span: EndoStateComparisonV0 | null = null;
	if (s !== null && e !== null) {
		head = await headMove(s.revision.commit, e.revision.commit);
		span = await compare(endoComparableOfV0(s), endoComparableOfV0(e));
	}

	let now: EndoAttemptProvenanceViewV0["now"] = null;
	if (latest !== null && input.now !== null) {
		now =
			nowState === null
				? {
						observedAtMs: input.now.startedAtMs,
						commit: null,
						head: null,
						comparison: { relation: "not-compared", reason: "unavailable" },
					}
				: {
						observedAtMs: input.now.startedAtMs,
						commit: nowState.revision.commit,
						head: dir === null ? null : await headMove(latest.revision.commit, nowState.revision.commit),
						comparison: await compare(endoComparableOfV0(latest), endoComparableOfV0(nowState)),
					};
	}

	const checked: EndoAttemptProvenanceViewV0["checked"] = [];
	if (latest !== null && input.receipts !== null) {
		const counts = new Map<string, { receipts: number; last: number }>();
		for (const r of input.receipts) {
			if (r.repository.commonDir !== latest.repository.commonDir) continue;
			const c = counts.get(r.revision.commit) ?? { receipts: 0, last: 0 };
			counts.set(r.revision.commit, { receipts: c.receipts + 1, last: Math.max(c.last, r.startedAtMs) });
		}
		const commits = [...counts.entries()].sort((x, y) => y[1].last - x[1].last || (x[0] < y[0] ? -1 : 1)).slice(0, 4);
		for (const [commit, c] of commits)
			checked.push({
				commit,
				receipts: c.receipts,
				// A receipt's commit was observed clean and committed: it is the commit, with nothing over it.
				comparison: await compare(endoComparableOfV0(latest), {
					commonDir: latest.repository.commonDir,
					commit,
					changes: [],
					complete: true,
				}),
			});
	}

	const overlaps: string[] = [];
	const frameFrom = start?.startedAtMs ?? end?.startedAtMs ?? 0;
	const frameTo = (end ?? start)?.endedAtMs ?? 0;
	const worktree = latest?.repository.worktree ?? null;
	if (start !== null && end !== null && worktree !== null)
		for (const other of input.others)
			if (
				other.observations.some(
					(o) =>
						o.result.state === "observed" &&
						o.result.repository.worktree === worktree &&
						o.endedAtMs >= frameFrom &&
						o.startedAtMs <= frameTo,
				)
			)
				overlaps.push(other.attemptId);

	return {
		state: "observed",
		observations: views,
		basis,
		start: start?.id ?? null,
		end: end?.id ?? null,
		head,
		span,
		now,
		checked,
		overlaps: overlaps.sort(),
		notes: ORDER.filter((n) => notes.has(n)),
	};
}

const ORDER: readonly EndoProvenanceNoteV0[] = [
	"authorized-without-before",
	"no-after-run",
	"observation-unavailable",
	"other-send-observations",
	"frame-elsewhere",
	"run-end-not-observed",
	"over-limit",
	"problems",
];

// ---- the terminal's words -------------------------------------------------------------------------------------------------------------

const short = (commit: string): string => commit.slice(0, 12);
const at = (ms: number): string => new Date(ms).toISOString();
/** A path as the terminal shows it: control and direction characters replaced, so a name cannot rewrite the line it is on. */
const shown = (path: string): string =>
	path.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "\ufffd");
const LETTER = { added: "A", deleted: "D", modified: "M", mode: "T" } as const;

/** One comparison in words. `what` names the other side ("the observation when the run had ended"). */
export function endoComparisonWordsV0(c: EndoStateComparisonV0, max = 8): string {
	if (c.relation === "same") return "same content";
	if (c.relation === "not-compared") return `not compared: ${ENDO_NOT_COMPARED_TEXT_V0[c.reason]}`;
	const listed = c.paths
		.slice(0, max)
		.map((p) => `${LETTER[p.change]} ${shown(p.path)}`)
		.join(", ");
	return `${c.total} path${c.total === 1 ? " differs" : "s differ"}: ${listed}${c.total > max ? ", \u2026" : ""}`;
}

export function endoHeadMoveWordsV0(h: EndoHeadMoveV0): string {
	if (h.from === h.to) return `HEAD stayed at ${short(h.from)}`;
	const how =
		h.descends === true
			? `${h.ahead} commit${h.ahead === 1 ? "" : "s"} on from it`
			: h.descends === false
				? "not a descendant of it (history was rewritten or another branch was checked out)"
				: "its relation unknown";
	return `HEAD moved from ${short(h.from)} to ${short(h.to)}, ${how}`;
}

const BASIS_TEXT: Readonly<Record<EndoProvenanceBasisV0, string>> = {
	"send-and-run":
		"just before the brief was sent, and after the run that followed (when it ended, or as the workbench closed)",
	"send-only": "just before the brief was sent (nothing observed since)",
	"send-and-operator": "just before the brief was sent, and your latest observation since",
	"run-only": "when the run had ended (nothing observed before the send)",
	operator: "your first and latest observations (they say nothing about when the work happened)",
};

/** The provenance as plain text for the terminal (stderr). */
export function renderEndoProvenanceV0(p: EndoAttemptProvenanceViewV0): string {
	const lines = ["provenance: what Git showed of the working tree around this attempt; not who changed it"];
	if (p.state === "unreadable")
		lines.push("  [unavailable] the observations directory could not be read; there may be observations");
	if (p.state === "none") lines.push("  [none] no observation is recorded for this attempt");
	for (const o of p.observations) {
		const role = o.id === p.start ? "start " : o.id === p.end ? "end   " : "      ";
		const what =
			o.state === "unavailable"
				? `not observed (${o.reason})`
				: `HEAD ${short(o.commit as string)}${o.branch === null ? " (detached)" : ` (${shown(o.branch)})`}, ${
						o.changed === 0 ? "no changes" : `${o.changed} changed path${o.changed === 1 ? "" : "s"}`
					}${o.complete ? "" : ", incomplete"}${o.here === false ? ", in another working tree" : ""}`;
		lines.push(
			`  ${role}  ${at(o.startedAtMs)}  ${ENDO_OBSERVATION_POINT_LABELS_V0[o.point]}${o.bound === "other-send" ? " [another send: not used]" : ""}: ${what}`,
		);
	}
	if (p.basis !== null) lines.push(`  frame   ${BASIS_TEXT[p.basis]}`);
	if (p.head !== null) lines.push(`  between ${endoHeadMoveWordsV0(p.head)}`);
	if (p.span !== null) lines.push(`  between ${endoComparisonWordsV0(p.span)}`);
	if (p.now !== null)
		lines.push(
			`  now     read ${at(p.now.observedAtMs)}${p.now.head === null ? "" : `; ${endoHeadMoveWordsV0(p.now.head)}`}; against the ${
				p.end === null ? "start" : "end"
			}: ${endoComparisonWordsV0(p.now.comparison)}`,
		);
	for (const c of p.checked)
		lines.push(
			`  checked ${short(c.commit)} (${c.receipts} receipt${c.receipts === 1 ? "" : "s"}) against the ${p.end === null ? "start" : "end"}: ${endoComparisonWordsV0(c.comparison)}`,
		);
	if (p.overlaps.length > 0)
		lines.push(
			`  overlap other attempts were observed in this working tree within this frame: ${p.overlaps.join(", ")}`,
		);
	for (const n of p.notes) lines.push(`  note    ${ENDO_PROVENANCE_NOTE_TEXT_V0[n]}`);
	for (const l of ENDO_OBSERVATION_LIMITATIONS_V0) lines.push(`  limit   ${l}`);
	return `${lines.join("\n")}\n`;
}
