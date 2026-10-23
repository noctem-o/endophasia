// Adversarial inputs below are SYNTHETIC, never runtime evidence.
import { type ChildProcess, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	chmodSync,
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
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { constants, zstdCompressSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { buildFixtures, CASES } from "../research/dsh-native/build-fixtures.ts";
import { assertDshProvenance, buildProvenance, DSH_AUDITED_FILES } from "../research/dsh-native/inventory.ts";
import { checkDshLog, dshLogAcceptable, readDshLog } from "../research/dsh-native/log.ts";
import {
	assertKilled,
	assertRecovery,
	prepareScratch,
	profilePatch,
	waitForProcess,
} from "../research/dsh-native/reproduce.ts";
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
const checkedFrame = (bytes: Uint8Array) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
const check = (bytes: Uint8Array) => checkDshLog(readDshLog(bytes), vocabulary);

describe("reader integrity regressions (SYNTHETIC)", () => {
	it("requires the pinned writer's checksum flag on every compressed frame", () => {
		const raw = encodeRaw(header, events);
		for (const bytes of [
			zstdCompressSync(raw),
			Buffer.concat([checkedFrame(raw), zstdCompressSync(Buffer.alloc(0))]),
		]) {
			const read = readDshLog(bytes);
			expect(read.tail.kind).toBe("unreadable");
			expect(read.problems.join(" ")).toMatch(/checksum/);
			expect(dshLogAcceptable(checkDshLog(read, vocabulary))).toBe(false);
		}
		expect(readDshLog(checkedFrame(raw)).tail.kind).toBe("clean");
	});
	it.each(["checksum", "size"])("retains structurally complete frame counts on %s failure", (kind) => {
		const first = checkedFrame(encodeRaw(header, []));
		const second = checkedFrame(Buffer.from("{}\n"));
		if (kind === "checksum") second[second.length - 1] ^= 0xff;
		const read = readDshLog(
			Buffer.concat([first, second, checkedFrame(Buffer.from("{}\n"))]),
			kind === "size" ? encodeRaw(header, []).length : undefined,
		);
		expect(read.frames).toBe(3);
		expect(read.tail.kind).toBe("unreadable");
	});
	it.each(["constructor", "toString", "__proto__"])("counts ignorable %s events numerically", (type) => {
		const extra = { type, seq: events.length, time: events.at(-1)!.time, data: {}, ignorable: true as const };
		const result = check(encodeRaw(header, [...events, extra, { ...extra, seq: extra.seq + 1 }]));
		expect(dshLogAcceptable(result)).toBe(true);
		expect(Object.hasOwn(result.summary.byType, type)).toBe(true);
		expect(result.summary.byType[type]).toBe(2);
		expect(JSON.parse(JSON.stringify(result.summary.byType))[type]).toBe(2);
	});

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
		const read = readDshLog(compressed ? checkedFrame(raw) : raw);
		expect(read.tail.kind).toBe("unreadable");
		expect(dshLogAcceptable(checkDshLog(read, vocabulary))).toBe(false);
	});
	it.each([false, true])(
		"refuses a row continued in another complete frame (empty frame between=%s)",
		(emptyBetween) => {
			const raw = encodeRaw(header, events);
			const cut = raw.indexOf(0x0a) + 12;
			const parts = [
				checkedFrame(raw.subarray(0, cut)),
				...(emptyBetween ? [checkedFrame(Buffer.alloc(0))] : []),
				checkedFrame(raw.subarray(cut)),
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
			const read = readDshLog(compressed ? checkedFrame(damaged) : damaged);
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
		const full = checkedFrame(raw);
		const empty = checkedFrame(Buffer.alloc(0));
		const byte = checkedFrame(Buffer.from("\n"));
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
	it.each(["stream.ndjson", "observer.ndjson"])("refuses blank or unterminated physical records in %s", (file) => {
		for (const damage of ["blank", "unterminated"]) {
			const { raw, destination } = inputs(`capture-rows-${file}-${damage}`);
			const record = file === "stream.ndjson" ? '{"type":"synthetic"}' : '{"feed":"agent/status","status":"idle"}';
			writeFileSync(join(raw, CASES.at(-1)!, file), damage === "blank" ? `${record}\n\n` : record);
			expect(() => buildFixtures(raw, destination)).toThrow(/row|record/);
			expect(readdirSync(destination)).toEqual(["previous"]);
		}
	});

	it("publishes a complete set and reports missing observer counts as unknown", () => {
		const { raw, destination } = inputs("success");
		buildFixtures(raw, destination);
		expect(readdirSync(destination)).toHaveLength(CASES.length * 2 + 1);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES) {
			expect(comparison[name].transientAssistantStreamFrames).toBeNull();
			expect(comparison[name].liveEvents).toBeNull();
			expect(comparison[name].persistedEventsNeverAnnouncedLive).toBeNull();
		}
	});
	it.each(["empty-file", "status-only", "prefix-only", "middle-only"])(
		"accounts for persisted rows absent from a valid %s observer capture",
		(kind) => {
			const { raw, destination } = inputs(`observer-coverage-${kind}`);
			const observed =
				kind === "prefix-only" ? events.slice(0, 4) : kind === "middle-only" ? events.slice(4, 8) : [];
			const records =
				kind === "status-only"
					? [{ feed: "agent/status", status: "idle" }]
					: observed.map((event) => ({ feed: "session/event", sessionId: header.id, event }));
			const text = records.length === 0 ? "" : `${records.map((row) => JSON.stringify(row)).join("\n")}\n`;
			for (const name of CASES) writeFileSync(join(raw, name, "observer.ndjson"), text);
			buildFixtures(raw, destination);
			const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
			const seen = new Set(observed.map((event) => event.seq));
			const absent = events.filter((event) => !seen.has(event.seq)).map((event) => `${event.seq}:${event.type}`);
			for (const name of CASES) {
				expect(comparison[name].liveEvents).toBe(observed.length);
				expect(comparison[name].persistedEventsNeverAnnouncedLive).toEqual(absent);
				if (observed.length === 0) {
					expect(comparison[name].liveFirstSeq).toBeNull();
					expect(comparison[name].liveOnlyTypes).toEqual([]);
				}
			}
		},
	);

	it.each(["foreign-overlap", "foreign-no-overlap", "missing-id", "mixed-id"])(
		"refuses %s observer session identity before publication",
		(kind) => {
			const { raw, destination } = inputs(`identity-${kind}`);
			const observed = kind === "foreign-no-overlap" ? [{ ...events[0]!, seq: events.length }] : events.slice(0, 2);
			const records = observed.map((event, index) => ({
				feed: "session/event",
				event,
				...(kind === "missing-id"
					? {}
					: { sessionId: kind === "mixed-id" && index === 0 ? header.id : "other-session" }),
			}));
			writeFileSync(
				join(raw, CASES.at(-1)!, "observer.ndjson"),
				`${records.map((row) => JSON.stringify(row)).join("\n")}\n`,
			);
			expect(() => buildFixtures(raw, destination)).toThrow(/observer.*session/i);
			expect(readFileSync(join(destination, "previous"), "utf8")).toBe("valid previous evidence");
		},
	);
	it.each([
		"/workspace/private/log",
		"/unlisted-root/private/log",
		"C:\\Private\\log",
		"\\\\server\\private\\log",
		"/fixture/../../private/log",
	])("refuses residual path %s before publication", (path) => {
		const { raw, destination } = inputs(`residual-path-${Buffer.from(path).toString("hex")}`);
		writeFileSync(
			join(raw, CASES.at(-1)!, "stream.ndjson"),
			`${JSON.stringify({ type: "synthetic", text: `stack (${path}:12:3)` })}\n`,
		);
		expect(() => buildFixtures(raw, destination)).toThrow(/leak/);
		expect(readFileSync(join(destination, "previous"), "utf8")).toBe("valid previous evidence");
	});

	it("refuses a missing persisted session identity even when the observer identity is also missing", () => {
		const { raw, destination } = inputs("missing-both-identities");
		const { id: _id, ...withoutId } = header;
		writeFileSync(
			join(raw, CASES.at(-1)!, "session.v4.jsonl.zstd"),
			encodeFrames(withoutId as typeof header, events),
		);
		writeFileSync(
			join(raw, CASES.at(-1)!, "observer.ndjson"),
			`${JSON.stringify({ feed: "session/event", event: events[0] })}\n`,
		);
		expect(() => buildFixtures(raw, destination)).toThrow(/capture is not clean valid evidence/);
		expect(readFileSync(join(destination, "previous"), "utf8")).toBe("valid previous evidence");
	});

	it("preserves prototype-named observer frame counters through sanitisation and publication", () => {
		const { raw, destination } = inputs("observer-kind-counters");
		const kinds = ["constructor", "toString", "__proto__"];
		const records = [...kinds, ...kinds].map((kind) => ({ feed: "agent/assistant-stream", kind }));
		for (const name of CASES)
			writeFileSync(join(raw, name, "observer.ndjson"), `${records.map((row) => JSON.stringify(row)).join("\n")}\n`);
		buildFixtures(raw, destination);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES)
			for (const kind of kinds) expect(comparison[name].transientAssistantStreamFrames[kind]).toBe(2);
	});
	it("scans decoded escaped paths and permits fixture paths, URLs and relative event names", () => {
		expect(findLeaks('{"text":"\\u002fworkspace\\u002fprivate"}', [])).not.toEqual([]);
		expect(findLeaks("at:/unlisted/private", [])).not.toEqual([]);
		expect(findLeaks(JSON.stringify({ text: "file:///unlisted/private" }), [])).not.toEqual([]);
		expect(findLeaks(JSON.stringify({ text: "file:///fixture/%2e%2e/%2e%2e/private" }), [])).not.toEqual([]);
		expect(findLeaks(JSON.stringify({ text: "file://private-host/share/private.txt" }), [])).not.toEqual([]);
		expect(findLeaks(JSON.stringify({ text: "//unlisted/private" }), [])).not.toEqual([]);
		expect(findLeaks(JSON.stringify({ text: "/非公開/private" }), [])).not.toEqual([]);
		expect(
			findLeaks(
				JSON.stringify({
					text: "<path>/fixture/workspace/file</path> https://example.test/v1/foo user/message notes.txt",
				}),
				[],
			),
		).toEqual([]);
	});

	it("preserves a measured empty headless capture without inventing a blank record", () => {
		const { raw, destination } = inputs("empty-stream");
		for (const name of CASES) writeFileSync(join(raw, name, "stream.ndjson"), "");
		buildFixtures(raw, destination);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES) {
			expect(readFileSync(join(destination, `${name}.stream.ndjson`), "utf8")).toBe("");
			expect(comparison[name].jsonStreamLines).toBe(0);
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
						.map((event) => JSON.stringify({ feed: "session/event", sessionId: header.id, event }))
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
				`${live.map((event) => JSON.stringify({ feed: "session/event", sessionId: header.id, event })).join("\n")}\n`,
			);
		buildFixtures(raw, destination);
		const comparison = JSON.parse(readFileSync(join(destination, "comparison.json"), "utf8"));
		for (const name of CASES) {
			expect(comparison[name].liveOnlyTypes).toBeNull();
			expect(comparison[name].persistedEventsNeverAnnouncedLive).toBeNull();
		}
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
	it("quotes every dynamic YAML scalar without changing its value", () => {
		const home = join(temp, 'yaml # " [scratch]\nnew: value');
		const modelUrl = 'http://127.0.0.1:8080/v1?x=1 # "\nnew: value';
		const patch = profilePatch({ home, modelUrl, stub: false, keyed: true });
		const scalar = (key: string) =>
			JSON.parse(
				patch
					.split("\n")
					.find((line) => line.trimStart().startsWith(`${key}: `))!
					.trimStart()
					.slice(key.length + 2),
			);
		expect(scalar("root")).toBe(join(home, "sessions"));
		expect(scalar("baseURL")).toBe(modelUrl);
		const observer = patch
			.split("\n")
			.find((line) => line.includes("observer.mjs"))!
			.trimStart()
			.slice(6);
		expect(JSON.parse(observer)).toBe(join(study, "instruments", "observer.mjs"));
	});
	it("makes a new scratch root private and narrows an owned root before reuse", () => {
		const root = join(temp, "private-root");
		prepareScratch(root, "stub-retry");
		expect(statSync(root).mode & 0o777).toBe(0o700);
		chmodSync(root, 0o755);
		prepareScratch(root, "stub-retry");
		expect(statSync(root).mode & 0o777).toBe(0o700);
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
