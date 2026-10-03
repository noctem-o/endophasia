// Short writes (docs/audits/pr14-post-merge.md L3). writeSync may write fewer bytes than asked (a full disk, a quota,
// a signal); the storage layer compares the count with the length and throws, so a short write is never reported as a
// complete append. node:fs is mocked for this file only: `shortWrites` makes the next N writeSync calls write half
// their bytes.
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { EndoEventV0 } from "../protocol/event.ts";
import { createEndoArtifactStoreV0, sha256HexOfBytesV0 } from "../storage/artifacts.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { createEndoFrameLogV0 } from "../storage/log.ts";

const fault = vi.hoisted(() => ({ shortWrites: 0 }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const shortable = ((fd: number, buffer: NodeJS.ArrayBufferView, ...rest: unknown[]) => {
		if (fault.shortWrites > 0 && ArrayBuffer.isView(buffer) && buffer.byteLength > 1) {
			fault.shortWrites -= 1;
			const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
			return actual.writeSync(fd, bytes.subarray(0, Math.floor(bytes.length / 2)));
		}
		return (actual.writeSync as (...args: unknown[]) => number)(fd, buffer, ...rest);
	}) as typeof actual.writeSync;
	return { ...actual, default: { ...actual, writeSync: shortable }, writeSync: shortable };
});

const dirs: string[] = [];
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
	fault.shortWrites = 0;
});

function event(n: number): EndoEventV0 {
	return {
		schemaVersion: "endo.event.v0",
		id: `endo.event.w${n}`,
		kind: "session.started",
		source: "runtime-fact",
		sequence: n,
		at: "2026-10-03T11:00:00Z",
		coordinates: { sessionId: "endo.session.s1" },
		producer: "endo.tool.observatory",
		derivedFrom: [],
		payload: {},
	};
}

describe("short writes", () => {
	it("the mock really writes half (the fault is live)", () => {
		const file = join(tempDir("endo-short-probe-"), "probe");
		const fd = openSync(file, "w");
		fault.shortWrites = 1;
		try {
			expect(writeSync(fd, Buffer.from("12345678"))).toBe(4);
		} finally {
			closeSync(fd);
		}
		expect(readFileSync(file, "utf8")).toBe("1234");
	});

	it("a frame log append throws, the partial frame reads as a torn tail, and further appends are refused", () => {
		const file = join(tempDir("endo-short-log-"), "a.log");
		const log = createEndoFrameLogV0(file);
		expect(log.append(Buffer.from("one"))).toBe(1);
		fault.shortWrites = 1;
		expect(() => log.append(Buffer.from("two-two-two"))).toThrow(/short write/);
		expect(log.length).toBe(1);
		const read = log.read();
		expect(read.truncated).toBe(true);
		expect(read.frames).toHaveLength(1);
		expect(read.tail?.bytes).toBe(Math.floor((4 + 11 + 32) / 2));
		expect(() => log.append(Buffer.from("three"))).toThrow(/torn tail/);
	});

	it("the event store goes dead on a short write, and the next writable open reports and cuts the partial frame", () => {
		const root = tempDir("endo-short-events-");
		const store = createEndoDurableEventStoreV0(root);
		store.ingest(event(1));
		fault.shortWrites = 1;
		expect(() => store.ingest(event(2))).toThrow(/log write failed/);
		expect(() => store.ingest(event(3))).toThrow(/dead/);
		store.close();
		const reopened = createEndoDurableEventStoreV0(root);
		expect(reopened.length).toBe(1);
		const recovery = reopened.recovery();
		expect(recovery).toMatchObject({ truncated: true, recovered: true });
		expect(recovery.discarded?.bytes).toBeGreaterThan(0);
		expect(readFileSync(recovery.discarded!.preservedAt).length).toBe(recovery.discarded!.bytes);
		reopened.ingest(event(2));
		expect(reopened.length).toBe(2);
	});

	it("truncateTo throws when preserving the cut bytes is short, and leaves the log as it was", () => {
		const file = join(tempDir("endo-short-truncate-"), "a.log");
		const log = createEndoFrameLogV0(file);
		log.append(Buffer.from("one"));
		const fd = openSync(file, "a");
		try {
			writeSync(fd, Buffer.from("torn-tail-bytes"));
		} finally {
			closeSync(fd);
		}
		const before = readFileSync(file);
		fault.shortWrites = 1;
		expect(() => log.truncateTo(1)).toThrow(/short write/);
		expect(readFileSync(file)).toEqual(before);
	});

	it("an artifact put throws and never publishes a file under the digest", () => {
		const root = tempDir("endo-short-artifacts-");
		const store = createEndoArtifactStoreV0(root);
		const bytes = Buffer.from("artifact-content");
		const digest = sha256HexOfBytesV0(bytes);
		fault.shortWrites = 1;
		expect(() => store.put(digest, bytes)).toThrow(/short write/);
		expect(readdirSync(join(root, "artifacts"))).not.toContain(digest);
		expect(store.has(digest)).toBe(false);
	});
});
