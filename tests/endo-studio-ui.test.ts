// The bundled Studio frontend without a browser: that the build is repeatable and closed, that the host refuses any build that is
// not exactly its manifest, and that the production server serves it under the same guards as the existing page. The browser proof
// is tests/endo-studio-ui-browser.test.ts; the installed-package proof is scripts/package-smoke.mjs.
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { startEndoCockpitServerV0 } from "../cockpit-http/server.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { capabilityOf, get, raw, send, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "endo-studio-ui-"));
let first = "";
let second = "";
const MANIFEST = "studio-ui.manifest.json";

beforeAll(async () => {
	const { buildStudioUi } = (await import(
		fileURLToPath(new URL("../scripts/build-studio-ui.mjs", import.meta.url))
	)) as {
		buildStudioUi(outDir: string): Promise<{ outDir: string }>;
	};
	first = (await buildStudioUi(join(scratch, "first"))).outDir;
	second = (await buildStudioUi(join(scratch, "second"))).outDir;
}, 90_000);
afterEach(stopServers);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const names = (dir: string): string[] => readdirSync(dir).sort();
const text = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const find = (dir: string, pattern: RegExp): string => {
	const found = names(dir).find((name) => pattern.test(name));
	if (found === undefined) throw new Error(`no file matches ${pattern}`);
	return found;
};

/** A private copy of the build to damage. */
let copies = 0;
function copy(): string {
	const dir = join(scratch, `copy-${copies++}`);
	cpSync(first, dir, { recursive: true });
	return dir;
}
/** Replace a file's content and make the manifest agree, so only the check on what the file refers to can refuse it. */
function rewrite(dir: string, name: string, content: string): void {
	writeFileSync(join(dir, name), content);
	const manifest = JSON.parse(text(dir, MANIFEST));
	const entry = manifest.files.find((file: { name: string }) => file.name === name);
	const bytes = readFileSync(join(dir, name));
	entry.bytes = bytes.length;
	entry.sha256 = sha(bytes);
	writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest));
}
const refused = (dir: string, message: RegExp): void => {
	expect(() => loadEndoStudioUiFilesV0(dir)).toThrow(TypeError);
	expect(() => loadEndoStudioUiFilesV0(dir)).toThrow(message);
};

describe("the build", () => {
	it("is repeatable: two builds are the same files with the same bytes, and the manifest lists exactly them", () => {
		expect(names(second)).toEqual(names(first));
		for (const name of names(first))
			expect(sha(readFileSync(join(second, name))), name).toBe(sha(readFileSync(join(first, name))));
		const manifest = JSON.parse(text(first, MANIFEST));
		expect(manifest.format).toBe("endo.studio-ui-manifest/v0");
		expect(manifest.files.map((file: { name: string }) => file.name)).toEqual(
			names(first).filter((name) => name !== MANIFEST),
		);
		for (const file of manifest.files) expect(sha(readFileSync(join(first, file.name))), file.name).toBe(file.sha256);
	});

	it("holds only the admitted kinds of file, flat, with no source map and no source", () => {
		for (const name of names(first)) {
			expect(name, name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
			expect(name === MANIFEST || /\.(html|js|css|svg|woff2)$/.test(name), name).toBe(true);
			expect(text(first, name).includes("sourceMappingURL"), name).toBe(false);
		}
		expect(names(first).filter((name) => /\.(map|tsx?|json)$/.test(name))).toEqual([MANIFEST]);
	});

	it("is built for production and carries no path of this machine and no hosted-service client", () => {
		const bundle = text(first, find(first, /^main-.*\.js$/));
		expect(bundle).not.toMatch(/process\.env/); // NODE_ENV was defined at build time
		expect(bundle).not.toMatch(/supabase|posthog|sentry|segment\.com|googletagmanager|google-analytics/i);
		for (const name of names(first)) {
			const content = text(first, name);
			if (name.endsWith(".woff2")) continue;
			expect(content.includes(repo.replace(/\/$/, "")), name).toBe(false);
			expect(content.includes(tmpdir()), name).toBe(false);
			expect(content.includes(process.env.HOME ?? "\0"), name).toBe(false);
		}
	});

	it("has a page with no inline script, no inline style and no reference but its own assets", () => {
		const html = text(first, "index.html");
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
		expect(html).not.toMatch(/<style|\sstyle\s*=|\son[a-z]+\s*=|<base|<iframe|<form|<object|<embed|javascript:/i);
		const references = [...html.matchAll(/(?:src|href)="([^"]*)"/g)].map((match) => match[1]);
		expect(references.length).toBeGreaterThan(0);
		for (const reference of references)
			expect(reference, reference).toMatch(/^\.\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
		const css = text(first, find(first, /\.css$/));
		expect(css).not.toMatch(/@import|url\(\s*(?!["']?\.\/)/);
	});

	it("is written from sources that make no request, parse no markup and import no hosted client", () => {
		const dir = join(repo, "studio-ui", "src");
		for (const name of readdirSync(dir)) {
			const source = readFileSync(join(dir, name), "utf8");
			expect(source, name).not.toMatch(
				/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|https?:\/\//,
			);
			for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g))
				expect(specifier!, `${name}: ${specifier}`).toMatch(/^(\.\/|react$|react-dom\/client$)/);
		}
		const pack = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
		expect(pack.dependencies).toBeUndefined(); // the published package has no runtime dependency; the frontend is bundled
		expect(
			Object.keys(pack.devDependencies).filter((name) =>
				/supabase|analytics|sentry|posthog|^(@vitejs\/.*|vite|webpack|rollup)$/i.test(name),
			),
		).toEqual([]);
	});
});

describe("the host refuses a build that is not exactly its manifest, before anything listens", () => {
	it("accepts the build as built, and holds the font as bytes, not text", () => {
		const files = loadEndoStudioUiFilesV0(first);
		expect(Object.keys(files).sort()).toEqual(names(first).filter((name) => name !== MANIFEST));
		const font = find(first, /\.woff2$/);
		expect(Buffer.from(files[font]!).equals(readFileSync(join(first, font)))).toBe(true);
	});

	it("refuses a missing directory, a missing or malformed manifest, and a manifest of another shape", () => {
		expect(() => loadEndoStudioUiFilesV0(join(scratch, "nowhere"))).toThrow(/was not found/);
		let dir = copy();
		rmSync(join(dir, MANIFEST));
		refused(dir, /manifest\.json is missing/);
		dir = copy();
		writeFileSync(join(dir, MANIFEST), "{not json");
		refused(dir, /not JSON/);
		dir = copy();
		writeFileSync(join(dir, MANIFEST), "x".repeat(70_000));
		refused(dir, /too large/);
		for (const change of [
			(m: Record<string, unknown>) => ({ ...m, extra: 1 }),
			(m: Record<string, unknown>) => ({ ...m, format: "other" }),
			(m: Record<string, unknown>) => ({ ...m, entry: "main.js" }),
			(m: Record<string, unknown>) => ({ ...m, files: [] }),
			(m: Record<string, unknown>) => ({ ...m, files: "all" }),
			(m: Record<string, unknown>) => ({
				...m,
				files: (m.files as { name: string }[]).filter((f) => f.name !== "index.html"),
			}),
		]) {
			dir = copy();
			writeFileSync(join(dir, MANIFEST), JSON.stringify(change(JSON.parse(text(dir, MANIFEST)))));
			expect(() => loadEndoStudioUiFilesV0(dir)).toThrow(TypeError);
		}
	});

	it("refuses a manifest entry that names a path, a type the server does not serve, or a size or digest that is not one", () => {
		for (const bad of [
			{ name: "../escape.js", bytes: 1, sha256: "0".repeat(64) },
			{ name: "sub/dir.js", bytes: 1, sha256: "0".repeat(64) },
			{ name: "font.woff", bytes: 1, sha256: "0".repeat(64) },
			{ name: "main.js.map", bytes: 1, sha256: "0".repeat(64) },
			{ name: "data.json", bytes: 1, sha256: "0".repeat(64) },
			{ name: ".hidden.js", bytes: 1, sha256: "0".repeat(64) },
			{ name: "ok.js", bytes: -1, sha256: "0".repeat(64) },
			{ name: "ok.js", bytes: 1.5, sha256: "0".repeat(64) },
			{ name: "ok.js", bytes: 99_000_000, sha256: "0".repeat(64) },
			{ name: "ok.js", bytes: 1, sha256: "XYZ" },
			{ name: "ok.js", bytes: 1, sha256: "A".repeat(64) },
			{ name: "ok.js", bytes: 1, sha256: "0".repeat(64), extra: true },
		]) {
			const dir = copy();
			const manifest = JSON.parse(text(dir, MANIFEST));
			manifest.files.push(bad);
			writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest));
			expect(() => loadEndoStudioUiFilesV0(dir), JSON.stringify(bad)).toThrow(/manifest/);
		}
		const dir = copy();
		const manifest = JSON.parse(text(dir, MANIFEST));
		manifest.files.push({ ...manifest.files[0] });
		writeFileSync(join(dir, MANIFEST), JSON.stringify(manifest));
		refused(dir, /manifest lists a file it may not/); // listed twice
	});

	it("refuses a file that is missing, extra, changed, resized, linked or not a file", () => {
		let dir = copy();
		rmSync(join(dir, find(dir, /^main-.*\.js$/)));
		refused(dir, /missing or not a regular file/);
		for (const extra of ["extra.js", "main.js.map", "notes.json", "extra.woff", "unlisted.woff2", ".env"]) {
			dir = copy();
			writeFileSync(join(dir, extra), "x");
			refused(dir, /present but not listed/);
		}
		dir = copy();
		mkdirSync(join(dir, "nested"));
		refused(dir, /present but not listed/);
		dir = copy();
		const script = join(dir, find(dir, /^main-.*\.js$/));
		const original = readFileSync(script);
		writeFileSync(
			script,
			Buffer.concat([original.subarray(0, original.length - 1), Buffer.from(original.at(-1) === 0x41 ? "B" : "A")]),
		);
		refused(dir, /does not match its manifest entry/); // same size, one byte different
		writeFileSync(script, Buffer.concat([original, Buffer.from(" ")]));
		refused(dir, /does not match its manifest entry/); // resized
		dir = copy();
		const font = join(dir, find(dir, /\.woff2$/));
		rmSync(font);
		symlinkSync(join(first, find(first, /\.woff2$/)), font);
		refused(dir, /not a regular file/); // a link to the right bytes is still a link
		dir = copy();
		const icon = join(dir, "icon.svg");
		rmSync(icon);
		mkdirSync(icon);
		refused(dir, /not a regular file/);
	});

	it("refuses a page, style sheet or module that refers to anything but a listed file beside it", () => {
		const html = text(first, "index.html");
		const css = find(first, /\.css$/);
		const main = find(first, /^main-.*\.js$/);
		const lazy = find(first, /^LazyProof-.*\.js$/);
		const cases: [string, string, string, RegExp][] = [
			[
				"index.html",
				html.replace("</head>", '<script src="https://example.com/x.js"></script></head>'),
				"a remote script",
				/other than \.\/assets/,
			],
			[
				"index.html",
				html.replace("</head>", '<link rel="stylesheet" href="//example.com/x.css"></head>'),
				"a protocol-relative style sheet",
				/other than \.\/assets/,
			],
			[
				"index.html",
				html.replace("</head>", '<script type="module" src="/assets/x.js"></script></head>'),
				"an absolute path",
				/other than \.\/assets/,
			],
			[
				"index.html",
				html.replace("</head>", '<script type="module" src="./assets/../x.js"></script></head>'),
				"a traversal",
				/other than \.\/assets/,
			],
			[
				"index.html",
				html.replace("</head>", '<script type="module" src="./assets/gone.js"></script></head>'),
				"a missing script",
				/gone\.js is missing/,
			],
			[css, `${text(first, css)}@import "./other.css";`, "an import", /imports another style sheet/],
			[
				css,
				`${text(first, css)}a{background:url(https://example.com/x.png)}`,
				"a remote url()",
				/other than a file beside it/,
			],
			[
				css,
				`${text(first, css)}a{background:url("data:image/png;base64,AAAA")}`,
				"a data: url()",
				/other than a file beside it/,
			],
			[css, `${text(first, css)}a{background:url(../x.png)}`, "a parent url()", /other than a file beside it/],
			[css, `${text(first, css)}a{background:url(./gone.png)}`, "a missing url()", /gone\.png is missing/],
			[
				main,
				`${text(first, main)};import("https://example.com/x.js")`,
				"a remote import",
				/other than a file beside it/,
			],
			[main, `${text(first, main)};import("react")`, "a bare import", /other than a file beside it/],
			[lazy, `${text(first, lazy)};import("./gone.js")`, "a missing import", /gone\.js is missing/],
		];
		for (const [name, content, what, message] of cases) {
			const dir = copy();
			rewrite(dir, name, content);
			expect(() => loadEndoStudioUiFilesV0(dir), what).toThrow(message);
		}
	});

	it("is checked before the key is made or anything listens: a damaged build leaves no key and no server", async () => {
		const dir = copy();
		rmSync(join(dir, find(dir, /\.woff2$/)));
		const keyFile = join(scratch, "launch-key", "cockpit-digest-key");
		let keyReported = false;
		await expect(
			launchEndoCockpitV0({
				root: join(scratch, "absent"),
				keyFile,
				uiDirectory: dir,
				uiFormat: "studio",
				onKey: () => {
					keyReported = true;
				},
			}),
		).rejects.toThrow(/incomplete or damaged/);
		expect(keyReported).toBe(false);
		expect(existsSync(keyFile) || existsSync(join(scratch, "launch-key"))).toBe(false);
		expect(existsSync(join(scratch, "absent"))).toBe(false);
	});
});

describe("the production server serves it under the same guards", () => {
	async function launch() {
		const launched = await launchEndoCockpitV0({
			root: join(scratch, "absent-store"),
			keyFile: join(scratch, "serve-key", "cockpit-digest-key"),
			uiDirectory: first,
			uiFormat: "studio",
		});
		return launched.server;
	}
	const POLICY =
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";

	it("serves the page and each listed file at the capability with the page policy, the right type and the exact bytes", async () => {
		const server = await launch();
		try {
			const page = await get(server, "/");
			expect(page.status).toBe(200);
			expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
			expect(page.headers["content-security-policy"]).toBe(POLICY);
			expect(page.body).toBe(text(first, "index.html"));
			for (const name of names(first).filter((n) => n !== MANIFEST && n !== "index.html")) {
				const reply = await get(server, `/assets/${name}`);
				expect(reply.status, name).toBe(200);
				expect(reply.headers["content-security-policy"], name).toBe(POLICY);
				expect(reply.headers["x-content-type-options"], name).toBe("nosniff");
				expect(reply.headers["cache-control"], name).toBe("no-store");
				expect(reply.headers["cross-origin-resource-policy"], name).toBe("same-origin");
				expect(
					Object.keys(reply.headers).some((h) => h.startsWith("access-control-")),
					name,
				).toBe(false);
				if (!name.endsWith(".woff2")) expect(reply.body, name).toBe(text(first, name));
			}
			const font = await get(server, `/assets/${find(first, /\.woff2$/)}`);
			expect(font.headers["content-type"]).toBe("font/woff2");
			expect(font.headers["content-length"]).toBe(String(readFileSync(join(first, find(first, /\.woff2$/))).length));
		} finally {
			await server.close();
		}
	});

	it("refuses everything else with the fixed answers, none of which carries the capability or a path", async () => {
		const server = await launch();
		const capability = capabilityOf(server).slice(1);
		const font = find(first, /\.woff2$/);
		try {
			const notFound = `{"error":"not-found"}\n`;
			for (const route of [
				`/assets/${MANIFEST}`,
				"/assets/nothing.js",
				"/assets/index.html",
				"/assets/",
				"/assets",
				"/assets/../index.html",
				"/assets/%2e%2e/index.html",
				`/assets/${font}%00`,
				`/assets/${font}/`,
				`//assets/${font}`,
				"/assets/.hidden",
				"/assets/main.js.map",
				"/assets/a.woff",
				"/main.js",
			]) {
				const reply = await get(server, route);
				expect(reply.status, route).toBe(404);
				expect(reply.body, route).toBe(notFound);
			}
			expect((await get(server, `/assets/${font}?v=1`)).status).toBe(400); // a query string is refused for a file
			expect((await send(server, capabilityOf(server))).status).toBe(404); // the capability without its slash
			const wrong = await send(server, `/${"A".repeat(capability.length)}/`);
			expect(wrong.status).toBe(404);
			expect(wrong.body).toBe(notFound);
			expect((await send(server, `/${capability}/`, { method: "POST", body: "x" })).status).toBe(405);
			expect((await send(server, `/${capability}/`, { method: "HEAD" })).status).toBe(405);
			expect((await send(server, `/${capability}/`, { headers: { "Content-Length": "3" } })).status).toBe(400);
			expect((await get(server, "/", { Host: "evil.example" })).status).toBe(421);
			expect((await get(server, "/", { Origin: "http://evil.example" })).status).toBe(403);
			expect((await get(server, "/", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
			const rebinding = await raw(server, `GET ${capabilityOf(server)}/ HTTP/1.1\r\nHost: evil.example\r\n\r\n`);
			expect(rebinding.includes(capability)).toBe(false);
			for (const reply of [await get(server, "/assets/nothing.js"), wrong]) {
				expect(JSON.stringify(reply.headers).includes(capability)).toBe(false);
				expect(reply.body.includes(capability)).toBe(false);
			}
		} finally {
			await server.close();
		}
	});

	it("still serves the read-only API beside the frontend, answering for an absent store as absent", async () => {
		const server = await launch();
		try {
			const snapshot = await get(server, "/api/v0/snapshot");
			expect(snapshot.status).toBe(200);
			expect(JSON.parse(snapshot.body).timeline.source.condition.state).toBe("absent");
			expect(existsSync(join(scratch, "absent-store"))).toBe(false); // reading did not create the store
		} finally {
			await server.close();
		}
	});

	it("admits no other font or data type to the server's own file list", async () => {
		for (const name of ["a.woff", "a.ttf", "a.otf", "a.map", "a.json", "a.wasm", "a.png", "a.WOFF2", "woff2"]) {
			const outcome = startEndoCockpitServerV0({
				root: scratch,
				digestKey: OTHER_KEY,
				ui: { "index.html": "<p>x</p>", [name]: "x" },
			});
			await expect(outcome, name).rejects.toThrow(TypeError);
		}
		const server = await startEndoCockpitServerV0({
			root: scratch,
			digestKey: OTHER_KEY,
			ui: { "index.html": "<p>x</p>", "a.woff2": new Uint8Array([1, 2, 3]) },
		});
		await server.close();
	});
});
