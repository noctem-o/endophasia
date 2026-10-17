// An adversarial harness for the cockpit bridge, in two halves that catch opposite defects.
//
// TOTALITY. Records that are VALID at their source but hostile in content (credential-shaped identifiers, paths, tokens,
// invisible-character splits, look-alike forms, over-long strings, control characters) go through the real stores and the
// real reader. The snapshot must be produced (it is validated before it is returned, so a validator stricter than the
// projection would throw here), must validate again from its serialization, must contain none of the canary, and reading
// must change nothing on disk. The committed Pi recordings and ACP v1 and v2 recordings made against the fake agents
// must round-trip.
//
// REJECTION. Valid wire records produced by that reader are mutated by a seeded mutation fuzzer, one mutation at a time,
// and the validator must reject every one. The classes are deliberately about contracts, not examples: a credential in
// any string leaf, an unknown key anywhere, a value of another type, a basis relabelled, a reference altered, a limit
// fabricated, removed, duplicated or reordered, elements out of order, a source condition changed, a version changed,
// a key deleted, a cursor moved. Seeds are fixed and the iteration count is bounded; a failure prints the seed, the class
// and the path so it reproduces exactly. (No property-testing dependency is used: the fuzzer is mutation-based and
// deterministic, and the repository's dependencies stay as they are.)
//
// Residual, stated rather than asserted away: a facts-requiring-the-store claim (a limit whose precondition needs a
// fingerprint the view does not embed, a reference's index inside the watermark's range) cannot be refuted from the wire.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AcpClientV0 } from "../adapters/acp/index.ts";
import { AcpClientV2 } from "../adapters/acp/v2.ts";
import {
	checkEndoCockpitSourceFreshnessV0,
	readEndoCockpitEventLogV0,
	readEndoCockpitRegistryV0,
	readEndoCockpitSnapshotV0,
} from "../cockpit/index.ts";
import {
	ENDO_COCKPIT_LIMIT_CODES_V0,
	readEndoCockpitRecordV0,
	validateEndoCockpitCapabilityStateV0,
	validateEndoCockpitRuntimeIdentityV0,
	validateEndoCockpitSessionTimelineV0,
	validateEndoCockpitSnapshotV0,
} from "../protocol/cockpit.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoFrameLogV0 } from "../storage/log.ts";
import {
	ATTACHMENT,
	changeRecord,
	event,
	ingestAll,
	lifecycleEvents,
	notificationRecord,
	removeTempRoots,
	seedRegistry,
	specimen,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const C = "CANARYSECRET";
const FAKE_V1 = join(import.meta.dirname, "fixtures", "fake-acp-agent.ts");
const FAKE_V2 = join(import.meta.dirname, "fixtures", "fake-acp-v2-agent.ts");

/** Credential- and path-shaped text the text policy must flag, each carrying the canary. */
const FLAGGED = [
	`/home/${C}/project`,
	`~/${C}/notes`,
	`C:\\Users\\${C}\\x`,
	`\\\\${C}\\share\\x`,
	`https://user:${C}@example.test/x`,
	`token=${C}abcdef`,
	`Authorization: Bearer ${C}abcdefgh`,
	`ghp_${C}${C}`,
	`gh\u200bp_${C}${C}`,
	`ｇｈｐ＿${C}${C}`,
	`AKIA${C}0000`,
	`sk-${C.toLowerCase()}${C.toLowerCase()}`,
	`x\u0000${C}`,
	`x\u202e${C}`,
	`-----BEGIN OPENSSH PRIVATE KEY-----${C}`,
];

/** Identifier local parts that are not of the shape identifiers have (so they must be aliased on the way out). */
const NON_PUBLIC_LOCALS = [
	`Tok_${C}`,
	`ghp_${C}${C}`,
	`${C}.Up`,
	`sk-${C.toLowerCase()}${C.toLowerCase()}`,
	`a..b`,
	"x".repeat(70),
];

function noCanary(value: unknown, label: string): void {
	const text = JSON.stringify(value);
	const at = text.indexOf(C);
	expect(
		at === -1,
		`${label}: canary escaped near ${at === -1 ? "" : text.slice(Math.max(0, at - 120), at + 60)}`,
	).toBe(true);
	expect(text.includes(C.toLowerCase()), `${label}: lowercase canary escaped`).toBe(false);
}

// ---------------------------------------------------------------------------------------------------------------
// Totality
// ---------------------------------------------------------------------------------------------------------------

describe("totality: valid but hostile sources", () => {
	/** The specimen registry with every identifier rewritten to a non-public one, and every free text hostile. */
	function hostileRegistry(root: string): void {
		const { fingerprint, evidence, state } = specimen();
		const ids = new Map<string, string>();
		const alias = (id: string) => {
			if (!ids.has(id))
				ids.set(id, `endo.evidence.${NON_PUBLIC_LOCALS[ids.size % NON_PUBLIC_LOCALS.length]}${ids.size}`);
			return ids.get(id)!;
		};
		const rewrite = <T>(record: T): T =>
			JSON.parse(JSON.stringify(record).replace(/endo\.evidence\.[A-Za-z0-9._-]+/g, (id) => alias(id)));
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		const fp = rewrite(fingerprint);
		fp.local.package = { ...fp.local.package!, name: FLAGGED[7]!, version: FLAGGED[0]! };
		fp.reported.version = FLAGGED[1]!;
		// Dotted kinds are grammar-valid whatever they say: a lowercase credential shape is one.
		fp.runtime = `sk-${C.toLowerCase()}${C.toLowerCase()}`;
		registry.append("fingerprint", fp);
		const withEvidence = evidence.map((item, at) => {
			const rewritten = rewrite(item);
			rewritten.check.name = FLAGGED[at % FLAGGED.length]!;
			rewritten.check.version = FLAGGED[(at + 1) % FLAGGED.length]!.slice(0, 60);
			rewritten.dependencies.adapterVersion = FLAGGED[(at + 2) % FLAGGED.length]!.slice(0, 60);
			rewritten.limitations = [FLAGGED[(at + 3) % FLAGGED.length]!, "a plain limitation"];
			return rewritten;
		});
		for (const record of withEvidence) registry.append("evidence", record);
		const st = rewrite(state);
		st.runtime = fp.runtime;
		st.capabilities[0]!.capability = `sk-${C.toLowerCase()}${C.toLowerCase()}`;
		st.capabilities.forEach((entry, at) => {
			entry.reason = FLAGGED[at % FLAGGED.length]!;
		});
		registry.append("state", st);
		const change = rewrite(changeRecord());
		change.current = { ...change.current!, fingerprintId: fp.id, version: FLAGGED[2]! };
		registry.append("change", change);
		registry.append("notification", rewrite({ ...notificationRecord({ title: FLAGGED[4]!, changeId: change.id }) }));
	}

	function hostileEvents(): EndoEventV0[] {
		const session = `endo.session.${NON_PUBLIC_LOCALS[0]}`;
		const events: EndoEventV0[] = [];
		NON_PUBLIC_LOCALS.forEach((local, at) => {
			events.push(
				event(
					"tool.started",
					{
						toolName: FLAGGED[at]!,
						toolCallId: FLAGGED[at + 1]!,
						runtimeEvent: "x".repeat(300),
						argsDigest: { value: FLAGGED[2]!, keyId: FLAGGED[7]! },
					},
					{ id: `endo.event.${local}`, producer: FLAGGED[at]!, session },
				),
			);
		});
		events.push(
			event(
				"harness.attached",
				{ fingerprintId: `endo.evidence.${NON_PUBLIC_LOCALS[1]}`, instance: FLAGGED[0]!, piSessionId: FLAGGED[0]! },
				{ id: `endo.event.${NON_PUBLIC_LOCALS[2]}1`, session },
			),
			event(
				"lifecycle.session-started",
				{
					runtime: "pi",
					runtimeSessionId: FLAGGED[1]!,
					instance: "i",
					unavailable: [
						{ field: FLAGGED[3]!, reason: FLAGGED[4]! },
						{ field: "runId", reason: "y".repeat(400) },
					],
				},
				{ id: `endo.event.${NON_PUBLIC_LOCALS[3]}2`, session },
			),
			event(
				"harness.runtime-changed",
				{
					previousFingerprintId: `endo.evidence.${NON_PUBLIC_LOCALS[4]}`,
					currentFingerprintId: "not an identifier",
				},
				{ id: "endo.event.plain.3", session },
			),
			event(
				"lifecycle.turn-completed",
				{ turn: 1, stopReason: { status: "reported", value: FLAGGED[7]! } },
				{ id: "endo.event.plain.4", session },
			),
			event("vendor.unknown", { anything: FLAGGED[8]! }, { id: "endo.event.plain.5", session }),
			event(
				"message.completed",
				{ role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
				{ id: "endo.event.plain.6", session },
			),
		);
		const last = event(
			"tool.finished",
			{},
			{ id: `endo.event.${NON_PUBLIC_LOCALS[0]}last`, session, producer: "p".repeat(600) },
		);
		events.push({ ...last, derivedFrom: [`endo.event.${NON_PUBLIC_LOCALS[0]}`] });
		return events;
	}

	it("reads hostile identifiers, strings and producers into a valid snapshot with nothing escaping", () => {
		const root = tempRoot();
		ingestAll(root, hostileEvents());
		hostileRegistry(root);
		// An attachment whose name the policy flags is not listed, and reading it by name is refused.
		openEndoHarnessRegistryV0(root, `sk-${C.toLowerCase()}${C.toLowerCase()}`).append("fingerprint", {
			...specimen().fingerprint,
			attachment: `sk-${C.toLowerCase()}${C.toLowerCase()}`,
		});
		expect(() => readEndoCockpitRegistryV0(root, `sk-${C.toLowerCase()}${C.toLowerCase()}`)).toThrow(TypeError);
		const before = treeHash(root);
		const snapshot = readEndoCockpitSnapshotV0(root, { limit: 1000 });
		expect(validateEndoCockpitSnapshotV0(JSON.parse(JSON.stringify(snapshot)))).not.toBeNull();
		expect(readEndoCockpitRecordV0(JSON.parse(JSON.stringify(snapshot))).ok).toBe(true);
		noCanary(snapshot, "snapshot");
		expect(treeHash(root)).toBe(before);
		// Non-public identifiers are presented as aliases, consistently: the last event's alias is the watermark's last.
		const last = snapshot.timeline.entries.at(-1)!;
		expect(last.eventId).toMatch(/^endo\.event\.withheld-[0-9a-f]{32}$/);
		expect(snapshot.timeline.source.watermark!.lastEventId).toBe(last.eventId);
		expect(last.derivedFrom[0]).toBe(snapshot.timeline.entries[0]!.eventId);
		// Freshness and reads still work, and still do not write.
		const held = readEndoCockpitEventLogV0(root).source;
		expect(checkEndoCockpitSourceFreshnessV0(root, held)).toBe("unchanged");
		const heldRegistry = readEndoCockpitRegistryV0(root, ATTACHMENT).source;
		expect(checkEndoCockpitSourceFreshnessV0(root, heldRegistry)).toBe("unchanged");
		expect(treeHash(root)).toBe(before);
	});

	it("round-trips the committed Pi recordings with the registry specimen", () => {
		for (const name of ["completes", "killed-and-resumed", "stop-mid-turn"]) {
			const root = tempRoot();
			const events = lifecycleEvents(name);
			ingestAll(root, events);
			seedRegistry(root);
			const before = treeHash(root);
			const snapshot = readEndoCockpitSnapshotV0(root, { limit: events.length });
			expect(validateEndoCockpitSnapshotV0(JSON.parse(JSON.stringify(snapshot))), name).not.toBeNull();
			expect(
				snapshot.timeline.entries.map((e) => e.eventId),
				name,
			).toEqual(events.map((e) => e.id));
			expect(
				snapshot.timeline.entries.every((e) => !e.flags.includes("unrecognized")),
				name,
			).toBe(true);
			expect(treeHash(root), name).toBe(before);
		}
	});

	it("round-trips real ACP v1 and v2 recordings made against the fake agents", async () => {
		const scratch = tempRoot("endo-cockpit-acp-");
		const recorded: Record<string, EndoEventV0[]> = { v1: [], v2: [] };
		const v1 = await AcpClientV0.connect(
			{
				launch: {
					command: process.execPath,
					args: [FAKE_V1],
					cwd: scratch,
					env: { FAKE_ACP_MODE: "normal", FAKE_ACP_OUT: join(scratch, "notes1.jsonl") },
				},
				attachment: "fake.default",
				onEvent: (e) => recorded.v1!.push(e),
				closeGraceMs: 300,
			},
			{ cwd: scratch },
		);
		await v1.prompt("hello");
		await v1.close();
		const v2 = await AcpClientV2.connect(
			{
				launch: {
					command: process.execPath,
					args: [FAKE_V2],
					cwd: scratch,
					env: {
						FAKE_V2_FLAGS: "",
						FAKE_V2_OUT: join(scratch, "notes2.jsonl"),
						FAKE_V2_STORE: join(scratch, "store2.json"),
					},
				},
				attachment: "fake.v2",
				onEvent: (e) => recorded.v2!.push(e),
				closeGraceMs: 300,
			},
			{ cwd: scratch },
		);
		await v2.prompt("hello");
		await v2.close();
		for (const [version, events] of Object.entries(recorded)) {
			expect(events.length, version).toBeGreaterThan(3);
			const root = tempRoot();
			ingestAll(root, events);
			const before = treeHash(root);
			const snapshot = readEndoCockpitSnapshotV0(root, { limit: 10_000 });
			expect(validateEndoCockpitSnapshotV0(JSON.parse(JSON.stringify(snapshot))), version).not.toBeNull();
			expect(snapshot.timeline.entries.length, version).toBe(events.length);
			expect(
				snapshot.timeline.entries.some((e) => e.kind === "harness.attached" && "runtimeSessionId" in e.fields),
				version,
			).toBe(true);
			expect(
				snapshot.timeline.entries.every((e) => !e.flags.includes("unrecognized")),
				version,
			).toBe(true);
			expect(treeHash(root), version).toBe(before);
		}
	}, 30_000);

	it("treats an unreadable source as unopenable with a fixed error and writes nothing", () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) return;
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		const log = join(root, "events", "events.log");
		writeFileSync(log, `${C}`);
		chmodSync(log, 0o000);
		try {
			const source = readEndoCockpitEventLogV0(root).source;
			expect(source.condition.error).toEqual({
				kind: "unreadable",
				message: "the log file exists but cannot be read",
			});
			noCanary(source, "unreadable");
		} finally {
			chmodSync(log, 0o600);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------------------------------------------

/** mulberry32: a small seeded generator, so every failure reproduces from its seed. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Json = any;
interface Node {
	path: string;
	parent: Json;
	key: string | number;
	value: Json;
}

function nodes(root: Json): Node[] {
	const out: Node[] = [];
	const walk = (value: Json, path: string, parent: Json, key: string | number) => {
		out.push({ path, parent, key, value });
		if (Array.isArray(value)) for (const [at, item] of value.entries()) walk(item, `${path}[${at}]`, value, at);
		else if (value !== null && typeof value === "object")
			for (const [name, item] of Object.entries(value)) walk(item, `${path}.${name}`, value, name);
	};
	walk(root, "$", null, "");
	return out;
}

function validatorOf(record: Json): (value: unknown) => unknown {
	switch (record.schemaVersion) {
		case "endo.cockpit-runtime-identity.v0":
			return validateEndoCockpitRuntimeIdentityV0;
		case "endo.cockpit-capability-state.v0":
			return validateEndoCockpitCapabilityStateV0;
		case "endo.cockpit-session-timeline.v0":
			return validateEndoCockpitSessionTimelineV0;
		default:
			return validateEndoCockpitSnapshotV0;
	}
}

/** The valid wire records of several real stores: current, stale and carried-forward registries, and a timeline. */
function fixtures(): { name: string; record: Json }[] {
	const out: { name: string; record: Json }[] = [];
	const add = (name: string, root: string) => {
		const snapshot = readEndoCockpitSnapshotV0(root, { limit: 1000 });
		out.push({ name: `${name}/snapshot`, record: JSON.parse(JSON.stringify(snapshot)) });
		out.push({ name: `${name}/timeline`, record: JSON.parse(JSON.stringify(snapshot.timeline)) });
		out.push({ name: `${name}/identity`, record: JSON.parse(JSON.stringify(snapshot.runtimes[0]!.identity)) });
		out.push({
			name: `${name}/capabilities`,
			record: JSON.parse(JSON.stringify(snapshot.runtimes[0]!.capabilities)),
		});
	};
	const events = [
		...lifecycleEvents("killed-and-resumed"),
		event("tool.started", { toolName: "read", toolCallId: "c1" }, { id: "endo.event.adv.1" }),
		event(
			"message.completed",
			{ role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
			{ id: "endo.event.adv.2" },
		),
		event(
			"harness.store-opened",
			{ lifecycleRepaired: 0, recovery: { truncated: false, recovered: false, sealed: false } },
			{ id: "endo.event.adv.3" },
		),
	];
	const base = tempRoot();
	ingestAll(base, events);
	seedRegistry(base);
	const registry = openEndoHarnessRegistryV0(base, ATTACHMENT);
	registry.append("change", changeRecord());
	registry.append("notification", notificationRecord());
	add("current", base);

	const { fingerprint, state } = specimen();
	const newer = {
		...structuredClone(fingerprint),
		id: "endo.evidence.test-fingerprint.2",
		observedAt: "2026-10-04T10:00:00.000Z",
	};
	newer.identity = { ...newer.identity, digest: "d".repeat(64) };
	const stale = tempRoot();
	ingestAll(stale, events.slice(0, 6));
	seedRegistry(stale);
	openEndoHarnessRegistryV0(stale, ATTACHMENT).append("fingerprint", newer);
	add("stale", stale);

	const carried = tempRoot();
	ingestAll(carried, events.slice(0, 6));
	seedRegistry(carried);
	const second = {
		...structuredClone(fingerprint),
		id: "endo.evidence.test-fingerprint.3",
		observedAt: "2026-10-04T10:00:00.000Z",
	};
	const carriedRegistry = openEndoHarnessRegistryV0(carried, ATTACHMENT);
	carriedRegistry.append("fingerprint", second);
	carriedRegistry.append("state", {
		...structuredClone(state),
		fingerprintId: second.id,
		at: "2026-10-04T10:00:01.000Z",
	});
	add("carried", carried);

	// A registry with several records of every kind, so "latest" and the notes have something to be wrong about.
	const busy = tempRoot();
	ingestAll(busy, events.slice(0, 6));
	seedRegistry(busy);
	const busyRegistry = openEndoHarnessRegistryV0(busy, ATTACHMENT);
	const third = {
		...structuredClone(fingerprint),
		id: "endo.evidence.test-fingerprint.4",
		observedAt: "2026-10-05T10:00:00.000Z",
	};
	third.identity = { ...third.identity, digest: "e".repeat(64) };
	busyRegistry.append("fingerprint", third);
	const firstChange = changeRecord();
	busyRegistry.append("change", firstChange);
	busyRegistry.append(
		"change",
		changeRecord({
			id: "endo.evidence.test-change.2",
			kind: "changed",
			previous: firstChange.current,
			current: { ...firstChange.current!, fingerprintId: third.id, identityDigest: "e".repeat(64) },
			differences: ["version"],
		}),
	);
	busyRegistry.append("notification", notificationRecord());
	busyRegistry.append(
		"notification",
		notificationRecord({
			id: "endo.evidence.test-notification.2",
			changeId: "endo.evidence.test-change.2",
			kind: "runtime-changed",
		}),
	);
	const latestState = { ...structuredClone(state), fingerprintId: third.id, at: "2026-10-05T10:00:01.000Z" };
	latestState.capabilities[0] = {
		...latestState.capabilities[0]!,
		status: "unverified",
		classification: null,
		evidenceId: null,
		reason: "no evidence yet",
	};
	busyRegistry.append("state", latestState);
	add("busy", busy);

	// Sources that are not readable records: an event log and a registry that cannot be opened, and nothing at all.
	const broken = tempRoot();
	mkdirSync(join(broken, "events"));
	const dup = event("tool.started", {}, { id: "endo.event.adv.dup" });
	const frames = createEndoFrameLogV0(join(broken, "events", "events.log"));
	frames.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
	frames.append(new TextEncoder().encode(canonicalEndoJsonV0(dup)));
	mkdirSync(join(broken, "harness", ATTACHMENT), { recursive: true });
	createEndoFrameLogV0(join(broken, "harness", ATTACHMENT, "records.log")).append(
		new TextEncoder().encode(
			JSON.stringify({ kind: "fingerprint", record: { schemaVersion: "endo.harness-fingerprint.v999" } }),
		),
	);
	add("unopenable", broken);
	const nothing = tempRoot();
	mkdirSync(join(nothing, "harness", ATTACHMENT), { recursive: true });
	add("absent", nothing);
	return out;
}

const SEEDS = Array.from({ length: Number(process.env.ADV_SEEDS ?? 120) }, (_, at) => 1000 + at);

describe("rejection: seeded mutation of valid wire records", () => {
	const all = fixtures();

	it("the unmutated fixtures validate", () => {
		expect(all.length).toBe(24);
		for (const { name, record } of all) expect(validatorOf(record)(record), name).not.toBeNull();
		// The stale fixture really has derived limits, and the carried one really has none.
		const stale = all.find((f) => f.name === "stale/capabilities")!.record;
		expect(stale.capabilities.some((c: Json) => c.limits.length > 0)).toBe(true);
		const carried = all.find((f) => f.name === "carried/capabilities")!.record;
		expect(carried.capabilities.every((c: Json) => c.limits.length === 0)).toBe(true);
	});

	type Mutator = {
		name: string;
		/** Mutate `record` in place using `random`; return a description of what changed, or null when not applicable. */
		apply: (record: Json, random: () => number) => string | null;
	};
	const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
	const other = <T>(random: () => number, items: readonly T[], not: T): T =>
		pick(
			random,
			items.filter((item) => item !== not),
		);

	const BASES = ["observed", "reported", "derived", "inferred", "unavailable"];
	const STATES = ["absent", "empty", "readable", "degraded", "unopenable"];
	const isId = (value: Json) => typeof value === "string" && /^endo\.[a-z]+\./.test(value);

	const mutators: Mutator[] = [
		{
			name: "a flagged string in any string leaf",
			apply(record, random) {
				const leaves = nodes(record).filter((n) => typeof n.value === "string");
				const leaf = pick(random, leaves);
				leaf.parent[leaf.key] = pick(random, FLAGGED);
				return leaf.path;
			},
		},
		{
			name: "a non-public identifier in any identifier leaf",
			apply(record, random) {
				const leaves = nodes(record).filter((n) => isId(n.value));
				if (leaves.length === 0) return null;
				const leaf = pick(random, leaves);
				const kind = leaf.value.split(".")[1];
				leaf.parent[leaf.key] = `endo.${kind}.${pick(random, NON_PUBLIC_LOCALS)}`;
				return leaf.path;
			},
		},
		{
			name: "an unknown key anywhere",
			apply(record, random) {
				const objects = nodes(record).filter(
					(n) => n.value !== null && typeof n.value === "object" && !Array.isArray(n.value),
				);
				const target = pick(random, objects);
				target.value[random() < 0.5 ? "surprise" : FLAGGED[0]!] = 1;
				return target.path;
			},
		},
		{
			name: "a key deleted",
			apply(record, random) {
				const objects = nodes(record).filter(
					(n) =>
						n.value !== null &&
						typeof n.value === "object" &&
						!Array.isArray(n.value) &&
						Object.keys(n.value).length > 0 &&
						// `fields` is a map of the presented fields: an absent field is a field not presented, which is valid.
						!n.path.endsWith(".fields"),
				);
				const target = pick(random, objects);
				const key = pick(random, Object.keys(target.value));
				delete target.value[key];
				return `${target.path}.${key}`;
			},
		},
		{
			name: "a value of another type",
			apply(record, random) {
				const leaves = nodes(record).filter((n) => ["string", "number", "boolean"].includes(typeof n.value));
				const leaf = pick(random, leaves);
				const t = typeof leaf.value;
				leaf.parent[leaf.key] = t === "string" ? 7 : t === "number" ? "7" : "true";
				return leaf.path;
			},
		},
		{
			name: "a basis relabelled",
			apply(record, random) {
				const targets = nodes(record).filter((n) => n.key === "basis" && typeof n.value === "string");
				if (targets.length === 0) return null;
				const target = pick(random, targets);
				target.parent.basis = other(random, BASES, target.value);
				return target.path;
			},
		},
		{
			name: "a reference altered in one field",
			apply(record, random) {
				// Notes may name any in-range record (wire validation does not know which), so they are not mutated here.
				const refs = nodes(record).filter(
					(n) =>
						n.value &&
						typeof n.value === "object" &&
						!Array.isArray(n.value) &&
						n.value.domain !== undefined &&
						"kind" in n.value &&
						!n.path.includes(".notes["),
				);
				if (refs.length === 0) return null;
				const target = pick(random, refs);
				const ref = target.value;
				const edits = [
					() => {
						ref.domain = "event-log";
					},
					() => {
						ref.kind = other(random, ["fingerprint", "change", "evidence", "state", "notification"], ref.kind);
					},
					() => {
						ref.id = ref.id === null ? "endo.evidence.zz-other" : null;
					},
					() => {
						ref.attachment = "zz.other";
					},
					() => {
						ref.index = 1_000_000;
					},
				];
				pick(random, edits)();
				return target.path;
			},
		},
		{
			name: "a limit fabricated",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) => n.value && Array.isArray(n.value.limits) && n.value.status !== "unverified" && n.value.ref,
				);
				if (views.length === 0) return null;
				const view = pick(random, views).value;
				const decidable = [
					"state-not-for-latest-fingerprint",
					"state-without-fingerprint",
					"status-classification-mismatch",
					"evidence-record-missing",
					"evidence-check-insufficient",
					"evidence-classification-differs",
				];
				const absent = decidable.filter((code) => !view.limits.some((l: Json) => l.code === code));
				const needsMore = [
					"evidence-capability-differs",
					"evidence-identity-differs",
					"evidence-confidence-differs",
					"evidence-reduced-identity",
					"runtime-differs",
				];
				const code = random() < 0.6 && absent.length > 0 ? pick(random, absent) : pick(random, needsMore);
				const refs = [structuredClone(view.ref)];
				view.limits.push({ code, refs });
				view.limits.sort(
					(a: Json, b: Json) =>
						ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(a.code) - ENDO_COCKPIT_LIMIT_CODES_V0.indexOf(b.code),
				);
				return code;
			},
		},
		{
			name: "a derived limit removed",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) =>
						n.value &&
						Array.isArray(n.value.limits) &&
						n.value.limits.some((l: Json) =>
							[
								"state-not-for-latest-fingerprint",
								"state-without-fingerprint",
								"status-classification-mismatch",
								"evidence-record-missing",
								"evidence-check-insufficient",
								"evidence-classification-differs",
							].includes(l.code),
						),
				);
				if (views.length === 0) return null;
				const view = pick(random, views).value;
				const at = view.limits.findIndex((l: Json) =>
					[
						"state-not-for-latest-fingerprint",
						"state-without-fingerprint",
						"status-classification-mismatch",
						"evidence-record-missing",
						"evidence-check-insufficient",
						"evidence-classification-differs",
					].includes(l.code),
				);
				view.limits.splice(at, 1);
				return view.capability;
			},
		},
		{
			name: "a limit duplicated",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) => n.value && Array.isArray(n.value.limits) && n.value.limits.length > 0,
				);
				if (views.length === 0) return null;
				const view = pick(random, views).value;
				const limit = pick(random, view.limits as Json[]);
				view.limits.push(structuredClone(limit));
				return limit.code;
			},
		},
		{
			name: "two elements swapped in an ordered list",
			apply(record, random) {
				const lists = nodes(record).filter(
					(n) =>
						Array.isArray(n.value) &&
						n.value.length >= 2 &&
						/(\.entries|\.sessions|\.runtimes|\.limits|\.flags)$/.test(n.path) &&
						JSON.stringify(n.value[0]) !== JSON.stringify(n.value[1]),
				);
				if (lists.length === 0) return null;
				const list = pick(random, lists).value;
				[list[0], list[1]] = [list[1], list[0]];
				return "swap";
			},
		},
		{
			name: "a source condition changed",
			apply(record, random) {
				const sources = nodes(record).filter((n) => n.key === "source" && n.value?.condition);
				if (sources.length === 0) return null;
				const source = pick(random, sources).value;
				// An empty log and an absent one are the same on the wire (zero events), so one is not a mutation of the other.
				const indistinguishable =
					source.domain === "event-log" && source.watermark?.length === 0
						? ["absent", "empty"]
						: [source.condition.state];
				source.condition.state = pick(
					random,
					STATES.filter((state) => !indistinguishable.includes(state)),
				);
				return `${source.domain}:${source.condition.state}`;
			},
		},
		{
			name: "a version string changed",
			apply(record, random) {
				const targets = nodes(record).filter(
					(n) => (n.key === "schemaVersion" || n.key === "projectionVersion") && typeof n.value === "string",
				);
				const target = pick(random, targets);
				target.parent[target.key] = `${target.value}.9`;
				return target.path;
			},
		},
		{
			name: "a category changed",
			apply(record, random) {
				const targets = nodes(record).filter((n) => n.key === "category" && typeof n.value === "string");
				if (targets.length === 0) return null;
				const target = pick(random, targets);
				target.parent.category = other(
					random,
					[
						"lifecycle",
						"agent",
						"message",
						"tool",
						"session",
						"queue",
						"compaction",
						"retry",
						"harness",
						"control",
						"other",
					],
					target.value,
				);
				return target.path;
			},
		},
		{
			name: "a derived note added that the view contradicts",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) => Array.isArray(n.value?.notes) && n.value.source?.domain === "harness-registry",
				);
				if (views.length === 0) return null;
				const view = pick(random, views).value;
				const have = (code: string) => view.notes.some((note: Json) => note.code === code);
				const candidates: Json[] = [];
				if (view.schemaVersion === "endo.cockpit-runtime-identity.v0") {
					if (view.current !== null && !have("no-fingerprint-recorded"))
						candidates.push({ code: "no-fingerprint-recorded", refs: [] });
					if (
						view.lastChange !== null &&
						view.lastChange.kind !== "collection-failed" &&
						!have("latest-change-is-collection-failure")
					)
						candidates.push({
							code: "latest-change-is-collection-failure",
							refs: [structuredClone(view.lastChange.ref)],
						});
					if (
						view.lastChange !== null &&
						view.current !== null &&
						!have("latest-change-not-for-latest-fingerprint") &&
						view.lastChange.current?.fingerprintId === view.current.id
					)
						candidates.push({
							code: "latest-change-not-for-latest-fingerprint",
							refs: [structuredClone(view.lastChange.ref), structuredClone(view.current.ref)],
						});
				} else {
					if (view.state !== null && !have("no-capability-state-recorded"))
						candidates.push({ code: "no-capability-state-recorded", refs: [] });
					if (view.state !== null && view.state.latestFingerprintId !== null && !have("state-without-fingerprint"))
						candidates.push({ code: "state-without-fingerprint", refs: [structuredClone(view.state.ref)] });
				}
				if (candidates.length === 0) return null;
				const note = pick(random, candidates);
				view.notes.push(note);
				return note.code;
			},
		},
		{
			name: "a latest record replaced by an earlier one",
			apply(record, random) {
				const views = nodes(record).filter((n) => n.value?.schemaVersion === "endo.cockpit-runtime-identity.v0");
				if (views.length === 0) return null;
				const view = pick(random, views).value;
				if (view.previousDifferent === null) return null;
				const edits = [
					() => {
						view.current = structuredClone(view.previousDifferent);
					},
					() => {
						view.current = null;
					},
				];
				pick(random, edits)();
				return "current";
			},
		},
		{
			name: "usage given or taken away against the event's role and entry type",
			apply(record, random) {
				const lists = nodes(record).filter(
					(n) =>
						n.key === "entries" &&
						Array.isArray(n.value) &&
						n.value.some(
							(e: Json) =>
								e.kind === "message.completed" ||
								e.kind === "session.entry-observed" ||
								e.kind === "tool.started",
						),
				);
				if (lists.length === 0) return null;
				const entries = (pick(random, lists).value as Json[]).filter(
					(e) =>
						e.kind === "message.completed" || e.kind === "session.entry-observed" || e.kind === "tool.started",
				);
				const entry = pick(random, entries);
				entry.usage = entry.usage === null ? { basis: "unavailable", reason: "the event records no usage" } : null;
				return entry.kind;
			},
		},
		{
			name: "a classification given to an unverified capability",
			apply(record, random) {
				const views = nodes(record).filter((n) => n.value?.status === "unverified" && "classification" in n.value);
				if (views.length === 0) return null;
				pick(random, views).value.classification = "EXACT";
				return "classification";
			},
		},
		{
			name: "a classification taken from an admitted capability",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) => n.value?.status !== undefined && n.value.status !== "unverified" && n.value.classification,
				);
				if (views.length === 0) return null;
				pick(random, views).value.classification = null;
				return "classification";
			},
		},
		{
			name: "a limitation attributed to evidence that is not cited",
			apply(record, random) {
				const views = nodes(record).filter(
					(n) => n.value?.evidence === null && Array.isArray(n.value?.limitations) && "capability" in n.value,
				);
				if (views.length === 0) return null;
				pick(random, views).value.limitations = ["a limitation nothing states"];
				return "limitations";
			},
		},
		{
			name: "a notification view with no lines",
			apply(record, random) {
				const views = nodes(record).filter((n) => typeof n.value?.lineCount === "number");
				if (views.length === 0) return null;
				pick(random, views).value.lineCount = 0;
				return "lineCount";
			},
		},
		{
			name: "the digest of an empty registry replaced",
			apply(record, random) {
				const marks = nodes(record).filter(
					(n) =>
						n.key === "watermark" &&
						n.value?.counts &&
						Object.values(n.value.counts).every((count) => count === 0),
				);
				if (marks.length === 0) return null;
				pick(random, marks).value.contentDigest = "0".repeat(64);
				return "contentDigest";
			},
		},
		{
			name: "a cursor or sequence moved",
			apply(record, random) {
				const windows = nodes(record).filter((n) => n.key === "window" && n.value?.nextAfterSequence !== undefined);
				if (windows.length === 0) return null;
				const window = pick(random, windows);
				const key = pick(random, ["afterSequence", "nextAfterSequence"]);
				window.value[key] += random() < 0.5 ? 1 : -1;
				return `${window.path}.${key}`;
			},
		},
		{
			name: "an entry's storage sequence moved",
			apply(record, random) {
				const lists = nodes(record).filter(
					(n) => n.key === "entries" && Array.isArray(n.value) && n.value.length > 1,
				);
				if (lists.length === 0) return null;
				const list = pick(random, lists).value;
				const entry = pick(random, list as Json[]);
				entry.storageSequence += 1;
				return `seq ${entry.storageSequence}`;
			},
		},
	];

	for (const mutator of mutators) {
		it(`rejects ${mutator.name}`, () => {
			let applied = 0;
			for (const seed of SEEDS) {
				const random = rng(seed);
				const { name, record } = pick(random, all);
				const copy = structuredClone(record);
				const where = mutator.apply(copy, random);
				if (where === null) continue;
				applied += 1;
				const accepted = validatorOf(copy)(copy) !== null;
				expect(
					accepted,
					`ACCEPTED a mutation: class="${mutator.name}" seed=${seed} fixture=${name} at=${where}`,
				).toBe(false);
			}
			expect(applied, `the class "${mutator.name}" never applied`).toBeGreaterThan(3);
		});
	}

	it("a canary never survives a round trip through the policy: flagged text is replaced, never passed", () => {
		// The positive side of the secret-leaf property: free text that is flagged is accepted ONLY as the fixed withheld text.
		const snapshot = all.find((f) => f.name === "current/identity")!.record;
		const copy = structuredClone(snapshot);
		copy.lastNotification.title = "withheld: looks like a path, address or credential";
		expect(validateEndoCockpitRuntimeIdentityV0(copy)).not.toBeNull();
		for (const text of FLAGGED) {
			copy.lastNotification.title = text;
			expect(validateEndoCockpitRuntimeIdentityV0(copy), text).toBeNull();
		}
	});
});
