// biome-ignore-all lint/suspicious/noAssignInExpressions: the mutations of a snapshot copy are written as one-line edits
// The page's pure parts: the response classifier and the view models. They run here under Node with no browser, over real
// snapshots read from real temporary stores, and every rule that keeps the page from claiming more than the record permits has a
// test: a missing value stays missing, order is storage order, usage is per event and never summed, no aggregate is invented.
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	ENDO_COCKPIT_BASES_V0,
	ENDO_COCKPIT_CATEGORIES_V0,
	ENDO_COCKPIT_FLAGS_V0,
	ENDO_COCKPIT_LIMIT_CODES_V0,
	ENDO_COCKPIT_NOTE_CODES_V0,
	ENDO_COCKPIT_PROJECTION_VERSIONS_V0,
	ENDO_COCKPIT_SOURCE_STATES_V0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	type EndoCockpitSnapshotV0,
	type EndoCockpitTimelineEntryV0,
	readEndoCockpitSnapshotV0,
} from "../cockpit/index.ts";
import {
	ALIAS_PATTERN,
	BASIS,
	CATEGORY,
	CHANGE_KIND,
	CHECK_KIND,
	CLASSIFICATION,
	DIFFERENCE,
	EVENT_SOURCE,
	FLAG,
	LIMIT_TEXT,
	NOTE_TEXT,
	NOTIFICATION_KIND,
	SOURCE_STATE,
	STATUS,
	SUPPORTED_PROJECTIONS,
	VERSION_ORDER,
	WITHHELD_TEXT,
} from "../cockpit-ui/src/labels.ts";
import {
	abbreviated,
	attachmentChoices,
	capabilityRows,
	categoryCounts,
	duration,
	eventLogSourceView,
	filterEntries,
	filtersActive,
	limitText,
	NO_FILTERS,
	noteViews,
	pagerView,
	presentText,
	registrySourceView,
	selectRuntime,
	statusCounts,
	usageView,
} from "../cockpit-ui/src/model.ts";
import { classifyReply, shownVersion } from "../cockpit-ui/src/reply.ts";
import { ENDO_CONFORMANCE_CLASSIFICATIONS_V0 } from "../protocol/evaluation.ts";
import { ENDO_EVENT_SOURCES_V0 } from "../protocol/event.ts";
import {
	ENDO_CAPABILITY_CHECK_KINDS_V0,
	ENDO_CAPABILITY_STATUSES_V0,
	ENDO_HARNESS_CHANGE_KINDS_V0,
	ENDO_HARNESS_DIFFERENCES_V0,
	ENDO_HARNESS_NOTIFICATION_KINDS_V0,
	ENDO_HARNESS_VERSION_ORDERS_V0,
} from "../protocol/harness.ts";
import { createEndoFrameLogV0, endoFrameBytesV0 } from "../storage/log.ts";
import { ATTACHMENT, event, ingestAll, removeTempRoots, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { OTHER_KEY, publicIdV0 } from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const keys = (table: object) => Object.keys(table).sort();
const sorted = (values: readonly string[]) => [...values].sort();

function seeded(events = 6): { root: string; snapshot: EndoCockpitSnapshotV0 } {
	const root = tempRoot();
	ingestAll(
		root,
		Array.from({ length: events }, (_, i) =>
			event(
				i % 2 === 0 ? "agent.prompt-accepted" : "tool.started",
				{},
				{ session: i < 3 ? "endo.session.one" : "endo.session.two" },
			),
		),
	);
	seedRegistry(root);
	return { root, snapshot: readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, limit: 4 }) };
}

const json = (value: unknown) => JSON.stringify(value);
const ok = (value: unknown) => classifyReply(200, null, "application/json; charset=utf-8", json(value));
const mutated = <T>(value: T, edit: (copy: any) => void): T => {
	const copy = JSON.parse(JSON.stringify(value));
	edit(copy);
	return copy;
};

describe("the page's vocabularies are pinned to the protocol's", () => {
	it("reads exactly the projection versions the protocol declares", () => {
		expect(SUPPORTED_PROJECTIONS).toEqual({
			snapshot: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.snapshot,
			runtimeIdentity: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.runtimeIdentity,
			capabilityState: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.capabilityState,
			sessionTimeline: ENDO_COCKPIT_PROJECTION_VERSIONS_V0.sessionTimeline,
		});
	});

	it("has wording for every member of every closed vocabulary, and nothing the protocol lacks", () => {
		expect(keys(SOURCE_STATE)).toEqual(sorted(ENDO_COCKPIT_SOURCE_STATES_V0));
		expect(keys(NOTE_TEXT)).toEqual(sorted(ENDO_COCKPIT_NOTE_CODES_V0));
		expect(keys(LIMIT_TEXT)).toEqual(sorted(ENDO_COCKPIT_LIMIT_CODES_V0));
		expect(keys(CATEGORY)).toEqual(sorted(ENDO_COCKPIT_CATEGORIES_V0));
		expect(keys(FLAG)).toEqual(sorted(ENDO_COCKPIT_FLAGS_V0));
		expect(keys(BASIS)).toEqual(sorted([...ENDO_COCKPIT_BASES_V0, "unavailable"]));
		expect(keys(STATUS)).toEqual(sorted(ENDO_CAPABILITY_STATUSES_V0));
		expect(keys(CLASSIFICATION)).toEqual(sorted(ENDO_CONFORMANCE_CLASSIFICATIONS_V0));
		expect(keys(CHECK_KIND)).toEqual(sorted(ENDO_CAPABILITY_CHECK_KINDS_V0));
		expect(keys(CHANGE_KIND)).toEqual(sorted(ENDO_HARNESS_CHANGE_KINDS_V0));
		expect(keys(DIFFERENCE)).toEqual(sorted(ENDO_HARNESS_DIFFERENCES_V0));
		expect(keys(VERSION_ORDER)).toEqual(sorted(ENDO_HARNESS_VERSION_ORDERS_V0));
		expect(keys(NOTIFICATION_KIND)).toEqual(sorted(ENDO_HARNESS_NOTIFICATION_KINDS_V0));
		expect(keys(EVENT_SOURCE)).toEqual(sorted(ENDO_EVENT_SOURCES_V0));
	});

	it("recognises the withheld text and a generated alias exactly as the policy produces them", () => {
		expect(WITHHELD_TEXT).toBe(ENDO_COCKPIT_WITHHELD_TEXT_V0);
		const alias = publicIdV0("endo.event.Tok_UPPER-case");
		expect(alias).toMatch(ALIAS_PATTERN);
		expect(presentText(alias).kind).toBe("alias");
		expect(presentText(`other.${alias.split(".").pop()}`).kind).toBe("alias");
		expect(presentText(ENDO_COCKPIT_WITHHELD_TEXT_V0).kind).toBe("withheld");
		expect(presentText("session.entry-observed").kind).toBe("text");
		// Close to an alias is ordinary text: a token of the wrong length is not the generator's.
		expect(presentText("withheld-123").kind).toBe("text");
		// Only a whole value of a generated form is an alias. Free text that merely contains a token is shown as the text it is.
		const token = alias.split(".").pop()!;
		for (const text of [
			`see ${token} for the reason`,
			`${token} and more`,
			`foo.${token}`,
			`endo.event.${token}.extra`,
			`endo.event.${token.toUpperCase()}`,
			`Endo.event.${token}`,
			`reason: ${alias}`,
		])
			expect(presentText(text), text).toEqual({ kind: "text", text });
		expect(presentText(token).kind).toBe("alias");
	});
});

describe("the response classifier", () => {
	const { snapshot } = seeded();

	it("reads a real snapshot, and hands it back unchanged", () => {
		const reply = ok(snapshot);
		expect(reply.kind).toBe("snapshot");
		if (reply.kind === "snapshot") expect(reply.snapshot).toEqual(snapshot);
	});

	it("refuses a response that is not JSON, or not a snapshot, without throwing", () => {
		for (const [type, body] of [
			["application/json", "{not json"],
			["application/json", ""],
			["application/json", "null"],
			["application/json", "[]"],
			["application/json", "3"],
			["application/json", '"snapshot"'],
			["text/html", json(snapshot)],
			[null, json(snapshot)],
		] as const)
			expect(classifyReply(200, null, type, body).kind, `${type} ${body.slice(0, 12)}`).toBe("malformed");
	});

	it("names a contract version it does not read, at the top level and in every nested projection", () => {
		const cases: [string, (copy: any) => void, string, string][] = [
			["schema", (c) => (c.schemaVersion = "endo.cockpit-snapshot.v1"), "schema", "endo.cockpit-snapshot.v1"],
			["projection", (c) => (c.projectionVersion = "cockpit-snapshot.4"), "projection", "cockpit-snapshot.4"],
			["consistency", (c) => (c.consistency = "one-snapshot"), "consistency", "one-snapshot"],
			[
				"timeline schema",
				(c) => (c.timeline.schemaVersion = "endo.cockpit-session-timeline.v9"),
				"schema",
				"endo.cockpit-session-timeline.v9",
			],
			[
				"timeline projection",
				(c) => (c.timeline.projectionVersion = "cockpit-session-timeline.9"),
				"projection",
				"cockpit-session-timeline.9",
			],
			["identity schema", (c) => (c.runtimes[0].identity.schemaVersion = "x.v1"), "schema", "x.v1"],
			[
				"identity projection",
				(c) => (c.runtimes[0].identity.projectionVersion = "cockpit-runtime-identity.9"),
				"projection",
				"cockpit-runtime-identity.9",
			],
			[
				"capability schema",
				(c) => (c.runtimes[0].capabilities.schemaVersion = "endo.cockpit-capability-state.v2"),
				"schema",
				"endo.cockpit-capability-state.v2",
			],
			[
				"capability projection",
				(c) => (c.runtimes[0].capabilities.projectionVersion = "cockpit-capability-state.2"),
				"projection",
				"cockpit-capability-state.2",
			],
		];
		for (const [name, edit, what, declared] of cases) {
			const reply = ok(mutated(snapshot, edit));
			expect(reply, name).toEqual({ kind: "unsupported", what, declared });
		}
	});

	it("treats a record that declares no version as malformed, not as an unsupported version", () => {
		for (const edit of [
			(c: any) => delete c.schemaVersion,
			(c: any) => delete c.projectionVersion,
			(c: any) => (c.schemaVersion = 7),
			(c: any) => delete c.timeline.schemaVersion,
			(c: any) => delete c.runtimes[0].identity.projectionVersion,
		])
			expect(ok(mutated(snapshot, edit)).kind).toBe("malformed");
	});

	it("never shows a declared version that is long, not text, or carries control characters", () => {
		expect(shownVersion("x".repeat(65))).toBe("unreadable");
		expect(shownVersion("a\u0007b")).toBe("unreadable");
		expect(shownVersion("<img src=x onerror=1>")).toBe("<img src=x onerror=1>"); // printable text is shown as text, never as markup
		expect(shownVersion(7)).toBe("not a string");
		expect(shownVersion(null)).toBe("not a string");
		const reply = ok(mutated(snapshot, (c) => (c.projectionVersion = "p".repeat(500))));
		expect(reply).toEqual({ kind: "unsupported", what: "projection", declared: "unreadable" });
	});

	it("refuses a snapshot whose structure the renderers could not index", () => {
		const cases: [string, (copy: any) => void][] = [
			["no timeline", (c) => delete c.timeline],
			["entries not an array", (c) => (c.timeline.entries = {})],
			["an entry without a position", (c) => delete c.timeline.entries[0].storageSequence],
			["an entry whose fields are a list", (c) => (c.timeline.entries[0].fields = [])],
			["no window", (c) => delete c.timeline.window],
			["a window with no hasMore", (c) => delete c.timeline.window.hasMore],
			["a source with no condition", (c) => delete c.timeline.source.condition],
			["runtimes not an array", (c) => (c.runtimes = null)],
			["a runtime without capabilities", (c) => delete c.runtimes[0].capabilities],
			["a capability list that is not a list", (c) => (c.runtimes[0].capabilities.capabilities = 3)],
			["a runtime without an attachment name", (c) => delete c.runtimes[0].identity.source.attachment],
			["a session that is null", (c) => (c.timeline.sessions = [null])],
			["a session without an id", (c) => (c.timeline.sessions = [{}])],
			["a note that is not an object", (c) => (c.timeline.notes = [3])],
			["a note without refs", (c) => (c.runtimes[0].identity.notes = [{ code: "x" }])],
			["a limit that is null", (c) => (c.runtimes[0].capabilities.capabilities[0].limits = [null])],
			["a flag that is not text", (c) => (c.timeline.entries[0].flags = [1])],
			["a derivedFrom that is not text", (c) => (c.timeline.entries[0].derivedFrom = [null])],
		];
		for (const [name, edit] of cases) expect(ok(mutated(snapshot, edit)).kind, name).toBe("malformed");
	});

	it("reads a 429 as pacing, with the server's own figure only when it is a plain whole number", () => {
		expect(classifyReply(429, "7", null, "")).toEqual({ kind: "paced", retryAfterSeconds: 7 });
		for (const header of [null, "", "abc", "-1", "1e3", "2.5", "1234567", "Wed, 21 Oct 2026 07:28:00 GMT", " 5"])
			expect(classifyReply(429, header, null, '{"error":"too-many-requests"}'), String(header)).toEqual({
				kind: "paced",
				retryAfterSeconds: null,
			});
	});

	it("tells a refusal, a missing address and a server fault apart, and shows only the server's fixed codes", () => {
		expect(classifyReply(404, null, "application/json", '{"error":"not-found"}')).toEqual({
			kind: "refused",
			status: 404,
			code: "not-found",
		});
		expect(classifyReply(421, null, "application/json", '{"error":"misdirected-request"}')).toEqual({
			kind: "refused",
			status: 421,
			code: "misdirected-request",
		});
		expect(classifyReply(403, null, "text/html", "<html>no</html>")).toEqual({
			kind: "refused",
			status: 403,
			code: null,
		});
		expect(classifyReply(400, null, "application/json", '{"error":"<script>"}')).toEqual({
			kind: "refused",
			status: 400,
			code: null,
		});
		expect(classifyReply(302, null, null, "")).toEqual({ kind: "refused", status: 302, code: null });
		expect(classifyReply(500, null, "application/json", '{"error":"internal-error"}')).toEqual({
			kind: "server-error",
			status: 500,
		});
		expect(classifyReply(503, null, null, "")).toEqual({ kind: "server-error", status: 503 });
	});
});

describe("how a missing value is shown", () => {
	const entry = (usage: EndoCockpitTimelineEntryV0["usage"]): EndoCockpitTimelineEntryV0 =>
		({ usage }) as EndoCockpitTimelineEntryV0;
	const reported = (over: Partial<{ costTotal: number | null; reasoning: number | null; input: number }> = {}) =>
		entry({
			basis: "reported",
			value: {
				input: 0,
				output: 12,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				costTotal: null,
				reasoning: null,
				...over,
			},
		});

	it("keeps the three usage states apart: never carried, not recorded, reported", () => {
		expect(usageView(entry(null).usage)).toEqual({ kind: "never" });
		expect(usageView(entry({ basis: "unavailable", reason: "the event carries no usage" }).usage)).toEqual({
			kind: "not-recorded",
			reason: "the event carries no usage",
		});
		expect(usageView(reported().usage).kind).toBe("reported");
	});

	it("shows a null cost or reasoning count as not recorded, and a recorded zero as 0", () => {
		const view = usageView(reported({ input: 0 }).usage);
		if (view.kind !== "reported") throw new Error("expected reported usage");
		const part = (label: string) => view.parts.find((p) => p.label === label)!;
		expect(part("input tokens")).toEqual({ label: "input tokens", value: "0", recorded: true });
		expect(part("cost (no unit recorded)")).toMatchObject({ value: "not recorded", recorded: false });
		expect(part("reasoning tokens")).toMatchObject({ value: "not recorded", recorded: false });
		const priced = usageView(reported({ costTotal: 0.0123, reasoning: 40 }).usage);
		if (priced.kind !== "reported") throw new Error("expected reported usage");
		expect(priced.parts.find((p) => p.label.startsWith("cost"))!.value).toBe("0.0123"); // not rounded to three places
		const long = usageView(reported({ costTotal: 0.000123456789 }).usage);
		if (long.kind !== "reported") throw new Error("expected reported usage");
		expect(long.parts.find((p) => p.label.startsWith("cost"))!.value).toBe("0.000123456789");
		// No currency symbol is ever added to a cost, whatever its size.
		expect(JSON.stringify(priced)).not.toMatch(/[$€£¥]|USD|usd/);
	});

	it("adds nothing up: there is no total across events, and each event's own total is labelled as its own", () => {
		const view = usageView(reported().usage);
		if (view.kind !== "reported") throw new Error("expected reported usage");
		expect(view.parts.map((p) => p.label)).toContain("total tokens (this event)");
		expect(view.parts.filter((p) => /total/i.test(p.label)).length).toBe(1);
		const source = usageView.toString() + filterEntries.toString() + pagerView.toString();
		expect(source).not.toMatch(/reduce\(|\+= *\w*usage|sum\(/i);
	});

	it("shows a source without a position as having none, never as length zero", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(join(root, "events", "events.log")).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: "endo.event.v999" })),
		);
		const snapshot = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY });
		expect(snapshot.timeline.source.condition.state).toBe("unopenable");
		const view = eventLogSourceView(snapshot.timeline.source);
		expect(view).toMatchObject({ state: "unopenable", positioned: false, facts: [] });
		expect(view.error).toBe("a stored record declares a schema version this reader does not support");
		const pager = pagerView(snapshot.timeline, 100);
		expect(pager).toMatchObject({
			total: null,
			hasMore: null,
			nextAfter: null,
			latestAfter: null,
			firstPosition: null,
		});
	});

	it("shows an absent and an empty registry as what they are, not as a registry of zeros", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		const absent = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, attachments: [ATTACHMENT] }).runtimes[0]!;
		const view = registrySourceView(absent.identity.source);
		expect(view.state).toBe("absent");
		expect(view.described?.meaning).toMatch(/Nothing exists/);
		const rows = capabilityRows(absent.capabilities);
		expect(rows).toEqual([]);
		expect(statusCounts(rows)).toEqual([]);
	});

	it("shows a degraded log with its torn tail", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started"), event("tool.started")]);
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		const snapshot = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY });
		const view = eventLogSourceView(snapshot.timeline.source);
		expect(view).toMatchObject({ state: "degraded", tornTailBytes: 21, positioned: true });
		expect(view.facts.find((f) => f.label === "events read")?.value).toBe("2");
	});
});

describe("capabilities are shown as recorded, one by one", () => {
	const { snapshot } = seeded();
	const runtime = snapshot.runtimes[0]!;

	it("keeps each recorded status and a null classification as they are, and counts statuses without scoring", () => {
		const rows = capabilityRows(runtime.capabilities);
		expect(rows.length).toBe(runtime.capabilities.capabilities.length);
		for (const [i, row] of rows.entries()) {
			expect(row.status).toBe(runtime.capabilities.capabilities[i]!.status);
			expect(row.classification).toBe(runtime.capabilities.capabilities[i]!.classification);
		}
		const counts = statusCounts(rows);
		expect(counts.reduce((n, c) => n + c.count, 0)).toBe(rows.length);
		for (const count of counts) expect(Object.keys(count).sort()).toEqual(["count", "label", "status"]);
		const unverified = capabilityRows({
			...runtime.capabilities,
			capabilities: [
				{ ...runtime.capabilities.capabilities[0]!, status: "unverified", classification: null, evidence: null },
				{
					...runtime.capabilities.capabilities[0]!,
					capability: "x.y",
					status: "unavailable",
					classification: "UNAVAILABLE",
				},
			],
		});
		expect(unverified.map((r) => [r.status, r.classification])).toEqual([
			["unverified", null],
			["unavailable", "UNAVAILABLE"],
		]);
		expect(new Set(unverified.map((r) => r.statusLabel)).size).toBe(2);
	});

	it("gives every limit and note code a sentence, and passes an unknown code through as itself", () => {
		for (const code of ENDO_COCKPIT_LIMIT_CODES_V0) expect(limitText(code), code).toMatch(/\w/);
		expect(limitText("a-limit-from-a-newer-contract")).toBeNull();
		const notes = noteViews([
			{ code: "from-the-future" as never, refs: [{ domain: "event-log", storageSequence: 3, eventId: "e" }] },
		]);
		expect(notes).toEqual([{ code: "from-the-future", text: null, refs: ["event log · position 3"] }]);
	});

	it("lists attachments with their own registry states and selects locally", () => {
		expect(attachmentChoices(snapshot)).toEqual([{ attachment: ATTACHMENT, state: "readable" }]);
		expect(selectRuntime(snapshot, ATTACHMENT)).toBe(runtime);
		expect(selectRuntime(snapshot, "not.listed")).toBe(runtime); // falls back to the first, never invents one
		expect(selectRuntime({ ...snapshot, runtimes: [] }, ATTACHMENT)).toBeNull();
	});
});

describe("the timeline window", () => {
	it("pages in storage order and finds the latest page from the watermark", () => {
		const { root } = seeded(23);
		const read = (after: number, limit: number) =>
			readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, afterSequence: after, limit }).timeline;
		const first = read(0, 10);
		expect(pagerView(first, 10)).toMatchObject({
			firstPosition: 1,
			lastPosition: 10,
			total: 23,
			hasMore: true,
			firstAfter: null,
			previousAfter: null,
			nextAfter: 10,
			latestAfter: 13,
		});
		const middle = read(10, 10);
		expect(pagerView(middle, 10)).toMatchObject({
			firstPosition: 11,
			lastPosition: 20,
			firstAfter: 0,
			previousAfter: 0,
			nextAfter: 20,
			latestAfter: 13,
		});
		const last = read(13, 10);
		expect(pagerView(last, 10)).toMatchObject({
			firstPosition: 14,
			lastPosition: 23,
			hasMore: false,
			nextAfter: null,
			latestAfter: null,
			previousAfter: 3,
		});
		expect(last.entries.map((e) => e.storageSequence)).toEqual(Array.from({ length: 10 }, (_, i) => 14 + i));
		const past = read(500, 10);
		expect(pagerView(past, 10)).toMatchObject({
			firstPosition: null,
			lastPosition: null,
			total: 23,
			hasMore: false,
			nextAfter: null,
		});
	});

	it("filters the loaded window only, keeps its order, and says how many of how many", () => {
		const { snapshot } = seeded(6);
		const entries = snapshot.timeline.entries;
		expect(filtersActive(NO_FILTERS)).toBe(false);
		const all = filterEntries(entries, NO_FILTERS);
		expect(all).toMatchObject({ shown: entries.length, inWindow: entries.length });
		const tools = filterEntries(entries, { ...NO_FILTERS, categories: new Set(["tool"]) });
		expect(tools.rows.every((e) => e.category === "tool")).toBe(true);
		expect(tools.inWindow).toBe(entries.length);
		const seqs = tools.rows.map((e) => e.storageSequence);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(filterEntries(entries, { ...NO_FILTERS, text: " TOOL.STARTED " }).shown).toBe(tools.shown);
		expect(filterEntries(entries, { ...NO_FILTERS, text: "no-such-kind" }).shown).toBe(0);
		expect(filterEntries(entries, { ...NO_FILTERS, flaggedOnly: true }).shown).toBe(
			entries.filter((e) => e.flags.length > 0).length,
		);
		expect(
			filterEntries(entries, { ...NO_FILTERS, session: "endo.session.one" }).rows.every(
				(e) => e.sessionId === "endo.session.one",
			),
		).toBe(true);
		expect(filtersActive({ ...NO_FILTERS, text: "x" })).toBe(true);
	});

	it("counts categories in the contract's order", () => {
		const { snapshot } = seeded(6);
		const counts = categoryCounts(snapshot.timeline.entries);
		expect(counts.map((c) => c.category)).toEqual(["agent", "tool"]);
		expect(counts.reduce((n, c) => n + c.count, 0)).toBe(snapshot.timeline.entries.length);
	});

	it("formats small things the same everywhere", () => {
		expect(abbreviated("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcdefghijkl…");
		expect(abbreviated("short")).toBe("short");
		expect(duration(0.2)).toBe("1 ms");
		expect(duration(42.4)).toBe("42 ms");
		expect(duration(1349)).toBe("1.3 s");
		void dirname;
	});
});
