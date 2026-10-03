// Host infrastructure import boundary: storage/ and cli/ run directly under node. They may use the synchronous
// node: APIs and the core services, but they must never reach the vendored Pi tree, the Pi adapter, or the
// presentation — not even through type-only imports, re-exports, or dynamic imports.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function specs(source: string): string[] {
	// Include erased type edges as well as value imports/reexports.
	const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
	return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((match) => match[1]!);
}
function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}
// Every @earendil-works/* package resolves into the vendored pi/ tree, so any such specifier is a hit on its own.
function hostReachable(roots: string[], read: (path: string) => string, has: (path: string) => boolean): string[] {
	const queue = [...roots];
	const seen = new Set<string>();
	const hits = new Set<string>();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		if (file.includes("/pi/") || file.includes("/adapters/") || file.includes("/presentation/")) {
			hits.add(file);
			continue;
		}
		for (const spec of specs(read(file))) {
			if (/^@earendil-works\//.test(spec)) hits.add(spec);
			if (!spec.startsWith(".")) continue;
			const base = resolve(dirname(file), spec);
			const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(has);
			if (!target) continue;
			queue.push(target);
		}
	}
	return [...hits];
}
function hostVisited(roots: string[], read: (path: string) => string, has: (path: string) => boolean): Set<string> {
	const queue = [...roots];
	const seen = new Set<string>();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of specs(read(file))) {
			if (!spec.startsWith(".")) continue;
			const base = resolve(dirname(file), spec);
			const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(has);
			if (target) queue.push(target);
		}
	}
	return seen;
}

describe("host infrastructure import boundary", () => {
	it.each(["storage", "cli"])(
		"%s reaches no Pi tree, adapter, or presentation module, even by type or dynamic import",
		(dir) => {
			expect(
				hostReachable(
					files(join(packageRoot, dir)),
					(p) => readFileSync(p, "utf8"),
					(p) => existsSync(p) && statSync(p).isFile(),
				),
			).toEqual([]);
		},
	);

	it("rejects indirect, type-only, and dynamic import edges in a hostile graph", () => {
		for (const statement of [
			'import type { ContinuitySnapshotV0 } from "../adapters/pi/continuity.ts";',
			'export * from "../pi/packages/agent/src/index.ts";',
			'const client = import("../presentation/client.ts");',
		]) {
			const graph: Record<string, string> = {
				"/endophasia/storage/log.ts": 'import "./helper.ts";',
				"/endophasia/storage/helper.ts": statement,
				"/endophasia/adapters/pi/continuity.ts": "",
				"/endophasia/pi/packages/agent/src/index.ts": "",
				"/endophasia/presentation/client.ts": "",
			};
			expect(
				hostReachable(
					["/endophasia/storage/log.ts"],
					(p) => graph[p]!,
					(p) => p in graph,
				).length,
			).toBeGreaterThan(0);
		}
	});

	it("proves the walk is non-vacuous: the CLI reaches the durable ledger through relative imports", () => {
		const visited = hostVisited(
			[join(packageRoot, "cli", "commands.ts")],
			(p) => readFileSync(p, "utf8"),
			(p) => existsSync(p) && statSync(p).isFile(),
		);
		expect(visited).toContain(join(packageRoot, "storage", "ledger.ts"));
	});
});
