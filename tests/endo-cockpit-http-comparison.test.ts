// Retained, sanitised Pi recordings and DSH runtime fixtures, acquired through a real read-only store and loopback server.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { importDshSessionBytesV0 } from "../adapters/dsh-native/import.ts";
import { projectDshTrajectoryV0 } from "../adapters/dsh-native/trajectory.ts";
import * as piProjection from "../adapters/pi/trajectory.ts";
import { projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import {
	canonicalEndoJsonV0,
	projectEndoCockpitTrajectoryComparisonV0,
	readEndoCockpitRecordV0,
} from "../cockpit/index.ts";
import * as reader from "../cockpit/reader.ts";
import * as comparison from "../cockpit-http/comparison.ts";
import { endoCockpitComparisonSelectionV0, readEndoCockpitComparisonV0 } from "../cockpit-http/comparison.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { compareEndoTrajectoriesV0 } from "../runtime/contracts/trajectory.ts";
import * as storage from "../storage/event-store.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import { event, ingestAll, removeTempRoots, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, raw, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

afterEach(async () => {
	vi.restoreAllMocks();
	await stopServers();
});
afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const pi = (name = "baseline"): EndoEventV0[] =>
	readFileSync(new URL(`./fixtures/trajectory/fake-pi/${name}.events.jsonl`, import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
const coordinate = (events: EndoEventV0[]) =>
	events.find((e) => e.coordinates.sessionId !== undefined)!.coordinates.sessionId!;
const selectPi = (session: string) => ({ source: "pi" as const, session });
const route = (a: string, b = a, sourceA = "pi", sourceB = sourceA) =>
	`/api/v0/compare/${sourceA}/${a}/${sourceB}/${b}`;
const logPath = (root: string) => `${root}/events/events.log`;

function seed(a = pi(), b: EndoEventV0[] = []) {
	const root = tempRoot();
	ingestAll(root, [...a, ...b]);
	return { root, a: coordinate(a), b: b.length === 0 ? coordinate(a) : coordinate(b), events: [...a, ...b] };
}

function dsh(
	root: string,
	fixture: string,
	id: string,
	key = endoDigestKeyV0(Buffer.alloc(32, 0x31), "comparison-source"),
) {
	const lines = readFileSync(
		new URL(`../research/dsh-native/fixtures/real/${fixture}.events.jsonl`, import.meta.url),
		"utf8",
	)
		.trim()
		.split("\n");
	// Only the header id changes to retain two distinct sessions in the same store.
	const header = JSON.parse(lines[0]!);
	header.id = id;
	lines[0] = JSON.stringify(header);
	const store = storage.createEndoDurableEventStoreV0(root);
	try {
		const report = importDshSessionBytesV0(Buffer.from(`${lines.join("\n")}\n`), store, {
			digestKey: key,
			now: () => "2026-10-24T00:00:00Z",
		});
		expect(report.refusals).toEqual([]);
	} finally {
		store.close();
	}
	return `endo.session.dsh.${id}`;
}

describe("comparison wire contract", () => {
	it.each(["baseline-again", "tool-args-differ", "other-digest-domain", "no-usage", "unknown-lifecycle"])(
		"Pi/Pi %s is byte-for-byte the existing presentation",
		async (name) => {
			const { root, a, b, events } = seed(pi(), pi(name));
			const ta = projectPiTrajectoryV0(events, { session: a, store: root });
			const tb = projectPiTrajectoryV0(events, { session: b, store: root });
			const expected = projectEndoCockpitTrajectoryComparisonV0(ta, tb, OTHER_KEY);
			const comparator = compareEndoTrajectoriesV0(ta, tb);
			const before = treeHash(root);
			const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
			const response = await get(server, route(a, b));
			expect(response.status).toBe(200);
			expect(response.body).toBe(canonicalEndoJsonV0(expected));
			for (const layer of ["lifecycle", "toolCalls", "toolResults", "outcome"] as const)
				expect(expected.layers[layer].status).toBe(comparator.layers[layer].status);
			if (name === "baseline-again") expect(expected.layers.toolCalls.status).toBe("EXACT");
			if (name === "tool-args-differ") expect(expected.layers.toolCalls.status).toBe("DIVERGED");
			if (name === "other-digest-domain") expect(expected.layers.toolCalls.status).toBe("UNAVAILABLE");
			expect(readEndoCockpitRecordV0(JSON.parse(response.body)).ok).toBe(true);
			for (const withheld of [
				root,
				ta.digest,
				tb.digest,
				ta.source.eventsSha256,
				comparator.digest,
				capabilityOf(server),
			])
				expect(response.body).not.toContain(withheld);
			expect(treeHash(root)).toBe(before);
			expect(response.headers["cache-control"]).toBe("no-store");
			expect(response.headers["access-control-allow-origin"]).toBeUndefined();
		},
	);

	it("DSH/DSH and Pi/DSH retain source mappings, missing usage/timing and recorded digest domains", async () => {
		const { root, a } = seed();
		const x = dsh(root, "tool-read", "compare-a");
		const y = dsh(root, "crash-resumed", "compare-b", OTHER_KEY);
		const events = reader.readEndoCockpitVerifiedEventsV0(root, OTHER_KEY);
		if (!events.ok) throw new Error("fixture read failed");
		const tx = projectDshTrajectoryV0(events.events, { session: x, sessionKind: "endo-coordinate", store: root });
		const ty = projectDshTrajectoryV0(events.events, { session: y, sessionKind: "endo-coordinate", store: root });
		const tp = projectPiTrajectoryV0(events.events, { session: a, store: root });
		const before = treeHash(root);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
		for (const [left, right, sourceA, sourceB, ta, tb] of [
			[x, y, "dsh", "dsh", tx, ty],
			[a, x, "pi", "dsh", tp, tx],
		] as const) {
			const response = await get(server, route(left, right, sourceA, sourceB));
			expect(response.status).toBe(200);
			const expected = projectEndoCockpitTrajectoryComparisonV0(ta, tb, OTHER_KEY);
			expect(response.body).toBe(canonicalEndoJsonV0(expected));
			expect(expected.layers.usage.status).toBe("UNAVAILABLE");
			expect(expected.layers.timing.status).toBe("UNAVAILABLE");
			expect(expected.flags.some((f) => f.kind === "digest-domain-differs")).toBe(true);
			if (sourceA === "pi") expect(expected.flags.some((f) => f.kind === "mapping-differs")).toBe(true);
		}
		expect(treeHash(root)).toBe(before);
	});

	it("registered comparison records fail closed on unknown schema, projection, rules and fields", () => {
		const { root, a } = seed();
		const record = readEndoCockpitComparisonV0(root, selectPi(a), selectPi(a), OTHER_KEY);
		for (const [field, value] of [
			["schemaVersion", "endo.cockpit-trajectory-comparison.v1"],
			["projectionVersion", "cockpit-trajectory-comparison.4"],
			["comparisonRules", "trajectory-comparison.4"],
			["unrecognised", "value"],
		]) {
			const result = readEndoCockpitRecordV0({ ...record, [field!]: value });
			expect(result.ok).toBe(false);
			if (field === "schemaVersion") expect(result).toMatchObject({ kind: "unsupported-version" });
		}
	});

	it("the HTTP wire gate refuses unsupported bridge output before serialization", async () => {
		const { root, a } = seed();
		const server = await serve(root);
		vi.spyOn(comparison, "readEndoCockpitComparisonV0").mockReturnValueOnce({
			schemaVersion: "endo.cockpit-trajectory-comparison.v99",
			private: "CANARY-9f3a-leak",
		} as never);
		const response = await get(server, route(a));
		expect(response.status).toBe(500);
		expect(response.body).toBe('{"error":"internal-error"}\n');
	});
});

describe("selectors and security refuse before evidence acquisition", () => {
	it.each([
		"/api/v0/compare/pi/endo.session.a/pi",
		"/api/v0/compare/other/endo.session.a/pi/endo.session.b",
		"/api/v0/compare/dsh/session-1/pi/endo.session.b",
		"/api/v0/compare/dsh/endo.session.pi.a/pi/endo.session.b",
		"/api/v0/compare/pi/endo.event.a/pi/endo.session.b",
		"/api/v0/compare/pi/../pi/endo.session.b",
		"/api/v0/compare/pi/%2e%2e/pi/endo.session.b",
		"/api/v0/compare/pi/endo.session.a/pi/endo.session.b/extra",
		route(`endo.session.${"x".repeat(208)}`),
		`${route("endo.session.a")}?root=/private`,
		`${route("endo.session.a")}?a=1&a=1`,
		`${route("endo.session.a")}?limit=1`,
		"/api/v1/compare/pi/endo.session.a/pi/endo.session.b",
		`/api/v0/compare/${"x".repeat(600)}`,
	])("invalid target %s reads nothing", async (target) => {
		const root = tempRoot();
		const server = await serve(root);
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		const response = await get(server, target);
		expect([400, 404]).toContain(response.status);
		expect(response.body).toMatch(/^\{"error":"(bad-request|not-found)"\}\n$/);
		expect(spy).not.toHaveBeenCalled();
		expect(treeHash(root)).toBe("");
	});

	it("auth, browser headers, methods, bodies and malformed HTTP read nothing", async () => {
		const { root, a } = seed();
		const server = await serve(root);
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		const target = `${capabilityOf(server)}${route(a)}`;
		for (const [path, options, status] of [
			[route(a), {}, 404],
			[`/wrong${route(a)}`, {}, 404],
			[target, { headers: { Host: "evil.example" } }, 421],
			[target, { headers: { Origin: "https://evil.example" } }, 403],
			[target, { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
			[target, { method: "POST" }, 405],
			[target, { method: "HEAD" }, 405],
			[target, { headers: { "Content-Length": "1" }, body: "x" }, 400],
			[target, { headers: { "Transfer-Encoding": "chunked" }, body: "x" }, 400],
		] as const)
			expect((await send(server, path, options)).status).toBe(status);
		const malformed = await raw(
			server,
			`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nBroken Header\r\n\r\n`,
		);
		expect(malformed).toContain("400 Bad Request");
		expect(spy).not.toHaveBeenCalled();
	});

	it("220-character coordinate bound covers emitted Pi ids and both sides fit the raw path limit", async () => {
		const session = `endo.session.pi.${"a".repeat(200)}`;
		const events = pi().map((e) => ({ ...e, coordinates: { ...e.coordinates, sessionId: session } }));
		const { root } = seed(events);
		const server = await serve(root);
		expect((await get(server, route(session))).status).toBe(200);
		const maximum = `endo.session.dsh.${"a".repeat(203)}`;
		expect(maximum.length).toBe(220);
		expect(`${capabilityOf(server)}${route(maximum, maximum, "dsh")}`.length).toBeLessThanOrEqual(512);
		expect(endoCockpitComparisonSelectionV0("dsh", maximum)).not.toBeNull();
		expect(endoCockpitComparisonSelectionV0("dsh", `${maximum}x`)).toBeNull();
	});
});

describe("source selection, failures and read-only consistency", () => {
	it("source is discriminated by producers, no prefix guessing, and multiple Pi attachments are refused", async () => {
		const { root, a, events } = seed();
		const x = dsh(root, "tool-read", "identity");
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
		for (const target of [route("endo.session.missing"), route(x), route(a, a, "dsh")])
			expect((await get(server, target)).status).toBe(404);
		const extra = events
			.filter((e) => e.producer === "pi-rpc-adapter:pi.default")
			.map((e, i) => ({ ...e, id: `endo.event.second.${i}`, producer: "pi-rpc-adapter:pi.second" }));
		ingestAll(root, extra);
		const response = await get(server, route(a));
		expect(response.status).toBe(409);
		expect(response.body).toBe('{"error":"ambiguous-selection"}\n');
	});

	it("a Pi recording may use a generic Endophasia coordinate; lifecycle-only and unrelated producers do not qualify", async () => {
		const session = "endo.session.explicit";
		const events = pi().map((e) => ({ ...e, coordinates: { ...e.coordinates, sessionId: session } }));
		const { root } = seed(events);
		const server = await serve(root);
		expect((await get(server, route(session))).status).toBe(200);
		const lifecycle = seed(events.filter((e) => e.producer.startsWith("pi-lifecycle:")));
		const other = seed(events.map((e) => ({ ...e, producer: "other-producer" })));
		for (const r of [lifecycle.root, other.root])
			expect((await get(await serve(r), route(session))).status).toBe(404);
		const dshRoot = tempRoot();
		ingestAll(dshRoot, [
			event(
				"lifecycle.session-started",
				{},
				{ producer: "dsh-native-lifecycle.1", session: "endo.session.dsh.only" },
			),
		]);
		expect((await get(await serve(dshRoot), route("endo.session.dsh.only", undefined, "dsh"))).status).toBe(404);
	});

	it.each(["absent", "empty", "torn", "corrupt", "unsupported", "unreadable"])(
		"%s evidence is explicit and never mutates the source",
		async (condition) => {
			const root = tempRoot();
			if (condition === "empty") {
				mkdirSync(`${root}/events`);
				writeFileSync(logPath(root), "");
			}
			if (condition === "unreadable") mkdirSync(logPath(root), { recursive: true });
			if (["torn", "corrupt", "unsupported"].includes(condition)) {
				ingestAll(root, pi());
				if (condition === "torn") appendFileSync(logPath(root), Buffer.from([1, 2, 3]));
				if (condition === "corrupt") {
					const bytes = readFileSync(logPath(root));
					bytes[8] = bytes[8]! ^ 1;
					writeFileSync(logPath(root), bytes);
				}
				if (condition === "unsupported")
					appendFileSync(
						logPath(root),
						endoFrameBytesV0(Buffer.from(JSON.stringify({ ...pi()[0], schemaVersion: "endo.event.v9" }))),
					);
			}
			const before = treeHash(root);
			const logs: unknown[] = [];
			const server = await serve(root, { onError: (error) => logs.push(error) });
			const response = await get(server, route(coordinate(pi())));
			const code =
				condition === "empty"
					? "not-found"
					: condition === "torn" || condition === "corrupt"
						? "source-degraded"
						: condition === "absent"
							? "source-absent"
							: "source-unopenable";
			expect(response.status).toBe(condition === "empty" ? 404 : 503);
			expect(response.body).toBe(`{"error":"${code}"}\n`);
			expect(logs).toEqual([]);
			expect(treeHash(root)).toBe(before);
		},
	);

	it("one read-only open and closure on success, with no writes", async () => {
		const { root, a } = seed();
		const original = storage.createEndoDurableEventStoreV0;
		const opened: { close: ReturnType<typeof vi.fn>; ingest: ReturnType<typeof vi.fn> }[] = [];
		const spy = vi.spyOn(storage, "createEndoDurableEventStoreV0").mockImplementation((r, options) => {
			expect(options).toEqual({ readOnly: true });
			const store = original(r, options);
			const close = vi.fn(() => store.close());
			const ingest = vi.fn(() => {
				throw new Error("unexpected write");
			});
			opened.push({ close, ingest });
			return { ...store, close, ingest };
		});
		const server = await serve(root);
		expect((await get(server, route(a))).status).toBe(200);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(opened[0]!.close).toHaveBeenCalledTimes(1);
		expect(opened[0]!.ingest).not.toHaveBeenCalled();
	});

	it.each(["page-failure", "adapter-failure", "ambiguous"])(
		"closure is guaranteed on %s and diagnostics are sanitized",
		async (failure) => {
			const { root, a, events } = seed();
			if (failure === "ambiguous")
				ingestAll(
					root,
					events.map((e, i) => ({
						...e,
						id: `endo.event.second.${i}`,
						producer: e.producer.replace("pi.default", "pi.second"),
					})),
				);
			const original = storage.createEndoDurableEventStoreV0;
			const close = vi.fn();
			vi.spyOn(storage, "createEndoDurableEventStoreV0").mockImplementationOnce((r, options) => {
				const store = original(r, options);
				return {
					...store,
					page:
						failure === "page-failure"
							? () => {
									throw new Error("CANARY-9f3a-leak");
								}
							: store.page,
					close: () => {
						close();
						store.close();
					},
				};
			});
			if (failure === "adapter-failure")
				vi.spyOn(piProjection, "projectPiTrajectoryV0").mockImplementationOnce(() => {
					throw new Error("CANARY-9f3a-leak");
				});
			const logs: string[] = [];
			const server = await serve(root, { onError: (e) => logs.push(String(e)) });
			const response = await get(server, route(a));
			expect(response.status).toBe(failure === "ambiguous" ? 409 : 500);
			expect(close).toHaveBeenCalledTimes(1);
			expect(response.body).not.toContain("CANARY");
			expect(logs.join()).not.toContain("CANARY");
		},
	);

	it("both selections across the event page boundary use a single validated open", async () => {
		const { root, a } = seed();
		const padding = Array.from({ length: 10_001 }, () => event("agent.prompt-accepted"));
		const added = pi("baseline-again");
		const b = coordinate(added);
		appendFileSync(
			logPath(root),
			Buffer.concat([...padding, ...added].map((e) => endoFrameBytesV0(Buffer.from(canonicalEndoJsonV0(e))))),
		);
		const open = vi.spyOn(storage, "createEndoDurableEventStoreV0");
		const server = await serve(root);
		expect((await get(server, route(a, b))).status).toBe(200);
		expect(open).toHaveBeenCalledExactlyOnceWith(root, { readOnly: true });
	});

	it.each(["missing", "torn", "lagging", "wrong-reference", "duplicate-sequence"])(
		"DSH %s checkpoint cannot imply a verified source",
		async (failure) => {
			const root = tempRoot();
			const session = dsh(root, "tool-read", "checkpoint");
			const read = reader.readEndoCockpitVerifiedEventsV0(root, OTHER_KEY);
			if (!read.ok) throw new Error("fixture read failed");
			read.events = JSON.parse(JSON.stringify(read.events)) as EndoEventV0[];
			const checkpoint = read.events.find((e) => e.kind === "dsh.import-checkpoint")!;
			const payload = checkpoint.payload as Record<string, unknown>;
			if (failure === "missing") read.events = read.events.filter((e) => e !== checkpoint);
			if (failure === "torn") payload.tail = "torn-row";
			if (failure === "lagging") payload.highWaterDshSeq = -1;
			if (failure === "wrong-reference") checkpoint.derivedFrom = ["endo.event.missing"];
			if (failure === "duplicate-sequence")
				read.events.push({ ...checkpoint, id: "endo.event.duplicate.checkpoint" });
			const alteredRoot = tempRoot();
			ingestAll(alteredRoot, read.events);
			const response = await get(await serve(alteredRoot), route(session, session, "dsh"));
			expect(response.status).toBe(503);
			expect(response.body).toBe('{"error":"source-degraded"}\n');
		},
	);

	it("a complete append after open is invisible to both sides until the next request; a torn append refuses then recovers", async () => {
		const { root, a } = seed();
		const original = storage.createEndoDurableEventStoreV0;
		const added = pi("baseline-again");
		const b = coordinate(added);
		vi.spyOn(storage, "createEndoDurableEventStoreV0").mockImplementationOnce((r, options) => {
			const snapshot = original(r, options);
			const writer = original(root);
			for (const e of added) writer.ingest(e);
			writer.close();
			return snapshot;
		});
		const server = await serve(root);
		expect((await get(server, route(a, b))).status).toBe(404);
		expect((await get(server, route(a, b))).status).toBe(200);
		const frame = endoFrameBytesV0(Buffer.from(JSON.stringify(event("agent.prompt-accepted"))));
		appendFileSync(logPath(root), frame.subarray(0, 12));
		expect((await get(server, route(a, b))).body).toContain("source-degraded");
		appendFileSync(logPath(root), frame.subarray(12));
		expect((await get(server, route(a, b))).status).toBe(200);
	});

	it("a retained DSH fixture imported with a torn source tail is refused, then admitted after a completed import", async () => {
		const root = tempRoot();
		const bytes = readFileSync(
			new URL("../research/dsh-native/fixtures/real/tool-read.events.jsonl", import.meta.url),
		);
		const store = storage.createEndoDurableEventStoreV0(root);
		const options = { digestKey: OTHER_KEY, now: () => "2026-10-24T00:00:00Z" };
		try {
			const report = importDshSessionBytesV0(bytes.subarray(0, bytes.length - 30), store, options);
			expect(report.refusals).toEqual([]);
			expect(report.tail.kind).toBe("torn-row");
			const server = await serve(root);
			const target = route(report.session!, report.session!, "dsh");
			expect((await get(server, target)).body).toBe('{"error":"source-degraded"}\n');
			expect(importDshSessionBytesV0(bytes, store, options).refusals).toEqual([]);
			expect((await get(server, target)).status).toBe(200);
			// Same high-water clean -> torn -> clean deduplicates the old clean checkpoint. It cannot establish a newer
			// clean observation, so retain the conservative refusal rather than interpreting the raw DSH file's current state.
			importDshSessionBytesV0(Buffer.concat([bytes, Buffer.from('{"seq":')]), store, options);
			importDshSessionBytesV0(bytes, store, options);
			expect((await get(server, target)).body).toBe('{"error":"source-degraded"}\n');
		} finally {
			store.close();
		}
	});

	it("private evidence and errors never escape in success, refusal or host diagnostics", async () => {
		const canary = "CANARY-9f3a-leak";
		const evidence = pi();
		for (const e of evidence) {
			const payload = e.payload as Record<string, unknown>;
			payload.privatePath = `/home/${canary}/private.json`;
			if (e.kind === "harness.attached") {
				payload.piSessionId = `token=${canary}`;
				payload.version = `/home/${canary}/runtime`;
			}
		}
		const root = tempRoot(`endo-${canary}-`);
		ingestAll(root, evidence);
		const a = coordinate(evidence);
		expect(readFileSync(logPath(root), "utf8")).toContain(canary);
		const before = treeHash(root);
		const logs: string[] = [];
		const server = await serve(root, { onError: (e) => logs.push(String(e)) });
		for (const target of [route(a), route(`endo.session.${canary}`)]) {
			const response = await get(server, target);
			expect(response.body).not.toContain(canary);
			expect(response.body).not.toContain(root);
		}
		vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0").mockImplementationOnce(() => {
			throw new Error(`${canary} /private/store`);
		});
		const response = await get(server, route(a));
		expect(response.status).toBe(500);
		expect(response.body).toBe('{"error":"internal-error"}\n');
		expect(logs).toEqual(["Error: comparison projection failed"]);
		expect(treeHash(root)).toBe(before);
	});

	it("comparison validation and serialization spend the existing read budget", async () => {
		const { root, a } = seed();
		const server = await serve(root, { readBudget: { duty: 1e-12, burstMs: 0.0001 } });
		expect((await get(server, route(a))).status).toBe(200);
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		const next = await get(server, route(a));
		expect(next.status).toBe(429);
		expect(next.headers["retry-after"]).toBeDefined();
		expect(spy).not.toHaveBeenCalled();
	});
});
