// The Studio Observe workspace in a real browser: headless Chromium with the GPU off (so the frontend is shown to work without hardware
// acceleration), against the production server under its real capability address, over real temporary stores. ENDO_REQUIRE_BROWSER=1
// makes a missing Chromium a failure; without it the suite is skipped with the reason stated (set CHROME_BIN to point at one).
//
// These are the old page's browser tests (tests/endo-cockpit-ui-browser.test.ts) carried over to the React frontend, with the same
// questions asked of the same stores: the old page may be retired only because everything it was held to is held here.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readEndoCockpitSnapshotV0 } from "../cockpit/index.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { createEndoFrameLogV0, endoFrameBytesV0 } from "../storage/log.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import {
	ATTACHMENT,
	CANARY,
	event,
	ingestAll,
	lifecycleEvents,
	removeTempRoots,
	seedRegistry,
	specimen,
	tempRoot,
} from "./cockpit-fixtures.ts";
import { get, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

const executable = findBrowser();
const repo = fileURLToPath(new URL("../", import.meta.url));
let browser: Browser | null = null;
let dist = "";
let ui: Record<string, Uint8Array> = {};

const required = process.env.ENDO_REQUIRE_BROWSER === "1";
beforeAll(async () => {
	if (executable === null && required)
		throw new Error("ENDO_REQUIRE_BROWSER=1 but no Chromium was found (set CHROME_BIN)");
	dist = mkdtempSync(join(tmpdir(), "endo-studio-observe-dist-"));
	const { buildStudioUi } = (await import(join(repo, "scripts/build-studio-ui.mjs"))) as {
		buildStudioUi(outDir: string): Promise<{ outDir: string }>;
	};
	await buildStudioUi(dist);
	ui = loadEndoStudioUiFilesV0(dist);
	if (executable !== null) browser = await Browser.launch(executable);
}, 90_000);
afterAll(async () => {
	await browser?.close();
	rmSync(dist, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});
afterEach(stopServers);

const suite = executable === null && !required ? describe.skip : describe;
if (executable === null && !required)
	console.warn("endo-studio-observe-browser: no Chromium found (set CHROME_BIN); the browser tests are skipped");

let tabs: Page[] = [];
/** React reads a text box through its own value tracker: a test sets the value by the prototype's setter, as a keystroke does, then fires the event. */
const SET_VALUE = `window.__set = (el, value) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value)`;
/** A stand-in for the API serving `snapshot` under the real page's files: for what the real server would not say. */
const standIns: Server[] = [];
async function pretendFor(snapshot: unknown): Promise<string> {
	const stand = createServer((req, res) => {
		const url = (req.url ?? "/").split("?")[0]!;
		if (url.startsWith("/api/")) {
			res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(snapshot));
			return;
		}
		const name = url === "/" ? "index.html" : url.replace(/^\/assets\//, "");
		const body = ui[name];
		if (body === undefined) res.writeHead(404).end();
		else res.writeHead(200, { "Content-Type": contentTypeOf(name) }).end(body);
	});
	standIns.push(stand);
	await new Promise<void>((resolve) => stand.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(stand.address() as { port: number }).port}/`;
}
const contentTypeOf = (name: string): string =>
	name.endsWith(".js")
		? "text/javascript"
		: name.endsWith(".css")
			? "text/css"
			: name.endsWith(".svg")
				? "image/svg+xml"
				: name.endsWith(".woff2")
					? "font/woff2"
					: "text/html";
afterEach(async () => {
	await Promise.all(standIns.splice(0).map((stand) => new Promise((resolve) => stand.close(resolve))));
});
async function open(url: string, width = 1440, height = 900): Promise<Page> {
	const page = await browser!.open(width, height);
	tabs.push(page);
	await page.goto(url);
	await page.settled();
	await page.eval(SET_VALUE);
	return page;
}
afterEach(async () => {
	await Promise.all(tabs.map((tab) => tab.close()));
	tabs = [];
});
/** Navigate without waiting for the page to report a read (for an address that serves something else). */
async function visit(url: string): Promise<Page> {
	const page = await browser!.open(1440, 900);
	tabs.push(page);
	await page.goto(url);
	await new Promise((resolve) => setTimeout(resolve, 400));
	return page;
}

const text = (page: Page, selector: string) => page.text(selector);
const count = (page: Page, selector: string) =>
	page.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const snapshotRequests = (page: Page) => page.seen.requests.filter((url) => url.includes("/api/v0/snapshot")).length;

function populated(events = lifecycleEvents("completes")): string {
	const root = tempRoot();
	ingestAll(root, events);
	seedRegistry(root);
	return root;
}

suite("a populated store", () => {
	it("renders the runtime, the capabilities and the timeline of real API data, with nothing wrong in the browser", async () => {
		const root = populated();
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		const library = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, limit: 100 });
		const runtime = library.runtimes[0]!;

		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(page.seen.problems).toEqual([]); // no console error, exception, CSP or Trusted Types violation
		expect(page.seen.requests.every((url) => url.startsWith(`${server.origin}/`))).toBe(true);
		expect(page.seen.requests.some((url) => /^https?:\/\/(?!127\.0\.0\.1)/.test(url))).toBe(false);

		const runtimeText = await text(page, "#runtime");
		expect(runtimeText).toContain(ATTACHMENT);
		expect(runtimeText).toContain("1.0.0"); // the version the runtime reported
		expect(runtimeText).toContain("REP"); // ... shown as reported, not observed
		expect(runtimeText).toContain("readable");

		expect(await count(page, "#capabilities button.caprow")).toBe(runtime.capabilities.capabilities.length);
		const capabilitiesText = await text(page, "#capabilities");
		for (const capability of runtime.capabilities.capabilities)
			expect(capabilitiesText).toContain(capability.capability);

		expect(await count(page, "#timeline table.events tbody tr[data-seq]")).toBe(library.timeline.entries.length);
		const kinds = await page.eval<string[]>(
			`[...document.querySelectorAll("#timeline tr[data-seq] .col-kind .kind")].map((e) => e.textContent)`,
		);
		expect(kinds).toEqual(library.timeline.entries.map((entry) => entry.kind));
		const positions = await page.eval<string[]>(
			`[...document.querySelectorAll("#timeline tr[data-seq] .seq")].map((e) => e.textContent.replace(/,/g, ""))`,
		);
		expect(positions).toEqual(library.timeline.entries.map((entry) => String(entry.storageSequence)));
	});

	it("says what it is and what it is not: read-only, independent sources, the browser's clock, and never LIVE", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		const all = await page.eval<string>("document.body.innerText");
		expect(all).toMatch(/read-only/i);
		expect(all).toMatch(/independent sources/i);
		expect(await text(page, "#read-status")).toMatch(/by this browser's clock/);
		// No LIVE badge, and no claim of being live: the only "live" on the page is the name of a kind of check, "live study".
		expect(all).not.toMatch(/\bLIVE\b/);
		expect(all).not.toMatch(/\blive\b(?! stud)/i);
		expect(await text(page, "#sources")).toMatch(/no shared sequence or moment/);
		expect(await text(page, "#timeline")).toMatch(/Recorded/);
		expect(await page.eval<string>(`document.querySelector("#timeline th[title*='producer']").title`)).toMatch(
			/Not an ordering/,
		);
	});

	it("shows usage per event, as reported, and never adds it up", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		const cells = await page.eval<string[]>(
			`[...document.querySelectorAll("#timeline .usage")].map((e) => e.textContent)`,
		);
		expect(cells.length).toBeGreaterThan(0);
		for (const cell of cells) expect(cell).toMatch(/^in [\d,]+ · out [\d,]+$/);
		const row = await page.eval<string>(`document.querySelector("#timeline .usage").closest("tr").dataset.seq`);
		await page.click(`#timeline tr[data-seq="${row}"] button.seq`);
		const inspector = await text(page, "#inspector");
		expect(inspector).toContain("Usage, as reported for this event");
		expect(inspector).toContain("total tokens (this event)");
		// A recorded zero is shown as 0 and a recorded cost as recorded, with no currency: not as "not recorded".
		expect(inspector).toMatch(/reasoning tokens0/);
		expect(inspector).toMatch(/cost \(no unit recorded\)0\.001/);
		expect(inspector).toContain("Not added up");
		expect(inspector).not.toMatch(/[$€£]/);
	});

	it("is idle when nothing is asked: no request, no animation, no timer work after it settles", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		const before = page.seen.requests.length;
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(page.seen.requests.length).toBe(before);
		expect(await page.eval<number>("document.getAnimations().length")).toBe(0);
		expect(await page.eval("document.body.dataset.busy")).toBe("false");
	});

	it("fits the screen without sideways scrolling at laptop and narrow widths", async () => {
		const server = await serve(populated(), { ui });
		for (const [width, height] of [
			[1440, 900],
			[1280, 720],
			[1100, 800],
			[900, 900],
			[640, 900],
			[420, 900],
			[360, 800],
			[768, 900],
			[1366, 768],
		] as const) {
			const page = await open(`${server.baseUrl}/`, width, height);
			expect(
				await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1"),
				`${width}px wide`,
			).toBe(true);
			expect(await count(page, "#timeline tr[data-seq]"), `${width}px wide`).toBeGreaterThan(0);
		}
	});
});

suite("the page enforces its own policy", () => {
	it("has Trusted Types on: an HTML sink throws, so no code path can parse markup from text", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(
			await page.eval(
				`(() => { try { document.body.innerHTML = "<b>x</b>"; return "allowed"; } catch (e) { return e.name; } })()`,
			),
		).toBe("TypeError");
		expect(
			await page.eval(
				`(() => { try { document.body.insertAdjacentHTML("beforeend", "<b>x</b>"); return "allowed"; } catch (e) { return e.name; } })()`,
			),
		).toBe("TypeError");
		expect(await page.eval(`document.querySelectorAll("script:not([src])").length`)).toBe(0);
	});

	it("shows text from the API as text: a hostile string makes no element and no script, and the sentinel and alias are told apart", async () => {
		// A stand-in for the API that answers with a well-formed snapshot whose strings are hostile. (The real server's text policy
		// would withhold most of these; the page must still be safe against a reply the server did not vet.)
		const hostile = '<img src=x onerror="document.title=1"><script>1</script>';
		const snapshot = JSON.parse(
			JSON.stringify(readEndoCockpitSnapshotV0(populated(), { digestKey: OTHER_KEY, limit: 100 })),
		);
		snapshot.timeline.entries[0].kind = hostile;
		snapshot.timeline.entries[0].producer = "withheld: looks like a path, address or credential";
		snapshot.timeline.entries[1].producer = "endo.event.withheld-0123456789abcdef0123456789abcdef";
		const url = await pretendFor(snapshot);
		const page = await open(url);
		const rows = await page.eval<{ imgs: number; shown: string; withheld: string; alias: string }>(`(() => {
			const row = (n) => document.querySelector("#timeline tr[data-seq='" + n + "']");
			return {
				imgs: document.querySelectorAll("img, script:not([src])").length,
				shown: row(1).querySelector(".kind").textContent,
				withheld: row(1).querySelector(".producer span").className + "|" + row(1).querySelector(".producer").textContent,
				alias: row(2).querySelector(".producer .alias").className,
			};
		})()`);
		expect(rows.imgs).toBe(0);
		expect(rows.shown).toBe(hostile);
		expect(rows.withheld).toBe("withheld|withheld");
		expect(rows.alias).toBe("alias");
		expect(await page.eval("document.title")).toBe("Endophasia Studio");
		expect(page.seen.problems).toEqual([]);
		// An unavailable claim names its reason, as text, beside the N/A mark.
		await page.click("#timeline tr[data-seq='1'] button.seq");
		expect(await text(page, "#inspector")).toContain(hostile);
		// Free text that merely contains an alias token is shown whole, as the text it is.
		const sentence = "see endo.event.withheld-0123456789abcdef0123456789abcdef for the reason";
		snapshot.timeline.entries[2].producer = sentence;
		const again = await open(await pretendFor(snapshot));
		expect(await again.eval(`document.querySelector("#timeline tr[data-seq='3'] .producer").textContent`)).toBe(
			sentence,
		);
	});
});

suite("sources the page must not misrepresent", () => {
	it("an absent store: absent, not empty and not unreadable, with no timeline table and no registry assumed", async () => {
		const server = await serve(tempRoot(), { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "#timeline")).toContain("No event log exists under this store root.");
		expect(await count(page, "#timeline table")).toBe(0);
		expect(await text(page, "#runtime")).toContain("No attachment registry was found");
		expect(await text(page, "#sources")).toMatch(/absent/);
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
	});

	it("an empty log: empty, said so, and different from absent", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		writeFileSync(join(root, "events", "events.log"), "");
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "#timeline")).toContain("The event log exists and holds no events.");
		expect(await text(page, "#timeline")).not.toContain("No event log exists");
		expect(await text(page, "#sources")).toMatch(/events read\s*0/);
	});

	it("a torn tail: degraded, warned about, and the readable prefix still shown", async () => {
		const root = populated();
		const before = readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY }).timeline.entries.length;
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "#timeline")).toMatch(/degraded/);
		expect(await text(page, "#timeline")).toMatch(/21 bytes follow the last verified event/);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(Math.min(before, 100));
		expect(await count(page, "#timeline .note-warn")).toBe(1);
	});

	it("an unopenable log: unopenable, with the server's fixed sentence, and never shown as an empty log", async () => {
		const root = tempRoot();
		mkdirSync(join(root, "events"));
		createEndoFrameLogV0(join(root, "events", "events.log")).append(
			new TextEncoder().encode(JSON.stringify({ ...event("tool.started"), schemaVersion: "endo.event.v999" })),
		);
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		const timeline = await text(page, "#timeline");
		expect(timeline).toContain("could not be opened");
		expect(timeline).toContain("a stored record declares a schema version this reader does not support");
		expect(timeline).toContain("This is not an empty log.");
		expect(timeline).not.toContain("holds no events");
		expect(await count(page, "#timeline table")).toBe(0);
		expect(await text(page, "#sources")).toMatch(/no position/);
		expect(await page.eval<string>("document.body.innerText")).not.toContain("v999");
	});

	it("an unopenable registry beside a healthy log and registry: each source keeps its own condition", async () => {
		const root = populated();
		const broken = join(root, "harness", "bad.default", "records.log");
		mkdirSync(dirname(broken), { recursive: true });
		createEndoFrameLogV0(broken).append(
			new TextEncoder().encode(
				JSON.stringify({ kind: "state", record: { schemaVersion: "endo.capability-state.v999" } }),
			),
		);
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		const sources = await page.eval<string[]>(
			`[...document.querySelectorAll("#sources article.source")].map((e) => e.dataset.state + ":" + e.querySelector("h3").textContent)`,
		);
		expect(sources).toEqual([
			"readable:Event log",
			"unopenable:Registry · bad.default",
			"readable:Registry · pi.default",
		]);
		expect(await count(page, "#timeline tr[data-seq]")).toBeGreaterThan(0);
		// Selecting the broken attachment is local (no request) and says plainly what it is.
		const requests = snapshotRequests(page);
		await page.eval(
			`(() => { const s = document.querySelector("#runtime select"); s.value = "bad.default"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		expect(await text(page, "#runtime")).toContain("could not be opened");
		expect(await text(page, "#runtime")).toContain("not an empty registry");
		expect(await text(page, "#capabilities")).toContain("not a runtime without capabilities");
		expect(snapshotRequests(page)).toBe(requests);
	});

	it("an attachment with a registry but no capability state says that, not that nothing is supported", async () => {
		const root = tempRoot();
		ingestAll(root, [event("tool.started")]);
		openEndoHarnessRegistryV0(root, "omp.default");
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "#capabilities")).toContain("This is not a statement that nothing is supported.");
		expect(await text(page, "#runtime")).toMatch(/none recorded/);
	});

	it("withheld and aliased values are marked, and the text policy's canaries reach no page text", async () => {
		const hostile = [CANARY, `/home/${CANARY}/notes`, `token=${CANARY}`, `ghp_${"A".repeat(36)}`];
		const root = tempRoot();
		ingestAll(root, [
			event("agent.prompt-accepted", { text: hostile[0], path: hostile[1] }, { producer: hostile[1] }),
			event("tool.started", { name: hostile[2], key: hostile[3] }, { id: `endo.event.Tok_${CANARY}` }),
		]);
		const { fingerprint, evidence, state } = specimen();
		const registry = openEndoHarnessRegistryV0(root, ATTACHMENT);
		registry.append("fingerprint", fingerprint);
		for (const record of evidence) registry.append("evidence", record);
		registry.append("state", {
			...state,
			capabilities: state.capabilities.map((c) => ({ ...c, reason: `see ${hostile[1]} ${hostile[3]}` })),
		});
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await count(page, "#timeline .withheld")).toBeGreaterThan(0); // the producer, a path
		await page.click("#timeline tr[data-seq='2'] button.seq");
		expect(await count(page, "#inspector .alias")).toBeGreaterThan(0); // the event id that would not be presented as written
		await page.click("#timeline tr[data-seq='1'] button.seq");
		const everything = await page.eval<string>("document.documentElement.outerHTML + document.body.innerText");
		for (const secret of [CANARY, "9f3a-leak", "ghp_"]) expect(everything.includes(secret), secret).toBe(false);
		await page.click("#capabilities button.caprow");
		expect(await text(page, "#inspector")).toContain("withheld");
	});
});

suite("reading, paging and refreshing", () => {
	function many(n: number): string {
		const root = tempRoot();
		ingestAll(
			root,
			Array.from({ length: n }, (_, i) => event(i % 3 === 0 ? "tool.started" : "agent.prompt-accepted")),
		);
		seedRegistry(root);
		return root;
	}

	it("pages the log in storage order, one read per page, with Latest from the watermark and no read for a disabled move", async () => {
		const root = many(230);
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`, 1440, 900);
		const positions = () =>
			page.eval<string[]>(
				`[...document.querySelectorAll("#timeline tr[data-seq] .seq")].map((e) => e.textContent.replace(/,/g, ""))`,
			);
		const range = () => text(page, "#timeline .window-line");
		const press = async (label: string, attempts: number) => {
			await page.eval(
				`[...document.querySelectorAll("#timeline .pager button")].find((b) => b.textContent === ${JSON.stringify(label)}).click()`,
			);
			await page.settled(attempts);
		};
		expect(await range()).toMatch(/positions 1–100 of 230 read · more follow/);
		expect((await positions()).length).toBe(100);
		expect(await page.eval(`document.querySelector("#timeline .pager").children[0].disabled`)).toBe(true); // First, already there
		await press("Next", 2);
		expect(await range()).toMatch(/positions 101–200 of 230/);
		await press("Next", 3);
		expect(await range()).toMatch(/positions 201–230 of 230 read · end of log/);
		expect((await positions()).at(-1)).toBe("230");
		expect(
			await page.eval(
				`[...document.querySelectorAll("#timeline .pager button")].find((b) => b.textContent === "Next").disabled`,
			),
		).toBe(true);
		await press("Previous", 4);
		expect(await range()).toMatch(/positions 101–200/);
		await press("First", 5);
		expect(await range()).toMatch(/positions 1–100/);
		await press("Latest", 6);
		expect(await range()).toMatch(/positions 131–230/);
		expect(snapshotRequests(page)).toBe(6);
		// The rows-per-page choice re-reads from the same place.
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "50"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(7);
		expect(await range()).toMatch(/positions 131–180 of 230/);
		expect(snapshotRequests(page)).toBe(7);
	});

	it("keeps the table's place when an event is selected, and starts a new window at the top", async () => {
		const server = await serve(many(230), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "200"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(2);
		await page.eval(`document.querySelector("#timeline .table-scroll").scrollTop = 900`);
		const before = await page.eval<number>(`document.querySelector("#timeline .table-scroll").scrollTop`);
		expect(before).toBeGreaterThan(500);
		await page.click("#timeline tr[data-seq='160'] button.seq");
		expect(await text(page, "#inspector")).toContain("Event at position 160");
		expect(await page.eval<number>(`document.querySelector("#timeline .table-scroll").scrollTop`)).toBe(before);
		// A refresh of the same window keeps its place too; a different window starts at the top.
		await page.click("#refresh");
		await page.settled(3);
		expect(await page.eval<number>(`document.querySelector("#timeline .table-scroll").scrollTop`)).toBe(before);
		await page.eval(
			`[...document.querySelectorAll("#timeline .pager button")].find((b) => b.textContent === "Next").click()`,
		);
		await page.settled(4);
		expect(await page.eval<number>(`document.querySelector("#timeline .table-scroll").scrollTop`)).toBe(0);
	});

	it("keeps keyboard focus on a control after it is used, and leaves a composing search box alone", async () => {
		const root = tempRoot();
		ingestAll(
			root,
			Array.from({ length: 12 }, (_, i) =>
				event(
					i % 2 ? "tool.started" : "agent.prompt-accepted",
					{},
					{ session: i < 6 ? "endo.session.one" : "endo.session.two" },
				),
			),
		);
		seedRegistry(root);
		openEndoHarnessRegistryV0(root, "omp.default");
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		const focused = () =>
			page.eval<string | null>("document.activeElement && document.activeElement.getAttribute('data-focus')");
		await page.eval(
			`(() => { const c = document.querySelector("#timeline .chips button"); c.focus(); c.click(); })()`,
		);
		expect(await focused()).toBe("category:agent");
		await page.eval(
			`(() => { const c = document.querySelector("#timeline .check input"); c.focus(); c.click(); })()`,
		);
		expect(await focused()).toBe("flagged");
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label^='Session']"); s.focus(); s.value = "endo.session.two"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		expect(await focused()).toBe("session");
		expect(await page.eval(`document.querySelector("#timeline select[aria-label^='Session']").value`)).toBe(
			"endo.session.two",
		);
		await page.eval(
			`(() => { const s = document.querySelector("#runtime select"); s.focus(); s.value = "omp.default"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		expect(await focused()).toBe("attachment");
		expect(await page.eval(`document.querySelector("#runtime select").value`)).toBe("omp.default");
		// A control that starts a read loses focus while it is disabled, and gets it back when the read ends.
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.focus(); s.value = "50"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(2);
		expect(await focused()).toBe("pagesize");
		await page.eval(`document.querySelector("#refresh").focus()`);
		await page.click("#refresh");
		await page.settled(3);
		expect(await focused()).toBe("refresh");
		await page.click("#timeline .btn.quiet"); // clear the filters the steps above set
		// An input method composing in the search box is not interrupted: the box stays the same element until the composition ends.
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); i.focus(); i.__mine = true; __set(i, "日"); i.dispatchEvent(new InputEvent("input", { isComposing: true, bubbles: true })); })()`,
		);
		expect(await page.eval(`document.querySelector("#timeline-search").__mine`)).toBe(true);
		expect(await count(page, "#timeline tr[data-seq]")).toBeGreaterThan(0); // not filtered yet
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); __set(i, "日本"); i.dispatchEvent(new CompositionEvent("compositionend", { data: "日本", bubbles: true })); })()`,
		);
		expect(await text(page, "#timeline")).toContain("No event in this window matches the filters.");
		expect(await page.eval(`document.activeElement.id`)).toBe("timeline-search");
		expect(await page.eval(`document.querySelector("#timeline-search").value`)).toBe("日本");
	});

	it("filters only the loaded window, says how many match, and never reads", async () => {
		const server = await serve(many(60), { ui });
		const page = await open(`${server.baseUrl}/`);
		const reads = snapshotRequests(page);
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); i.focus(); __set(i, "tool.started"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(20);
		expect(await text(page, "#timeline .window-line")).toMatch(/20 of 60 in this window match/);
		expect(await page.eval(`document.activeElement.id`)).toBe("timeline-search");
		await page.click("#timeline .chips button");
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); __set(i, "no-such-kind"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		expect(await text(page, "#timeline")).toContain("Other windows are not searched.");
		await page.click("#timeline .btn.quiet");
		expect(await count(page, "#timeline tr[data-seq]")).toBe(60);
		expect(snapshotRequests(page)).toBe(reads);
	});

	it("starts one read for a double click, shows the busy state, and refreshes on request", async () => {
		const server = await serve(many(20), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		expect(snapshotRequests(page)).toBe(1);
		await page.eval(`(() => { const b = document.querySelector("#refresh"); b.click(); b.click(); b.click(); })()`);
		await page.settled(2);
		expect(snapshotRequests(page)).toBe(2);
		// A key press refreshes too, but not while typing in a field.
		await page.eval(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "r" }))`);
		await page.settled(3);
		expect(snapshotRequests(page)).toBe(3);
		await page.eval(`document.querySelector("#timeline-search").focus()`);
		await page.eval(
			`document.querySelector("#timeline-search").dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }))`,
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(snapshotRequests(page)).toBe(3);
	});

	it("shows a 429 as the server pacing reads, keeps the last read marked not current, never retries, and comes back", async () => {
		const server = await serve(many(20), { ui, readBudget: { duty: 0.01, burstMs: 1 } });
		const page = await open(`${server.baseUrl}/`);
		expect(snapshotRequests(page)).toBe(1);
		const rowsBefore = await count(page, "#timeline tr[data-seq]");
		await page.click("#refresh");
		await page.settled(2);
		expect(await page.eval("document.body.dataset.state")).toBe("error");
		const banner = await text(page, "#banner");
		expect(banner).toMatch(/pacing reads/);
		expect(banner).toMatch(/is still shown and is not current/);
		expect(await text(page, "#read-status")).toMatch(/not current/);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(rowsBefore); // the previous read stays on screen
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(true);
		expect(snapshotRequests(page)).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(snapshotRequests(page)).toBe(2); // no automatic retry
		// One timeout re-enables it, at the time the server named (read from the banner, not guessed: the figure grows with a slower read).
		const asked = Number(/asked for (\d+) s/.exec(banner)![1]);
		await page.waitFor("document.querySelector('#refresh').disabled === false", (asked + 3) * 1000);
		await page.click("#refresh");
		await page.settled(3);
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(await text(page, "#banner")).toBe("");
	}, 60_000);

	it("says so when the server has stopped, keeping what it last read", async () => {
		const server = await serve(many(10), { ui });
		const page = await open(`${server.baseUrl}/`);
		await server.close();
		await page.click("#refresh");
		await page.settled(2);
		expect(await text(page, "#banner")).toMatch(/did not answer/);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(10);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(false);
	});
});

suite("inspecting", () => {
	it("opens an event or a capability in the inspector with its provenance, and keeps the selection across a refresh", async () => {
		const server = await serve(populated(), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "#inspector")).toContain("Evidence and provenance");
		await page.click("#timeline tr[data-seq='5'] button.seq");
		const event = await text(page, "#inspector");
		expect(event).toContain("Event at position 5");
		expect(event).toMatch(/producer sequence\s*\d+ \(within this producer only\)/);
		expect(event).toMatch(/producer clock\s*20\d\d-/);
		expect(event).toContain("Position is the order.");
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='5']").getAttribute("aria-selected")`),
		).toBe("true");
		await page.click("#refresh");
		await page.settled(2);
		expect(await text(page, "#inspector")).toContain("Event at position 5");
		await page.click("#capabilities button.caprow[data-key='session.overview']");
		const capability = await text(page, "#inspector");
		expect(capability).toContain("session.overview");
		expect(capability).toMatch(/recorded status\s*admitted, partial/);
		expect(capability).toContain("Evidence");
		expect(capability).toContain("Limits on this status");
		expect(
			await page.eval(
				`document.querySelector("button.caprow[data-key='session.overview']").getAttribute("aria-pressed")`,
			),
		).toBe("true");
	});
});

// A stand-in for the cockpit server that answers the snapshot request with whatever a test says, to prove the page handles replies
// the real server never sends (it serves the real built page, so the page under test is the real one).
suite("replies the page must not trust", () => {
	let fake: Server | null = null;
	const stopFake = async () => {
		const server = fake;
		fake = null;
		if (server === null) return;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};
	afterEach(stopFake);
	async function pretend(respond: (res: import("node:http").ServerResponse) => void): Promise<string> {
		fake = createServer((request, res) => {
			const url = request.url ?? "/";
			if (url.startsWith("/api/v0/snapshot")) return respond(res);
			const name = url === "/" ? "index.html" : url.replace(/^\/assets\//, "");
			const body = ui[name];
			if (body === undefined) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, {
				"Content-Type": name.endsWith(".js")
					? "text/javascript"
					: name.endsWith(".css")
						? "text/css"
						: name.endsWith(".svg")
							? "image/svg+xml"
							: name.endsWith(".woff2")
								? "font/woff2"
								: "text/html",
			}).end(body);
		});
		await new Promise<void>((resolve) => fake!.listen(0, "127.0.0.1", resolve));
		return `http://127.0.0.1:${(fake!.address() as { port: number }).port}/`;
	}
	const json = (
		res: import("node:http").ServerResponse,
		status: number,
		body: string,
		type = "application/json; charset=utf-8",
	) => res.writeHead(status, { "Content-Type": type }).end(body);

	it("a server error, a refusal, a body that is not JSON and a body of the wrong shape each get a plain sentence and no data", async () => {
		const cases: [string, (res: import("node:http").ServerResponse) => void, RegExp][] = [
			["500", (res) => json(res, 500, '{"error":"internal-error"}'), /internal error \(status 500\)/],
			["404", (res) => json(res, 404, '{"error":"not-found"}'), /does not recognize this address/],
			[
				"421",
				(res) => json(res, 421, '{"error":"misdirected-request"}'),
				/refused the request \(status 421, misdirected-request\)/,
			],
			[
				"not JSON",
				(res) => json(res, 200, "<html>hello</html>", "text/html"),
				/did not have the shape this page reads \(the response is not JSON\)/,
			],
			["broken JSON", (res) => json(res, 200, '{"schemaVersion":'), /not valid JSON/],
			[
				"wrong shape",
				(res) =>
					json(
						res,
						200,
						'{"schemaVersion":"endo.cockpit-snapshot.v0","projectionVersion":"cockpit-snapshot.3","consistency":"independent-sources","timeline":{}}',
					),
				/did not have the shape/,
			],
		];
		for (const [name, respond, expected] of cases) {
			const url = await pretend(respond);
			const page = await open(url);
			expect(await text(page, "#banner"), name).toMatch(expected);
			expect(await page.eval("document.body.dataset.state"), name).toBe("error");
			expect(await count(page, "#timeline tr[data-seq]"), name).toBe(0);
			expect(await text(page, "[data-testid='observe-unread']"), name).toContain(
				"No read has succeeded, so nothing is shown",
			);
			await stopFake();
		}
	});

	it("an unknown projection version is named as text and nothing from it is shown", async () => {
		const hostile = "cockpit-snapshot.9<img src=x onerror=1>";
		const url = await pretend((res) =>
			json(res, 200, JSON.stringify({ schemaVersion: "endo.cockpit-snapshot.v0", projectionVersion: hostile })),
		);
		const page = await open(url);
		const banner = await text(page, "#banner");
		expect(banner).toContain(
			"its snapshot declares the projection version “cockpit-snapshot.9<img src=x onerror=1>”, and this build reads “cockpit-snapshot.3” there",
		);
		expect(await count(page, "#banner img")).toBe(0);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(0);
		expect(page.seen.problems).toEqual([]);
	});

	it("an unknown version in a nested record names that record and the version this build reads for it", async () => {
		const snapshot = JSON.parse(JSON.stringify(realSnapshot()));
		snapshot.timeline.projectionVersion = "cockpit-session-timeline.9";
		const url = await pretend((res) => json(res, 200, JSON.stringify(snapshot)));
		const banner = await text(await open(url), "#banner");
		expect(banner).toContain(
			"its timeline declares the projection version “cockpit-session-timeline.9”, and this build reads “cockpit-session-timeline.3” there",
		);
		expect(banner).not.toContain("cockpit-snapshot.3");
	});

	/** A real snapshot, as JSON, for a stand-in server to hand out. */
	const realSnapshot = () => {
		const root = populated();
		return readEndoCockpitSnapshotV0(root, { digestKey: OTHER_KEY, limit: 100 });
	};

	it("locks the rows-per-page choice, with Refresh, while a read is in flight and while the server asks for a pause", async () => {
		const body = JSON.stringify(realSnapshot());
		let reads = 0;
		const url = await pretend((res) => {
			reads += 1;
			if (reads === 1) return json(res, 200, body);
			if (reads === 2) return void setTimeout(() => json(res, 200, body), 700);
			if (reads === 3)
				return void res
					.writeHead(429, { "Content-Type": "application/json", "Retry-After": "2" })
					.end('{"error":"too-many-requests"}');
			return json(res, 200, body);
		});
		const page = await open(url);
		const locked = () =>
			page.eval<[boolean, boolean]>(
				`[document.querySelector("#timeline select[aria-label='Rows per page']").disabled, document.querySelector("#refresh").disabled]`,
			);
		expect(await locked()).toEqual([false, false]);
		await page.click("#refresh"); // the second read, delayed
		expect(await locked()).toEqual([true, true]);
		await page.settled(2);
		expect(await locked()).toEqual([false, false]);
		await page.click("#refresh"); // the third read, answered 429 with Retry-After: 2
		await page.settled(3);
		expect(await locked()).toEqual([true, true]);
		// A choice made while locked is not taken and not silently half-applied: the selector still says what the page shows.
		expect(await page.eval(`document.querySelector("#timeline select[aria-label='Rows per page']").value`)).toBe(
			"100",
		);
		await page.waitFor("document.querySelector('#refresh').disabled === false", 8000);
		expect(await locked()).toEqual([false, false]);
		expect(reads).toBe(3);
	});

	it("a failed read of another page size leaves the page asking for the window it has", async () => {
		const body = JSON.stringify(realSnapshot());
		let reads = 0;
		const url = await pretend((res) => {
			reads += 1;
			if (reads === 2) return json(res, 500, '{"error":"internal-error"}');
			return json(res, 200, body);
		});
		const page = await open(url);
		const size = () => page.eval(`document.querySelector("#timeline select[aria-label='Rows per page']").value`);
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "50"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(2);
		expect(await text(page, "#banner")).toMatch(/internal error/);
		expect(await size()).toBe("100"); // the page still shows 100 rows, and says so
		await page.click("#refresh");
		await page.settled(3);
		expect(
			page.seen.requests.filter((u) => u.includes("/api/v0/snapshot")).map((u) => /limit=(\d+)/.exec(u)![1]),
		).toEqual(["100", "50", "100"]);
		expect(await size()).toBe("100");
		expect(await text(page, "#banner")).toBe("");
	});

	it("a 200 the classifier passes but the panels cannot draw keeps the last good read, marked not current", async () => {
		const good = realSnapshot();
		const broken = JSON.parse(JSON.stringify(good));
		const reported = broken.timeline.entries.find((e: { usage: unknown }) => e.usage !== null);
		reported.usage = { basis: "reported", value: null };
		let reads = 0;
		const url = await pretend((res) => json(res, 200, JSON.stringify(++reads === 1 ? good : broken)));
		const page = await open(url);
		const rows = await count(page, "#timeline tr[data-seq]");
		expect(rows).toBeGreaterThan(0);
		await page.click("#refresh");
		await page.settled(2);
		expect(await page.eval("document.body.dataset.state")).toBe("error");
		expect(await text(page, "#banner")).toMatch(/could not be displayed.*is still shown and is not current/);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(rows);
		expect(await text(page, "#timeline")).not.toContain("could not be displayed.");
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(false);
	});

	it("a 200 whose nested lists hold the wrong things is refused as malformed, with the page left usable", async () => {
		const snapshot = realSnapshot();
		const bad = [
			{ ...snapshot, timeline: { ...snapshot.timeline, sessions: [null] } },
			{ ...snapshot, timeline: { ...snapshot.timeline, notes: [3] } },
			{
				...snapshot,
				runtimes: [
					{
						...snapshot.runtimes[0],
						capabilities: {
							...snapshot.runtimes[0]!.capabilities,
							capabilities: [{ capability: "x", limits: [null] }],
						},
					},
				],
			},
		];
		for (const [index, snap] of bad.entries()) {
			const url = await pretend((res) => json(res, 200, JSON.stringify(snap)));
			const page = await open(url);
			expect(await text(page, "#banner"), `case ${index}`).toMatch(/did not have the shape this page reads/);
			expect(await page.eval("document.body.dataset.state")).toBe("error");
			expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(false); // never stuck loading
			expect(await count(page, "#timeline tr[data-seq]")).toBe(0);
			await stopFake();
		}
	});

	/** A real snapshot with something one view of it cannot draw, for the checks that a view the operator could open later is tried now. */
	const copy = () => JSON.parse(JSON.stringify(realSnapshot()));

	it("refuses at once a snapshot holding a view the operator could only open later: an event's fields, a capability's evidence, another attachment", async () => {
		const withField = copy();
		withField.timeline.entries[0].fields = { x: null };
		const withEvidence = copy();
		const capabilities = withEvidence.runtimes[0].capabilities.capabilities;
		expect(capabilities.length).toBeGreaterThan(0);
		capabilities[0].evidence = {};
		const withSecond = copy();
		const current = withSecond.runtimes[0].identity.current;
		expect(current).not.toBeNull();
		const second = JSON.parse(JSON.stringify(withSecond.runtimes[0]));
		second.identity.source.attachment = "other.attachment";
		second.identity.current.version = null;
		withSecond.runtimes.push(second);
		for (const [name, snapshot] of [
			["fields", withField],
			["evidence", withEvidence],
			["a second attachment", withSecond],
		] as const) {
			const url = await pretend((res) => json(res, 200, JSON.stringify(snapshot)));
			const page = await open(url);
			expect(await text(page, "#banner"), name).toMatch(/could not be displayed/);
			expect(await page.eval("document.body.dataset.state"), name).toBe("error");
			expect(await count(page, "#timeline tr[data-seq]"), name).toBe(0);
			expect(await page.eval("document.querySelector('#refresh').disabled"), name).toBe(false);
			expect(page.seen.problems, name).toEqual([]);
			await stopFake();
		}
	});

	it("a value a record should hold and does not is a refused read, never a blank or the word undefined", async () => {
		const noObservedAt = copy();
		delete noObservedAt.runtimes[0].identity.current.observedAt;
		const noProducerSequence = copy();
		delete noProducerSequence.timeline.entries[0].producerSequence;
		const noReason = copy();
		delete noReason.runtimes[0].capabilities.capabilities[0].reason;
		for (const [name, snapshot] of [
			["identity.current.observedAt", noObservedAt],
			["an event's producerSequence", noProducerSequence],
			["a capability's reason", noReason],
		] as const) {
			const url = await pretend((res) => json(res, 200, JSON.stringify(snapshot)));
			const page = await open(url);
			expect(await text(page, "#banner"), name).toMatch(/could not be displayed/);
			expect(await page.eval("document.body.dataset.state"), name).toBe("error");
			expect(await count(page, "#timeline tr[data-seq]"), name).toBe(0);
			expect(await page.eval("document.body.innerText.includes('undefined')"), name).toBe(false);
			await stopFake();
		}
	});

	it("labels a capability row's classification as the state's own, not the evidence's", async () => {
		const url = await pretend((res) => json(res, 200, JSON.stringify(copy())));
		const page = await open(url);
		const titles = await page.eval<string[]>(
			`[...document.querySelectorAll("#capabilities .cap-class")].map((el) => el.title)`,
		);
		expect(titles.length).toBeGreaterThan(0);
		for (const title of titles) {
			expect(title).toMatch(/classification this capability state records/);
			expect(title).not.toMatch(/of the cited evidence/);
		}
	});

	it("refuses a snapshot whose unreadable row the current filter happens to hide, because clearing the filter would draw it", async () => {
		const good = copy();
		const entries = good.timeline.entries as { kind: string; producer: string; eventId: string; usage: unknown }[];
		const needleEntry = entries.find((e) => e.usage === null);
		expect(needleEntry).toBeDefined();
		const needle = needleEntry!.kind.toLowerCase();
		const hides = (e: { kind: string; producer: string; eventId: string }) =>
			![e.kind, e.producer, e.eventId].some((value) => value.toLowerCase().includes(needle));
		const hidden = JSON.parse(JSON.stringify(good));
		const victim = (hidden.timeline.entries as typeof entries).find((e) => e.usage !== null && hides(e));
		expect(victim).toBeDefined();
		victim!.usage = { basis: "reported", value: null };
		let reads = 0;
		const url = await pretend((res) => json(res, 200, JSON.stringify(++reads === 1 ? good : hidden)));
		const page = await open(url);
		const rows = await count(page, "#timeline tr[data-seq]");
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); __set(i, ${JSON.stringify(needle)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		const filtered = await count(page, "#timeline tr[data-seq]");
		expect(filtered).toBeGreaterThan(0);
		expect(filtered).toBeLessThan(rows);
		await page.click("#refresh");
		await page.settled(2);
		expect(await page.eval("document.body.dataset.state")).toBe("error");
		expect(await text(page, "#banner")).toMatch(/could not be displayed.*is still shown and is not current/);
		await page.click("#timeline .btn.quiet"); // clear the filter: the last good read draws in full
		expect(await count(page, "#timeline tr[data-seq]")).toBe(rows);
		expect(await text(page, "#timeline")).not.toContain("could not be displayed.");
	});

	it("lifts a pause by the monotonic clock: a wall clock set back during the wait does not keep the controls locked", async () => {
		const body = JSON.stringify(realSnapshot());
		let reads = 0;
		const url = await pretend((res) => {
			reads += 1;
			if (reads === 2)
				return void res
					.writeHead(429, { "Content-Type": "application/json", "Retry-After": "2" })
					.end('{"error":"too-many-requests"}');
			return json(res, 200, body);
		});
		const page = await open(url);
		await page.click("#refresh"); // the second read, answered 429 with Retry-After: 2
		await page.settled(2);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(true);
		// The clock is set back an hour while the wait runs: by the wall clock the wait would end an hour from now.
		await page.eval(`(() => { const real = Date.now.bind(Date); Date.now = () => real() - 3600000; })()`);
		await page.waitFor("document.querySelector('#refresh').disabled === false", 8000);
		await page.click("#refresh");
		await page.settled(3);
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(reads).toBe(3);
	}, 30_000);

	it("a 429 with no Retry-After is shown as pacing without inventing a time, and the controls stay usable", async () => {
		const url = await pretend((res) => json(res, 429, '{"error":"too-many-requests"}'));
		const page = await open(url);
		expect(await text(page, "#banner")).toMatch(/gave no time/);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(false);
	});

	// A note's references are the records it was drawn from. Each panel shows them beside the note, as the model describes them, in
	// the order given; a note without any shows no empty brackets.
	function withNotes(registryState: "recorded" | "none"): string {
		const snapshot = JSON.parse(JSON.stringify(realSnapshot())) as ReturnType<typeof realSnapshot>;
		const runtime = snapshot.runtimes[0]!;
		const attachment = runtime.identity.source.attachment;
		const eventRef = (n: number) => ({ domain: "event-log", storageSequence: n, eventId: `endo.event.test.${n}` });
		const registryRef = (kind: string, index: number) => ({
			domain: "harness-registry",
			attachment,
			kind,
			index,
			id: null,
		});
		const notes = (label: string) => [
			{
				code: `${label}.many`,
				refs: [eventRef(9), eventRef(2), registryRef("state", 0), registryRef("fingerprint", 3)],
			},
			{ code: `${label}.none`, refs: [] },
			{ code: `${label}.one`, refs: [eventRef(5)] },
		];
		snapshot.timeline.notes = notes("timeline") as never;
		runtime.identity.notes = notes("runtime") as never;
		runtime.capabilities.notes = notes("capability") as never;
		if (registryState === "none") runtime.capabilities.state = null as never;
		return JSON.stringify(snapshot);
	}
	const shownNotes = (page: Page, panel: string) =>
		page.eval<string[]>(`[...document.querySelectorAll("${panel} .notes li")].map((li) => li.textContent)`);
	const expectedNotes = (label: string, attachment = "omp.default") => [
		`${label}.many (event log \u00b7 position 9; event log \u00b7 position 2; registry ${attachment} \u00b7 state #1; registry ${attachment} \u00b7 fingerprint #4)`,
		`${label}.none`,
		`${label}.one (event log \u00b7 position 5)`,
	];

	it("shows the records a capability, timeline or runtime note was drawn from beside it, in order, and nothing for a note with none", async () => {
		const body = withNotes("recorded");
		const attachment = (JSON.parse(body) as ReturnType<typeof realSnapshot>).runtimes[0]!.identity.source.attachment;
		const page = await open(await pretend((res) => json(res, 200, body)));
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(await shownNotes(page, "#capabilities")).toEqual(expectedNotes("capability", attachment));
		expect(await shownNotes(page, "#sources")).toEqual(expectedNotes("timeline", attachment));
		expect(await shownNotes(page, "#runtime")).toEqual(expectedNotes("runtime", attachment));
	});

	it("shows them as well beside the notes of a registry that records no capability state", async () => {
		const body = withNotes("none");
		const attachment = (JSON.parse(body) as ReturnType<typeof realSnapshot>).runtimes[0]!.identity.source.attachment;
		const page = await open(await pretend((res) => json(res, 200, body)));
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(await text(page, "#capabilities")).toContain("This is not a statement that nothing is supported.");
		expect(await shownNotes(page, "#capabilities")).toEqual(expectedNotes("capability", attachment));
	});

	// A capability the operator opened belongs to the registry they opened it in. When a refresh removes that registry the page falls
	// back to another, which the operator did not choose: the selection is dropped, though that registry has a capability of the same name.
	it("drops an open capability when a refresh removes its registry, rather than showing a same-named one from another", async () => {
		const first = JSON.parse(JSON.stringify(realSnapshot())) as ReturnType<typeof realSnapshot>;
		const second = JSON.parse(JSON.stringify(first)) as ReturnType<typeof realSnapshot>;
		const clone = JSON.parse(JSON.stringify(first.runtimes[0])) as (typeof first.runtimes)[number];
		clone.identity.source.attachment = "zz.other";
		clone.capabilities.source.attachment = "zz.other";
		first.runtimes.push(clone); // the first read lists two registries with the same capability names; the second lists only the first
		const bodies = [JSON.stringify(first), JSON.stringify(second)];
		let reads = 0;
		const page = await open(await pretend((res) => json(res, 200, bodies[Math.min(reads++, 1)]!)));
		await page.eval(
			`(() => { const s = document.querySelector("#runtime select"); s.value = "zz.other"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.click("#capabilities button.caprow[data-key='session.overview']");
		expect(await text(page, "#inspector")).toMatch(/recorded status/); // open, so the check below is not vacuous
		await page.click("#refresh");
		await page.settled(2);
		expect(await text(page, "#runtime")).toContain(second.runtimes[0]!.identity.source.attachment); // fell back to the one left
		expect(
			await page.eval(
				`document.querySelector("button.caprow[data-key='session.overview']").getAttribute("aria-pressed")`,
			),
		).toBe("false");
		expect(await text(page, "#inspector")).not.toMatch(/recorded status/);
	});

	// A generated alias is a stand-in and must never read as a recorded id, wherever the page shows one: in text, on a card, in a list.
	it("marks a generated alias wherever it is shown, and keeps the whole value on hover", async () => {
		const snapshot = JSON.parse(JSON.stringify(realSnapshot())) as ReturnType<typeof realSnapshot>;
		const token = (n: number) => `withheld-${n.toString(16).padStart(32, "0")}`;
		snapshot.timeline.source.watermark!.lastEventId = `endo.event.${token(1)}`;
		snapshot.timeline.sessions = [
			{ ...snapshot.timeline.sessions[0]!, sessionId: `endo.session.${token(2)}` },
			{ ...snapshot.timeline.sessions[0]!, sessionId: "endo.session.plain" },
		];
		snapshot.timeline.entries[0]!.eventId = `endo.event.${token(3)}`;
		const page = await open(await pretend((res) => json(res, 200, JSON.stringify(snapshot))));
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		// Every text that carries an alias sits in an alias mark, or is an option that begins with the word alias.
		const unmarked = await page.eval<string[]>(`(() => {
			const found = [];
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				if (!n.textContent.includes("withheld-")) continue;
				const parent = n.parentElement;
				if (parent.closest(".alias")) continue;
				if (parent.tagName === "OPTION" && n.textContent.startsWith("alias ")) continue;
				found.push(n.textContent);
			}
			return found;
		})()`);
		expect(unmarked).toEqual([]);
		expect(
			await page.eval(
				`[...document.querySelectorAll("#timeline select[aria-label^='Session'] option")].map((o) => o.textContent)`,
			),
		).toEqual([
			"all sessions in this window",
			"alias withheld-00000000\u2026 · 1–25 · 25 here",
			"endo.session.plain · 1–25 · 25 here",
		]);
		// The card shows the alias as one, with the whole value on hover.
		expect(
			await page.eval(`[...document.querySelectorAll("#sources .alias")].map((e) => e.title.split("\\n")[0])`),
		).toContain(`endo.event.${token(1)}`);
	});

	// A control that starts a read loses focus while a pause holds it disabled. The page remembers which control it was and puts focus
	// back when the one timeout lifts the pause, unless the operator has moved on by then.
	const pausedOnce =
		(reads: { n: number }, body: string, pausedRead = 2) =>
		(res: import("node:http").ServerResponse) => {
			reads.n += 1;
			if (reads.n === pausedRead)
				return void res
					.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" })
					.end('{"error":"too-many-requests"}');
			return json(res, 200, body);
		};
	const focusedName = (page: Page) =>
		page.eval<string | null>("document.activeElement && document.activeElement.getAttribute('data-focus')");

	it("puts keyboard focus back on the control that started a read the server paced, once the pause ends and it is enabled", async () => {
		const reads = { n: 0 };
		const page = await open(await pretend(pausedOnce(reads, JSON.stringify(realSnapshot()))));
		// The rows-per-page choice: it is drawn again with each render, so focus is lost while it is disabled.
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.focus(); s.value = "50"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(2);
		expect(reads.n).toBe(2); // the paced read
		expect(await page.eval("document.body.dataset.state")).toBe("error");
		await page.waitFor(
			"document.querySelector(\"#timeline select[aria-label='Rows per page']\").disabled === false",
			8000,
		);
		await page.waitFor(
			"document.activeElement && document.activeElement.getAttribute('data-focus') === 'pagesize'",
			2000,
		);
		expect(await focusedName(page)).toBe("pagesize");
		expect(await page.eval(`document.querySelector("#timeline select[aria-label='Rows per page']").value`)).toBe(
			"100",
		); // still the window it has
		expect(reads.n).toBe(2); // restoring focus is not a read
	}, 30_000);

	it("does the same for Refresh", async () => {
		const reads = { n: 0 };
		const page = await open(await pretend(pausedOnce(reads, JSON.stringify(realSnapshot()))));
		await page.eval(`document.querySelector("#refresh").focus()`);
		await page.click("#refresh");
		await page.settled(2);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(true);
		await page.waitFor("document.querySelector('#refresh').disabled === false", 8000);
		await page.waitFor("document.activeElement && document.activeElement.id === 'refresh'", 2000);
		expect(await focusedName(page)).toBe("refresh");
	}, 30_000);

	it("leaves focus where the operator put it during the pause", async () => {
		const reads = { n: 0 };
		const page = await open(await pretend(pausedOnce(reads, JSON.stringify(realSnapshot()))));
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.focus(); s.value = "50"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
		);
		await page.settled(2);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(true);
		await page.eval(`document.querySelector("#timeline-search").focus()`); // the search box is not locked by the pause
		await page.waitFor("document.querySelector('#refresh').disabled === false", 8000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await page.eval("document.activeElement && document.activeElement.id")).toBe("timeline-search");
	}, 30_000);

	it("does not take focus back for a control it could not have: nothing was focused, so nothing is moved", async () => {
		const reads = { n: 0 };
		const page = await open(await pretend(pausedOnce(reads, JSON.stringify(realSnapshot()))));
		await page.eval(`document.activeElement.blur()`);
		await page.click("#refresh"); // a script click: no control holds focus
		await page.settled(2);
		await page.waitFor("document.querySelector('#refresh').disabled === false", 8000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await page.eval("document.activeElement === document.body")).toBe(true);
	}, 30_000);
});

suite("the whole path", () => {
	it("serves the page from the capability URL only, and the same page works under the other loopback name", async () => {
		const root = populated();
		const server = await serve(root, { ui });
		const asLocalhost = server.baseUrl.replace("127.0.0.1", "localhost");
		const page = await open(`${asLocalhost}/`);
		expect(await page.eval("document.body.dataset.state")).toBe("ready");
		expect(await count(page, "#timeline tr[data-seq]")).toBeGreaterThan(0);
		const wrong = await visit(`${server.origin}/${"x".repeat(43)}/`);
		expect(await count(wrong, "#timeline")).toBe(0);
		expect(await wrong.eval("document.body.innerText")).toContain('{"error":"not-found"}');
		expect((await get(server, "/")).status).toBe(200);
	});
});

suite("the narrow inspector, the keyboard, the overview, and the workspaces not built yet", () => {
	const tornTail = () => {
		const root = populated();
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		return root;
	};
	const focusedSeq = (page: Page) =>
		page.eval<string | null>(
			`document.activeElement && document.activeElement.closest("tr") && document.activeElement.closest("tr").dataset.seq`,
		);

	it("at a narrow width the inspector is a modal dialog that keeps the degraded source in view, closes on Escape and gives focus back", async () => {
		const server = await serve(tornTail(), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`, 420, 900);
		// Before anything is open, the warning is in the shell and the page says how to read the marks without a second legend.
		expect(await count(page, "[data-testid=attention] .attention-item")).toBe(1);
		expect(await text(page, "[data-testid=attention]")).toMatch(/degraded/);
		expect(await page.eval(`document.querySelector("dialog#inspector").open`)).toBe(false);
		expect(await count(page, "[data-testid=legend]")).toBe(1); // the one in the fold, not also in the closed dialog
		// Open an event from its own button, focused, as a keyboard user would have it.
		await page.eval(`document.querySelector("#timeline tr[data-seq='5'] button.seq").focus()`);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		expect(await page.eval(`document.querySelector("dialog#inspector").open`)).toBe(true);
		expect(await text(page, "dialog#inspector")).toContain("Event at position 5");
		// The page behind is inert, so the warning is repeated inside the dialog.
		const warned = await text(page, "dialog#inspector [data-testid=dialog-attention]");
		expect(warned).toMatch(/degraded/);
		expect(warned).toMatch(/Torn tail left in place: 21 bytes/);
		expect(await count(page, "[data-testid=legend]")).toBe(0);
		// A shortcut does not reach through the dialog to the page behind it.
		const reads = snapshotRequests(page);
		await page.press("r");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(snapshotRequests(page)).toBe(reads);
		// Escape closes it, clears the one selection, and focus is back on the row it came from.
		await page.press("Escape");
		await page.waitFor(`document.querySelector("dialog#inspector").open === false`, 3000);
		expect(await page.eval(`document.querySelectorAll("#timeline tr.selected").length`)).toBe(0);
		expect(await focusedSeq(page)).toBe("5");
		expect(await page.eval(`document.activeElement.className`)).toBe("seq");
		expect(page.seen.problems).toEqual([]);
	});

	it("at a narrow width a capability opens in the dialog too, and its close button works", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`, 420, 900);
		await page.eval(`document.querySelector("#capabilities button.caprow").focus()`);
		await page.click("#capabilities button.caprow");
		expect(await text(page, "dialog#inspector")).toContain("Limits on this status");
		await page.click("dialog#inspector button[data-focus=inspector-close]");
		await page.waitFor(`document.querySelector("dialog#inspector").open === false`, 3000);
		expect(await page.eval(`document.activeElement.classList.contains("caprow")`)).toBe(true);
	});

	it("the wide inspector is a panel, not a dialog, and there is one legend", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await count(page, "dialog")).toBe(0);
		expect(await count(page, "[data-testid=legend]")).toBe(1);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		expect(await count(page, "[data-testid=legend]")).toBe(0);
		expect(await count(page, "[data-testid=event-detail]")).toBe(1);
	});

	it("can be walked and opened with the keyboard alone: arrows move between rows, Enter opens one, r reads again", async () => {
		const server = await serve(populated(), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		await page.eval(`document.querySelector("#timeline tr[data-seq='1'] button.seq").focus()`);
		await page.press("ArrowDown");
		await page.press("ArrowDown");
		expect(await focusedSeq(page)).toBe("3");
		await page.press("ArrowUp");
		expect(await focusedSeq(page)).toBe("2");
		await page.press("Enter");
		expect(await text(page, "#inspector")).toContain("Event at position 2");
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='2']").getAttribute("aria-selected")`),
		).toBe("true");
		const reads = snapshotRequests(page);
		await page.eval(`document.activeElement.blur()`);
		await page.press("r");
		await page.settled(2);
		expect(snapshotRequests(page)).toBe(reads + 1);
		// The selection survives the refresh because the same record is still in the window.
		expect(await text(page, "#inspector")).toContain("Event at position 2");
	});

	it("keeps the overview and the table in step, and a hover reads nothing", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		const reads = snapshotRequests(page);
		// A mark opens its event, and the table row and the mark agree on which one is selected.
		await page.eval(
			`document.querySelector("#overview g[data-seq='7']").dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
		);
		expect(await text(page, "#inspector")).toContain("Event at position 7");
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='7']").getAttribute("aria-selected")`),
		).toBe("true");
		expect(await count(page, "#overview .omark-wrap.selected")).toBe(1);
		// And the other way: a row moves the mark.
		await page.click("#timeline tr[data-seq='9'] button.seq");
		expect(await page.eval(`document.querySelector("#overview .omark-wrap.selected").dataset.seq`)).toBe("9");
		// A hover marks both the mark and the row, and fetches nothing.
		await page.hover("#overview g[data-seq='3']");
		await page.waitFor(`document.querySelector("#overview .omark-wrap.hovered")`, 2000);
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='3']").classList.contains("hovered")`),
		).toBe(true);
		await page.hover("#timeline tr[data-seq='4']");
		await page.waitFor(`document.querySelector("#overview .omark-wrap.hovered").dataset.seq === "4"`, 2000);
		expect(snapshotRequests(page)).toBe(reads);
		// A filter dims what it hides on the overview and does not remove it.
		await page.click("#timeline .chips button");
		expect(await count(page, "#overview .omark-wrap")).toBe(25);
		expect(await count(page, "#overview .omark-wrap.dim")).toBeGreaterThan(0);
	});

	it("says what the overview covers: the whole log, one window of it, or the readable prefix of a degraded one", async () => {
		const many = tempRoot();
		ingestAll(
			many,
			Array.from({ length: 230 }, (_, i) => event(i % 3 === 0 ? "tool.started" : "agent.prompt-accepted")),
		);
		const server = await serve(many, { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		expect(await text(page, "[data-testid=overview-coverage]")).toMatch(
			/positions 1–100 only of 230 read\. The rest of the log is not drawn\./,
		);
		await page.eval(
			`[...document.querySelectorAll("#timeline .pager button")].find((b) => b.textContent === "Next").click()`,
		);
		await page.settled(2);
		expect(await text(page, "[data-testid=overview-coverage]")).toMatch(/positions 101–200 only of 230/);
		const whole = await serve(populated(), { ui });
		const wholePage = await open(`${whole.baseUrl}/`);
		expect(await text(wholePage, "[data-testid=overview-coverage]")).toBe(
			"This overview covers the whole log as read.",
		);
		const torn = await serve(tornTail(), { ui });
		const tornPage = await open(`${torn.baseUrl}/`);
		const coverage = await text(tornPage, "[data-testid=overview-coverage]");
		expect(coverage).toMatch(/whole readable prefix/);
		expect(coverage).toMatch(/degraded/);
		expect(coverage).not.toMatch(/whole log as read/);
	});

	it("sizes the overview to its host when the log appears after the first read found none (the host was not there to follow)", async () => {
		const root = tempRoot();
		const server = await serve(root, { ui });
		const page = await open(`${server.baseUrl}/`, 420, 900);
		expect(await count(page, "#overview svg")).toBe(0);
		ingestAll(root, lifecycleEvents("completes"));
		await page.click("#refresh");
		await page.settled(2);
		await page.waitFor(`document.querySelector("#overview svg")`, 5000);
		await new Promise((resolve) => setTimeout(resolve, 500)); // the observer reports after layout
		const [svg, host] = await page.eval<number[]>(
			`[document.querySelector("#overview svg.overview-svg").getBoundingClientRect().width, document.querySelector(".overview-host").clientWidth]`,
		);
		expect(svg).toBeLessThanOrEqual(host! + 1);
		expect(await page.eval("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
	});

	it("an absent store draws no lanes: it says there is nothing to draw, and why", async () => {
		const server = await serve(tempRoot(), { ui });
		const page = await open(`${server.baseUrl}/`);
		expect(await count(page, "#overview svg")).toBe(0);
		expect(await text(page, "[data-testid=overview-coverage]")).toMatch(
			/No event log exists under this store root, so there is nothing to draw/,
		);
		expect(await text(page, "[data-testid=attention]")).toMatch(/absent/);
	});

	it("names the workspaces that are not built, loads them on demand, shows no record in them, and keeps Observe as it was", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		const reads = snapshotRequests(page);
		for (const name of ["compare", "capabilities", "evolve"]) {
			await page.click(`button[data-workspace=${name}]`);
			await page.waitFor(`document.querySelector("[data-testid=unavailable-${name}]")`, 5000);
			const said = await text(page, `[data-testid=unavailable-${name}]`);
			expect(said).toMatch(/is not available yet/);
			expect(said).toMatch(/This workspace shows nothing read from a store/);
			expect(await count(page, "tr[data-seq]")).toBe(0);
			expect(
				await page.eval(`document.querySelector("button[data-workspace=${name}]").getAttribute("aria-current")`),
			).toBe("page");
		}
		expect(page.seen.requests.some((url) => /\/assets\/Unavailable-[A-Za-z0-9]+\.js$/.test(url))).toBe(true);
		await page.click("button[data-workspace=observe]");
		// The read, the selection and the window are where they were: switching workspace reads nothing.
		expect(await text(page, "#inspector")).toContain("Event at position 5");
		expect(snapshotRequests(page)).toBe(reads);
		expect(page.seen.problems).toEqual([]);
	});

	it("makes no request to anywhere but its own server, and starts nothing the operator did not ask for", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		await page.click("button[data-workspace=compare]");
		await page.waitFor(`document.querySelector("[data-testid=unavailable-compare]")`, 5000);
		for (const url of page.seen.requests) expect(url.startsWith(`${server.origin}/`), url).toBe(true);
		const mine = page.seen.requests.filter((url) => url.startsWith(server.origin));
		const allowed = /\/(assets\/[A-Za-z0-9._-]+|api\/v0\/snapshot\?afterSequence=0&limit=100)$|\/$/;
		for (const url of mine) expect(url.replace(server.baseUrl, "/"), url).toMatch(allowed);
		expect(snapshotRequests(page)).toBe(1);
	});
});

suite("finding the selected event in a long session, and reading the inspector", () => {
	const long = (n = 230) => {
		const root = tempRoot();
		ingestAll(
			root,
			Array.from({ length: n }, (_, i) => event(i % 3 === 0 ? "tool.started" : "agent.prompt-accepted")),
		);
		seedRegistry(root);
		return root;
	};
	const budget = { duty: 1, burstMs: 1e9 };
	const rowVisible = (page: Page, seq: number) =>
		page.eval<boolean>(`(() => {
			const box = document.querySelector("#timeline .table-scroll").getBoundingClientRect();
			const head = document.querySelector("#timeline thead").getBoundingClientRect().height;
			const r = document.querySelector("#timeline tr[data-seq='${seq}']").getBoundingClientRect();
			return r.top >= box.top + head - 1 && r.bottom <= box.bottom + 1;
		})()`);
	const markClick = (page: Page, seq: number) =>
		page.eval(
			`document.querySelector("#overview g[data-seq='${seq}']").dispatchEvent(new MouseEvent("click", { bubbles: true }))`,
		);
	const bar = (page: Page) => text(page, "[data-testid=selection-bar]");
	const scrollTop = (page: Page) => page.eval<number>(`document.querySelector("#timeline .table-scroll").scrollTop`);

	it("selecting a mark opens the inspector but does not move the table; Show in table reveals the row, inside the table, with no read", async () => {
		const server = await serve(long(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		await page.eval(
			`document.querySelector("#timeline select[aria-label='Rows per page']").value = "200"; document.querySelector("#timeline select[aria-label='Rows per page']").dispatchEvent(new Event("change", { bubbles: true }))`,
		);
		await page.settled(2);
		const reads = snapshotRequests(page);
		const before = await scrollTop(page);
		expect(await bar(page)).toBe("No event selected.");
		await markClick(page, 150);
		expect(await text(page, "#inspector")).toContain("Event at position 150");
		expect(await bar(page)).toMatch(/Selected: position 150\./);
		expect(await scrollTop(page)).toBe(before); // selecting does not scroll the table by itself
		expect(await rowVisible(page, 150)).toBe(false); // it is offscreen in the table
		await page.click("[data-focus=selection-action]");
		expect(await rowVisible(page, 150)).toBe(true);
		expect(await page.eval(`document.activeElement.closest("tr").dataset.seq`)).toBe("150");
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='150']").getAttribute("aria-selected")`),
		).toBe("true");
		expect(await text(page, "#inspector")).toContain("Event at position 150"); // the selection is intact
		// The row is on the screen, not only inside its scroller (the page moved as far as that took, and no farther).
		expect(
			await page.eval<boolean>(
				`(() => { const r = document.querySelector("#timeline tr[data-seq='150']").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`,
			),
		).toBe(true);
		// A row already in view does not move.
		const settledAt = await scrollTop(page);
		const pageAt = await page.eval<number>("window.scrollY");
		await page.click("[data-focus=selection-action]");
		expect(await scrollTop(page)).toBe(settledAt);
		expect(await page.eval<number>("window.scrollY")).toBe(pageAt);
		expect(snapshotRequests(page)).toBe(reads); // never a read for a row the window already holds
	});

	it("a filter can hide the selected event without selecting another, says which filter, and one button clears only that and keeps focus", async () => {
		const server = await serve(populated(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		const reads = snapshotRequests(page);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		const category = await page.eval<string>(
			`document.querySelector("#timeline tr[data-seq='5'] .cat").className.split(" ").find((c) => c.startsWith("cat-")).slice(4)`,
		);
		await page.click(`#timeline button.chip.cat-${category}`); // keeps the event's own category
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); i.focus(); __set(i, "no-such-thing"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		expect(await bar(page)).toMatch(/Position 5 is open in the inspector and hidden by the text filter\./);
		expect(await text(page, "#inspector")).toContain("Event at position 5"); // no other event was selected
		expect(await text(page, "#inspector")).toMatch(/hide this event from the table/);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(0);
		// The one button: focus it, press Enter as a keyboard user would.
		await page.eval(`document.querySelector("[data-focus=selection-action]").focus()`);
		// The name is the visible words (it must be speakable as they read); the position and the filters are its description.
		expect(
			await page.eval(`document.querySelector("[data-focus=selection-action]").hasAttribute("aria-label")`),
		).toBe(false);
		expect(await page.eval(`document.querySelector("[data-focus=selection-action]").textContent`)).toBe(
			"Clear filters that hide it",
		);
		expect(
			await page.eval(
				`document.getElementById(document.querySelector("[data-focus=selection-action]").getAttribute("aria-describedby")).textContent`,
			),
		).toMatch(/Position 5 .* hidden by the text filter/);
		await page.press("Enter");
		expect(await bar(page)).toMatch(/Selected: position 5\./);
		expect(await page.eval(`document.activeElement.getAttribute("data-focus")`)).toBe("selection-action"); // the same button, still focused
		await page.waitFor(`document.querySelector("#timeline-search").value === ""`, 3000);
		expect(await page.eval<string>(`document.querySelector("#timeline-search").value`)).toBe("");
		expect(
			await page.eval(
				`document.querySelector("#timeline button.chip.cat-${category}").getAttribute("aria-pressed")`,
			),
		).toBe("true"); // the category filter was not the cause, so it stays
		expect(await count(page, "#timeline tr[data-seq]")).toBeGreaterThan(0);
		expect(
			await page.eval(`document.querySelector("#timeline tr[data-seq='5']").getAttribute("aria-selected")`),
		).toBe("true");
		expect(snapshotRequests(page)).toBe(reads);
	});

	it("keeps a selected event's ring at full strength on the overview while the filters dim its shape", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); __set(i, "no-such-thing"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		const opacity = await page.eval<[string, string]>(`(() => {
			const g = document.querySelector("#overview g[data-seq='5']");
			return [getComputedStyle(g.querySelector(".ring-selected")).opacity, getComputedStyle(g.querySelector(".omark")).opacity];
		})()`);
		expect(opacity[0]).toBe("1");
		expect(Number(opacity[1])).toBeLessThan(0.5);
	});

	it("a read that moves the window closes a selection the new window does not hold, says so once, and the bar returns to no selection", async () => {
		const server = await serve(long(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		await markClick(page, 10);
		await page.eval(
			`[...document.querySelectorAll("#timeline .pager button")].find((b) => b.textContent === "Next").click()`,
		);
		await page.settled(2);
		expect(await bar(page)).toBe("No event selected.");
		expect(await text(page, "#inspector")).toMatch(
			/The event at position 10 is not in the window now loaded, so it is closed\./,
		);
		expect(await text(page, "#inspector")).not.toMatch(/still in the log/);
		expect(await scrollTop(page)).toBe(0);
		// Selecting in the new window works as before, and the note is gone once something is open.
		await markClick(page, 120);
		expect(await bar(page)).toMatch(/Selected: position 120\./);
		expect(await text(page, "#inspector")).not.toMatch(/is not in the window now loaded/);
	});

	it("says why a move is not available beside the pager, reachable without a mouse, and says when the last read failed", async () => {
		const server = await serve(long(), { ui, readBudget: { duty: 0.0001, burstMs: 1 } });
		const page = await open(`${server.baseUrl}/`);
		expect(
			await page.eval(`document.querySelector("[data-focus='pager:First']").getAttribute("aria-describedby")`),
		).toBe("pager-reasons");
		expect(await text(page, "#pager-reasons")).toMatch(/First: This window starts at the beginning of the log\./);
		expect(await text(page, "#pager-reasons")).toMatch(/Previous: There is nothing before this window\./);
		expect(
			await page.eval(`document.querySelector("[data-focus='pager:Next']").getAttribute("aria-describedby")`),
		).toBeNull(); // Next works
		expect(await text(page, "#timeline .panel-tools")).not.toMatch(/not current/);
		await page.click("#refresh"); // a budget this small paces the second read
		await page.settled(2);
		expect(await text(page, "#timeline .panel-tools")).toMatch(/not current/);
		expect(await text(page, "#pager-reasons")).toMatch(/Reads are paused/);
	});

	it("opens the reference one disclosure at a time with the keyboard, and keeps it available beside a selected event", async () => {
		const server = await serve(populated(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		const reads = snapshotRequests(page);
		const open_ = () =>
			page.eval<boolean[]>(
				`[...document.querySelectorAll("#inspector [data-testid=legend] details")].map((d) => d.open)`,
			);
		expect(await text(page, "#inspector [data-testid=legend] .lead")).toBe(
			"Select an event or capability to inspect its recorded evidence.",
		);
		expect(await open_()).toEqual([true, false, false, false, false]); // only how a value is known is open
		expect(
			await page.eval<string[]>(
				`[...document.querySelectorAll("#inspector [data-testid=legend] summary")].map((s) => s.textContent)`,
			),
		).toEqual([
			"Evidence and provenance",
			"Overview marks",
			"Event flags",
			"Source conditions",
			"Capability statuses",
		]);
		await page.eval(`document.querySelectorAll("#inspector [data-testid=legend] summary")[2].focus()`);
		await page.press("Enter");
		expect(await open_()).toEqual([true, false, true, false, false]);
		expect(
			await page.eval(
				`(() => { const f = document.querySelectorAll("#inspector [data-testid=legend] details")[2]; return getComputedStyle(f.querySelector("ul")).display !== "none" && f.querySelector("ul").offsetHeight > 0; })()`,
			),
		).toBe(true);
		// Nothing was dropped: every wording the earlier legend had is still in the page.
		const all = await page.eval<string>(`document.querySelector("#inspector [data-testid=legend]").textContent`);
		for (const phrase of [
			"Observed directly by Endophasia",
			"Reported by the runtime",
			"Computed from other recorded values",
			"no value, for the reason shown",
			"envelope only",
			"Its kind records a fault",
			"A torn tail can be a write in progress",
			"Not offered, whatever earlier evidence said",
		])
			expect(all, phrase).toContain(phrase);
		// A selected event: the details are there, folded in a reading guide, and the one legend is gone.
		await page.click("#timeline tr[data-seq='5'] button.seq");
		expect(await count(page, "[data-testid=legend]")).toBe(0);
		expect(await page.eval<boolean>(`document.querySelector("#inspector [data-testid=reference]").open`)).toBe(false);
		await page.eval(`document.querySelector("#inspector [data-testid=reference] summary").focus()`);
		await page.press("Enter");
		expect(await page.eval<boolean>(`document.querySelector("#inspector [data-testid=reference]").open`)).toBe(true);
		expect(snapshotRequests(page)).toBe(reads);
	});

	it("opens a cut identifier in place to its whole value, and copies only a displayed identifier, as shown", async () => {
		const server = await serve(populated(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		const reads = snapshotRequests(page);
		// A value the runtime panel cuts: its button opens it to the whole.
		const cut: { before: string; after: string; expanded: string } = {
			after: "",
			expanded: "",
			...(await page.eval<{ before: string }>(`(() => {
			const b = [...document.querySelectorAll("#runtime button.expand")][0];
			const before = b.textContent; b.click();
			return { before };
		})()`)),
		};
		await page.waitFor(
			`document.querySelector("#runtime button.expand").getAttribute("aria-expanded") === "true"`,
			3000,
		);
		cut.after = await page.eval<string>(`document.querySelector("#runtime button.expand").textContent`);
		cut.expanded = "true";
		expect(cut.before.endsWith("…")).toBe(true);
		expect(cut.after.length).toBeGreaterThan(cut.before.length);
		expect(cut.after.startsWith(cut.before.slice(0, -1))).toBe(true);
		expect(cut.expanded).toBe("true");
		// Copy: the page's clipboard is replaced by a recorder, so what would be copied is what is read back.
		await page.eval(
			`window.__copied = []; Object.defineProperty(navigator, "clipboard", { value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true })`,
		);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		const shown = await page.eval<string>(
			`[...document.querySelectorAll("#inspector dl.facts .fact")].find((f) => f.querySelector("dt").textContent === "event id").querySelector("dd .mono").textContent`,
		);
		await page.click(`#inspector button.copy[aria-label="Copy event id"]`);
		await page.waitFor(`window.__copied.length === 1`, 3000);
		expect(await page.eval<string[]>("window.__copied")).toEqual([shown]);
		expect(await text(page, `#inspector button.copy[aria-label="Copy event id"]`)).toBe("copied");
		expect(snapshotRequests(page)).toBe(reads);
		// A generated alias has no copy button: it stands in for what is not shown.
		const snapshot = JSON.parse(
			JSON.stringify(readEndoCockpitSnapshotV0(populated(), { digestKey: OTHER_KEY, limit: 100 })),
		);
		snapshot.timeline.entries[4].eventId = "endo.event.withheld-0123456789abcdef0123456789abcdef";
		const aliased = await open(await pretendFor(snapshot));
		await aliased.click("#timeline tr[data-seq='5'] button.seq");
		expect(await count(aliased, `#inspector button.copy[aria-label="Copy event id"]`)).toBe(0);
		expect(await count(aliased, `#inspector button.copy[aria-label="Copy session id"]`)).toBe(1);
	});

	it("in the narrow dialog the actions are reachable: the note that filters hide the open event carries Clear, and Show in table closes the dialog and shows the row", async () => {
		const server = await serve(populated(), { ui, readBudget: budget });
		const page = await open(`${server.baseUrl}/`);
		await page.click("#timeline tr[data-seq='5'] button.seq");
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); __set(i, "no-such-thing"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
		);
		await page.resize(420, 800); // the window is made narrow with the event open and hidden: the table is now behind a modal dialog
		await page.waitFor(`document.querySelector("dialog#inspector").open`, 5000);
		const reads = snapshotRequests(page);
		expect(await text(page, "dialog#inspector [data-testid=event-detail]")).toMatch(
			/hide this event from the table \(the text filter\)/,
		);
		await page.eval(`document.querySelector("dialog#inspector [data-focus=inspector-clear]").focus()`);
		await page.press("Enter");
		await page.waitFor(`!document.querySelector("dialog#inspector [data-focus=inspector-clear]")`, 3000);
		expect(await page.eval<boolean>(`document.querySelector("dialog#inspector").open`)).toBe(true); // still open, selection intact
		expect(await text(page, "dialog#inspector")).toContain("Event at position 5");
		await page.click("dialog#inspector [data-focus=inspector-show]");
		await page.waitFor(`document.querySelector("dialog#inspector").open === false`, 3000);
		expect(
			await page.eval(`document.activeElement.closest("tr") && document.activeElement.closest("tr").dataset.seq`),
		).toBe("5");
		expect(
			await page.eval<boolean>(
				`(() => { const r = document.querySelector("#timeline tr[data-seq='5']").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()`,
			),
		).toBe(true);
		expect(snapshotRequests(page)).toBe(reads);
	});

	it("never moves the table when the selection bar changes state, whatever the width and however many filters hide the event", async () => {
		const server = await serve(populated(), { ui, readBudget: budget });
		for (const [width, height] of [
			[1440, 900],
			[1100, 800],
		] as const) {
			const page = await open(`${server.baseUrl}/`, width, height);
			// What the bar itself adds to the page: its height, and where it sits against the window line above it. (The filter row above it can wrap when a
			// filter is set; that is the filters' doing, not the bar's.)
			const geometry = () =>
				page.eval<[number, number]>(
					`(() => { const b = document.querySelector("[data-testid=selection-bar]"); return [b.getBoundingClientRect().height, b.getBoundingClientRect().top - document.querySelector("#timeline .window-line").getBoundingClientRect().top]; })()`,
				);
			page.eval<[number, number]>(
				`[document.querySelector("[data-testid=selection-bar]").getBoundingClientRect().height, document.querySelector("[data-testid=selection-bar]").nextElementSibling.getBoundingClientRect().top]`,
			);
			await page.eval("document.fonts.ready.then(() => true)"); // a late font swap is not the bar's doing
			const none = await geometry();
			await page.click("#timeline tr[data-seq='5'] button.seq");
			const shown = await geometry();
			// Every filter at once, so the sentence is as long as it gets.
			await page.eval(
				`(() => { const i = document.querySelector("#timeline-search"); __set(i, "no-such-thing"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
			);
			await page.click("#timeline .check input");
			await page.click("#timeline button.chip.cat-control");
			await page.eval(
				`(() => { const s = document.querySelector("#timeline select[aria-label^='Session']"); if (s) { s.value = s.options[1].value; s.dispatchEvent(new Event("change", { bubbles: true })); } })()`,
			);
			const hidden = await geometry();
			expect(shown, `${width}px`).toEqual(none);
			expect(hidden, `${width}px`).toEqual(none);
		}
	});

	it("keeps a fact's label and value side by side in the left rail at the common laptop widths (stacking is only for a genuinely narrow panel)", async () => {
		const server = await serve(populated(), { ui });
		for (const [width, height] of [
			[1440, 900],
			[1366, 768],
		] as const) {
			const page = await open(`${server.baseUrl}/`, width, height);
			const sameRow = await page.eval<boolean>(`(() => {
				const f = document.querySelector("#runtime .fact");
				return Math.abs(f.querySelector("dt").getBoundingClientRect().top - f.querySelector("dd").getBoundingClientRect().top) < 6;
			})()`);
			expect(sameRow, `${width}px`).toBe(true);
		}
	});

	it("keeps the page free of sideways scrolling and the source warnings in view at the representative widths", async () => {
		const root = populated();
		appendFileSync(
			join(root, "events", "events.log"),
			endoFrameBytesV0(new TextEncoder().encode(JSON.stringify(event("tool.started")))).subarray(0, 21),
		);
		const server = await serve(root, { ui });
		for (const [width, height] of [
			[1440, 900],
			[1280, 720],
			[1100, 800],
			[768, 900],
			[420, 800],
		] as const) {
			const page = await open(`${server.baseUrl}/`, width, height);
			expect(
				await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1"),
				`${width}px`,
			).toBe(true);
			expect(await text(page, "[data-testid=attention]"), `${width}px`).toMatch(/degraded/);
			expect(await count(page, "#timeline tr[data-seq]"), `${width}px`).toBeGreaterThan(0);
			await page.click("#timeline tr[data-seq='5'] button.seq");
			expect(
				await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1"),
				`${width}px, inspector open`,
			).toBe(true);
			const modal = width < 1024;
			expect(await count(page, "dialog[open]"), `${width}px`).toBe(modal ? 1 : 0);
			if (modal)
				expect(await text(page, "dialog#inspector [data-testid=dialog-attention]"), `${width}px`).toMatch(
					/degraded/,
				);
			else expect(await text(page, "#inspector"), `${width}px`).toContain("Event at position 5");
			expect(page.seen.problems, `${width}px`).toEqual([]);
		}
	});
});
