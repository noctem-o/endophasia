// Adversarial inputs below are SYNTHETIC, never runtime evidence.
import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { buildFixtures, CASES } from "../research/dsh-native/build-fixtures.ts";
import { assertDshProvenance, buildProvenance, DSH_AUDITED_FILES } from "../research/dsh-native/inventory.ts";
import { checkDshLog, dshLogAcceptable, readDshLog } from "../research/dsh-native/log.ts";
import { assertKilled, assertRecovery, prepareScratch, waitForProcess } from "../research/dsh-native/reproduce.ts";
import { findLeaks } from "../research/dsh-native/sanitise.ts";
import { encodeFrames, encodeRaw } from "../research/dsh-native/synthetic.ts";

const study = fileURLToPath(new URL("../research/dsh-native/", import.meta.url));
const fixtures = join(study, "fixtures", "real");
const vocabulary = JSON.parse(readFileSync(join(study, "vocabulary.json"), "utf8"));
const tool = readDshLog(readFileSync(join(fixtures, "tool-read.events.jsonl")));
const header = tool.header!;
const events = tool.events;
const temp = mkdtempSync(join(tmpdir(), "endo-dsh-repair-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const check = (bytes: Uint8Array) => checkDshLog(readDshLog(bytes), vocabulary);

describe("reader integrity regressions (SYNTHETIC)", () => {
	it.each([1, 2, 3])("classifies a %i-byte Zstandard magic as a torn frame", (length) => {
		const read = readDshLog(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]).subarray(0, length));
		expect(read.physical).toBe("zstd");
		expect(read.tail).toEqual({ kind: "torn-frame", completeBytes: 0, trailingBytes: length });
	});
	it.each([false, true])("refuses invalid UTF-8 in a complete JSON string (compressed=%s)", (compressed) => {
		const raw = Buffer.concat([
			encodeRaw(header, []),
			Buffer.from('{"type":"future/x","seq":0,"time":1,"ignorable":true,"data":"'),
			Buffer.from([0xff]),
			Buffer.from('"}\n'),
		]);
		const read = readDshLog(compressed ? zstdCompressSync(raw) : raw);
		expect(read.tail.kind).toBe("unreadable");
		expect(dshLogAcceptable(checkDshLog(read, vocabulary))).toBe(false);
	});
	it.each([false, true])(
		"refuses a row continued in another complete frame (empty frame between=%s)",
		(emptyBetween) => {
			const raw = encodeRaw(header, events);
			const cut = raw.indexOf(0x0a) + 12;
			const parts = [
				zstdCompressSync(raw.subarray(0, cut)),
				...(emptyBetween ? [zstdCompressSync(Buffer.alloc(0))] : []),
				zstdCompressSync(raw.subarray(cut)),
			];
			const read = readDshLog(Buffer.concat(parts));
			expect(dshLogAcceptable(checkDshLog(read, vocabulary))).toBe(false);
			expect(read.tail.kind).not.toBe("clean");
		},
	);
	it.each([false, true])("refuses empty complete physical rows (compressed=%s)", (compressed) => {
		const raw = encodeRaw(header, events);
		for (const at of [0, raw.indexOf(0x0a) + 1, raw.length]) {
			const damaged = Buffer.concat([raw.subarray(0, at), Buffer.from("\n"), raw.subarray(at)]);
			const read = readDshLog(compressed ? zstdCompressSync(damaged) : damaged);
			expect(read.problems).toEqual(expect.arrayContaining([expect.stringMatching(/empty.*row|row.*empty/)]));
			expect(dshLogAcceptable(checkDshLog(read, vocabulary))).toBe(false);
		}
	});
	it("refuses duplicate open step starts without inflating the observed step count", () => {
		const at = events.findIndex((e) => e.type === "step/start");
		const duplicate = [...events.slice(0, at + 1), events[at]!, ...events.slice(at + 1)].map((e, seq) => ({
			...e,
			seq,
		}));
		const result = check(encodeRaw(header, duplicate));
		expect(result.findings.map((f) => f.code)).toContain("step-started-twice");
		expect(result.summary.turns[0]!.steps).toBe(2);
		expect(dshLogAcceptable(result)).toBe(false);
	});

	it("enforces the raw byte limit at and immediately beyond the boundary", () => {
		const raw = encodeRaw(header, events);
		expect(readDshLog(raw, raw.length).tail.kind).toBe("clean");
		expect(readDshLog(raw, raw.length - 1).tail).toEqual({
			kind: "unreadable",
			reason: "the decoded size bound was exceeded",
		});
	});
	it("enforces cumulative capacity, including zero, while allowing empty frames", () => {
		const raw = encodeRaw(header, events);
		const full = zstdCompressSync(raw);
		const empty = zstdCompressSync(Buffer.alloc(0));
		const byte = zstdCompressSync(Buffer.from("\n"));
		expect(readDshLog(Buffer.concat([full, empty]), raw.length).tail.kind).toBe("clean");
		for (const bytes of [Buffer.concat([full, byte, byte]), byte]) {
			const read = readDshLog(bytes, bytes === byte ? 0 : raw.length);
			expect(read.tail).toEqual({ kind: "unreadable", reason: "the decoded size bound was exceeded" });
		}
	});
	it("accepts unknown ignorable surface events and still refuses unknown required ones", () => {
		for (const type of ["future/surface", "plugin:acme/surface"]) {
			const unknown = { type, seq: events.length, time: events.at(-1)!.time, data: {}, surfaceOp: "append" };
			expect(dshLogAcceptable(check(encodeRaw(header, [...events, { ...unknown, ignorable: true }])))).toBe(true);
			expect(dshLogAcceptable(check(encodeRaw(header, [...events, unknown])))).toBe(false);
		}
	});
	it("flags duplicate results and retains the first result's sequence and outcome", () => {
		const first = events.find((e) => e.type === "tool/result")!;
		const duplicate = {
			...first,
			seq: events.length,
			data: { ...(first.data as object), message: { ...(first.data as any).message, isError: true } },
		};
		const result = check(encodeRaw(header, [...events, duplicate]));
		expect(result.findings.map((f) => f.code)).toContain("duplicate-tool-result");
		expect(result.summary.toolCalls[0]).toMatchObject({ resultSeq: first.seq, isError: false });
		expect(dshLogAcceptable(result)).toBe(false);
	});
});

describe("fixture publication integrity (SYNTHETIC inputs)", () => {
	function inputs(label: string): { raw: string; destination: string } {
		const base = join(temp, label);
		const raw = join(base, "raw");
		const destination = join(base, "published");
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "previous"), "valid previous evidence");
		for (const name of CASES) {
			mkdirSync(join(raw, name), { recursive: true });
			writeFileSync(join(raw, name, "session.v4.jsonl.zstd"), encodeFrames(header, events));
			writeFileSync(join(raw, name, "stream.ndjson"), '{"type":"synthetic"}\n');
		}
		return { raw, destination };
	}
	it.each([
		"torn-row",
		"torn-frame",
		"bad-json",
		"bad-seq",
		"missing",
		"leak",
		"bad-observer",
		"utf8-stream",
		"utf8-observer",
	])("leaves ALL previous evidence intact after late-case failure: %s", (damage) => {
		const { raw, destination } = inputs(damage);
		const last = join(raw, CASES.at(-1)!);
		const log = join(last, "session.v4.jsonl.zstd");
		if (damage === "torn-row") writeFileSync(log, encodeRaw(header, events).subarray(0, -1));
		if (damage === "torn-frame") writeFileSync(log, encodeFrames(header, events).subarray(0, -1));
		if (damage === "bad-json") writeFileSync(log, Buffer.concat([encodeRaw(header, events), Buffer.from("bad\n")]));
		if (damage === "bad-seq") writeFileSync(log, encodeRaw(header, [{ ...events[0]!, seq: 5 }]));
		if (damage === "missing") rmSync(log);
		if (damage === "leak") writeFileSync(join(last, "stream.ndjson"), '{"type":"You are a coding agent"}\n');
		if (damage === "bad-observer") writeFileSync(join(last, "observer.ndjson"), "invalid\n");
		if (damage === "utf8-stream" || damage === "utf8-observer")
			writeFileSync(join(last, damage === "utf8-stream" ? "stream.ndjson" : "observer.ndjson"), Buffer.from([0xff]));
		expect(() => buildFixtures(raw, destination)).toThrow();
		expect(readdirSync(destination)).toEqual(["previous"]);
		expect(readFileSync(join(destination, "previous"), "utf8")).toBe("valid previous evidence");
	});
	it("publishes a complete set and reports missing observer counts as unknown", () => {
		const { raw, destination } = inputs("success");
		buildFixtures(raw, destination);
		expect(readdirSync(destination)).toHaveLength(CASES.length * 2 + 1);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES) {
			expect(comparison[name].transientAssistantStreamFrames).toBeNull();
			expect(comparison[name].liveEvents).toBeNull();
		}
	});
	it("sanitises comparison type/phase labels and scans comparison-only secret content", () => {
		const { raw, destination } = inputs("comparison-privacy");
		for (const name of CASES)
			writeFileSync(
				join(raw, name, "stream.ndjson"),
				`${JSON.stringify({ type: "status", phase: `${join(raw, "..")}/PRIVATE-CANARY` })}\n`,
			);
		buildFixtures(raw, destination);
		const text = readFileSync(join(destination, "comparison.json"), "utf8");
		expect(text).not.toContain(temp);
		expect(text).toContain("/fixture/study");
	});

	it.each(["raw", "ancestor", "symlink-alias", "symlink-parent", "raw-child"])(
		"refuses publication overlapping raw evidence: %s",
		(kind) => {
			const { raw } = inputs(`overlap-${kind}`);
			const before = CASES.map((name) => readFileSync(join(raw, name, "session.v4.jsonl.zstd")));
			let destination =
				kind === "ancestor" ? join(raw, "..") : kind === "raw-child" ? join(raw, "nested", "output") : raw;
			if (kind === "symlink-alias") {
				destination = `${raw}-alias`;
				symlinkSync(raw, destination);
			}
			if (kind === "symlink-parent") {
				const alias = `${raw}-parent`;
				symlinkSync(join(raw, ".."), alias);
				destination = join(alias, "raw");
			}
			expect(() => buildFixtures(raw, destination)).toThrow(/overlap/);
			for (const [index, name] of CASES.entries())
				expect(readFileSync(join(raw, name, "session.v4.jsonl.zstd"))).toEqual(before[index]);
		},
	);
	it.each(["directory", "file"])("protects source evidence reached through a raw-case %s symlink", (kind) => {
		const { raw } = inputs(`source-link-${kind}`);
		const source = join(raw, CASES[0]!, "session.v4.jsonl.zstd");
		const before = readFileSync(source);
		const external = join(temp, `external-source-${kind}`);
		if (kind === "directory") {
			renameSync(join(raw, CASES[0]!), external);
			symlinkSync(external, join(raw, CASES[0]!));
		} else {
			mkdirSync(external);
			renameSync(source, join(external, "original"));
			symlinkSync(join(external, "original"), source);
		}
		expect(() => buildFixtures(raw, external)).toThrow(/overlap/);
		expect(readFileSync(source)).toEqual(before);
	});

	it.each([0, 4, events.length])(
		"retains live-only types after a matching durable suffix beginning at seq %i",
		(offset) => {
			const { raw, destination } = inputs(`late-observer-${offset}`);
			const extra = {
				type: "future/volatile",
				seq: events.length,
				time: events.at(-1)!.time,
				data: {},
				ignorable: true,
			};
			for (const name of CASES)
				writeFileSync(
					join(raw, name, "observer.ndjson"),
					`${[...events.slice(offset), extra]
						.map((event) => JSON.stringify({ feed: "session/event", event }))
						.join("\n")}\n`,
				);
			buildFixtures(raw, destination);
			const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
			for (const name of CASES) expect(comparison[name].liveOnlyTypes).toEqual(["future/volatile"]);
		},
	);
	it("does not infer live-only events when the observed overlap differs from the persisted log", () => {
		const { raw, destination } = inputs("mismatched-observer");
		const live = [
			...events.slice(4).map((e, i) => (i === 0 ? { ...e, time: -1 } : e)),
			{ type: "future/volatile", seq: events.length, time: 1, data: {} },
		];
		for (const name of CASES)
			writeFileSync(
				join(raw, name, "observer.ndjson"),
				`${live.map((event) => JSON.stringify({ feed: "session/event", event })).join("\n")}\n`,
			);
		buildFixtures(raw, destination);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES) expect(comparison[name].liveOnlyTypes).toBeNull();
	});

	it.each(["user", "app", "read", "tool"])("does not mistake ordinary vocabulary for the account %s", (username) => {
		expect(findLeaks("user app read tool", [`/home/${username}`])).toEqual([]);
		expect(findLeaks(`/home/${username}`, []).length).toBeGreaterThan(0);
		expect(findLeaks(`/Users/${username}/capture`, []).length).toBeGreaterThan(0);
	});
});

describe("scratch and process boundaries", () => {
	it("clears both crash captures on a repeated run and leaves other scenarios alone", () => {
		const root = join(temp, "scratch");
		prepareScratch(root, "crash");
		for (const name of ["crash-killed", "crash-resumed", "tool-read"]) {
			mkdirSync(join(root, "raw", name), { recursive: true });
			writeFileSync(join(root, "raw", name, "observer.ndjson"), "stale");
		}
		prepareScratch(root, "crash");
		expect(readdirSync(join(root, "raw"))).toEqual(["tool-read"]);
	});
	it("refuses unclaimed nonempty roots and symlinked raw directories before cleanup", () => {
		const outside = join(temp, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "keep"), "untouched");
		expect(() => prepareScratch(outside, "crash")).toThrow(/empty or owned/);
		const root = join(temp, "symlink-root");
		prepareScratch(root, "crash");
		symlinkSync(outside, join(root, "raw"));
		expect(() => prepareScratch(root, "crash")).toThrow(/symlink/);
		expect(readFileSync(join(outside, "keep"), "utf8")).toBe("untouched");
	});
	it("captures original pipe bytes across split UTF-8 and retains corrupt bytes for strict validation", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: () => true,
		});
		const outcome = waitForProcess(child as unknown as ChildProcess);
		child.stdout.write(Buffer.from([0xc3]));
		child.stdout.write(Buffer.from([0xa9, 0xff]));
		child.stderr.write(Buffer.from([0xff]));
		child.emit("close", 0, null);
		const captured = await outcome;
		expect(captured.stdout).toEqual(Buffer.from([0xc3, 0xa9, 0xff]));
		expect(captured.stderr).toEqual(Buffer.from([0xff]));
	});

	it("rejects both unsuccessful delivery and natural completion racing successful delivery", () => {
		expect(() => assertKilled(false, { code: 0, signal: null })).toThrow();
		expect(() => assertKilled(true, { code: 0, signal: null })).toThrow();
		expect(() => assertKilled(true, { code: null, signal: "SIGTERM" })).toThrow();
		expect(() => assertKilled(true, { code: null, signal: "SIGKILL" })).not.toThrow();
	});
	it("requires both a successful resume process and persisted recovery evidence", () => {
		const before = readDshLog(readFileSync(join(fixtures, "crash-killed.events.jsonl")));
		const after = readDshLog(readFileSync(join(fixtures, "crash-resumed.events.jsonl")));
		expect(() => assertRecovery(before, after, { code: 0, signal: null })).not.toThrow();
		expect(() => assertRecovery(before, after, { code: 1, signal: null })).toThrow(/process failed/);
		expect(() => assertRecovery(before, before, { code: 0, signal: null })).toThrow(/evidence/);
	});
	it("rejects unaudited dirty source at the pinned HEAD (a disposable fake checkout)", () => {
		const root = join(temp, "checkout");
		mkdirSync(root);
		for (const file of [...DSH_AUDITED_FILES, "apps/cli/package.json"]) {
			const target = join(root, file);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, file.endsWith("package.json") ? '{"version":"0.2.1-rc.2"}' : "synthetic");
		}
		writeFileSync(join(root, "unaudited"), "clean");
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["-C", root, "add", "."]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"synthetic",
		]);
		const clean = buildProvenance(root);
		expect(() => assertDshProvenance(clean, clean)).not.toThrow();
		writeFileSync(join(root, "unaudited"), "dirty");
		const dirty = buildProvenance(root);
		expect(dirty.dsh.commit).toBe(clean.dsh.commit);
		expect(dirty.files).toEqual(clean.files);
		expect(() => assertDshProvenance(dirty, clean)).toThrow(/clean pinned provenance/);
	});
});
