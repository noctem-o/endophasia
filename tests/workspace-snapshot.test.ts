// Workspace archives (storage/workspace-snapshot.ts): a v1 archive restores content and modification times (files,
// links, directories deepest first, the root last), so `ls -la` sees the recorded workspace; a v0 archive still
// restores; the same tree and times give the same bytes; unsafe archives are refused before anything is written.
import {
	existsSync,
	lstatSync,
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
	const at = (date: string) => new Date(date);
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

	it("refuses an entry under a symbolic link the archive creates, and a time on a v0 entry", () => {
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
			/bad time/,
		);
	});
});
