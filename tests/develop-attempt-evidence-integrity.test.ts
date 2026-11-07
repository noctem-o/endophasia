// EVIDENCE-INTEGRITY-001: a damaged authorisation record must never read as "never authorised". Real stores on disk, the shared service,
// the evidence reading, and the CLI in a new process. Every damaged file is left exactly as found.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
	type EndoDevelopAttemptAuthorizationV0,
	validateEndoDevelopAttemptAuthorizationV0,
} from "../protocol/develop-attempt-execution.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { endoAttemptEvidenceV0, renderEndoAttemptEvidenceV0 } from "../runtime/contracts/develop-attempt-evidence.ts";
import { type EndoSessionLogReadV0, endoBriefSha256V0 } from "../runtime/contracts/develop-attempt-execution.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-evidence-integrity-")));
afterAll(() => {
	try {
		chmodSync(join(base), 0o700);
	} catch {}
	rmSync(base, { recursive: true, force: true });
});
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION = "endo.session.pi.0b6f6c0e-1111-4c4c-9e9e-123456789abc";
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** A store with one project, one task and two prepared attempts (A and B). */
function seeded(log: () => EndoSessionLogReadV0 = () => ({ state: "unavailable" })) {
	const root = fresh("root");
	const tasks = new DevelopTasksStoreV0(root);
	const p = ok(tasks.registerProject({ name: "demo", path: fresh("project"), observedGitRoot: null }));
	const t = ok(tasks.createTask(p.id, { title: "Fix parser" }, { select: true }));
	const attempts = new DevelopAttemptsStoreV0(root);
	const service = new DevelopAttemptsServiceV0(tasks, attempts, { sessionLog: log });
	const a = ok(service.prepare(p.id, t.id, { objective: "Attempt A" }));
	const b = ok(service.prepare(p.id, t.id, { objective: "Attempt B" }));
	const dir = attempts.directory;
	return {
		root,
		tasks,
		attempts,
		service,
		a,
		b,
		dir,
		at: (id: string, kind: string) => join(dir, `${id}.${kind}.json`),
	};
}

const MESSAGE = {
	digest: { algorithm: "hmac-sha256" as const, keyId: "endo.key.test", value: "a".repeat(64) },
	bytes: 100,
};

function proposal(tag: string) {
	const content = {
		session: SESSION,
		attachment: "pi.default",
		message: MESSAGE,
		origin: "operator-workbench",
		proposedAt: `2026-11-04T10:00:0${tag}.000Z`,
	};
	const proposalDigest = sha256(canonicalEndoJsonV0(content as never));
	return { content, proposalDigest, proposalId: `endo.evidence.workbench-prompt-${proposalDigest.slice(0, 32)}` };
}

let seq = 0;
const ev = (id: string, kind: string, payload: Record<string, unknown>, derivedFrom: string[] = []): EndoEventV0 =>
	({
		schemaVersion: "endo.event.v0",
		id,
		kind,
		source: "runtime-fact",
		sequence: ++seq,
		at: "2026-11-04T10:00:00Z",
		coordinates: { sessionId: SESSION },
		producer: "test",
		derivedFrom,
		payload,
	}) as EndoEventV0;

/** One whole workbench send and its completed run, as the attachment records it. */
function chain(tag: string) {
	const p = proposal(tag);
	const events = [
		ev(`endo.event.${tag}.start`, "lifecycle.session-started", { instance: `inst-${tag}` }),
		ev(`endo.event.${tag}.prop`, "workbench.prompt-proposed", {
			schemaVersion: "endo.workbench.v0",
			proposalId: p.proposalId,
			proposalDigest: p.proposalDigest,
			...p.content,
		}),
		ev(
			`endo.event.${tag}.auth`,
			"workbench.prompt-authorized",
			{
				schemaVersion: "endo.workbench.v0",
				proposalId: p.proposalId,
				proposalDigest: p.proposalDigest,
				decision: "allow",
				confirmation: "terminal",
				decidedAt: "2026-11-04T10:00:01.000Z",
			},
			[`endo.event.${tag}.prop`],
		),
		ev(`endo.event.${tag}.disp`, "workbench.prompt-dispatched", { proposalId: p.proposalId }, [
			`endo.event.${tag}.auth`,
		]),
		ev(`endo.event.${tag}.run`, "lifecycle.run-started", { instance: `inst-${tag}` }),
		ev(`endo.event.${tag}.acc`, "workbench.prompt-accepted", { proposalId: p.proposalId, disposition: "started" }, [
			`endo.event.${tag}.disp`,
		]),
		ev(`endo.event.${tag}.end`, "lifecycle.run-completed", { turns: 1 }),
	];
	return { p, events };
}

function authorization(
	p: ReturnType<typeof proposal>,
	brief: string,
	attemptId: string,
	tag: string,
): EndoDevelopAttemptAuthorizationV0 {
	return validateEndoDevelopAttemptAuthorizationV0({
		schemaVersion: "endo.develop-attempt-authorization.v0",
		attemptId,
		recordedAtMs: 1_800_000_000_000,
		briefSha256: endoBriefSha256V0(brief),
		taskRevision: 0,
		harness: "pi",
		session: SESSION,
		attachment: "pi.default",
		launchId: "0123456789abcdef",
		proposalId: p.proposalId,
		proposalDigest: p.proposalDigest,
		authorizationEventId: `endo.event.${tag}.auth`,
		message: MESSAGE,
		approvedBy: "operator",
		via: "workbench-terminal",
	});
}

function evidenceOf(s: ReturnType<typeof seeded>, id: string) {
	const report = ok(s.service.get(id));
	const view = endoAttemptEvidenceV0({
		report,
		task: { status: "open", history: [] },
		receipts: [],
		receiptProblems: 0,
		comparedWith: null,
		current: null,
		readAtMs: 1,
	});
	return { report, view, gaps: view.gaps.map((g) => g.code), text: renderEndoAttemptEvidenceV0(view) };
}

const brief = (s: ReturnType<typeof seeded>, id: string) => ok(s.service.brief(id));

describe("EVIDENCE-INTEGRITY-001: an authorisation record that cannot be read is unknown, never absent", () => {
	it("1. a prepared attempt with no authorisation file, in a directory read whole: known absent", () => {
		const s = seeded();
		const { report, view, gaps, text } = evidenceOf(s, s.a.id);
		expect(report.records).toEqual({ handoff: "absent", outcome: "absent", authorized: "absent" });
		expect(report.damaged).toEqual([]);
		expect(view.sent).toMatchObject({
			authorizationRecord: "absent",
			authorizedAtMs: null,
			unattributedWorkbenchSends: null,
		});
		expect(gaps).toContain("not-authorized");
		expect(gaps).not.toContain("authorization-record-damaged");
		expect(text).toContain(
			"  sent      [observed] No send to Pi through the workbench was authorised for this attempt.",
		);
		expect(view.schemaVersion).toBe("endo.develop-attempt-evidence.v1");
	});

	it("2. a valid authorisation and a confirmed dispatch: observed present, joined to the log", () => {
		const { p, events } = chain("1");
		const s = seeded(() => ({ state: "complete", events }));
		expect(s.attempts.write(s.a.id, "authorized", authorization(p, brief(s, s.a.id), s.a.id, "1"))).toBe("created");
		const { report, view, gaps } = evidenceOf(s, s.a.id);
		expect(report.records.authorized).toBe("recorded");
		expect(view.sent).toMatchObject({
			authorizationRecord: "recorded",
			send: "runtime-accepted",
			unattributedWorkbenchSends: null,
		});
		expect(view.pi).toMatchObject({ source: "pi-report", run: "completed" });
		expect(gaps).not.toContain("not-authorized");
		expect(gaps).not.toContain("authorization-record-damaged");
	});

	const damagedCases: [string, (s: ReturnType<typeof seeded>) => void, string][] = [
		["3. corrupted JSON", (s) => writeFileSync(s.at(s.a.id, "authorized"), "{garbage"), "malformed"],
		[
			"4. valid JSON, not an authorisation record",
			(s) =>
				writeFileSync(
					s.at(s.a.id, "authorized"),
					JSON.stringify({ schemaVersion: "endo.develop-attempt-authorization.v0" }),
				),
			"invalid",
		],
		[
			"5a. a symbolic link at its name (unsafe)",
			(s) => symlinkSync(join(s.root, "elsewhere.json"), s.at(s.a.id, "authorized")),
			"unsafe-path",
		],
		["5b. over its bound", (s) => writeFileSync(s.at(s.a.id, "authorized"), `"${"x".repeat(80_000)}"`), "too-large"],
		[
			"5c. another attempt's valid record copied under its name (misnamed)",
			(s) => {
				const { p } = chain("2");
				expect(s.attempts.write(s.b.id, "authorized", authorization(p, brief(s, s.b.id), s.b.id, "2"))).toBe(
					"created",
				);
				writeFileSync(s.at(s.a.id, "authorized"), readFileSync(s.at(s.b.id, "authorized")));
			},
			"misnamed",
		],
	];
	for (const [name, damage, reason] of damagedCases)
		it(`${name}: damaged, unknown, and not "not-authorized"; the file is left as found`, () => {
			const s = seeded();
			damage(s);
			const before = (() => {
				try {
					return readFileSync(s.at(s.a.id, "authorized"));
				} catch {
					return null;
				}
			})();
			const { report, view, gaps, text } = evidenceOf(s, s.a.id);
			expect(report.records.authorized).toBe("damaged");
			// A misnamed record also says which attempt it claims (here B's, copied under A's name).
			expect(report.damaged).toEqual([
				{ name: `${s.a.id}.authorized.json`, reason, ...(reason === "misnamed" ? { claims: s.b.id } : {}) },
			]);
			expect(view.sent).toMatchObject({ authorizationRecord: "damaged", authorizedAtMs: null, send: null });
			expect(view.sent.damaged).toEqual([{ record: "authorized", reason }]);
			expect(view.pi).toMatchObject({ source: "unknown", run: null });
			expect(gaps[0]).toBe("authorization-record-damaged");
			expect(gaps).not.toContain("not-authorized");
			expect(text).toContain("  sent      [unknown] Unknown: this attempt's authorisation record is damaged");
			expect(text).toContain(`  damaged   [observed] this attempt's authorized record is not usable (${reason})`);
			expect(text).not.toContain("No send to Pi through the workbench was authorised");
			const after = (() => {
				try {
					return readFileSync(s.at(s.a.id, "authorized"));
				} catch {
					return null;
				}
			})();
			expect(after).toEqual(before);
		});

	it.skipIf(isRoot)("5d. a file at its name that cannot be read (permissions): damaged (io)", () => {
		const s = seeded();
		writeFileSync(s.at(s.a.id, "authorized"), "{}");
		chmodSync(s.at(s.a.id, "authorized"), 0o000);
		try {
			const { report, gaps } = evidenceOf(s, s.a.id);
			expect(report.records.authorized).toBe("damaged");
			expect(report.damaged[0]?.reason).toBe("io");
			expect(gaps).toContain("authorization-record-damaged");
		} finally {
			chmodSync(s.at(s.a.id, "authorized"), 0o600);
		}
	});

	it.skipIf(isRoot)(
		"6. an attempts directory that cannot be read: refused, no reading at all, nothing claimed",
		() => {
			const s = seeded();
			chmodSync(s.dir, 0o000);
			try {
				const got = s.service.get(s.a.id);
				expect(got).toMatchObject({ ok: false, code: "unreadable" });
			} finally {
				chmodSync(s.dir, 0o700);
			}
		},
	);

	it("7. a damaged record of ANOTHER attempt says nothing about this one", () => {
		const s = seeded();
		writeFileSync(s.at(s.b.id, "authorized"), "{garbage");
		const a = evidenceOf(s, s.a.id);
		expect(a.report.records.authorized).toBe("absent");
		expect(a.report.damaged).toEqual([]);
		expect(a.gaps).toContain("not-authorized");
		const b = evidenceOf(s, s.b.id);
		expect(b.report.records.authorized).toBe("damaged");
		// And a file merely NAMED like this attempt's but not a record name is not this attempt's record.
		writeFileSync(join(s.dir, `${s.a.id}.authorized.json.bak`), "{garbage");
		expect(evidenceOf(s, s.a.id).report.records.authorized).toBe("absent");
	});

	it("8. a valid authorisation with an incomplete session log: recorded, with the incompleteness as its own gap", () => {
		const { p, events } = chain("3");
		const s = seeded(() => ({ state: "partial", events: events.slice(0, 4) }));
		expect(s.attempts.write(s.a.id, "authorized", authorization(p, brief(s, s.a.id), s.a.id, "3"))).toBe("created");
		const { view, gaps } = evidenceOf(s, s.a.id);
		expect(view.sent.authorizationRecord).toBe("recorded");
		expect(gaps).toContain("execution-evidence-incomplete");
		expect(gaps).not.toContain("not-authorized");
		expect(gaps).not.toContain("authorization-record-damaged");
	});

	it("9. a damaged authorisation beside a whole log of sends: they are counted, unattributed, never joined to this attempt", () => {
		const mine = chain("4");
		const theirs = chain("5");
		const plain = chain("6"); // a plain workbench prompt: no attempt, so no authorisation record ever accounts for it
		const events = [...mine.events, ...theirs.events, ...plain.events];
		const s = seeded(() => ({ state: "complete", events }));
		// B's send is accounted for by B's valid record; A's record (which would have accounted for "mine") is damaged.
		expect(s.attempts.write(s.b.id, "authorized", authorization(theirs.p, brief(s, s.b.id), s.b.id, "5"))).toBe(
			"created",
		);
		writeFileSync(s.at(s.a.id, "authorized"), "{garbage");
		const { view, gaps, text } = evidenceOf(s, s.a.id);
		expect(view.sent).toMatchObject({ authorizationRecord: "damaged", send: null, unattributedWorkbenchSends: 2 });
		expect(view.pi).toMatchObject({ source: "unknown", run: null });
		expect(gaps).toContain("authorization-record-damaged");
		expect(gaps).not.toContain("run-not-completed");
		expect(text).toContain(
			"  log       [observed] 2 workbench send(s) in the session log are accounted for by no readable authorisation; none is attributed to this attempt",
		);
		// A log not read whole: no count, since what is missing could change it.
		const partial = seeded(() => ({ state: "partial", events }));
		writeFileSync(partial.at(partial.a.id, "authorized"), "{garbage");
		expect(evidenceOf(partial, partial.a.id).view.sent.unattributedWorkbenchSends).toBeNull();
	});

	it("a stray file merely starting with this attempt's id is not its record: absent, and nothing listed as damaged (review #2)", () => {
		const s = seeded();
		for (const stray of ["extra.authorized.json", "prepared.authorized.json"])
			writeFileSync(join(s.dir, `${s.a.id}.${stray}`), "{garbage");
		const { report, view, gaps, text } = evidenceOf(s, s.a.id);
		expect(report.records.authorized).toBe("absent");
		expect(report.damaged).toEqual([]);
		expect(view.sent.damaged).toEqual([]);
		expect(gaps).toContain("not-authorized");
		expect(text).not.toContain("damaged   [observed]");
		// The broker still refuses it (a file at one of its names might be a record a later build writes).
		expect(
			new DevelopAttemptDispatchV0(s.tasks, s.attempts, { projectId: s.a.projectId, launchDirectory: s.root }).check(
				s.a.id,
			),
		).toMatchObject({ ok: false, code: "unreadable" });
	});

	it("this attempt's valid record found under ANOTHER attempt's name: damaged for both, and no second send (review #3)", () => {
		const { p } = chain("7");
		const s = seeded();
		expect(s.attempts.write(s.a.id, "authorized", authorization(p, brief(s, s.a.id), s.a.id, "7"))).toBe("created");
		writeFileSync(s.at(s.b.id, "authorized"), readFileSync(s.at(s.a.id, "authorized")));
		rmSync(s.at(s.a.id, "authorized"));
		const a = evidenceOf(s, s.a.id);
		expect(a.report.records.authorized).toBe("damaged");
		expect(a.report.damaged).toEqual([{ name: `${s.b.id}.authorized.json`, reason: "misnamed", claims: s.a.id }]);
		expect(a.gaps).toContain("authorization-record-damaged");
		expect(a.view.pi.source).toBe("unknown");
		expect(evidenceOf(s, s.b.id).report.records.authorized).toBe("damaged");
		const dispatch = new DevelopAttemptDispatchV0(s.tasks, s.attempts, {
			projectId: s.a.projectId,
			launchDirectory: s.root,
		});
		expect(dispatch.check(s.a.id)).toMatchObject({ ok: false, code: "unreadable" });
		expect(dispatch.check(s.b.id)).toMatchObject({ ok: false, code: "unreadable" });
	});

	it("every reader that names one attempt says unreadable, not 'not found', when its prepared record is damaged (review #8)", () => {
		const s = seeded();
		writeFileSync(s.at(s.a.id, "prepared"), "{garbage");
		expect(s.service.handoff(s.a.id, { target: "x" })).toMatchObject({ ok: false, code: "unreadable" });
		expect(s.service.report(s.a.id, "done")).toMatchObject({ ok: false, code: "unreadable" });
		expect(
			new DevelopAttemptDispatchV0(s.tasks, s.attempts, { projectId: s.a.projectId, launchDirectory: s.root }).check(
				s.a.id,
			),
		).toMatchObject({ ok: false, code: "unreadable" });
		// The list still shows the other attempt, and counts the problem.
		const listed = ok(s.service.list(s.a.projectId));
		expect(listed.attempts.map((x) => x.attempt.id)).toEqual([s.b.id]);
		expect(listed.problems).toEqual([{ name: `${s.a.id}.prepared.json`, reason: "malformed" }]);
	});

	it("dispatches without a usable proposal id are counted as unaccounted, not dropped (review mutation survivor)", () => {
		const s = seeded(() => ({
			state: "complete",
			events: [
				ev("endo.event.x.1", "workbench.prompt-dispatched", {}),
				ev("endo.event.x.2", "workbench.prompt-dispatched", { proposalId: 7 }),
				ev("endo.event.x.3", "workbench.prompt-refused", { reason: "authorization-denied" }),
			],
		}));
		writeFileSync(s.at(s.a.id, "authorized"), "{garbage");
		expect(evidenceOf(s, s.a.id).view.sent.unattributedWorkbenchSends).toBe(2);
	});

	it("a damaged handoff or outcome is an unreadable operator statement, not an absent one", () => {
		const s = seeded();
		writeFileSync(s.at(s.a.id, "handoff"), "{garbage");
		const { report, gaps, view } = evidenceOf(s, s.a.id);
		expect(report.records).toEqual({ handoff: "damaged", outcome: "absent", authorized: "absent" });
		expect(gaps).toContain("operator-statement-damaged");
		expect(view.sent.damaged).toEqual([{ record: "handoff", reason: "malformed" }]);
	});

	it("a damaged prepared record (or later records without it) is not 'no such attempt'", () => {
		const s = seeded();
		writeFileSync(s.at(s.a.id, "prepared"), "{garbage");
		expect(s.service.get(s.a.id)).toMatchObject({ ok: false, code: "unreadable", reason: "malformed" });
		expect(s.service.get("endo.attempt.ffffffffffffffffffffffffffffffff")).toMatchObject({
			ok: false,
			code: "not-found",
		});
	});

	it("10. read again from a new process: the CLI's JSON, text and gap list agree, and nothing in the store changes", () => {
		const s = seeded();
		writeFileSync(s.at(s.a.id, "authorized"), "{garbage");
		const env = { ...process.env, ENDO_DIGEST_KEY_FILE: join(s.root, "key") };
		const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
		const ev1 = run("attempt", "evidence", "--root", s.root, "--attempt", s.a.id);
		expect(ev1.status).toBe(0);
		const view = JSON.parse(ev1.stdout).evidence;
		expect(view.sent.authorizationRecord).toBe("damaged");
		expect(view.gaps.map((g: { code: string }) => g.code)).toContain("authorization-record-damaged");
		expect(view.gaps.map((g: { code: string }) => g.code)).not.toContain("not-authorized");
		expect(ev1.stderr).toContain("[unknown] Unknown: this attempt's authorisation record is damaged");
		expect(ev1.stderr).toContain(
			"gap       A file at this attempt's authorisation record's name is not a usable record. Whether a send was authorised is unknown",
		);
		const listed = run("attempt", "list", "--root", s.root, "--project", s.a.projectId);
		expect(
			JSON.parse(listed.stdout).attempts.map((x: { id: string; records: { authorized: string } }) => [
				x.id,
				x.records.authorized,
			]),
		).toEqual([
			[s.a.id, "damaged"],
			[s.b.id, "absent"],
		]);
		const show = run("attempt", "show", "--root", s.root, "--attempt", s.a.id);
		expect(show.status).toBe(0);
		expect(JSON.parse(show.stdout).attempt).toMatchObject({
			records: { authorized: "damaged" },
			damaged: [{ name: `${s.a.id}.authorized.json`, reason: "malformed" }],
			execution: null,
		});
		expect(show.stderr).toContain("execution: unknown.");
		expect(readFileSync(s.at(s.a.id, "authorized"), "utf8")).toBe("{garbage");
		// The ordinary case, from a new process too.
		const plain = run("attempt", "evidence", "--root", s.root, "--attempt", s.b.id);
		expect(JSON.parse(plain.stdout).evidence.sent.authorizationRecord).toBe("absent");
		expect(plain.stderr).toContain("[observed] No send to Pi through the workbench was authorised for this attempt.");
		// A damaged prepared record: the CLI refuses, and does not say "no such attempt".
		writeFileSync(s.at(s.b.id, "prepared"), "{garbage");
		const gone = run("attempt", "evidence", "--root", s.root, "--attempt", s.b.id);
		expect(gone.status).not.toBe(0);
		expect(gone.stderr).toContain("cannot be used");
		expect(gone.stderr).not.toContain("no such project, task (in that project) or attempt");
	});
});
