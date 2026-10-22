// The bundled Studio frontend in a real browser, through the real server at its real capability address: headless Chromium with the
// GPU off. The build is made from this checkout into a scratch directory, loaded by the production host (cockpit-http/host.ts) and
// served by the production server. The installed-package version of the same proof is in scripts/package-smoke.mjs.
//
// This suite does not skip when no Chromium is found if ENDO_REQUIRE_BROWSER=1 (CI sets it): it fails, like the package smoke test.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchEndoCockpitV0 } from "../cockpit-http/host.ts";
import { startEndoCockpitServerV0 } from "../cockpit-http/server.ts";
import { Browser, findBrowser } from "./cockpit-browser.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { exerciseStudioUi } from "./studio-ui-acceptance.ts";

const required = process.env.ENDO_REQUIRE_BROWSER === "1";
const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-studio-ui-browser-"));
let browser: Browser | null = null;
let built = "";

beforeAll(async () => {
	if (executable === null && required)
		throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
	const { buildStudioUi } = (await import(
		fileURLToPath(new URL("../scripts/build-studio-ui.mjs", import.meta.url))
	)) as {
		buildStudioUi(outDir: string): Promise<{ outDir: string }>;
	};
	built = (await buildStudioUi(join(scratch, "ui"))).outDir;
	if (executable !== null) browser = await Browser.launch(executable);
}, 90_000);
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
});

const suite = executable === null && !required ? describe.skip : describe;
if (executable === null)
	console.warn("endo-studio-ui-browser: no Chromium found (set CHROME_BIN); the browser tests are skipped");

suite("the bundled Studio frontend through the production server", () => {
	it("renders at the capability address with every asset loaded, nothing outside the server, and no policy violation", async () => {
		const launched = await launchEndoCockpitV0({
			root: join(scratch, "absent-store"),
			keyFile: join(scratch, "key", "cockpit-digest-key"),
			uiDirectory: built,
			uiFormat: "studio",
		});
		try {
			const { failures, facts } = await exerciseStudioUi(
				browser!,
				`${launched.server.baseUrl}/`,
				launched.server.origin,
			);
			expect(failures).toEqual([]);
			expect(facts.title).toBe("Endophasia Studio (integration proof)");
		} finally {
			await launched.server.close();
		}
	}, 60_000);

	it("a font from anywhere but the server is not loaded: a data: font and a remote font are each blocked by the page policy", async () => {
		const hits: string[] = [];
		const remote = createServer((request, response) => {
			hits.push(request.url ?? "");
			response.writeHead(200, { "Content-Type": "font/woff2", "Access-Control-Allow-Origin": "*" });
			response.end("x");
		});
		await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
		const remotePort = (remote.address() as { port: number }).port;
		const css = [
			`@font-face{font-family:"DataFont";src:url("data:font/woff2;base64,d09GMgABAAAAAAAA") format("woff2")}`,
			`@font-face{font-family:"RemoteFont";src:url("http://127.0.0.1:${remotePort}/remote.woff2") format("woff2")}`,
			`p{font-family:"DataFont","RemoteFont",serif}`,
		].join("\n");
		const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./assets/f.css"></head><body><p>text</p></body></html>`;
		const server = await startEndoCockpitServerV0({
			root: join(scratch, "absent-store"),
			digestKey: OTHER_KEY,
			ui: { "index.html": html, "f.css": css },
		});
		const tab = await browser!.open();
		try {
			await tab.goto(`${server.baseUrl}/`);
			await tab.waitFor("document.fonts.status === 'loaded'", 15_000);
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(hits).toEqual([]);
			expect(tab.seen.problems.some((problem) => /Content Security Policy|font-src/i.test(problem))).toBe(true);
			expect(await tab.eval<string[]>(`[...document.fonts].map((face) => face.status)`)).not.toContain("loaded");
		} finally {
			await tab.close();
			await server.close();
			await new Promise((resolve) => remote.close(resolve));
		}
	}, 60_000);
});
