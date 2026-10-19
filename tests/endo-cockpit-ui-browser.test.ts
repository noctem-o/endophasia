// The page in a real browser: headless Chromium with the GPU off (so the page is shown to work without hardware acceleration),
// against a real server over real temporary stores. Skipped, with the reason stated, when no Chromium is installed
// (set CHROME_BIN to point at one).
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readEndoCockpitSnapshotV0 } from "../cockpit/index.ts";
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
let ui: Record<string, string> = {};

beforeAll(async () => {
	dist = mkdtempSync(join(tmpdir(), "endo-cockpit-ui-dist-"));
	const built = spawnSync(process.execPath, [join(repo, "scripts/build-cockpit-ui.mjs"), dist], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(`the UI did not build: ${built.stderr}`);
	ui = Object.fromEntries(readdirSync(dist).map((name) => [name, readFileSync(join(dist, name), "utf8")]));
	if (executable !== null) browser = await Browser.launch(executable);
}, 60_000);
afterAll(async () => {
	await browser?.close();
	rmSync(dist, { recursive: true, force: true });
	removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true }));
});
afterEach(stopServers);

const suite = executable === null ? describe.skip : describe;
if (executable === null)
	console.warn("endo-cockpit-ui-browser: no Chromium found (set CHROME_BIN); the browser tests are skipped");

let tabs: Page[] = [];
async function open(url: string, width = 1440, height = 900): Promise<Page> {
	const page = await browser!.open(width, height);
	tabs.push(page);
	await page.goto(url);
	await page.settled();
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
			`[...document.querySelectorAll("#timeline tr[data-seq] .col-kind")].map((e) => e.textContent)`,
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

	it("shows text from the API as text: the widgets make no element from a hostile string", async () => {
		const server = await serve(populated(), { ui });
		const page = await open(`${server.baseUrl}/`);
		const result = await page.eval<{
			imgs: number;
			shown: string;
			withheld: string;
			alias: string;
			na: string;
		}>(`(async () => {
			const widgets = await import("./assets/widgets.js");
			const hostile = '<img src=x onerror="document.title=1"><script>1</script>';
			const holder = document.createElement("div");
			document.body.append(holder);
			holder.append(widgets.textValue(hostile), widgets.textValue("withheld: looks like a path, address or credential"), widgets.textValue("endo.event.withheld-0123456789abcdef0123456789abcdef"), widgets.unavailable("the producer gave none"));
			const [a, b, c, d] = [...holder.children];
			return { imgs: holder.querySelectorAll("img, script").length, shown: a.textContent, withheld: b.className + "|" + b.textContent, alias: c.className, na: d.textContent };
		})()`);
		expect(result.imgs).toBe(0);
		expect(result.shown).toBe('<img src=x onerror="document.title=1"><script>1</script>');
		expect(result.withheld).toBe("withheld|withheld");
		expect(result.alias).toBe("alias");
		expect(result.na).toContain("N/A");
		expect(result.na).toContain("the producer gave none");
		expect(await page.eval("document.title")).toBe("Endophasia Cockpit");
		// Free text that merely contains an alias token is shown whole, as the text it is.
		const sentence = "see endo.event.withheld-0123456789abcdef0123456789abcdef for the reason";
		expect(
			await page.eval(
				`import("./assets/widgets.js").then((w) => w.textValue(${JSON.stringify(sentence)}).textContent)`,
			),
		).toBe(sentence);
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
			`(() => { const s = document.querySelector("#runtime select"); s.value = "bad.default"; s.dispatchEvent(new Event("change")); })()`,
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
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "50"; s.dispatchEvent(new Event("change")); })()`,
		);
		await page.settled(7);
		expect(await range()).toMatch(/positions 131–180 of 230/);
		expect(snapshotRequests(page)).toBe(7);
	});

	it("keeps the table's place when an event is selected, and starts a new window at the top", async () => {
		const server = await serve(many(230), { ui, readBudget: { duty: 1, burstMs: 1e9 } });
		const page = await open(`${server.baseUrl}/`);
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "200"; s.dispatchEvent(new Event("change")); })()`,
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
			`(() => { const s = document.querySelector("#timeline select[aria-label='Session']"); s.focus(); s.value = "endo.session.two"; s.dispatchEvent(new Event("change")); })()`,
		);
		expect(await focused()).toBe("session");
		expect(await page.eval(`document.querySelector("#timeline select[aria-label='Session']").value`)).toBe(
			"endo.session.two",
		);
		await page.eval(
			`(() => { const s = document.querySelector("#runtime select"); s.focus(); s.value = "omp.default"; s.dispatchEvent(new Event("change")); })()`,
		);
		expect(await focused()).toBe("attachment");
		expect(await page.eval(`document.querySelector("#runtime select").value`)).toBe("omp.default");
		// A control that starts a read loses focus while it is disabled, and gets it back when the read ends.
		await page.eval(
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.focus(); s.value = "50"; s.dispatchEvent(new Event("change")); })()`,
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
			`(() => { const i = document.querySelector("#timeline-search"); i.focus(); i.__mine = true; i.value = "日"; i.dispatchEvent(new InputEvent("input", { isComposing: true })); })()`,
		);
		expect(await page.eval(`document.querySelector("#timeline-search").__mine`)).toBe(true);
		expect(await count(page, "#timeline tr[data-seq]")).toBeGreaterThan(0); // not filtered yet
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); i.value = "日本"; i.dispatchEvent(new CompositionEvent("compositionend", { data: "日本" })); })()`,
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
			`(() => { const i = document.querySelector("#timeline-search"); i.focus(); i.value = "tool.started"; i.dispatchEvent(new Event("input")); })()`,
		);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(20);
		expect(await text(page, "#timeline .window-line")).toMatch(/20 of 60 in this window match/);
		expect(await page.eval(`document.activeElement.id`)).toBe("timeline-search");
		await page.click("#timeline .chips button");
		await page.eval(
			`(() => { const i = document.querySelector("#timeline-search"); i.value = "no-such-kind"; i.dispatchEvent(new Event("input")); })()`,
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
		expect(await text(page, "#inspector")).toContain("How a value is known");
		await page.click("#timeline tr[data-seq='5'] button.seq");
		const event = await text(page, "#inspector");
		expect(event).toContain("Event at position 5");
		expect(event).toMatch(/producer sequence\s*\d+ \(within this producer only\)/);
		expect(event).toMatch(/recorded\s*20\d\d-/);
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
			expect(await text(page, "#runtime"), name).toContain("No snapshot has been read yet.");
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
		expect(banner).toContain("projection version of “cockpit-snapshot.9<img src=x onerror=1>”");
		expect(await count(page, "#banner img")).toBe(0);
		expect(await count(page, "#timeline tr[data-seq]")).toBe(0);
		expect(page.seen.problems).toEqual([]);
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
			`(() => { const s = document.querySelector("#timeline select[aria-label='Rows per page']"); s.value = "50"; s.dispatchEvent(new Event("change")); })()`,
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

	it("a 429 with no Retry-After is shown as pacing without inventing a time, and the controls stay usable", async () => {
		const url = await pretend((res) => json(res, 429, '{"error":"too-many-requests"}'));
		const page = await open(url);
		expect(await text(page, "#banner")).toMatch(/gave no time/);
		expect(await page.eval("document.querySelector('#refresh').disabled")).toBe(false);
	});
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
