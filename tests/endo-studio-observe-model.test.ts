// The Observe view-model adapter and the state reducer: the pure part of the Studio frontend, run under Node with no browser over real
// snapshots read from real temporary stores. Each rule that keeps the page from claiming more than the record permits has a test:
// storage position is the order, the producer's clock is only ever labelled, a missing value stays missing, an absent, empty, degraded
// and unopenable source are four different things, a window is never presented as the whole log, and nothing is invented.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	type EndoCockpitSnapshotV0,
	type EndoCockpitTimelineEntryV0,
	readEndoCockpitSnapshotV0,
} from "../cockpit/index.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoFrameLogV0, endoFrameBytesV0 } from "../storage/log.ts";
import { NO_FILTERS, type Reply } from "../studio-ui/src/model/contract.ts";
import { capabilityDetail, eventDetail } from "../studio-ui/src/model/detail.ts";
import { checkDisplayable, legendModel, toObserveViewModel } from "../studio-ui/src/model/observe.ts";
import {
	type Action,
	type AppState,
	controlsLocked,
	initialState,
	pacedNow,
	pauseRemaining,
	reduce,
} from "../studio-ui/src/model/state.ts";
import { basesOf, markClassOf, splitClock } from "../studio-ui/src/model/timeline.ts";
import { event, ingestAll, lifecycleEvents, removeTempRoots, seedRegistry, tempRoot } from "./cockpit-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const read = (root: string, options: { limit?: number; afterSequence?: number } = {}): EndoCockpitSnapshotV0 =>
	readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, limit: 100, ...options });
const view = (
	snapshot: EndoCockpitSnapshotV0,
	patch: Partial<Parameters<typeof toObserveViewModel>[0]> = {},
): ReturnType<typeof toObserveViewModel> =>
	toObserveViewModel({ snapshot, attachment: null, selection: null, filters: NO_FILTERS, limit: 100, ...patch });
const populated = (events = lifecycleEvents("completes")): string => {
	const root = tempRoot();
	ingestAll(root, events);
	seedRegistry(root);
	return root;
};
const deepFreeze = <T>(value: T): T => {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
};
const textOf = (value: unknown): string => JSON.stringify(value);

describe("the adapter is pure and deterministic", () => {
	it("does not change its input, and says the same thing twice", () => {
		const snapshot = deepFreeze(structuredClone(read(populated())));
		const first = view(snapshot, {
			selection: { kind: "event", sequence: 4, eventId: snapshot.timeline.entries[3]!.eventId },
		});
		const second = view(snapshot, {
			selection: { kind: "event", sequence: 4, eventId: snapshot.timeline.entries[3]!.eventId },
		});
		expect(textOf(second)).toBe(textOf(first));
		expect(checkDisplayable(snapshot, NO_FILTERS, 100)).toBe(true);
	});

	it("builds a row for every event, in storage order, whatever the producer's clock says", () => {
		const events = [
			event("tool.started", {}, { at: "2026-10-03T12:00:09Z", sequence: 1 }),
			event("tool.started", {}, { at: "2026-10-03T12:00:01Z", sequence: 2 }),
			event("tool.started", {}, { at: "2026-10-02T23:59:59Z", sequence: 3 }),
			event("tool.started", {}, { at: "2026-10-03T12:00:05Z", sequence: 4 }),
		];
		const root = tempRoot();
		ingestAll(root, events);
		const model = view(read(root));
		expect(model.timeline.rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
		// The clock runs backwards: it is shown as written, labelled, and the date line is repeated where the date goes back.
		expect(model.timeline.rows.map((row) => row.clock.time)).toEqual([
			"12:00:09Z",
			"12:00:01Z",
			"23:59:59Z",
			"12:00:05Z",
		]);
		expect(model.timeline.rows.map((row) => row.dateDivider)).toEqual([
			"2026-10-03",
			null,
			"2026-10-02",
			"2026-10-03",
		]);
		// ... and the overview is placed by storage position, never by time.
		const xs = model.timeline.overview.marks.map((mark) => mark.x);
		expect(xs).toEqual([...xs].sort((a, b) => a - b));
		expect(new Set(xs).size).toBe(4);
	});

	it("splits a producer clock at its T and leaves a clock with none whole", () => {
		expect(splitClock("2026-10-03T17:34:47.648Z")).toEqual({ date: "2026-10-03", time: "17:34:47.648Z" });
		expect(splitClock("not a clock")).toEqual({ date: null, time: "not a clock" });
	});
});

describe("four different facts about a source: absent, empty, degraded, unopenable", () => {
	it("an absent store: no event log, no registry, and nothing assumed", () => {
		const model = view(read(tempRoot()));
		expect(model.timeline.state.state).toBe("absent");
		expect(model.timeline.empty).toEqual({ text: "No event log exists under this store root.", tone: "info" });
		expect(model.timeline.rows).toEqual([]);
		expect(model.runtime.attachment).toBeNull();
		expect(model.runtime.noRegistryText).toMatch(/No attachment registry was found/);
		expect(model.capabilities.kind).toBe("no-registry");
		expect(model.sources.noRegistryText).toMatch(/none is assumed/);
		expect(model.timeline.overview.coverage).toBe("none");
		expect(model.timeline.overview.emptyText).toMatch(/No event log exists.*nothing to draw/);
		expect(model.timeline.overview.bracket).toBeNull();
		expect(model.attention.map((a) => a.condition.state)).toEqual(["absent"]);
	});

	it("an empty log is a log of length zero, not an absent one, and needs no attention", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		writeFileSync(join(root, "events", "events.log"), "");
		const model = view(read(root));
		expect(model.timeline.state.state).toBe("empty");
		expect(model.timeline.empty?.text).toBe("The event log exists and holds no events.");
		expect(model.sources.cards[0]!.facts.find((f) => f.label === "events read")?.cell).toMatchObject({
			k: "text",
			text: { shown: "0" },
		});
		expect(model.timeline.overview.logLength).toBe(0);
		expect(model.timeline.overview.bracket).toBeNull();
		expect(model.attention).toEqual([]);
	});

	it("a torn tail is degraded: the prefix is still shown, with what follows it, and the warning is in the attention list", () => {
		const root = populated();
		const before = read(root).timeline.entries.length;
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		const model = view(read(root));
		expect(model.timeline.state.state).toBe("degraded");
		expect(model.timeline.degradedText).toMatch(/21 bytes follow the last verified event/);
		expect(model.timeline.rows).toHaveLength(before);
		expect(model.timeline.empty).toBeNull();
		const item = model.attention.find((a) => a.id === "event-log");
		expect(item?.condition.state).toBe("degraded");
		expect(item?.text).toMatch(/21 bytes/);
	});

	it("an unopenable log shows nothing from it, is not an empty log, and has no position", () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(join(root, "events", "events.log")).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: "endo.event.v999" })),
		);
		const model = view(read(root));
		expect(model.timeline.state.state).toBe("unopenable");
		expect(model.timeline.empty?.tone).toBe("error");
		expect(model.timeline.empty?.text).toMatch(/This is not an empty log\./);
		expect(model.timeline.empty?.text).not.toMatch(/holds no events/);
		expect(model.timeline.rows).toEqual([]);
		expect(model.sources.cards[0]!.positioned).toBe(false);
		expect(model.timeline.pager.of).toBe("position of the log unknown");
		expect(model.timeline.overview.logLength).toBeNull();
		expect(model.attention.find((a) => a.id === "event-log")?.text).toMatch(/no position/);
	});

	it("an unopenable registry beside a healthy log: each source keeps its own condition and its own position", () => {
		const root = populated();
		const broken = join(root, "harness", "bad.default", "records.log");
		mkdirSync(dirname(broken), { recursive: true });
		createEndoFrameLogV0(broken).append(
			new TextEncoder().encode(
				JSON.stringify({ kind: "state", record: { schemaVersion: "endo.capability-state.v999" } }),
			),
		);
		const snapshot = read(root);
		const model = view(snapshot);
		expect(model.sources.cards.map((c) => `${c.condition.state}:${c.title}`)).toEqual([
			"readable:Event log",
			"unopenable:Registry · bad.default",
			"readable:Registry · pi.default",
		]);
		expect(model.sources.cards.map((c) => c.positioned)).toEqual([true, false, true]);
		// The healthy log is still a table; the broken registry is named in the attention list.
		expect(model.timeline.rows.length).toBeGreaterThan(0);
		expect(model.attention.map((a) => a.id)).toEqual(["registry:bad.default"]);
		// Choosing it is local, and says what it is: not an empty registry, not a runtime without capabilities.
		const chosen = view(snapshot, { attachment: "bad.default" });
		expect(chosen.runtime.attachment?.unopenableText).toMatch(/not an empty registry/);
		expect(chosen.capabilities).toMatchObject({ kind: "no-state", tone: "error" });
		expect(chosen.capabilities.kind === "no-state" && chosen.capabilities.text).toMatch(
			/not a runtime without capabilities/,
		);
	});

	it("a registry with no capability state says that, not that nothing is supported", () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		openEndoHarnessRegistryV0(root, "omp.default");
		const model = view(read(root));
		expect(model.capabilities).toMatchObject({ kind: "no-state", tone: "info" });
		expect(model.capabilities.kind === "no-state" && model.capabilities.text).toMatch(
			/not a statement that nothing is supported/,
		);
	});

	it("the sources are independent histories: no join, no sum, no health figure", () => {
		const model = view(read(populated()));
		const flat = textOf(model.sources);
		expect(flat).not.toMatch(/health|confidence|score|overall/i);
		const log = model.sources.cards[0]!;
		const registry = model.sources.cards[1]!;
		expect(log.facts.map((f) => f.label)).toEqual(["events read", "last event", "prefix digest", "digest key"]);
		expect(registry.facts.map((f) => f.label)).toEqual(["records", "content digest", "digest key"]);
	});
});

describe("how a value is known", () => {
	const root = populated();
	const snapshot = read(root);

	it("shows each presented field with the basis it carries, and an unavailable one with its reason", () => {
		for (const entry of snapshot.timeline.entries) {
			const detail = eventDetail(entry);
			expect(detail.fields.map((f) => f.name)).toEqual(Object.keys(entry.fields));
			for (const [index, field] of Object.entries(entry.fields)) {
				const cell = detail.fields.find((f) => f.name === index)!.cell;
				if (field.basis === "unavailable") expect(cell.k).toBe("unavailable");
				else expect(cell).toMatchObject({ k: "claim", basis: { basis: field.basis } });
			}
		}
	});

	it("summarises an event's fields by the distinct bases among them, and says 'envelope only' when none is presented", () => {
		const bases = new Set(snapshot.timeline.entries.map((e) => basesOf(e).join("+")));
		expect(bases.size).toBeGreaterThan(1);
		expect(markClassOf([])).toBe("envelope");
		expect(markClassOf(["observed"])).toBe("observed");
		expect(markClassOf(["observed", "reported"])).toBe("mixed");
		expect(markClassOf(["something-new"])).toBe("unknown");
		// An envelope-only mark is not the dashed "unavailable" mark: an absent presentation is not an unavailable claim.
		expect(markClassOf([])).not.toBe(markClassOf(["unavailable"]));
		const envelope = snapshot.timeline.entries.find((e) => Object.keys(e.fields).length === 0);
		if (envelope !== undefined)
			expect(view(snapshot).timeline.rows.find((r) => r.sequence === envelope.storageSequence)?.bases).toEqual([]);
	});

	it("shows usage that is never carried, not recorded, or recorded, and never sums it", () => {
		const usage = (value: EndoCockpitTimelineEntryV0["usage"]) =>
			eventDetail({ ...snapshot.timeline.entries[0]!, usage: value }).usage;
		expect(usage(null)).toEqual({ kind: "never" });
		expect(usage({ basis: "unavailable", reason: "the runtime did not report usage for this call" })).toMatchObject({
			kind: "not-recorded",
		});
		const recorded = usage({
			basis: "reported",
			value: {
				input: 10,
				output: 4,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 14,
				costTotal: null,
				reasoning: null,
			},
		});
		expect(recorded.kind).toBe("reported");
		if (recorded.kind !== "reported") throw new Error("unreachable");
		const byLabel = Object.fromEntries(recorded.facts.map((f) => [f.label, f.cell]));
		// A cost the record does not hold is "not recorded", never 0.
		expect(byLabel["cost (no unit recorded)"]).toMatchObject({ k: "dim", text: "not recorded" });
		expect(byLabel["reasoning tokens"]).toMatchObject({ k: "dim", text: "not recorded" });
		expect(byLabel["input tokens"]).toMatchObject({ k: "mono", text: "10" });
		expect(recorded.facts.some((f) => /sum|total of|all events/i.test(f.label))).toBe(false);
	});

	it("keeps a missing optional value missing: no session, no run, no experiment, nothing derived from", () => {
		const entry = {
			...snapshot.timeline.entries[0]!,
			sessionId: null,
			runId: null,
			experimentId: null,
			derivedFrom: [],
		};
		const facts = Object.fromEntries(eventDetail(entry).facts.map((f) => [f.label, f.cell]));
		expect(facts.session).toMatchObject({ k: "dim", text: "none recorded" });
		expect(facts.run).toMatchObject({ k: "dim", text: "none recorded" });
		expect(facts.experiment).toMatchObject({ k: "dim", text: "none recorded" });
		expect(facts["derived from"]).toMatchObject({ k: "dim", text: "nothing" });
	});

	it("labels the producer's clock and the producer's sequence as the producer's own", () => {
		const facts = eventDetail(snapshot.timeline.entries[0]!).facts.map((f) => f.label);
		expect(facts).toContain("producer clock");
		expect(facts).toContain("producer sequence");
		expect(facts).not.toContain("recorded");
		const parts = eventDetail(snapshot.timeline.entries[0]!).facts.find((f) => f.label === "producer sequence")!.cell;
		expect(textOf(parts)).toMatch(/within this producer only/);
	});

	it("counts withheld payload keys, and marks an unrecognised kind with its flag and no fields", () => {
		const entry = { ...snapshot.timeline.entries[0]!, withheldFields: 2 };
		expect(eventDetail(entry).withheldNote).toBe("2 payload keys were recorded and not presented.");
		expect(eventDetail({ ...entry, withheldFields: 1 }).withheldNote).toBe(
			"1 payload key was recorded and not presented.",
		);
		expect(eventDetail({ ...entry, withheldFields: 0 }).withheldNote).toBe("No payload key was withheld.");
		const unknown = event("vendor.thing-nobody-knows", { secret: "CANARY-9f3a-leak" });
		const root2 = tempRoot();
		ingestAll(root2, [unknown]);
		const snap = read(root2);
		const detail = eventDetail(snap.timeline.entries[0]!);
		expect(detail.flags.map((f) => f.flag)).toContain("unrecognized");
		expect(detail.fields).toEqual([]);
		expect(textOf(view(snap))).not.toContain("CANARY-9f3a-leak");
		expect(view(snap).timeline.rows[0]!.markClass).toBe("envelope");
	});

	it("reads a capability's limits and evidence from the record, and never calls a missing limit a verification", () => {
		const runtime = snapshot.runtimes[0]!;
		for (const capability of runtime.capabilities.capabilities) {
			const detail = capabilityDetail(capability);
			expect(detail.status).toBe(capability.status);
			expect(detail.limits).toHaveLength(capability.limits.length);
			if (capability.limits.length === 0)
				expect(detail.noLimitsText).toMatch(/not a verification|without current evidence/);
		}
	});
});

describe("a window is a window", () => {
	const events = Array.from({ length: 30 }, (_, i) => event("tool.started", {}, { sequence: i + 1 }));
	const root = tempRoot();
	ingestAll(root, events);

	it("says it covers the whole log only when it starts at the beginning and the log ends", () => {
		const whole = view(read(root, { limit: 100 }));
		expect(whole.timeline.overview.coverage).toBe("whole");
		expect(whole.timeline.overview.coverageText).toBe("This overview covers the whole log as read.");
		const first = view(read(root, { limit: 10 }));
		expect(first.timeline.overview.coverage).toBe("partial");
		expect(first.timeline.overview.coverageText).toMatch(/positions 1–10 only of 30 read/);
		const middle = view(read(root, { limit: 10, afterSequence: 10 }), { limit: 10 });
		expect(middle.timeline.overview.coverage).toBe("partial");
		expect(middle.timeline.overview.span).toEqual({ first: 11, last: 20 });
		expect(middle.timeline.overview.bracket).toEqual({ from: 10 / 30, to: 20 / 30 });
		// The last window of a log that ends is still not the whole log: it starts after position zero.
		const last = view(read(root, { limit: 10, afterSequence: 20 }), { limit: 10 });
		expect(last.timeline.overview.coverage).toBe("partial");
		expect(last.timeline.pager.more).toMatch(/end of log/);
	});

	it("pages by the watermark: Latest from the log's length, Previous and Next from the window, none where there is none", () => {
		const middle = view(read(root, { limit: 10, afterSequence: 10 }), { limit: 10 }).timeline.pager;
		expect(middle).toMatchObject({ firstAfter: 0, previousAfter: 0, nextAfter: 20, latestAfter: 20 });
		const start = view(read(root, { limit: 10 }), { limit: 10 }).timeline.pager;
		expect(start).toMatchObject({ firstAfter: null, previousAfter: null, nextAfter: 10, latestAfter: 20 });
		const end = view(read(root, { limit: 10, afterSequence: 20 }), { limit: 10 }).timeline.pager;
		expect(end).toMatchObject({ nextAfter: null, latestAfter: null });
		expect(end.range).toBe("positions 21–30");
		expect(end.of).toBe("of 30 read");
	});

	it("places marks by storage position, so a gap in the positions stays a gap", () => {
		const snapshot = structuredClone(read(root, { limit: 10 }));
		snapshot.timeline.entries.splice(3, 2); // positions 4 and 5 are not in the window (say, repeats that were not presented)
		const marks = view(snapshot).timeline.overview.marks;
		expect(marks.map((m) => m.x)).toEqual([0.05, 0.15, 0.25, 0.55, 0.65, 0.75, 0.85, 0.95]);
	});

	it("filters the loaded window only, dims what it hides on the overview, and never removes it from the count", () => {
		const snapshot = read(root, { limit: 10 });
		const model = view(snapshot, { filters: { ...NO_FILTERS, text: "no-such-thing" } });
		expect(model.timeline.rows).toEqual([]);
		expect(model.timeline.noRowsText).toBe(
			"No event in this window matches the filters. Other windows are not searched.",
		);
		expect(model.timeline.window.text).toBe("0 of 10 in this window match");
		expect(model.timeline.overview.marks).toHaveLength(10);
		expect(model.timeline.overview.marks.every((m) => m.dim)).toBe(true);
		expect(model.timeline.categories.reduce((n, c) => n + c.count, 0)).toBe(10);
	});

	it("searches ids, kind, producer, session and presented text, but never a withheld sentinel", () => {
		const snapshot = read(populated());
		const sample = snapshot.timeline.entries[3]!;
		const find = (text: string) =>
			view(snapshot, { filters: { ...NO_FILTERS, text } }).timeline.rows.map((r) => r.sequence);
		expect(find(sample.kind)).toContain(sample.storageSequence);
		expect(find(sample.eventId.toUpperCase())).toContain(sample.storageSequence);
		expect(find(sample.producer)).toContain(sample.storageSequence);
		expect(find("withheld: looks like")).toEqual([]);
	});

	it("lists the sessions seen in this window, with no outcome and no duration", () => {
		const model = view(read(populated()));
		expect(model.timeline.sessions.length).toBeGreaterThan(0);
		for (const session of model.timeline.sessions)
			expect(Object.keys(session).sort()).toEqual(["entries", "first", "id", "label", "last"]);
		expect(model.timeline.sessionNote).toMatch(/seen in this window/);
		expect(textOf(model.timeline.sessions)).not.toMatch(/outcome|duration|success|fail|complete/i);
	});
});

describe("the inspector says what the record establishes", () => {
	const snapshot = read(populated());
	const first = snapshot.timeline.entries[3]!;

	it("is the legend until something is selected, and the legend is the same for every store", () => {
		expect(view(snapshot).inspector).toEqual({ kind: "legend" });
		expect(textOf(legendModel())).toBe(textOf(legendModel()));
		const legend = legendModel();
		expect(legend.bases.map((b) => b.basis)).toEqual(["observed", "reported", "derived", "unavailable"]);
		expect(legend.flags.map((f) => f.flag).sort()).toEqual([
			"anomaly",
			"discontinuity",
			"interruption",
			"unrecognized",
		]);
	});

	it("opens an event only where the position and the id agree, and otherwise says it is gone", () => {
		const ok = view(snapshot, {
			selection: { kind: "event", sequence: first.storageSequence, eventId: first.eventId },
		});
		expect(ok.inspector.kind).toBe("event");
		const other = view(snapshot, {
			selection: { kind: "event", sequence: first.storageSequence, eventId: "endo.event.someone-else" },
		});
		expect(other.inspector).toMatchObject({ kind: "gone" });
	});

	it("says when the filters hide the open event, which is still in the window", () => {
		const selection = { kind: "event" as const, sequence: first.storageSequence, eventId: first.eventId };
		const hidden = view(snapshot, { selection, filters: { ...NO_FILTERS, text: "no-such-thing" } });
		expect(hidden.inspector).toMatchObject({ kind: "event", hiddenByFilters: true });
		expect(view(snapshot, { selection }).inspector).toMatchObject({ kind: "event", hiddenByFilters: false });
	});

	it("never exposes a path, a secret or the raw payload: only presented fields, and the projection's own entry", () => {
		const detail = eventDetail(first);
		expect(detail.raw).toBe(JSON.stringify(first, null, 2));
		expect(Object.keys(first).sort()).toEqual(
			[
				"category",
				"derivedFrom",
				"eventId",
				"fields",
				"flags",
				"kind",
				"producer",
				"producerSequence",
				"recordedAt",
				"runId",
				"experimentId",
				"sessionId",
				"source",
				"storageSequence",
				"usage",
				"withheldFields",
			].sort(),
		);
	});
});

describe("the reducer is the one owner of the state", () => {
	const snapshot = read(populated());
	const reply: Reply = { kind: "snapshot", snapshot };
	const finished = (state: AppState, patch: Partial<Extract<Action, { type: "read-finished" }>> = {}): AppState =>
		reduce(state, {
			type: "read-finished",
			reply,
			request: { afterSequence: 0, limit: 100 },
			durationMs: 5,
			at: new Date(0),
			now: 1000,
			...patch,
		});

	it("starts empty, and a read replaces it with the snapshot, marks nothing stale and picks the first attachment", () => {
		const next = finished(reduce(initialState(), { type: "read-started" }));
		expect(next.busy).toBe(false);
		expect(next.loaded?.snapshot).toBe(snapshot);
		expect(next.problem).toBeNull();
		expect(next.attachment).toBe("pi.default");
		expect(next.attempts).toBe(1);
	});

	it("keeps the last snapshot, marked not current, when a read fails; and a paced read locks the controls by the monotonic clock", () => {
		const good = finished(initialState());
		const paced = reduce(good, {
			type: "read-finished",
			reply: { kind: "paced", retryAfterSeconds: 7 },
			request: { afterSequence: 0, limit: 100 },
			durationMs: 1,
			at: new Date(10_000),
			now: 2000,
		});
		expect(paced.loaded).toBe(good.loaded);
		expect(paced.problem?.reply.kind).toBe("paced");
		expect(paced.problem?.holdUntil).toBe(9000);
		expect(paced.problem?.retryAt?.getTime()).toBe(17_000);
		expect(pauseRemaining(paced, 5000)).toBe(4000);
		expect(pacedNow(paced, 5000)).toBe(true);
		expect(controlsLocked(paced, 5000)).toBe(true);
		expect(controlsLocked(paced, 9000)).toBe(false);
		// A pause the server did not put a time on locks nothing and invents no time.
		const bare = reduce(good, {
			...({
				type: "read-finished",
				reply: { kind: "paced", retryAfterSeconds: null },
				request: { afterSequence: 0, limit: 100 },
				durationMs: 1,
				at: new Date(0),
				now: 1,
			} as Action),
		});
		expect(bare.problem?.holdUntil).toBeNull();
		expect(bare.problem?.retryAt).toBeNull();
		expect(controlsLocked(bare, 1)).toBe(false);
	});

	it("fails closed on an unsupported or unreadable reply: nothing from it is kept", () => {
		const unsupported = reduce(initialState(), {
			type: "read-finished",
			reply: {
				kind: "unsupported",
				record: "snapshot",
				what: "schema",
				declared: "endo.cockpit-snapshot.v9",
				expected: "endo.cockpit-snapshot.v0",
			},
			request: { afterSequence: 0, limit: 100 },
			durationMs: 1,
			at: new Date(0),
			now: 0,
		});
		expect(unsupported.loaded).toBeNull();
		expect(unsupported.problem?.reply.kind).toBe("unsupported");
	});

	it("refuses a snapshot it cannot show whole, and keeps the read before it", () => {
		const good = finished(initialState());
		const broken = structuredClone(snapshot);
		(broken.timeline.entries[2] as unknown as { storageSequence: unknown }).storageSequence = undefined; // `grouped` refuses a position that is not there
		const next = finished(good, { reply: { kind: "snapshot", snapshot: broken } });
		expect(next.loaded).toBe(good.loaded);
		expect(next.problem?.reply).toEqual({ kind: "malformed", reason: "the snapshot could not be displayed" });
	});

	it("commits the page size only when a read of it succeeds", () => {
		const good = finished(initialState());
		expect(good.pageSize).toBe(100);
		const failed = reduce(good, {
			type: "read-finished",
			reply: { kind: "server-error", status: 500 },
			request: { afterSequence: 0, limit: 500 },
			durationMs: 1,
			at: new Date(0),
			now: 0,
		});
		expect(failed.pageSize).toBe(100);
		expect(finished(good, { request: { afterSequence: 0, limit: 500 } }).pageSize).toBe(500);
	});

	it("keeps an open event across a refresh when the same record is still there, and closes it with a sentence when it is not", () => {
		const entry = snapshot.timeline.entries[3]!;
		const open = reduce(finished(initialState()), {
			type: "select",
			selection: { kind: "event", sequence: entry.storageSequence, eventId: entry.eventId },
		});
		expect(finished(open).selection).toEqual(open.selection);
		// Another window: the event is in the log but not the window now loaded.
		const shifted = structuredClone(snapshot);
		shifted.timeline.entries = shifted.timeline.entries.slice(10);
		const gone = finished(open, { reply: { kind: "snapshot", snapshot: shifted } });
		expect(gone.selection).toBeNull();
		expect(gone.clearedNote).toMatch(/not in the window now loaded, so it is closed\.$/);
		expect(gone.clearedNote).not.toMatch(/still in the log/); // a window cannot say that
		// The note belongs to the read that closed the selection: the next successful read does not repeat it.
		expect(finished(gone).clearedNote).toBeNull();
		// The same position held by a different record is not the same selection.
		const replaced = structuredClone(snapshot);
		replaced.timeline.entries[3]!.eventId = "endo.event.a-different-record";
		const swapped = finished(open, { reply: { kind: "snapshot", snapshot: replaced } });
		expect(swapped.selection).toBeNull();
		expect(swapped.clearedNote).toMatch(/holds a different event at position 4/);
		// Selecting something else clears the note.
		expect(reduce(gone, { type: "select", selection: null }).clearedNote).toBeNull();
	});

	it("keeps an event the filters hide, and moves the session filter off a session that left the window", () => {
		const entry = snapshot.timeline.entries[3]!;
		let state = reduce(finished(initialState()), {
			type: "select",
			selection: { kind: "event", sequence: entry.storageSequence, eventId: entry.eventId },
		});
		state = reduce(state, { type: "set-filters", filters: { ...NO_FILTERS, text: "no-such-thing" } });
		expect(state.selection).not.toBeNull();
		state = reduce(state, { type: "set-filters", filters: { ...NO_FILTERS, session: "endo.session.gone" } });
		expect(finished(state).filters.session).toBeNull();
	});

	it("drops an open capability when a refresh removes its attachment, rather than showing a same-named one from another", () => {
		const two = structuredClone(snapshot);
		const copy = structuredClone(two.runtimes[0]!);
		copy.identity.source.attachment = "zz.other";
		copy.capabilities.source.attachment = "zz.other";
		two.runtimes.push(copy);
		const name = two.runtimes[0]!.capabilities.capabilities[0]!.capability;
		let state = reduce(finished(initialState(), { reply: { kind: "snapshot", snapshot: two } }), {
			type: "select-attachment",
			name: "zz.other",
		});
		state = reduce(state, { type: "select", selection: { kind: "capability", name } });
		expect(state.attachment).toBe("zz.other");
		const one = structuredClone(two);
		one.runtimes = one.runtimes.filter((r) => r.identity.source.attachment !== "zz.other");
		const after = finished(state, { reply: { kind: "snapshot", snapshot: one } });
		expect(after.attachment).toBe("pi.default");
		expect(after.selection).toBeNull();
	});

	it("selects an attachment without a read, and keeps a capability only if the new attachment has it", () => {
		const good = finished(initialState());
		const name = snapshot.runtimes[0]!.capabilities.capabilities[0]!.capability;
		const open = reduce(good, { type: "select", selection: { kind: "capability", name } });
		expect(reduce(open, { type: "select-attachment", name: "pi.default" }).selection).toEqual(open.selection);
		// A name the snapshot does not list is not chosen: nothing changes, and no other attachment answers to it.
		expect(reduce(open, { type: "select-attachment", name: "nobody.default" })).toBe(open);
		// An attachment that lacks the open capability closes it.
		const bare = structuredClone(snapshot);
		const lacking = structuredClone(bare.runtimes[0]!);
		lacking.identity.source.attachment = "zz.bare";
		lacking.capabilities.source.attachment = "zz.bare";
		lacking.capabilities.capabilities = [];
		bare.runtimes.push(lacking);
		const withTwo = reduce(finished(initialState(), { reply: { kind: "snapshot", snapshot: bare } }), {
			type: "select",
			selection: { kind: "capability", name },
		});
		expect(reduce(withTwo, { type: "select-attachment", name: "zz.bare" }).selection).toBeNull();
	});

	it("starts a different window at the top and a refresh of the same window where it was", () => {
		const first = finished(initialState());
		expect(first.windowMoves).toBe(1);
		expect(finished(first).windowMoves).toBe(1);
		expect(finished(first, { request: { afterSequence: 50, limit: 100 } }).windowMoves).toBe(2);
	});

	it("closes the inspector in one place, and the modal is whatever the selection says", () => {
		const entry = snapshot.timeline.entries[0]!;
		const open = reduce(finished(initialState()), {
			type: "select",
			selection: { kind: "event", sequence: entry.storageSequence, eventId: entry.eventId },
		});
		expect(open.selection).not.toBeNull();
		expect(reduce(open, { type: "close-inspector" }).selection).toBeNull();
	});
});
