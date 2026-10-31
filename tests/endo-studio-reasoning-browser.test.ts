// Model-provided reasoning in a real browser (headless Chromium, GPU off), through the real broker and the real built page, in both
// appearances: folded by default and discoverable; the Shown preference; a trace opened or folded by hand; the keyboard; a long trace
// clamped and shown whole; the message being written, replaced by the completed one with the operator's choice carried across; the
// reader's place kept when a trace is opened and something arrives; the draft untouched by any of it; the preference never sent anywhere.
// The conversation is synthetic (tests/develop-reasoning-fixtures.ts).
import { mkdtempSync, rmSync } from "node:fs";
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
import {
	assistant,
	LONG_TRACE,
	SYNTHETIC_CONVERSATION,
	SYNTHETIC_OPEN,
	thinkingDelta,
	user,
} from "./develop-reasoning-fixtures.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-reasoning-browser-"));
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
const suite = executable === null ? describe.skip : describe;

const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const expanded = (page: Page) =>
	page.eval<(string | null)[]>(
		"[...document.querySelectorAll('[data-testid=reasoning-toggle]')].map((b) => b.getAttribute('aria-expanded'))",
	);
/** Read the session again and wait until the read has finished. */
const reread = async (page: Page) => {
	await page.click("#workbench-refresh");
	await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
};

async function live(appearance: "instrument" | "field", width = 1440, height = 900, withProject = false) {
	const session = new FakeSession();
	session.runActive = true;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: new Approval().approver,
		interventions: new FakeDesk(session),
		...(withProject ? { project: new GitProjectInspectorV0({ cwd: demoRepo(), minRefreshMs: 0 }) } : {}),
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	for (const event of SYNTHETIC_CONVERSATION) session.live_(event);
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=live-row]')");
	if (appearance === "field") await page.click("[data-testid=appearance-field]");
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelectorAll('[data-testid=reasoning]').length >= 5");
	return { session, broker, page };
}

for (const appearance of ["instrument", "field"] as const) {
	suite(`model-provided reasoning (${appearance})`, () => {
		it("is folded by default and discoverable: labelled, sized, with a preview, the withheld one said to be withheld", async () => {
			const { page } = await live(appearance);
			expect(await expanded(page)).toEqual(["false", "false", "false", "false"]);
			const heads = await page.eval<string[]>(
				"[...document.querySelectorAll('[data-testid=reasoning]')].map((r) => r.textContent)",
			);
			expect(heads).toHaveLength(5);
			for (const head of heads) expect(head).toContain("Model-provided reasoning");
			expect(heads[1]).toContain("1 of 2");
			expect(heads[4]).toContain("withheld by the provider");
			// The withheld trace offers nothing to open.
			expect(
				await page.eval<boolean>(
					"document.querySelectorAll('[data-testid=reasoning]')[4].querySelector('button') === null",
				),
			).toBe(true);
			// Folded traces draw no body at all; the preview is visual only.
			expect(await page.eval<number>("document.querySelectorAll('[data-testid=reasoning-text]').length")).toBe(0);
			expect(
				await page.eval<boolean>(
					"[...document.querySelectorAll('.reasoning-preview')].every((p) => p.getAttribute('aria-hidden') === 'true')",
				),
			).toBe(true);
			// A turn without reasoning shows none.
			expect(
				await page.eval<number>(
					"[...document.querySelectorAll('[data-testid=turn-user]')].filter((t) => t.querySelector('[data-testid=reasoning]')).length",
				),
			).toBe(0);
			expect(page.seen.problems.filter((p) => !/401/.test(p))).toEqual([]);
		});

		it("opens and folds one trace from the keyboard, and shows a long trace whole only when asked", async () => {
			const { page } = await live(appearance);
			await page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[0].focus()");
			await page.press("Enter");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 1");
			expect(await expanded(page)).toEqual(["true", "false", "false", "false"]);
			const controls = await page.eval<string>(
				"document.querySelectorAll('[data-testid=reasoning-toggle]')[0].getAttribute('aria-controls')",
			);
			expect(await page.eval<boolean>(`!document.getElementById(${JSON.stringify(controls)}).hidden`)).toBe(true);
			expect(await page.text("[data-testid=reasoning-text]")).toContain("carry a partial token across chunks");
			expect(await page.text("[data-testid=reasoning-body]")).toContain(
				"not a record of how the answer was produced",
			);
			await page.press("Enter");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 0");
			// The long trace: clamped, then whole.
			await page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[3].click()");
			await page.waitFor("document.querySelector('[data-testid=reasoning-more]')");
			const clamped = await page.eval<number>(
				"document.querySelector('[data-testid=reasoning-text]').textContent.length",
			);
			expect(clamped).toBeLessThan(LONG_TRACE.length);
			expect(await page.text("[data-testid=reasoning-more]")).toMatch(/Show the whole trace \([\d,]+ more words\)/);
			await page.click("[data-testid=reasoning-more]");
			await page.waitFor(
				`document.querySelector('[data-testid=reasoning-text]').textContent.length === ${LONG_TRACE.length}`,
			);
		});

		it("shows every trace under the Shown preference, keeps a trace folded by hand, and clears hand-made choices when the preference changes", async () => {
			const { page, session } = await live(appearance);
			await fill(page, "[data-testid=composer]", "a draft that must survive");
			await page.click("[data-testid=reasoning-shown]");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 4");
			expect(await expanded(page)).toEqual(["true", "true", "true", "true"]);
			await page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[1].click()");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 3");
			// A new message arrives: it is shown, and the trace folded by hand stays folded.
			session.live_(
				assistant([
					{ type: "thinking", thinking: "A new trace arrives." },
					{ type: "text", text: "New answer." },
				]),
			);
			await reread(page);
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-toggle]').length === 5");
			expect(await expanded(page)).toEqual(["true", "false", "true", "true", "true"]);
			// Back to Folded: everything folds, the hand-made choice included.
			await page.click("[data-testid=reasoning-folded]");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 0");
			expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
				"a draft that must survive",
			);
			// A display preference only: nothing was sent for it.
			expect(page.seen.requests.filter((u) => /thinking|preference|reasoning/i.test(u))).toEqual([]);
		});

		it("follows the message being written, labelled partial, and carries an opened trace into the completed message", async () => {
			const { page, session } = await live(appearance);
			for (const event of SYNTHETIC_OPEN) session.live_(event);
			await reread(page);
			await page.waitFor("document.querySelector('[data-testid=turn-open]')");
			expect(await page.text("[data-testid=turn-open]")).toContain("Being written, as of the read at");
			expect(await page.text("[data-testid=turn-open] [data-testid=reasoning]")).toContain(
				"being written, as of the last read",
			);
			await page.click("[data-testid=turn-open] [data-testid=reasoning-toggle]");
			await page.waitFor("document.querySelector('[data-testid=turn-open] [data-testid=reasoning-text]')");
			session.live_(thinkingDelta(0, " More."));
			await reread(page);
			await page.waitFor(
				"document.querySelector('[data-testid=turn-open] [data-testid=reasoning-text]').textContent.endsWith('More.')",
			);
			session.live_(
				assistant([
					{ type: "thinking", thinking: "Keep a running line counter; record it when a string opens." },
					{ type: "text", text: "Done: the message now names the line the string starts on." },
				]),
			);
			await reread(page);
			await page.waitFor("!document.querySelector('[data-testid=turn-open]')");
			const last = "[...document.querySelectorAll('[data-testid=turn-assistant]')].at(-1)";
			expect(
				await page.eval<string | null>(
					`${last}.querySelector('[data-testid=reasoning-toggle]').getAttribute('aria-expanded')`,
				),
			).toBe("true");
			expect(await page.eval<string>(`${last}.querySelector('[data-testid=reasoning-text]').textContent`)).toBe(
				"Keep a running line counter; record it when a string opens.",
			);
		});

		it("keeps the reader's place: opening a trace above and new arrivals below never move what is being read", async () => {
			const { page, session } = await live(appearance, 1366, 768);
			await page.click("[data-testid=reasoning-shown]");
			await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 4");
			// Read from the middle: the second trace at the top of the scroller, well away from both ends.
			await page.eval(
				"(() => { const s = document.querySelector('.live-scroll'); const r = document.querySelectorAll('[data-testid=reasoning]')[1]; s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top; s.dispatchEvent(new Event('scroll')); })()",
			);
			await page.waitFor("document.querySelector('[data-testid=new-below]') === null");
			const before = await page.eval<number>("document.querySelector('.live-scroll').scrollTop");
			expect(before).toBeGreaterThan(100);
			expect(
				await page.eval<number>(
					"(() => { const s = document.querySelector('.live-scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight; })()",
				),
			).toBeGreaterThan(400);
			const anchor = await page.eval<number>(
				"document.querySelectorAll('[data-testid=reasoning]')[1].getBoundingClientRect().top",
			);
			session.live_(user("Another message."));
			session.live_(
				assistant([
					{ type: "thinking", thinking: LONG_TRACE },
					{ type: "text", text: "Long answer." },
				]),
			);
			for (const event of SYNTHETIC_OPEN) session.live_(event);
			await reread(page);
			await page.waitFor("document.querySelector('[data-testid=turn-open]')");
			expect(await page.eval<number>("document.querySelector('.live-scroll').scrollTop")).toBe(before);
			expect(
				await page.eval<number>(
					"document.querySelectorAll('[data-testid=reasoning]')[1].getBoundingClientRect().top",
				),
			).toBe(anchor);
			expect(await page.eval<boolean>("!!document.querySelector('[data-testid=new-below]')")).toBe(true);
			// At the bottom, the conversation follows again.
			await page.click("[data-testid=new-below]");
			session.live_(thinkingDelta(0, " Still thinking."));
			await reread(page);
			expect(
				await page.eval<number>(
					"(() => { const s = document.querySelector('.live-scroll'); return s.scrollHeight - s.scrollTop - s.clientHeight; })()",
				),
			).toBeLessThan(24);
		});
	});
}

(executable === null || !haveGit ? describe.skip : describe)("model-provided reasoning while changes are read", () => {
	it("keeps the conversation's place when the preference is changed from the Changes view", async () => {
		const { page } = await live("field", 1366, 768, true);
		await page.eval(
			"(() => { const s = document.querySelector('.live-scroll'); const r = document.querySelectorAll('[data-testid=reasoning]')[1]; s.scrollTop += r.getBoundingClientRect().top - s.getBoundingClientRect().top; s.dispatchEvent(new Event('scroll')); })()",
		);
		const before = await page.eval<number>("document.querySelector('.live-scroll').scrollTop");
		expect(before).toBeGreaterThan(100);
		await page.click("[data-testid=tab-changes]");
		await page.click("[data-testid=reasoning-shown]");
		await page.waitFor("document.querySelectorAll('[data-testid=reasoning-text]').length === 4");
		await page.click("[data-testid=tab-conversation]");
		await page.waitFor("!document.querySelector('#develop-view-conversation').hidden");
		expect(await page.eval<number>("document.querySelector('.live-scroll').scrollTop")).toBe(before);
	});
});

suite("a conversation without model-provided reasoning", () => {
	it("says why none is shown, and stops saying it once a trace arrives", async () => {
		const session = new FakeSession();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: new Approval().approver,
		});
		const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
		session.live_(user("Hello."));
		session.live_(assistant([{ type: "text", text: "<think>not structured</think>Hi." }]));
		const page = await browser.open(1440, 900);
		tabs.push(page);
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=live-row]')");
		await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[data-testid=reasoning-none]')");
		expect(await page.text("[data-testid=reasoning-none]")).toContain(
			"No model-provided reasoning in this conversation so far",
		);
		expect(await page.text("[data-testid=turn-assistant] .turn-text")).toBe("<think>not structured</think>Hi.");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=reasoning]').length")).toBe(0);
		session.live_(
			assistant([
				{ type: "thinking", thinking: "Now structured." },
				{ type: "text", text: "Done." },
			]),
		);
		await reread(page);
		await page.waitFor("!document.querySelector('[data-testid=reasoning-none]')");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=reasoning]').length")).toBe(1);
	});
});

suite("a transcript that needs many pages", () => {
	it("is read to its newest message on the first read, with Follow off and nothing open", async () => {
		// The case that needs more pages than one read used to take: 200 tool items, then 17 messages of about 120 KiB each.
		const session = new FakeSession();
		const broker = new WorkbenchBrokerV0({
			session,
			key: OTHER_KEY,
			attachment: "pi.default",
			approver: new Approval().approver,
		});
		const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
		for (let i = 0; i < 100; i++)
			for (const event of [
				{ type: "tool_execution_start", record: { toolCallId: `t${i}`, toolName: "read" } },
				{ type: "tool_execution_end", record: { toolCallId: `t${i}`, toolName: "read", isError: false } },
			])
				session.live_(event);
		for (let i = 0; i < 17; i++)
			session.live_(
				assistant([
					// Two blocks, each under the per-block bound, so the message really is about 120 KiB: four fit a page.
					{ type: "thinking", thinking: "r".repeat(44 * 1024) },
					{ type: "thinking", thinking: "s".repeat(44 * 1024) },
					{ type: "text", text: `${i === 16 ? "THE-NEWEST-MESSAGE " : ""}${"t".repeat(31 * 1024)}` },
				]),
			);
		const page = await browser.open(1440, 900);
		tabs.push(page);
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=live-row]')");
		await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor(
			"[...document.querySelectorAll('[data-testid=turn-assistant] .turn-text')].some((t) => t.textContent.startsWith('THE-NEWEST-MESSAGE'))",
		);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=turn-assistant]').length")).toBe(17);
	});
});

suite("model-provided reasoning across appearances", () => {
	it("keeps the preference, the hand-opened traces and the draft when the appearance changes", async () => {
		const { page } = await live("instrument");
		await page.click("[data-testid=reasoning-shown]");
		await page.eval("document.querySelectorAll('[data-testid=reasoning-toggle]')[2].click()");
		await fill(page, "[data-testid=composer]", "kept");
		const before = await expanded(page);
		await page.click("[data-testid=appearance-field]");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
		expect(await expanded(page)).toEqual(before);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=reasoning-shown]').checked")).toBe(true);
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("kept");
	});
});
