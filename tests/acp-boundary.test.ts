// The ACP boundary. The official ACP SDK is imported only by adapters/acp (and the tests and fixtures that exercise
// it): protocol/, runtime/ and every other adapter stay free of ACP types. This tranche is ACP v1 only, so nothing
// imports the SDK's experimental v2 entry. The SDK is pinned to one exact reviewed version.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const SKIP = new Set(["node_modules", ".git", ".agents", ".commandcode"]);

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (SKIP.has(entry.name)) return [];
		const path = join(dir, entry.name);
		return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
	});
}
const rel = (path: string) => relative(root, path).split(sep).join("/");

/** Module specifiers a file imports or re-exports (static and dynamic, type-only included). */
function specs(source: string): string[] {
	const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
	return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((match) => match[1] as string);
}
const imports = (path: string) => specs(readFileSync(path, "utf8"));
const SDK = /^@agentclientprotocol\//;

describe("ACP adapter boundary", () => {
	const files = sources(root).filter((path) => rel(path) !== "tests/acp-boundary.test.ts");

	it("is the only production code that imports the ACP SDK", () => {
		const importers = files.filter((path) => imports(path).some((spec) => SDK.test(spec))).map(rel);
		const production = importers.filter((path) => !path.startsWith("tests/"));
		expect(production.length).toBeGreaterThan(0);
		expect(production.filter((path) => !path.startsWith("adapters/acp/"))).toEqual([]);
	});

	// The experimental v2 entry, and only that entry, with the files allowed to name it.
	const V2_ENTRY = "@agentclientprotocol/sdk/experimental/v2";
	const v2Allowed = (path: string) =>
		path === "adapters/acp/client-v2.ts" ||
		/^tests\/acp-v2-[a-z-]+\.test\.ts$/.test(path) ||
		/^tests\/fixtures\/[a-z-]*v2[a-z-]*\.ts$/.test(path);

	it("imports the experimental v2 entry only from the one v2 client and the v2 tests and fixtures", () => {
		const importers = files.filter((path) => imports(path).includes(V2_ENTRY)).map(rel);
		expect(importers.filter((path) => !v2Allowed(path))).toEqual([]);
		const production = importers.filter((path) => !path.startsWith("tests/"));
		expect(production).toEqual(["adapters/acp/client-v2.ts"]);
	});

	it("imports no other experimental SDK entry anywhere", () => {
		const others = files.filter((path) =>
			imports(path).some((spec) => /^@agentclientprotocol\/sdk\/experimental/.test(spec) && spec !== V2_ENTRY),
		);
		expect(others.map(rel)).toEqual([]);
	});

	it("keeps the v1 modules and their barrel from importing the v2 modules, and v2 out of unrelated code", () => {
		const V2_MODULE = /(^|\/)(client-v2|schema-v2|translate-v2|loss-v2|conversation-v2|negotiate|v2)\.ts$/;
		for (const name of ["index.ts", "client.ts", "schema.ts", "translate.ts", "loss.ts"])
			expect(
				imports(join(root, "adapters/acp", name)).filter((spec) => V2_MODULE.test(spec)),
				name,
			).toEqual([]);
		// The one place that knows both versions, and the v2 barrel, are imported only inside adapters/acp and the tests.
		const importersOf = (pattern: RegExp) =>
			files
				.filter((path) => imports(path).some((spec) => pattern.test(spec)))
				.map(rel)
				.filter((path) => !path.startsWith("adapters/acp/") && !path.startsWith("tests/"));
		expect(importersOf(/adapters\/acp\//)).toEqual([]);
	});

	it("keeps ACP out of protocol/ and runtime/ ", () => {
		for (const path of files.filter((file) => /^(protocol|runtime)\//.test(rel(file)))) {
			expect(
				imports(path).filter((spec) => /adapters\/acp|@agentclientprotocol/.test(spec)),
				rel(path),
			).toEqual([]);
		}
	});

	it("pins the SDK to one exact version, in the manifest and the lockfile", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			devDependencies: Record<string, string>;
		};
		const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
			packages: Record<string, { version?: string }>;
		};
		const pinned = manifest.devDependencies["@agentclientprotocol/sdk"];
		expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lock.packages["node_modules/@agentclientprotocol/sdk"]?.version).toBe(pinned);
	});

	it("reaches the SDK only through its public entry and its public exports, never a private path", () => {
		const allowed = new Set(["@agentclientprotocol/sdk", "@agentclientprotocol/sdk/schema/schema.json"]);
		// The v2 study names two more public exports, in the two files that pin and import them.
		const v2Only: Record<string, readonly string[]> = {
			"adapters/acp/client-v2.ts": [V2_ENTRY],
			"adapters/acp/schema-v2.ts": [V2_ENTRY, "@agentclientprotocol/sdk/schema/v2/schema.unstable.json"],
		};
		const literal = /["'`](@agentclientprotocol\/sdk[^"'`]*)["'`]/g;
		for (const path of files.filter((file) => !rel(file).startsWith("tests/"))) {
			for (const match of readFileSync(path, "utf8").matchAll(literal))
				expect(
					allowed.has(match[1] as string) || (v2Only[rel(path)] ?? []).includes(match[1] as string),
					`${rel(path)}: ${match[1]}`,
				).toBe(true);
		}
	});

	it("confines the JSON Schema validator to adapters/acp, pinned exactly, importing one entry", () => {
		const importers = files.filter((path) => imports(path).some((spec) => /^ajv(\/|$)/.test(spec)));
		expect(importers.map(rel).filter((path) => !path.startsWith("adapters/acp/"))).toEqual([]);
		expect(importers.length).toBeGreaterThan(0);
		for (const path of importers)
			expect(
				imports(path).filter((spec) => /^ajv(\/|$)/.test(spec)),
				rel(path),
			).toEqual(["ajv/dist/2020.js"]);
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			devDependencies: Record<string, string>;
		};
		const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
			packages: Record<string, { version?: string }>;
		};
		expect(manifest.devDependencies.ajv).toMatch(/^\d+\.\d+\.\d+$/);
		expect(lock.packages["node_modules/ajv"]?.version).toBe(manifest.devDependencies.ajv);
	});
});
