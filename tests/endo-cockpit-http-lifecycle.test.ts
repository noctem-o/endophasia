// The cockpit HTTP transport's lifecycle and boundary: what it binds, how it starts, fails and stops, what key it accepts, and
// which modules it may import. The library stays free of any network API (endo-cockpit-boundary.test.ts); the transport stays
// free of storage, adapters and the environment.
import { readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startEndoCockpitServerV0 } from "../cockpit-http/server.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { endoFixtureDigestKeyPathV0, loadEndoFixtureDigestKeyV0 } from "../storage/digest-key.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { get, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY, TEST_KEY } from "./cockpit-keyed.ts";

afterEach(stopServers);
afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const netHandles = () =>
	process.getActiveResourcesInfo().filter((name) => name === "TCPServerWrap" || name === "TCPSocketWrap");
/** The listening sockets and connections this process holds, once they stop changing (a close finishes a tick or two later). */
const resources = async (): Promise<string[]> => {
	let last = netHandles();
	for (let stable = 0; stable < 4; ) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		const now = netHandles();
		stable = now.length === last.length ? stable + 1 : 0;
		last = now;
	}
	return last;
};
const connectable = (host: string, port: number): Promise<boolean> =>
	new Promise((resolve) => {
		const socket = connect({ host, port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});

describe("binding", () => {
	it("listens on the IPv4 loopback address only, on an operating-system port by default", async () => {
		const server = await serve(tempRoot());
		expect(server.port).toBeGreaterThan(0);
		expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
		expect(await connectable("127.0.0.1", server.port)).toBe(true);
		expect(await connectable("::1", server.port)).toBe(false);
		for (const addresses of Object.values(networkInterfaces()))
			for (const info of addresses ?? [])
				if (info.family === "IPv4" && !info.internal)
					expect(await connectable(info.address, server.port), info.address).toBe(false);
	});

	it("serves two instances on two ports with two capabilities", async () => {
		const a = await serve(tempRoot());
		const b = await serve(tempRoot());
		expect(a.port).not.toBe(b.port);
		expect(a.baseUrl).not.toBe(b.baseUrl);
		const cross = await fetch(`${a.origin}${b.baseUrl.slice(b.origin.length)}/api/v0/snapshot`);
		expect(cross.status).toBe(404);
	});
});

describe("startup failures leave nothing behind", () => {
	it("an occupied port rejects, with no listener or socket left by the failed attempt", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const { port } = blocker.address() as { port: number };
		const before = await resources();
		await expect(startEndoCockpitServerV0({ root: tempRoot(), digestKey: OTHER_KEY, port })).rejects.toThrow();
		expect(await resources()).toEqual(before);
		await new Promise<void>((resolve) => blocker.close(() => resolve()));
	});

	it("a key a cockpit read does not admit is refused at startup, before anything is bound", async () => {
		const before = await resources();
		const unpinnedPublic = endoDigestKeyV0(Buffer.alloc(32, 0x32), "fixture-other", { public: true });
		const credentialLabel = endoDigestKeyV0(Buffer.alloc(32, 0x31), "sk-abcdefghijklmnop", { public: true });
		for (const key of [
			unpinnedPublic,
			credentialLabel,
			{ ...OTHER_KEY, digest: undefined },
			null,
			undefined,
			"key",
			{},
		])
			await expect(
				startEndoCockpitServerV0({ root: tempRoot(), digestKey: key as never }),
				String(key),
			).rejects.toThrow(TypeError);
		expect(await resources()).toEqual(before);
	});

	it("an invalid port or read budget is a TypeError, not a listener", async () => {
		const root = tempRoot();
		const before = await resources();
		for (const port of [-1, 65536, 1.5, Number.NaN])
			await expect(startEndoCockpitServerV0({ root, digestKey: OTHER_KEY, port })).rejects.toThrow(TypeError);
		for (const readBudget of [
			{ duty: 0, burstMs: 1 },
			{ duty: 1, burstMs: 0 },
			{ duty: 2, burstMs: 5 },
		])
			await expect(startEndoCockpitServerV0({ root, digestKey: OTHER_KEY, readBudget })).rejects.toThrow(TypeError);
		expect(await resources()).toEqual(before);
	});

	it("admits a private key and the committed public fixture keys, and nothing else", async () => {
		const fixture = loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0("fixture-public"));
		for (const key of [OTHER_KEY, TEST_KEY, fixture]) {
			const root = tempRoot();
			ingestAll(root, [event("agent.prompt-accepted")]);
			const server = await serve(root, { digestKey: key });
			const body = (await get(server, "/api/v0/timeline")).body;
			expect(JSON.parse(body).source.watermark.keyId).toBe(key.keyId);
			expect(body.includes(Buffer.alloc(32, 0x11).toString("hex"))).toBe(false);
		}
	});
});

describe("shutdown", () => {
	it("close releases the port, ends open keep-alive connections and is idempotent", async () => {
		const baseline = await resources();
		const server = await startEndoCockpitServerV0({ root: tempRoot(), digestKey: OTHER_KEY });
		const { port } = server;
		const socket = connect({ host: "127.0.0.1", port });
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
		const first = server.close();
		await Promise.all([first, server.close(), closed]);
		expect(await server.close()).toBeUndefined();
		expect(await connectable("127.0.0.1", port)).toBe(false);
		expect(await resources()).toEqual(baseline);
		// The same port can be bound again at once.
		const again = await startEndoCockpitServerV0({ root: tempRoot(), digestKey: OTHER_KEY, port });
		expect(again.port).toBe(port);
		await again.close();
	});

	it("many start/serve/stop cycles hold no handles", async () => {
		const baseline = await resources();
		const root = tempRoot();
		for (let i = 0; i < 20; i += 1) {
			const server = await startEndoCockpitServerV0({ root, digestKey: OTHER_KEY });
			await fetch(`${server.baseUrl}/api/v0/timeline`);
			await server.close();
		}
		expect(await resources()).toEqual(baseline);
	});

	it("an idle server holds one listening socket and no timer of its own", async () => {
		const before = process.getActiveResourcesInfo();
		const server = await serve(tempRoot());
		const during = process.getActiveResourcesInfo();
		const added = [...during];
		for (const name of before) added.splice(added.indexOf(name), 1);
		// Node's http server may hold its own connection-checking timer; the transport adds none of its own.
		expect(added.filter((name) => name !== "Timeout").sort()).toEqual(["TCPServerWrap"]);
		expect(added.filter((name) => name === "Timeout").length).toBeLessThanOrEqual(1);
		await server.close();
	});
});

describe("source boundary", () => {
	const read = (file: string) => readFileSync(join(packageRoot, file), "utf8");
	const specifiers = (source: string) =>
		[...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/g)].map(
			(match) => match[1]!,
		);
	const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

	it("the transport imports only its comparison bridge, cockpit/index.ts and HTTP infrastructure", () => {
		expect(specifiers(read("cockpit-http/server.ts")).sort()).toEqual(
			[
				"./candidates.ts",
				"./comparison.ts",
				"./develop.ts",
				"../protocol/workbench-http.ts",
				"../cockpit/index.ts",
				"node:crypto",
				"node:http",
				"node:net",
			].sort(),
		);
	});

	it("the host module is the only file that reaches the key files, and it reads no environment itself", () => {
		expect(specifiers(read("cockpit-http/host.ts")).sort()).toEqual(
			[
				"../protocol/workbench-http.ts",
				"../storage/digest-key.ts",
				"./server.ts",
				"./studio-ui.ts",
				"node:fs",
				"node:path",
			].sort(),
		);
		expect(code(read("cockpit-http/host.ts"))).not.toMatch(/process\.env/);
	});

	it("the frontend check reads one directory and nothing else: no environment, no key, no write, no network, no process", () => {
		expect(specifiers(read("cockpit-http/studio-ui.ts")).sort()).toEqual(
			["node:crypto", "node:fs", "node:path"].sort(),
		);
		expect(code(read("cockpit-http/studio-ui.ts"))).not.toMatch(
			/process\.|writeFile|appendFile|unlink|\brm\(|mkdir|rename|symlink|child_process|node:http|node:net|fetch\(/,
		);
	});

	it("the development launcher is thin: the host module, and node's path and url helpers", () => {
		expect(specifiers(read("cockpit-http/launch.ts")).sort()).toEqual(["./host.ts", "node:path", "node:url"].sort());
		expect(code(read("cockpit-http/launch.ts"))).not.toMatch(/process\.env/);
	});

	it("the transport reads no environment, writes no file, runs no timer, worker or child process, and holds no module state", () => {
		const source = code(read("cockpit-http/server.ts"));
		expect(source).not.toMatch(/process\.env|\bfs\b|writeFile|appendFile|\bunlink|\brm\(|mkdir/);
		// A per-socket deadline on a refused connection is the only timer, and it is a socket option, never a module-level one.
		expect(source).not.toMatch(/setInterval|setImmediate|Worker|child_process|spawn|exec\(|fork\(/);
		expect(source.replace(/\bsocket\.setTimeout\(|^\s*setTimeout\(milliseconds/gm, "")).not.toMatch(/setTimeout/);
		expect(source).not.toMatch(/^(let|var)\s/m);
		expect(source).not.toMatch(/^const\s+\w+\s*(:[^=]+)?=\s*(new (Map|Set|WeakMap|Array)\b|\[\]|\{\})/m);
		expect(source).not.toMatch(/Access-Control|0\.0\.0\.0|"::"/);
	});

	it("the cockpit library itself still imports no network API", () => {
		expect(code(read("cockpit/index.ts"))).not.toMatch(/node:http|node:net/);
	});
});
