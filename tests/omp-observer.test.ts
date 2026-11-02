// The Oh My Pi saved-session observer (adapters/omp, protocol/omp-observation.ts, the two Studio routes): what it reads, what it refuses,
// what it withholds, and that it changes nothing and controls nothing. Synthetic journals only (tests/fixtures/omp-journals.ts); every
// text field in them carries a canary. No OMP process, no model, no network.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { readOmpFileV0, reduceOmpJournalV0 } from "../adapters/omp/journal.ts";
import { OmpSavedSessionObserverV0 } from "../adapters/omp/observer.ts";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { endoDevelopSessionProblemV0 } from "../protocol/develop-session.ts";
import {
	ENDO_OMP_ACTIVITY_KINDS_V0,
	ENDO_OMP_EXIT_KINDS_V0,
	ENDO_OMP_FILE_STATES_V0,
	ENDO_OMP_KEY_REASONS_V0,
	ENDO_OMP_STOP_REASONS_V0,
	type EndoOmpSessionsV0,
	validateEndoOmpSessionsV0,
	validateEndoOmpSessionV0,
} from "../protocol/omp-observation.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { presentOmpSaved } from "../studio-ui/src/model/develop-session.ts";
import {
	OMP_ACTIVITY_KINDS,
	OMP_EXIT_KINDS,
	OMP_FILE_STATES,
	OMP_KEY_REASONS,
	OMP_STOP_REASONS,
	readOmpSession,
	readOmpSessions,
} from "../studio-ui/src/model/omp-wire.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { CANARY, conversation, header, resetIds, session, titleSlot } from "./fixtures/omp-journals.ts";
import { developStore } from "./studio-develop-fixtures.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "endo-omp-observer-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
afterEach(async () => {
	resetIds();
	await stopServers();
});
let made = 0;
const fresh = (name: string) => {
	made += 1;
	const dir = join(base, `${name}-${made}`);
	mkdirSync(dir, { recursive: true });
	return dir;
};
const observer = (root: string) => new OmpSavedSessionObserverV0({ root, key: OTHER_KEY });
const ID_A = "019a0000-0000-7000-8000-00000000000a";
const ID_B = "019a0000-0000-7000-8000-00000000000b";
const listOf = (root: string): EndoOmpSessionsV0 => {
	const list = observer(root).sessions();
	validateEndoOmpSessionsV0(list);
	return list;
};
/** Every file under a directory: size, times, inode, mode and content digest. A read that changes any of them fails. */
function manifest(root: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			const s = lstatSync(path, { bigint: true });
			const entry: unknown[] = [s.size, s.mtimeNs, s.ctimeNs, s.ino, s.mode];
			if (s.isFile()) entry.push(createHash("sha256").update(readFileSync(path)).digest("hex"));
			out[relative(root, path)] = entry.map(String);
			if (s.isDirectory()) walk(path);
		}
	};
	walk(root);
	return out;
}

describe("reading a valid saved session", () => {
	it("reduces OMP's own format to counts, kinds, tool and model names, OMP's exit record and lineage, and nothing else", () => {
		const root = fresh("valid");
		mkdirSync(join(root, "-work-demo"));
		writeFileSync(join(root, "-work-demo", `2026-10-01T10-00-00-000Z_${ID_A}.jsonl`), session(ID_A));
		const list = listOf(root);
		expect(list.sessions).toHaveLength(1);
		const row = list.sessions[0]!;
		expect(row).toMatchObject({
			key: { status: "established", id: ID_A },
			alias: `omp ${ID_A.slice(-8)}`,
			state: "readable",
			format: { session: 3, titleSlot: true },
			runtimeVersions: ["18.14.1"],
			createdAt: "2026-10-01T10:00:00.000Z",
			tail: "complete",
			counts: {
				userMessages: 1,
				assistantMessages: 2,
				toolResults: 1,
				toolCalls: 1,
				toolErrors: 1,
				compactions: 1,
				unknownTypes: 0,
				malformedLines: 0,
			},
			tree: { leaves: 1, duplicateIds: 0, missingParents: 0, cycles: 0 },
			lineage: { kind: "none" },
			exit: { kind: "normal", reason: "manual", at: "2026-10-01T10:00:40.000Z" },
			turn: "settled",
		});
		const detail = observer(root).session(row.selector)!;
		validateEndoOmpSessionV0(detail);
		expect(detail.activity.map((a) => a.kind)).toEqual([
			"model-change",
			"other",
			"user-message",
			"assistant-message",
			"tool-start",
			"tool-result",
			"compaction",
			"assistant-message",
			"other",
			"title-change",
			"extension",
			"other",
			"session-exit",
		]);
		expect(detail.activity[3]).toMatchObject({
			tools: ["bash"],
			stopReason: "toolUse",
			model: "anthropic/claude-test",
		});
		expect(detail.activity[5]).toMatchObject({ tools: ["bash"], isError: true });
		// The browser's gate reads exactly what the server's validator accepts.
		expect(readOmpSessions(JSON.parse(JSON.stringify(list)))).not.toBeNull();
		expect(readOmpSession(JSON.parse(JSON.stringify(detail)))).not.toBeNull();
	});

	it("withholds every text: no message, thinking, tool argument or output, title, path, summary, prompt, digest or cache key", () => {
		const root = fresh("private");
		mkdirSync(join(root, `-home-${CANARY}`));
		const file = join(root, `-home-${CANARY}`, `x_${ID_A}.jsonl`);
		writeFileSync(file, session(ID_A, { extra: { parentSession: `/home/${CANARY}/other.jsonl`, title: CANARY } }));
		const list = listOf(root);
		const detail = observer(root).session(list.sessions[0]!.selector)!;
		for (const record of [list, detail]) {
			const text = JSON.stringify(record);
			expect(text).not.toContain(CANARY);
			expect(text).not.toContain("AKIA");
			expect(text).not.toContain("/home/");
		}
		// A lineage that names a file is said to exist, without the path.
		expect(list.sessions[0]!.lineage).toEqual({ kind: "copied-file" });
	});

	it("records lineage only as OMP wrote it in the header, never from a name, a directory or a time", () => {
		const root = fresh("lineage");
		const artifacts = join(root, "-work", `x_${ID_A}`);
		mkdirSync(artifacts, { recursive: true });
		writeFileSync(join(root, "-work", `x_${ID_A}.jsonl`), session(ID_A));
		// A subagent beside its parent, named after it, made at the same time, but with no parentSession: no lineage.
		writeFileSync(join(artifacts, "Scout.jsonl"), session(ID_B));
		writeFileSync(join(artifacts, "Scout.log"), `${CANARY} bash output\n`);
		writeFileSync(join(artifacts, "Scout.md"), `${CANARY} subagent result\n`);
		const rows = listOf(root).sessions;
		expect(rows.map((r) => r.lineage)).toEqual([{ kind: "none" }, { kind: "none" }]);
		expect(JSON.stringify(rows)).not.toContain(CANARY);
		rmSync(join(artifacts, "Scout.jsonl"));
		writeFileSync(join(artifacts, "Scout.jsonl"), session(ID_B, { extra: { parentSession: ID_A } }));
		expect(listOf(root).sessions.find((r) => r.key.status === "established" && r.key.id === ID_B)?.lineage).toEqual({
			kind: "session",
			id: ID_A,
		});
	});

	it("reads a legacy-ordered file without a title slot, and counts unknown entry types without treating them as damage", () => {
		const root = fresh("legacy");
		const convo = conversation();
		const unknown = `${JSON.stringify({ type: "com.example.future", id: "zz", parentId: convo.last, timestamp: "2026-10-01T10:01:00.000Z", secret: CANARY })}\n`;
		writeFileSync(join(root, `a_${ID_A}.jsonl`), `${header(ID_A)}${convo.text}${unknown}`);
		const row = listOf(root).sessions[0]!;
		expect(row).toMatchObject({ state: "readable", format: { session: 3, titleSlot: false }, exit: null });
		expect(row.counts.unknownTypes).toBe(1);
		expect(JSON.stringify(row)).not.toContain(CANARY);
	});

	it("keeps branches of one session apart from separate sessions, and follows the last entry back as OMP does", () => {
		const root = fresh("branches");
		const convo = conversation();
		// A second child of the first user message: a sibling branch in the same file, not another session.
		const branch = `${JSON.stringify({ type: "message", id: "b1", parentId: "00000003", timestamp: "2026-10-01T10:02:00.000Z", message: { role: "user", content: CANARY, timestamp: 9 } })}\n`;
		writeFileSync(join(root, `a_${ID_A}.jsonl`), `${titleSlot()}${header(ID_A)}${convo.text}${branch}`);
		const list = listOf(root);
		expect(list.sessions).toHaveLength(1);
		expect(list.sessions[0]!.tree.leaves).toBe(2);
		// The leaf is the branch (the last entry in file order): its path is the user message's ancestors and itself; the turn is open.
		expect(list.sessions[0]!.turn).toBe("open");
		const detail = observer(root).session(list.sessions[0]!.selector)!;
		expect(detail.activity.map((a) => a.kind)).toEqual(["model-change", "other", "user-message", "user-message"]);
	});

	it("counts a damaged tree (repeated ids, missing parents, cycles) and still terminates", () => {
		const root = fresh("damaged-tree");
		const line = (o: Record<string, unknown>) =>
			`${JSON.stringify({ timestamp: "2026-10-01T10:00:01.000Z", ...o })}\n`;
		writeFileSync(
			join(root, `a_${ID_A}.jsonl`),
			`${header(ID_A)}${line({ type: "label", id: "a", parentId: "c" })}${line({ type: "label", id: "b", parentId: "a" })}${line({ type: "label", id: "c", parentId: "b" })}${line({ type: "label", id: "a", parentId: null })}${line({ type: "label", id: "d", parentId: "missing" })}`,
		);
		const row = listOf(root).sessions[0]!;
		expect(row.tree).toMatchObject({ duplicateIds: 1, missingParents: 1, cycles: 1 });
	});
});

describe("identity: source-qualified, never from a label, refused when ambiguous", () => {
	it("leaves both files without a key when two carry one session id, and never shares a label", () => {
		const root = fresh("dupes");
		mkdirSync(join(root, "p1"));
		mkdirSync(join(root, "p2"));
		writeFileSync(join(root, "p1", `a_${ID_A}.jsonl`), session(ID_A));
		writeFileSync(join(root, "p2", "copied.jsonl"), session(ID_A));
		const rows = listOf(root).sessions;
		expect(rows.map((r) => r.key)).toEqual([
			{ status: "unavailable", reason: "duplicate-id" },
			{ status: "unavailable", reason: "duplicate-id" },
		]);
		expect(rows.map((r) => r.alias)).toEqual([null, null]);
		// In the neutral surface each is an entry with no key, and neither is validated as the other.
		for (const row of rows) {
			const entry = presentOmpSaved(row);
			expect(entry.identity.key.status).toBe("unavailable");
			expect(endoDevelopSessionProblemV0(entry)).toBeNull();
		}
	});

	it("gives no label to two ids that end alike, and never uses a title (or a file name) as one", () => {
		const root = fresh("alike");
		const a = "019a0000-0000-7000-8000-aaaaaaaa0001";
		const b = "019a1111-0000-7000-8000-bbbbaaaa0001";
		writeFileSync(join(root, "same-title-1.jsonl"), session(a));
		writeFileSync(join(root, "same-title-2.jsonl"), session(b));
		const rows = listOf(root).sessions;
		expect(rows.map((r) => r.key.status)).toEqual(["established", "established"]);
		expect(rows.map((r) => r.alias)).toEqual([null, null]);
	});

	it("does not repair a malformed id", () => {
		const root = fresh("bad-id");
		writeFileSync(join(root, "a.jsonl"), `${header("has spaces/and slashes")}${conversation().text}`);
		expect(listOf(root).sessions[0]!.key).toEqual({ status: "unavailable", reason: "malformed-id" });
	});
});

describe("formats and damage fail visibly", () => {
	it("refuses a session format it does not know, whole, and reads nothing else from it", () => {
		const root = fresh("versions");
		const convo = conversation().text;
		writeFileSync(join(root, "v4.jsonl"), `${titleSlot()}${header(ID_A, { version: 4 })}${convo}`);
		writeFileSync(join(root, "v1.jsonl"), `${header(ID_B, { version: undefined })}${convo}`);
		writeFileSync(join(root, "vs.jsonl"), `${header("019c", { version: "3" })}${convo}`);
		const rows = listOf(root).sessions;
		expect(rows.map((r) => [r.state, r.format.session, r.counts.entries, r.key])).toEqual([
			["unsupported-version", 1, 0, { status: "unavailable", reason: "no-header" }],
			["unsupported-version", 4, 0, { status: "unavailable", reason: "no-header" }],
			["unsupported-version", null, 0, { status: "unavailable", reason: "no-header" }],
		]);
		for (const row of rows) {
			const entry = presentOmpSaved(row);
			expect(entry.status).toEqual([]);
			expect(entry.capabilities.observe.activity.status).toBe("unavailable");
			expect(endoDevelopSessionProblemV0(entry)).toBeNull();
		}
	});

	it("says there is no header when there is none, and reads an empty file as such", () => {
		const root = fresh("no-header");
		writeFileSync(join(root, "a.jsonl"), conversation().text);
		writeFileSync(join(root, "b.jsonl"), "");
		writeFileSync(join(root, "c.jsonl"), "not json at all\n");
		expect(listOf(root).sessions.map((r) => r.state)).toEqual(["no-header", "no-header", "no-header"]);
	});

	it("skips a malformed line elsewhere and counts it; a partial last line is pending, not damage, and is read once complete", () => {
		const root = fresh("partial");
		const file = join(root, `a_${ID_A}.jsonl`);
		const convo = conversation();
		const tail = JSON.stringify({
			type: "message",
			id: "late",
			parentId: convo.last,
			timestamp: "2026-10-01T10:05:00.000Z",
			message: { role: "user", content: CANARY, timestamp: 9 },
		});
		writeFileSync(
			file,
			`${titleSlot()}${header(ID_A)}${convo.text.replace("\n", "\n{not json\n")}${tail.slice(0, 40)}`,
		);
		const first = listOf(root).sessions[0]!;
		expect(first).toMatchObject({ state: "readable", tail: "pending", turn: "settled" });
		expect(first.counts.malformedLines).toBe(1);
		const entries = first.counts.entries;
		// OMP finishes the line: the next read has it, and the session was never poisoned by the incomplete one.
		appendFileSync(file, `${tail.slice(40)}\n`);
		const second = listOf(root).sessions[0]!;
		expect(second).toMatchObject({ tail: "complete", turn: "open" });
		expect(second.counts.entries).toBe(entries + 1);
	});

	it("reads repeatedly without duplicating anything: each read is a whole new snapshot", () => {
		const root = fresh("repeat");
		writeFileSync(join(root, `a_${ID_A}.jsonl`), session(ID_A));
		const o = observer(root);
		const one = o.sessions();
		const selector = one.sessions[0]!.selector;
		const a = o.session(selector)!;
		const b = o.session(selector)!;
		expect({ ...b, readAt: null }).toEqual({ ...a, readAt: null });
		expect({ ...o.sessions(), readAt: null }).toEqual({ ...one, readAt: null });
	});
});

describe("rewrites, replacement, links and odd files", () => {
	it("shows a file rewritten in place as it now is, with nothing of the earlier generation merged in", () => {
		const root = fresh("rewrite");
		const file = join(root, `a_${ID_A}.jsonl`);
		writeFileSync(file, session(ID_A));
		const o = observer(root);
		const selector = o.sessions().sessions[0]!.selector;
		expect(o.session(selector)!.activity.length).toBeGreaterThan(5);
		// Truncated and rewritten in place (same inode): a shorter session, no exit.
		writeFileSync(file, `${titleSlot()}${header(ID_A)}`);
		const after = o.session(selector)!;
		expect(after.activity).toEqual([]);
		expect(after.session).toMatchObject({ exit: null, turn: "empty", counts: { entries: 0 } });
	});

	it("gives a replaced file a new selector: the old one finds nothing rather than another file's contents", () => {
		const root = fresh("replace");
		const file = join(root, `a_${ID_A}.jsonl`);
		writeFileSync(file, session(ID_A));
		const o = observer(root);
		const old = o.sessions().sessions[0]!.selector;
		const next = join(root, "next.tmp");
		writeFileSync(next, session(ID_B));
		renameSync(next, file);
		expect(o.session(old)).toBeNull();
		const now = o.sessions().sessions[0]!;
		expect(now.selector).not.toBe(old);
		expect(now.key).toEqual({ status: "established", id: ID_B });
	});

	it("never follows a link (to a file or a directory), never reads a FIFO, and counts what it passed over", () => {
		const root = fresh("links");
		const outside = fresh("outside");
		writeFileSync(join(outside, "secret.jsonl"), session(ID_B));
		mkdirSync(join(outside, "dir"));
		writeFileSync(join(outside, "dir", "inner.jsonl"), session(ID_B));
		writeFileSync(join(root, `a_${ID_A}.jsonl`), session(ID_A));
		symlinkSync(join(outside, "secret.jsonl"), join(root, "link.jsonl"));
		symlinkSync(join(outside, "dir"), join(root, "linked-dir"));
		const fifo = spawnSync("mkfifo", [join(root, "pipe.jsonl")]);
		const list = listOf(root);
		expect(list.sessions.map((r) => r.key)).toEqual([{ status: "established", id: ID_A }]);
		expect(list.skipped.links).toBe(2);
		if (fifo.status === 0) expect(list.skipped.notRegular).toBe(1);
		expect(JSON.stringify(list)).not.toContain(ID_B);
	});

	it("looks into three directory levels (the root, project groups, artifact directories) and no deeper, reads only *.jsonl, and leaves OMP's .log, .md and .json files unopened", () => {
		const root = fresh("depth");
		// The root, OMP's project groups, and a session's artifact directory (where subagent sessions are): no further.
		const deep = join(root, "a", "b", "c");
		mkdirSync(deep, { recursive: true });
		writeFileSync(join(root, "a", "b", `ok_${ID_A}.jsonl`), session(ID_A));
		writeFileSync(join(deep, `too-deep_${ID_B}.jsonl`), session(ID_B));
		writeFileSync(join(root, "a", "notes.json"), JSON.stringify({ type: "session", version: 3, id: CANARY }));
		const list = listOf(root);
		expect(list.sessions.map((r) => r.key)).toEqual([{ status: "established", id: ID_A }]);
	});

	it("changes nothing in the directory it reads: no byte, time, inode or mode, and no new file", () => {
		const root = fresh("untouched");
		mkdirSync(join(root, "-p", `x_${ID_A}`), { recursive: true });
		writeFileSync(join(root, "-p", `x_${ID_A}.jsonl`), session(ID_A, { exit: false }));
		writeFileSync(join(root, "-p", `x_${ID_A}`, "1.bash.log"), CANARY);
		const before = manifest(root);
		const o = observer(root);
		for (let i = 0; i < 3; i += 1) for (const row of o.sessions().sessions) o.session(row.selector);
		expect(manifest(root)).toEqual(before);
	});
});

describe("what a saved file can and cannot say about a process", () => {
	it("an open turn with no exit, just written, is a RECORDED active claim on a recording: never live, never connected, not controllable", () => {
		const root = fresh("looks-running");
		writeFileSync(
			join(root, `a_${ID_A}.jsonl`),
			`${titleSlot()}${header(ID_A)}${conversation().text.split("\n").slice(0, 4).join("\n")}\n`,
		);
		const row = listOf(root).sessions[0]!;
		expect(row).toMatchObject({ exit: null, turn: "open" });
		const entry = presentOmpSaved(row);
		expect(endoDevelopSessionProblemV0(entry)).toBeNull();
		expect(entry.observation).toEqual({ mode: "recorded", reason: null });
		expect(entry.connection.state).toBe("not-applicable");
		expect(entry.status).toEqual([{ state: "active", basis: "recorded", by: "omp-saved", at: row.lastEntryAt }]);
		expect(entry.ownership).toMatchObject({ value: "external" });
		for (const action of ["prompt", "steer", "queue", "stop", "resume"] as const)
			expect(entry.capabilities.control[action].status).toBe("unsupported");
		for (const action of ["live-status", "live-transcript", "live-reasoning"] as const)
			expect(entry.capabilities.observe[action].status).toBe("unsupported");
	});

	it("an exit OMP recorded is OMP's REPORT of its exit; a signal exit is an interruption; a resumed session is not ended", () => {
		const root = fresh("exits");
		writeFileSync(join(root, "normal.jsonl"), session(ID_A));
		writeFileSync(
			join(root, "signal.jsonl"),
			session(ID_B).replace('"kind":"normal","reason":"manual"', '"kind":"signal","reason":"sighup"'),
		);
		const rows = listOf(root).sessions;
		expect(rows.map((r) => presentOmpSaved(r).status)).toEqual([
			[{ state: "ended", basis: "reported", by: "omp", at: "2026-10-01T10:00:40.000Z" }],
			[{ state: "interrupted", basis: "reported", by: "omp", at: "2026-10-01T10:00:40.000Z" }],
		]);
		// Resumed after the exit: the exit is no longer the last entry, so nothing says the session ended.
		const resumed = `${session("019d0000-0000-7000-8000-00000000000d")}${JSON.stringify({ type: "message", id: "r1", parentId: "x", timestamp: "2026-10-01T11:00:00.000Z", message: { role: "user", content: "x", timestamp: 1 } })}\n`;
		expect(reduceOmpJournalV0(Buffer.from(resumed)).row).toMatchObject({ exit: null, turn: "open" });
	});

	it("an unreadable file has no status, no key and no lifecycle or activity: unavailable, with the reason", () => {
		const entry = presentOmpSaved({
			...listOf(
				(() => {
					const root = fresh("unreadable");
					writeFileSync(join(root, "a.jsonl"), "{}\n");
					return root;
				})(),
			).sessions[0]!,
		});
		expect(entry.status).toEqual([]);
		expect(entry.identity.key.status).toBe("unavailable");
		expect(entry.capabilities.observe.lifecycle.status).toBe("unavailable");
		expect(endoDevelopSessionProblemV0(entry)).toBeNull();
	});
});

describe("no authority, no task association", () => {
	it("an OMP entry cannot claim control or another integration's governed path", () => {
		const root = fresh("authority");
		writeFileSync(join(root, "a.jsonl"), session(ID_A));
		const entry = presentOmpSaved(listOf(root).sessions[0]!);
		const forged = structuredClone(entry);
		forged.capabilities.control.prompt = { status: "supported", via: "pi-workbench-broker", reason: null };
		expect(endoDevelopSessionProblemV0(forged)).toMatch(
			/control is supported only for a live, directly owned session/,
		);
		const borrowed = structuredClone(entry);
		borrowed.capabilities.observe["live-status"] = { status: "supported", via: "pi-workbench-broker", reason: null };
		expect(endoDevelopSessionProblemV0(borrowed)).toMatch(/pi-workbench-broker is the path of pi-live only/);
	});

	it("an OMP host can link no session to a task, and observing OMP writes nothing to the task store", async () => {
		const root = fresh("tasks-root");
		const project = fresh("tasks-project");
		const service = new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), {
			observeGitRoot: async () => null,
		});
		const registered = await service.registerProject({ name: "demo", path: project });
		if (!registered.ok) throw new Error(registered.code);
		const task = service.createTask(registered.value.id, { title: "t" });
		if (!task.ok) throw new Error(task.code);
		const before = readFileSync(join(root, "develop", "tasks.json"), "utf8");
		const scope = service.forLaunch(
			{ projectId: registered.value.id, launchDirectory: project },
			{
				launchId: "0123456789abcdef",
				attachment: "omp.saved",
				session: { source: "omp-saved", current: () => ({ sessionId: ID_A }) },
			},
		);
		expect(scope.linkCurrentSession(task.value.id, 0)).toEqual({ ok: false, code: "unsupported-source" });
		const omp = fresh("omp-beside-tasks");
		writeFileSync(join(omp, "a.jsonl"), session(ID_A));
		observer(omp).sessions();
		expect(readFileSync(join(root, "develop", "tasks.json"), "utf8")).toBe(before);
	});
});

describe("over HTTP", () => {
	it("answers one constant without --omp-sessions, and refuses a selector it did not give, a path or a query", async () => {
		const server = await serve(developStore());
		const absent = await get(server, "/api/v0/develop/omp/sessions");
		expect([absent.status, JSON.parse(absent.body)]).toEqual([
			200,
			{ schemaVersion: "endo.develop-omp-sessions.v0", available: false },
		]);
		expect((await get(server, `/api/v0/develop/omp/session/o1-${"0".repeat(32)}`)).status).toBe(404);
		const omp = fresh("http");
		writeFileSync(join(omp, "a.jsonl"), session(ID_A));
		const live = await serve(developStore(), { omp: observer(omp) });
		for (const route of [
			`develop/omp/session/o1-${"0".repeat(32)}`,
			"develop/omp/session/..%2Fa.jsonl",
			"develop/omp/session/a.jsonl",
			"develop/omp/sessions/extra",
			"develop/omp",
		])
			expect([route, (await get(live, `/api/v0/${route}`)).status]).toEqual([route, 404]);
		expect((await get(live, "/api/v0/develop/omp/sessions?x=1")).status).toBe(400);
		const post = await send(live, `${capabilityOf(live)}/api/v0/develop/omp/sessions`, {
			method: "POST",
			headers: { Origin: live.origin, "Content-Type": "application/json" },
			body: "{}",
		});
		expect(post.status).toBe(405);
	});

	it("serves no private OMP text through any Studio route, and the store's own routes are unchanged by it", async () => {
		const omp = fresh("http-privacy");
		mkdirSync(join(omp, `-home-${CANARY}`));
		writeFileSync(join(omp, `-home-${CANARY}`, `x_${ID_A}.jsonl`), session(ID_A));
		mkdirSync(join(omp, `-home-${CANARY}`, `x_${ID_A}`));
		writeFileSync(join(omp, `-home-${CANARY}`, `x_${ID_A}`, "1.bash.log"), `${CANARY} output`);
		const root = developStore();
		const before = manifest(omp);
		const plain = await serve(root);
		const server = await serve(root, { omp: observer(omp) });
		const list = await get(server, "/api/v0/develop/omp/sessions");
		expect(list.status).toBe(200);
		const selector = (JSON.parse(list.body) as EndoOmpSessionsV0).sessions[0]!.selector;
		const sessions = JSON.parse((await get(server, "/api/v0/develop/sessions")).body) as {
			sessions: { selector: string | null }[];
		};
		const recorded = sessions.sessions.find((r) => r.selector !== null)!.selector;
		const routes = [
			"develop/omp/sessions",
			`develop/omp/session/${selector}`,
			"snapshot?afterSequence=0&limit=10",
			"develop/sessions",
			`develop/session/${recorded}`,
			"compare/candidates",
		];
		for (const route of routes) {
			const reply = await get(server, `/api/v0/${route}`);
			expect([route, reply.status]).toEqual([route, 200]);
			expect(reply.body, route).not.toContain(CANARY);
			expect(reply.body, route).not.toContain(omp);
		}
		// The recorded-store routes answer exactly what a server without the observer answers.
		for (const route of ["develop/sessions", "compare/candidates"]) {
			const a = JSON.parse((await get(plain, `/api/v0/${route}`)).body);
			const b = JSON.parse((await get(server, `/api/v0/${route}`)).body);
			expect(b, route).toEqual(a);
		}
		expect(manifest(omp)).toEqual(before);
	});

	it("refuses an OMP directory that overlaps the store or would receive Studio's key, before anything is created", async () => {
		const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
			buildStudioUi(outDir: string): Promise<unknown>;
		};
		const ui = join(fresh("ui"), "built");
		await buildStudioUi(ui);
		const omp = fresh("overlap");
		const opener = { root: omp, open: () => observer(omp) };
		const keyFile = join(fresh("k"), "key");
		await expect(
			launchEndoCockpitV0({ root: join(omp, "store"), uiDirectory: ui, keyFile, omp: opener }),
		).rejects.toThrow(/the OMP sessions directory and the store overlap/);
		const store = fresh("store-around");
		const inner = join(store, "omp");
		mkdirSync(inner);
		await expect(
			launchEndoCockpitV0({
				root: store,
				uiDirectory: ui,
				keyFile,
				omp: { root: inner, open: () => observer(inner) },
			}),
		).rejects.toThrow(/overlap/);
		await expect(
			launchEndoCockpitV0({ root: fresh("store"), uiDirectory: ui, keyFile: join(omp, "studio-key"), omp: opener }),
		).rejects.toThrow(/inside the OMP sessions directory/);
		expect(readdirSync(omp)).toEqual([]);
		expect(readdirSync(dirname(keyFile))).toEqual([]);
	}, 90_000);
});

describe("found by the independent review, and fixed", () => {
	it("counts duplicate ids from the same full reads: a blank line before the header, or a title slot it does not know, changes nothing", () => {
		const root = fresh("dup-blank");
		const odd = `${titleSlot()}\n${header(ID_A)}${conversation().text}`;
		writeFileSync(join(root, "one.jsonl"), odd);
		writeFileSync(join(root, "two.jsonl"), odd);
		// A file the reader refuses (a title slot of another version) does not take a valid file's key away.
		writeFileSync(join(root, "three.jsonl"), session(ID_B));
		writeFileSync(
			join(root, "zz-v2-slot.jsonl"),
			`${JSON.stringify({ type: "title", v: 2, title: CANARY })}\n${header(ID_B)}${conversation().text}`,
		);
		const rows = listOf(root).sessions;
		expect(rows.map((r) => [r.state, r.key])).toEqual([
			["readable", { status: "unavailable", reason: "duplicate-id" }],
			["readable", { status: "established", id: ID_B }],
			["readable", { status: "unavailable", reason: "duplicate-id" }],
			["unsupported-version", { status: "unavailable", reason: "no-header" }],
		]);
		// The list validator refuses two established rows with one key, whatever produced them.
		const forged = structuredClone(listOf(root));
		forged.sessions[0]!.key = { status: "established", id: ID_A };
		forged.sessions[2]!.key = { status: "established", id: ID_A };
		expect(() => validateEndoOmpSessionsV0(forged)).toThrow(/established key repeats/);
	});

	it("withholds a model name that is a path or a model file, a tool name that is not OMP's own, and an exit reason it does not know", () => {
		const root = fresh("grammar-canaries");
		const lower = "canary-omp-private";
		const lines = [
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-10-01T10:00:01.000Z",
				model: `llama.cpp//home/${lower}/x.gguf`,
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-10-01T10:00:02.000Z",
				message: {
					role: "assistant",
					provider: "llama.cpp",
					model: `/home/${lower}/models/client.gguf`,
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id: "c1", name: `mcp_${lower}_lookup`, arguments: {} },
						{ type: "toolCall", id: "c2", name: "read", arguments: {} },
					],
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "m3",
				parentId: "m2",
				timestamp: "2026-10-01T10:00:03.000Z",
				message: {
					role: "assistant",
					provider: "llama.cpp",
					model: `${lower}-weights.gguf`,
					stopReason: "stop",
					content: [],
					timestamp: 2,
				},
			},
			{
				type: "custom",
				id: "m4",
				parentId: "m3",
				timestamp: "2026-10-01T10:00:04.000Z",
				customType: "session_exit",
				data: { kind: "normal", reason: lower, recordedAt: "2026-10-01T10:00:04.000Z" },
			},
		];
		writeFileSync(
			join(root, "a.jsonl"),
			`${titleSlot()}${header(ID_A)}${lines.map((l) => `${JSON.stringify(l)}\n`).join("")}`,
		);
		const list = listOf(root);
		const detail = observer(root).session(list.sessions[0]!.selector)!;
		const text = JSON.stringify([list, detail]);
		expect(text).not.toContain(lower);
		expect(text).not.toContain("/home/");
		expect(detail.activity.map((a) => a.model)).toEqual([null, null, null, null]);
		expect(detail.activity[1]!.tools).toEqual(["(withheld name)", "read"]);
		expect(list.sessions[0]!.exit).toEqual({ kind: "normal", reason: null, at: "2026-10-01T10:00:04.000Z" });
	});

	it("bounds a file by its lines as well as its bytes, and a file over its own bound is too large", () => {
		const root = fresh("bounds");
		writeFileSync(join(root, "lines.jsonl"), `${header(ID_A)}${"\n".repeat(400_001)}`);
		expect(listOf(root).sessions[0]!.state).toBe("too-large");
		expect(readOmpFileV0(join(root, "lines.jsonl"), 1000)).toEqual({ ok: false, state: "too-large" });
	});

	it("lists past an unreadable directory, counts it, and stops at the file limit", () => {
		const root = fresh("unreadable-dir");
		writeFileSync(join(root, `a_${ID_A}.jsonl`), session(ID_A));
		const locked = join(root, "locked");
		mkdirSync(locked);
		writeFileSync(join(locked, "b.jsonl"), session(ID_B));
		chmodSync(locked, 0o000);
		try {
			const list = listOf(root);
			if (process.getuid?.() !== 0) expect(list.skipped.unreadable).toBe(1);
			expect(list.sessions.some((r) => r.key.status === "established" && r.key.id === ID_A)).toBe(true);
		} finally {
			chmodSync(locked, 0o755);
		}
		const many = fresh("many");
		for (let i = 0; i < 201; i += 1)
			writeFileSync(join(many, `${String(i).padStart(3, "0")}.jsonl`), header(`id-${i}`));
		const list = listOf(many);
		expect([list.sessions.length, list.skipped.overLimit]).toEqual([200, 1]);
	});

	it("does not claim OMP's exit when an unfinished line follows it, and reads a final developer message as an open turn", () => {
		const exited = Buffer.from(`${session(ID_A)}{"type":"message","id":"late"`);
		expect(reduceOmpJournalV0(exited).row).toMatchObject({ tail: "pending", exit: null });
		const dev = `${header(ID_A)}${JSON.stringify({ type: "message", id: "d1", parentId: null, timestamp: "2026-10-01T10:00:01.000Z", message: { role: "developer", content: "x", timestamp: 1 } })}\n`;
		expect(reduceOmpJournalV0(Buffer.from(dev)).row.turn).toBe("open");
	});

	it("names no runtime when no entry records one, and calls an unknown exit kind an end, not an interruption", () => {
		const root = fresh("runtime");
		const noVersion = session(ID_A)
			.replace(/,?"runtime":\{"version":"18\.14\.1"\}/g, "")
			.replace('"kind":"normal"', '"kind":"crashed"');
		writeFileSync(join(root, "a.jsonl"), noVersion);
		const row = listOf(root).sessions[0]!;
		expect(row.runtimeVersions).toEqual([]);
		const entry = presentOmpSaved(row);
		expect(entry.runtime.status).toBe("unavailable");
		expect(entry.status).toEqual([{ state: "ended", basis: "reported", by: "omp", at: "2026-10-01T10:00:40.000Z" }]);
		expect(endoDevelopSessionProblemV0(entry)).toBeNull();
	});

	it("charges the OMP routes to the server's read budget like every other read", async () => {
		const omp = fresh("budget");
		writeFileSync(join(omp, "a.jsonl"), session(ID_A));
		const server = await serve(developStore(), { omp: observer(omp), readBudget: { duty: 0.0001, burstMs: 0.01 } });
		const first = await get(server, "/api/v0/develop/omp/sessions");
		const second = await get(server, "/api/v0/develop/omp/sessions");
		expect([first.status, second.status]).toEqual([200, 429]);
	});
});

describe("contracts and layering", () => {
	it("the browser's closed lists equal the protocol's", () => {
		expect(OMP_FILE_STATES).toEqual(ENDO_OMP_FILE_STATES_V0);
		expect(OMP_KEY_REASONS).toEqual(ENDO_OMP_KEY_REASONS_V0);
		expect(OMP_STOP_REASONS).toEqual(ENDO_OMP_STOP_REASONS_V0);
		expect(OMP_EXIT_KINDS).toEqual(ENDO_OMP_EXIT_KINDS_V0);
		expect(OMP_ACTIVITY_KINDS).toEqual(ENDO_OMP_ACTIVITY_KINDS_V0);
	});

	it("the adapter reaches only node:, the protocol and core contracts; only the CLI composition imports it", () => {
		const read = (file: string) => readFileSync(join(REPO, file), "utf8");
		const specs = (text: string) =>
			[
				...text.matchAll(
					/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g,
				),
			].map((m) => m[1] ?? m[2]!);
		for (const file of ["adapters/omp/journal.ts", "adapters/omp/observer.ts"])
			for (const spec of specs(read(file)))
				expect(spec, file).toMatch(
					/^(node:[a-z_/]+|\.\/[a-z-]+\.ts|\.\.\/\.\.\/protocol\/[a-z-]+\.ts|\.\.\/\.\.\/runtime\/contracts\/[a-z-]+\.ts)$/,
				);
		for (const file of ["adapters/omp/journal.ts", "adapters/omp/observer.ts"])
			expect(read(file)).not.toMatch(
				/writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|openSync\([^)]*O_(WRONLY|RDWR|CREAT)|child_process|spawn|fetch\(|node:net|node:http/,
			);
		expect(specs(read("protocol/omp-observation.ts"))).toEqual(["./primitives.ts"]);
		const importers: string[] = [];
		const walk = (dir: string): string[] =>
			readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((e) =>
				e.isDirectory()
					? e.name === "node_modules" || e.name === "dist"
						? []
						: walk(join(dir, e.name))
					: [join(dir, e.name)],
			);
		for (const dir of [
			"protocol",
			"runtime",
			"storage",
			"cockpit",
			"cockpit-http",
			"studio-ui/src",
			"adapters",
			"cli",
		])
			for (const file of walk(dir).filter((f) => /\.(ts|tsx)$/.test(f)))
				if (!file.startsWith("adapters/omp/") && specs(read(file)).some((s) => /adapters\/omp\//.test(s)))
					importers.push(file);
		expect(importers).toEqual(["cli/develop-tasks.ts", "cli/studio.ts"]);
	});
});
