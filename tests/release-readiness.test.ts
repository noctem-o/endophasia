// What a release candidate must agree on before anyone packs it: one version in the manifest, the lockfile, the CLI, the changelog
// and the version's own release document; a manifest that cannot move `latest` by accident; a release document whose publish command
// is the tested tarball and not a rebuild; and CI that gates on the browser and the supported Node floor. The packed artifact itself
// is tested by scripts/package-smoke.mjs (npm run test:package), which this does not repeat.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { endoVersionV0 } from "../cli/help.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file: string) => readFileSync(join(root, file), "utf8");
const manifest = JSON.parse(read("package.json")) as {
	name: string;
	version: string;
	engines: { node: string };
	publishConfig?: { tag?: string };
};
const lock = JSON.parse(read("package-lock.json")) as {
	name: string;
	version: string;
	packages: Record<string, { name?: string; version?: string }>;
};
const version = manifest.version;
const escaped = version.replace(/[.+-]/g, "\\$&");

describe("one version, everywhere it is written", () => {
	it("is a semantic version, and the CLI reports the manifest's", () => {
		expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
		expect(endoVersionV0()).toBe(version);
	});

	it("is the lockfile's version, at its top and for the root package", () => {
		expect(lock.name).toBe(manifest.name);
		expect(lock.version).toBe(version);
		expect(lock.packages[""]?.name).toBe(manifest.name);
		expect(lock.packages[""]?.version).toBe(version);
	});

	it("has its own changelog section, first or directly under Unreleased, with the previous release kept below it", () => {
		const changelog = read("CHANGELOG.md");
		const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
		const own = headings.findIndex((heading) => new RegExp(`^\\[?${escaped}\\]?(\\s|$)`).test(heading));
		expect(own, `a "## ${version}" section in CHANGELOG.md`).toBeGreaterThanOrEqual(0);
		expect(
			headings.slice(0, own).every((heading) => /^Unreleased/i.test(heading)),
			"only an Unreleased section may sit above it",
		).toBe(true);
		expect(headings[own + 1], "the previous release's section is kept").toMatch(/^\[?\d+\.\d+\.\d+/);
	});

	it("has a release document that names it", () => {
		const doc = read(`docs/release-${version}.md`);
		expect(doc.split("\n")[0]).toContain(version);
	});
});

describe("publishing cannot move `latest` by accident", () => {
	it("a prerelease publishes under the alpha tag by default", () => {
		if (version.includes("-")) expect(manifest.publishConfig?.tag).toBe("alpha");
	});

	it("the release document publishes the tested tarball file under an explicit tag, never a bare `npm publish`", () => {
		const doc = read(`docs/release-${version}.md`);
		const tag = version.includes("-") ? "--tag alpha" : "--tag latest";
		expect(doc).toContain(`npm publish ./endophasia-${version}.tgz ${tag}`);
		// Every command written out (`npm publish <args>`, in a code span or on a code line) names the tarball and the tag; prose that
		// merely mentions `npm publish` (a backtick follows) is not a command.
		const commands = [...doc.matchAll(/npm publish[ \t]+[^`\n]*/g)].map((m) => m[0]);
		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			expect(command, command).toContain(`./endophasia-${version}.tgz`);
			expect(command, command).toContain(tag);
		}
	});
});

describe("the release gate in CI", () => {
	const ci = read(".github/workflows/ci.yml");
	const job = (name: string) => {
		const start = ci.indexOf(`\n  ${name}:\n`);
		expect(start, `job ${name}`).toBeGreaterThan(-1);
		const next = ci.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
		return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
	};

	it("fails, instead of skipping, when the installed page cannot be loaded in a browser", () => {
		// On the step that runs the smoke, not merely somewhere in the job.
		for (const [name, script] of [
			["package", "test:package"],
			["package-floor", "test:package"],
			["acceptance", "test:acceptance"],
		] as const)
			expect(job(name), name).toMatch(
				new RegExp(`- run: npm run ${script}\\n\\s+env:\\n\\s+ENDO_REQUIRE_BROWSER: "1"`),
			);
	});

	it("builds, packs and installs on the lowest Node the manifest allows, as well as the newest 22", () => {
		const floor = manifest.engines.node.replace(/^>=/, "");
		expect(job("package-floor")).toContain(`node-version: "${floor}"`);
		expect(job("package")).toContain('node-version: "22"');
	});

	it("keeps the real Pi acceptance on the pinned baseline", () => {
		expect(job("acceptance")).toContain(`PI_PINNED_VERSION: "1.0.0"`);
		expect(read("adapters/pi/version.ts")).toContain('"1.0.0"');
	});
});
