// `endo --help`, `endo --version` and the invalid-invocation exit code, through the development entry point. The
// packaged binary is exercised separately by scripts/package-smoke.mjs (npm run test:package).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endoVersionV0 } from "../cli/help.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
	version: string;
};

const endo = (args: string[], cwd: string) =>
	spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, HOME: cwd } });

describe("endo help and version", () => {
	const dir = mkdtempSync(join(tmpdir(), "endo-help-"));
	it("--help exits 0, describes the instrument and creates nothing", () => {
		const result = endo(["--help"], dir);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/experimental research instrument/);
		expect(result.stdout).toMatch(/Pi is installed and managed separately/);
		expect(result.stdout).toMatch(/--authorize-live-study/);
		expect(readdirSync(dir)).toEqual([]);
	});
	it("--version is the package.json version", () => {
		const result = endo(["--version"], dir);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(`${manifest.version}\n`);
		expect(endoVersionV0()).toBe(manifest.version);
		expect(readdirSync(dir)).toEqual([]);
	});
	it("an unknown or missing command is an invalid invocation (exit 2), including inherited property names", () => {
		for (const args of [["no-such-command"], [], ["constructor"], ["toString"]]) {
			const result = endo(args, dir);
			expect(result.status).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/usage: endo/);
		}
	});
	it("an inherited property name is a usage error in every command family, not a silent success", () => {
		for (const family of ["harness", "proxy", "steer", "experiment", "trajectory"])
			for (const sub of ["constructor", "toString", "__proto__"]) {
				const result = endo([family, sub], dir);
				expect(result.status, `${family} ${sub}`).toBe(1);
				expect(result.stderr).toMatch(new RegExp(`usage: endo ${family}`));
			}
	});
	it("a usage error does not claim a default store was used, and an empty root is refused", () => {
		const bare = endo(["ingest"], dir);
		expect(bare.status).toBe(1);
		expect(bare.stderr).toMatch(/usage: endo ingest/);
		expect(bare.stderr).not.toMatch(/default store/);
		const empty = endo(["ingest", "--root", "", "event.json"], dir);
		expect(empty.status).toBe(1);
		expect(empty.stderr).toMatch(/store root is empty/);
	});

	it("a command's own usage error keeps exit 1", () => {
		const result = endo(["status", "a", "b"], dir);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/usage: endo status/);
		rmSync(dir, { recursive: true, force: true });
	});
});
