// COUNTERFACTUAL-REPLAY-001 probe (research/counterfactual-replay/probe.ts): its output stays private, and a repeat refuses inputs that
// differ from its source trial's (Codex, #136). The measurements themselves need a real model and are not run here.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privateDirectoryV0, repeatProvenanceMismatchesV0 } from "../research/counterfactual-replay/probe.ts";

const base = mkdtempSync(join(tmpdir(), "endo-cf-probe-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const mode = (p: string) => statSync(p).mode & 0o777;

describe("the probe's output directory is private, whatever the umask", () => {
	it("a new directory, and the parents it makes, are 0700 under a permissive umask", () => {
		const previous = process.umask(0o022);
		try {
			const dir = join(base, "new", "nested", "out");
			privateDirectoryV0(dir);
			expect(mode(dir)).toBe(0o700);
			expect(mode(join(base, "new", "nested"))).toBe(0o700);
		} finally {
			process.umask(previous);
		}
	});

	it("an existing directory left open to others is made 0700, and checked after", () => {
		const dir = join(base, "existing");
		mkdirSync(dir);
		chmodSync(dir, 0o755);
		privateDirectoryV0(dir);
		expect(mode(dir)).toBe(0o700);
	});

	it("a link or a file in its place is refused, never followed", () => {
		const target = join(base, "target");
		mkdirSync(target);
		chmodSync(target, 0o755);
		const link = join(base, "link");
		symlinkSync(target, link);
		expect(() => privateDirectoryV0(link)).toThrow(/not a directory/);
		expect(mode(target)).toBe(0o755);
		const file = join(base, "file");
		writeFileSync(file, "x");
		expect(() => privateDirectoryV0(file)).toThrow();
	});
});

describe("a repeat must use the source trial's Pi and model endpoint", () => {
	const source = {
		subject: { pi: { distSha256: "a".repeat(64) } },
		relay: { upstream: { origin: "http://127.0.0.1:8081" } },
	};

	it("matching inputs, the endpoint compared by normalised origin", () => {
		for (const upstream of ["http://127.0.0.1:8081", "http://127.0.0.1:8081/", "http://127.0.0.1:8081/v1"])
			expect(repeatProvenanceMismatchesV0(source, { piDistSha256: "a".repeat(64), upstream })).toEqual([]);
	});

	it("another Pi build is refused", () => {
		expect(
			repeatProvenanceMismatchesV0(source, { piDistSha256: "b".repeat(64), upstream: "http://127.0.0.1:8081" }),
		).toEqual(["pi-dist"]);
	});

	it("another endpoint (port, host or scheme), or one that is not a URL, is refused", () => {
		for (const upstream of ["http://127.0.0.1:8082", "http://localhost:8081", "https://127.0.0.1:8081", "not a url"])
			expect(repeatProvenanceMismatchesV0(source, { piDistSha256: "a".repeat(64), upstream })).toEqual(["upstream"]);
	});

	it("both differing are both named; a source with no recorded endpoint never matches one", () => {
		expect(
			repeatProvenanceMismatchesV0(source, { piDistSha256: "b".repeat(64), upstream: "http://127.0.0.1:9" }),
		).toEqual(["pi-dist", "upstream"]);
		expect(
			repeatProvenanceMismatchesV0(
				{ subject: source.subject },
				{ piDistSha256: "a".repeat(64), upstream: "http://127.0.0.1:8081" },
			),
		).toEqual(["upstream"]);
	});

	it("a replay (its upstream is the cassette by design) checks the Pi build only", () => {
		expect(repeatProvenanceMismatchesV0(source, { piDistSha256: "a".repeat(64), upstream: null })).toEqual([]);
		expect(repeatProvenanceMismatchesV0(source, { piDistSha256: "c".repeat(64), upstream: null })).toEqual([
			"pi-dist",
		]);
	});
});
