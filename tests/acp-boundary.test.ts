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

	it("imports no ACP v2 / experimental entry anywhere", () => {
		const v2 = files.filter((path) =>
			imports(path).some((spec) => /^@agentclientprotocol\/sdk\/experimental/.test(spec)),
		);
		expect(v2.map(rel)).toEqual([]);
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
});
