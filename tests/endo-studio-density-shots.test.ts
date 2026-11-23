// Screenshots and layout measurements of the live DEVELOP workbench, opt-in:
//   ENDO_SHOTS_DIR=/some/dir npx vitest --run tests/endo-studio-density-shots.test.ts
// Real browser (headless Chromium, GPU off), real broker, real Git, the real built page; the conversation and the repositories are
// SYNTHETIC (tests/develop-reasoning-fixtures.ts, tests/git-fixtures.ts). Beside the captures it writes the geometry it measured into
// metrics.json: how tall the head of the work and the composer are, and how much of the window the conversation's scroller gets. It
// asserts only that each state was reached; the behaviour is pinned by the other browser suites.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import type { RpcEventV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { SYNTHETIC_CONVERSATION } from "./develop-reasoning-fixtures.ts";
import { cleanGitFixtures, commitedRepo, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession } from "./workbench-fixtures.ts";

const out = process.env.ENDO_SHOTS_DIR ?? "";
const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-density-shots-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
const metrics: Record<string, unknown> = {};
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
	if (out !== "") writeFileSync(join(out, "metrics.json"), `${JSON.stringify(metrics, null, "\t")}\n`);
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});

/** The geometry of the live surface in CSS pixels, as the browser laid it out, and the stop control's computed colours. */
const MEASURE = [
	"(() => {",
	"const box = (s) => { const e = document.querySelector(s); if (!e || e.getClientRects().length === 0) return null; const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height), width: Math.round(b.width) }; };",
	"const live = box('#develop-live');",
	"const view = box('#develop-view-conversation');",
	"const scroller = document.querySelector('#develop-view-conversation .live-scroll');",
	"const stop = document.querySelector('[data-testid=stop]');",
	"const style = stop ? getComputedStyle(stop) : null;",
	"return {",
	"viewport: { width: innerWidth, height: innerHeight },",
	"live,",
	"head: live && view ? view.top - live.top : null,",
	"foot: live && view ? live.bottom - view.bottom : null,",
	"conversation: scroller && scroller.getClientRects().length > 0 ? { width: scroller.clientWidth, height: scroller.clientHeight, area: scroller.clientWidth * scroller.clientHeight } : null,",
	"composer: box('#develop-live .composer'),",
	"authority: box('[data-testid=authority]'),",
	"context: box('#develop-context'),",
	"course: box('.develop-course'),",
	"overflowX: document.documentElement.scrollWidth - innerWidth,",
	"stop: style === null ? null : { background: style.backgroundColor, color: style.color, border: style.borderTopColor, shadow: style.boxShadow, text: stop.textContent },",
	"};",
	"})()",
].join("\n");

const shot = async (page: Page, name: string) => {
	await new Promise((r) => setTimeout(r, 700));
	writeFileSync(join(out, `${name}.png`), await page.screenshot());
	metrics[name] = await page.eval(MEASURE);
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		"(() => { const e = document.querySelector(" +
			JSON.stringify(selector) +
			"); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, " +
			JSON.stringify(value) +
			"); e.dispatchEvent(new Event('input', { bubbles: true })); })()",
	);
const toBottom = (page: Page) =>
	page.eval(
		"(() => { const s = document.querySelector('.live-scroll'); if (s) { s.scrollTop = s.scrollHeight; s.dispatchEvent(new Event('scroll')); } })()",
	);
/** The control that collapses the context column, in whichever appearance offers one, or null. */
const collapser = (page: Page) =>
	page.eval<string | null>(
		"(() => { for (const id of ['context-toggle', 'dock-toggle']) { const b = document.querySelector('[data-testid=' + id + ']'); if (b && b.getClientRects().length > 0) return id; } return null; })()",
	);

type Appearance = "instrument" | "field";
async function open(
	appearance: Appearance,
	width: number,
	height: number,
	options: { running?: boolean; clean?: boolean; session?: string; conversation?: RpcEventV0[] } = {},
) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	if (options.session !== undefined) session.piSessionId = options.session;
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: new FakeDesk(session),
		project: new GitProjectInspectorV0({ cwd: options.clean ? commitedRepo() : demoRepo(), minRefreshMs: 0 }),
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	for (const event of options.conversation ?? SYNTHETIC_CONVERSATION) session.live_(event);
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
	if (appearance === "field") {
		await page.click("[data-testid=appearance-field]");
		await page.waitFor(
			"document.querySelector('.field-canvas') && document.querySelector('.field-canvas').dataset.state !== 'loading'",
		);
	}
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	await page.waitFor("document.querySelectorAll('[data-testid=reasoning]').length >= 5");
	if (width >= 1024) {
		await page.click("[data-testid=project-refresh]");
		await page.waitFor("document.querySelector('[data-testid=project-header]')?.dataset.state === 'ready'");
	}
	await toBottom(page);
	return { session, broker, server, page, approval };
}

/** The README hero's conversation: the synthetic one, its last turn's tool calls carrying the arguments and outputs Pi reports. */
const call = (id: string, toolName: string, args: Record<string, unknown>, output: string): RpcEventV0[] => [
	{ type: "tool_execution_start", record: { toolCallId: id, toolName, args } },
	{
		type: "tool_execution_end",
		record: { toolCallId: id, toolName, isError: false, result: { content: [{ type: "text", text: output }] } },
	},
];
const HERO_CONVERSATION: RpcEventV0[] = [
	...SYNTHETIC_CONVERSATION.slice(0, -2),
	...call(
		"h1",
		"read",
		{ path: "src/parser/lexer.ts", offset: 42, limit: 60 },
		"export function lexString(state: LexState) {",
	),
	...call("h2", "edit", { path: "src/parser/lexer.ts" }, "Edited src/parser/lexer.ts"),
	...call("h3", "bash", { command: "npm test -- tests/parser.test.ts" }, "15 passed"),
	...call("h4", "bash", { command: "git status --short" }, " M src/parser/lexer.ts"),
];

const LONG_DRAFT = Array.from(
	{ length: 14 },
	(_, i) =>
		"Paragraph " +
		(i + 1) +
		": keep the tokenizer streaming, but do not change the parser's public signature; check the empty-chunk case and the rename in docs before you touch the generated table.",
).join("\n\n");

describe.runIf(out !== "" && executable !== null && haveGit)("DEVELOP density (synthetic fixtures)", () => {
	for (const a of ["instrument", "field"] as Appearance[]) {
		it(`${a}: desktop, laptop, 4K and phone with a run open`, async () => {
			for (const [w, h, tag] of [
				[1440, 900, "1440"],
				[1366, 768, "1366"],
				[3840, 2160, "3840"],
				[390, 844, "390"],
			] as const) {
				const { page } = await open(a, w, h);
				await shot(page, `${a}-run-${tag}`);
				const toggle = w >= 1024 ? await collapser(page) : null;
				if (toggle !== null) {
					await page.click(`[data-testid=${toggle}]`);
					await toBottom(page);
					await shot(page, `${a}-run-${tag}-collapsed`);
				}
			}
		}, 240_000);

		it(`${a}: idle, clean worktree, long names and a long draft`, async () => {
			const idle = await open(a, 1440, 900, { running: false, clean: true });
			await shot(idle.page, `${a}-idle-clean-1440`);
			const long = await open(a, 1440, 900, {
				session: "a-rather-long-session-name-for-the-parser-streaming-refactor-2026-11-23-attempt-3",
			});
			await fill(long.page, "[data-testid=composer]", LONG_DRAFT);
			await shot(long.page, `${a}-long-names-draft-1440`);
			await long.page.resize(1366, 768);
			await shot(long.page, `${a}-long-names-draft-1366`);
		}, 120_000);

		it(`${a}: approval pending and broker unreachable`, async () => {
			const { page, approval, server } = await open(a, 1440, 900);
			await page.click("[data-testid=mode-steer]");
			await fill(page, "[data-testid=composer]", "also cover an empty chunk");
			await page.click("[data-testid=send]");
			await approval.waitForRequest();
			await page.waitFor("document.querySelector('[data-testid=intervention-card]')");
			await toBottom(page);
			await shot(page, `${a}-approval-pending-1440`);
			approval.answer(null);
			await server.close();
			await page.click("#workbench-refresh");
			await page.waitFor("document.querySelector('[data-testid=run-strip]').dataset.connection === 'unknown'");
			await shot(page, `${a}-unreachable-1440`);
		}, 120_000);
	}
	// The README hero (docs/images/readme-hero-field-storm-1440.png): Field at 1440x900 with Storm chosen, a run open, the Course
	// gauges, folded reasoning, the last turn's tool calls unfolded with the first one opened, and the worktree's changes in Context.
	it("field: README hero, Storm, a run open, a tool call opened", async () => {
		const { page } = await open("field", 1440, 900, { conversation: HERO_CONVERSATION });
		await page.eval(
			"(() => { const e = document.querySelector('[data-testid=atmosphere]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(e, 'storm'); e.dispatchEvent(new Event('change', { bubbles: true })); })()",
		);
		await page.waitFor(
			"document.querySelector('#develop-workspace').dataset.atmosphere === 'storm' && document.querySelector('.weather-rain') !== null && document.querySelector('.weather-rain').dataset.state !== 'loading'",
		);
		await page.eval(
			"(() => { const group = [...document.querySelectorAll('details.turn-body')].findLast((d) => /tool calls/.test(d.querySelector('summary')?.textContent ?? '')); group.querySelector('summary').click(); group.dataset.hero = 'tools'; })()",
		);
		await page.waitFor("document.querySelector('[data-hero=tools] .tool-disclosure')");
		await page.eval("document.querySelector('[data-hero=tools] .tool-disclosure summary').click()");
		await page.waitFor("document.querySelector('[data-hero=tools] .tool-disclosure[open] dl')");
		await toBottom(page);
		await new Promise((r) => setTimeout(r, 2500));
		await shot(page, "readme-hero-field-storm-1440");
	}, 120_000);
});
