// The workspace desk in a real browser: the workspace host (no Pi, no fake session, no broker) over the real task, attempt and receipt
// stores, a real Git repository (synthetic content) and the real built page. The operator's journey without an agent: open, pair, see what
// needs attention, read a task and the check it is about, keep a draft and their place while moving between the overview and a task,
// change a status, and see nothing that pretends a session was ever there. Set ENDO_SHOTS_DIR to also write screenshots.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { endoDevelopServiceV0, endoReceiptCurrentV0 } from "../cli/develop-service.ts";
import { endoStartOnDevelopV0 } from "../cockpit-http/host.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { EndoWorkspaceHostV0 } from "../cockpit-http/workspace-host.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { seedAttention } from "./studio-attention-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-workspace-browser-"));
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

async function launch(width: number, height: number, options: { pair?: boolean; appearance?: "field" } = {}) {
	const root = developStore();
	const cwd = demoRepo();
	const made = new DevelopTasksStoreV0(root).registerProject({
		name: "Parser work",
		path: realpathSync(cwd),
		observedGitRoot: realpathSync(cwd),
	});
	if (!made.ok) throw new Error("registration refused");
	const project = made.value.id;
	const current = await endoReceiptCurrentV0(cwd);
	if (current === null) throw new Error("the demo repository cannot be observed");
	const seeded = seedAttention(root, project, current);
	const service = endoDevelopServiceV0(root);
	const host = new EndoWorkspaceHostV0({
		open: (facts) => service.forLaunch({ projectId: project, launchDirectory: cwd }, facts),
		project: new GitProjectInspectorV0({ cwd, minRefreshMs: 0 }),
	});
	// As `endo workspace open` serves it: the page marked to open on DEVELOP.
	const server = await serve(root, {
		ui: endoStartOnDevelopV0(ui),
		workbench: host,
		readBudget: { duty: 1, burstMs: 1e6 },
	});
	const page = await browser.open(width, height);
	tabs.push(page);
	// The address `endo workspace open` prints: the page opens on DEVELOP, as the served page says.
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.waitFor("document.querySelector('[data-testid=workspace-row]')");
	if (options.appearance === "field") await page.click("[data-testid=appearance-field]");
	if (width < 1024) {
		await page.click("[data-testid=workspace-row]");
	}
	await page.waitFor("document.querySelector('[data-testid=workspace-desk]')");
	const api = { root, cwd, project, host, server, page, seeded };
	if (options.pair !== false) await pair(api);
	return api;
}

async function pair(api: { page: Page; host: EndoWorkspaceHostV0 }) {
	await fill(api.page, "[data-testid=pair-code]", api.host.issuePairingCode().code);
	await api.page.click("[data-testid=pair-submit]");
	await api.page.waitFor("!document.querySelector('[data-testid=pair-code]')");
	await overviewShown(api.page);
}
const overviewShown = (page: Page) =>
	page.waitFor("document.querySelector('[data-testid=attention-overview]')?.dataset.evidence === 'shown'");
const noOverflow = (page: Page) => page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const bodyText = (page: Page) => page.eval<string>("document.body.innerText");
const statusOf = (root: string, id: string) =>
	(
		JSON.parse(readFileSync(join(root, "develop", "tasks.json"), "utf8")) as {
			tasks: { id: string; status: string }[];
		}
	).tasks.find((t) => t.id === id)?.status;
/** Nothing on the page claims a session that was never there, or offers to command one. */
async function noSessionClaims(page: Page) {
	const text = await bodyText(page);
	// Control labels and session states, as the live workbench writes them (the desk's own disclaimer says "steer" in lower case).
	const hit =
		/[Dd]isconnected|no admitted connection|Pi · |pi session|Read session|Approve|\bSteer\b|Stop the run/.exec(text);
	expect(hit === null ? null : text.slice(Math.max(0, hit.index - 80), hit.index + 40)).toBeNull();
	for (const id of ["composer", "run-strip-words", "live-row", "follow", "tab-conversation", "task-link"])
		expect([id, await page.eval<boolean>(`document.querySelector('[data-testid=${id}]') !== null`)]).toEqual([
			id,
			false,
		]);
	expect(page.seen.requests.filter((r) => /transcript|prompt|intervention/.test(r))).toEqual([]);
}

suite("the workspace desk: the project's work, with no agent", () => {
	it("opens on what needs attention, says plainly that no agent is attached, and offers no agent control", async () => {
		const api = await launch(1440, 900, { pair: false });
		const { page } = api;
		// Before pairing: what it is, and how to pair; no task text.
		expect(await page.text("[data-testid=authority-chip]")).toContain("Workspace · not paired");
		expect(await page.text("[data-testid=host-strip-words]")).toContain("No agent attached");
		expect(await bodyText(page)).not.toContain("Stream the parser");
		await shot(page, "workspace-unpaired-1440");
		await pair(api);
		expect(await page.text("[data-testid=authority-chip]")).toContain("Workspace · paired");
		expect(await page.text("[data-testid=workspace-row-state]")).toMatch(/12 tasks · \d+ need attention/);
		const needs = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=attention-needs] [data-testid=attention-row]')].map((r) => r.dataset.flag)",
		);
		expect(needs).toEqual(expect.arrayContaining(["decision", "failed", "inconclusive"]));
		expect(await page.text("[data-testid=context-host]")).toMatch(/none attached, none needed/);
		await noSessionClaims(page);
		expect(await noOverflow(page)).toBe(true);
		await shot(page, "workspace-overview-1440");
	});

	it("opens a task and the check its row is about, keeps a draft and the operator's place, and changes a status by the rules", async () => {
		const api = await launch(1440, 900);
		const { page, seeded, root } = api;
		const regressed = seeded.tasks.regressed!;
		// The failed check's row opens the task and focuses that receipt.
		await page.click(`[data-testid=attention-row][data-task="${regressed}"]`);
		await page.waitFor(
			"document.querySelector('[data-testid=task-title]')?.textContent === 'Normalize CRLF line endings'",
		);
		await page.waitFor("document.querySelector('[data-receipt-id][data-focused=true]')");
		expect(await page.text("[data-testid=task-link-none]")).toContain("runs no agent, so it has no session to link");
		await shot(page, "workspace-task-1440");
		// An unsaved edit.
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-title-input]", "Normalize CRLF and lone CR line endings");
		// Back to the overview: the row of the task just read has focus again, and its draft is kept.
		await page.click("[data-testid=task-overview]");
		await page.waitFor(`document.activeElement?.dataset?.task === ${JSON.stringify(regressed)}`);
		// Keyboard: down and up move between rows; Enter opens one.
		await page.press("ArrowDown");
		expect(await page.eval<string>("document.activeElement.dataset.task")).not.toBe(regressed);
		await page.press("ArrowUp");
		expect(await page.eval<string>("document.activeElement.dataset.task")).toBe(regressed);
		await page.press("Enter");
		await page.waitFor("document.querySelector('[data-testid=task-title-input]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"Normalize CRLF and lone CR line endings",
		);
		// "Show all" open tasks survives a visit to a task.
		await page.click("[data-testid=task-overview]");
		await page.waitFor("document.querySelector('[data-testid=attention-overview]')");
		await page.click("[data-testid=attention-done] summary");
		// The details element announces its toggle in a later task: let it land before leaving the overview (no person clicks faster).
		await page.eval("new Promise((r) => setTimeout(r, 100))");
		await page.click(`[data-testid=attention-row][data-task="${seeded.tasks.docs}"]`);
		await page.waitFor(
			"document.querySelector('[data-testid=task-title]')?.textContent === 'Document the streaming API'",
		);
		// A status change: only the operator's button, against the revision the page saw.
		// Choosing the task is remembered in the file first (a select); the buttons wait for it.
		await page.waitFor("document.querySelector('[data-testid=task-to-in-progress]')?.disabled === false");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor(`document.querySelector('[data-testid=task-detail]')?.dataset.status === 'in-progress'`);
		expect(statusOf(root, seeded.tasks.docs!)).toBe("in-progress");
		expect(statusOf(root, regressed)).toBe("in-progress");
		await page.click("[data-testid=task-overview]");
		await page.waitFor("document.querySelector('[data-testid=attention-done]')?.open === true");
		// The draft is still there for the task it belongs to.
		await page.click(`[data-testid=attention-row][data-task="${regressed}"]`);
		await page.waitFor("document.querySelector('[data-testid=task-title-input]')");
		await noSessionClaims(page);
	});

	it("refuses a change made against an old revision, and says so, without losing the operator's words", async () => {
		const api = await launch(1440, 900);
		const { page, seeded, root, project } = api;
		const id = seeded.tasks.lint!;
		await page.click(`[data-testid=attention-row][data-task="${id}"]`);
		await page.waitFor("document.querySelector('[data-testid=task-to-in-progress]')");
		// The terminal changes it meanwhile.
		const store = new DevelopTasksStoreV0(root);
		const task = store.read();
		if (!task.ok) throw new Error("read");
		const t = task.file.tasks.find((x) => x.id === id)!;
		expect(store.setStatus(project, id, t.revision, "blocked", "from the terminal").ok).toBe(true);
		await fill(page, "[data-testid=task-note]", "my note");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("document.querySelector('[data-testid=task-notice]')");
		expect(statusOf(root, id)).toBe("blocked");
		await page.waitFor("document.querySelector('[data-testid=task-detail]')?.dataset.status === 'blocked'");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-note]').value")).toBe("my note");
	});

	it("says when a pairing code is refused, and asks to pair again after the terminal revokes the grant, keeping the operator's words", async () => {
		const api = await launch(1440, 900, { pair: false });
		const { page, host, seeded } = api;
		await fill(page, "[data-testid=pair-code]", "AAAA-AAAA");
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[data-testid=desk-problem]')?.textContent.includes('not accepted')");
		expect(await page.text("[data-testid=desk-problem]")).not.toContain("attached terminal");
		await pair(api);
		await page.click(`[data-testid=attention-row][data-task="${seeded.tasks.lint}"]`);
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-title-input]", "Tighten lint, kept across a revocation");
		// The terminal types `revoke`. The next read is refused, the page asks the host, and shows the pairing form again.
		host.revoke();
		await page.click("[data-testid=desk-refresh]");
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		expect(await page.text("[data-testid=authority-chip]")).toContain("not paired");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"Tighten lint, kept across a revocation",
		);
		// Pairing again carries on where the operator was.
		await fill(page, "[data-testid=pair-code]", host.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("!document.querySelector('[data-testid=pair-code]')");
		await page.waitFor("document.querySelector('[data-testid=tasks-stale-note]') === null");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"Tighten lint, kept across a revocation",
		);
	});

	it("asks to pair again when a change is refused because the grant ended", async () => {
		const api = await launch(1440, 900);
		const { page, host, seeded } = api;
		await page.click(`[data-testid=attention-row][data-task="${seeded.tasks.docs}"]`);
		await page.waitFor("document.querySelector('[data-testid=task-to-in-progress]')?.disabled === false");
		host.revoke();
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		expect(await page.text("[data-testid=task-notice]")).toContain("Pair this page again");
	});

	it("reads the worktree's changes from the desk, and Escape returns to Tasks", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await page.click("[data-testid=desk-tab-changes]");
		await page.waitFor("document.querySelector('[data-testid=project-header]')?.dataset.state === 'ready'");
		await page.waitFor("document.querySelectorAll('.changes-list button').length > 0");
		await page.click(".changes-list button");
		await page.waitFor("document.querySelector('.diff-scroll')");
		await shot(page, "workspace-changes-1440");
		await page.press("Escape");
		await page.waitFor("document.querySelector('#desk-view-task')?.hidden === false");
		expect(await page.eval<string>("document.activeElement.id")).toBe("desk-tab-task");
	});

	it("leaves the desk for a recorded session and comes back to the same place", async () => {
		const api = await launch(1440, 900);
		const { page, seeded } = api;
		await page.click(`[data-testid=attention-row][data-task="${seeded.tasks.timeout}"]`);
		await page.waitFor("document.querySelector('[data-testid=task-title]')?.textContent === 'Unicode identifiers'");
		await page.click("#develop-refresh");
		await page.waitFor("document.querySelector('[data-session-row]:not([data-testid=workspace-row])')");
		await page.click("[data-session-row]:not([data-testid=workspace-row])");
		await page.waitFor("!document.querySelector('[data-testid=workspace-desk]')");
		await page.click("[data-testid=workspace-row]");
		await page.waitFor("document.querySelector('[data-testid=task-title]')?.textContent === 'Unicode identifiers'");
	});

	for (const appearance of ["instrument", "field"] as const)
		it(`works at 390 px in ${appearance}: one stage at a time, no sideways scroll, the overview and a task readable`, async () => {
			const api = await launch(390, 844, appearance === "field" ? { appearance } : {});
			const { page, seeded } = api;
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `workspace-overview-390-${appearance}`);
			await page.click(`[data-testid=attention-row][data-task="${seeded.tasks.regressed}"]`);
			await page.waitFor("document.querySelector('[data-testid=task-title]')");
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `workspace-task-390-${appearance}`);
			await noSessionClaims(page);
		});

	it("draws the desk in Field at 1440 with words, not colour alone, for what needs attention", async () => {
		const api = await launch(1440, 900, { appearance: "field" });
		const { page } = api;
		expect(await page.eval<string>("document.querySelector('.develop').dataset.surface")).toBe("desk");
		expect(await page.text(".field-legend")).toMatch(/Workspace: no agent is attached/);
		const tags = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=attention-needs] .attn-tag')].map((t) => t.textContent)",
		);
		expect(tags).toEqual(expect.arrayContaining(["Check failed", "Inconclusive"]));
		await shot(page, "workspace-overview-1440-field");
		await noSessionClaims(page);
	});
});

suite("before: the same store without a workspace host", () => {
	it("is read-only Studio: recordings, and no tasks", async () => {
		const root = developStore();
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser.open(1440, 900);
		tabs.push(page);
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('#develop-workspace')");
		expect(await page.text("[data-testid=authority-chip]")).toContain("Read-only");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=workspace-row]') === null")).toBe(true);
		await shot(page, "workspace-before-studio-1440");
	});
});
