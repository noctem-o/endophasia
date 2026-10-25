import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readEndoCockpitSnapshotV0 } from "../cockpit/index.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { chooseRecording, exerciseStudioCompare } from "./studio-compare-acceptance.ts";
import { compareEvents, comparePiEvents, compareRecords } from "./studio-compare-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-compare-browser-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
const stops: (() => Promise<void>)[] = [];
beforeAll(async () => {
	if (executable === null) {
		if (process.env.ENDO_REQUIRE_BROWSER === "1") throw new Error("Chromium required");
		return;
	}
	const { buildStudioUi } = (await import(new URL("../scripts/build-studio-ui.mjs", import.meta.url).pathname)) as {
		buildStudioUi(outDir: string): Promise<unknown>;
	};
	await buildStudioUi(join(scratch, "ui"));
	ui = loadEndoStudioUiFilesV0(join(scratch, "ui"));
	browser = await Browser.launch(executable);
}, 90_000);
afterEach(async () => {
	await Promise.all(tabs.splice(0).map((p) => p.close()));
	await stopServers();
	await Promise.all(stops.splice(0).map((stop) => stop()));
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null ? describe.skip : describe;
async function open(address: string) {
	const page = await browser.open(1280, 900);
	tabs.push(page);
	await page.goto(address);
	await page.settled();
	await page.click("button[data-workspace=compare]");
	await page.waitFor(
		"document.querySelector('#compare-workspace')?.dataset.busy === 'false' && (document.querySelector('#compare-workspace [role=alert]') || document.querySelector('#compare-recordings output')?.textContent.includes('candidates loaded'))",
	);
	return page;
}
async function capture(page: Page, name: string) {
	if (process.env.ENDO_COMPARE_EVIDENCE_DIR) {
		mkdirSync(process.env.ENDO_COMPARE_EVIDENCE_DIR, { recursive: true });
		writeFileSync(join(process.env.ENDO_COMPARE_EVIDENCE_DIR, `${name}.png`), await page.screenshot());
	}
}

/** A test-only wire stand-in for malformed, paced and overlapping responses the production server cannot fabricate. */
async function standIn(handler: (route: string, response: ServerResponse) => void) {
	const root = tempRoot();
	ingestAll(root, compareEvents());
	const snapshot = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY });
	const server = createServer((req, res) => {
		const route = req.url ?? "/";
		if (route.startsWith("/api/v0/compare/")) return handler(route, res);
		if (route.startsWith("/api/v0/snapshot")) {
			res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(snapshot));
			return;
		}
		const name = route === "/" ? "index.html" : route.slice("/assets/".length);
		const body = ui[name];
		if (body === undefined) {
			res.writeHead(404).end();
			return;
		}
		const type = name.endsWith(".js")
			? "text/javascript"
			: name.endsWith(".css")
				? "text/css"
				: name.endsWith(".woff2")
					? "font/woff2"
					: name.endsWith(".svg")
						? "image/svg+xml"
						: "text/html";
		res.writeHead(200, { "Content-Type": type }).end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	stops.push(
		() =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	);
	return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
const json = (res: ServerResponse, value: unknown, status = 200, retry?: string) =>
	res
		.writeHead(status, { "Content-Type": "application/json", ...(retry ? { "Retry-After": retry } : {}) })
		.end(JSON.stringify(value));

suite("React Compare", () => {
	it("compares retained Pi/DSH evidence via production HTTP, preserves Observe, keyboard focus, CSP and narrow layout", async () => {
		const root = tempRoot();
		ingestAll(root, compareEvents());
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const result = await exerciseStudioCompare(browser, `${server.baseUrl}/`);
		expect(result.failures).toEqual([]);
		if (process.env.ENDO_COMPARE_EVIDENCE_DIR) {
			mkdirSync(process.env.ENDO_COMPARE_EVIDENCE_DIR, { recursive: true });
			writeFileSync(join(process.env.ENDO_COMPARE_EVIDENCE_DIR, "compare-populated.png"), result.image);
		}
	});
	it("empty and single-candidate inventories require explicit choices; self-comparison is identified", async () => {
		const root = tempRoot();
		mkdirSync(`${root}/events`);
		writeFileSync(`${root}/events/events.log`, "");
		let server = await serve(root, { ui });
		let page = await open(`${server.baseUrl}/`);
		expect(await page.text("#compare-workspace")).toContain("No recording candidates");
		expect(await page.eval("document.querySelector('#compare-run').disabled")).toBe(true);
		const one = tempRoot();
		ingestAll(one, comparePiEvents());
		server = await serve(one, { ui });
		page = await open(`${server.baseUrl}/`);
		await chooseRecording(page, "a", "pi");
		expect(await page.eval("document.querySelector('#compare-run').disabled")).toBe(true);
		await chooseRecording(page, "b", "pi");
		expect(await page.text("#compare-workspace")).toContain("not independent observations");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-result')");
	});
	it("keeps ineligible recordings disabled without deriving a selector from their display identity", async () => {
		const rows = compareEvents().filter((e) => e.kind !== "dsh.import-checkpoint");
		const root = tempRoot();
		ingestAll(root, [
			...rows,
			event("harness.attached", {}, { producer: "pi-rpc-adapter:pi.second", session: "endo.session.pi.a" }),
		]);
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(
			await page.eval(
				"[...document.querySelector('#recording-a').options].filter(o => o.disabled).map(o => o.textContent)",
			),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("ambiguous attachments"),
				expect.stringContaining("insufficient evidence"),
			]),
		);
		expect(await page.eval("document.querySelector('#compare-run').disabled")).toBe(true);
	});
	it("renders DSH self-comparison and independent exact, unavailable-domain and absent-entry Pi layers from production evidence", async () => {
		const root = tempRoot();
		const secret = "endo.session.pi.Tok_CANARY_PrivateCoordinate";
		ingestAll(root, [
			...compareEvents(),
			...comparePiEvents("other-digest-domain", "endo.session.pi.domain"),
			event("harness.attached", {}, { producer: "pi-rpc-adapter:pi.default", session: "endo.session.pi.empty" }),
			...comparePiEvents("baseline", secret).map((e) =>
				e.kind === "lifecycle.run-completed"
					? {
							...e,
							payload: {
								...(e.payload as Record<string, unknown>),
								stopReason: { status: "reported", value: "/home/CANARY_private/withheld-stop-reason" },
							},
						}
					: e,
			),
		]);
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await open(`${server.baseUrl}/`);
		expect(await page.text("body")).not.toContain("CANARY");
		await chooseRecording(page, "a", "dsh");
		await chooseRecording(page, "b", "dsh");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-result')");
		expect(await page.text("#compare-toolCalls")).toContain("EXACT");
		// Select actual public options by their labels, never construct a request from them.
		const chooseSession = async (side: string, ending: string) =>
			page.eval(`(() => {
            const e = document.querySelector('#recording-${side}');
            e.value = [...e.options].find(o => o.textContent.trim().endsWith('${ending}')).value;
            e.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
		await chooseSession("a", "endo.session.pi.a");
		await chooseSession("b", "endo.session.pi.domain");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-result')");
		expect(await page.text("#compare-toolCalls")).toContain("UNAVAILABLE");
		expect(await page.text("#compare-toolCalls")).toContain("digest-domains-differ");
		await chooseSession("b", "endo.session.pi.empty");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-result')");
		expect(await page.text("#compare-result")).toContain("No entry at this position");
		// The withheld original is represented only by the server's long keyed alias.
		await page.eval(
			`(() => { const e = document.querySelector('#recording-b'); e.value = [...e.options].find(o => o.textContent.includes('endo.session.withheld-')).value; e.dispatchEvent(new Event('change', {bubbles:true})); })()`,
		);
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-result')");
		expect(await page.text("#compare-toolCalls")).toContain("EXACT");
		expect(await page.text("#compare-outcome")).toContain("DIVERGED");
		expect(await page.text("#compare-outcome")).toContain("Withheld text");
		await page.click("#compare-outcome details.withheld summary");
		expect(
			await page.eval("document.querySelector('#compare-outcome details.withheld[open] code').textContent.length"),
		).toBe(64);
		await page.resize(360, 900);
		expect(await page.eval("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
		expect(await page.text("body")).not.toContain("CANARY");
		expect(page.seen.requests.join("\n")).not.toContain("CANARY");
		expect(page.seen.problems).toEqual([]);
	});
	it("rejects an unknown comparison version and permits only explicit rediscovery", async () => {
		const records = compareRecords();
		const page = await open(
			await standIn((route, res) =>
				json(
					res,
					route.includes("candidates")
						? records.candidates
						: { ...records.comparison, projectionVersion: "cockpit-trajectory-comparison.999" },
				),
			),
		);
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.text("#compare-workspace")).toContain("Unsupported or malformed");
		expect(await page.eval("Boolean(document.querySelector('#compare-result'))")).toBe(false);
		expect(await page.eval("document.querySelector('#recording-a').disabled")).toBe(true);
		await page.click("#rediscover");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.eval("document.querySelector('#recording-a').disabled")).toBe(false);
	});
	it("multiple pages load explicitly; stale cursors clear the inventory without asserting mutation", async () => {
		const root = tempRoot();
		ingestAll(
			root,
			Array.from({ length: 101 }, (_, i) =>
				event("harness.attached", {}, { producer: "pi-rpc-adapter:pi.default", session: `endo.session.pi.s-${i}` }),
			),
		);
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await open(`${server.baseUrl}/`);
		expect(await page.text("#compare-recordings")).toContain("100 of 101");
		await page.click("#compare-more");
		await page.waitFor("document.querySelector('#compare-workspace')?.dataset.busy === 'false'");
		expect(await page.text("#compare-recordings")).toContain("101 of 101");
		await page.click("#rediscover");
		await page.waitFor(
			"document.querySelector('#compare-more') && document.querySelector('#compare-workspace').dataset.busy === 'false'",
		);
		ingestAll(root, [event("unrelated.append")]);
		await page.click("#compare-more");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.text("#compare-workspace")).toContain("does not prove");
		expect(await page.eval("document.querySelector('#recording-a').disabled")).toBe(true);
	});
	it("a stale selection clears results and offers explicit rediscovery; absent evidence is a fixed source failure", async () => {
		const root = tempRoot();
		ingestAll(root, compareEvents());
		let server = await serve(root, { ui });
		let page = await open(`${server.baseUrl}/`);
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		ingestAll(root, [event("unrelated.append")]);
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.text("#compare-workspace")).toContain("does not prove");
		expect(await page.eval("Boolean(document.querySelector('#compare-result'))")).toBe(false);
		await capture(page, "compare-invalid-selection");
		server = await serve(join(scratch, "absent"), { ui });
		page = await open(`${server.baseUrl}/`);
		expect(await page.text("#compare-workspace")).toContain("No event store is present");
		await capture(page, "compare-source-unavailable");
	});
	it.each(["schema", "projection", "shape"])("rejects %s responses without presenting data", async (failure) => {
		const record = structuredClone(compareRecords().candidates) as unknown as Record<string, unknown>;
		record[failure === "schema" ? "schemaVersion" : failure === "projection" ? "projectionVersion" : "candidates"] =
			"CANARY-private-response";
		const page = await open(await standIn((_r, res) => json(res, record)));
		expect(await page.text("#compare-workspace")).toContain("Unsupported or malformed");
		expect(await page.text("body")).not.toContain("CANARY");
	});
	it("429 honors pacing without retry; navigation cancels a pending comparison and late data cannot become applicable", async () => {
		const records = compareRecords();
		let attempts = 0;
		const pending: ServerResponse[] = [];
		const address = await standIn((route, res) => {
			if (route.includes("candidates")) {
				attempts += 1;
				json(
					res,
					attempts === 1 ? { error: "too-many-requests" } : records.candidates,
					attempts === 1 ? 429 : 200,
					attempts === 1 ? "1" : undefined,
				);
			} else pending.push(res);
		});
		const page = await open(address);
		expect(await page.eval("document.querySelector('#rediscover').disabled")).toBe(true);
		await page.waitFor("!document.querySelector('#rediscover').disabled");
		expect(attempts).toBe(1);
		await page.click("#rediscover");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'true'");
		await page.click("button[data-workspace=observe]");
		for (const res of pending.splice(0)) json(res, records.comparison);
		await page.click("button[data-workspace=compare]");
		expect(await page.eval("Boolean(document.querySelector('#compare-result'))")).toBe(false);
		expect(await page.text("#compare-workspace")).toContain("interrupted");
	});
	it("timeout and network failures retain the chosen pair but never retry or display a result", async () => {
		const records = compareRecords();
		let reads = 0;
		const page = await open(
			await standIn((route, res) => {
				if (route.includes("candidates")) json(res, records.candidates);
				else {
					reads += 1;
					if (reads > 1) res.destroy();
				}
			}),
		);
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		await page.eval("(() => { const original = AbortSignal.timeout; AbortSignal.timeout = () => original(30); })()");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.text("#compare-workspace")).toContain("timed out");
		expect(reads).toBe(1);
		expect(await page.eval("document.querySelector('#recording-a').value.startsWith('pi:')")).toBe(true);
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'false'");
		expect(await page.text("#compare-workspace")).toContain("could not be reached");
		expect(await page.eval("Boolean(document.querySelector('#compare-result'))")).toBe(false);
	});
	it("a delayed old comparison cannot overwrite a newer selection; failure text never leaks exception payloads", async () => {
		const records = compareRecords();
		const pending: ServerResponse[] = [];
		const page = await open(
			await standIn((route, res) =>
				route.includes("candidates") ? json(res, records.candidates) : void pending.push(res),
			),
		);
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		await page.click("#compare-run");
		await page.waitFor("document.querySelector('#compare-workspace').dataset.busy === 'true'");
		await chooseRecording(page, "a", "dsh");
		for (const res of pending.splice(0)) json(res, records.comparison);
		expect(await page.eval("Boolean(document.querySelector('#compare-result'))")).toBe(false);
	});
});
