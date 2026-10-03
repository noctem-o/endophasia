// The Pi attachment boundary, held as tests so the retired fork integration cannot return unnoticed:
// - no source imports a Pi package (@earendil-works/*) or a vendored Pi path (pi/packages/*), nothing declares one as a
//   dependency, and there is no vendored Pi tree or submodule;
// - protocol/ is zero-dependency: it imports only protocol/;
// - the runtime-neutral layers never reach the Pi adapter; only the operator composition root (cli/) does;
// - the Pi adapter reaches only node: builtins, the protocol, the core contracts, storage, the shared JSONL transport
//   and its own modules;
// - no adapter spawns through a shell, and nothing in Endophasia installs, updates or rebuilds a harness.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function files(dir: string, extensions = [".ts", ".mjs"]): string[] {
	const absolute = join(root, dir);
	if (!existsSync(absolute)) return [];
	return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path, extensions);
		return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
	});
}

function specifiers(file: string): string[] {
	const source = readFileSync(join(root, file), "utf8");
	const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
	return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((match) => match[1]!);
}

const SOURCE_DIRS = [
	"protocol",
	"graph",
	"visualization",
	"lab",
	"evolution",
	"trust",
	"collab",
	"models",
	"runtime",
	"adapters",
	"storage",
	"cli",
	"research",
	"tests",
];
const ALL = SOURCE_DIRS.flatMap((dir) => files(dir));

describe("no Pi fork integration", () => {
	it("no source imports a Pi package or a vendored Pi path", () => {
		const hits = ALL.flatMap((file) =>
			specifiers(file)
				.filter((spec) => /^@earendil-works\//.test(spec) || /(^|\/)pi\/packages\//.test(spec))
				.map((spec) => `${file}: ${spec}`),
		);
		expect(hits).toEqual([]);
	});

	it("there is no vendored Pi tree, no submodule and no Pi dependency", () => {
		expect(existsSync(join(root, "pi"))).toBe(false);
		expect(existsSync(join(root, ".gitmodules"))).toBe(false);
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
		expect(manifest.workspaces).toBeUndefined();
		const deps = { ...(manifest.dependencies as object), ...(manifest.devDependencies as object) };
		expect(Object.keys(deps).filter((name) => name.startsWith("@earendil-works/"))).toEqual([]);
		const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
			packages: Record<string, unknown>;
		};
		expect(Object.keys(lock.packages).filter((key) => /earendil-works|^pi\//.test(key))).toEqual([]);
		for (const config of ["tsconfig.json", "vitest.config.ts", "biome.json"]) {
			expect(readFileSync(join(root, config), "utf8"), config).not.toMatch(/@earendil-works|pi\/packages/);
		}
	});
});

describe("layering", () => {
	it("protocol/ is zero-dependency: it imports only protocol/", () => {
		for (const file of files("protocol")) {
			for (const spec of specifiers(file)) expect(spec, file).toMatch(/^\.\/[a-z-]+\.ts$/);
		}
	});

	it("only the operator composition root reaches the Pi adapter", () => {
		const allowed = (file: string) =>
			file.startsWith("adapters/pi/") || file.startsWith("cli/") || file.startsWith("tests/");
		const hits = ALL.filter((file) => !allowed(file)).flatMap((file) =>
			specifiers(file)
				.filter((spec) => /adapters\/pi\//.test(spec) || /^\.\.?\/pi\//.test(spec))
				.map((spec) => `${file}: ${spec}`),
		);
		expect(hits).toEqual([]);
	});

	it("the Pi adapter reaches only node:, protocol, core contracts, storage, the shared transport and itself", () => {
		for (const file of files("adapters/pi")) {
			for (const spec of specifiers(file)) {
				expect(spec, file).toMatch(
					/^(node:[a-z_/]+|\.\/[a-z-]+\.ts|\.\.\/\.\.\/protocol\/[a-z-]+\.ts|\.\.\/\.\.\/runtime\/contracts\/[a-z-]+\.ts|\.\.\/\.\.\/storage\/[a-z-]+\.ts|\.\.\/rpc-jsonl\/[a-z-]+\.ts)$/,
				);
			}
		}
	});
});

/** The source without comments, so prose that mentions a package manager is not mistaken for a call to one. */
function code(file: string): string {
	return readFileSync(join(root, file), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("no hidden harness management", () => {
	const production = SOURCE_DIRS.filter((dir) => dir !== "tests" && dir !== "research").flatMap((dir) => files(dir));

	it("no production module spawns through a shell", () => {
		for (const file of production) {
			const source = code(file);
			expect(source, file).not.toMatch(/shell:\s*true/);
			expect(source, file).not.toMatch(/\bexecSync\s*\(|\bexec\s*\(\s*["'`]/);
		}
	});

	it("no production module invokes a package manager or rewrites a harness installation", () => {
		const pattern = /["'`](npm|pnpm|yarn|bun|brew|nix)["'`]|npm (install|update|i )|pi update|--self-update/;
		const hits = production.filter((file) => pattern.test(code(file)));
		expect(hits.map((file) => relative(root, join(root, file)))).toEqual([]);
	});
});
