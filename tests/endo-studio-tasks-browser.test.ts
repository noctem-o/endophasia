// The project and task workspace in a real browser: the live broker over a fake Pi session, the real task store, a real Git repository (synthetic
// content), and the real built page. The operator's journey: see the project, create a task, choose it, keep working in the same
// conversation, record progress, close, come back. And what must NOT happen: choosing a task sends nothing, changes no session, worktree,
// status or draft; a mismatch or a damaged file is read-only; a restart makes a session link historical. Set ENDO_SHOTS_DIR to also write
// screenshots (of these synthetic fixtures; no private text is ever on screen).
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-tasks-browser-"));
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

/** What `endo project add` does: the operator names a directory; Git is asked once, read-only, for its worktree root. */
async function registerProject(root: string, cwd: string, name = "Parser work") {
	const inspector = new GitProjectInspectorV0({ cwd, minRefreshMs: 0 });
	const overview = await inspector.overview();
	inspector.dispose();
	const made = new DevelopTasksStoreV0(root).registerProject({
		name,
		path: realpathSync(cwd),
		observedGitRoot: overview.repository?.root ?? null,
	});
	if (!made.ok) throw new Error(`registration refused: ${made.code}`);
	return made.value;
}

type Mode = "ok" | "mismatch" | "none" | "unknown";
interface Launch {
	root: string;
	cwd: string;
	project: string | null;
}
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);

async function launch(
	width: number,
	height: number,
	options: { mode?: Mode; pair?: boolean; running?: boolean; prior?: Launch; page?: Page } = {},
) {
	const mode = options.mode ?? "ok";
	const root = options.prior?.root ?? developStore();
	const cwd = options.prior?.cwd ?? demoRepo();
	const project = options.prior?.project ?? (mode === "none" ? null : (await registerProject(root, cwd)).id);
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const other = mode === "mismatch" ? mkdtempSync(join(scratch, "other-")) : cwd;
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		project: new GitProjectInspectorV0({ cwd, minRefreshMs: 0 }),
		aliasOf: (id) => `endo.session.alias-of-${id.length}`,
		...(project === null
			? {}
			: {
					tasks: {
						open: (host) =>
							// As cli/workbench.ts constructs it: the attempts are served read-only beside the tasks.
							new DevelopWorkspaceServiceV0(new DevelopTasksStoreV0(root), {
								attempts: new DevelopAttemptsStoreV0(root),
							}).forLaunch(
								{
									projectId: mode === "unknown" ? `endo.project.${"0".repeat(32)}` : project,
									launchDirectory: other,
								},
								host,
							),
					},
				}),
	});
	const server = await serve(root, { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	session.live_({ type: "agent_start", record: {} });
	session.live_(textMessage("user", "Make the parser stream: accept chunks and yield tokens as they complete."));
	session.live_(
		textMessage(
			"assistant",
			"I'll read the tokenizer and its tests first, then change the buffering in small steps.",
		),
	);
	const page = options.page ?? (await browser.open(width, height));
	if (options.page === undefined) tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=live-row]')");
	if (width < 1024) {
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('#develop-live')");
	} else await page.waitFor("document.querySelector('[data-testid=run-strip-words]')?.textContent");
	const api = { session, desk, broker, server, page, approval, state: { root, cwd, project } satisfies Launch };
	if (options.pair !== false) await pair(api);
	return api;
}
type Api = Awaited<ReturnType<typeof launch>>;

async function pair(api: { page: Page; broker: WorkbenchBrokerV0 }) {
	await fill(api.page, "[data-testid=pair-code]", api.broker.issuePairingCode().code);
	await api.page.click("[data-testid=pair-submit]");
	await api.page.waitFor("document.querySelector('[data-testid=composer]')");
}
const cluster = (page: Page) => page.text("[data-testid=task-cluster]");
const view = (page: Page) => page.eval<string>("document.querySelector('#develop-live').dataset.view");
const ready = (page: Page) =>
	page.waitFor("document.querySelector('[data-testid=task-cluster]')?.dataset.state === 'ready'");
const openTab = async (page: Page) => {
	await page.click("[data-testid=tab-task]");
	await page.waitFor("document.querySelector('#develop-live').dataset.view === 'task'");
};
const draftOf = (page: Page) => page.eval<string>("document.querySelector('[data-testid=composer]').value");
const noOverflow = (page: Page) => page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const inViewport = (page: Page, selector: string) =>
	page.eval<boolean>(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1; })()`,
	);
const create = async (page: Page, title: string, description = "", acceptance = "") => {
	await fill(page, "[data-testid=task-title-input]", title);
	if (description !== "") await fill(page, "[data-testid=task-description-input]", description);
	if (acceptance !== "") await fill(page, "[data-testid=task-acceptance-input]", acceptance);
	await page.click("[data-testid=task-save]");
	await page.waitFor(`document.querySelector('[data-testid=task-title]')?.textContent === ${JSON.stringify(title)}`);
};
const statusOf = (page: Page) =>
	page.eval<string>("document.querySelector('[data-testid=task-detail]').dataset.status");
const noAgentTraffic = (api: Api) => {
	expect(api.session.promptCalls).toEqual([]);
	expect(api.approval.requests).toEqual([]);
	expect(api.desk.applyCalls).toEqual([]);
	expect(api.desk.proposals.size).toBe(0);
	expect(api.session.records).toEqual([]);
	// And the page asked for no route that could reach the agent on behalf of a task.
	const sent = api.page.seen.requests.filter((r) => /prompt\/propose|intervention\/propose/.test(r));
	expect(sent).toEqual([]);
};

suite("the operator's journey through a project and its tasks (Instrument)", () => {
	it("opens a project, creates a task, works beside it, records progress, and finds it again after a reload and after a restart", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		// The project is identified, with the three facts apart: the registered directory matches this launch, and Git agrees.
		expect(await page.text("[data-testid=project-identity]")).toContain("Parser work");
		await page.waitFor(
			"document.querySelector('[data-testid=project-association]')?.textContent.includes('matches')",
		);
		expect(await page.text("[data-testid=task-current-title]")).toBe("none yet");
		expect(await page.text("[data-testid=context-project]")).toContain("the registered directory");
		await shot(page, "tasks-instrument-empty-1440");

		// An unsent draft in the composer must survive everything below.
		await fill(page, "[data-testid=composer]", "mention the tokenizer tests");
		const conversation = await page.eval<number>("document.querySelectorAll('.turn').length");

		await openTab(page);
		expect(await page.text("[data-testid=task-create-form]")).toContain("Create the first task");
		// STOP and the composer stay docked while a task is read or written.
		expect(await inViewport(page, "[data-testid=stop]")).toBe(true);
		expect(await draftOf(page)).toBe("mention the tokenizer tests");
		await create(
			page,
			"Stream the parser",
			"Accept chunks and yield tokens as they complete.\nKeep tokenize() working.",
			"parseStream yields before the input ends\nExisting tests pass",
		);
		expect(await statusOf(page)).toBe("open");
		expect(await page.text("[data-testid=task-description]")).toContain("Keep tokenize() working.");
		expect(await page.text("[data-testid=task-acceptance]")).toContain("Existing tests pass");
		expect(await page.text("[data-testid=task-current-title]")).toBe("Stream the parser");
		await shot(page, "tasks-instrument-task-1440");

		// Record progress, explicitly.
		await fill(page, "[data-testid=task-note]", "started on the tokenizer");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'in-progress'");
		// A task cannot jump to done; only the moves the store allows are offered.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-to-done]') === null")).toBe(true);
		// Using the same conversation, the draft intact, the conversation untouched.
		await page.click("[data-testid=tab-conversation]");
		expect(await draftOf(page)).toBe("mention the tokenizer tests");
		expect(await page.eval<number>("document.querySelectorAll('.turn').length")).toBe(conversation);
		noAgentTraffic(api);

		// An agent finishing a run changes nothing about the task.
		api.session.live_({ type: "agent_end", record: {} });
		api.session.live_({ type: "agent_settled", record: {} });
		await page.click("#workbench-refresh");
		await openTab(page);
		expect(await statusOf(page)).toBe("in-progress");

		// Review, then done: each an act of the operator.
		await page.click("[data-testid=task-to-review]");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'review'");
		await fill(page, "[data-testid=task-note]", "accepted after reading the diff");
		await page.click("[data-testid=task-to-done]");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'done'");
		await page.eval("document.querySelector('[data-testid=task-history] summary').click()");
		const history = await page.text("[data-testid=task-history]");
		expect(history).toContain("accepted after reading the diff");
		expect(history).toContain("started on the tokenizer");
		await shot(page, "tasks-instrument-done-1440");

		// Close and come back: the same page object reloads, the grant is gone, the tasks are not.
		await page.goto(`${api.server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=live-row]')");
		await page.waitFor("document.querySelector('[data-testid=task-cluster-note]')");
		expect(await cluster(page)).toContain("pair this page to read them");
		await pair(api);
		await ready(page);
		expect(await page.text("[data-testid=task-current-title]")).toBe("Stream the parser");
		await openTab(page);
		expect(await statusOf(page)).toBe("done");
		expect(await page.text("[data-testid=task-description]")).toContain("Keep tokenize() working.");
		noAgentTraffic(api);
		expect(await page.eval<number>("localStorage.length + sessionStorage.length")).toBe(0);
		expect(page.seen.problems).toEqual([]);
	});

	it("switches tasks without sending anything, changing a status, or losing the draft, and does it from the keyboard", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "First task", "one");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'in-progress'");
		await fill(page, "[data-testid=composer]", "a draft that must survive");
		// T opens the picker from anywhere nobody is typing; the last item is "New task".
		await page.click("[data-testid=tab-conversation]");
		await page.press("t");
		await page.waitFor("document.querySelector('[data-testid=task-list]')");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=task-option]').length")).toBe(1);
		await page.press("ArrowDown");
		await page.press("Enter");
		await page.waitFor("document.querySelector('[data-testid=task-create-form]')");
		expect(await view(page)).toBe("task");
		await create(page, "Second task");
		expect(await page.text("[data-testid=task-current-title]")).toBe("Second task");
		// Choose the first again with the keyboard: T, ArrowUp (the list is ordered work-in-hand first), Enter.
		await page.press("t");
		await page.waitFor("document.querySelector('[data-testid=task-list]')");
		const order = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=task-option]')].map(o => o.querySelector('.task-opt-title').textContent)",
		);
		expect(order).toEqual(["First task", "Second task"]);
		await page.press("ArrowUp");
		await page.press("Enter");
		await page.waitFor("document.querySelector('[data-testid=task-title]')?.textContent === 'First task'");
		// Escape closes the picker and nothing behind it: the Task view stays.
		await page.press("t");
		await page.waitFor("document.querySelector('[data-testid=task-list]')");
		await page.press("Escape");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-list]') === null")).toBe(true);
		expect(await view(page)).toBe("task");
		// T is the operator's key only where nobody is typing: in the composer it is a letter, and the list does not open.
		await page.click("[data-testid=tab-conversation]");
		await page.eval("document.querySelector('[data-testid=composer]').focus()");
		await page.press("t");
		expect(await draftOf(page)).toBe("a draft that must survivet");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-list]') === null")).toBe(true);
		await fill(page, "[data-testid=composer]", "a draft that must survive");
		// Nor outside DEVELOP: the keyboard handler goes with the workspace.
		await page.eval("document.activeElement.blur()");
		await page.click("button[data-workspace=observe]");
		await page.press("t");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-list]') === null")).toBe(true);
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=composer]')");
		await openTab(page);
		// Nothing about the choosing changed a status, sent a prompt or touched the draft.
		expect(await statusOf(page)).toBe("in-progress");
		await page.click("[data-testid=tab-conversation]");
		expect(await draftOf(page)).toBe("a draft that must survive");
		noAgentTraffic(api);
		const stored = new DevelopTasksStoreV0(api.state.root).read();
		expect(stored.ok && stored.file.tasks.map((t) => [t.title, t.status, t.revision])).toEqual([
			["First task", "in-progress", 1],
			["Second task", "open", 0],
		]);
		// The broker remembered the choice for the next visit.
		expect(stored.ok && stored.file.projects[0]?.selectedTaskId).toBe(stored.ok ? stored.file.tasks[0]?.id : null);
	});

	it("an edit made against an old view is refused, rebased on the new words, and never writes back a field it did not touch", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "Edited task", "old words");
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-description-input]", "half-typed new words");
		// Another process (the CLI, another tab) changes a DIFFERENT field of the task meanwhile.
		const store = new DevelopTasksStoreV0(api.state.root);
		const found = store.read();
		if (!found.ok) throw new Error("unreadable");
		const task = found.file.tasks[0]!;
		store.updateTask(api.state.project!, task.id, task.revision, { acceptance: "written elsewhere" });
		await page.click("[data-testid=task-save]");
		await page.waitFor("document.querySelector('[data-testid=task-notice]')");
		expect(await page.text("[data-testid=task-notice]")).toContain("changed since you opened it");
		// Nothing was overwritten, the half-typed words are still in the form, and the field the operator never touched shows the new words.
		const refused = new DevelopTasksStoreV0(api.state.root).read();
		expect(refused.ok && refused.file.tasks[0]).toMatchObject({
			description: "old words",
			acceptance: "written elsewhere",
		});
		await page.waitFor(
			"document.querySelector('[data-testid=task-acceptance-input]')?.value === 'written elsewhere'",
		);
		expect(await page.eval<string>("document.querySelector('[data-testid=task-description-input]').value")).toBe(
			"half-typed new words",
		);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-conflict]') === null")).toBe(true);
		// Saving again sends only what the operator changed: the other field survives.
		await page.click("[data-testid=task-save]");
		await page.waitFor(
			"document.querySelector('[data-testid=task-description]')?.textContent === 'half-typed new words'",
		);
		const saved = new DevelopTasksStoreV0(api.state.root).read();
		expect(saved.ok && saved.file.tasks[0]).toMatchObject({
			description: "half-typed new words",
			acceptance: "written elsewhere",
			revision: 2,
		});
		expect(await page.text("[data-testid=task-acceptance]")).toBe("written elsewhere");
	});

	it("a field both sides changed is flagged, shown beside the operator's words, and replaced only by saving again", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "Contested task", "original");
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-description-input]", "the operator's version");
		const store = new DevelopTasksStoreV0(api.state.root);
		const found = store.read();
		if (!found.ok) throw new Error("unreadable");
		const task = found.file.tasks[0]!;
		store.updateTask(api.state.project!, task.id, task.revision, { description: "the other version" });
		await page.click("[data-testid=task-save]");
		await page.waitFor("document.querySelector('[data-testid=task-conflict]')");
		expect(await page.text("[data-testid=task-conflict]")).toContain("Description also changed elsewhere");
		expect(await page.text("[data-testid=task-elsewhere]")).toContain("the other version");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-description-input]').value")).toBe(
			"the operator's version",
		);
		await shot(page, "tasks-instrument-conflict-1440");
		// Nothing is decided for the operator: the file still holds the other version until they save again.
		const before = new DevelopTasksStoreV0(api.state.root).read();
		expect(before.ok && before.file.tasks[0]?.description).toBe("the other version");
		await page.click("[data-testid=task-save]");
		await page.waitFor(
			"document.querySelector('[data-testid=task-description]')?.textContent === \"the operator's version\"",
		);
		const after = new DevelopTasksStoreV0(api.state.root).read();
		expect(after.ok && after.file.tasks[0]?.description).toBe("the operator's version");
	});

	it("keeps an unsaved edit when the operator looks at another task", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "First", "one");
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-title-input]", "First, renamed");
		await page.click("[data-testid=task-picker]");
		await page.click("[data-testid=task-new-option]");
		await create(page, "Second");
		await page.click("[data-testid=task-picker]");
		await page.waitFor("document.querySelectorAll('[data-testid=task-option]').length === 2");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=task-option]')].find(o => o.textContent.includes('First')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=task-edit-form]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"First, renamed",
		);
	});

	it("does not let words be typed into a form while its save is in flight, so none are lost when it succeeds", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		// Hold the create request in the page until released, as a slow disk or a busy lock would.
		await page.eval(`(() => {
			const real = window.fetch.bind(window);
			window.__release = null;
			window.fetch = (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (!url.includes("workspace/tasks/create")) return real(input, init);
				return new Promise((resolve, reject) => {
					window.__release = () => real(input, init).then(resolve, reject);
				});
			};
		})()`);
		await fill(page, "[data-testid=task-title-input]", "Held while saving");
		await page.click("[data-testid=task-save]");
		await page.waitFor("window.__release !== null");
		for (const field of ["title", "description", "acceptance"]) {
			expect(
				await page.eval<boolean>(`document.querySelector('[data-testid=task-${field}-input]').readOnly`),
				field,
			).toBe(true);
		}
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-save]').disabled")).toBe(true);
		await page.eval("window.__release()");
		await page.waitFor("document.querySelector('[data-testid=task-title]')?.textContent === 'Held while saving'");
		// Saved: the form is gone, and what was saved is what was in the field when Save was pressed.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-create-form]') === null")).toBe(true);
		const stored = new DevelopTasksStoreV0(api.state.root).read();
		expect(stored.ok && stored.file.tasks.map((t) => t.title)).toEqual(["Held while saving"]);
	});

	it("does not let the status note be edited while its change is in flight", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "Noted");
		await page.eval(`(() => {
			const real = window.fetch.bind(window);
			window.__release = null;
			window.fetch = (input, init) => {
				const url = String(input instanceof Request ? input.url : input);
				if (!url.includes("workspace/tasks/status")) return real(input, init);
				return new Promise((resolve, reject) => {
					window.__release = () => real(input, init).then(resolve, reject);
				});
			};
		})()`);
		await fill(page, "[data-testid=task-note]", "started on it");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("window.__release !== null");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-note]').readOnly")).toBe(true);
		await page.eval("window.__release()");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'in-progress'");
		const stored = new DevelopTasksStoreV0(api.state.root).read();
		expect(stored.ok && stored.file.tasks[0]?.history.at(-1)?.note).toBe("started on it");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-note]').readOnly")).toBe(false);
	});

	it("links the current session as a reference, and shows it as an earlier launch after a restart", async () => {
		const first = await launch(1440, 900);
		await ready(first.page);
		await openTab(first.page);
		await create(first.page, "Linked task");
		expect(await first.page.text("[data-testid=task-sessions-none]")).toContain("Never inferred from a name");
		await first.page.click("[data-testid=task-link]");
		await first.page.waitFor("document.querySelector('[data-testid=task-session-ref]')");
		expect(
			await first.page.eval<string>("document.querySelector('[data-testid=task-session-ref]').dataset.relation"),
		).toBe("current");
		expect(await first.page.text("[data-testid=task-session-ref]")).toContain("linked by you");
		// The page was given a label, never the store's session id.
		expect(await first.page.eval<boolean>("document.body.textContent.includes('fake-session-1')")).toBe(false);
		await shot(first.page, "tasks-instrument-linked-1440");
		// A restart: a new broker and launch, the same store, the same Pi session id and alias.
		await first.server.close();
		const second = await launch(1440, 900, { prior: first.state, page: first.page });
		await ready(second.page);
		expect(second.broker.launchId).not.toBe(first.broker.launchId);
		await openTab(second.page);
		expect(
			await second.page.eval<string>("document.querySelector('[data-testid=task-session-ref]').dataset.relation"),
		).toBe("historical");
		expect(await second.page.text("[data-testid=task-session-ref]")).toContain("cannot be verified");
		// The link button is offered again, for THIS session; the old reference stays a separate, historical claim.
		await second.page.click("[data-testid=task-link]");
		await second.page.waitFor("document.querySelectorAll('[data-testid=task-session-ref]').length === 2");
		expect(
			await second.page.eval<string[]>(
				"[...document.querySelectorAll('[data-testid=task-session-ref]')].map(r => r.dataset.relation).sort()",
			),
		).toEqual(["current", "historical"]);
		noAgentTraffic(second);
	});
});

suite("a saved OMP reference beside a live Pi one", () => {
	/** What `endo task link --source omp-saved` records, written through the same store (the CLI path is tested in develop-tasks-v1). */
	const linkOmp = (api: Api, sessionId: string) => {
		const store = new DevelopTasksStoreV0(api.state.root);
		const read = store.read();
		if (!read.ok) throw new Error("unreadable");
		const task = read.file.tasks[0]!;
		const done = store.linkSession(api.state.project!, task.id, task.revision, {
			source: "omp-saved",
			sessionId,
			scope: `omp-dir.${"5".repeat(32)}`,
			observedFormat: 3,
			linkedBy: "operator",
			via: "cli",
		});
		if (!done.ok) throw new Error(done.code);
	};
	const OMP_ID = "019a0000-0000-7000-8000-0000c0ffee42";

	for (const [appearance, width, height] of [
		["instrument", 1440, 900],
		["field", 1440, 900],
		["instrument", 390, 844],
	] as const)
		it(`shows Pi as current and OMP as a saved reference, never current, in ${appearance} at ${width} px`, async () => {
			const api = await launch(width, height);
			const { page } = api;
			if (appearance === "field") {
				await page.click("[data-testid=appearance-field]");
				await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
			}
			await ready(page);
			await openTab(page);
			await create(page, "Cross-harness task");
			await page.click("[data-testid=task-link]");
			await page.waitFor("document.querySelector('[data-testid=task-session-ref]')");
			linkOmp(api, OMP_ID);
			await page.click("[data-testid=tasks-refresh]");
			await page.waitFor("document.querySelectorAll('[data-testid=task-session-ref]').length === 2");
			const refs = await page.eval<string[][]>(
				"[...document.querySelectorAll('[data-testid=task-session-ref]')].map(r => [r.dataset.source, r.dataset.relation, r.querySelector('.chip-ref').textContent])",
			);
			expect(refs).toEqual([
				["pi-live", "current", "Pi · current"],
				["omp-saved", "saved", "OMP · saved reference"],
			]);
			const omp = await page.text("[data-testid=task-session-ref][data-source=omp-saved]");
			expect(omp).toContain("omp c0ffee42");
			expect(omp).toContain("from the CLI");
			expect(omp).toContain("neither connects to nor controls it");
			// The full OMP id is never on the page; the Pi link stays available only for the session this workbench serves.
			expect(await page.eval<boolean>(`document.body.textContent.includes(${JSON.stringify(OMP_ID)})`)).toBe(false);
			expect(await page.eval<boolean>("document.querySelector('[data-testid=task-link]').disabled")).toBe(true);
			expect(await noOverflow(page)).toBe(true);
			// Its Remove link is an ordinary button, reachable from the keyboard.
			const removable = await page.eval<boolean>(
				"(() => { const b = document.querySelector('[data-testid=task-session-ref][data-source=omp-saved] button'); if (!b) return false; b.focus(); return document.activeElement === b && b.tabIndex >= 0; })()",
			);
			expect(removable).toBe(true);
			await shot(page, `tasks-${appearance}-omp-ref-${width}`);
			noAgentTraffic(api);
			expect(page.seen.problems).toEqual([]);
		});
});

suite("work attempts in the Task view: read-only, copyable, honest about what was recorded", () => {
	const attemptsOf = (root: string) =>
		new DevelopAttemptsServiceV0(new DevelopTasksStoreV0(root), new DevelopAttemptsStoreV0(root));
	// The page reads the attempts after each good read of the tasks; the tests wait for what they expect to see, not for the clock.
	const refresh = (page: Page) => page.click("[data-testid=tasks-refresh]");

	for (const [appearance, width, height] of [
		["instrument", 1440, 900],
		["field", 1440, 900],
		["instrument", 390, 844],
	] as const)
		it(`shows the selected task's attempts and their briefs, and changes nothing, in ${appearance} at ${width} px`, async () => {
			const api = await launch(width, height);
			const { page } = api;
			if (appearance === "field") {
				await page.click("[data-testid=appearance-field]");
				await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
			}
			await ready(page);
			await openTab(page);
			await create(page, "Accept trailing commas", "", "npm test passes");
			await page.waitFor("document.querySelector('[data-testid=attempts-none]')");
			expect(await page.text("[data-testid=task-attempts]")).toContain("endo attempt prepare --root <store>");
			// The operator prepares an attempt in a terminal; the page shows it after its next read.
			const stored = new DevelopTasksStoreV0(api.state.root).read();
			if (!stored.ok) throw new Error("unreadable");
			const task = stored.file.tasks[0]!;
			const service = attemptsOf(api.state.root);
			const attempt = service.prepare(task.projectId, task.id, {
				objective: "Make the parser accept a trailing comma in argument lists.\n\n```js\nf(a, b,)\n```",
				constraints: "Do not touch the lexer.",
			});
			if (!attempt.ok) throw new Error(attempt.code);
			const brief = service.brief(attempt.value.id);
			if (!brief.ok) throw new Error(brief.code);
			await page.click("[data-testid=tab-conversation]");
			await fill(page, "[data-testid=composer]", "an unsent draft");
			await openTab(page);
			await refresh(page);
			await page.waitFor("document.querySelector('[data-testid=attempt]')");
			expect(await page.eval<string>("document.querySelector('[data-testid=attempt]').dataset.state")).toBe(
				"prepared",
			);
			expect(await page.text("[data-testid=attempt] .chip-ref")).toBe("Prepared");
			// Open it: the brief is the CLI's, byte for byte, in a read-only box.
			await page.click("[data-testid=attempt] summary");
			await page.waitFor("document.querySelector('[data-testid=attempt-brief]')?.offsetHeight > 0");
			expect(await page.eval<string>("document.querySelector('[data-testid=attempt-brief]').value")).toBe(
				brief.value,
			);
			expect(await page.eval<boolean>("document.querySelector('[data-testid=attempt-brief]').readOnly")).toBe(true);
			// Copy writes the clipboard and nothing else: focus stays on the button, the draft is untouched, nothing is sent.
			const copy = `[data-testid=attempt] button[aria-label='Copy brief ${attempt.value.id.slice(-8)}']`;
			if (await page.eval<boolean>(`document.querySelector(${JSON.stringify(copy)}) !== null`)) {
				// From the keyboard, as an operator would: focus the button and press Enter.
				await page.eval(`document.querySelector(${JSON.stringify(copy)}).focus()`);
				await page.press("Enter");
				await page.waitFor(`document.querySelector(${JSON.stringify(copy)}).textContent !== 'copy'`);
				expect(await page.eval<string>("document.activeElement?.getAttribute('aria-label') ?? ''")).toBe(
					`Copy brief ${attempt.value.id.slice(-8)}`,
				);
			}
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `attempts-${appearance}-prepared-${width}`);
			// What the operator records later is shown as their statement, and a reported result is never shown as verified.
			if (!service.handoff(attempt.value.id, { target: "Claude Code" }).ok) throw new Error("handoff");
			if (!service.report(attempt.value.id, "The agent says the tests pass.").ok) throw new Error("report");
			const edited = new DevelopTasksStoreV0(api.state.root).updateTask(task.projectId, task.id, task.revision, {
				acceptance: "npm test and npm run lint pass",
			});
			if (!edited.ok) throw new Error(edited.code);
			await refresh(page);
			await page.waitFor("document.querySelector('[data-testid=attempt]')?.dataset.state === 'reported'");
			expect(await page.text("[data-testid=attempt] .chip-ref")).toBe("Result reported, not verified");
			await page.eval("document.querySelector('[data-testid=attempt] details').open = true");
			expect(await page.text("[data-testid=attempt-handoff]")).toContain("does not show the agent read it");
			expect(await page.text("[data-testid=attempt-outcome]")).toContain("Not verified");
			expect(await page.text("[data-testid=attempt-task-changed]")).toContain(
				"acceptance criteria has changed since this brief was prepared",
			);
			// The brief keeps the words it was prepared with.
			expect(await page.eval<string>("document.querySelector('[data-testid=attempt-brief]').value")).toBe(
				brief.value,
			);
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `attempts-${appearance}-reported-${width}`);
			// No status moved, no draft was touched, nothing reached the agent, and the store path is not on the page.
			expect(await statusOf(page)).toBe("open");
			await page.click("[data-testid=tab-conversation]");
			expect(await draftOf(page)).toBe("an unsent draft");
			expect(await page.eval<boolean>(`document.body.textContent.includes(${JSON.stringify(api.state.root)})`)).toBe(
				false,
			);
			noAgentTraffic(api);
			expect(page.seen.requests.filter((r) => /attempts\/|attempts\?/.test(r))).toEqual([]);
			expect(page.seen.problems).toEqual([]);
		});
});

suite("the same journey in Field", () => {
	it("creates and chooses tasks in the Field appearance, with the conversation, STOP and the draft where they were", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await page.click("[data-testid=appearance-field]");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
		await ready(page);
		await fill(page, "[data-testid=composer]", "keep this draft");
		await openTab(page);
		await create(page, "Field task", "Written in the dark appearance.", "It reads well");
		await shot(page, "tasks-field-task-1440");
		await page.press("t");
		await page.waitFor("document.querySelector('[data-testid=task-list]')");
		await shot(page, "tasks-field-picker-1440");
		await page.press("Escape");
		await page.click("[data-testid=tab-conversation]");
		expect(await draftOf(page)).toBe("keep this draft");
		expect(await inViewport(page, "[data-testid=stop]")).toBe(true);
		await shot(page, "tasks-field-conversation-1440");
		// Focus (the dock closed) with the Task view open: the Field hero composition.
		await openTab(page);
		await page.click("[data-testid=dock-toggle]");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.dock === 'closed'");
		await shot(page, "tasks-field-focus-1440");
		await page.click("[data-testid=dock-toggle]");
		await page.click("[data-testid=tab-conversation]");
		// Switch back to Instrument: the same task, the same draft.
		await page.click("[data-testid=appearance-instrument]");
		expect(await page.text("[data-testid=task-current-title]")).toBe("Field task");
		expect(await draftOf(page)).toBe("keep this draft");
		noAgentTraffic(api);
		expect(page.seen.problems).toEqual([]);
	});
});

suite("what the page says when it cannot show or change tasks", () => {
	it("a workbench with no project registered says so and how to register one", async () => {
		const api = await launch(1440, 900, { mode: "none" });
		await api.page.waitFor("document.querySelector('[data-testid=task-cluster]')?.dataset.state === 'absent'");
		expect(await cluster(api.page)).toContain("No project");
		await openTab(api.page);
		const panel = await api.page.text("[data-testid=task-panel]");
		expect(panel).toContain("No project registered");
		expect(panel).toContain("endo project add");
		expect(panel).toContain("--project");
		await shot(api.page, "tasks-instrument-no-project-1440");
	});

	it("a launch in another directory shows the tasks, flags the mismatch, and offers no way to change them", async () => {
		const root = developStore();
		const cwd = demoRepo();
		const project = await registerProject(root, cwd);
		new DevelopTasksStoreV0(root).createTask(project.id, { title: "Registered elsewhere", description: "kept" });
		const api = await launch(1440, 900, { mode: "mismatch", prior: { root, cwd, project: project.id } });
		await ready(api.page);
		expect(await api.page.text("[data-testid=project-association]")).toContain("other directory");
		expect(await api.page.eval<string>("document.querySelector('[data-testid=project-identity]').dataset.tone")).toBe(
			"attention",
		);
		await openTab(api.page);
		expect(await api.page.text("[data-testid=tasks-read-only]")).toContain("different directory");
		// Nothing is selected for the operator; they can look at a task (the choice is local: a read-only workspace remembers nothing).
		expect(await api.page.text("[data-testid=task-none-selected]")).toContain("No task selected");
		await api.page.click("[data-testid=task-picker]");
		await api.page.waitFor("document.querySelector('[data-testid=task-option]')");
		await api.page.click("[data-testid=task-option]");
		await api.page.waitFor("document.querySelector('[data-testid=task-title]')");
		expect(await api.page.text("[data-testid=task-title]")).toBe("Registered elsewhere");
		for (const hidden of ["task-edit", "task-to-in-progress", "task-link", "task-new-option"])
			expect(
				await api.page.eval<boolean>(`document.querySelector('[data-testid=${hidden}]') === null`),
				hidden,
			).toBe(true);
		await shot(api.page, "tasks-instrument-mismatch-1440");
		const stored = readFileSync(join(root, "develop", "tasks.json"), "utf8");
		expect(stored).toContain("Registered elsewhere");
		noAgentTraffic(api);
	});

	it("a damaged task file is reported as unusable, left alone, and the conversation is unaffected", async () => {
		const root = developStore();
		const cwd = demoRepo();
		const project = await registerProject(root, cwd);
		const good = readFileSync(join(root, "develop", "tasks.json"), "utf8");
		writeFileSync(join(root, "develop", "tasks.json"), '{"schemaVersion": "endo.develop-tasks.v0", "rev');
		const api = await launch(1440, 900, { prior: { root, cwd, project: project.id } });
		await api.page.waitFor("document.querySelector('[data-testid=task-cluster]')?.dataset.state === 'unreadable'");
		expect(await cluster(api.page)).toContain("not valid JSON");
		expect(await cluster(api.page)).toContain("It was not changed");
		await openTab(api.page);
		expect(await api.page.text("[data-testid=task-panel]")).toContain("develop/tasks.json");
		expect(readFileSync(join(root, "develop", "tasks.json"), "utf8")).toBe(
			'{"schemaVersion": "endo.develop-tasks.v0", "rev',
		);
		await api.page.click("[data-testid=tab-conversation]");
		expect(await api.page.eval<number>("document.querySelectorAll('.turn').length")).toBeGreaterThan(0);
		await shot(api.page, "tasks-instrument-damaged-1440");
		// Mended by the operator (here: restored): the page can read again without a reload, which would lose any unsaved words.
		writeFileSync(join(root, "develop", "tasks.json"), good);
		await api.page.click("[data-testid=tasks-read-again]");
		await api.page.waitFor("document.querySelector('[data-testid=task-panel]')?.dataset.state === 'ready'");
		expect(await cluster(api.page)).not.toContain("not valid JSON");
	});

	it("a project the store does not know shows no tasks", async () => {
		const api = await launch(1440, 900, { mode: "unknown" });
		await api.page.waitFor(
			"document.querySelector('[data-testid=task-cluster]')?.dataset.state === 'unknown-project'",
		);
		expect(await cluster(api.page)).toContain("not in this store");
	});

	it("a session that disconnects leaves the tasks as last read and does not say the work is finished", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "Survives the session");
		await page.click("[data-testid=task-to-in-progress]");
		await page.waitFor("document.querySelector('[data-testid=task-detail]').dataset.status === 'in-progress'");
		// Pi goes away: the broker ends the session and withdraws the grant, as it always has.
		api.session.live = false;
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=run-strip]').dataset.connection === 'disconnected'");
		await page.click("[data-testid=tasks-refresh]").catch(() => undefined);
		await page.waitFor("document.querySelector('[data-testid=tasks-stale-note]')");
		const note = await page.text("[data-testid=tasks-stale-note]");
		expect(note).toContain("no longer holds a pairing");
		expect(note).toContain("endo task command");
		// The task is still there, as it was; it is not marked done, and nothing can be changed from here.
		expect(await page.text("[data-testid=task-title]")).toBe("Survives the session");
		expect(await statusOf(page)).toBe("in-progress");
		for (const hidden of ["task-edit", "task-to-review", "task-link"])
			expect(await page.eval<boolean>(`document.querySelector('[data-testid=${hidden}]') === null`), hidden).toBe(
				true,
			);
		expect(await cluster(page)).toContain("last read");
		await shot(page, "tasks-instrument-disconnected-1440");
		const stored = new DevelopTasksStoreV0(api.state.root).read();
		expect(stored.ok && stored.file.tasks[0]?.status).toBe("in-progress");
	});

	it("words typed into a form when the pairing goes are kept, shown, and cannot be saved from here", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await openTab(page);
		await create(page, "First kept", "original words");
		await page.click("[data-testid=task-picker]");
		await page.click("[data-testid=task-new-option]");
		await page.waitFor("document.querySelector('[data-testid=task-create-form]')");
		await fill(page, "[data-testid=task-title-input]", "A task typed as the session ends");
		await fill(page, "[data-testid=task-description-input]", "words that must not vanish");
		// An edit open on the existing task as well.
		await page.click("[data-testid=task-picker]");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=task-option]')].find(o => o.textContent.includes('First kept')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=task-title]')?.textContent === 'First kept'");
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-description-input]", "an edit in progress");
		// The session ends and the grant goes.
		api.session.live = false;
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=run-strip]').dataset.connection === 'disconnected'");
		await page.waitFor("document.querySelector('[data-testid=tasks-stale-note]')");
		// The edit form still holds its words, says why they cannot be saved, and Save is off.
		expect(
			await page.eval<string>(
				"document.querySelector('[data-testid=task-edit-form] [data-testid=task-description-input]').value",
			),
		).toBe("an edit in progress");
		expect(await page.text("[data-testid=task-edit-form] [data-testid=task-locked]")).toContain(
			"cannot be saved from this page now",
		);
		expect(
			await page.eval<boolean>(
				"document.querySelector('[data-testid=task-edit-form] [data-testid=task-save]').disabled",
			),
		).toBe(true);
		// The tasks are still listed, and the half-typed new task is not hidden: its form is shown, locked, above the task.
		expect(await page.text("[data-testid=task-title]")).toBe("First kept");
		expect(
			await page.eval<string>(
				"document.querySelector('[data-testid=task-create-form] [data-testid=task-title-input]').value",
			),
		).toBe("A task typed as the session ends");
		expect(
			await page.eval<boolean>(
				"document.querySelector('[data-testid=task-create-form] [data-testid=task-save]').disabled",
			),
		).toBe(true);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-none]') === null")).toBe(true);
		const stored = new DevelopTasksStoreV0(api.state.root).read();
		expect(stored.ok && stored.file.tasks.map((t) => t.title)).toEqual(["First kept"]);
		expect(stored.ok && stored.file.tasks[0]?.description).toBe("original words");
	});
});

suite("laptop widths", () => {
	it("keeps the picker whole inside the centre column where the sessions list is a drawer", async () => {
		for (const [width, height] of [
			[1280, 800],
			[1100, 760],
		] as const) {
			const api = await launch(width, height);
			const { page } = api;
			await ready(page);
			await openTab(page);
			await create(page, "A task on a laptop");
			expect(await noOverflow(page)).toBe(true);
			await page.click("[data-testid=task-picker]");
			await page.waitFor("document.querySelector('[data-testid=task-list]')");
			// Not clipped by the live column's paint containment: the list lies inside it, and inside the window.
			expect(
				await page.eval<boolean>(
					"(() => { const l = document.querySelector('[data-testid=task-list]').getBoundingClientRect(); const c = document.querySelector('#develop-live').getBoundingClientRect(); return l.left >= c.left - 1 && l.right <= c.right + 1 && l.bottom <= c.bottom + 1 && l.right <= window.innerWidth; })()",
				),
			).toBe(true);
			await shot(page, `tasks-instrument-picker-${width}`);
			await page.press("Escape");
			expect(await inViewport(page, "[data-testid=stop]")).toBe(true);
			await page.close();
			tabs.splice(tabs.indexOf(page), 1);
			await api.server.close();
		}
	});
});

suite("small screens", () => {
	it("keeps the project, the picker, the task and STOP usable on a phone", async () => {
		const api = await launch(390, 844);
		const { page } = api;
		await ready(page);
		expect(await noOverflow(page)).toBe(true);
		await openTab(page);
		await create(
			page,
			"A task with a long title that has to wrap on a narrow screen without moving the page sideways",
		);
		expect(await noOverflow(page)).toBe(true);
		await page.click("[data-testid=task-picker]");
		await page.waitFor("document.querySelector('[data-testid=task-list]')");
		expect(await inViewport(page, "[data-testid=task-list]")).toBe(true);
		expect(await noOverflow(page)).toBe(true);
		await shot(page, "tasks-instrument-picker-390");
		await page.press("Escape");
		await page.click("[data-testid=tab-conversation]");
		expect(await inViewport(page, "[data-testid=stop]")).toBe(true);
		await openTab(page);
		await shot(page, "tasks-instrument-task-390");
		noAgentTraffic(api);
	});
});

suite("the read-only Studio has none of it", () => {
	it("shows no task view, asks for no workspace route and offers no task control", async () => {
		const root = developStore();
		const server = await serve(root, { ui, readBudget: { duty: 1, burstMs: 1e6 } });
		const page = await browser.open(1440, 900);
		tabs.push(page);
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=develop]')");
		expect(
			await page.eval<boolean>(
				"document.querySelector('[data-testid=tab-task]') === null && document.querySelector('[data-testid=task-cluster]') === null",
			),
		).toBe(true);
		expect(page.seen.requests.filter((r) => r.includes("workspace"))).toEqual([]);
		expect(page.seen.problems).toEqual([]);
	});
});
