import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Amendment 13: the G probe reports which errno came back through its exit code, a channel the unchanged TRUST-003 grader records.
// The probe runs here outside the sandbox, with /work pointed at a scratch directory; EROFS needs the grader's read-only mount and is
// checked only as part of the vocabulary.
const source = readFileSync("research/develop-verify-trust-004/guest/controls.ts", "utf8");
const probe = /Buffer\.from\(`([\s\S]*?)`\)/.exec(source)?.[1] as string;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		spawnSync("chmod", ["-R", "u+w", d]);
		rmSync(d, { recursive: true, force: true });
	}
});
const run = (mode: string, work: string) => {
	const d = mkdtempSync(join(tmpdir(), "dvt004-probe-"));
	dirs.push(d);
	writeFileSync(join(d, "probe.mjs"), probe.replaceAll("/work/", `${work}/`));
	const r = spawnSync(process.execPath, [join(d, "probe.mjs"), mode], { encoding: "utf8" });
	return { status: r.status, stdout: r.stdout };
};
const scratch = () => {
	const d = mkdtempSync(join(tmpdir(), "dvt004-work-"));
	dirs.push(d);
	return d;
};
const notRoot = process.getuid?.() !== 0;

describe("TRUST-004 G probe exit-code vocabulary", () => {
	it("states the vocabulary in the probe's header and maps it exactly", () => {
		expect(probe).toContain("10 EROFS, 11 EACCES, 12 EPERM, 1 the write succeeded (prints WROTE), 2 any other errno");
		expect(probe).toContain("process.exit({ EROFS: 10, EACCES: 11, EPERM: 12 }[e.code] ?? 2)");
	});

	it.runIf(notRoot)("write-existing on a 0444 file reports EACCES with code 11", () => {
		const w = scratch();
		writeFileSync(join(w, "probe.mjs"), "x");
		chmodSync(join(w, "probe.mjs"), 0o444);
		expect(run("write-existing", w)).toEqual({ status: 11, stdout: "EACCES\n" });
	});

	it.runIf(notRoot)("chmod of a file owned by another uid reports EPERM with code 12", () => {
		const w = scratch();
		symlinkSync("/etc/passwd", join(w, "probe.mjs"));
		expect(run("chmod", w)).toEqual({ status: 12, stdout: "EPERM\n" });
	});

	it("a write that succeeds prints WROTE with code 1, and any other errno exits 2", () => {
		expect(run("write-new", scratch())).toEqual({ status: 1, stdout: "WROTE\n" });
		expect(run("mkdir", "/nonexistent-dvt004")).toEqual({ status: 2, stdout: "ENOENT\n" });
	});

	it("expects each write case's stdout and code, and leaves every other G case unchanged", () => {
		const cases = [...source.matchAll(/^\t\tk\(("[^"]+"), ("[^"]*")(?:, (\d+))?\),$/gm)].map((m) => [
			JSON.parse(m[1] as string),
			JSON.parse(m[2] as string),
			Number(m[3] ?? 0),
		]);
		expect(cases).toEqual([
			["write-new", "EROFS\n", 10],
			["write-existing", "EACCES\n", 11],
			["chmod", "EROFS\n", 10],
			["mkdir", "EROFS\n", 10],
			["read-list", "probe.mjs\n", 0],
			["identity", "65534 65534\n", 0],
			["descendant", "", 0],
			["stdout-flood", "", 0],
			["stderr-flood", "", 0],
		]);
	});

	it("records each case's measured exit code and match beside its expectation in controls.json", () => {
		expect(source).toContain(
			"cases: g.cases.map((c) => ({ ...c, expect: probeOracle.cases.find((p) => p.name === c.name)?.expect ?? null })),",
		);
	});
});
