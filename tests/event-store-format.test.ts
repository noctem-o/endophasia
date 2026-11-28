import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { EndoHarnessFingerprintRecordV0 } from "../protocol/harness.ts";
import { createEndoDurableEventStoreV0, openEndoEventStreamReadOnlyV0 } from "../storage/event-store.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { detectEndoStoreFormatV0, endoStoreFormatPathsV0 } from "../storage/store-format.ts";
import {
	attachEndoEventStoreWriterV0,
	initEndoEventStoreV0,
	migrateEndoEventStoreV0,
} from "../storage/store-format-write.ts";
import { concurrentEvent } from "./helpers/concurrent-event-fixture.ts";
import { readEventLogBytesV0 } from "./helpers/event-log-bytes.ts";

const FORMAT = "per-attachment-v1";
const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./fixtures/concurrent-event-writer.ts", import.meta.url));
const roots: string[] = [];
const workers: {
	child: ChildProcessWithoutNullStreams;
	done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}[] = [];

function scratch() {
	const path = mkdtempSync(join(tmpdir(), "endo-format-"));
	roots.push(path);
	return path;
}

function env(root: string) {
	return {
		...process.env,
		HOME: root,
		XDG_DATA_HOME: join(root, "data"),
		ENDO_STORE_ROOT: join(root, "default"),
		ENDO_DIGEST_KEY_FILE: join(root, "key"),
	};
}

function worker(root: string, mode: string, attachment = "pi.one") {
	const child = spawn(process.execPath, [WORKER, root, mode, attachment], { env: env(root) });
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	workers.push({ child, done });
	return {
		done,
		next: async () => (await lines.next()).value,
		proceed: () => child.stdin.write("!"),
		kill: () => child.kill("SIGKILL"),
	};
}

afterEach(async () => {
	for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await Promise.allSettled(workers.splice(0).map(({ done }) => done));
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function cli(root: string, ...args: string[]) {
	return spawnSync(process.execPath, [CLI, "store", ...args], { env: env(root), encoding: "utf8" });
}

function legacy(root: string) {
	const store = createEndoDurableEventStoreV0(root);
	store.ingest(concurrentEvent("pi.one"));
	store.close();
	return readFileSync(endoStoreFormatPathsV0(root).legacy);
}

it("observes two distinct processes on an absent root, waits for one initialiser, and refuses a third with the same attachment", async () => {
	const root = scratch();
	const a = worker(root, "init-pause");
	expect(await a.next()).toBe("held:init");
	expect(detectEndoStoreFormatV0(root).state).toBe("initialising");
	const b = worker(root, "wait", "pi.two");
	expect(await b.next()).toBe("waiting:init");
	a.proceed();
	expect(await a.next()).toBe(`endo: created store ${root} (format: ${FORMAT})`);
	expect(await a.next()).toBe("held:attachment");
	b.proceed();
	expect(await b.next()).toBe("held:attachment");
	const c = worker(root, "attach");
	expect(await c.next()).toMatch(/^refused:another Endophasia session attachment/);
	expect((await c.done).code).toBe(1);
	const paths = endoStoreFormatPathsV0(root);
	expect(existsSync(paths.legacy)).toBe(false);
	const bytes = readFileSync(paths.lock);
	expect(readFileSync(paths.witness)).toEqual(bytes);
	expect(JSON.parse(bytes.toString())).toMatchObject({ format: FORMAT, origin: "created", legacy: null });
	const events = readEventLogBytesV0(root).toString("utf8");
	expect(events).toContain(concurrentEvent("pi.one").id);
	expect(events).toContain(concurrentEvent("pi.two").id);
	for (const item of [a, b]) {
		item.proceed();
		expect((await item.done).code).toBe(0);
	}
	expect(readFileSync(paths.lock)).toEqual(bytes);
});

it("uses the public CLI to inspect, initialise and refuse reinitialisation without touching an ambient default", () => {
	const root = scratch();
	const paths = endoStoreFormatPathsV0(root);
	expect(cli(root, "init", "--format", FORMAT).status).toBe(1);
	expect(cli(root, "migrate", "--to", FORMAT, "--commit").status).toBe(1);
	expect(existsSync(join(root, "default"))).toBe(false);
	expect(JSON.parse(cli(root, "status", "--root", root).stdout)).toMatchObject({ state: "absent" });
	expect(existsSync(paths.events)).toBe(false);
	const init = cli(root, "init", "--root", root, "--format", FORMAT);
	expect(init.status, init.stderr).toBe(0);
	expect(init.stdout).toBe(`endo: created store ${root} (format: ${FORMAT})\n`);
	const body = readFileSync(paths.lock);
	expect(Object.keys(JSON.parse(body.toString())).sort()).toEqual([
		"attachment",
		"createdAt",
		"format",
		"legacy",
		"origin",
		"schemaVersion",
	]);
	expect(readFileSync(paths.witness)).toEqual(body);
	expect(existsSync(paths.legacy)).toBe(false);
	expect(cli(root, "init", "--root", root, "--format", FORMAT).status).toBe(1);
	expect(readFileSync(paths.lock)).toEqual(body);
});

it("recovers a killed initialiser and refuses a live hung one without claiming its lock", async () => {
	const root = scratch();
	const a = worker(root, "init-pause");
	expect(await a.next()).toBe("held:init");
	const paths = endoStoreFormatPathsV0(root);
	const lock = readFileSync(paths.lock);
	const b = worker(root, "hung", "pi.two");
	expect(await b.next()).toMatch(/^refused:store initialisation by pid \d+ has not completed/);
	expect((await b.done).code).toBe(1);
	expect(readFileSync(paths.lock)).toEqual(lock);
	a.kill();
	expect((await a.done).signal).toBe("SIGKILL");
	const c = worker(root, "attach");
	expect(await c.next()).toContain("created store");
	expect(await c.next()).toBe("held:attachment");
	c.proceed();
	expect((await c.done).code).toBe(0);
	expect(existsSync(paths.recovery)).toBe(false);
});

it("enforces both startup orders including after all writers exit, without changing old bytes", async () => {
	const root = scratch();
	const paths = endoStoreFormatPathsV0(root);
	const original = legacy(root);
	const old = worker(root, "legacy", "old");
	expect(await old.next()).toBe("held:legacy");
	const attempt = worker(root, "attach", "pi.two");
	expect(await attempt.next()).toMatch(/refused:.*endo store migrate --root/);
	expect((await attempt.done).code).toBe(1);
	const migrate = cli(root, "migrate", "--root", root, "--to", FORMAT, "--commit");
	expect(migrate.status).toBe(1);
	expect(migrate.stderr).toMatch(/another Endophasia session attachment/);
	old.proceed();
	expect((await old.done).code).toBe(0);

	const dry = cli(root, "migrate", "--root", root, "--to", FORMAT);
	expect(dry.status, dry.stderr).toBe(0);
	expect(JSON.parse(dry.stdout)).toMatchObject({
		state: "legacy-only",
		dryRun: true,
		proposedSeal: {
			bytes: original.length,
			frames: 1,
			sha256: createHash("sha256").update(original).digest("hex"),
		},
	});
	expect(existsSync(paths.lock)).toBe(false);
	expect(readFileSync(paths.legacy)).toEqual(original);
	expect(cli(root, "migrate", "--root", root, "--to", FORMAT, "--commit").status).toBe(0);
	const sentinel = readFileSync(paths.lock);
	const next = worker(root, "attach", "pi.two");
	expect(await next.next()).toBe("held:attachment");
	for (const active of [true, false]) {
		const retryOld = worker(root, "legacy", "old");
		expect(await retryOld.next()).toMatch(/non-PID lock barrier/);
		expect((await retryOld.done).code).toBe(1);
		expect(readFileSync(paths.lock)).toEqual(sentinel);
		if (active) {
			next.proceed();
			expect((await next.done).code).toBe(0);
		}
	}
	expect(readFileSync(paths.legacy)).toEqual(original);
});

it("admits exactly one migrator when another process already holds the migration lock", async () => {
	const root = scratch();
	const original = legacy(root);
	const winner = worker(root, "migrate");
	expect(await winner.next()).toBe("held:migrate");
	const contender = worker(root, "migrate");
	expect(await contender.next()).toMatch(/refused:another Endophasia session attachment/);
	expect((await contender.done).code).toBe(1);
	winner.proceed();
	expect(await winner.next()).toBe("migrated");
	expect((await winner.done).code).toBe(0);
	expect(detectEndoStoreFormatV0(root).state).toBe("mixed");
	expect(readFileSync(endoStoreFormatPathsV0(root).legacy)).toEqual(original);
});

it("recognises a DEVELOP-only store without changing it and seals absence explicitly when migrated", () => {
	const root = scratch();
	mkdirSync(join(root, "develop"));
	expect(detectEndoStoreFormatV0(root).state).toBe("legacy-uninitialised");
	expect(existsSync(endoStoreFormatPathsV0(root).events)).toBe(false);
	expect(() => initEndoEventStoreV0(root)).toThrow(/legacy-uninitialised/);
	expect(migrateEndoEventStoreV0(root).proposedSeal).toEqual({ logPresent: false });
	expect(migrateEndoEventStoreV0(root, true).state).toMatchObject({
		state: "mixed",
		sentinel: { legacy: { logPresent: false } },
	});
	writeFileSync(endoStoreFormatPathsV0(root).legacy, "");
	expect(detectEndoStoreFormatV0(root)).toMatchObject({
		state: "legacy-seal-drift",
		findings: [{ kind: "appeared" }],
	});
});

it("seals a present empty legacy log with two hex digests, distinct from a missing log", () => {
	const root = scratch();
	const paths = endoStoreFormatPathsV0(root);
	mkdirSync(paths.events);
	writeFileSync(paths.legacy, "");
	const emptyDigest = createHash("sha256").digest("hex");
	const seal = { bytes: 0, frames: 0, sha256: emptyDigest, prefixDigest: emptyDigest };
	expect(migrateEndoEventStoreV0(root).proposedSeal).toEqual(seal);
	expect(migrateEndoEventStoreV0(root, true).state).toMatchObject({ state: "mixed", sentinel: { legacy: seal } });
	expect(readFileSync(paths.witness)).toEqual(readFileSync(paths.lock));
});

it("does not create an E4 registry before a matching attachment lock is held", () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const attachment = "fx.attachment";
	const record = JSON.parse(
		readFileSync(
			new URL("./fixtures/schema-compat/endo.harness-fingerprint.v1/minimal.json", import.meta.url),
			"utf8",
		),
	) as EndoHarnessFingerprintRecordV0;
	const directory = join(root, "harness", attachment);
	const unlocked = openEndoHarnessRegistryV0(root, attachment);
	expect(existsSync(directory)).toBe(false);
	expect(() => unlocked.append("fingerprint", record)).toThrow(/live attachment lock/);
	expect(existsSync(directory)).toBe(false);
	const writer = attachEndoEventStoreWriterV0(root, attachment);
	try {
		expect(writer.mode).toBe("attachment");
		if (writer.mode !== "attachment") throw new Error("expected attachment writer");
		const registry = openEndoHarnessRegistryV0(root, attachment, { lock: writer.lock });
		expect(existsSync(directory)).toBe(false);
		registry.append("fingerprint", record);
		expect(registry.last("fingerprint")).toEqual(record);
		expect(existsSync(join(directory, "records.log"))).toBe(true);
		writer.close();
		expect(() => registry.append("fingerprint", record)).toThrow(/live attachment lock/);
	} finally {
		writer.close();
	}
});

it.each(["broken-sentinel", "future-format", "invalid-witness", "streams-alone"])(
	"refuses a %s barrier without altering its bytes",
	(kind) => {
		const root = scratch();
		initEndoEventStoreV0(root);
		const paths = endoStoreFormatPathsV0(root);
		if (kind === "broken-sentinel") writeFileSync(paths.lock, "{");
		if (kind === "invalid-witness") writeFileSync(paths.witness, "{");
		if (kind === "future-format") writeFileSync(paths.lock, '{"format":"per-attachment-v2"}');
		if (kind === "streams-alone") {
			rmSync(paths.witness);
			rmSync(paths.lock);
		}
		const contents = (path: string) => (existsSync(path) ? readFileSync(path) : null);
		const bytes = [contents(paths.lock), contents(paths.witness)];
		expect(detectEndoStoreFormatV0(root).state).toBe("format-barrier-broken");
		expect(() => attachEndoEventStoreWriterV0(root, "pi.one")).toThrow(/format-barrier-broken/);
		expect(() => createEndoDurableEventStoreV0(root)).toThrow(/format-barrier-broken/);
		expect(() => initEndoEventStoreV0(root)).toThrow(/format-barrier-broken/);
		expect(() => migrateEndoEventStoreV0(root, true)).toThrow(/format-barrier-broken/);
		expect([contents(paths.lock), contents(paths.witness)]).toEqual(bytes);
		expect(existsSync(paths.legacy)).toBe(false);
	},
);

it.each(["truncated", "grown-append", "grown-rewritten", "rewritten-same-size", "deleted", "witness-seal-mismatch"])(
	"reports %s drift without losing the healthy writer, but refuses after sentinel loss",
	(kind) => {
		const root = scratch();
		const paths = endoStoreFormatPathsV0(root);
		const bytes = legacy(root);
		const oldWriter = createEndoDurableEventStoreV0(root);
		migrateEndoEventStoreV0(root, true);
		expect(() => oldWriter.ingest(concurrentEvent("pi.two"))).toThrow(/not writable/);
		oldWriter.close();
		const changed = Buffer.from(bytes);
		changed[8] ^= 1;
		if (kind === "truncated") writeFileSync(paths.legacy, bytes.subarray(0, bytes.length - 1));
		if (kind === "grown-append") appendFileSync(paths.legacy, "x");
		if (kind === "grown-rewritten") writeFileSync(paths.legacy, Buffer.concat([changed, Buffer.from("x")]));
		if (kind === "rewritten-same-size") writeFileSync(paths.legacy, changed);
		if (kind === "deleted") rmSync(paths.legacy);
		if (kind === "witness-seal-mismatch") {
			const copy = JSON.parse(readFileSync(paths.witness, "utf8"));
			copy.legacy.sha256 = "f".repeat(64);
			writeFileSync(paths.witness, JSON.stringify(copy));
		}
		const status = cli(root, "status", "--root", root);
		expect(status.status, status.stderr).toBe(0);
		expect(JSON.parse(status.stdout)).toMatchObject({ state: "legacy-seal-drift", findings: [{ kind }] });
		expect(() => createEndoDurableEventStoreV0(root)).toThrow(/not writable/);
		const writer = attachEndoEventStoreWriterV0(root, "pi.two");
		writer.store.ingest(concurrentEvent("pi.two"));
		rmSync(paths.lock);
		expect(() => writer.store.ingest(concurrentEvent("pi.two", 2))).toThrow(/sentinel-lost/);
		writer.close();
		const broken = cli(root, "status", "--root", root);
		expect(broken.status).toBe(2);
		expect(JSON.parse(broken.stdout)).toMatchObject({
			state: "format-barrier-broken",
			finding: { kind: "sentinel-lost" },
		});
		expect(() => attachEndoEventStoreWriterV0(root, "pi.three")).toThrow(/sentinel-lost/);
	},
);

it("leaves a deterministic torn append in one process, preserves the bytes on recovery, and leaves the sibling writable", async () => {
	const root = scratch();
	initEndoEventStoreV0(root);
	const dying = worker(root, "crash");
	const healthy = worker(root, "attach", "pi.two");
	expect(await dying.next()).toBe("held:attachment");
	expect(await healthy.next()).toBe("held:attachment");
	dying.proceed();
	expect((await dying.done).signal).toBe("SIGKILL");
	const reader = openEndoEventStreamReadOnlyV0(root, { kind: "attachment", attachmentId: "pi.one" });
	expect(reader.recovery()).toMatchObject({ truncated: true, recovered: false, tail: { bytes: 9 } });
	expect(reader.page().events).toEqual([concurrentEvent("pi.one")]);
	reader.close();
	healthy.proceed();
	expect((await healthy.done).code).toBe(0);
	const resumed = attachEndoEventStoreWriterV0(root, "pi.one");
	expect(resumed.store.recovery()).toMatchObject({ recovered: true, discarded: { bytes: 9 } });
	resumed.store.ingest(concurrentEvent("pi.one", 2));
	expect(resumed.store.length).toBe(2);
	resumed.close();
});
