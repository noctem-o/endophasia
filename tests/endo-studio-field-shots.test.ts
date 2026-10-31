// Screenshots of DEVELOP for visual review, opt-in: ENDO_SHOTS_DIR=/some/dir npx vitest --run tests/endo-studio-field-shots.test.ts
// Real browser, real broker, real Git, real built page; the conversation and the repository are SYNTHETIC (tests/develop-reasoning-
// fixtures.ts, tests/git-fixtures.ts). Nothing here is a live model's output, and every file it writes is named for the state it shows.
// It asserts only that each state was reached; the behaviour is pinned by the other browser suites.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { SYNTHETIC_CONVERSATION, SYNTHETIC_OPEN, tool } from "./develop-reasoning-fixtures.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const out = process.env.ENDO_SHOTS_DIR ?? "";
const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-field-shots-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
beforeAll(async () => {
	if (out === "" || executable === null) return;
	mkdirSync(out, { recursive: true });
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
	cleanGitFixtures();
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

const shot = async (page: Page, name: string) => {
	// Let transitions finish and the field draw its frame.
	await new Promise((r) => setTimeout(r, 900));
	writeFileSync(join(out, `${name}.png`), await page.screenshot());
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const reread = async (page: Page) => {
	await page.click("#workbench-refresh");
	await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
};

type Appearance = "instrument" | "field";
async function open(
	appearance: Appearance,
	width: number,
	height: number,
	options: { pair?: boolean; conversation?: boolean; running?: boolean; reduced?: boolean } = {},
) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: new FakeDesk(session),
		project: new GitProjectInspectorV0({ cwd: demoRepo(), minRefreshMs: 0 }),
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	if (options.conversation !== false) for (const event of SYNTHETIC_CONVERSATION) session.live_(event);
	const page = await browser.open(width, height);
	tabs.push(page);
	if (options.reduced === true) await page.reducedMotion();
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=live-row]')");
	if (width < 1024) {
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('#develop-live')");
	}
	if (appearance === "field") {
		await page.click("[data-testid=appearance-field]");
		await page.waitFor(
			"document.querySelector('.field-canvas') && document.querySelector('.field-canvas').dataset.state !== 'loading'",
		);
	}
	if (options.pair !== false) {
		await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[data-testid=composer]')");
		if (options.conversation !== false)
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning]').length >= 5");
	}
	return { session, broker, server, page, approval };
}
const toBottom = (page: Page) =>
	page.eval(
		"(() => { const s = document.querySelector('.live-scroll'); if (s) { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); } })()",
	);
const showTrace = async (page: Page, index: number) => {
	await page.eval(`document.querySelectorAll('[data-testid=reasoning-toggle]')[${index}].click()`);
	await page.eval(
		`(() => { const s = document.querySelector('.live-scroll'); const r = document.querySelectorAll('[data-testid=reasoning]')[${index}]; s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top - 120; s.dispatchEvent(new Event('scroll')); })()`,
	);
};

describe.runIf(out !== "" && executable !== null && haveGit)("DEVELOP screenshots (synthetic fixtures)", () => {
	for (const appearance of ["field", "instrument"] as Appearance[]) {
		const a = appearance;
		it(`${a}: arrivals and connection states`, async () => {
			const ro = await serve(developStore(), { ui, readBudget: { duty: 1, burstMs: 1e6 } });
			const page = await browser.open(1440, 900);
			tabs.push(page);
			await page.goto(`${ro.baseUrl}/`);
			await page.settled();
			await page.click("button[data-workspace=develop]");
			await page.waitFor("document.querySelector('[data-testid=session-row]')");
			if (a === "field") await page.click("[data-testid=appearance-field]");
			await shot(page, `${a}-01-arrival-readonly-1440`);
			const unpaired = await open(a, 1440, 900, { pair: false, conversation: false, running: false });
			await shot(unpaired.page, `${a}-02-arrival-unpaired-1440`);
			const idle = await open(a, 1440, 900, { conversation: false, running: false });
			await shot(idle.page, `${a}-03-connected-idle-1440`);
		});

		it(`${a}: conversation and reasoning`, async () => {
			const { page, session } = await open(a, 1440, 900);
			await toBottom(page);
			await shot(page, `${a}-04-conversation-folded-1440`);
			await showTrace(page, 0);
			await shot(page, `${a}-05-reasoning-one-open-1440`);
			await page.click("[data-testid=reasoning-shown]");
			await showTrace(page, 1);
			await page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[1].click()");
			await shot(page, `${a}-06-reasoning-shown-1440`);
			await page.eval(
				"(() => { const t = document.querySelectorAll('[data-testid=reasoning]')[3]; const s = document.querySelector('.live-scroll'); s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top - 80; })()",
			);
			await shot(page, `${a}-07-reasoning-long-clamped-1440`);
			for (const event of [...tool("c5", "bash"), ...SYNTHETIC_OPEN]) session.live_(event);
			await page.click("[data-testid=follow]");
			await reread(page);
			await page.waitFor("document.querySelector('[data-testid=turn-open]')");
			await toBottom(page);
			await shot(page, `${a}-08-active-tool-and-partial-1440`);
		});

		it(`${a}: high resolution`, async () => {
			const { page } = await open(a, 2560, 1440);
			await page.click("[data-testid=reasoning-shown]");
			await toBottom(page);
			await shot(page, `${a}-09-conversation-2560`);
			if (a === "field") {
				await page.click("[data-testid=dock-toggle]");
				await shot(page, `${a}-09b-focus-2560`);
				await page.resize(1440, 900);
				await page.click("[data-testid=dock-toggle]");
				await page.click("[data-testid=sessions-toggle]");
				await shot(page, `${a}-09c-sessions-drawer-1440`);
			}
		});

		it(`${a}: changes and diff review`, async () => {
			const { page } = await open(a, 1440, 900);
			await page.click("[data-testid=tab-changes]");
			await page.waitFor("document.querySelector('[data-testid=change-row]')");
			await page.eval(
				"[...document.querySelectorAll('[data-testid=change-row]')].find(r => r.querySelector('.change-name').textContent === 'tokenizer.ts').click()",
			);
			await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
			await shot(page, `${a}-10-diff-1440`);
			await page.resize(2560, 1440);
			await shot(page, `${a}-11-diff-2560`);
		});

		it(`${a}: approval pending and broker unreachable`, async () => {
			const { page, approval, server } = await open(a, 1440, 900);
			await page.click("[data-testid=mode-steer]");
			await fill(page, "[data-testid=composer]", "also cover an empty chunk");
			await page.click("[data-testid=send]");
			await approval.waitForRequest();
			await page.waitFor("document.querySelector('[data-testid=intervention-card]')");
			await toBottom(page);
			await shot(page, `${a}-12-approval-pending-1440`);
			approval.answer(null);
			await server.close();
			await page.click("#workbench-refresh");
			await page.waitFor("document.querySelector('[data-testid=run-strip]').dataset.connection === 'unknown'");
			await shot(page, `${a}-13-unreachable-1440`);
		});

		it(`${a}: smaller screens and reduced motion`, async () => {
			const laptop = await open(a, 1366, 768);
			await toBottom(laptop.page);
			await shot(laptop.page, `${a}-14-laptop-1366`);
			const narrow = await open(a, 1180, 820);
			await toBottom(narrow.page);
			await shot(narrow.page, `${a}-15-narrow-laptop-1180`);
			const phone = await open(a, 390, 844);
			await shot(phone.page, `${a}-16-phone-390`);
			await phone.page.eval(
				"document.querySelectorAll('[data-testid=reasoning-toggle]')[0].scrollIntoView({ block: 'center' })",
			);
			await phone.page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[0].click()");
			await shot(phone.page, `${a}-17-phone-reasoning-390`);
			const reduced = await open(a, 1440, 900, { reduced: true });
			await toBottom(reduced.page);
			await shot(reduced.page, `${a}-18-reduced-motion-1440`);
		});
	}
});
