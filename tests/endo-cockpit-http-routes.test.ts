// The cockpit HTTP transport serves the bridge's contracts unchanged. These tests read real temporary stores through a real
// loopback listener and compare every body with what the library returns directly, byte for byte.
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
	canonicalEndoJsonV0,
	ENDO_COCKPIT_WITHHELD_TEXT_V0,
	readEndoCockpitRecordV0,
	readEndoCockpitRuntimeV0,
	readEndoCockpitSnapshotV0,
	readEndoCockpitTimelineV0,
} from "../cockpit/index.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoFrameLogV0, endoFrameBytesV0 } from "../storage/log.ts";
import {
	ATTACHMENT,
	CANARY,
	event,
	ingestAll,
	removeTempRoots,
	seedRegistry,
	specimen,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import { get, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

afterEach(stopServers);
afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const direct = { digestKey: OTHER_KEY };

function seeded(events = 5): string {
	const root = tempRoot();
	ingestAll(
		root,
		Array.from({ length: events }, () => event("agent.prompt-accepted")),
	);
	seedRegistry(root);
	openEndoHarnessRegistryV0(root, "omp.default"); // a second attachment: opened, no records
	return root;
}

describe("a body is the library's contract, serialized canonically", () => {
	it("the snapshot over a real store with events and two registries equals the direct read", async () => {
		const root = seeded();
		const server = await serve(root);
		const reply = await get(server, "/api/v0/snapshot");
		expect(reply.status).toBe(200);
		expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
		expect(reply.body).toBe(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, direct) as never));
		const snapshot = JSON.parse(reply.body);
		expect(
			snapshot.runtimes.map((r: { identity: { source: { attachment: string } } }) => r.identity.source.attachment),
		).toEqual(["omp.default", ATTACHMENT]);
		expect(snapshot.consistency).toBe("independent-sources");
		expect(readEndoCockpitRecordV0(snapshot).ok).toBe(true);
	});

	it("the timeline equals the direct read, and the runtime pair equals the direct read of that attachment", async () => {
		const root = seeded();
		const server = await serve(root);
		const timeline = await get(server, "/api/v0/timeline");
		expect(timeline.body).toBe(canonicalEndoJsonV0(readEndoCockpitTimelineV0(root, direct) as never));
		const runtime = await get(server, `/api/v0/runtime/${ATTACHMENT}`);
		expect(runtime.status).toBe(200);
		expect(runtime.body).toBe(canonicalEndoJsonV0(readEndoCockpitRuntimeV0(root, ATTACHMENT, OTHER_KEY) as never));
		const { identity, capabilities } = JSON.parse(runtime.body);
		expect(readEndoCockpitRecordV0(identity).ok && readEndoCockpitRecordV0(capabilities).ok).toBe(true);
	});

	it("the same unchanged store answers byte-identically, warm or repeated", async () => {
		const server = await serve(seeded());
		const first = await get(server, "/api/v0/snapshot");
		for (let i = 0; i < 4; i += 1) expect((await get(server, "/api/v0/snapshot")).body).toBe(first.body);
	});

	it("no body carries the store path, the key bytes, the key id's secret or the capability", async () => {
		const root = seeded();
		const server = await serve(root);
		const capability = server.baseUrl.slice(server.origin.length + 1);
		for (const route of ["/api/v0/snapshot", "/api/v0/timeline", `/api/v0/runtime/${ATTACHMENT}`]) {
			const { body } = await get(server, route);
			for (const secret of [root, dirname(root), capability, Buffer.alloc(32, 0x11).toString("hex"), "node_modules"])
				expect(body.includes(secret), `${route} carries ${secret.slice(0, 8)}`).toBe(false);
		}
	});
});

describe("text the privacy policy withholds never reaches a body", () => {
	it("a canary, a path and a credential in event and registry free text appear in the store and in no response", async () => {
		const hostile = [
			CANARY,
			`/home/${CANARY}/notes`,
			`token=${CANARY}`,
			`ghp_${"A".repeat(36)}`,
			`http://${CANARY}.example/x`,
		];
		const root = tempRoot();
		ingestAll(root, [
			event("agent.prompt-accepted", { text: hostile[0], path: hostile[1], note: hostile[2], key: hostile[3] }),
			event(
				"tool.started",
				{ name: hostile[1], argsPreview: hostile[2], url: hostile[4] },
				{ producer: hostile[1] },
			),
			event("agent.prompt-accepted", {}, { id: `endo.event.Tok_${CANARY}`, producer: "tool:pi-default" }),
		]);
		const { fingerprint, evidence, state } = specimen();
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", fingerprint);
		for (const record of evidence) registry.append("evidence", record);
		registry.append("state", {
			...state,
			capabilities: state.capabilities.map((c) => ({
				...c,
				reason: `see ${hostile[1]} with ${hostile[2]} and ${hostile[3]}`,
			})),
		});
		// Non-vacuous: the hostile text is in the durable files the server reads.
		const stored = readFileSync(join(root, "events", "events.log"), "utf8");
		for (const text of [CANARY, hostile[3]!]) expect(stored.includes(text), text).toBe(true);
		expect(readFileSync(join(root, "harness", ATTACHMENT, "records.log"), "utf8").includes(CANARY)).toBe(true);

		const server = await serve(root);
		const replies = await Promise.all(
			["/api/v0/snapshot", "/api/v0/timeline", `/api/v0/runtime/${ATTACHMENT}`].map((route) => get(server, route)),
		);
		for (const { body } of replies) {
			expect(body).toContain(ENDO_COCKPIT_WITHHELD_TEXT_V0); // the policy ran, and said so
			for (const text of [CANARY, "9f3a-leak", "ghp_", ...hostile.slice(1, 3), "example/x"])
				expect(body.includes(text), text).toBe(false);
		}
	});
});

// The page does not enforce which source fields are presented: the producer does, and the API serves only what passed. This is that
// producer-side fact, seen from the wire. The probe values are plain text the text policy would let through, so that their absence
// can only be the field policy's doing; the policy itself is not copied here.
describe("a source field the presentation policy does not present never reaches a body", () => {
	it("an unlisted key, in a kind with approved fields and in one with none, is absent from every response and counted as withheld", async () => {
		const root = tempRoot();
		ingestAll(root, [
			event("tool.started", {
				toolName: "read_file",
				unlistedProbe: "plain-probe-value",
				nested: { deeper: "plain-nested-value" },
			}),
			event("agent.prompt-accepted", { unlistedProbe: "plain-probe-value" }),
		]);
		const stored = readFileSync(join(root, "events", "events.log"), "utf8");
		for (const text of ["unlistedProbe", "plain-probe-value", "plain-nested-value"])
			expect(stored.includes(text), text).toBe(true);

		const server = await serve(root);
		const replies = await Promise.all(["/api/v0/snapshot", "/api/v0/timeline"].map((route) => get(server, route)));
		for (const { body } of replies) {
			for (const text of ["unlistedProbe", "plain-probe-value", "nested", "plain-nested-value"])
				expect(body.includes(text), text).toBe(false);
			expect(body).toContain("read_file"); // an approved field of the same event is presented
		}
		const entries = (
			JSON.parse(replies[1]!.body) as { entries: { fields: Record<string, unknown>; withheldFields: number }[] }
		).entries;
		expect(Object.keys(entries[0]!.fields)).toContain("toolName");
		expect(entries[0]!.withheldFields).toBe(2); // the unlisted key and the nested one, counted and not shown
		expect(entries[1]!.fields).toEqual({});
		expect(entries[1]!.withheldFields).toBe(1);
	});
});

describe("pagination is the bridge's storage-order cursor and window", () => {
	it("pages cover the log once, in order, and each page equals the direct read of the same window", async () => {
		const root = seeded(7);
		const server = await serve(root);
		let after = 0;
		const seen: string[] = [];
		for (let page = 0; page < 10; page += 1) {
			const reply = await get(server, `/api/v0/timeline?afterSequence=${after}&limit=3`);
			expect(reply.body).toBe(
				canonicalEndoJsonV0(
					readEndoCockpitTimelineV0(root, { ...direct, afterSequence: after, limit: 3 }) as never,
				),
			);
			const timeline = JSON.parse(reply.body);
			seen.push(...timeline.entries.map((entry: { eventId: string }) => entry.eventId));
			if (!timeline.window.hasMore) break;
			after = timeline.window.nextAfterSequence;
		}
		expect(seen.length).toBe(7);
		expect(new Set(seen).size).toBe(7);
	});

	it("the snapshot takes the same window, and a window past the end is an empty page, not an error", async () => {
		const root = seeded(4);
		const server = await serve(root);
		const reply = await get(server, "/api/v0/snapshot?afterSequence=2&limit=1");
		expect(reply.body).toBe(
			canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, { ...direct, afterSequence: 2, limit: 1 }) as never),
		);
		const past = await get(server, "/api/v0/timeline?afterSequence=100000");
		expect(past.status).toBe(200);
		expect(JSON.parse(past.body).entries).toEqual([]);
	});
});

describe("source conditions are observation data, never an HTTP failure", () => {
	it("an absent store answers 200 with absent sources, and an absent attachment is 200 `absent`", async () => {
		const root = tempRoot();
		const server = await serve(root);
		const snapshot = JSON.parse((await get(server, "/api/v0/snapshot")).body);
		expect(snapshot.timeline.source.condition.state).toBe("absent");
		expect(snapshot.runtimes).toEqual([]);
		const runtime = await get(server, "/api/v0/runtime/nobody.here");
		expect(runtime.status).toBe(200);
		expect(JSON.parse(runtime.body).identity.source.condition.state).toBe("absent");
	});

	it("a torn tail is `degraded` data, and an invalid registry is `unopenable` data, beside a healthy source", async () => {
		const root = seeded(3);
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		const broken = join(root, "harness", "bad.default", "records.log");
		mkdirSync(dirname(broken), { recursive: true });
		createEndoFrameLogV0(broken).append(
			new TextEncoder().encode(
				JSON.stringify({ kind: "state", record: { schemaVersion: "endo.capability-state.v999" } }),
			),
		);
		const server = await serve(root);
		const before = treeHash(root);
		const reply = await get(server, "/api/v0/snapshot");
		expect(reply.status).toBe(200);
		expect(reply.body).toBe(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, direct) as never));
		const snapshot = JSON.parse(reply.body);
		expect(snapshot.timeline.source.condition.state).toBe("degraded");
		const states = Object.fromEntries(
			snapshot.runtimes.map((r: { identity: { source: { attachment: string; condition: { state: string } } } }) => [
				r.identity.source.attachment,
				r.identity.source.condition.state,
			]),
		);
		expect(states).toMatchObject({ "bad.default": "unopenable", [ATTACHMENT]: "readable" });
		expect(JSON.stringify(snapshot)).not.toContain("v999");
		expect(treeHash(root)).toBe(before);
	});

	it("the sources stay independent: an unopenable registry changes neither the timeline nor another registry's view", async () => {
		const healthy = seeded(3);
		const reference = JSON.parse((await get(await serve(healthy), "/api/v0/snapshot")).body);
		const broken = join(healthy, "harness", "bad.default", "records.log");
		mkdirSync(dirname(broken), { recursive: true });
		createEndoFrameLogV0(broken).append(
			new TextEncoder().encode(
				JSON.stringify({ kind: "state", record: { schemaVersion: "endo.capability-state.v999" } }),
			),
		);
		const after = JSON.parse((await get(await serve(healthy), "/api/v0/snapshot")).body);
		expect(after.timeline).toEqual(reference.timeline);
		const pick = (snapshot: typeof after, name: string) =>
			snapshot.runtimes.find(
				(r: { identity: { source: { attachment: string } } }) => r.identity.source.attachment === name,
			);
		expect(pick(after, ATTACHMENT)).toEqual(pick(reference, ATTACHMENT));
	});
});

describe("a read never mutates the store", () => {
	it("every route, with and without parameters, leaves the whole tree byte-identical", async () => {
		const root = seeded();
		const server = await serve(root);
		const before = treeHash(root);
		for (const route of [
			"/api/v0/snapshot",
			"/api/v0/snapshot?limit=1",
			"/api/v0/timeline?afterSequence=1&limit=2",
			`/api/v0/runtime/${ATTACHMENT}`,
			"/api/v0/runtime/never.written",
		])
			await get(server, route);
		expect(treeHash(root)).toBe(before);
	});
});
