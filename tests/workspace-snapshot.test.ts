// Workspace archives (storage/workspace-snapshot.ts): a v1 archive restores content and modification times (files,
// links, directories deepest first, the root last), so `ls -la` sees the recorded workspace; a v0 archive still
// restores; the same tree and times give the same bytes; unsafe archives are refused before anything is written.
import {
	existsSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	archiveEndoWorkspaceV0,
	parseEndoWorkspaceArchiveV0,
	pinEndoWorkspaceTimesV0,
	restoreEndoWorkspaceV0,
} from "../storage/workspace-snapshot.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-snapshot-test-"));
	dirs.push(dir);
	return dir;
};

/** A small tree with distinct, old times on every entry (times set leaves first, as a recorder's tree would have). */
function tree(): string {
	const root = join(scratch(), "work");
	mkdirSync(join(root, "src", "deep"), { recursive: true });
	writeFileSync(join(root, "notes.txt"), "status: draft\n");
	writeFileSync(join(root, "src", "deep", "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
	symlinkSync("notes.txt", join(root, "link"));
	// Seconds at the middle of the millisecond, so a libuv that truncates to microseconds (Node 22's) still stores it.
	const at = (date: string) => (Date.parse(date) + 0.5) / 1000;
	lutimesSync(join(root, "link"), at("2026-01-02T03:04:05.383Z"), at("2026-01-02T03:04:05.383Z"));
	utimesSync(join(root, "notes.txt"), at("2026-01-02T03:04:05.678Z"), at("2026-01-02T03:04:05.678Z"));
	utimesSync(join(root, "src", "deep", "run.sh"), at("2026-02-03T04:05:06Z"), at("2026-02-03T04:05:06Z"));
	utimesSync(join(root, "src", "deep"), at("2026-03-04T05:06:07Z"), at("2026-03-04T05:06:07Z"));
	utimesSync(join(root, "src"), at("2026-04-05T06:07:08Z"), at("2026-04-05T06:07:08Z"));
	utimesSync(root, at("2026-05-06T07:08:09Z"), at("2026-05-06T07:08:09Z"));
	return root;
}

const mtime = (path: string, link = false) => Math.floor((link ? lstatSync(path) : statSync(path)).mtimeMs);

describe("workspace archives", () => {
	it("v1 restores content and every modification time, so a directory listing sees the recorded workspace", () => {
		const source = tree();
		const { bytes, summary } = archiveEndoWorkspaceV0(source);
		expect(summary).toMatchObject({ files: 2, directories: 2, symlinks: 1 });
		const target = join(scratch(), "restored");
		const archive = restoreEndoWorkspaceV0(bytes, target);
		expect(archive.schemaVersion).toBe("endo.workspace-archive.v1");
		expect(readFileSync(join(target, "notes.txt"), "utf8")).toBe("status: draft\n");
		expect(statSync(join(target, "src", "deep", "run.sh")).mode & 0o111).not.toBe(0);
		for (const path of ["notes.txt", "src/deep/run.sh", "src/deep", "src"])
			expect(mtime(join(target, path)), path).toBe(mtime(join(source, path)));
		expect(mtime(join(target, "link"), true)).toBe(mtime(join(source, "link"), true));
		expect(mtime(target)).toBe(mtime(source));
		expect(mtime(join(target, "notes.txt"))).toBe(Date.parse("2026-01-02T03:04:05.678Z"));
	});

	it("every millisecond value survives a restore exactly (no float rounding drops a millisecond)", () => {
		// Regression (CI, Node 22): restoring t ms as t / 1000 seconds lands a hair below the millisecond, and a libuv that
		// truncates to whole microseconds stores …382999 µs for …383 ms, about half of all values. Newer libuv keeps
		// nanoseconds and never showed it. Every value of one second is checked, on a file, a link, a directory and the root.
		const base = Date.parse("2026-10-04T09:00:00Z");
		const source = join(scratch(), "sweep");
		mkdirSync(join(source, "d"), { recursive: true });
		writeFileSync(join(source, "f"), "x");
		symlinkSync("f", join(source, "l"));
		const restoredAt: number[] = [];
		for (let ms = 0; ms < 1000; ms += 1) {
			const at = (base + ms + 0.5) / 1000;
			utimesSync(join(source, "f"), at, at);
			lutimesSync(join(source, "l"), at, at);
			utimesSync(join(source, "d"), at, at);
			utimesSync(source, at, at);
			for (const path of [join(source, "f"), join(source, "d"), source]) expect(mtime(path)).toBe(base + ms);
			expect(mtime(join(source, "l"), true)).toBe(base + ms);
			const target = join(scratch(), `sweep-${ms}`);
			restoreEndoWorkspaceV0(archiveEndoWorkspaceV0(source).bytes, target);
			for (const path of [join(target, "f"), join(target, "d"), target])
				if (mtime(path) !== mtime(source)) restoredAt.push(ms);
			if (mtime(join(target, "l"), true) !== mtime(join(source, "l"), true)) restoredAt.push(ms);
			rmSync(target, { recursive: true, force: true });
		}
		expect(restoredAt).toEqual([]);
	});

	it("pinning a tree gives every entry, links and the root included, one time; the archive then carries only it", () => {
		const source = tree();
		const pin = Date.parse("2026-01-01T00:00:00Z");
		pinEndoWorkspaceTimesV0(source, pin);
		for (const path of ["notes.txt", "src/deep/run.sh", "src/deep", "src"])
			expect(mtime(join(source, path)), path).toBe(pin);
		expect(mtime(join(source, "link"), true)).toBe(pin);
		expect(mtime(source)).toBe(pin);
		const archive = parseEndoWorkspaceArchiveV0(archiveEndoWorkspaceV0(source).bytes);
		expect(archive.rootMtimeMs).toBe(pin);
		expect(new Set(archive.entries.map((entry) => entry.mtimeMs))).toEqual(new Set([pin]));
		expect(() => pinEndoWorkspaceTimesV0(source, -1)).toThrow(/bad time/);
		expect(() => pinEndoWorkspaceTimesV0(source, 1.5)).toThrow(/bad time/);
	});

	it("the same tree with the same times always gives the same bytes", () => {
		const source = tree();
		expect(
			Buffer.from(archiveEndoWorkspaceV0(source).bytes).equals(Buffer.from(archiveEndoWorkspaceV0(source).bytes)),
		).toBe(true);
		const copy = join(scratch(), "copy");
		restoreEndoWorkspaceV0(archiveEndoWorkspaceV0(source).bytes, copy);
		expect(
			Buffer.from(archiveEndoWorkspaceV0(copy).bytes).equals(Buffer.from(archiveEndoWorkspaceV0(source).bytes)),
		).toBe(true);
	});

	it("a v0 archive (no times) still parses and restores, with fresh times", () => {
		const v0 = {
			schemaVersion: "endo.workspace-archive.v0",
			entries: [
				{ path: "a.txt", type: "file", executable: false, bytes: 2, base64: Buffer.from("hi").toString("base64") },
			],
		};
		const target = join(scratch(), "v0");
		restoreEndoWorkspaceV0(new TextEncoder().encode(canonicalEndoJsonV0(v0)), target);
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("hi");
		expect(mtime(join(target, "a.txt"))).toBeGreaterThan(Date.now() - 60_000);
	});

	it.each([
		["a path outside the root", { path: "../escape", type: "directory", mtimeMs: 1 }],
		["an absolute path", { path: "/etc/x", type: "directory", mtimeMs: 1 }],
		["a v1 entry without a time", { path: "a", type: "directory" }],
		["a negative time", { path: "a", type: "directory", mtimeMs: -1 }],
	])("refuses %s before writing anything", (_name, entry) => {
		const archive = { schemaVersion: "endo.workspace-archive.v1", rootMtimeMs: 1, entries: [entry] };
		const target = join(scratch(), "refused");
		expect(() => restoreEndoWorkspaceV0(new TextEncoder().encode(canonicalEndoJsonV0(archive)), target)).toThrow();
		expect(existsSync(join(target, "a"))).toBe(false);
	});

	it("refuses an entry under a symbolic link the archive creates, and a v1-only time on a v0 entry", () => {
		const underLink = {
			schemaVersion: "endo.workspace-archive.v1",
			rootMtimeMs: 1,
			entries: [
				{ path: "l", type: "symlink", target: "/tmp", mtimeMs: 1 },
				{ path: "l/x", type: "directory", mtimeMs: 1 },
			],
		};
		expect(() => parseEndoWorkspaceArchiveV0(new TextEncoder().encode(canonicalEndoJsonV0(underLink)))).toThrow(
			/symbolic link/,
		);
		const v0WithTime = {
			schemaVersion: "endo.workspace-archive.v0",
			entries: [{ path: "a", type: "directory", mtimeMs: 1 }],
		};
		expect(() => parseEndoWorkspaceArchiveV0(new TextEncoder().encode(canonicalEndoJsonV0(v0WithTime)))).toThrow(
			/unknown field "mtimeMs"/,
		);
	});
});
