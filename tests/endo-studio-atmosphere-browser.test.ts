// The Field's atmospheres in a real browser (headless Chromium, GPU off): the live broker over a fake Pi session, a real Git repository
// of synthetic content, and the real built page. It holds what docs/develop-atmospheres.md promises: the contours stay the default and
// are untouched; None draws nothing; the weather is requested only when chosen and is one renderer for Rain and Storm; choosing changes
// the drawing and nothing else; motion stops when it should; the lightning can be replayed from a seed with its clock stepped by hand,
// stays within its limits and never whitens the sky; and the page stays inside its policy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { MAX_DROPS, MAX_SKY_CELLS, STORM_LIMITS } from "../studio-ui/src/model/weather.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-atmosphere-browser-"));
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
	cleanGitFixtures();
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null || !haveGit ? describe.skip : describe;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const requested = (page: Page, name: string) =>
	page.seen.requests.filter((url) => new RegExp(`/assets/${name}-[^/]+\\.js$`).test(url));
/** Choose an atmosphere as the operator does: the select's value, then its change event. */
const choose = async (page: Page, atmosphere: string) => {
	await page.eval(
		`(() => { const e = document.querySelector('[data-testid=atmosphere]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, ${JSON.stringify(atmosphere)}); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
	);
	await page.waitFor(
		`document.querySelector('#develop-workspace').dataset.atmosphere === ${JSON.stringify(atmosphere)}`,
	);
	if (atmosphere === "rain" || atmosphere === "storm")
		await page.waitFor(
			"document.querySelector('.weather-rain')?.dataset.state !== 'loading' && document.querySelector('.weather-rain') !== null",
		);
	if (atmosphere === "contours")
		await page.waitFor(
			"document.querySelector('.field-canvas')?.dataset.state !== 'loading' && document.querySelector('.field-canvas') !== null",
		);
};
type Weather = Record<
	| "running"
	| "state"
	| "frames"
	| "cost"
	| "sky"
	| "grid"
	| "pixels"
	| "drops"
	| "falling"
	| "strikes"
	| "level"
	| "alight"
	| "surfaces"
	| "landers"
	| "splashes"
	| "beads"
	| "look"
	| "atmosphere",
	string
>;
const weather = (page: Page) =>
	page.eval<Weather | null>(
		"(() => { const c = document.querySelector('.weather-rain'); return c === null ? null : { ...c.dataset }; })()",
	);
/** The renderer's test controls (read once, when the weather is first chosen): a seed, and optionally a clock stepped by hand. */
const control = (page: Page, value: string) =>
	page.eval(`document.documentElement.dataset.weather = ${JSON.stringify(value)}`);
const step = (page: Page, seconds: number) =>
	page.eval(
		`document.querySelector('.weather-rain').dispatchEvent(new CustomEvent('weather-step', { detail: ${seconds} }))`,
	);
/** Step a frame at a time to the brightest frame of the next stroke at least this strong: how many frames it took, and its level. */
const strike = (page: Page, atLeast: number) =>
	page.eval<{ frames: number; level: number } | null>(
		`(() => { const c = document.querySelector('.weather-rain'); let before = 0; for (let i = 0; i < 30 * 400; i++) { c.dispatchEvent(new CustomEvent('weather-step', { detail: 1 / 30 })); const now = Number(c.dataset.level); if (now >= ${atLeast} && now >= before && Number(c.dataset.alight) > 0) { before = now; continue; } if (before >= ${atLeast}) return { frames: i, level: before }; before = now; } return null; })()`,
	);
/** The brightest channel anywhere in the sky as drawn, and its mean brightness, of 255. */
const skyLight = (page: Page) =>
	page.eval<{ most: number; mean: number }>(
		"(() => { const c = document.querySelector('.weather-sky'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let most = 0; let sum = 0; for (let i = 0; i < d.length; i += 4) { most = Math.max(most, d[i], d[i + 1], d[i + 2]); sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; } return { most, mean: sum / (d.length / 4) }; })()",
	);

const CONVERSATION: [string, string][] = Array.from({ length: 14 }, (_, i) => [
	i % 2 === 0 ? "user" : "assistant",
	`Message ${i + 1}: ${"a sentence of synthetic text that wraps across the reading measure. ".repeat(3)}`,
]);

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
	session.live_({ type: "agent_start", record: {} });
	for (const [role, text] of CONVERSATION) session.live_(textMessage(role, text));
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
	return { server, page };
}
async function readOnly(width: number, height: number) {
	const server = await serve(developStore(), { ui, readBudget: { duty: 1, burstMs: 1e6 } });
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=session-row]')");
	return { server, page };
}
const field = async (page: Page) => {
	await page.click("[data-testid=appearance-field]");
	await page.waitFor(
		"document.querySelector('.field-canvas')?.dataset.state !== 'loading' && document.querySelector('.field-canvas') !== null",
	);
};

suite("the Field's atmospheres", () => {
	it("opens with the contours, exactly as before; the selector is Field's alone, a labelled native select the keyboard can use", async () => {
		const { page, server } = await readOnly(1440, 900);
		// Instrument has no atmosphere and no selector, and asks for neither renderer.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=atmosphere]') === null")).toBe(true);
		expect(
			await page.eval<string | undefined>("document.querySelector('#develop-workspace').dataset.atmosphere"),
		).toBe(undefined);
		expect(requested(page, "FieldCanvas")).toEqual([]);
		expect(requested(page, "WeatherCanvas")).toEqual([]);
		await field(page);
		expect(await page.eval<string>("document.querySelector('[data-testid=atmosphere]').value")).toBe("contours");
		expect(await page.eval<string>("document.querySelector('#develop-workspace').dataset.atmosphere")).toBe(
			"contours",
		);
		expect(
			await page.eval<string[]>(
				"[...document.querySelectorAll('[data-testid=atmosphere] option')].map(o => o.textContent)",
			),
		).toEqual(["None", "Contours", "Rain", "Storm"]);
		// The contours are the renderer they were: drifting on the read-only arrival, with the legend's own words, and no weather loaded.
		await page.waitFor("document.querySelector('.field-canvas').dataset.running === 'true'");
		expect(await page.text("[data-testid=field-words]")).toContain("Read-only: the field drifts on its own");
		expect(requested(page, "FieldCanvas")).toHaveLength(1);
		expect(requested(page, "WeatherCanvas")).toEqual([]);
		expect(await page.eval<number>("document.querySelectorAll('.field-layer canvas').length")).toBe(1);
		// It is a real select with a visible label, in the tab order, apart from the Instrument | Field switch.
		expect(
			await page.eval<boolean>(
				"(() => { const s = document.querySelector('[data-testid=atmosphere]'); return s.tagName === 'SELECT' && s.closest('label').textContent.startsWith('Atmosphere') && s.tabIndex === 0 && !s.disabled && s.closest('[data-testid=appearance]') === null && s.closest('[data-testid=field-legend]') !== null; })()",
			),
		).toBe(true);
		// The keyboard alone changes it: focus, then the arrow keys.
		await page.eval("document.querySelector('[data-testid=atmosphere]').focus()");
		await page.press("ArrowDown");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.atmosphere === 'rain'");
		await page.press("ArrowUp");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.atmosphere === 'contours'");
		expect(
			await page.eval<boolean>("document.activeElement === document.querySelector('[data-testid=atmosphere]')"),
		).toBe(true);
		// The choice is the shell's: it survives leaving DEVELOP and coming back, and Instrument and back.
		await choose(page, "none");
		await page.click("button[data-workspace=observe]");
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=atmosphere]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=atmosphere]').value")).toBe("none");
		await page.click("[data-testid=appearance-instrument]");
		await page.click("[data-testid=appearance-field]");
		expect(await page.eval<string>("document.querySelector('[data-testid=atmosphere]').value")).toBe("none");
		const origin = new URL(server.baseUrl).origin;
		expect(page.seen.requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
		expect(page.seen.problems).toEqual([]);
	});

	it("draws nothing at all for None: no canvas, no frame asked for, no light moving on the horizon, and the page's state still said", async () => {
		const { page } = await live(1440, 900);
		await field(page);
		// A run is open and the page is following it, so under the contours the horizon carries its moving light.
		await page.waitFor("document.querySelector('#develop-workspace').dataset.motion === 'current'");
		const horizon = "getComputedStyle(document.querySelector('.develop-live .run-strip'), '::after').animationName";
		expect(await page.eval<string>(horizon)).toBe("horizon");
		await choose(page, "none");
		expect(await page.eval<number>("document.querySelectorAll('.field-layer canvas').length")).toBe(0);
		expect(await page.eval<number>("document.querySelector('.field-layer').childElementCount")).toBe(0);
		expect(await page.eval<string>("getComputedStyle(document.querySelector('.field-layer')).backgroundImage")).toBe(
			"none",
		);
		expect(await page.eval<string>(horizon)).toBe("none");
		// Nothing asks for a frame once the choice has settled.
		await page.eval(
			"(() => { window.__frames = 0; const ask = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => { window.__frames += 1; return ask(f); }; })()",
		);
		await wait(500);
		expect(await page.eval<number>("window.__frames")).toBe(0);
		// The legend says nothing is drawn and still says what is known; the horizon keeps the state's colour.
		const words = await page.text("[data-testid=field-words]");
		expect(words).toContain("No atmosphere: nothing is drawn behind the work.");
		expect(words).toContain("Pi reports a run open, re-read every few seconds.");
		expect(await page.eval<string>("document.querySelector('#develop-workspace').dataset.motion")).toBe("current");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=field-pause]').disabled")).toBe(true);
		// Everything the page does is still there.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=stop]').disabled")).toBe(false);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=composer]') !== null")).toBe(true);
		expect(requested(page, "WeatherCanvas")).toEqual([]);
		expect(page.seen.problems).toEqual([]);
	});

	it("loads the weather only when it is chosen, once, as one renderer for Rain and Storm, and unloads it for the others", async () => {
		const { page, server } = await readOnly(1440, 900);
		await field(page);
		await choose(page, "rain");
		expect(requested(page, "WeatherCanvas")).toHaveLength(1);
		// Two canvases in a layer hidden from assistive technology and from the pointer; the contours are gone.
		expect(
			await page.eval<string[]>("[...document.querySelectorAll('.field-layer canvas')].map(c => c.className)"),
		).toEqual(["weather-sky", "weather-rain"]);
		expect(
			await page.eval<boolean>(
				"(() => { const l = document.querySelector('.field-layer'); return l.getAttribute('aria-hidden') === 'true' && getComputedStyle(l).pointerEvents === 'none' && l.querySelector('button, a, input, select, [tabindex]') === null; })()",
			),
		).toBe(true);
		// A click where the rain is drawn reaches the page under it, not the canvas.
		expect(await page.eval<boolean>("!['CANVAS'].includes(document.elementFromPoint(700, 700).tagName)")).toBe(true);
		await page.waitFor("document.querySelector('.weather-rain').dataset.running === 'true'");
		expect(await page.text("[data-testid=field-words]")).toMatch(
			/^Field Rain: weather is scenery and shows nothing about the session\. This server only reads/,
		);
		// Storm is the same canvases and the same loop, not a second renderer.
		await page.eval("document.querySelector('.weather-rain').__same = true");
		await choose(page, "storm");
		expect(await page.eval<boolean>("document.querySelector('.weather-rain').__same === true")).toBe(true);
		expect((await weather(page))?.atmosphere).toBe("storm");
		expect(requested(page, "WeatherCanvas")).toHaveLength(1);
		expect(await page.text("[data-testid=field-words]")).toMatch(/^Field Storm: weather is scenery/);
		// Back to the contours: the weather's canvases are gone, and the contours run as they did.
		await choose(page, "contours");
		expect(await page.eval<boolean>("document.querySelector('.weather-rain') === null")).toBe(true);
		await page.waitFor("document.querySelector('.field-canvas').dataset.running === 'true'");
		await choose(page, "storm");
		expect(requested(page, "WeatherCanvas")).toHaveLength(1);
		// Instrument: no layer at all.
		await page.click("[data-testid=appearance-instrument]");
		expect(await page.eval<boolean>("document.querySelector('.field-layer') === null")).toBe(true);
		const origin = new URL(server.baseUrl).origin;
		expect(page.seen.requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
		expect(page.seen.problems).toEqual([]);
	});

	it("changes the drawing and nothing else: the draft, the open file, the view and the conversation's place stay through every atmosphere", async () => {
		const { page } = await live(1440, 900);
		await field(page);
		await page.waitFor(
			"document.querySelectorAll('[data-testid=transcript] [data-testid^=turn-]').length >= 14 && (() => { const s = document.querySelector('.live-scroll'); return s.scrollHeight > s.clientHeight + 200; })()",
		);
		// The operator is part-way up the conversation, with a draft.
		await page.eval(
			"(() => { const s = document.querySelector('.live-scroll'); s.scrollTop = 120; s.dispatchEvent(new Event('scroll')); })()",
		);
		await fill(page, "[data-testid=composer]", "keep this draft");
		const session = await page.text("[data-testid=run-strip] .run-session, [data-testid=run-strip] strong");
		for (const atmosphere of ["rain", "storm", "none", "contours", "storm"]) {
			await choose(page, atmosphere);
			expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value"), atmosphere).toBe(
				"keep this draft",
			);
			expect(await page.eval<number>("document.querySelector('.live-scroll').scrollTop"), atmosphere).toBe(120);
			expect(await page.eval<string>("document.querySelector('#develop-live').dataset.view"), atmosphere).toBe(
				"conversation",
			);
			expect(
				await page.text("[data-testid=run-strip] .run-session, [data-testid=run-strip] strong"),
				atmosphere,
			).toBe(session);
			expect(await page.eval<number>("document.querySelectorAll('[data-testid=stop]').length")).toBe(1);
		}
		// And while a file is being read: the diff and the Changes view stay.
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=change-row]')].find(r => r.querySelector('.change-name').textContent === 'tokenizer.ts').click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		const title = await page.text("[data-testid=diff-view] .diff-title");
		for (const atmosphere of ["rain", "none", "contours", "storm"]) {
			await choose(page, atmosphere);
			expect(await page.eval<string>("document.querySelector('#develop-live').dataset.view"), atmosphere).toBe(
				"changes",
			);
			expect(await page.text("[data-testid=diff-view] .diff-title"), atmosphere).toBe(title);
			expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value"), atmosphere).toBe(
				"keep this draft",
			);
		}
		// The weather does not still itself for reading, because it says nothing; the page's state is unchanged by it.
		expect(await page.eval<string>("document.querySelector('#develop-workspace').dataset.surface")).toBe("changes");
		await page.click("[data-testid=tab-conversation]");
		expect(await page.eval<number>("document.querySelector('.live-scroll').scrollTop")).toBe(120);
		// The page does not scroll or run sideways with the legend's new control in it.
		expect(
			await page.eval<boolean>(
				"document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth",
			),
		).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("stops the weather when the operator pauses it and under reduced motion, where it is one still frame with no lightning", async () => {
		const { page } = await readOnly(1280, 800);
		await field(page);
		await control(page, "seed:42");
		await choose(page, "storm");
		await page.waitFor("document.querySelector('.weather-rain').dataset.running === 'true'");
		await page.waitFor("Number(document.querySelector('.weather-rain').dataset.frames) > 16");
		await page.click("[data-testid=field-pause]");
		await page.waitFor("document.querySelector('.weather-rain').dataset.running === 'false'");
		const paused = await weather(page);
		expect(paused?.state).toBe("still");
		// A paused sky holds no lightning and no water in mid-air.
		expect(paused).toMatchObject({ alight: "0", level: "0.000", landers: "0", splashes: "0", beads: "0" });
		await wait(500);
		expect((await weather(page))?.frames).toBe(paused?.frames);
		expect(await page.text("[data-testid=field-words]")).toMatch(/^Field Storm, paused by you: /);
		await page.click("[data-testid=field-pause]");
		await page.waitFor("document.querySelector('.weather-rain').dataset.running === 'true'");

		const reduced = await readOnly(1280, 800);
		await reduced.page.reducedMotion();
		await reduced.page.click("[data-testid=appearance-field]");
		await control(reduced.page, "seed:42");
		await choose(reduced.page, "storm");
		await reduced.page.waitFor("document.querySelector('.weather-rain').dataset.state === 'still'");
		const still = await weather(reduced.page);
		// Long enough for this seed's first stroke to have come, had the clock been running.
		await wait(900);
		const later = await weather(reduced.page);
		expect(later?.frames).toBe(still?.frames);
		expect(later).toMatchObject({ running: "false", strikes: "0", alight: "0", level: "0.000" });
		// The still frame is a sky, not a blank: clouds were drawn, dark.
		const light = await skyLight(reduced.page);
		expect(light.most).toBeGreaterThan(20);
		expect(light.most).toBeLessThan(110);
		expect(await reduced.page.text("[data-testid=field-words]")).toMatch(
			/^Field Storm, drawn once and still \(your system asks for reduced motion\): /,
		);
		expect(await reduced.page.eval<boolean>("document.querySelector('[data-testid=field-pause]').disabled")).toBe(
			true,
		);
		expect(reduced.page.seen.problems).toEqual([]);
	});

	it("replays a storm from a seed with the clock stepped by hand: the same strokes, within every limit, and a sky that never whitens", async () => {
		const first = await live(1440, 900);
		await field(first.page);
		await control(first.page, "seed:20261114,clock:manual");
		await choose(first.page, "storm");
		// With the clock in hand nothing runs by itself.
		expect(await weather(first.page)).toMatchObject({ running: "false", state: "manual", strikes: "0" });
		await wait(300);
		expect((await weather(first.page))?.strikes).toBe("0");
		const dark = await skyLight(first.page);
		const a = await strike(first.page, 0.3);
		expect(a).not.toBeNull();
		const lit = await skyLight(first.page);
		// The stroke is light, and local: the sky's brightest point rises, its mean stays a dark sky's, and nothing nears white.
		expect(lit.most).toBeGreaterThan(dark.most + 15);
		expect(lit.most).toBeLessThanOrEqual(201);
		expect(lit.mean).toBeLessThan(40);
		expect(lit.mean - dark.mean).toBeLessThan(18);
		const held = await weather(first.page);
		expect(Number(held?.alight)).toBeGreaterThanOrEqual(1);
		expect(Number(held?.alight)).toBeLessThanOrEqual(STORM_LIMITS.maxStrokes);
		// The panels were measured for it: some, and never more than ten.
		expect(Number(held?.surfaces)).toBeGreaterThan(0);
		expect(Number(held?.surfaces)).toBeLessThanOrEqual(10);
		// The same seed in another page gives the same stroke at the same frame.
		const second = await live(1440, 900);
		await field(second.page);
		await control(second.page, "seed:20261114,clock:manual");
		await choose(second.page, "storm");
		expect(await strike(second.page, 0.3)).toEqual(a);
		// Ten minutes of storm, a frame at a time: every count stays inside its bound.
		let most = 0;
		for (let i = 0; i < 20; i++) {
			await step(first.page, 30);
			const now = await weather(first.page);
			most = Math.max(most, (await skyLight(first.page)).most);
			expect(Number(now?.drops)).toBeLessThanOrEqual(MAX_DROPS);
			expect(Number(now?.falling)).toBeLessThanOrEqual(Number(now?.drops));
			expect(Number(now?.alight)).toBeLessThanOrEqual(3);
			expect(Number(now?.landers)).toBeLessThanOrEqual(4);
			expect(Number(now?.splashes)).toBeLessThanOrEqual(24);
			expect(Number(now?.beads)).toBeLessThanOrEqual(3);
			expect(Number(now?.surfaces)).toBeLessThanOrEqual(10);
			const [cols, rows] = (now?.grid ?? "0x0").split("x").map(Number);
			expect(cols! * rows!).toBeLessThanOrEqual(MAX_SKY_CELLS);
			expect(Number(now?.pixels)).toBeLessThanOrEqual(4_000_000);
		}
		expect(most).toBeLessThanOrEqual(201);
		const after = await weather(first.page);
		// Strokes came, and no more than the model's limit of five events of three strokes a minute.
		expect(Number(after?.strikes)).toBeGreaterThan(3);
		expect(Number(after?.strikes)).toBeLessThanOrEqual(
			11 * STORM_LIMITS.maxEventsPerMinute * STORM_LIMITS.maxStrokes,
		);
		// Parallax: the cloud layers ease after a mouse (never a finger), and settle back when it leaves the window.
		const pointer = (type: string, x: number) =>
			second.page.eval(
				`window.dispatchEvent(new PointerEvent('pointermove', { clientX: ${x}, clientY: 450, pointerType: '${type}' }))`,
			);
		expect((await weather(second.page))?.look).toBe("0.000,0.000");
		await pointer("touch", 4);
		await step(second.page, 3);
		expect((await weather(second.page))?.look).toBe("0.000,0.000");
		await pointer("mouse", 4);
		await step(second.page, 1 / 30);
		const begun = Number((await weather(second.page))?.look.split(",")[0]);
		expect(begun).toBeLessThan(0);
		expect(begun).toBeGreaterThan(-0.05);
		await step(second.page, 8);
		expect(Number((await weather(second.page))?.look.split(",")[0])).toBeLessThan(-0.98);
		await second.page.eval("document.documentElement.dispatchEvent(new PointerEvent('pointerleave'))");
		await step(second.page, 8);
		expect((await weather(second.page))?.look).toBe("0.000,0.000");
		// Rain has no lightning in it, however long it runs.
		const rain = await live(1440, 900);
		await field(rain.page);
		await control(rain.page, "seed:20261114,clock:manual");
		await choose(rain.page, "rain");
		await step(rain.page, 300);
		expect(await weather(rain.page)).toMatchObject({ strikes: "0", alight: "0", level: "0.000" });
		// (Chromium remarks on this test's own reading back of the sky's pixels; that is the test's doing, not the page's.)
		for (const page of [first.page, second.page, rain.page])
			expect(page.seen.problems.filter((problem) => !/willReadFrequently/.test(problem))).toEqual([]);
	});

	it("runs live at no more than thirty frames a second, strikes without being stepped, and stays cheap at 1440, 2560 and 4K", async () => {
		const costs: string[] = [];
		for (const [w, h] of [
			[1440, 900],
			[2560, 1440],
			[3840, 2160],
		] as const) {
			const { page } = await live(w, h);
			await field(page);
			// Seed 5: its first stroke comes a little over five seconds in.
			await control(page, "seed:5");
			await choose(page, "storm");
			await page.waitFor("document.querySelector('.weather-rain').dataset.running === 'true'");
			await page.waitFor("Number(document.querySelector('.weather-rain').dataset.frames) > 30");
			const from = Number((await weather(page))?.frames);
			await wait(2000);
			const now = await weather(page);
			// The counter is written every fifteenth frame, so allow that much slack around sixty frames in two seconds.
			expect(Number(now?.frames) - from, `${w}`).toBeLessThanOrEqual(76);
			expect(Number(now?.frames) - from, `${w}`).toBeGreaterThan(8);
			if (w === 1440) {
				await page.waitFor("Number(document.querySelector('.weather-rain').dataset.strikes) >= 1", 20_000);
				expect(Number((await weather(page))?.strikes)).toBeGreaterThanOrEqual(1);
			}
			const end = await weather(page);
			costs.push(
				`${w}x${h}: frame ${end?.cost} ms, sky ${end?.sky} ms, grid ${end?.grid}, canvas ${end?.pixels} px, drops ${end?.drops}`,
			);
			// Software rasterising with the GPU off, on a shared machine: a loose ceiling, there to catch a renderer that has lost its bounds.
			expect(Number(end?.cost), `${w}`).toBeLessThan(16);
			expect(Number(end?.pixels), `${w}`).toBeLessThanOrEqual(4_000_000);
			expect(Number(end?.drops), `${w}`).toBeLessThanOrEqual(MAX_DROPS);
			expect(page.seen.problems).toEqual([]);
			await stopServers();
		}
		if (process.env.ENDO_SHOTS_DIR) process.stdout.write(`\nweather cost (headless, GPU off)\n${costs.join("\n")}\n`);
	}, 90_000);

	it("keeps the conversation, the composer and STOP when the weather's file cannot be loaded", async () => {
		const { page } = await live(1440, 900);
		await field(page);
		await page.block(["*WeatherCanvas-*"]);
		await fill(page, "[data-testid=composer]", "still here");
		await page.eval(
			"(() => { const e = document.querySelector('[data-testid=atmosphere]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'storm'); e.dispatchEvent(new Event('change', { bubbles: true })); })()",
		);
		await page.waitFor("document.querySelector('#develop-workspace').dataset.atmosphere === 'storm'");
		await wait(500);
		// The weather is left out; nothing else is.
		expect(await page.eval<number>("document.querySelectorAll('.field-layer canvas').length")).toBe(0);
		expect(await page.text("#develop-workspace")).not.toContain("could not be displayed");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("still here");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=stop]').disabled")).toBe(false);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=turn-user]').length")).toBeGreaterThan(0);
		for (const problem of page.seen.problems)
			expect(problem).toMatch(/WeatherCanvas|ERR_BLOCKED|dynamically imported module/);
		// The contours still work beside a weather that would not load.
		await choose(page, "contours");
		expect(await page.eval<number>("document.querySelectorAll('.field-layer canvas').length")).toBe(1);
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("still here");
	});

	it("fits a phone: the legend wraps, the selector stays reachable, and nothing runs sideways", async () => {
		const { page } = await live(390, 844);
		await page.click("[data-testid=appearance-field]");
		await page.waitFor("document.querySelector('[data-testid=atmosphere]')");
		for (const atmosphere of ["rain", "none", "contours"]) {
			await choose(page, atmosphere);
			expect(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth"), atmosphere).toBe(
				true,
			);
			expect(
				await page.eval<boolean>(
					"(() => { const r = document.querySelector('[data-testid=atmosphere]').getBoundingClientRect(); return r.width > 40 && r.left >= 0 && r.right <= window.innerWidth; })()",
				),
				atmosphere,
			).toBe(true);
		}
		expect(page.seen.problems).toEqual([]);
	});
});
