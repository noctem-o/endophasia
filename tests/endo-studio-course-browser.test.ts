// The course in a real browser (docs/develop-course.md): the lower region of the session rail. Real broker, real built page; the
// conversation is SYNTHETIC (tests/develop-reasoning-fixtures.ts). What is pinned: it says what the broker reported and no more, it sends
// nothing and asks for nothing by itself, its separator and chart work from the keyboard, and it stays in view where the sessions do not.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { SYNTHETIC_CONVERSATION, tool } from "./develop-reasoning-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-course-browser-"));
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

const shot = async (page: Page, name: string) => {
	const dir = process.env.ENDO_SHOTS_DIR;
	if (dir === undefined || dir === "") return;
	await new Promise((r) => setTimeout(r, 400));
	writeFileSync(join(dir, `${name}.png`), await page.screenshot());
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const reread = async (page: Page) => {
	await page.click("#workbench-refresh");
	await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
};
const noOverflow = (page: Page) =>
	page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth");
const lit = (page: Page, lane: string) =>
	page.eval<string[]>(
		`[...document.querySelectorAll('#develop-course-body [data-lane=${lane}] [data-on=true]')].map(n => n.dataset.node)`,
	);
const rect = (page: Page, selector: string) =>
	page.eval<{ x: number; y: number; w: number; h: number }>(
		`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
	);

/** A live workbench with the synthetic conversation, the page on DEVELOP and paired. */
async function live(width = 1440, height = 900, options: { running?: boolean; conversation?: boolean } = {}) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: new FakeDesk(session),
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	if (options.conversation !== false) for (const event of SYNTHETIC_CONVERSATION) session.live_(event);
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=live-row]')");
	if (width < 1024) {
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('#develop-live')");
	}
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	if (options.conversation !== false) await page.waitFor("document.querySelector('[data-testid=run-marker]')");
	return { session, broker, server, page, approval };
}

suite("the course", () => {
	it("says what the broker reported on two lanes, and that an ordinary conversation needs no task", async () => {
		const { page, session, approval } = await live();
		await page.waitFor("document.querySelector('[data-testid=course-live]')");
		expect(await lit(page, "run")).toEqual(["open"]);
		expect(await lit(page, "request")).toEqual(["none"]);
		expect(await page.text("[data-testid=course-text-run]")).toContain("A run is open.");
		expect(await page.text("[data-testid=course-state-run]")).toContain("run open");
		expect(await page.text("[data-testid=course-state-request]")).toContain("none");
		expect(await page.eval("document.querySelector('[data-testid=course-attempt]') === null")).toBe(true);
		expect(await page.text("[data-testid=course-of]")).toContain("(browser clock)");
		// It is in the rail, above the sessions, and the conversation keeps its place beside it.
		const [course, sessions, conversation] = [
			await rect(page, "#develop-course"),
			await rect(page, "#develop-sessions"),
			await rect(page, "#develop-live"),
		];
		expect(course.y + course.h).toBeLessThanOrEqual(sessions.y + 2);
		expect(course.x + course.w).toBeLessThanOrEqual(conversation.x + 1);
		await shot(page, "course-01-live-run-open-1440");

		// A tool call with no result yet is named only after the page has read it: the course never runs ahead of a read.
		await page.click("[data-testid=follow]");
		for (const event of tool("c9", "bash")) session.live_(event);
		expect(await page.text("[data-testid=course-state-run]")).not.toContain("tool running");
		await reread(page);
		await page.waitFor(
			"document.querySelector('[data-testid=course-state-run]').textContent.includes('run open · tool running')",
		);
		// One needle on each scale, whatever is happening inside the run.
		expect(await lit(page, "run")).toEqual(["open"]);
		expect(await page.text("[data-testid=course-text-run]")).toContain("a tool call it made has no result yet");

		// A steer asked from the page waits for the terminal: the request lane says so, and that nothing was sent.
		await page.click("[data-testid=mode-steer]");
		await fill(page, "[data-testid=composer]", "also cover an empty chunk");
		await page.click("[data-testid=send]");
		await approval.waitForRequest();
		await page.waitFor(
			"document.querySelector('#develop-course-body [data-lane=request] [data-on=true]')?.dataset.node === 'awaiting'",
		);
		expect(await page.text("[data-testid=course-text-request]")).toContain(
			"A steer waits for your approval in the attached terminal. Nothing has been sent.",
		);
		expect(await page.text("[data-testid=course-flag]")).toBe("waits for you");
		expect(await page.text("[data-testid=course-state-request]")).toContain("steer awaits terminal");
		expect(await page.eval("document.querySelector('[data-testid=intervention-card]').dataset.state")).toBe(
			"awaiting-approval",
		);
		expect(session.promptCalls).toEqual([]);
		await shot(page, "course-02-live-awaiting-terminal-1440");
		approval.answer(null);
		expect(page.seen.problems).toEqual([]);
	});

	it("has four heights, set from the keyboard, and folds; none of it asks the server for anything", async () => {
		const { page } = await live();
		await page.waitFor("document.querySelector('[data-testid=course-split]')");
		// Follow is on when the page opens; it is switched off here so that any request seen below would be the course's own.
		await page.click("[data-testid=follow]");
		await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
		const size = () => page.eval<string>("document.querySelector('#develop-course').dataset.size");
		const height = async () => (await rect(page, "#develop-course")).h;
		const before = page.seen.requests.length;
		expect(await size()).toBe("fit");
		const low = await height();
		// Fitted, it is as tall as what it says: nothing in it is cut, and nothing in it scrolls.
		expect(
			await page.eval<boolean>(
				"(() => { const b = document.querySelector('#develop-course-body'); return b.scrollHeight <= b.clientHeight + 1; })()",
			),
		).toBe(true);
		await page.eval("document.querySelector('[data-testid=course-split]').focus()");
		await page.press("ArrowDown");
		expect(await size()).toBe("tall");
		expect(await height()).toBeGreaterThan(low + 40);
		expect(
			await page.eval("document.querySelector('[data-testid=course-split]').getAttribute('aria-valuetext')"),
		).toBe("tall");
		await page.press("ArrowDown");
		expect(await size()).toBe("tall");
		await page.press("ArrowUp");
		expect(await size()).toBe("fit");
		await page.press("Home");
		expect(await size()).toBe("closed");
		await page.press("End");
		expect(await size()).toBe("tall");
		await shot(page, "course-03-tall-1440");
		await page.press("Enter");
		expect(await size()).toBe("closed");
		expect(await page.eval("document.querySelector('#develop-course-body').hidden")).toBe(true);
		expect(await height()).toBeLessThan(60);
		// Folded, it still says where the session stands to a screen reader, and the sessions take the room.
		expect(await page.text("[data-testid=course-summary]")).toContain("A run is open.");
		await shot(page, "course-04-closed-1440");
		await page.press("Enter");
		expect(await size()).toBe("tall");
		await page.click("[data-testid=course-fold]");
		expect(await size()).toBe("closed");
		expect(await page.eval("document.querySelector('[data-testid=course-fold]').getAttribute('aria-expanded')")).toBe(
			"false",
		);
		await page.click("[data-testid=course-fold]");
		expect(await size()).toBe("tall");
		expect(page.seen.requests.length).toBe(before);
	});

	it("opens a chart with the runs the page holds, and shows a run where it is in the conversation", async () => {
		const { page } = await live();
		await page.waitFor("document.querySelector('[data-testid=course-open-chart]')");
		await page.click("[data-testid=follow]");
		await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
		const before = page.seen.requests.length;
		await page.click("[data-testid=course-open-chart]");
		await page.waitFor("document.querySelector('#course-chart').open");
		// The chart names every state, the basis of each statement, and what it is not.
		const chart = await page.text("#course-chart");
		for (const words of [
			"disconnected",
			"idle",
			"run open",
			"awaits terminal",
			"Nothing here needs a task.",
			"Runs this page holds",
			"private live text, not recorded evidence",
			"The runtime said so. Nothing checked it.",
			"It does not govern the session",
			"Nothing here is independent verification.",
		])
			expect(chart).toContain(words);
		expect(
			await page.eval<number>("document.querySelectorAll('#course-chart [data-testid=course-run]').length"),
		).toBeGreaterThanOrEqual(1);
		await shot(page, "course-05-chart-1440");
		await page.click("#course-chart [data-testid=course-show-run]");
		await page.waitFor("!document.querySelector('#course-chart').open");
		await page.waitFor("document.activeElement?.dataset.testid === 'run-marker'");
		// Escape closes it and gives focus back to what opened it.
		await page.click("[data-testid=course-open-chart]");
		await page.waitFor("document.querySelector('#course-chart').open");
		await page.press("Escape");
		await page.waitFor("!document.querySelector('#course-chart').open");
		expect(await page.eval("document.activeElement?.dataset.testid")).toBe("course-open-chart");
		expect(page.seen.requests.length).toBe(before);
		expect(page.seen.problems).toEqual([]);
	});

	it("draws a recording from what it recorded, marks the event open in the table, and is quiet where there is nothing", async () => {
		const server = await serve(developStore(), { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser.open(1440, 900);
		tabs.push(page);
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=session-row]')");
		expect(await page.text("[data-testid=course-empty]")).toContain("Nothing to chart");
		expect(await page.eval("document.querySelector('[data-testid=course-split]') === null")).toBe(true);
		await shot(page, "course-06-empty-readonly-1440");
		await page.eval(
			"[...document.querySelectorAll('[data-session-row]')].find(e => e.textContent.startsWith('pi.long')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=course-recorded]')");
		expect(await page.text("[data-testid=course-of]")).toContain("as recorded");
		expect(await page.text("[data-testid=course-recorded]")).toContain("Not a statement about a process now.");
		const marks = await page.eval<number>("document.querySelectorAll('.course-mark').length");
		expect(marks).toBe(await page.eval<number>("document.querySelectorAll('[data-testid=event-row]').length"));
		// A mark is the same event as the table's row: choosing one there marks it here, and a click here chooses it there.
		await page.eval("document.querySelectorAll('[data-testid=event-row]')[3].click()");
		await page.waitFor("document.querySelector('.course-mark[data-selected=true]')");
		expect(await page.eval("document.querySelector('.course-mark[data-selected=true]').dataset.sequence")).toBe(
			await page.eval(
				"document.querySelector('[data-testid=event-row][aria-pressed=true]').textContent.replaceAll(',', '').trim()",
			),
		);
		await page.eval(
			"document.querySelectorAll('.course-mark')[7].dispatchEvent(new MouseEvent('click', { bubbles: true }))",
		);
		await page.waitFor(
			"document.querySelector('.course-mark[data-selected=true]') === document.querySelectorAll('.course-mark')[7]",
		);
		await shot(page, "course-07-recorded-1440");
		expect(page.seen.problems).toEqual([]);
	});

	it("stays in view where the sessions are a drawer, and fits a tablet and a phone", async () => {
		const laptop = await live(1180, 820);
		await laptop.page.waitFor("document.querySelector('[data-testid=course-live]')");
		const [course, context, conversation] = [
			await rect(laptop.page, "#develop-course"),
			await rect(laptop.page, "#develop-context"),
			await rect(laptop.page, "#develop-live"),
		];
		expect(course.h).toBeGreaterThan(80);
		expect(course.x).toBeGreaterThanOrEqual(conversation.x + conversation.w - 1);
		expect(course.y + course.h).toBeLessThanOrEqual(context.y + 1);
		// The sessions drawer still opens over the work, and the course is not inside it.
		await laptop.page.click("[data-testid=sessions-toggle]");
		await laptop.page.waitFor("getComputedStyle(document.querySelector('#develop-sessions')).display !== 'none'");
		expect((await rect(laptop.page, "#develop-sessions")).x).toBeLessThan(40);
		expect(await noOverflow(laptop.page)).toBe(true);
		await shot(laptop.page, "course-08-drawer-width-1180");
		for (const [width, height] of [
			[1024, 768],
			[768, 1024],
			[390, 844],
		] as const) {
			const { page } = await live(width, height);
			if (width < 1024) {
				// One stage at a time: the course is with the context, one press from the conversation.
				await page.click("[data-testid=develop-crumb] button:last-child");
				await page.waitFor("document.querySelector('[data-testid=course-live]')");
			}
			expect(await lit(page, "run")).toEqual(["open"]);
			expect(await noOverflow(page)).toBe(true);
			const box = await rect(page, "#develop-course");
			expect(box.x).toBeGreaterThanOrEqual(0);
			expect(box.x + box.w).toBeLessThanOrEqual(width + 1);
			await shot(page, `course-09-context-stage-${width}`);
		}
	});
});
