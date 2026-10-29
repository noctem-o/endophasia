// DEVELOP session desk, server side: the projection (pure, over real stores), its protocol validators and the GET routes.
// Isolated temporary stores only. Nothing here starts an agent, attaches to anything or writes to a store it reads.
import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { canonicalEndoJsonV0, readEndoCockpitObservationV0, readEndoCockpitRecordV0 } from "../cockpit/index.ts";
import { EndoCockpitComparisonRefusalV0 } from "../cockpit-http/comparison.ts";
import {
	projectEndoCockpitDevelopSessionsV0,
	projectEndoCockpitDevelopSessionV0,
	readEndoCockpitDevelopSessionsV0,
	readEndoCockpitDevelopSessionV0,
} from "../cockpit-http/develop.ts";
import {
	ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0,
	ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0,
	type EndoCockpitDevelopSessionsV0,
	type EndoCockpitDevelopSessionV0,
	validateEndoCockpitDevelopSessionsV0,
	validateEndoCockpitDevelopSessionV0,
} from "../protocol/cockpit-develop.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import { event, ingestAll, lifecycleEvents, removeTempRoots, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { compareEvents, comparePiEvents } from "./studio-compare-fixtures.ts";

const key = OTHER_KEY;
const CANARY = "CANARY-7c1e-develop-leak";
const SESSIONS = "/api/v0/develop/sessions";
const ONE = "/api/v0/develop/session/";

afterEach(async () => {
	await stopServers();
});
afterAll(() => removeTempRoots((root) => rmSync(root, { recursive: true, force: true })));

function seed(events: readonly EndoEventV0[] = compareEvents()): string {
	const root = tempRoot("endo-develop-");
	ingestAll(root, events);
	return root;
}
const list = (root: string, cursor?: string) => readEndoCockpitDevelopSessionsV0(root, key, cursor);
const detail = (root: string, selector: string, cursor?: string) =>
	readEndoCockpitDevelopSessionV0(root, key, selector, cursor);
const selectorOf = (record: EndoCockpitDevelopSessionsV0, session: string): string => {
	const row = record.sessions.find((r) => r.session === session);
	if (row?.selector == null) throw new Error(`no selectable ${session}`);
	return row.selector;
};
const refusal = (run: () => unknown): string | null => {
	try {
		run();
		return null;
	} catch (error) {
		return error instanceof EndoCockpitComparisonRefusalV0 ? error.refusal : `other:${(error as Error).message}`;
	}
};

describe("DEVELOP session inventory", () => {
	it("lists Pi and DSH recordings with the lifecycle state as recorded, counts and positions, and validates", () => {
		const record = list(seed());
		expect(validateEndoCockpitDevelopSessionsV0(record)).not.toBeNull();
		expect(readEndoCockpitRecordV0(record).ok).toBe(true);
		expect(record.consistency).toBe("single-event-log-observation");
		expect(record.sessions.map((r) => [r.source, r.session, r.qualification])).toEqual([
			["dsh", "endo.session.dsh.session-1", "inspectable"],
			["pi", "endo.session.pi.a", "inspectable"],
		]);
		const pi = record.sessions[1]!;
		expect(pi).toMatchObject({
			label: "Pi recording",
			events: 39,
			firstStorageSequence: 1,
			lastStorageSequence: 39,
			recorded: { state: "detached", lastRunOutcome: "completed", runs: 1, turns: 2 },
		});
		expect(record.sessions[0]!.recorded).toMatchObject({ state: "idle", lastRunOutcome: "completed" });
		expect(record.source.condition.state).toBe("readable");
		expect(record.generation).toMatch(/^[0-9a-f]{64}$/);
		expect(record.otherSessions).toBe(0);
	});

	it("is deterministic and ordered by source then alias, whatever the order of the log", () => {
		const events = [
			...comparePiEvents("baseline", "endo.session.pi.z"),
			...compareEvents(),
			...comparePiEvents("baseline", "endo.session.pi.m"),
		];
		const root = seed(events);
		const a = canonicalEndoJsonV0(list(root) as never);
		const b = canonicalEndoJsonV0(list(root) as never);
		expect(a).toBe(b);
		expect(list(root).sessions.map((r) => r.session)).toEqual([
			"endo.session.dsh.session-1",
			"endo.session.pi.a",
			"endo.session.pi.m",
			"endo.session.pi.z",
		]);
	});

	it("reports absent and unopenable stores as their own condition, never as an empty list", () => {
		const absent = tempRoot("endo-develop-absent-");
		const none = list(absent);
		expect(none.source.condition.state).toBe("absent");
		expect(none).toMatchObject({ generation: null, sessions: [], page: { total: 0, hasMore: false } });
		expect(validateEndoCockpitDevelopSessionsV0(none)).not.toBeNull();
		const broken = seed();
		appendFileSync(join(broken, "events", "events.log"), endoFrameBytesV0(new TextEncoder().encode("{}")));
		const unopenable = list(broken);
		expect(unopenable.source.condition.state).toBe("unopenable");
		expect(unopenable.source.watermark).toBeNull();
		expect(unopenable).toMatchObject({ generation: null, sessions: [] });
		expect(validateEndoCockpitDevelopSessionsV0(unopenable)).not.toBeNull();
	});

	it("lists the verified prefix of a degraded log and says so; a selected session carries the condition", () => {
		const root = seed();
		appendFileSync(join(root, "events", "events.log"), Buffer.from([0x00, 0x00, 0x00, 0x20, 0x7b, 0x22]));
		const record = list(root);
		expect(record.source.condition.state).toBe("degraded");
		expect(record.source.condition.tornTail?.bytes).toBeGreaterThan(0);
		expect(record.sessions).toHaveLength(2);
		const one = detail(root, selectorOf(record, "endo.session.pi.a"));
		expect(one.source.condition.state).toBe("degraded");
		expect(validateEndoCockpitDevelopSessionV0(one)).not.toBeNull();
	});

	it("distinguishes ambiguous Pi attachments and incomplete DSH imports, and never gives them a selector", () => {
		const second = comparePiEvents("baseline", "endo.session.pi.a").map((e, i) => ({
			...e,
			id: `endo.event.second.${i}`,
			producer: e.producer.replace("pi.default", "pi.second"),
		}));
		const incomplete = compareEvents().filter((e) => e.kind !== "dsh.import-checkpoint");
		const record = list(seed([...incomplete, ...second]));
		const rows = Object.fromEntries(record.sessions.map((r) => [r.source, r]));
		expect(rows.pi).toMatchObject({
			qualification: "ambiguous",
			reason: "several-attachments",
			selector: null,
			recorded: null,
		});
		expect(rows.dsh).toMatchObject({
			qualification: "insufficient",
			reason: "import-incomplete",
			selector: null,
			recorded: null,
		});
		// What does not depend on the qualification is still shown.
		expect(rows.pi!.events).toBeGreaterThan(0);
		expect(validateEndoCockpitDevelopSessionsV0(record)).not.toBeNull();
	});

	it("reduces interrupted, detached and open runs exactly as the lifecycle reducer does, and counts other sessions", () => {
		for (const name of ["completes", "killed-and-resumed", "stop-mid-turn"]) {
			const expected = JSON.parse(
				readFileSync(
					new URL(`./fixtures/pi-lifecycle/fake-pi-1.0.0/${name}.overview.json`, import.meta.url),
					"utf8",
				),
			) as { state: string; counts: { runs: number; turns: number } };
			const events = lifecycleEvents(name);
			const record = list(seed(events));
			const rows = record.sessions.filter((r) => r.recorded !== null);
			if (rows.length === 0) {
				// A lifecycle-only fixture is not a recording: counted, never listed.
				expect(record.otherSessions).toBeGreaterThan(0);
				continue;
			}
			expect(rows[0]!.recorded!.state).toBe(expected.state);
			expect(rows[0]!.recorded).toMatchObject({ runs: expected.counts.runs, turns: expected.counts.turns });
		}
	});

	it("keeps an unrecognised lifecycle kind visible as a count and does not fail the listing", () => {
		const root = seed(comparePiEvents("unknown-lifecycle", "endo.session.pi.u"));
		const record = list(root);
		const one = detail(root, selectorOf(record, "endo.session.pi.u"));
		expect(one.lifecycle!.unrecognized + one.lifecycle!.anomalies).toBeGreaterThan(0);
		expect(validateEndoCockpitDevelopSessionV0(one)).not.toBeNull();
	});

	it("is never fatal for one malformed recording: it degrades that row only", () => {
		const events = [
			...compareEvents(),
			event("harness.attached", {}, { session: "endo.session.pi.broken", producer: "pi-rpc-adapter:pi.default" }),
		];
		const record = list(seed(events));
		expect(record.sessions.map((r) => r.session)).toContain("endo.session.pi.broken");
		expect(validateEndoCockpitDevelopSessionsV0(record)).not.toBeNull();
	});

	it("never carries a canary planted in a payload, an id or a path", () => {
		const base = comparePiEvents("baseline", "endo.session.pi.p");
		const planted: EndoEventV0[] = base.map((e) =>
			e.kind === "tool.started"
				? {
						...e,
						payload: {
							...(e.payload as Record<string, never>),
							args: { secret: CANARY },
							command: `/home/${CANARY}/x`,
						},
					}
				: e.kind === "harness.attached"
					? {
							...e,
							payload: {
								...(e.payload as Record<string, never>),
								piSessionId: `raw-${CANARY}`,
								cwd: `/srv/${CANARY}`,
							},
						}
					: e,
		);
		const root = seed([...planted, ...compareEvents()]);
		const sessions = list(root);
		const one = detail(root, selectorOf(sessions, "endo.session.pi.p"));
		const everything = JSON.stringify([sessions, one]);
		expect(everything).not.toContain(CANARY);
		expect(everything).not.toContain(root);
		expect(everything).not.toMatch(/\/home\/|\/srv\//);
	});

	it("leaves out an unavailable-field name the boundary does not admit instead of failing the session", () => {
		const base = comparePiEvents("baseline", "endo.session.pi.g");
		const events: EndoEventV0[] = base.map((e) =>
			e.kind === "lifecycle.session-started"
				? {
						...e,
						payload: {
							...(e.payload as Record<string, never>),
							unavailable: [
								{ field: `/home/${CANARY}/path`, reason: "gone" },
								{ field: "cost", reason: "the runtime reports none" },
							],
						},
					}
				: e,
		);
		const root = seed(events);
		const one = detail(root, selectorOf(list(root), "endo.session.pi.g"));
		expect(one.lifecycle!.unavailable.map((u) => u.field)).toEqual(["cost"]);
		expect(JSON.stringify(one)).not.toContain(CANARY);
		expect(validateEndoCockpitDevelopSessionV0(one)).not.toBeNull();
	});

	it("pages the inventory with a cursor bound to its purpose and generation", () => {
		const many = Array.from({ length: 120 }, (_, i) =>
			comparePiEvents("baseline", `endo.session.pi.s${String(i).padStart(3, "0")}`),
		);
		const root = seed(many.flat());
		const first = list(root);
		expect(first.sessions).toHaveLength(ENDO_COCKPIT_DEVELOP_SESSIONS_PAGE_SIZE_V0);
		expect(first.page).toMatchObject({ offset: 0, total: 120, hasMore: true });
		const second = list(root, first.page.nextCursor!);
		const third = list(root, second.page.nextCursor!);
		expect([second.page.offset, third.page.offset, third.page.hasMore]).toEqual([50, 100, false]);
		expect(third.sessions).toHaveLength(20);
		expect(validateEndoCockpitDevelopSessionsV0(third)).not.toBeNull();
		const seen = [...first.sessions, ...second.sessions, ...third.sessions].map((r) => r.session);
		expect(new Set(seen).size).toBe(120);
		// A cursor from another log, a tampered one, one past the end and a Compare cursor are all refused.
		const other = seed(many.slice(0, 60).flat());
		expect(refusal(() => list(other, first.page.nextCursor!))).toBe("continuation-invalid");
		expect(refusal(() => list(root, `s1-50-${"0".repeat(64)}`))).toBe("continuation-invalid");
		expect(refusal(() => list(root, `s1-150-${"0".repeat(64)}`))).toBe("continuation-invalid");
		expect(() => list(root, `p1-100-${"0".repeat(64)}`)).toThrow("invalid sessions cursor");
		expect(() => list(root, `s1-7-${"0".repeat(64)}`)).toThrow("invalid sessions cursor");
	});
});

function longSession(session: string, filler: number): EndoEventV0[] {
	const base = comparePiEvents("baseline", session);
	const at = base.findIndex((e) => e.kind === "harness.catch-up");
	const template = base.find((e) => e.kind === "session.entry-observed")!;
	const extra = Array.from({ length: filler }, (_, i) => ({
		...template,
		id: `endo.event.filler.${session.slice(13)}.${i}`,
		sequence: 1000 + i,
	}));
	return [...base.slice(0, at), ...extra, ...base.slice(at)];
}

describe("DEVELOP session detail", () => {
	it("gives identity, recorded lifecycle, per-run usage as reported, counts and the timeline's own entries", () => {
		const root = seed();
		const sessions = list(root);
		const one = detail(root, selectorOf(sessions, "endo.session.pi.a"));
		expect(validateEndoCockpitDevelopSessionV0(one)).not.toBeNull();
		expect(readEndoCockpitRecordV0(one).ok).toBe(true);
		expect(one.attachment).toBe("pi.default");
		expect(one.session.recorded).toMatchObject({ state: "detached" });
		expect(one.lifecycle!.counts).toMatchObject({ runs: 1, turns: 2, completed: 1 });
		expect(one.runs).toMatchObject({
			status: "reported",
			total: 1,
			entries: [{ run: 1, outcome: "completed", tokens: { status: "reported" }, wallMs: { status: "reported" } }],
		});
		expect(one.activity.total).toBe(39);
		expect(one.activity.entries).toHaveLength(39);
		expect(Object.values(one.activity.byCategory).reduce((a, b) => a + b, 0)).toBe(39);
		expect(one.activity.tools).toEqual({ calls: 2, errors: 0 });
		expect(one.activity.entries.every((e) => e.sessionId === "endo.session.pi.a")).toBe(true);
		// A DSH recording has no attachment and says its usage is unavailable instead of inventing it.
		const dsh = detail(root, selectorOf(sessions, "endo.session.dsh.session-1"));
		expect(dsh.attachment).toBeNull();
		expect(dsh.runs.status === "reported" && dsh.runs.entries[0]!.tokens.status).toBe("unavailable");
	});

	it("pages a long session in storage order and binds every cursor to generation, session and purpose", () => {
		const root = seed([...longSession("endo.session.pi.long", 230), ...compareEvents()]);
		const sessions = list(root);
		const selector = selectorOf(sessions, "endo.session.pi.long");
		const first = detail(root, selector);
		const size = ENDO_COCKPIT_DEVELOP_ACTIVITY_PAGE_SIZE_V0;
		expect(first.activity.entries).toHaveLength(size);
		expect(first.activity.page).toMatchObject({ offset: 0, hasMore: true });
		const second = detail(root, selector, first.activity.page.nextCursor!);
		const third = detail(root, selector, second.activity.page.nextCursor!);
		const all = [...first.activity.entries, ...second.activity.entries, ...third.activity.entries];
		expect(all).toHaveLength(first.activity.total);
		expect(all.every((e, i) => i === 0 || e.storageSequence > all[i - 1]!.storageSequence)).toBe(true);
		expect(third.activity.page.hasMore).toBe(false);
		expect(validateEndoCockpitDevelopSessionV0(third)).not.toBeNull();
		// The cursor is bound to this session: the same cursor on another selector is refused.
		const other = selectorOf(sessions, "endo.session.pi.a");
		expect(refusal(() => detail(root, other, first.activity.page.nextCursor!))).toBe("continuation-invalid");
		expect(() => detail(root, selector, `s1-100-${"0".repeat(64)}`)).toThrow("invalid activity cursor");
	});

	it("invalidates every selector and cursor when the log changes, and refuses foreign or non-inspectable ones", () => {
		const root = seed([...longSession("endo.session.pi.long", 230), ...compareEvents()]);
		const sessions = list(root);
		const selector = selectorOf(sessions, "endo.session.pi.long");
		const cursor = detail(root, selector).activity.page.nextCursor!;
		appendFileSync(join(root, "events", "events.log"), "");
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.other", producer: "pi-lifecycle:pi.default" }),
		]);
		expect(refusal(() => detail(root, selector))).toBe("not-found");
		expect(refusal(() => detail(root, selector, cursor))).toBe("not-found");
		expect(refusal(() => list(root, sessions.page.nextCursor ?? `s1-50-${"0".repeat(64)}`))).toBe(
			"continuation-invalid",
		);
		// A selector of another purpose (Compare's) never resolves.
		expect(() => detail(root, `c1-${"0".repeat(64)}`)).toThrow("invalid session selector");
	});

	it("is a pure function of the observation: the same bytes twice, and no access to anything but the supplied log", () => {
		const root = seed();
		const observation = readEndoCockpitObservationV0(root, key);
		const a = projectEndoCockpitDevelopSessionsV0(observation, key);
		const b = projectEndoCockpitDevelopSessionsV0(observation, key);
		expect(canonicalEndoJsonV0(a as never)).toBe(canonicalEndoJsonV0(b as never));
		const selector = a.sessions[1]!.selector!;
		const x = projectEndoCockpitDevelopSessionV0(observation, key, selector);
		const y = projectEndoCockpitDevelopSessionV0(observation, key, selector);
		expect(canonicalEndoJsonV0(x as never)).toBe(canonicalEndoJsonV0(y as never));
	});
});

describe("DEVELOP protocol validators", () => {
	it("refuse a record that contradicts itself", () => {
		const root = seed();
		const sessions = list(root);
		const one = detail(root, selectorOf(sessions, "endo.session.pi.a"));
		const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
		const bad = (mutate: (r: EndoCockpitDevelopSessionsV0) => void) => {
			const r = clone(sessions);
			mutate(r);
			return validateEndoCockpitDevelopSessionsV0(r);
		};
		expect(
			bad((r) => {
				r.sessions[0]!.selector = null;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.sessions[0]!.qualification = "ambiguous";
			}),
		).toBeNull();
		expect(bad((r) => r.sessions.reverse())).toBeNull();
		expect(
			bad((r) => {
				r.page.total = 5;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.generation = null;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.sessions[0]!.lastStorageSequence = 10_000;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r as unknown as { extra: number }).extra = 1;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.sessions[0]!.recorded = { state: "not-observed", lastRunOutcome: "completed", runs: 0, turns: 0 };
			}),
		).toBeNull();
		const badDetail = (mutate: (r: EndoCockpitDevelopSessionV0) => void) => {
			const r = clone(one);
			mutate(r);
			return validateEndoCockpitDevelopSessionV0(r);
		};
		expect(
			badDetail((r) => {
				r.activity.entries[0]!.sessionId = "endo.session.other";
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				r.activity.total = 3;
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				r.activity.byCategory.tool += 1;
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				r.activity.entries[0]!.storageSequence = 7;
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				r.lifecycle!.counts.runs = 9;
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				r.session.qualification = "ambiguous";
			}),
		).toBeNull();
		expect(
			badDetail((r) => {
				(r.runs as { entries: { run: number }[] }).entries[0]!.run = 0;
			}),
		).toBeNull();
		expect(validateEndoCockpitDevelopSessionV0(one)).not.toBeNull();
	});

	it("loads in either import order (the protocol modules import each other's functions)", async () => {
		const develop = await import("../protocol/cockpit-develop.ts");
		const cockpit = await import("../protocol/cockpit.ts");
		const read = cockpit.readEndoCockpitRecordV0({ schemaVersion: "endo.cockpit-develop-sessions.v0" });
		// Known to the wire gate (so a malformed body is refused by its own validator), not an unsupported version.
		expect(read.ok).toBe(false);
		expect(JSON.stringify(read)).not.toContain("unsupported-version");
		expect(typeof develop.validateEndoCockpitDevelopSessionsV0).toBe("function");
	});
});

describe("DEVELOP HTTP routes", () => {
	it("serves both routes as validated GET records under the guards", async () => {
		const root = seed();
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 60_000 } });
		const res = await get(server, SESSIONS);
		expect(res.status).toBe(200);
		expect(res.headers["content-type"]).toMatch(/^application\/json/);
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["access-control-allow-origin"]).toBeUndefined();
		const record = JSON.parse(res.body) as EndoCockpitDevelopSessionsV0;
		expect(readEndoCockpitRecordV0(record).ok).toBe(true);
		const one = await get(server, `${ONE}${selectorOf(record, "endo.session.pi.a")}`);
		expect(one.status).toBe(200);
		expect(readEndoCockpitRecordV0(JSON.parse(one.body)).ok).toBe(true);
		expect(res.body).not.toContain(root);
	});

	it("refuses bad methods, origins, hosts, paths, queries, selectors and cursors with fixed codes", async () => {
		const root = seed([...longSession("endo.session.pi.long", 230), ...compareEvents()]);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 60_000 } });
		const record = JSON.parse((await get(server, SESSIONS)).body) as EndoCockpitDevelopSessionsV0;
		const selector = selectorOf(record, "endo.session.pi.long");
		const cap = capabilityOf(server);
		const code = (r: { status: number; body: string }) => [r.status, (JSON.parse(r.body) as { error: string }).error];
		expect(code(await send(server, `${cap}${SESSIONS}`, { method: "POST" }))).toEqual([405, "method-not-allowed"]);
		expect((await send(server, `${cap}${SESSIONS}`, { method: "HEAD" })).status).toBe(405);
		expect(code(await get(server, SESSIONS, { Origin: "http://evil.example" }))).toEqual([403, "forbidden"]);
		expect(code(await get(server, SESSIONS, { "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "forbidden"]);
		expect(code(await send(server, `${cap}${SESSIONS}`, { headers: { Host: "evil.example" } }))).toEqual([
			421,
			"misdirected-request",
		]);
		for (const route of [
			"/api/v0/develop",
			"/api/v0/develop/",
			`${SESSIONS}/extra`,
			"/api/v0/develop/session",
			`${ONE}${selector}/extra`,
			`${ONE}d1-short`,
			`${ONE}c1-${"0".repeat(64)}`,
			`${ONE}D1-${"0".repeat(64)}`,
			"/api/v0/develop/sessions%2f..",
			"/api/v1/develop/sessions",
		])
			expect((await get(server, route)).status, route).toBe(404);
		for (const query of [
			"?x=1",
			"?cursor=",
			"?cursor=bad",
			`?cursor=p1-100-${"0".repeat(64)}`,
			`?cursor=s1-7-${"0".repeat(64)}`,
			"?afterSequence=1",
		])
			expect((await get(server, `${SESSIONS}${query}`)).status, query).toBe(400);
		expect((await get(server, `${ONE}${selector}?cursor=s1-50-${"0".repeat(64)}`)).status).toBe(400);
		expect(code(await get(server, `${SESSIONS}?cursor=s1-50-${"0".repeat(64)}`))).toEqual([
			409,
			"continuation-invalid",
		]);
		expect(code(await get(server, `${ONE}d1-${"0".repeat(64)}`))).toEqual([404, "not-found"]);
		// Without the capability nothing answers.
		expect((await send(server, SESSIONS)).status).toBe(404);
	});

	it("is charged against the read budget like every other read", async () => {
		const server = await serve(seed(), { readBudget: { duty: 0.0001, burstMs: 0.01 } });
		expect((await get(server, SESSIONS)).status).toBe(200);
		const limited = await get(server, SESSIONS);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
	});

	it("never writes: the store is byte-for-byte unchanged and nothing is created beside it", async () => {
		const root = seed([...longSession("endo.session.pi.long", 230), ...compareEvents()]);
		const before = treeHash(root);
		const names = readdirSync(root).sort();
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 60_000 } });
		const record = JSON.parse((await get(server, SESSIONS)).body) as EndoCockpitDevelopSessionsV0;
		const selector = selectorOf(record, "endo.session.pi.long");
		const page = JSON.parse((await get(server, `${ONE}${selector}`)).body) as EndoCockpitDevelopSessionV0;
		await get(server, `${ONE}${selector}?cursor=${page.activity.page.nextCursor}`);
		await get(server, `${ONE}d1-${"0".repeat(64)}`);
		expect(treeHash(root)).toBe(before);
		expect(readdirSync(root).sort()).toEqual(names);
	});

	it("reads an absent store as a condition, not an error, and creates nothing", async () => {
		const root = tempRoot("endo-develop-http-absent-");
		const before = readdirSync(root);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 60_000 } });
		const res = await get(server, SESSIONS);
		expect(res.status).toBe(200);
		expect((JSON.parse(res.body) as EndoCockpitDevelopSessionsV0).source.condition.state).toBe("absent");
		expect(readdirSync(root)).toEqual(before);
	});
});
