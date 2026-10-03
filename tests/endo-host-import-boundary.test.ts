// Host infrastructure import boundary. storage/ is host infrastructure under every runtime adapter: it reaches no
// adapter at all. cli/ is the operator's composition root: it may reach the Pi attachment adapter (and through it the
// shared JSONL transport), but nothing it reaches may import a Pi package or a vendored Pi path. Both rules hold for
// type-only imports, re-exports and dynamic imports too.
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
/** Walk relative imports from the roots; report every reached file or specifier the predicate forbids. */
function reachable(
	roots: string[],
	forbidden: (fileOrSpec: string) => boolean,
	read: (path: string) => string,
	has: (path: string) => boolean,
): { hits: string[]; seen: Set<string> } {
	const queue = [...roots];
	const seen = new Set<string>();
	const hits = new Set<string>();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		if (forbidden(file)) {
			hits.add(file);
			continue;
		}
		for (const spec of specs(read(file))) {
			if (!spec.startsWith(".")) {
				if (forbidden(spec)) hits.add(spec);
				continue;
			}
			const base = resolve(dirname(file), spec);
			const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(has);
			if (target) queue.push(target);
		}
	}
	return { hits: [...hits], seen };
}

const PI_PACKAGE = (value: string) => /^@earendil-works\//.test(value) || /(^|\/)pi\/packages\//.test(value);
const STORAGE_FORBIDDEN = (value: string) =>
	PI_PACKAGE(value) || value.includes("/adapters/") || value.includes("/presentation/");
const disk = {
	read: (p: string) => readFileSync(p, "utf8"),
	has: (p: string) => existsSync(p) && statSync(p).isFile(),
};

describe("host infrastructure import boundary", () => {
	it("storage reaches no adapter and no Pi package, even by type or dynamic import", () => {
		expect(reachable(files(join(packageRoot, "storage")), STORAGE_FORBIDDEN, disk.read, disk.has).hits).toEqual([]);
	});

	it("cli reaches no Pi package or vendored Pi path, even through the attachment adapter", () => {
		expect(reachable(files(join(packageRoot, "cli")), PI_PACKAGE, disk.read, disk.has).hits).toEqual([]);
	});

	it("rejects indirect, type-only, and dynamic import edges in a hostile graph", () => {
		for (const statement of [
			'import type { Harness } from "@earendil-works/pi-durable";',
			'export * from "../pi/packages/agent/src/index.ts";',
			'const attach = import("../adapters/pi/attachment.ts");',
		]) {
			const graph: Record<string, string> = {
				"/endophasia/storage/log.ts": 'import "./helper.ts";',
				"/endophasia/storage/helper.ts": statement,
				"/endophasia/adapters/pi/attachment.ts": "",
				"/endophasia/pi/packages/agent/src/index.ts": "",
			};
			expect(
				reachable(
					["/endophasia/storage/log.ts"],
					STORAGE_FORBIDDEN,
					(p) => graph[p]!,
					(p) => p in graph,
				).hits.length,
			).toBeGreaterThan(0);
		}
	});

	it("proves the walks are non-vacuous: the CLI reaches the ledger and the Pi attachment through relative imports", () => {
		const { seen } = reachable([join(packageRoot, "cli", "index.ts")], PI_PACKAGE, disk.read, disk.has);
		expect(seen).toContain(join(packageRoot, "storage", "ledger.ts"));
		expect(seen).toContain(join(packageRoot, "adapters", "pi", "attachment.ts"));
		expect(seen).toContain(join(packageRoot, "adapters", "rpc-jsonl", "rpc-connection.ts"));
	});
});
