// The Field appearance of DEVELOP in a real browser (headless Chromium, GPU off): the live broker over a fake Pi session, a real Git
// repository of synthetic content, and the real built page. It holds what docs/develop-field.md promises: Instrument stays the default
// and never loads the renderer; switching changes the drawing and nothing else (the draft, the file being read, the conversation's
// place); the arrival offers only the page's real controls; an approval is shown as the terminal's; the field stops when it should; and
// the page stays inside its policy. Set ENDO_SHOTS_DIR to also write screenshots (synthetic fixtures only).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-field-browser-"));
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

const shot = async (page: Page, name: string) => {
	const dir = process.env.ENDO_SHOTS_DIR;
	if (dir !== undefined && dir !== "") writeFileSync(join(dir, `${name}.png`), await page.screenshot());
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const renderer = (page: Page) => page.seen.requests.filter((url) => /\/assets\/FieldCanvas-[^/]+\.js$/.test(url));
const canvas = (page: Page) =>
	page.eval<{ running?: string; state?: string; frames?: string } | null>(
		"(() => { const c = document.querySelector('.field-canvas'); return c === null ? null : { ...c.dataset }; })()",
	);
const field = async (page: Page) => {
	await page.click("[data-testid=appearance-field]");
	await page.waitFor(
		"document.querySelector('.field-canvas')?.dataset.state !== 'loading' && document.querySelector('.field-canvas') !== null",
	);
};

const CONVERSATION: [string, string][] = Array.from({ length: 14 }, (_, i) => [
	i % 2 === 0 ? "user" : "assistant",
	`Message ${i + 1}: ${"a sentence of synthetic text that wraps across the reading measure. ".repeat(3)}`,
]);

async function live(
	width: number,
	height: number,
	options: { pair?: boolean; running?: boolean; empty?: boolean } = {},
) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const source = new GitProjectInspectorV0({ cwd: demoRepo(), minRefreshMs: 0 });
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		project: source,
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	if (options.empty !== true) {
		session.live_({ type: "agent_start", record: {} });
		for (const [role, text] of CONVERSATION) session.live_(textMessage(role, text));
	}
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
	if (options.pair !== false) {
		await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[data-testid=composer]')");
	}
	return { session, desk, broker, server, page, approval };
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

suite("DEVELOP drawn as Field", () => {
	it("is not the default: Instrument draws no field and never requests the renderer, and the switch is on DEVELOP only", async () => {
		const { page, server } = await live(1440, 900);
		expect(await page.eval<string>("document.querySelector('#develop-workspace').dataset.appearance")).toBe(
			"instrument",
		);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=appearance-instrument]').checked")).toBe(
			true,
		);
		expect(await page.eval<boolean>("document.querySelector('.field-layer') === null")).toBe(true);
		expect(renderer(page)).toEqual([]);
		await page.click("button[data-workspace=observe]");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=appearance]') === null")).toBe(true);
		await page.click("button[data-workspace=develop]");
		await field(page);
		// The renderer is one file, asked for once, from the page's own assets.
		expect(renderer(page)).toHaveLength(1);
		await page.click("[data-testid=appearance-instrument]");
		await page.click("[data-testid=appearance-field]");
		expect(renderer(page)).toHaveLength(1);
		// Everything the page asked for, the renderer included, came from the server that served it.
		const origin = new URL(server.baseUrl).origin;
		expect(page.seen.requests.filter((url) => new URL(url).origin !== origin)).toEqual([]);
		expect(page.seen.problems).toEqual([]);
	});

	it("switches the drawing and nothing else: the draft, the open file, the Changes view and the conversation's place all stay", async () => {
		const { page } = await live(1440, 900);
		// The operator has scrolled up the conversation (once all of it has arrived: a short one is at its top and its bottom at once),
		// typed a draft, and is reading a file.
		await page.waitFor(
			"document.querySelectorAll('[data-testid=transcript] [data-testid^=turn-]').length >= 14 && (() => { const s = document.querySelector('.live-scroll'); return s.scrollHeight > s.clientHeight + 200; })()",
		);
		await page.eval(
			"(() => { const s = document.querySelector('.live-scroll'); s.scrollTop = 0; s.dispatchEvent(new Event('scroll')); })()",
		);
		await fill(page, "[data-testid=composer]", "keep this draft");
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=change-row]')].find(r => r.querySelector('.change-name').textContent === 'tokenizer.ts').click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		const before = await page.text("[data-testid=diff-view] .diff-title");
		for (const appearance of ["field", "instrument", "field"]) {
			await page.click(`[data-testid=appearance-${appearance}]`);
			expect(await page.eval<string>("document.querySelector('#develop-live').dataset.view")).toBe("changes");
			expect(await page.text("[data-testid=diff-view] .diff-title")).toBe(before);
			expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
				"keep this draft",
			);
			expect(await page.eval<number>("document.querySelectorAll('[data-testid=stop]').length")).toBe(1);
		}
		// Reading changes stills the field.
		await page.waitFor("document.querySelector('.field-canvas')?.dataset.running === 'false'");
		expect(await page.eval<string>("document.querySelector('#develop-workspace').dataset.surface")).toBe("changes");
		expect(await page.text("[data-testid=field-words]")).toContain("Still while you read changes");
		// Back in the conversation, the place the operator scrolled to is kept (not pulled to the newest item).
		await page.click("[data-testid=tab-conversation]");
		expect(await page.eval<number>("document.querySelector('.live-scroll').scrollTop")).toBeLessThan(40);
		await shot(page, "field-conversation-1440");
		expect(page.seen.problems).toEqual([]);
	});

	it("keeps the working layout: the page does not scroll, the composer is docked and STOP is in view, at desktop and laptop widths", async () => {
		for (const [w, h] of [
			[1920, 1080],
			[1440, 900],
			[1366, 768],
			[1024, 768],
		] as const) {
			const { page } = await live(w, h);
			await field(page);
			expect(
				await page.eval<boolean>("document.documentElement.scrollHeight <= window.innerHeight + 1"),
				`${w}`,
			).toBe(true);
			expect(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth"), `${w}`).toBe(
				true,
			);
			expect(
				await page.eval<boolean>(
					"(() => { const r = document.querySelector('form.composer').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top > window.innerHeight / 2; })()",
				),
				`${w}`,
			).toBe(true);
			expect(
				await page.eval<boolean>(
					"(() => { const r = document.querySelector('[data-testid=stop]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0; })()",
				),
				`${w}`,
			).toBe(true);
			if (w === 1366) await shot(page, "field-conversation-1366");
			await stopServers();
		}
	});

	it("does not run sideways on a narrow screen, in either appearance", async () => {
		for (const [w, h] of [
			[768, 1024],
			[420, 860],
			[360, 760],
		] as const) {
			const { page } = await live(w, h);
			for (const appearance of ["instrument", "field"]) {
				await page.click(`[data-testid=appearance-${appearance}]`);
				expect(
					await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth"),
					`${w} ${appearance}`,
				).toBe(true);
			}
			if (w === 420) await shot(page, "field-conversation-420");
			await stopServers();
		}
		const { page } = await readOnly(390, 844);
		await field(page);
		expect(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
		await shot(page, "field-arrival-390");
	});

	it("on a read-only server, arrives with the ledger and no input of any kind; the field drifts and says it shows no activity", async () => {
		const { page } = await readOnly(1440, 900);
		await field(page);
		expect(await page.text("[data-testid=arrival-statement]")).toBe("Nothing is attached here.");
		expect(await page.text("[data-testid=ledger]")).toContain("recorded sessions in this store");
		expect(await page.eval<number>("document.querySelectorAll('textarea, [data-testid=pair-code]').length")).toBe(0);
		await page.waitFor("Number(document.querySelector('.field-canvas')?.dataset.frames ?? 0) > 2", 8000);
		expect(await page.text("[data-testid=field-words]")).toContain("it shows no activity");
		await shot(page, "field-arrival-readonly-1440");
		// Opening a recording stills the field: a recording is not a live process.
		await page.eval("document.querySelector('button[data-testid=session-row]').click()");
		await page.waitFor("document.querySelector('[data-testid=activity-title]')");
		await page.waitFor("document.querySelector('.field-canvas')?.dataset.running === 'false'");
		expect(await page.text("[data-testid=field-words]")).toContain("Nothing recorded is live");
		expect(page.seen.problems).toEqual([]);
	});

	it("on an unpaired workbench, the only input in the arrival is the real pairing form", async () => {
		const { page } = await live(1440, 900, { pair: false, empty: true });
		await field(page);
		expect(await page.text("[data-testid=arrival-statement]")).toContain("is connected");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=pair-code]').length")).toBe(1);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=composer]').length")).toBe(0);
		expect(await page.text("[data-testid=ledger]")).toContain("Pair this page");
		await shot(page, "field-arrival-unpaired-1440");
	});

	it("shows a request waiting for approval as the terminal's: a beacon of text, no control, the field held", async () => {
		const { page, approval } = await live(1440, 900);
		await field(page);
		await page.click("[data-testid=mode-steer]");
		await fill(page, "[data-testid=composer]", "also cover an empty chunk");
		await page.click("[data-testid=send]");
		await approval.waitForRequest();
		await page.waitFor("document.querySelector('[data-testid=field-beacon]')");
		const beacon = await page.text("[data-testid=field-beacon]");
		expect(beacon).toContain("Waiting for you in the attached terminal");
		expect(beacon).toContain("This page cannot approve it");
		expect(
			await page.eval<number>(
				"document.querySelectorAll('[data-testid=field-beacon] button, [data-testid=field-beacon] a').length",
			),
		).toBe(0);
		expect(await page.eval<string>("document.querySelector('.field-layer').dataset.motion")).toBe("held");
		expect(await page.text("[data-testid=field-words]")).toContain(
			"waits for your approval in the attached terminal",
		);
		// STOP is still there to be requested, and the withdraw on the card is the page's own.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=stop]').disabled")).toBe(false);
		await shot(page, "field-approval-1440");
		approval.answer("deny");
		await page.waitFor("document.querySelector('[data-testid=field-beacon]') === null");
		expect(page.seen.problems).toEqual([]);
	});

	it("stops drawing when the operator pauses it, and never moves under reduced motion", async () => {
		const { page } = await readOnly(1280, 800);
		await field(page);
		await page.waitFor("document.querySelector('.field-canvas').dataset.running === 'true'");
		await page.click("[data-testid=field-pause]");
		await page.waitFor("document.querySelector('.field-canvas').dataset.running === 'false'");
		const frames = Number((await canvas(page))?.frames);
		await new Promise((r) => setTimeout(r, 400));
		expect(Number((await canvas(page))?.frames)).toBe(frames);
		expect(await page.text("[data-testid=field-words]")).toMatch(/^Field Paused by you\./);
		await page.click("[data-testid=field-pause]");
		await page.waitFor("document.querySelector('.field-canvas').dataset.running === 'true'");

		const reduced = await readOnly(1280, 800);
		await reduced.page.reducedMotion();
		await field(reduced.page);
		await reduced.page.waitFor("document.querySelector('.field-canvas').dataset.state === 'still'");
		const still = Number((await canvas(reduced.page))?.frames);
		await new Promise((r) => setTimeout(r, 400));
		expect(Number((await canvas(reduced.page))?.frames)).toBe(still);
		expect(await reduced.page.eval<boolean>("document.querySelector('[data-testid=field-pause]').disabled")).toBe(
			true,
		);
	});

	it("draws an unreachable broker broken, not ended", async () => {
		const { page, server } = await live(1440, 900);
		await field(page);
		await server.close();
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('.field-layer')?.dataset.texture === 'dashed'");
		expect(await page.text("[data-testid=field-words]")).toContain("unreachable is not ended");
	});
});
