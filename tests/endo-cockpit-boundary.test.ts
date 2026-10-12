// The cockpit observation bridge is a harness-neutral, read-only, renderer-free library. These tests hold that as source
// facts, so a later change that gives it a runtime, a renderer, a transport, a write path or a clock fails here:
// - cockpit/ reaches no harness adapter, no Pi package, no ACP implementation, no browser framework, no rendering engine
//   and no network or process API, even through relative imports (type-only and dynamic included);
// - the pure projections and the contract read no file, clock, random source or environment;
// - the reader imports only the read-side of node:fs and opens every store with { readOnly: true };
// - protocol/cockpit.ts imports only the protocol (also held by endo-pi-boundary.test.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

function specs(source: string): string[] {
	const staticEdges = /(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g;
	const dynamicEdges = /\bimport\s*\(\s*["']([^"']+)["']/g;
	return [...source.matchAll(staticEdges), ...source.matchAll(dynamicEdges)].map((match) => match[1]!);
}

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
	);
}

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN_SPEC = (value: string) =>
	/^@earendil-works\//.test(value) ||
	/(^|\/)pi\/packages\//.test(value) ||
	/(^|\/)adapters\//.test(value) ||
	/(^|\/)(presentation|apps)\//.test(value) ||
	/^@agentclientprotocol\//.test(value) ||
	/^(react|react-dom|vite|three|pixi\.js|@webgpu\/.*|@react-three\/.*|d3|express|fastify|ws)(\/|$)/.test(value) ||
	/^node:(http|https|http2|net|tls|dgram|dns|child_process|worker_threads|cluster|vm|inspector)$/.test(value);

function reach(roots: string[]): { hits: string[]; seen: Set<string> } {
	const queue = [...roots];
	const seen = new Set<string>();
	const hits = new Set<string>();
	while (queue.length) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of specs(readFileSync(file, "utf8"))) {
			if (FORBIDDEN_SPEC(spec)) hits.add(`${file}: ${spec}`);
			if (!spec.startsWith(".")) continue;
			const base = resolve(dirname(file), spec);
			const target = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts")].find(
				(path) => existsSync(path) && statSync(path).isFile(),
			);
			if (target) queue.push(target);
		}
	}
	return { hits: [...hits], seen };
}

const COCKPIT = files(join(packageRoot, "cockpit"));
const PROJECTIONS = files(join(packageRoot, "cockpit", "projections"));

describe("cockpit import boundary", () => {
	it("reaches no adapter, Pi package, ACP implementation, framework, renderer, network or process API", () => {
		const { hits, seen } = reach(COCKPIT);
		expect(hits).toEqual([]);
		// Non-vacuous: the walk reaches the storage it reads through, and the protocol contracts.
		expect(seen).toContain(join(packageRoot, "storage", "event-store.ts"));
		expect(seen).toContain(join(packageRoot, "storage", "harness-registry.ts"));
		expect(seen).toContain(join(packageRoot, "protocol", "cockpit.ts"));
		expect([...seen].some((file) => file.includes(`${join(packageRoot, "adapters")}`))).toBe(false);
	});

	it("rejects hostile edges in a probe graph", () => {
		for (const edge of [
			"@earendil-works/pi-durable",
			"../adapters/pi/attachment.ts",
			"react",
			"node:http",
			"@webgpu/types",
			"../../apps/web/main.ts",
		])
			expect(FORBIDDEN_SPEC(edge), edge).toBe(true);
		for (const edge of ["node:fs", "../protocol/cockpit.ts", "../storage/event-store.ts"])
			expect(FORBIDDEN_SPEC(edge), edge).toBe(false);
	});

	it("imports nothing outside node:fs, node:path, node:crypto and relative modules of this package", () => {
		for (const file of COCKPIT) {
			for (const spec of specs(readFileSync(file, "utf8")))
				expect(spec, file).toMatch(/^(node:(fs|path|crypto)|\.\.?\/.*\.ts)$/);
		}
	});
});

describe("cockpit purity and read-only operation", () => {
	it("the pure projections and the contract use no file, clock, random, environment or node: module", () => {
		const pure = [...PROJECTIONS, join(packageRoot, "protocol", "cockpit.ts")];
		expect(pure.length).toBeGreaterThanOrEqual(5);
		for (const file of pure) {
			const source = withoutComments(readFileSync(file, "utf8"));
			expect(source, file).not.toMatch(/\bnode:/);
			expect(source, file).not.toMatch(
				/\bDate\b|Math\.random|performance\.now|randomUUID|randomBytes|\bprocess\.|\bglobalThis\b/,
			);
			expect(source, file).not.toMatch(/\b(fetch|XMLHttpRequest|setTimeout|setInterval|setImmediate)\b/);
		}
	});

	it("the pure projections hold no module-level mutable state", () => {
		for (const file of PROJECTIONS) {
			const source = withoutComments(readFileSync(file, "utf8"));
			expect(source, file).not.toMatch(/^(let|var)\s/m);
			expect(source, file).not.toMatch(/^const\s+\w+\s*(:[^=]+)?=\s*(new (Map|Set|WeakMap|Array)\b|\[\]|\{\})/m);
		}
	});

	it("the reader imports only the read side of node:fs", () => {
		const source = withoutComments(readFileSync(join(packageRoot, "cockpit", "reader.ts"), "utf8"));
		const fs = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:fs"/g)].flatMap((m) =>
			m[1]!
				.split(",")
				.map((name) => name.trim())
				.filter(Boolean),
		);
		expect(fs.sort()).toEqual(["lstatSync", "readdirSync", "statSync"]);
		for (const file of COCKPIT)
			expect(withoutComments(readFileSync(file, "utf8")), file).not.toMatch(
				/\b(writeFile|appendFile|mkdir|rmdir|rm|unlink|rename|truncate|copyFile|symlink|chmod|utimes|ftruncate|fsync|write|open)(Sync)?\s*\(/,
			);
	});

	it("every store is opened read-only", () => {
		let opens = 0;
		for (const file of COCKPIT) {
			const source = withoutComments(readFileSync(file, "utf8"));
			for (const match of source.matchAll(
				/\b(createEndoDurableEventStoreV0|openEndoHarnessRegistryV0)\(([^)]*)\)/g,
			)) {
				opens += 1;
				expect(match[2], `${file}: ${match[0]}`).toMatch(/\{\s*readOnly:\s*true\s*\}/);
			}
		}
		expect(opens).toBe(2);
	});
});
