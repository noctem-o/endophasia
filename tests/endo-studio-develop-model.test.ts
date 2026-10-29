// DEVELOP frontend, pure parts: the browser wire gate and the reducer, against real server records and one-field mutations of them.
import { describe, expect, it } from "vitest";
import {
	type DevelopState,
	developFiltersActive,
	filterRows,
	groupBySource,
	initialDevelop,
	listCoverage,
	NO_DEVELOP_FILTERS,
	reduceDevelop,
	STATE_WORDING,
} from "../studio-ui/src/model/develop.ts";
import {
	activityCursor,
	developFailure,
	developSelector,
	readDevelopSession,
	readDevelopSessions,
	sessionsCursor,
} from "../studio-ui/src/model/develop-wire.ts";
import { developRecords } from "./studio-develop-fixtures.ts";

const { sessions, session, selectorOf } = developRecords();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const LONG = "endo.session.pi.long";
const at = new Date(0);

function listed(): DevelopState {
	let s = reduceDevelop(initialDevelop(), { type: "start", id: 1, read: { kind: "list" } });
	s = reduceDevelop(s, { type: "finish", id: 1, reply: { kind: "sessions", record: sessions }, now: 0, at });
	return s;
}
function opened(alias = LONG): DevelopState {
	let s = reduceDevelop(listed(), { type: "select", selector: selectorOf(alias) });
	s = reduceDevelop(s, {
		type: "start",
		id: 2,
		read: { kind: "session", selector: selectorOf(alias), generation: sessions.generation! },
	});
	return reduceDevelop(s, { type: "finish", id: 2, reply: { kind: "session", record: session(alias) }, now: 0, at });
}

describe("the wire gate", () => {
	it("accepts the server's real records and nothing else", () => {
		expect(readDevelopSessions(clone(sessions))).not.toBeNull();
		expect(readDevelopSession(clone(session("endo.session.pi.a")))).not.toBeNull();
		expect(readDevelopSession(clone(session("endo.session.dsh.session-1")))).not.toBeNull();
		for (const hostile of [null, 1, "x", [], {}, { schemaVersion: "endo.cockpit-develop-sessions.v0" }]) {
			expect(readDevelopSessions(hostile)).toBeNull();
			expect(readDevelopSession(hostile)).toBeNull();
		}
	});

	it("refuses a record whose version, shape, pairing, order or page contradicts itself", () => {
		const bad = (mutate: (r: typeof sessions) => void) => {
			const r = clone(sessions);
			mutate(r);
			return readDevelopSessions(r);
		};
		expect(
			bad((r) => {
				(r as { projectionVersion: string }).projectionVersion = "cockpit-develop-sessions.2";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r as { consistency: string }).consistency = "atomic";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r.sessions[0] as { selector: string | null }).selector = null;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r.sessions[0] as { label: string }).label = "Pi recording";
			}),
		).toBeNull();
		expect(bad((r) => r.sessions.reverse())).toBeNull();
		expect(
			bad((r) => {
				r.page.hasMore = !r.page.hasMore;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.page.total += 1;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r.sessions[0] as { session: string }).session = "not a session";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r.sessions[0] as { lastRecordedAt: string }).lastRecordedAt = "yesterday";
			}),
		).toBeNull();
		expect(
			bad((r) => {
				(r.sessions[0] as { extra?: number }).extra = 1;
			}),
		).toBeNull();
		expect(
			bad((r) => {
				r.generation = null;
			}),
		).toBeNull();
		const one = (mutate: (r: ReturnType<typeof session>) => void) => {
			const r = clone(session("endo.session.pi.a"));
			mutate(r);
			return readDevelopSession(r);
		};
		expect(
			one((r) => {
				r.activity.entries[0]!.sessionId = "endo.session.pi.other";
			}),
		).toBeNull();
		expect(
			one((r) => {
				(r.activity.entries[1] as { storageSequence: number }).storageSequence = 1;
			}),
		).toBeNull();
		expect(
			one((r) => {
				(r.activity.entries[0] as { fields: unknown }).fields = null;
			}),
		).toBeNull();
		expect(
			one((r) => {
				(r.activity.page as { limit: number }).limit = 99;
			}),
		).toBeNull();
		expect(
			one((r) => {
				(r.lifecycle as { open: unknown }).open = 3;
			}),
		).toBeNull();
		expect(
			one((r) => {
				r.session.recorded = null;
			}),
		).toBeNull();
	});

	it("recognises only well-formed opaque tokens", () => {
		expect(developSelector(`d1-${"a".repeat(64)}`)).toBe(true);
		for (const v of [`c1-${"a".repeat(64)}`, `d1-${"A".repeat(64)}`, "d1-short", 7, null, `d1-${"a".repeat(64)}/x`])
			expect(developSelector(v)).toBe(false);
		expect(sessionsCursor(`s1-50-${"a".repeat(64)}`)).toBe(true);
		expect(sessionsCursor(`s1-7-${"a".repeat(64)}`)).toBe(false);
		expect(sessionsCursor(`a1-100-${"a".repeat(64)}`)).toBe(false);
		expect(activityCursor(`a1-100-${"a".repeat(64)}`)).toBe(true);
		expect(activityCursor(`a1-50-${"a".repeat(64)}`)).toBe(false);
	});

	it("turns a failure into fixed text: 404 and 409 invalidate, 429 carries the pause, no body is shown", () => {
		const canary = { error: "<img src=x onerror=alert(1)>" };
		for (const status of [404, 409]) expect(developFailure(status, canary, null)).toMatchObject({ invalid: true });
		expect(developFailure(429, canary, "7")).toMatchObject({ invalid: false, retrySeconds: 7 });
		expect(developFailure(429, canary, "99999")).toMatchObject({ retrySeconds: null });
		expect(developFailure(500, canary, null).message).not.toContain("img");
		expect(developFailure(503, { error: "too-many-candidates" }, null).message).toContain("10,000");
	});
});

describe("the reducer", () => {
	it("holds one inventory, one selection and one detail, bound to one generation", () => {
		const s = opened();
		expect(s.selected).toBe(selectorOf(LONG));
		expect(s.detail?.session.session).toBe(LONG);
		expect(s.stage).toBe("activity");
		expect(s.request).toBeNull();
		expect(s.event).toBeNull();
	});

	it("opens an event only from the loaded activity, and closes it on request", () => {
		let s = opened();
		const first = s.detail!.activity.entries[3]!.storageSequence;
		s = reduceDevelop(s, { type: "event", sequence: first });
		expect(s.event).toBe(first);
		expect(reduceDevelop(s, { type: "event", sequence: 999_999 }).event).toBe(first);
		expect(reduceDevelop(s, { type: "event", sequence: null }).event).toBeNull();
	});

	it("appends activity pages in order and refuses a page that is not the next one", () => {
		let s = opened();
		const selector = s.selected!;
		const generation = s.detail!.generation;
		const cursor = s.detail!.activity.page.nextCursor!;
		s = reduceDevelop(s, { type: "start", id: 3, read: { kind: "events", selector, cursor, generation } });
		const next = session(LONG, cursor);
		const done = reduceDevelop(s, { type: "finish", id: 3, reply: { kind: "session", record: next }, now: 0, at });
		expect(done.detail!.activity.entries).toHaveLength(200);
		expect(done.detail!.activity.page.offset).toBe(100);
		// The same page applied twice does not belong to the held activity.
		const again = reduceDevelop(
			reduceDevelop(done, {
				type: "start",
				id: 4,
				read: { kind: "events", selector, cursor: done.detail!.activity.page.nextCursor!, generation },
			}),
			{ type: "finish", id: 4, reply: { kind: "session", record: next }, now: 0, at },
		);
		expect(again).toMatchObject({ invalid: true, inventory: null, selected: null, detail: null });
	});

	it("discards everything on 404/409 and offers rediscovery, but only keeps a stale read on an ordinary failure", () => {
		const s = opened();
		const started = reduceDevelop(s, { type: "start", id: 5, read: { kind: "list" } });
		const fail = (status: number) =>
			reduceDevelop(started, {
				type: "finish",
				id: 5,
				reply: developFailure(status, null, null),
				now: 0,
				at,
			});
		expect(fail(404)).toMatchObject({ invalid: true, inventory: null, selected: null, detail: null });
		expect(fail(409)).toMatchObject({ invalid: true, inventory: null });
		const kept = fail(500);
		expect(kept).toMatchObject({ invalid: false });
		expect(kept.inventory).not.toBeNull();
		expect(kept.problem).toContain("Retry explicitly");
		// A pause is a monotonic deadline, never a timer here.
		const paced = fail(429);
		expect(paced.problem).toContain("pacing");
		const withHold = reduceDevelop(started, {
			type: "finish",
			id: 5,
			reply: developFailure(429, null, "3"),
			now: 1000,
			at,
		});
		expect(withHold.holdUntil).toBe(4000);
	});

	it("ignores a late reply for a request that is no longer the current one", () => {
		const s = reduceDevelop(opened(), { type: "start", id: 9, read: { kind: "list" } });
		const cancelled = reduceDevelop(s, { type: "cancel" });
		expect(cancelled.request).toBeNull();
		expect(
			reduceDevelop(cancelled, { type: "finish", id: 9, reply: { kind: "sessions", record: sessions }, now: 0, at }),
		).toBe(cancelled);
	});

	it("keeps the selection across a refresh of the same verified log and drops it, with a sentence, when the log changed", () => {
		const s = opened();
		const same = reduceDevelop(reduceDevelop(s, { type: "start", id: 6, read: { kind: "list" } }), {
			type: "finish",
			id: 6,
			reply: { kind: "sessions", record: clone(sessions) },
			now: 0,
			at,
		});
		expect(same.selected).toBe(s.selected);
		expect(same.detail).not.toBeNull();
		const changed = clone(sessions);
		for (const row of changed.sessions)
			if (row.selector !== null)
				row.selector = `d1-${"f".repeat(64)}`.slice(0, 67) + row.selector.slice(-4).padStart(0, "");
		changed.generation = "1".repeat(64);
		const next = reduceDevelop(reduceDevelop(s, { type: "start", id: 7, read: { kind: "list" } }), {
			type: "finish",
			id: 7,
			reply: { kind: "sessions", record: changed },
			now: 0,
			at,
		});
		expect(next.selected).toBeNull();
		expect(next.detail).toBeNull();
		expect(next.stage).toBe("sessions");
		expect(next.notice).toContain("not in the sessions now read");
	});

	it("never selects a row that has no selector", () => {
		const s = listed();
		expect(reduceDevelop(s, { type: "select", selector: `d1-${"0".repeat(64)}` })).toBe(s);
	});
});

describe("the view helpers", () => {
	it("words every recorded state as recorded, and never as a live process", () => {
		for (const [state, wording] of Object.entries(STATE_WORDING)) {
			if (state !== "not-observed") expect(wording.word).toContain("as recorded");
			expect(wording.word + wording.meaning).not.toMatch(/\b(alive|live|active now|online)\b/i);
		}
		expect(STATE_WORDING.running.meaning).toContain("does not check whether a process exists");
	});

	it("filters only the loaded rows, groups by source, and says what the filters cover", () => {
		const s = listed();
		const rows = s.inventory!.sessions;
		expect(filterRows(rows, NO_DEVELOP_FILTERS)).toHaveLength(rows.length);
		expect(filterRows(rows, { ...NO_DEVELOP_FILTERS, sources: new Set(["dsh"]) }).map((r) => r.source)).toEqual([
			"dsh",
		]);
		expect(filterRows(rows, { ...NO_DEVELOP_FILTERS, text: " LONG " })).toHaveLength(1);
		expect(filterRows(rows, { ...NO_DEVELOP_FILTERS, states: new Set(["running"]) })).toEqual([]);
		expect(groupBySource(rows).map((g) => g.source)).toEqual(["pi", "dsh"]);
		const filtered = { ...s, filters: { ...NO_DEVELOP_FILTERS, text: "long" } };
		expect(developFiltersActive(filtered.filters)).toBe(true);
		expect(listCoverage(filtered, 1)).toContain("Filters apply to the");
		expect(listCoverage({ ...s, inventory: null }, 0)).toBe("");
	});
});
