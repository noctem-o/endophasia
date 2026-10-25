// Isolated stores only. End-to-end identity assertions use the actual guarded HTTP comparison endpoint.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { importDshSessionBytesV0 } from "../adapters/dsh-native/import.ts";
import { projectDshTrajectoryV0 } from "../adapters/dsh-native/trajectory.ts";
import * as piProjection from "../adapters/pi/trajectory.ts";
import * as cockpitApi from "../cockpit/index.ts";
import {
	canonicalEndoJsonV0,
	projectEndoCockpitTrajectoryComparisonV0,
	readEndoCockpitRecordV0,
} from "../cockpit/index.ts";
import { cockpitAliasesV0 } from "../cockpit/projections/common.ts";
import * as reader from "../cockpit/reader.ts";
import * as candidatesBridge from "../cockpit-http/candidates.ts";
import { projectEndoCockpitCompareCandidatesV0 } from "../cockpit-http/candidates.ts";
import {
	ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0,
	type EndoCockpitCompareCandidatesV0,
	validateEndoCockpitCompareCandidatesV0,
} from "../protocol/cockpit-candidates.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import * as storage from "../storage/event-store.ts";
import { endoFrameBytesV0 } from "../storage/log.ts";
import { event, ingestAll, removeTempRoots, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, raw, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY, TEST_KEY } from "./cockpit-keyed.ts";

const path = "/api/v0/compare/candidates";
type Candidate = EndoCockpitCompareCandidatesV0["candidates"][number];
const selected = (a: Candidate, b = a) =>
	`/api/v0/compare/selected/${a.source}/${a.selector}/${b.source}/${b.selector}`;
const key = OTHER_KEY;
const CANARY = "CANARY-9f3a-leak";

afterEach(async () => {
	vi.restoreAllMocks();
	await stopServers();
});
afterAll(() => removeTempRoots((root) => rmSync(root, { recursive: true, force: true })));

function pi(session = "endo.session.pi.example"): EndoEventV0[] {
	const events = readFileSync(new URL("./fixtures/trajectory/fake-pi/baseline.events.jsonl", import.meta.url), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as EndoEventV0);
	return events.map((e, i) => ({
		...e,
		id: `endo.event.recording.${session.slice(13)}.${i}`,
		coordinates: { ...e.coordinates, sessionId: session },
	}));
}

function minimalPi(session: string) {
	return event("harness.attached", {}, { session, producer: "pi-rpc-adapter:pi.default" });
}

function seed(events = pi(), prefix = "endo-candidates-") {
	const root = tempRoot(prefix);
	ingestAll(root, events);
	return root;
}

function dsh(root: string, id = "session-1", tail = false) {
	const lines = readFileSync(
		new URL("../research/dsh-native/fixtures/real/tool-read.events.jsonl", import.meta.url),
		"utf8",
	)
		.trim()
		.split("\n");
	const header = JSON.parse(lines[0]!);
	header.id = id;
	lines[0] = JSON.stringify(header);
	const bytes = Buffer.from(`${lines.join("\n")}\n`);
	const store = storage.createEndoDurableEventStoreV0(root);
	try {
		const report = importDshSessionBytesV0(tail ? bytes.subarray(0, bytes.length - 30) : bytes, store, {
			digestKey: OTHER_KEY,
			now: () => "2026-10-24T00:00:00Z",
		});
		expect(report.refusals).toEqual([]);
		return report.session!;
	} finally {
		store.close();
	}
}

const readEvents = (root: string) => {
	const read = reader.readEndoCockpitVerifiedEventsV0(root, key);
	if (!read.ok) throw new Error("fixture invalid");
	return read.events;
};

async function discover(server: Awaited<ReturnType<typeof serve>>, cursor?: string) {
	const response = await get(server, `${path}${cursor === undefined ? "" : `?cursor=${cursor}`}`);
	expect(response.status).toBe(200);
	const record = JSON.parse(response.body) as EndoCockpitCompareCandidatesV0;
	expect(readEndoCockpitRecordV0(record).ok).toBe(true);
	return { response, record };
}

describe("recording evidence and public selection", () => {
	it("two sources sharing a coordinate remain separate; asserted source cannot reuse the other's selector", async () => {
		const root = tempRoot();
		const session = dsh(root, "shared");
		ingestAll(root, pi(session));
		const server = await serve(root);
		const { record } = await discover(server);
		expect(record.candidates.map((c) => c.source)).toEqual(["dsh", "pi"]);
		expect(record.candidates[0]!.selector).not.toBe(record.candidates[1]!.selector);
		expect((await get(server, selected(record.candidates[0]!, record.candidates[1]!))).status).toBe(200);
		expect((await get(server, selected({ ...record.candidates[0]!, source: "pi" }))).status).toBe(404);
	});

	it("payload, runtime identifier and path canaries stay out of discovery and selected response bytes and headers", async () => {
		const events = pi();
		for (const e of events) {
			const payload = e.payload as Record<string, unknown>;
			payload.privatePath = `/home/${CANARY}/secret.json`;
			if (e.kind === "harness.attached") {
				payload.piSessionId = `token=${CANARY}`;
				payload.version = `/home/${CANARY}/runtime`;
			}
		}
		const root = seed(events);
		const before = treeHash(root);
		const server = await serve(root);
		const { record, response } = await discover(server);
		const comparison = await get(server, selected(record.candidates[0]!));
		expect(comparison.status).toBe(200);
		expect(readFileSync(`${root}/events/events.log`, "utf8")).toContain(CANARY);
		for (const r of [response, comparison])
			for (const bytes of [r.body, JSON.stringify(r.headers)]) {
				expect(bytes).not.toContain(CANARY);
				expect(bytes).not.toContain(root);
				expect(bytes).not.toContain(capabilityOf(server));
			}
		expect(treeHash(root)).toBe(before);
	});
	it("a valid empty log produces a complete, deterministic empty inventory", async () => {
		const root = tempRoot();
		mkdirSync(`${root}/events`);
		writeFileSync(`${root}/events/events.log`, "");
		const server = await serve(root);
		const a = await discover(server);
		const b = await discover(server);
		expect(a.response.body).toBe(b.response.body);
		expect(a.record.candidates).toEqual([]);
		expect(a.record.page).toEqual({ offset: 0, total: 0, hasMore: false, nextCursor: null });
	});

	it("multiple Pi and DSH sessions are discovered by producer, ordered and usable as mixed comparisons", async () => {
		const sessions = ["endo.session.pi.a", "endo.session.explicit-pi"];
		const root = seed(sessions.flatMap(pi));
		const ds = [dsh(root, "dsh-a"), dsh(root, "dsh-b")];
		ingestAll(root, [
			event("agent.prompt-accepted", {}, { session: "endo.session.unrelated" }),
			event("harness.attached", {}, { session: "endo.session.pi.fake", producer: "unsupported-producer" }),
		]);
		const before = treeHash(root);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
		const { record } = await discover(server);
		expect(record.page.total).toBe(4);
		expect(record.candidates.map((c) => c.session)).toEqual([...ds, ...sessions.sort()]);
		const events = readEvents(root);
		for (const a of record.candidates) {
			expect(a.eligibility).toBe("selectable");
			for (const b of record.candidates) {
				const response = await get(server, selected(a, b));
				expect(response.status).toBe(200);
				const trajectory = (c: Candidate) =>
					c.source === "pi"
						? piProjection.projectPiTrajectoryV0(events, { session: c.session, store: root })
						: projectDshTrajectoryV0(events, { session: c.session, sessionKind: "endo-coordinate", store: root });
				expect(response.body).toBe(
					canonicalEndoJsonV0(projectEndoCockpitTrajectoryComparisonV0(trajectory(a), trajectory(b), key)),
				);
			}
		}
		expect(treeHash(root)).toBe(before);
	});

	it("ambiguous Pi and incomplete DSH are distinguished, while lifecycle-only and unknown producers are excluded", async () => {
		const original = pi();
		const root = seed([
			...original,
			...original.map((e, i) => ({
				...e,
				id: `endo.event.second.${i}`,
				producer: e.producer.replace("pi.default", "pi.second"),
			})),
		]);
		dsh(root, "torn", true);
		ingestAll(root, [
			event(
				"lifecycle.session-started",
				{},
				{ session: "endo.session.only-lifecycle", producer: "pi-lifecycle:pi.default" },
			),
			event("anything.else", {}, { session: "endo.session.dsh.fake" }),
		]);
		const { record } = await discover(await serve(root));
		expect(record.candidates.map((c) => [c.source, c.eligibility, c.selector])).toEqual([
			["dsh", "insufficient", null],
			["pi", "ambiguous", null],
		]);
	});

	it("a recording under an invalid native coordinate is insufficient, never interpreted as a runtime ID", async () => {
		const root = seed([
			event("dsh.session-imported", {}, { producer: "dsh-native-import.1", session: "endo.session.explicit" }),
		]);
		const { record } = await discover(await serve(root));
		expect(record.candidates[0]).toMatchObject({ source: "dsh", eligibility: "insufficient", selector: null });
	});

	it("withheld coordinates and reserved alias collisions select the original recording, never an alias-shaped literal", async () => {
		const secret = `endo.session.pi.Tok_${CANARY}`;
		const literalAlias = cockpitAliasesV0(key).id(secret);
		const root = seed([...pi(secret), ...pi(literalAlias)], `endo-${CANARY}-`);
		const ds = dsh(root, `Tok_${CANARY}`);
		const events = readEvents(root);
		expect(readFileSync(`${root}/events/events.log`, "utf8")).toContain(CANARY);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
		const { record, response } = await discover(server);
		expect(record.candidates).toHaveLength(3);
		const sourceSessions = [secret, literalAlias, ds];
		for (const original of sourceSessions) {
			const source = original === ds ? "dsh" : "pi";
			const row = record.candidates.find(
				(c) => c.source === source && c.session === cockpitAliasesV0(key).id(original),
			)!;
			expect(row.eligibility).toBe("selectable");
			const compared = await get(server, selected(row));
			expect(compared.status).toBe(200);
			const t =
				source === "pi"
					? piProjection.projectPiTrajectoryV0(events, { session: original, store: root })
					: projectDshTrajectoryV0(events, { session: original, sessionKind: "endo-coordinate", store: root });
			expect(compared.body).toBe(canonicalEndoJsonV0(projectEndoCockpitTrajectoryComparisonV0(t, t, key)));
			for (const text of [response.body, compared.body, JSON.stringify(compared.headers)]) {
				expect(text).not.toContain(CANARY);
				expect(text).not.toContain(root);
			}
		}
		expect(new Set(record.candidates.map((c) => c.session)).size).toBe(3);
		expect(new Set(record.candidates.map((c) => c.selector)).size).toBe(3);
		const row = record.candidates[0]!;
		expect(
			(await get(server, `/api/v0/compare/selected/${row.source}/${row.session}/${row.source}/${row.session}`))
				.status,
		).toBe(404);
	});

	it("valid coordinates beyond the raw route's bound are selectable through opaque tokens", async () => {
		const session = `endo.session.${"a".repeat(64)}.${"b".repeat(64)}.${"c".repeat(64)}.${"d".repeat(40)}`;
		const root = seed([minimalPi(session)]);
		const server = await serve(root);
		const { record } = await discover(server);
		expect(record.candidates[0]!.eligibility).toBe("selectable");
		expect((await get(server, selected(record.candidates[0]!))).status).toBe(200);
	});

	it("identical inputs/key produce canonical identical bytes; other keys separate tokens, aliases and cursors", () => {
		const events = Array.from({ length: 101 }, (_, i) => minimalPi(`endo.session.pi.Tok_${i}`));
		const a = projectEndoCockpitCompareCandidatesV0(events, key);
		expect(canonicalEndoJsonV0(a)).toBe(canonicalEndoJsonV0(projectEndoCockpitCompareCandidatesV0([...events], key)));
		const b = projectEndoCockpitCompareCandidatesV0(events, TEST_KEY);
		expect(a.generation).not.toBe(b.generation);
		expect(a.page.nextCursor).not.toBe(b.page.nextCursor);
		expect(a.candidates[0]!.session).not.toBe(b.candidates[0]!.session);
		expect(a.candidates[0]!.selector).not.toBe(b.candidates[0]!.selector);
	});

	it("repeated recording events do not create duplicate candidates; forced token collisions fail closed", () => {
		const events = pi();
		expect(projectEndoCockpitCompareCandidatesV0([...events, ...events], key).page.total).toBe(1);
		const collide = {
			...key,
			digest: () => ({ algorithm: "hmac-sha256" as const, keyId: key.keyId, value: "a".repeat(64) }),
		};
		expect(() => projectEndoCockpitCompareCandidatesV0([...pi(), ...pi("endo.session.pi.other")], collide)).toThrow(
			"ambiguous-selection",
		);
	});
});

describe("bounded inventories and generation binding", () => {
	it("pages are bounded, complete and repeatable; offsets are authenticated against the full observation", async () => {
		const root = seed(
			Array.from({ length: 205 }, (_, i) => minimalPi(`endo.session.pi.s-${String(i).padStart(3, "0")}`)),
		);
		const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
		let page = (await discover(server)).record;
		const rows = [...page.candidates];
		expect(rows).toHaveLength(ENDO_COCKPIT_CANDIDATE_PAGE_SIZE_V0);
		const cursor = page.page.nextCursor!;
		while (page.page.hasMore) {
			const next = await discover(server, page.page.nextCursor!);
			page = next.record;
			rows.push(...page.candidates);
		}
		expect(rows).toHaveLength(205);
		expect(new Set(rows.map((c) => c.selector)).size).toBe(205);
		expect(page.page).toMatchObject({ offset: 200, total: 205, hasMore: false, nextCursor: null });
		expect((await discover(server, cursor)).response.body).toBe((await discover(server, cursor)).response.body);
		for (const bad of [cursor.replace("p1-100-", "p1-200-"), `p1-9900-${"a".repeat(64)}`])
			expect((await get(server, `${path}?cursor=${bad}`)).status).toBe(409);
	});

	it.each(["append", "rewrite"])(
		"%s invalidates held pages and selections even with an otherwise identical position",
		async (change) => {
			const events = Array.from({ length: 101 }, (_, i) => minimalPi(`endo.session.pi.session-${i}`));
			const root = seed(events);
			const server = await serve(root, { readBudget: { duty: 1, burstMs: 1e6 } });
			const first = (await discover(server)).record;
			if (change === "append") ingestAll(root, [event("unrelated.observation")]);
			else {
				const changed = structuredClone(events);
				changed[0]!.payload = { private: CANARY };
				writeFileSync(
					`${root}/events/events.log`,
					Buffer.concat(changed.map((e) => endoFrameBytesV0(Buffer.from(canonicalEndoJsonV0(e))))),
				);
			}
			expect((await get(server, `${path}?cursor=${first.page.nextCursor}`)).body).toBe(
				'{"error":"continuation-invalid"}\n',
			);
			expect((await get(server, selected(first.candidates[0]!))).status).toBe(404);
			expect((await discover(server)).record.generation).not.toBe(first.generation);
		},
	);

	it("a discovered candidate that gains a second attachment cannot be silently retargeted", async () => {
		const root = seed();
		const server = await serve(root);
		const first = (await discover(server)).record.candidates[0]!;
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.pi.example", producer: "pi-rpc-adapter:pi.second" }),
		]);
		expect((await get(server, selected(first))).status).toBe(404);
		expect((await discover(server)).record.candidates[0]).toMatchObject({ eligibility: "ambiguous", selector: null });
	});

	it("a previously complete DSH checkpoint that becomes lagging is no longer selectable", async () => {
		const root = tempRoot();
		const session = dsh(root);
		const server = await serve(root);
		const first = (await discover(server)).record.candidates[0]!;
		ingestAll(root, [
			event("dsh.tool-requested", { source: { dshSeq: 999 } }, { session, producer: "dsh-native-import.1" }),
		]);
		expect((await get(server, selected(first))).status).toBe(404);
		expect((await discover(server)).record.candidates[0]).toMatchObject({
			eligibility: "insufficient",
			selector: null,
		});
	});

	it("oversized candidate populations refuse rather than truncate or run projections", async () => {
		const root = tempRoot();
		mkdirSync(`${root}/events`);
		const events = Array.from({ length: 10_001 }, (_, i) => minimalPi(`endo.session.pi.s-${i}`));
		writeFileSync(
			`${root}/events/events.log`,
			Buffer.concat(events.map((e) => endoFrameBytesV0(Buffer.from(canonicalEndoJsonV0(e))))),
		);
		const spy = vi.spyOn(piProjection, "projectPiTrajectoryV0");
		const response = await get(await serve(root), path);
		expect(response.status).toBe(503);
		expect(response.body).toBe('{"error":"too-many-candidates"}\n');
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("closed wire and guarded read-only HTTP", () => {
	it.each(["validation", "serialization"])("%s time alone exhausts the shared read budget", async (phase) => {
		const record = projectEndoCockpitCompareCandidatesV0(pi(), key);
		const originalValidate = cockpitApi.readEndoCockpitRecordV0;
		const originalSerialize = cockpitApi.canonicalEndoJsonV0;
		let tick = 0;
		vi.spyOn(performance, "now").mockImplementation(() => tick);
		const server = await serve(seed(), { readBudget: { duty: 0.1, burstMs: 5 } });
		vi.spyOn(candidatesBridge, "readEndoCockpitCompareCandidatesV0").mockReturnValue(record);
		if (phase === "validation")
			vi.spyOn(cockpitApi, "readEndoCockpitRecordV0").mockImplementationOnce((v) => {
				tick += 100;
				return originalValidate(v);
			});
		else
			vi.spyOn(cockpitApi, "canonicalEndoJsonV0").mockImplementationOnce((v) => {
				tick += 100;
				return originalSerialize(v);
			});
		expect((await get(server, path)).status).toBe(200);
		expect((await get(server, path)).status).toBe(429);
	});
	it("the new validator is version registered, strict and rejects inconsistent pagination, identity and eligibility", () => {
		const record = projectEndoCockpitCompareCandidatesV0(pi(), key);
		expect(readEndoCockpitRecordV0(record).ok).toBe(true);
		for (const change of [
			(r: EndoCockpitCompareCandidatesV0) => {
				r.schemaVersion = "endo.cockpit-compare-candidates.v1" as never;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.projectionVersion = "cockpit-compare-candidates.2" as never;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.page.hasMore = true;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.page.total = 2;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.candidates[0]!.session = `endo.session.Tok_${CANARY}`;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.candidates[0]!.selector = null;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.candidates[0]!.label = CANARY as never;
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				Object.assign(r.candidates[0]!, { private: CANARY });
			},
			(r: EndoCockpitCompareCandidatesV0) => {
				r.candidates.push(r.candidates[0]!);
				r.page.total = 2;
			},
		]) {
			const copy = structuredClone(record);
			change(copy);
			expect(readEndoCockpitRecordV0(copy).ok).toBe(false);
		}
		expect(validateEndoCockpitCompareCandidatesV0({ ...record, extra: true })).toBeNull();
	});

	it.each([
		`${path}?limit=1`,
		`${path}?cursor=`,
		`${path}?cursor=p1-0-${"a".repeat(64)}`,
		`${path}?cursor=p1-0100-${"a".repeat(64)}`,
		`${path}?cursor=p1-101-${"a".repeat(64)}`,
		`${path}?cursor=p1-100-${"a".repeat(64)}&cursor=x`,
		`${path}?root=/private`,
		`${path}?${"x".repeat(200)}`,
		`${path}/extra`,
		"/api/v0/compare/selected/pi/../pi/x",
		"/api/v0/compare/selected/pi/%2e%2e/pi/x",
		"/api/v0/compare/selected/unknown/c1-xx/pi/c1-xx",
		`/api/v0/compare/selected/pi/${"x".repeat(600)}`,
	])("malformed %s consumes no evidence read", async (target) => {
		const server = await serve(seed());
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		expect([400, 404]).toContain((await get(server, target)).status);
		expect(spy).not.toHaveBeenCalled();
	});

	it("both endpoints share capability, Host, Origin, method, body and HTTP-parser guards", async () => {
		const server = await serve(seed());
		const candidate = (await discover(server)).record.candidates[0]!;
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		for (const target of [path, selected(candidate)]) {
			const full = `${capabilityOf(server)}${target}`;
			for (const [url, options, status] of [
				[target, {}, 404],
				[`/wrong${target}`, {}, 404],
				[full, { headers: { Host: "hostile.example" } }, 421],
				[full, { headers: { Origin: "https://hostile.example" } }, 403],
				[full, { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
				[full, { method: "HEAD" }, 405],
				[full, { method: "POST" }, 405],
				[full, { headers: { "Content-Length": "1" }, body: "x" }, 400],
			] as const)
				expect((await send(server, url, options)).status).toBe(status);
			expect(
				await raw(server, `GET ${full} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nBroken Header\r\n\r\n`),
			).toContain("400 Bad Request");
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it.each(["absent", "torn", "unopenable", "unsupported"])(
		"%s store is refused without a partial inventory or source details",
		async (condition) => {
			const root = tempRoot(`endo-${CANARY}-`);
			if (condition === "unopenable") mkdirSync(`${root}/events/events.log`, { recursive: true });
			if (condition === "torn" || condition === "unsupported") {
				ingestAll(root, pi());
				appendFileSync(
					`${root}/events/events.log`,
					condition === "torn"
						? Buffer.from([1, 2, 3])
						: endoFrameBytesV0(
								Buffer.from(JSON.stringify({ ...pi()[0], schemaVersion: `endo.event.${CANARY}` })),
							),
				);
			}
			const before = treeHash(root);
			const logs: string[] = [];
			const response = await get(await serve(root, { onError: (e) => logs.push(String(e)) }), path);
			expect(response.status).toBe(503);
			expect(response.body).not.toContain(CANARY);
			expect(response.body).not.toContain("candidates");
			expect(logs).toEqual([]);
			expect(treeHash(root)).toBe(before);
		},
	);

	it("unknown, stale-key and wrong-source opaque tokens fail without literal or alias fallback", async () => {
		const root = seed();
		const server = await serve(root);
		const first = (await discover(server)).record.candidates[0]!;
		const other = projectEndoCockpitCompareCandidatesV0(readEvents(root), TEST_KEY).candidates[0]!;
		for (const row of [{ ...first, selector: `c1-${"0".repeat(64)}` }, { ...first, source: "dsh" as const }, other])
			expect((await get(server, selected(row))).status).toBe(404);
	});

	it("one read-only open per request, closure before projection, no writes or new activity; only selected groups project", async () => {
		const root = seed([...pi(), ...pi("endo.session.pi.other")]);
		const before = treeHash(root);
		const server = await serve(root);
		const original = storage.createEndoDurableEventStoreV0;
		const close = vi.fn();
		const write = vi.fn(() => {
			throw new Error("unexpected write");
		});
		const open = vi.spyOn(storage, "createEndoDurableEventStoreV0").mockImplementation((r, options) => {
			expect(options).toEqual({ readOnly: true });
			const store = original(r, options);
			return {
				...store,
				ingest: write,
				close: () => {
					close();
					store.close();
				},
			};
		});
		const result = await discover(server);
		expect(open).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		const projection = vi.spyOn(piProjection, "projectPiTrajectoryV0");
		expect((await get(server, selected(result.record.candidates[0]!))).status).toBe(200);
		expect(projection).toHaveBeenCalledTimes(2);
		expect(open).toHaveBeenCalledTimes(2);
		expect(close).toHaveBeenCalledTimes(2);
		expect(write).not.toHaveBeenCalled();
		expect(treeHash(root)).toBe(before);
	});

	it("unexpected projection errors are sanitized even in host diagnostics and the store is closed", async () => {
		const root = seed();
		const logs: string[] = [];
		const server = await serve(root, { onError: (e) => logs.push(String(e)) });
		const original = storage.createEndoDurableEventStoreV0;
		const close = vi.fn();
		vi.spyOn(storage, "createEndoDurableEventStoreV0").mockImplementationOnce((r, options) => {
			const store = original(r, options);
			return {
				...store,
				close: () => {
					close();
					store.close();
				},
			};
		});
		vi.spyOn(piProjection, "projectPiTrajectoryV0").mockImplementationOnce(() => {
			throw new Error(`/private/${CANARY}`);
		});
		const response = await get(server, path);
		expect(response.status).toBe(500);
		expect(response.body).toBe('{"error":"internal-error"}\n');
		expect(logs).toEqual(["Error: comparison projection failed"]);
		expect(close).toHaveBeenCalledOnce();
	});

	it("server wire validation rejects unknown candidate contracts before sending them", async () => {
		const server = await serve(seed());
		vi.spyOn(candidatesBridge, "readEndoCockpitCompareCandidatesV0").mockReturnValueOnce({
			schemaVersion: "endo.cockpit-compare-candidates.v99",
			private: CANARY,
		} as never);
		expect((await get(server, path)).body).toBe('{"error":"internal-error"}\n');
	});

	it("the full discovery pipeline, including wire validation and serialization, is charged to the read budget", async () => {
		const server = await serve(seed(), { readBudget: { duty: 1e-12, burstMs: 0.0001 } });
		expect((await get(server, path)).status).toBe(200);
		const spy = vi.spyOn(reader, "readEndoCockpitVerifiedEventsV0");
		const response = await get(server, path);
		expect(response.status).toBe(429);
		expect(response.headers["retry-after"]).toBeDefined();
		expect(spy).not.toHaveBeenCalled();
	});
});
