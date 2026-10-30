// DEVELOP in a real browser over the production server: discovery, selection, event inspection, paging, keyboard, stale-selection
// recovery, the hand-offs to Observe and Compare, narrow stages, and the page policy. Skipped locally without Chromium; required in CI.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { developEvents, developStore } from "./studio-develop-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-develop-browser-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
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
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null ? describe.skip : describe;

async function open(root: string, width = 1440, height = 900) {
	const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor(
		"document.querySelector('#develop-workspace') && !document.querySelector('#develop-workspace .loading') && document.querySelector('#develop-refresh')",
	);
	return { page, server };
}
const api = (page: Page, part: string) => page.seen.requests.filter((r) => r.includes(part));
const pick = async (page: Page, alias: string) => {
	await page.eval(
		`(() => { const b = [...document.querySelectorAll('[data-session-row]')].find(e => e.textContent.startsWith(${JSON.stringify(alias)})); b.click(); })()`,
	);
	await page.waitFor(
		`document.querySelector('[data-testid=activity-title]')?.textContent === ${JSON.stringify(alias)}`,
	);
};
const noOverflow = (page: Page) =>
	page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth");

suite("DEVELOP", () => {
	it("marks every recording as recorded only, shows its source, ownership and offers with reasons, and sends nothing to a workbench", async () => {
		const { page } = await open(developStore());
		const tags = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=surface-tag]')].map((e) => e.textContent)",
		);
		expect(tags.length).toBeGreaterThan(1);
		expect(new Set(tags)).toEqual(new Set(["recorded only"]));
		await pick(page, "pi.a");
		expect(await page.text("[data-testid=surface-source]")).toContain("Pi recording");
		expect(await page.text("[data-testid=surface-observation]")).toContain("Recorded only");
		expect(await page.text("[data-testid=surface-connection]")).toContain("none: this is a recording");
		expect(await page.text("[data-testid=surface-ownership]")).toContain("Imported from a recording");
		expect(await page.text("[data-testid=surface-status]")).toContain("as recorded");
		const status = (action: string) =>
			page.eval<string>(`document.querySelector('[data-testid=cap-control-${action}]').dataset.status`);
		for (const action of ["prompt", "steer", "queue", "stop", "resume"])
			expect(await status(action)).toBe("unsupported");
		expect(await page.text("[data-testid=cap-control-stop]")).toContain("read-only");
		await pick(page, "dsh.session-1");
		expect(await page.text("[data-testid=cap-control-prompt]")).toContain("no control path to DSH");
		// Reading a recording never reaches a workbench route that could change anything.
		expect(page.seen.requests.filter((r) => /\/workbench\/(prompt|intervention|pair)/.test(r))).toEqual([]);
		expect(page.seen.requests.filter((r) => /develop-session|fixture/.test(r))).toEqual([]);
	});

	it("discovers recorded sessions, selects one, reads its activity and an event, and keeps the page policy", async () => {
		const { page } = await open(developStore());
		const dev = "/api/v0/develop/";
		expect(api(page, `${dev}sessions`)).toHaveLength(1);
		const text = await page.eval<string>("document.body.innerText");
		expect(text).toContain("as recorded");
		// The headings are set in capitals by the style sheet; the text is compared as written.
		expect(text.toLowerCase()).toContain("pi recordings");
		expect(text.toLowerCase()).toContain("dsh recordings");
		expect(text).toContain("Project: unavailable for every session");
		expect(text).not.toMatch(/\b(alive|online|active now|live process running)\b/i);
		await pick(page, "pi.a");
		expect(api(page, `${dev}session/d1-`)).toHaveLength(1);
		expect(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")).toBe(39);
		expect(await page.text("#develop-inspector")).toContain("process now");
		expect(await page.text("#develop-inspector")).toContain("Not checked");
		await page.click("[data-event-row]");
		await page.waitFor("document.querySelector('#develop-inspector [data-testid=event-detail]')");
		expect(await page.text("#develop-inspector")).toContain("Event at position 1");
		await page.click("#develop-inspector button.small-btn");
		await page.waitFor("document.querySelector('#develop-inspector [data-testid=session-detail]')");
		// One read to open the workspace, one quiet probe for a workbench (a read-only server answers it with a constant), and one per
		// explicit action: selecting an event and going back read nothing.
		expect(api(page, "/api/")).toHaveLength(4);
		expect(api(page, "/api/v0/workbench/")).toHaveLength(1);
		expect(page.seen.problems).toEqual([]);
		expect(await noOverflow(page)).toBe(true);
	});

	it("moves between sessions and events with the arrow keys, and pages a long session only on request", async () => {
		const { page } = await open(developStore());
		await page.eval("document.querySelector('[data-session-row]').focus()");
		await page.press("ArrowDown");
		expect(
			await page.eval<boolean>("document.activeElement === document.querySelectorAll('[data-session-row]')[1]"),
		).toBe(true);
		await pick(page, "pi.long");
		expect(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")).toBe(100);
		expect(await page.text("[data-testid=activity-coverage]")).toContain("of 269 events loaded");
		await page.eval("document.querySelector('[data-event-row]').focus()");
		await page.press("ArrowDown");
		expect(
			await page.eval<boolean>("document.activeElement === document.querySelectorAll('[data-event-row]')[1]"),
		).toBe(true);
		await page.click("#develop-more-events");
		await page.waitFor("document.querySelectorAll('[data-event-row]').length === 200");
		expect(api(page, "?cursor=a1-")).toHaveLength(1);
	});

	it("starts each session unfiltered, so a category chosen elsewhere never hides a session behind a chip that is not there", async () => {
		const { page } = await open(developStore());
		await pick(page, "pi.a");
		const tool = "[...document.querySelectorAll('.chips button')].find(b => b.textContent.startsWith('tool'))";
		await page.eval(`${tool}.click()`);
		await page.waitFor("document.querySelector('[data-testid=clear-activity-filters]')");
		expect(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")).toBe(4);
		// The DSH recording has no tool-category events: with the old retained filter it showed no rows and no chip to clear.
		await pick(page, "dsh.session-1");
		expect(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")).toBe(30);
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=clear-activity-filters]')")).toBe(true);
		// An active filter is always visible and clearable, even if the loaded events happened not to match it.
		await page.eval(
			"[...document.querySelectorAll('.chips button')].find(b => b.textContent.startsWith('lifecycle')).click()",
		);
		await page.eval("document.querySelector('[data-testid=clear-activity-filters]').click()");
		expect(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")).toBe(30);
		expect(page.seen.problems).toEqual([]);
	});

	it("drops a selection the log no longer supports, with a sentence, and rediscovers on request", async () => {
		const root = developStore();
		const { page } = await open(root);
		await pick(page, "pi.a");
		ingestAll(root, [
			event("harness.attached", {}, { session: "endo.session.other", producer: "pi-lifecycle:pi.default" }),
		]);
		await page.click("#develop-refresh");
		await page.waitFor("document.querySelector('.note-warn')?.textContent.includes('not in the sessions now read')");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=activity-title]')")).toBe(true);
		expect(await page.text("#develop-activity")).toContain("Select a recorded session");
		await pick(page, "pi.a");
		expect(page.seen.problems).toEqual([]);
	});

	it("hands a session to Observe (one explicit read from its first event) and to Compare (preselected as A)", async () => {
		const { page } = await open(developStore());
		await pick(page, "pi.long");
		await page.click("[data-testid=open-compare]");
		await page.waitFor(
			"document.querySelector('#compare-workspace')?.dataset.busy === 'false' && document.querySelector('#recording-a')?.value?.startsWith('pi:')",
		);
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=open-observe]')");
		await page.click("[data-testid=open-observe]");
		await page.waitFor("document.querySelector('button[data-workspace=observe][aria-current=page]')");
		await page.waitFor("document.body.dataset.busy === 'false'");
		expect(api(page, "/api/v0/snapshot").some((r) => /afterSequence=(?!0&)\d+/.test(r))).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("shows an absent store and a degraded log as their own conditions", async () => {
		const absent = await open(tempRoot());
		expect(await absent.page.text("#develop-sessions")).toContain("absent");
		expect(await absent.page.text("#develop-sessions")).toContain("No event store here");
		expect(await absent.page.text("#develop-activity")).toContain("No session to open");
		const root = developStore();
		appendFileSync(join(root, "events", "events.log"), Buffer.from([0, 0, 0, 0x20, 0x7b, 0x22]));
		const degraded = await open(root);
		expect(await degraded.page.text("[data-testid=develop-source-note]")).toContain("degraded");
		await pick(degraded.page, "pi.a");
		expect(await degraded.page.text("#develop-inspector")).toContain("log is degraded");
		// The cue is in the activity too, so a partial session is never read as a complete one.
		expect(await degraded.page.text("[data-testid=activity-degraded]")).toContain("readable prefix");
		expect(await degraded.page.text("#develop-activity")).toContain("in the readable prefix");
	});

	it("shows one stage at a time on a narrow screen and returns focus where it came from", async () => {
		const { page } = await open(developStore(), 768, 1000);
		expect(await page.eval<boolean>("!document.querySelector('#develop-activity')")).toBe(true);
		await pick(page, "pi.a");
		expect(await page.eval<boolean>("!document.querySelector('#develop-sessions')")).toBe(true);
		expect(await page.eval<boolean>("document.activeElement?.dataset.testid === 'develop-crumb'")).toBe(true);
		await page.eval("document.querySelector('[data-event-row]').focus()");
		await page.click("[data-event-row]");
		await page.waitFor("document.querySelector('dialog#develop-event-dialog[open]')");
		await page.press("Escape");
		await page.waitFor("!document.querySelector('dialog[open]')");
		expect(await page.eval<boolean>("document.activeElement?.matches('[data-event-row]')")).toBe(true);
		await page.press("Escape");
		await page.waitFor("document.querySelector('#develop-sessions')");
		expect(await noOverflow(page)).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("does not overflow the page at 1440, 1024, 768 and 420 pixels", async () => {
		for (const width of [1440, 1024, 768, 420]) {
			const { page } = await open(developStore(), width, 900);
			await pick(page, "pi.a").catch(async () => {
				await page.click("[data-session-row]");
			});
			expect(await noOverflow(page), `${width}px`).toBe(true);
			expect(page.seen.problems).toEqual([]);
		}
	});

	it("renders every record string as text: a hostile alias or kind is never markup", async () => {
		const root = developStore(developEvents());
		const { page } = await open(root);
		expect(
			await page.eval<number>(
				"document.querySelectorAll('#develop-workspace img, #develop-workspace script, #develop-workspace iframe').length",
			),
		).toBe(0);
		expect(
			await page.eval<boolean>(
				"(() => { try { document.body.innerHTML = '<b>x</b>'; return false; } catch { return true; } })()",
			),
		).toBe(true);
	});
});
