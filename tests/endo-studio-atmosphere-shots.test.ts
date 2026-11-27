// Screenshots of the Field atmospheres for visual review, opt-in:
//   ENDO_SHOTS_DIR=/some/dir npx vitest --run tests/endo-studio-atmosphere-shots.test.ts
// Real browser (headless Chromium, GPU off), real broker, real Git, the real built page; the conversation and the repository are
// SYNTHETIC. The weather is seeded and its clock is stepped by hand (the renderer's test controls, docs/develop-atmospheres.md §7), so
// a stroke of lightning can be held at its brightest frame: every capture named "strike" is that, a frame that lasts about a thirtieth
// of a second in use. It asserts only that each state was reached; the behaviour is pinned by tests/endo-studio-atmosphere-browser.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { SYNTHETIC_CONVERSATION } from "./develop-reasoning-fixtures.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const out = process.env.ENDO_SHOTS_DIR ?? "";
const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-atmosphere-shots-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
beforeAll(async () => {
	if (out === "" || executable === null) return;
	mkdirSync(out, { recursive: true });
	const { ensureSharedStudioUiDir } = await import("./helpers/studio-ui-build.ts");
	ui = loadEndoStudioUiFilesV0(await ensureSharedStudioUiDir());
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
	await new Promise((r) => setTimeout(r, 250));
	writeFileSync(join(out, `${name}.png`), await page.screenshot());
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
/** Choose an atmosphere as the operator does: the select's value, then its change event. */
const choose = async (page: Page, atmosphere: string) => {
	await page.eval(
		`(() => { const e = document.querySelector('[data-testid=atmosphere]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(atmosphere)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
	);
	if (atmosphere === "rain" || atmosphere === "storm")
		await page.waitFor(
			"document.querySelector('.weather-rain') !== null && document.querySelector('.weather-rain').dataset.state !== 'loading'",
		);
};
/** Seed the weather and take its clock, before it is first chosen. */
const control = (page: Page, seed: number) =>
	page.eval(`document.documentElement.dataset.weather = 'seed:${seed},clock:manual'`);
const step = (page: Page, seconds: number) =>
	page.eval(
		`document.querySelector('.weather-rain').dispatchEvent(new CustomEvent('weather-step', { detail: ${seconds} }))`,
	);
/** Step a frame at a time to the brightest frame of the next stroke at least this strong. Returns its level, or null if none came. */
const strike = (page: Page, atLeast = 0.3) =>
	page.eval<number | null>(
		`(() => { const c = document.querySelector('.weather-rain'); let before = 0; for (let i = 0; i < 30 * 400; i++) { c.dispatchEvent(new CustomEvent('weather-step', { detail: 1 / 30 })); const now = Number(c.dataset.level); if (now >= ${atLeast} && now >= before && Number(c.dataset.alight) > 0) { before = now; continue; } if (before >= ${atLeast}) return before; before = now; } return null; })()`,
	);

async function live(width: number, height: number) {
	const session = new FakeSession();
	session.runActive = true;
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
	for (const event of SYNTHETIC_CONVERSATION) session.live_(event);
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
	await page.click("[data-testid=appearance-field]");
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	await page.waitFor("document.querySelectorAll('[data-testid=reasoning]').length >= 5");
	await page.eval(
		"(() => { const s = document.querySelector('.live-scroll'); if (s) { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); } })()",
	);
	return { page };
}
async function readOnly(width: number, height: number) {
	const server = await serve(developStore(), { ui, readBudget: { duty: 1, burstMs: 1e6 } });
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=session-row]')");
	await page.click("[data-testid=appearance-field]");
	return { page };
}

const SEED = Number(process.env.ENDO_WEATHER_SEED ?? 20261114);

describe.runIf(out !== "" && executable !== null && haveGit)(
	"Field atmospheres, screenshots (synthetic fixtures)",
	() => {
		it("the arrival: none, contours, rain, and a storm held at a stroke", async () => {
			const { page } = await readOnly(1440, 900);
			await page.waitFor("document.querySelector('.field-canvas')?.dataset.state !== 'loading'");
			await shot(page, "atmosphere-arrival-contours-1440");
			await choose(page, "none");
			await shot(page, "atmosphere-arrival-none-1440");
			await control(page, SEED);
			await choose(page, "rain");
			await step(page, 6);
			await shot(page, "atmosphere-arrival-rain-1440");
			await choose(page, "storm");
			expect(await strike(page)).not.toBeNull();
			await shot(page, "atmosphere-arrival-storm-strike-1440");
			await step(page, 0.2);
			await shot(page, "atmosphere-arrival-storm-fading-1440");
			await step(page, 3);
			await shot(page, "atmosphere-arrival-storm-dark-1440");
		});

		it("a live conversation: rain, and a storm held at a stroke", async () => {
			const { page } = await live(1440, 900);
			await control(page, SEED);
			await choose(page, "rain");
			await step(page, 9);
			await shot(page, "atmosphere-conversation-rain-1440");
			await choose(page, "storm");
			expect(await strike(page)).not.toBeNull();
			await shot(page, "atmosphere-conversation-storm-strike-1440");
			expect(await strike(page, 0.2)).not.toBeNull();
			await shot(page, "atmosphere-conversation-storm-strike-2-1440");
			await choose(page, "none");
			await shot(page, "atmosphere-conversation-none-1440");
		});

		it("larger and smaller windows", async () => {
			const wide = await live(2560, 1440);
			await control(wide.page, SEED);
			await choose(wide.page, "storm");
			await wide.page.click("[data-testid=dock-toggle]");
			await step(wide.page, 4);
			await shot(wide.page, "atmosphere-focus-storm-dark-2560");
			expect(await strike(wide.page)).not.toBeNull();
			await shot(wide.page, "atmosphere-focus-storm-strike-2560");
			const uhd = await live(3840, 2160);
			await control(uhd.page, SEED);
			await choose(uhd.page, "storm");
			expect(await strike(uhd.page)).not.toBeNull();
			await shot(uhd.page, "atmosphere-conversation-storm-strike-3840");
			const laptop = await live(1366, 768);
			await control(laptop.page, SEED);
			await choose(laptop.page, "storm");
			expect(await strike(laptop.page)).not.toBeNull();
			await shot(laptop.page, "atmosphere-conversation-storm-strike-1366");
			const phone = await live(390, 844);
			await control(phone.page, SEED);
			await choose(phone.page, "rain");
			await step(phone.page, 5);
			await shot(phone.page, "atmosphere-conversation-rain-390");
		});

		it("the scene alone, with the page hidden by the test (never seen like this in use)", async () => {
			const { page } = await readOnly(1440, 900);
			await control(page, SEED);
			await choose(page, "storm");
			await page.eval(
				"(() => { for (const e of document.querySelectorAll('.develop > :not(.field-layer), .topbar')) e.style.visibility = 'hidden'; document.querySelector('.field-layer').style.opacity = '1'; })()",
			);
			await step(page, 5);
			await shot(page, "atmosphere-scene-alone-dark-1440");
			for (let i = 1; i <= 3; i++) {
				expect(await strike(page, 0.25)).not.toBeNull();
				await shot(page, `atmosphere-scene-alone-strike-${i}-1440`);
			}
			// Parallax: the same sky with the pointer at the left edge and then at the right. The near masses shift most, the far bank least.
			await step(page, 4);
			for (const [name, x] of [
				["left", 4],
				["right", 1420],
			] as const) {
				await page.eval(
					`window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: 450, pointerType: 'mouse' }))`,
				);
				await step(page, 5);
				await shot(page, `atmosphere-scene-alone-pointer-${name}-1440`);
			}
		});

		it("reduced motion: one still frame, no lightning", async () => {
			const { page } = await readOnly(1440, 900);
			await page.reducedMotion();
			await choose(page, "storm");
			await page.waitFor("document.querySelector('.weather-rain').dataset.state === 'still'");
			await shot(page, "atmosphere-arrival-storm-reduced-1440");
		});
	},
);
