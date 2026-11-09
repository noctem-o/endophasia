// Candidate provenance (docs/designs/develop-candidate-provenance.md): what Git showed of the working tree around an attempt, recorded once,
// and compared later with the tree now and with the commits checks ran at. Real Git repositories throughout; no model, no network.
//
//   1. the state: blob ids as Git computes them, every area, links, deletions, unreadable and oversized files, ignored files left out
//   2. comparing: an uncommitted state and the commit made from it are the same; one more change is not; nothing is claimed when incomplete
//   3. the record: closed validation, derived facts re-derived, the points' shapes
//   4. the service: the operator's observation, its refusals and bounds
//   5. the read model: which observations frame the attempt, and why; Git only in the reader's own directory; overlaps
//   6. the broker: observed just before the send and when the run settles; never a gate; nothing after a refusal; the gate re-checked
//   7. the page's gate: forgeries refused, words equal to the protocol's
import {
	chmodSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { compareEndoStatesV0, gitStateReaderV0, observeEndoStateV0 } from "../adapters/git/state-observer.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import {
	ENDO_DEVELOP_OBSERVATION_LIMITS_V0,
	ENDO_DEVELOP_OBSERVATION_SCHEMA_V0,
	type EndoDevelopObservationV0,
	type EndoObservationResultV0,
	type EndoObservedStateV0,
	endoComparableOfV0,
	endoObservedStateDigestTextV0,
	validateEndoDevelopObservationV0,
} from "../protocol/develop-observations.ts";
import {
	ENDO_NOT_COMPARED_TEXT_V0,
	ENDO_OBSERVATION_LIMITATIONS_V0,
	ENDO_OBSERVATION_POINT_LABELS_V0,
	ENDO_OBSERVATION_TRIGGER_TEXT_V0,
	ENDO_OBSERVATION_UNAVAILABLE_V0,
	ENDO_PROVENANCE_NOTE_TEXT_V0,
	type EndoAttemptProvenanceViewV0,
} from "../protocol/develop-provenance.ts";
import type { EndoDevelopReceiptV0 } from "../protocol/develop-receipts.ts";
import { sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import {
	type DevelopObservationReaderV0,
	DevelopObservationsServiceV0,
	type DevelopTakenObservationV0,
	endoAttemptProvenanceV0,
	renderEndoProvenanceV0,
} from "../runtime/contracts/develop-observations.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopObservationsStoreV0 } from "../storage/develop-observations.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { relationAgrees } from "../studio-ui/src/model/attempts-wire.ts";
import {
	NOT_COMPARED_TEXT,
	OBSERVATION_LIMITATIONS,
	OBSERVATION_POINT_LABELS,
	OBSERVATION_TRIGGER_TEXT,
	OBSERVATION_UNAVAILABLE,
	PROVENANCE_NOTE_TEXT,
	provenance_,
	provenanceCoherent,
	shownPath,
} from "../studio-ui/src/model/provenance-wire.ts";
import { cleanGitFixtures, commitedRepo, fixtureDir, git, haveGit, write } from "./git-fixtures.ts";
import { Approval, FakeSession, settle } from "./workbench-fixtures.ts";

afterAll(() => cleanGitFixtures());

const observer = new GitRevisionObserverV0();
const reader = gitStateReaderV0(observer);
const observed = async (dir: string): Promise<EndoObservedStateV0> => {
	const r = await observeEndoStateV0(observer, dir);
	if (r.state !== "observed") throw new Error(`not observed: ${r.reason}`);
	return r;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const clean = (s: EndoObservedStateV0, commit: string) => ({
	commonDir: s.repository.commonDir,
	commit,
	changes: [],
	complete: true,
});

describe.skipIf(!haveGit)("the observed state", () => {
	it("holds HEAD and, for every changed path, the blob id Git would store and the areas Git listed it in", async () => {
		const root = commitedRepo();
		write(root, "a.txt", "one\nTWO\n");
		git(root, "add", "a.txt");
		write(root, "a.txt", "one\nTWO\nthree\n"); // staged AND changed again: one path, two areas, the working tree's content
		rmSync(join(root, "gone.txt"));
		write(root, "new file.txt", "fresh\n");
		write(root, "run.sh", "#!/bin/sh\n", 0o755);
		symlinkSync("a.txt", join(root, "link"));
		write(root, ".gitignore", "*.log\n");
		write(root, "debug.log", "ignored\n");
		const s = await observed(root);
		expect(s.revision.commit).toBe(git(root, "rev-parse", "HEAD").trim());
		expect(s.revision.branch).toBe("refs/heads/main");
		const by = new Map(s.changes.map((c) => [c.path, c]));
		expect([...by.keys()]).toEqual([".gitignore", "a.txt", "gone.txt", "link", "new file.txt", "run.sh"]);
		expect(by.get("a.txt")).toEqual({
			path: "a.txt",
			areas: ["staged", "unstaged"],
			content: { kind: "file", mode: "100644", oid: git(root, "hash-object", "a.txt").trim() },
		});
		expect(by.get("gone.txt")?.content).toEqual({ kind: "absent" });
		expect(by.get("run.sh")?.content).toMatchObject({ kind: "file", mode: "100755" });
		// A link's blob is its target, as Git stores it, and it is never followed.
		expect(by.get("link")?.content).toEqual({ kind: "file", mode: "120000", oid: gitBlob(root, "a.txt") });
		// Ignored files are not part of the state.
		expect(by.has("debug.log")).toBe(false);
		expect(s.complete).toBe(true);
		expect(s.digest).toBe(sha256HexV0(endoObservedStateDigestTextV0(s)));
		// The record holds no content: only ids, modes and names.
		expect(JSON.stringify(s)).not.toContain("TWO");
	});

	it("is incomplete, never guessed, when a file is too large to read, is not a file, or hides index entries", async () => {
		const root = commitedRepo();
		const big = join(root, "big.bin");
		writeFileSync(big, "");
		truncateSync(big, ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxFileBytes + 1);
		const s = await observed(root);
		expect(s.changes.find((c) => c.path === "big.bin")?.content).toEqual({ kind: "not-read", why: "too-large" });
		expect(s.complete).toBe(false);

		const nested = commitedRepo();
		const inner = join(nested, "vendor");
		mkdirSync(inner);
		git(inner, "init", "-q");
		write(inner, "x", "x\n");
		const n = await observed(nested);
		expect(n.changes.find((c) => c.path === "vendor")?.content).toEqual({ kind: "not-read", why: "not-a-file" });
		expect(n.complete).toBe(false);

		const flagged = commitedRepo();
		git(flagged, "update-index", "--assume-unchanged", "a.txt");
		const f = await observed(flagged);
		expect(f.flaggedEntries).toBe(true);
		expect(f.complete).toBe(false);
	});

	it("is unavailable, with the observer's reason, outside a repository", async () => {
		const dir = fixtureDir("plain");
		expect(await observeEndoStateV0(observer, dir)).toEqual({ state: "unavailable", reason: "not-a-repository" });
	});

	it("reads an unreadable file as not read", async () => {
		if (process.getuid?.() === 0) return; // root reads everything
		const root = commitedRepo();
		write(root, "secret.txt", "s\n");
		chmodSync(join(root, "secret.txt"), 0o000);
		const s = await observed(root);
		chmodSync(join(root, "secret.txt"), 0o644);
		expect(s.changes.find((c) => c.path === "secret.txt")?.content).toEqual({ kind: "not-read", why: "unreadable" });
	});
});

function gitBlob(root: string, target: string): string {
	// The blob of a link is its target's NAME: hash that text the way Git does.
	writeFileSync(join(root, ".target-name"), target);
	const id = git(root, "hash-object", ".target-name").trim();
	rmSync(join(root, ".target-name"));
	return id;
}

describe.skipIf(!haveGit)("comparing two states", () => {
	it("an uncommitted state and the commit made from it hold the same content; one more change is a difference", async () => {
		const root = commitedRepo();
		const before = await observed(root);
		write(root, "a.txt", "changed\n");
		rmSync(join(root, "gone.txt"));
		git(root, "mv", "old.txt", "moved.txt");
		write(root, "added.txt", "new\n");
		const after = await observed(root);
		const span = await compareEndoStatesV0(observer, root, endoComparableOfV0(before), endoComparableOfV0(after));
		expect(span).toEqual({
			relation: "different",
			paths: [
				{ path: "a.txt", change: "modified" },
				{ path: "added.txt", change: "added" },
				{ path: "gone.txt", change: "deleted" },
				{ path: "moved.txt", change: "added" },
				{ path: "old.txt", change: "deleted" },
			],
			total: 5,
		});
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "the work");
		const commit = git(root, "rev-parse", "HEAD").trim();
		// The commit holds exactly what was observed: the claim a check at that commit can be related to.
		expect(await compareEndoStatesV0(observer, root, endoComparableOfV0(after), clean(after, commit))).toEqual({
			relation: "same",
		});
		// A commit with one more change, made before committing, is not the observed state, and the path says where.
		write(root, "extra.txt", "slipped in\n");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "more");
		const more = git(root, "rev-parse", "HEAD").trim();
		expect(await compareEndoStatesV0(observer, root, endoComparableOfV0(after), clean(after, more))).toEqual({
			relation: "different",
			paths: [{ path: "extra.txt", change: "added" }],
			total: 1,
		});
		// A mode change alone is a difference of its own.
		chmodSync(join(root, "a.txt"), 0o755);
		const moded = await observed(root);
		expect(await compareEndoStatesV0(observer, root, clean(moded, more), endoComparableOfV0(moded))).toEqual({
			relation: "different",
			paths: [{ path: "a.txt", change: "mode" }],
			total: 1,
		});
	});

	it("claims nothing for an incomplete state, another repository, or a commit Git does not have", async () => {
		const root = commitedRepo();
		const s = await observed(root);
		const incomplete = { ...endoComparableOfV0(s), complete: false };
		expect(await compareEndoStatesV0(observer, root, incomplete, endoComparableOfV0(s))).toEqual({
			relation: "not-compared",
			reason: "incomplete",
		});
		expect(
			await compareEndoStatesV0(observer, root, endoComparableOfV0(s), {
				...endoComparableOfV0(s),
				commonDir: "/elsewhere/.git",
			}),
		).toEqual({ relation: "not-compared", reason: "other-repository" });
		expect(await compareEndoStatesV0(observer, root, endoComparableOfV0(s), clean(s, "0".repeat(40)))).toEqual({
			relation: "not-compared",
			reason: "commit-unavailable",
		});
	});
});

// ---- the record --------------------------------------------------------------------------------------------------------------------

const A = `endo.attempt.${"a".repeat(32)}`;
const B = `endo.attempt.${"b".repeat(32)}`;
const P = `endo.project.${"c".repeat(32)}`;
const PROPOSAL = `endo.evidence.workbench-prompt-${"d".repeat(32)}`;

function record(
	result: EndoObservationResultV0,
	over: Partial<EndoDevelopObservationV0> = {},
	n = 1,
): EndoDevelopObservationV0 {
	return {
		schemaVersion: ENDO_DEVELOP_OBSERVATION_SCHEMA_V0,
		id: `endo.observation.${String(n).padStart(32, "0")}`,
		attemptId: A,
		projectId: P,
		point: "operator",
		trigger: "operator-command",
		recordedBy: "cli",
		binding: null,
		observer: { tool: "endo", version: "0.1.0" },
		startedAtMs: 1000 * n,
		endedAtMs: 1000 * n + 10,
		result,
		...over,
	};
}

describe.skipIf(!haveGit)("the observation record", () => {
	it("is closed, and its derived facts must follow from its state", async () => {
		const root = commitedRepo();
		write(root, "a.txt", "x\n");
		const s = await observed(root);
		const r = record(s);
		expect(validateEndoDevelopObservationV0(JSON.parse(JSON.stringify(r)), sha256HexV0)).toEqual(r);
		const bad = (mutate: (v: Record<string, unknown> & { result: Record<string, unknown> }) => void) => {
			const v = JSON.parse(JSON.stringify(r));
			mutate(v);
			return () => validateEndoDevelopObservationV0(v, sha256HexV0);
		};
		expect(
			bad((v) => {
				v.extra = 1;
			}),
		).toThrow(/unknown member/);
		expect(
			bad((v) => {
				v.result.digest = "0".repeat(64);
			}),
		).toThrow(/digest/);
		expect(
			bad((v) => {
				v.result.complete = false;
			}),
		).toThrow(/complete/);
		expect(
			bad((v) => {
				(v.result.changes as { path: string }[])[0]!.path = "../escape";
			}),
		).toThrow(/relative path/);
		expect(
			bad((v) => {
				(v.result.changes as { path: string }[])[0]!.path = "/abs";
			}),
		).toThrow(/relative path/);
		expect(
			bad((v) => {
				(v.result.changes as { content: Record<string, string> }[])[0]!.content.oid = "a".repeat(64);
			}),
		).toThrow(/oid/);
		expect(
			bad((v) => {
				(v.result.changes as { areas: string[] }[])[0]!.areas = ["unstaged", "staged"];
			}),
		).toThrow(/order/);
		// The workbench's points carry the send they were made for; the operator's carry none.
		expect(
			bad((v) => {
				v.point = "before-send";
			}),
		).toThrow(/trigger/);
		expect(
			bad((v) => Object.assign(v, { point: "before-send", trigger: "send-approved", recordedBy: "workbench" })),
		).toThrow(/binding/);
		expect(
			bad((v) => {
				v.binding = { proposalId: PROPOSAL, authorizationEventId: "x" };
			}),
		).toThrow(/binding/);
		expect(
			bad((v) => {
				v.endedAtMs = 1;
			}),
		).toThrow(/before/);
		expect(() =>
			validateEndoDevelopObservationV0(record({ state: "unavailable", reason: "timed-out" }), sha256HexV0),
		).not.toThrow();
	});
});

// ---- the service ---------------------------------------------------------------------------------------------------------------------

function workspace(repo: string) {
	const root = fixtureDir("store");
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name: "demo", path: repo, observedGitRoot: null }));
	const t = ok(tasks.createTask(p.id, { title: "Fix parser", acceptance: "npm test passes" }, { select: true }));
	const attempts = new DevelopAttemptsStoreV0(root);
	const prepared = ok(new DevelopAttemptsServiceV0(tasks, attempts).prepare(p.id, t.id, { objective: "Fix it" }));
	const store = new DevelopObservationsStoreV0(root);
	const service = new DevelopObservationsServiceV0(tasks, attempts, store, { reader, version: "0.1.0-test" });
	return { root, tasks, attempts, store, service, projectId: p.id, attempt: prepared };
}

describe.skipIf(!haveGit)("the observations service", () => {
	it("records the operator's observation of the project's directory, once, and reads it back", async () => {
		const repo = commitedRepo();
		const w = workspace(repo);
		write(repo, "a.txt", "PRIVATE-CONTENT-42\n");
		const got = await w.service.observeForOperator(w.attempt.id);
		if (!got.ok) throw new Error(got.code);
		expect(got.observation).toMatchObject({ point: "operator", recordedBy: "cli", binding: null });
		const read = w.store.read(w.attempt.id);
		expect(read).toMatchObject({ ok: true, problems: [] });
		expect(read.ok && read.observations).toEqual([got.observation]);
		// Only blob ids and names are written: the file's text is not in the store.
		const dir = join(w.root, "develop", "observations", w.attempt.id);
		for (const name of readdirSync(dir))
			expect(readFileSync(join(dir, name), "utf8")).not.toContain("PRIVATE-CONTENT");
	});

	it("refuses another repository's tree, an unknown attempt, and past its bound; a file it cannot use is a problem, not an observation", async () => {
		const repo = commitedRepo();
		const w = workspace(repo);
		const other = commitedRepo();
		expect(await w.service.observeForOperator(w.attempt.id, other)).toEqual({ ok: false, code: "other-repository" });
		expect(await w.service.observeForOperator(`endo.attempt.${"0".repeat(32)}`)).toEqual({
			ok: false,
			code: "not-found",
		});
		const dir = join(w.root, "develop", "observations", w.attempt.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `endo.observation.${"e".repeat(32)}.json`), "{not json");
		const read = w.store.read(w.attempt.id);
		expect(read.ok && read.problems).toEqual([
			{ name: `endo.observation.${"e".repeat(32)}.json`, reason: "malformed" },
		]);
		for (let i = 0; i < ENDO_DEVELOP_OBSERVATION_LIMITS_V0.maxPerAttempt - 1; i++)
			writeFileSync(join(dir, `junk-${i}`), "");
		expect(await w.service.observeForOperator(w.attempt.id)).toEqual({ ok: false, code: "limit" });
	});

	it("records an observation that timed out as unavailable, never as a state", async () => {
		const repo = commitedRepo();
		const w = workspace(repo);
		const slow: DevelopObservationReaderV0 = {
			...reader,
			observeState: () => new Promise(() => {}),
		};
		const service = new DevelopObservationsServiceV0(w.tasks, w.attempts, w.store, {
			reader: slow,
			version: "0.1.0-test",
			timeoutMs: 20,
		});
		const taken = await service.take(repo);
		expect(taken.result).toEqual({ state: "unavailable", reason: "timed-out" });
	});
});

// ---- the read model ------------------------------------------------------------------------------------------------------------------

const bound = (eventId = "endo.event.x.1") => ({ proposalId: PROPOSAL, authorizationEventId: eventId });
const authorized = { proposalId: PROPOSAL, authorizationEventId: "endo.event.x.1" };
const taken = (result: EndoObservationResultV0, at = 99_000): DevelopTakenObservationV0 => ({
	startedAtMs: at,
	endedAtMs: at + 5,
	result,
});
const before = (s: EndoObservationResultV0, n = 1) =>
	record(s, { point: "before-send", trigger: "send-approved", recordedBy: "workbench", binding: bound() }, n);
const after = (s: EndoObservationResultV0, n = 2, trigger: "run-settled" | "workbench-closing" = "run-settled") =>
	record(s, { point: "after-run", trigger, recordedBy: "workbench", binding: bound() }, n);
const read = (...observations: EndoDevelopObservationV0[]) => ({ ok: true as const, observations, problems: [] });

/** A reader that notes where Git was run. */
function spying(): DevelopObservationReaderV0 & { dirs: string[] } {
	const dirs: string[] = [];
	return {
		dirs,
		observeState: reader.observeState,
		compare: (dir, a, b) => {
			dirs.push(dir);
			return reader.compare(dir, a, b);
		},
		ancestry: (dir, a, b) => {
			dirs.push(dir);
			return reader.ancestry(dir, a, b);
		},
	};
}

function receiptAt(commit: string, commonDir: string, worktree: string, n = 1): EndoDevelopReceiptV0 {
	return {
		repository: { worktree, commonDir, linked: false },
		revision: { commit, tree: "f".repeat(40), branch: "refs/heads/main" },
		startedAtMs: 50_000 + n,
	} as unknown as EndoDevelopReceiptV0;
}

describe.skipIf(!haveGit)("an attempt's provenance", () => {
	it("frames the send and the run's end, says what changed between them, and relates now and the checked commit to the end", async () => {
		const root = commitedRepo();
		const s1 = await observed(root);
		write(root, "a.txt", "fixed\n");
		write(root, "test.ts", "t\n");
		const s2 = await observed(root);
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "work");
		const commit = git(root, "rev-parse", "HEAD").trim();
		write(root, "later.txt", "after the run\n");
		const now = await observed(root);
		const spy = spying();
		const p = await endoAttemptProvenanceV0({
			reader: spy,
			authorized,
			read: read(before(s1), after(s2)),
			now: taken(now),
			receipts: [receiptAt(commit, s1.repository.commonDir, root)],
			others: [],
		});
		expect(p).toMatchObject({
			state: "observed",
			basis: "send-and-run",
			start: before(s1).id,
			end: after(s2).id,
			head: { from: s1.revision.commit, to: s1.revision.commit, ahead: 0, descends: true },
			span: {
				relation: "different",
				paths: [
					{ path: "a.txt", change: "modified" },
					{ path: "test.ts", change: "added" },
				],
				total: 2,
			},
			now: {
				commit,
				head: { from: s1.revision.commit, to: commit, ahead: 1, descends: true },
				comparison: { relation: "different", paths: [{ path: "later.txt", change: "added" }], total: 1 },
			},
			checked: [{ commit, receipts: 1, comparison: { relation: "same" } }],
			notes: [],
		});
		// Git was run only in the reader's own directory.
		expect(new Set(spy.dirs)).toEqual(new Set([root]));
		expect(provenance_(p) && provenanceCoherent(p)).toBe(true);
		const text = renderEndoProvenanceV0(p);
		expect(text).toContain("checked");
		expect(text).toContain("same content");
		expect(text).toContain("not who changed it");
	});

	it("uses only observations made for THIS attempt's send, and says what is missing", async () => {
		const root = commitedRepo();
		const s = await observed(root);
		const foreign = record(s, {
			point: "after-run",
			trigger: "run-settled",
			recordedBy: "workbench",
			binding: bound("endo.event.other.9"),
		});
		const p = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(before(s), { ...foreign, id: `endo.observation.${"9".repeat(32)}` }),
			now: null,
			receipts: null,
			others: [],
		});
		expect(p.basis).toBe("send-only");
		expect(p.end).toBeNull();
		expect(p.notes).toEqual(["no-after-run", "other-send-observations"]);
		expect(p.observations.map((o) => o.bound)).toEqual(["this-send", "other-send"]);
		expect(provenanceCoherent(p)).toBe(true);

		// An after-run observation that began before the before-send one ended cannot be that run's end: it is not used.
		const early = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(after(s, 1), before(s, 2)),
			now: null,
			receipts: null,
			others: [],
		});
		expect(early).toMatchObject({ basis: "send-only", start: before(s, 2).id, end: null });

		// Authorised with no observation from before the send (an older build, or it failed): said, never filled in.
		const q = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(after(s)),
			now: null,
			receipts: null,
			others: [],
		});
		expect(q).toMatchObject({ basis: "run-only", start: null, notes: ["authorized-without-before"] });

		// The workbench stopped before the run ended; the operator observed later: that frame, named as such.
		const r = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(before(s, 1), record(s, {}, 3)),
			now: null,
			receipts: null,
			others: [],
		});
		expect(r).toMatchObject({ basis: "send-and-operator", notes: ["no-after-run"] });

		// Without a send (a handoff to another agent): the operator's first and latest observations, which say nothing about timing.
		const o = await endoAttemptProvenanceV0({
			reader,
			authorized: null,
			read: read(record(s, {}, 1), record(s, {}, 2), record(s, {}, 3)),
			now: taken(s),
			receipts: null,
			others: [],
		});
		expect(o).toMatchObject({ basis: "operator", start: record(s, {}, 1).id, end: record(s, {}, 3).id });
		expect(o.span).toEqual({ relation: "same" });

		// Unreadable: there may be observations; nothing is claimed.
		const u = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: { ok: false, reason: "io" },
			now: null,
			receipts: null,
			others: [],
		});
		expect(u).toMatchObject({ state: "unreadable", observations: [], basis: null });
		// No observation at all, for an attempt that was authorised.
		const none = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(),
			now: null,
			receipts: null,
			others: [],
		});
		expect(none).toMatchObject({ state: "none", notes: ["authorized-without-before"] });
	});

	it("runs no Git and compares nothing when the reader's tree is another repository or could not be observed", async () => {
		const root = commitedRepo();
		const s1 = await observed(root);
		write(root, "a.txt", "x\n");
		const s2 = await observed(root);
		const elsewhere = await observed(commitedRepo());
		const spy = spying();
		const p = await endoAttemptProvenanceV0({
			reader: spy,
			authorized,
			read: read(before(s1), after(s2)),
			now: taken(elsewhere),
			receipts: [],
			others: [],
		});
		expect(spy.dirs).toEqual([]);
		expect(p.span).toEqual({ relation: "not-compared", reason: "other-repository" });
		expect(p.now?.comparison).toEqual({ relation: "not-compared", reason: "other-repository" });
		expect(p.notes).toContain("frame-elsewhere");
		const q = await endoAttemptProvenanceV0({
			reader: spy,
			authorized,
			read: read(before(s1), after(s2)),
			now: taken({ state: "unavailable", reason: "git-timeout" }),
			receipts: [],
			others: [],
		});
		expect(q.now).toMatchObject({
			commit: null,
			head: null,
			comparison: { relation: "not-compared", reason: "unavailable" },
		});
		expect(provenanceCoherent(p) && provenanceCoherent(q)).toBe(true);
	});

	it("names other attempts observed in the same tree within the frame", async () => {
		const root = commitedRepo();
		const s = await observed(root);
		const theirs = { ...record(s, { attemptId: B }, 2), startedAtMs: 1500, endedAtMs: 1600 };
		const outside = { ...record(s, { attemptId: B }, 9), startedAtMs: 90_000, endedAtMs: 90_010 };
		const p = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(before(s, 1), after(s, 3)),
			now: null,
			receipts: null,
			others: [{ attemptId: B, observations: [theirs] }],
		});
		expect(p.overlaps).toEqual([B]);
		const q = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(before(s, 1), after(s, 3)),
			now: null,
			receipts: null,
			others: [{ attemptId: B, observations: [outside] }],
		});
		expect(q.overlaps).toEqual([]);
	});
});

// ---- the broker ----------------------------------------------------------------------------------------------------------------------

const KEY = endoDigestKeyV0(Buffer.alloc(32, 7), "provenance-test");

function brokerOver(repo: string, options: { observe?: () => Promise<DevelopTakenObservationV0> } = {}) {
	const w = workspace(repo);
	const session = new FakeSession();
	const approval = new Approval();
	const dispatch = new DevelopAttemptDispatchV0(w.tasks, w.attempts, {
		projectId: w.projectId,
		launchDirectory: repo,
	});
	const calls: string[] = [];
	const broker = new WorkbenchBrokerV0({
		session,
		key: KEY,
		attachment: "pi.default",
		approver: approval.approver,
		attempts: dispatch,
		provenance: {
			take: async () => {
				calls.push("take");
				return options.observe === undefined ? w.service.take(repo) : options.observe();
			},
			record: (id, input) => {
				calls.push(`record:${input.point}:${input.trigger}`);
				return w.service.record(id, input);
			},
		},
	});
	return { ...w, session, approval, broker, calls };
}

/** Wait for a condition, not for the clock: observations take real Git reads, slower under load. */
const until = async (condition: () => boolean, ms = 20_000): Promise<void> => {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await settle(10);
	}
};

const recorded = (w: { store: DevelopObservationsStoreV0 }, id: string) => {
	const r = w.store.read(id);
	if (!r.ok) throw new Error("unreadable");
	return r.observations;
};

describe.skipIf(!haveGit)("the workbench observes around an attempt it sends", () => {
	it("just before the send, bound to its authorisation, and once when the run that followed settles", async () => {
		const repo = commitedRepo();
		const w = brokerOver(repo);
		w.broker.requestAttempt(w.attempt.id);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		await until(() => w.session.promptCalls.length === 1 && recorded(w, w.attempt.id).length === 1);
		expect(w.session.promptCalls).toEqual([renderEndoDevelopBriefV0(w.attempt)]);
		const authorizedEvent = w.session.records.find((r) => r.kind === "workbench.prompt-authorized");
		const [first] = recorded(w, w.attempt.id);
		expect(first).toMatchObject({
			point: "before-send",
			trigger: "send-approved",
			recordedBy: "workbench",
			binding: { authorizationEventId: authorizedEvent?.id },
		});
		// The work happens; Pi reports the run's start and its settle. A settle with no start (another run's) is not this run.
		w.session.live_({ type: "agent_settled", record: {} });
		await settle(50);
		expect(recorded(w, w.attempt.id)).toHaveLength(1);
		w.session.live_({ type: "agent_start", record: {} });
		write(repo, "a.txt", "the agent's work, or anyone's\n");
		w.session.live_({ type: "agent_settled", record: {} });
		await until(() => recorded(w, w.attempt.id).length === 2);
		const all = recorded(w, w.attempt.id);
		expect(all.map((o) => o.point)).toEqual(["before-send", "after-run"]);
		expect(all[1]).toMatchObject({ trigger: "run-settled", binding: first?.binding });
		expect((all[1]?.result as EndoObservedStateV0).changes.map((c) => c.path)).toEqual(["a.txt"]);
		// Once: a later run is not this attempt's.
		w.session.live_({ type: "agent_start", record: {} });
		w.session.live_({ type: "agent_settled", record: {} });
		await settle(200);
		expect(recorded(w, w.attempt.id)).toHaveLength(2);
		await w.broker.dispose();
	});

	it("never decides the send: a failed observation is recorded as unavailable and the brief is still sent", async () => {
		const repo = commitedRepo();
		const w = brokerOver(repo, {
			observe: async () => taken({ state: "unavailable", reason: "git-timeout" }, Date.now()),
		});
		w.broker.requestAttempt(w.attempt.id);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		await until(() => w.session.promptCalls.length === 1 && recorded(w, w.attempt.id).length === 1);
		expect(recorded(w, w.attempt.id)[0]?.result).toEqual({ state: "unavailable", reason: "git-timeout" });
		await w.broker.dispose();
	});

	it("checks the gate again after observing: a run that started meanwhile refuses the send, and nothing is bound or recorded", async () => {
		const repo = commitedRepo();
		let w: ReturnType<typeof brokerOver> | null = null;
		w = brokerOver(repo, {
			observe: async () => {
				(w as ReturnType<typeof brokerOver>).session.runActive = true;
				return taken({ state: "unavailable", reason: "git-timeout" }, Date.now());
			},
		});
		w.broker.requestAttempt(w.attempt.id);
		await w.approval.waitForRequest();
		w.approval.answer("allow");
		await until(() => w?.session.records.some((r) => r.kind === "workbench.prompt-refused") === true);
		expect(w.session.promptCalls).toEqual([]);
		expect(w.calls).toEqual(["take"]);
		expect(recorded(w, w.attempt.id)).toEqual([]);
		// Nothing was bound: the attempt can still be sent.
		w.session.runActive = false;
		expect(w.broker.requestAttempt(w.attempt.id).ok).toBe(true);
		await w.broker.dispose();
	});

	it("observes nothing after a send Pi refused, and once more when the workbench closes during the run", async () => {
		const repo = commitedRepo();
		const refused = brokerOver(repo);
		const { PiRpcRefusalV0 } = await import("../adapters/pi/rpc.ts");
		refused.session.promptResult = async () => {
			throw new PiRpcRefusalV0("prompt", "busy");
		};
		refused.broker.requestAttempt(refused.attempt.id);
		await refused.approval.waitForRequest();
		refused.approval.answer("allow");
		await until(() => refused.session.promptCalls.length === 1 && recorded(refused, refused.attempt.id).length === 1);
		await settle(50);
		refused.session.live_({ type: "agent_start", record: {} });
		refused.session.live_({ type: "agent_settled", record: {} });
		await settle(200);
		expect(recorded(refused, refused.attempt.id).map((o) => o.point)).toEqual(["before-send"]);
		await refused.broker.dispose();

		const closing = brokerOver(commitedRepo());
		closing.broker.requestAttempt(closing.attempt.id);
		await closing.approval.waitForRequest();
		closing.approval.answer("allow");
		await until(() => closing.session.promptCalls.length === 1 && recorded(closing, closing.attempt.id).length === 1);
		closing.session.live_({ type: "agent_start", record: {} });
		await closing.broker.dispose();
		expect(recorded(closing, closing.attempt.id).map((o) => [o.point, o.trigger])).toEqual([
			["before-send", "send-approved"],
			["after-run", "workbench-closing"],
		]);
	});
});

// ---- the page's gate -----------------------------------------------------------------------------------------------------------------

describe.skipIf(!haveGit)("the page's gate over provenance", () => {
	it("mirrors the protocol's words exactly", () => {
		expect(OBSERVATION_POINT_LABELS).toEqual(ENDO_OBSERVATION_POINT_LABELS_V0);
		expect(OBSERVATION_TRIGGER_TEXT).toEqual(ENDO_OBSERVATION_TRIGGER_TEXT_V0);
		expect(NOT_COMPARED_TEXT).toEqual(ENDO_NOT_COMPARED_TEXT_V0);
		expect(PROVENANCE_NOTE_TEXT).toEqual(ENDO_PROVENANCE_NOTE_TEXT_V0);
		expect(OBSERVATION_LIMITATIONS).toEqual([...ENDO_OBSERVATION_LIMITATIONS_V0]);
		expect(OBSERVATION_UNAVAILABLE).toEqual([...ENDO_OBSERVATION_UNAVAILABLE_V0]);
	});

	it("refuses a provenance whose parts disagree", async () => {
		const root = commitedRepo();
		const s1 = await observed(root);
		write(root, "a.txt", "y\n");
		const s2 = await observed(root);
		const good = await endoAttemptProvenanceV0({
			reader,
			authorized,
			read: read(before(s1), after(s2)),
			now: taken(s2),
			receipts: [],
			others: [],
		});
		expect(provenance_(good) && provenanceCoherent(good)).toBe(true);
		const forge = (f: (p: EndoAttemptProvenanceViewV0) => void): boolean => {
			const p = JSON.parse(JSON.stringify(good)) as EndoAttemptProvenanceViewV0;
			f(p);
			return provenance_(p) && provenanceCoherent(p);
		};
		// The basis must name the points it frames.
		expect(
			forge((p) => {
				p.basis = "operator";
			}),
		).toBe(false);
		// A frame end that does not exist, or one made for another send.
		expect(
			forge((p) => {
				p.end = `endo.observation.${"7".repeat(32)}`;
			}),
		).toBe(false);
		expect(
			forge((p) => {
				p.observations[1]!.bound = "other-send";
			}),
		).toBe(false);
		// A HEAD move between other commits than the observations'.
		expect(
			forge((p) => {
				p.head!.to = "e".repeat(40);
			}),
		).toBe(false);
		// "Same" or "different" from an incomplete observation.
		expect(
			forge((p) => {
				p.observations[1]!.complete = false;
			}),
		).toBe(false);
		// An unavailable observation with a commit; a workbench point with no send.
		expect(forge((p) => Object.assign(p.observations[0]!, { state: "unavailable", reason: "git-timeout" }))).toBe(
			false,
		);
		expect(
			forge((p) => {
				p.observations[0]!.bound = null;
			}),
		).toBe(false);
		// A comparison whose total is below its own list; paths that are not relative.
		expect(
			forge((p) => {
				p.span = { relation: "different", paths: [{ path: "a.txt", change: "modified" }], total: 0 };
			}),
		).toBe(false);
		expect(
			forge((p) => {
				p.span = { relation: "different", paths: [{ path: "../a", change: "modified" }], total: 1 };
			}),
		).toBe(false);
		// Now without a commit cannot claim a comparison.
		expect(
			forge((p) => {
				p.now = { ...p.now!, commit: null };
			}),
		).toBe(false);
		// Nothing framed in a state that has no observations.
		expect(
			forge((p) => {
				p.state = "none";
			}),
		).toBe(false);
	});

	it("refuses a receipt relation the view's HEAD does not imply (one reading of 'now' for the whole view)", () => {
		const X = "a".repeat(40);
		const Y = "b".repeat(40);
		const head = (commit: string | null, clean: boolean | null) => ({ readAtMs: 1, commit, clean });
		expect(relationAgrees({ commit: X, relation: "at-head" }, head(X, true))).toBe(true);
		expect(relationAgrees({ commit: X, relation: "at-head" }, head(Y, true))).toBe(false);
		expect(relationAgrees({ commit: X, relation: "at-head" }, head(X, false))).toBe(false);
		expect(relationAgrees({ commit: X, relation: "at-head-changed" }, head(X, false))).toBe(true);
		expect(relationAgrees({ commit: X, relation: "head-differs" }, head(X, true))).toBe(false);
		expect(relationAgrees({ commit: X, relation: "head-differs" }, head(Y, true))).toBe(true);
		expect(relationAgrees({ commit: X, relation: "unavailable" }, head(Y, true))).toBe(false);
		expect(relationAgrees({ commit: X, relation: "unavailable" }, head(null, null))).toBe(true);
		expect(relationAgrees({ commit: X, relation: "unavailable" }, null)).toBe(true);
		expect(relationAgrees({ commit: X, relation: "at-head" }, null)).toBe(false);
	});

	it("shows a path's control and direction characters as replacements", () => {
		const rlo = String.fromCharCode(0x202e);
		const nl = String.fromCharCode(10);
		expect(shownPath(`a${rlo}txt.exe${nl}b`)).toBe(
			`a${String.fromCharCode(0xfffd)}txt.exe${String.fromCharCode(0xfffd)}b`,
		);
	});
});
