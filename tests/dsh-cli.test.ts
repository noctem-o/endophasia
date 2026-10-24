// CLI acceptance uses retained sanitised runtime fixtures and explicitly synthetic mutations only. Every process has
// isolated HOME/XDG/key/store paths; no DSH installation, active session or provider is consulted.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { DSH_NATIVE_LOSS_ACCOUNTING_V0, projectDshTrajectoryV0, readDshLog } from "../adapters/dsh-native/index.ts";
import { dshImportCommand } from "../cli/dsh.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { encodeFrames, encodeRaw } from "../research/dsh-native/synthetic.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import * as storeModule from "../storage/event-store.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { createEndoFrameLogV0 } from "../storage/log.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../research/dsh-native/fixtures/real/", import.meta.url));
const roots: string[] = [];
function scratch() {
	const root = mkdtempSync(join(tmpdir(), "endo-dsh-cli-"));
	roots.push(root);
	return root;
}
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	process.exitCode = undefined;
});
function env(root: string) {
	return {
		PATH: process.env.PATH ?? "",
		HOME: join(root, "home"),
		XDG_DATA_HOME: join(root, "data"),
		ENDO_DIGEST_KEY_FILE: join(root, "key"),
		NO_COLOR: "1",
		NODE_NO_WARNINGS: "1",
	};
}
function run(root: string, args: string[], extra: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, [CLI, ...args], {
		cwd: root,
		env: { ...env(root), ...extra },
		encoding: "utf8",
		timeout: 20000,
	});
}
function source(
	root: string,
	name = "tool-read",
	bytes: Uint8Array = readFileSync(join(FIXTURES, `${name}.events.jsonl`)),
) {
	const directory = join(root, "source");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "session.v4.jsonl"), bytes);
	writeFileSync(join(directory, "session.lock"), "synthetic lock; never opened by the CLI");
	return directory;
}
// Access time is deliberately excluded: reads may update it at the filesystem's discretion. No metadata restoration writes.
function snapshot(directory: string): unknown {
	return [".", ...readdirSync(directory)].sort().map((name) => {
		const path = join(directory, name),
			st = lstatSync(path);
		return {
			name,
			size: st.size,
			mode: st.mode,
			mtime: st.mtimeMs,
			ctime: st.ctimeMs,
			ino: st.ino,
			bytes: st.isFile() ? readFileSync(path).toString("hex") : null,
		};
	});
}
function attempt(root: string, args: string[], extra: Record<string, string | undefined> = {}) {
	const dir = join(root, "source"),
		before = snapshot(dir),
		result = run(root, args, extra);
	expect(snapshot(dir)).toEqual(before);
	expect(result.signal).toBeNull();
	return result;
}
function report(result: ReturnType<typeof run>, status: string, exit: number) {
	expect(result.status, result.stderr).toBe(exit);
	const value = JSON.parse(result.stdout);
	expect(value.status).toBe(status);
	expect(result.stdout).toBe(canonicalEndoJsonV0(value));
	return value;
}
function events(root: string) {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		return store.page({ limit: 10000 }).events;
	} finally {
		store.close();
	}
}
const logPath = (root: string) => join(root, "store", "events", "events.log");
const keyFile = (byte: string) =>
	JSON.stringify({ schemaVersion: "endo.digest-key.v0", domain: "installation", key: byte.repeat(32) });

describe("native DSH CLI dispatch and resource-free commands", () => {
	it("help advertises explicit cold import and static fidelity accounting without creating resources", () => {
		const root = scratch();
		const result = run(root, ["--help"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("dsh import");
		expect(result.stdout).toContain("dsh loss-accounting");
		expect(readdirSync(root)).toEqual([]);
	});
	it.each([
		[],
		["bad"],
		["constructor"],
		["toString"],
		["__proto__"],
		["loss-accounting", "extra"],
		["loss-accounting", "--root", "store"],
	])("rejects invalid family invocation %j without side effects", (...args: string[]) => {
		const root = scratch(),
			result = run(root, ["dsh", ...args]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("usage: endo dsh");
		expect(readdirSync(root)).toEqual([]);
	});
	it("loss accounting is exactly the exported static contract even without HOME, key, store or DSH", () => {
		const root = scratch(),
			result = run(root, ["dsh", "loss-accounting"], {
				HOME: undefined,
				XDG_DATA_HOME: undefined,
				ENDO_DIGEST_KEY_FILE: undefined,
			});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(canonicalEndoJsonV0(DSH_NATIVE_LOSS_ACCOUNTING_V0));
		expect(result.stderr).toBe("");
		expect(readdirSync(root)).toEqual([]);
	});
	it.each([
		[],
		["--root"],
		["--root", ""],
		["--root", "store"],
		["--bad"],
		[""],
		["--root", "a", "--root", "b", "source"],
		["a", "b", "source"],
		["a", "source", "--root", "b"],
		["source", "--unknown"],
		["source", "extra", "--root", "a"],
	])("rejects malformed import %j before creating resources", (...args: string[]) => {
		const root = scratch(),
			result = run(root, ["dsh", "import", ...args]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("usage: endo dsh import");
		expect(readdirSync(root)).toEqual([]);
	});
});

describe("native DSH CLI import", () => {
	it.each(["named", "positional", "default-env", "default-xdg", "default-home"])(
		"imports and reimports with %s root",
		(kind) => {
			const root = scratch(),
				dir = source(root);
			let args = ["dsh", "import", dir],
				extra: Record<string, string | undefined> = {},
				dest = join(root, "store");
			if (kind === "named") args = ["dsh", "import", "--root", dest, dir];
			if (kind === "positional") args = ["dsh", "import", dest, dir];
			if (kind === "default-env") extra.ENDO_STORE_ROOT = dest;
			if (kind === "default-xdg") dest = join(root, "data", "endophasia", "store");
			if (kind === "default-home") {
				extra.XDG_DATA_HOME = undefined;
				dest = join(root, "home", ".local", "share", "endophasia", "store");
			}
			const first = attempt(root, args, extra);
			report(first, "imported", 0);
			expect(existsSync(join(root, "key"))).toBe(true);
			expect(events(dest).length).toBeGreaterThan(0);
			const before = readFileSync(join(dest, "events", "events.log"));
			const same = report(attempt(root, args, extra), "unchanged", 0);
			expect(Object.values(same.appended)).toEqual([0, 0, 0, 0]);
			expect(readFileSync(join(dest, "events", "events.log"))).toEqual(before);
			if (kind.startsWith("default")) expect(first.stderr).toContain("using the default store");
			else expect(first.stderr).toBe("");
		},
	);
	it.each(["xdg", "home"])("creates the existing installation key at its %s default", (kind) => {
		const root = scratch(),
			dir = source(root),
			extra: Record<string, string | undefined> = { ENDO_DIGEST_KEY_FILE: undefined };
		if (kind === "home") extra.XDG_DATA_HOME = undefined;
		report(attempt(root, ["dsh", "import", join(root, "store"), dir], extra), "imported", 0);
		const key =
			kind === "xdg"
				? join(root, "data", "endophasia", "digest-key")
				: join(root, "home", ".local", "share", "endophasia", "digest-key");
		expect(existsSync(key)).toBe(true);
		expect(statSync(key).mode & 0o077).toBe(0);
	});
	it("incremental import preserves the same evidence and layers while retaining per-import clocks/checkpoints", () => {
		const root = scratch(),
			bytes = readFileSync(join(FIXTURES, "tool-read.events.jsonl")),
			read = readDshLog(bytes);
		const dir = source(root, "tool-read", encodeRaw(read.header!, read.events.slice(0, 10))),
			dest = join(root, "store"),
			one = join(root, "one-shot");
		report(attempt(root, ["dsh", "import", dest, dir]), "imported", 0);
		writeFileSync(join(dir, "session.v4.jsonl"), bytes);
		report(attempt(root, ["dsh", "import", dest, dir]), "imported", 0);
		report(attempt(root, ["dsh", "import", one, dir]), "imported", 0);
		const incremental = events(dest),
			single = events(one);
		const evidence = (all: typeof single) =>
			all
				.filter((e) => e.kind !== "dsh.import-checkpoint")
				.map(({ at: _at, ...e }) => e)
				.sort((a, b) => a.id.localeCompare(b.id));
		expect(evidence(incremental)).toEqual(evidence(single));
		expect(incremental.filter((e) => e.kind === "dsh.import-checkpoint")).toHaveLength(2);
		expect(single.filter((e) => e.kind === "dsh.import-checkpoint")).toHaveLength(1);
		expect(projectDshTrajectoryV0(incremental, { session: "session-1", store: dest }).layers).toEqual(
			projectDshTrajectoryV0(single, { session: "session-1", store: one }).layers,
		);
	});
	it.each(["history", "shorter", "domain", "mapping"])(
		"refuses changed %s without replacing destination evidence",
		(kind) => {
			const root = scratch(),
				dir = source(root),
				dest = join(root, "store"),
				args = ["dsh", "import", dest, dir];
			report(attempt(root, args), "imported", 0);
			if (kind === "domain") writeFileSync(join(root, "key"), keyFile("77"));
			if (kind === "history" || kind === "shorter") {
				const read = readDshLog(readFileSync(join(dir, "session.v4.jsonl")));
				if (kind === "history") (read.events[0]!.data as any).message = "synthetic changed history";
				writeFileSync(
					join(dir, "session.v4.jsonl"),
					encodeRaw(read.header!, kind === "shorter" ? read.events.slice(0, 10) : read.events),
				);
			}
			if (kind === "mapping") {
				const saved = JSON.parse(JSON.stringify(events(dest))) as EndoEventV0[];
				const header = saved.find((e) => e.kind === "dsh.session-imported")!;
				(header.payload as any).mapping = "dsh-native-mapping.0";
				writeFileSync(logPath(root), Buffer.alloc(0));
				const log = createEndoFrameLogV0(logPath(root));
				for (const e of saved) log.append(Buffer.from(canonicalEndoJsonV0(e)));
			}
			const before = readFileSync(logPath(root)),
				r = report(attempt(root, args), "refused", 1);
			expect(r.refusals.map((x: any) => x.code)).toContain(
				{
					history: "history-changed",
					shorter: "source-shorter",
					domain: "digest-domain-differs",
					mapping: "mapping-changed",
				}[kind],
			);
			expect(readFileSync(logPath(root))).toEqual(before);
		},
	);
	it.each(["new-generation", "malformed", "invalid-utf8", "infinite-seq"])(
		"emits a structured refusal for %s and creates no destination",
		(kind) => {
			const root = scratch(),
				dir = source(root),
				dest = join(root, "store");
			if (kind === "new-generation") writeFileSync(join(dir, "session.v5.jsonl"), "unsupported");
			if (kind === "malformed") writeFileSync(join(dir, "session.v4.jsonl"), "{ private malformed text\n");
			if (kind === "invalid-utf8") writeFileSync(join(dir, "session.v4.jsonl"), Buffer.from([0xff, 0x0a]));
			if (kind === "infinite-seq")
				writeFileSync(
					join(dir, "session.v4.jsonl"),
					readFileSync(join(dir, "session.v4.jsonl"), "utf8").replace('"seq":0', '"seq":1e999'),
				);
			const r = report(attempt(root, ["dsh", "import", dest, dir]), "refused", 1);
			expect(r.refusals.length).toBeGreaterThan(0);
			expect(existsSync(dest)).toBe(false);
		},
	);
	it("reports a torn source row without repairing it or losing the complete prefix", () => {
		const root = scratch(),
			dir = source(root);
		appendFileSync(join(dir, "session.v4.jsonl"), '{"cut":');
		const r = report(attempt(root, ["dsh", "import", join(root, "store"), dir]), "imported", 0);
		expect(r.tail.kind).toBe("torn-row");
		expect(events(join(root, "store")).find((e) => e.kind === "dsh.import-checkpoint")!.payload).toMatchObject({
			tail: "torn-row",
		});
	});
	it.each(["missing", "file", "empty", "multiple", "symlink-log"])(
		"fails source preflight for %s without acquiring resources",
		(kind) => {
			const root = scratch();
			const dir = join(root, "source");
			if (kind === "file") writeFileSync(dir, "not a directory");
			if (kind === "empty") mkdirSync(dir);
			if (kind === "multiple") {
				source(root);
				writeFileSync(join(dir, "session.v4.jsonl.zstd"), "ambiguous");
			}
			if (kind === "symlink-log") {
				mkdirSync(dir);
				writeFileSync(join(root, "elsewhere"), "not source");
				symlinkSync(join(root, "elsewhere"), join(dir, "session.v4.jsonl"));
			}
			const result = run(root, ["dsh", "import", join(root, "store"), dir]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("source preflight failed");
			expect(existsSync(join(root, "key"))).toBe(false);
			expect(existsSync(join(root, "store"))).toBe(false);
		},
	);
	it("an unwritable destination gives no fabricated report and leaves source intact", () => {
		const root = scratch(),
			dir = source(root),
			dest = join(root, "store");
		mkdirSync(dest);
		chmodSync(dest, 0o500);
		try {
			const result = attempt(root, ["dsh", "import", dest, dir]);
			expect(result.status).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("DSH import failed");
		} finally {
			chmodSync(dest, 0o700);
		}
	});
	it.each(["torn", "sealed"])("does not recover a %s destination even before a refusal", (kind) => {
		const root = scratch(),
			dir = source(root),
			dest = join(root, "store"),
			args = ["dsh", "import", dest, dir];
		report(attempt(root, args), "imported", 0);
		if (kind === "torn") appendFileSync(logPath(root), Buffer.from([1, 2, 3]));
		else {
			const bytes = readFileSync(logPath(root));
			bytes[20] ^= 1;
			writeFileSync(logPath(root), bytes);
		}
		const before = readFileSync(logPath(root)),
			names = readdirSync(join(dest, "events"));
		const r = attempt(root, args);
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(readFileSync(logPath(root))).toEqual(before);
		expect(readdirSync(join(dest, "events"))).toEqual(names);
	});
});

describe("native DSH CLI privacy and destination isolation", () => {
	const canary = "PRIVATE/transcript-DO-NOT-DISCLOSE-7f93";
	it.each(["tool", "unknown-required", "unknown-ignorable", "version", "malformed", "stored-mapping"])(
		"withholds %s canaries from output and durable records",
		(kind) => {
			const root = scratch(),
				read = readDshLog(readFileSync(join(FIXTURES, "tool-read.events.jsonl")));
			if (kind === "tool") {
				const call = read.events.find((e) => e.type === "tool/call")!;
				(call.data as any).name = canary;
				(call.data as any).callId = canary;
				(call.data as any).arguments = JSON.stringify({ private: canary });
				const result = read.events.find((e) => e.type === "tool/result")!;
				(result.data as any).message.toolCallId = canary;
				(result.data as any).message.content = [{ type: "text", text: canary }];
				read.events = read.events.slice(0, read.events.indexOf(result)); // Unpaired call warning echoes its name in the API report.
			}
			if (kind === "unknown-required" || kind === "unknown-ignorable")
				read.events.push({
					type: canary,
					seq: read.events.length,
					time: 2000,
					data: { private: canary },
					...(kind === "unknown-ignorable" ? { ignorable: true as const } : {}),
				});
			if (kind === "version") (read.header as any).version = canary;
			let bytes = encodeRaw(read.header!, read.events);
			if (kind === "malformed") bytes = Buffer.from(`{${canary}\n`);
			const dir = source(root, "tool-read", bytes),
				dest = join(root, "store"),
				args = ["dsh", "import", dest, dir];
			if (kind === "stored-mapping") {
				report(attempt(root, args), "imported", 0);
				const all = JSON.parse(JSON.stringify(events(dest)));
				(all.find((e: any) => e.kind === "dsh.session-imported").payload as any).mapping = canary;
				writeFileSync(logPath(root), Buffer.alloc(0));
				const log = createEndoFrameLogV0(logPath(root));
				for (const e of all) log.append(Buffer.from(canonicalEndoJsonV0(e)));
			}
			const result = attempt(root, args);
			expect(result.stdout).not.toContain(canary);
			expect(result.stderr).not.toContain(canary);
			if (kind !== "stored-mapping" && existsSync(logPath(root)))
				expect(readFileSync(logPath(root), "utf8")).not.toContain(canary);
			if (kind === "stored-mapping") expect(result.status).toBe(1);
			else
				report(
					result,
					["tool", "unknown-ignorable"].includes(kind) ? "imported" : "refused",
					["tool", "unknown-ignorable"].includes(kind) ? 0 : 1,
				);
			const key = JSON.parse(readFileSync(join(root, "key"), "utf8")).key;
			expect(result.stdout + result.stderr).not.toContain(key);
		},
	);
	it.each(["public", "malformed"])("does not use a %s key or echo its contents/path", (kind) => {
		const root = scratch(),
			dir = source(root),
			key = join(root, canary.replaceAll("/", "-"));
		writeFileSync(
			key,
			kind === "public"
				? JSON.stringify({
						schemaVersion: "endo.digest-key.v0",
						domain: "fixture-public",
						public: true,
						key: "11".repeat(32),
					})
				: canary,
		);
		const result = attempt(root, ["dsh", "import", join(root, "store"), dir], { ENDO_DIGEST_KEY_FILE: key });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(canary);
		expect(result.stderr).not.toContain(key);
		expect(existsSync(join(root, "store"))).toBe(false);
	});
	it.each([
		"same",
		"nested",
		"ancestor",
		"store-alias",
		"events-alias",
		"key-source",
		"key-store",
		"dangling-key",
		"hardlink",
	])("rejects %s overlap/alias before acquiring a writer", (kind) => {
		const root = scratch(),
			dir = source(root),
			dest = join(root, "store");
		let target = dest,
			key = join(root, "key");
		if (kind === "same") target = dir;
		if (kind === "nested") target = join(dir, "new-store");
		if (kind === "ancestor") target = root;
		if (kind === "store-alias") {
			symlinkSync(dir, dest);
		}
		if (kind === "events-alias") {
			mkdirSync(dest);
			symlinkSync(dir, join(dest, "events"));
		}
		if (kind === "key-source") key = join(dir, "new-key");
		if (kind === "key-store") key = join(dest, "new-key");
		if (kind === "dangling-key") {
			key = join(root, "key-link");
			symlinkSync(join(dir, "missing-key"), key);
		}
		if (kind === "hardlink") {
			mkdirSync(join(dest, "events"), { recursive: true });
			writeFileSync(join(dir, "sidecar"), "");
			linkSync(join(dir, "sidecar"), logPath(root));
		}
		const result = attempt(root, ["dsh", "import", target, dir], { ENDO_DIGEST_KEY_FILE: key });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("destination preflight failed");
		expect(existsSync(join(root, "key"))).toBe(false);
	});
});

describe("DSH CLI acquired-store lifecycle", () => {
	it.each(["success", "refusal", "throw"])("closes every acquired store on %s", (kind) => {
		const root = scratch(),
			dir = source(root),
			dest = join(root, "store");
		if (kind === "refusal") writeFileSync(join(dir, "session.v5.jsonl"), "unsupported");
		for (const [name, value] of Object.entries(env(root))) vi.stubEnv(name, value);
		const actual = storeModule.createEndoDurableEventStoreV0;
		const opened: ReturnType<typeof actual>[] = [];
		vi.spyOn(storeModule, "createEndoDurableEventStoreV0").mockImplementation((path, options) => {
			const store = actual(path, options);
			opened.push(store);
			if (kind === "throw" && options?.readOnly !== true)
				vi.spyOn(store, "ingest").mockImplementation(() => {
					throw new Error("PRIVATE/raw exception fragment");
				});
			return store;
		});
		const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		if (kind === "throw") expect(() => dshImportCommand([dest, dir])).toThrow("DSH import failed");
		else dshImportCommand([dest, dir]);
		expect(opened).toHaveLength(kind === "refusal" ? 1 : 2);
		for (const store of opened) expect(() => store.page()).toThrow("closed");
		if (kind === "throw") expect(output).not.toHaveBeenCalled();
		expect(existsSync(dest)).toBe(kind !== "refusal");
	});
});

describe("compressed and read-only source directories", () => {
	it.each([false, true])("imports a compressed snapshot and preserves torn-frame evidence (torn=%s)", (torn) => {
		const root = scratch(),
			read = readDshLog(readFileSync(join(FIXTURES, "tool-read.events.jsonl")));
		const frames = encodeFrames(read.header!, read.events, 3);
		const dir = source(root, "tool-read", torn ? frames.subarray(0, frames.length - 5) : frames);
		renameSync(join(dir, "session.v4.jsonl"), join(dir, "session.v4.jsonl.zstd"));
		const result = report(attempt(root, ["dsh", "import", join(root, "store"), dir]), "imported", 0);
		expect(result.tail.kind).toBe(torn ? "torn-frame" : "clean");
	});
	it("needs only read/search permission on source, not write permission", () => {
		const root = scratch(),
			dir = source(root);
		for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o400);
		chmodSync(dir, 0o500);
		try {
			report(attempt(root, ["dsh", "import", join(root, "store"), dir]), "imported", 0);
		} finally {
			chmodSync(dir, 0o700);
			for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o600);
		}
	});
});

it.each([["-x"], ["--root", "-x"]])(
	"rejects flag-shaped root %j with a valid source before writes",
	(...prefix: string[]) => {
		const root = scratch(),
			dir = source(root),
			before = readdirSync(root).sort();
		const result = attempt(root, ["dsh", "import", ...prefix, dir]);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("usage: endo dsh import");
		expect(readdirSync(root).sort()).toEqual(before);
	},
);
