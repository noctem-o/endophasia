// The browser page as the HTTP transport serves it: explicit routes only, every PR B guard in front of them, a narrow policy of
// their own, nothing read from disk per request, and the JSON API untouched beside them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalEndoJsonV0, readEndoCockpitSnapshotV0 } from "../cockpit/index.ts";
import { startEndoCockpitServerV0 } from "../cockpit-http/server.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { event, ingestAll, removeTempRoots, seedRegistry, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, raw, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

afterEach(stopServers);
afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const repo = fileURLToPath(new URL("../", import.meta.url));
let dist = "";
/** The built Studio frontend as the server is given it (bytes), and as text for comparison (a font is binary and is left out of it). */
let ui: Record<string, Uint8Array> = {};
let text: Record<string, string> = {};
let MAIN = "";
let CSS = "";
let root = "";
beforeAll(async () => {
	dist = mkdtempSync(join(tmpdir(), "endo-studio-ui-dist-"));
	const { buildStudioUi } = (await import(join(repo, "scripts/build-studio-ui.mjs"))) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(dist);
	ui = loadEndoStudioUiFilesV0(dist);
	text = Object.fromEntries(
		Object.entries(ui)
			.filter(([name]) => !name.endsWith(".woff2"))
			.map(([name, bytes]) => [name, Buffer.from(bytes).toString("utf8")]),
	);
	MAIN = Object.keys(ui).find((name) => /^main-.*\.js$/.test(name))!;
	CSS = Object.keys(ui).find((name) => /^main-.*\.css$/.test(name))!;
	root = tempRoot();
	ingestAll(root, [event("agent.prompt-accepted"), event("tool.started")]);
	seedRegistry(root);
}, 90_000);
afterAll(() => rmSync(dist, { recursive: true, force: true }));

const PAGE_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
const TYPES: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	svg: "image/svg+xml",
	woff2: "font/woff2",
};

describe("the page and its assets", () => {
	it("serves the page at the capability root, and each built file at /assets/<name> with its own type", async () => {
		const server = await serve(root, { ui });
		const page = await get(server, "/");
		expect(page.status).toBe(200);
		expect(page.headers["content-type"]).toBe(TYPES.html);
		expect(page.body).toBe(text["index.html"]);
		expect(page.body).toContain(`src="./assets/${MAIN}"`);
		const names = Object.keys(ui).filter((name) => name !== "index.html");
		expect(names.length).toBeGreaterThan(5);
		for (const name of names) {
			const reply = await get(server, `/assets/${name}`);
			expect(reply.status, name).toBe(200);
			expect(reply.headers["content-type"], name).toBe(TYPES[name.slice(name.lastIndexOf(".") + 1)]);
			if (text[name] !== undefined) expect(reply.body, name).toBe(text[name]); // a font is binary: its bytes are compared in endo-studio-ui.test.ts
		}
	});

	it("carries the page's own narrow policy and isolation headers, and the PR B headers too", async () => {
		const server = await serve(root, { ui });
		for (const route of ["/", `/assets/${MAIN}`, `/assets/${CSS}`, "/assets/icon.svg"]) {
			const { headers } = await get(server, route);
			expect(headers["content-security-policy"], route).toBe(PAGE_CSP);
			expect(headers["cache-control"]).toBe("no-store");
			expect(headers["x-content-type-options"]).toBe("nosniff");
			expect(headers["referrer-policy"]).toBe("no-referrer");
			expect(headers["x-frame-options"]).toBe("DENY");
			expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
			expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
			expect(String(headers["permissions-policy"])).toContain("camera=()");
			expect(headers["content-length"]).toBe(
				String(Buffer.byteLength(ui[route === "/" ? "index.html" : route.slice(8)]!)),
			);
			for (const name of Object.keys(headers)) expect(name.startsWith("access-control-"), name).toBe(false);
		}
		expect(PAGE_CSP).not.toMatch(/unsafe-|\*|https?:|data:|blob:/);
	});

	it("serves only those names: another asset, a traversal, a missing slash or a query is refused", async () => {
		const server = await serve(root, { ui });
		const cap = capabilityOf(server);
		const notFound = [
			"/assets/index.html",
			"/assets/nothing.js",
			"/assets/Main.js",
			`/assets/${MAIN}/`,
			`/assets/${MAIN}.map`,
			"/assets/",
			"/assets",
			`/assets//${MAIN}`,
			"/assets/../index.html",
			`/assets/./${MAIN}`,
			"/assets/%2e%2e/index.html",
			"/assets/..%2findex.html",
			"/assets/main%2ejs",
			"/assets/package.json",
			"/assets/server.ts",
			"/assets/launch.ts",
			`/assets/${MAIN}%00.css`,
			"/assets/a/b.js",
			"//",
			"/index.html",
		];
		for (const route of notFound) {
			const reply = await get(server, route);
			expect([404, 400], route).toContain(reply.status);
			expect(reply.body, route).toMatch(/^\{"error":"[a-z-]+"\}\n$/);
			expect(reply.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
		}
		const noSlash = await send(server, cap);
		expect(noSlash.status).toBe(404);
		expect(JSON.stringify(noSlash.headers)).not.toContain(cap.slice(1)); // a refusal carries no redirect with the capability
		for (const query of ["?x=1", "?limit=1", "?a=b&c=d"]) {
			expect((await send(server, `${cap}/${query}`)).status, query).toBe(400);
			expect((await send(server, `${cap}/assets/main.js${query}`)).status, query).toBe(400);
		}
		expect((await send(server, `${cap}/?`)).status).toBe(200);
	});

	it("without a page the server is API-only, as before", async () => {
		const server = await serve(root);
		expect((await get(server, "/")).status).toBe(404);
		expect((await get(server, `/assets/${MAIN}`)).status).toBe(404);
		expect((await get(server, "/api/v0/timeline")).status).toBe(200);
	});

	/**
	 * The only absolute addresses in what is served, and what each is: the XML namespace identifiers React's DOM code names (a name, never
	 * a request), and the address React's production build puts in the text of an error it throws (never fetched, and the page policy
	 * would refuse it). Nothing else, and nothing in the page, style sheet or icon beyond the SVG namespace.
	 */
	const NAMES_NOT_REQUESTS = [
		"https://reactjs.org/docs/error-decoder.html?invariant=",
		"http://www.w3.org/1998/Math/MathML",
		"http://www.w3.org/1999/xhtml",
		"http://www.w3.org/1999/xlink",
		"http://www.w3.org/2000/svg",
		"http://www.w3.org/XML/1998/namespace",
	];

	it("keeps no capability and no absolute address in anything it serves, but the names a library holds", async () => {
		const server = await serve(root, { ui });
		const capability = capabilityOf(server).slice(1);
		for (const name of Object.keys(ui)) {
			const reply = await get(server, name === "index.html" ? "/" : `/assets/${name}`);
			expect(JSON.stringify(reply.headers).includes(capability), name).toBe(false);
			if (name.endsWith(".woff2")) continue; // binary: a font's bytes hold no text to read
			expect(reply.body.includes(capability), name).toBe(false);
			const addresses = [...new Set(reply.body.match(/https?:\/\/[^\s"'`)\\]+/g) ?? [])];
			if (name.endsWith(".js"))
				for (const address of addresses) expect(NAMES_NOT_REQUESTS, `${name}: ${address}`).toContain(address);
			else if (name.endsWith(".svg")) expect(addresses, name).toEqual(["http://www.w3.org/2000/svg"]);
			else expect(addresses, name).toEqual([]);
			// No protocol-relative address either, in the page or the style sheet.
			if (name.endsWith(".html") || name.endsWith(".css"))
				expect(reply.body, name).not.toMatch(/(["'(=\s])\/\/[a-z0-9.-]+\.[a-z]{2,}/i);
		}
	});
});

describe("every guard of the API applies to the page", () => {
	it("answers the same refusals for the page and an asset as for a route", async () => {
		const server = await serve(root, { ui });
		const cap = capabilityOf(server);
		for (const target of [`${cap}/`, `${cap}/assets/${MAIN}`]) {
			expect((await send(server, target, { headers: { Host: "evil.example" } })).status, target).toBe(421);
			expect((await send(server, target, { headers: { Host: `127.0.0.1:${server.port + 1}` } })).status).toBe(421);
			expect((await send(server, target, { headers: { Origin: "http://evil.example" } })).status).toBe(403);
			expect((await send(server, target, { headers: { Origin: "null" } })).status).toBe(403);
			expect((await send(server, target, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
			expect((await send(server, target, { headers: { "Sec-Fetch-Site": "same-site" } })).status).toBe(403);
			for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
				expect((await send(server, target, { method })).status, method).toBe(405);
			expect((await send(server, target, { body: "{}", headers: { "Content-Length": "2" } })).status).toBe(400);
		}
		// A browser navigation (typed address) and a same-origin subresource request are served.
		expect((await send(server, `${cap}/`, { headers: { "Sec-Fetch-Site": "none" } })).status).toBe(200);
		expect(
			(
				await send(server, `${cap}/assets/${MAIN}`, {
					headers: { "Sec-Fetch-Site": "same-origin", Origin: server.origin },
				})
			).status,
		).toBe(200);
		expect(
			(await raw(server, `GET ${cap}/ HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`)).startsWith(
				"HTTP/1.1 421",
			),
		).toBe(true);
	});

	it("a wrong capability gets the same 404 as any unknown path, for the page too", async () => {
		const server = await serve(root, { ui });
		const unknown = await send(server, "/nothing/here");
		for (const target of ["/wrongwrongwrongwrongwrongwrongwrongwrongwro/", `/x/assets/${MAIN}`, "/"]) {
			const reply = await send(server, target);
			expect(reply.status, target).toBe(404);
			expect(reply.body).toBe(unknown.body);
		}
	});

	it("serving the page and its assets spends none of the read budget and changes nothing in the store", async () => {
		const server = await serve(root, { ui, readBudget: { duty: 0.0001, burstMs: 1 } });
		const before = treeHash(root);
		for (let i = 0; i < 40; i += 1)
			for (const name of Object.keys(ui)) await get(server, name === "index.html" ? "/" : `/assets/${name}`);
		expect((await get(server, "/api/v0/snapshot")).status).toBe(200); // the first read still has its whole budget
		expect((await get(server, "/api/v0/snapshot")).status).toBe(429);
		expect(treeHash(root)).toBe(before);
	});
});

describe("the JSON API is exactly what it was", () => {
	it("keeps its bodies byte-identical to the library's and its own restrictive policy, with or without the page", async () => {
		for (const withUi of [false, true]) {
			const server = await serve(root, withUi ? { ui } : {});
			const reply = await get(server, "/api/v0/snapshot?limit=10");
			expect(reply.body).toBe(
				canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, limit: 10 }) as never),
			);
			expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
			expect(reply.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
			expect(reply.headers["cross-origin-opener-policy"]).toBeUndefined();
			expect(reply.headers["x-frame-options"]).toBeUndefined();
			const refusal = await get(server, "/api/v0/snapshot?limit=0");
			expect(refusal.status).toBe(400);
			expect(refusal.body).toBe('{"error":"bad-request"}\n');
		}
	});
});

describe("what the host passes in", () => {
	it("is held in memory: the server reads no file when asked, and changing the host's copy changes nothing", async () => {
		const files: Record<string, string | Uint8Array> = {
			"index.html": "<!doctype html><title>a</title>",
			"a.js": new TextEncoder().encode("export {}"),
		};
		const server = await serve(root, { ui: files });
		files["index.html"] = "changed";
		expect((await get(server, "/")).body).toBe("<!doctype html><title>a</title>");
		expect((await get(server, "/assets/a.js")).body).toBe("export {}");
	});

	it("refuses a file set the server cannot serve safely, before it listens", async () => {
		const bad: Record<string, Record<string, string>> = {
			"no page": { "a.js": "x" },
			"a path": { "index.html": "x", "a/b.js": "x" },
			"a traversal": { "index.html": "x", "../b.js": "x" },
			"a hidden name": { "index.html": "x", ".b.js": "x" },
			"no extension": { "index.html": "x", app: "x" },
			"an unknown type": { "index.html": "x", "data.json": "{}" },
			"a source map": { "index.html": "x", "main.js.map": "{}" },
			"a long name": { "index.html": "x", [`${"n".repeat(70)}.js`]: "x" },
			"a space": { "index.html": "x", "a b.js": "x" },
			"too large": { "index.html": "x".repeat(5 * 1024 * 1024) },
		};
		for (const [what, files] of Object.entries(bad))
			await expect(startEndoCockpitServerV0({ root, digestKey: OTHER_KEY, ui: files }), what).rejects.toThrow(
				TypeError,
			);
	});
});
