// The attention overview in a real browser: the live broker over a fake Pi session, the real task, attempt and receipt stores, a real Git
// repository (synthetic content), and the real built page. Set ENDO_SHOTS_DIR to also write screenshots (synthetic fixtures only).
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { GitRevisionObserverV0 } from "../adapters/git/revision-observer.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import type { EndoReceiptCurrentV0 } from "../protocol/develop-receipts.ts";
import { DevelopWorkspaceServiceV0 } from "../runtime/contracts/develop-workspace.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopReceiptsStoreV0 } from "../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { seedAttention } from "./studio-attention-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-attention-browser-"));
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

/** As cli/workbench.ts observes it: the launch directory's HEAD, read-only. */
const revisions = new GitRevisionObserverV0();
async function currentOf(directory: string): Promise<EndoReceiptCurrentV0 | null> {
	const seen = await revisions.observe(directory, { within: true });
	if (!seen.ok) return null;
	const o = seen.observation;
	return { worktree: o.worktree, commonDir: o.commonDir, commit: o.commit, clean: o.dirty.length === 0 };
}

async function registerProject(root: string, cwd: string) {
	const inspector = new GitProjectInspectorV0({ cwd, minRefreshMs: 0 });
	const overview = await inspector.overview();
	inspector.dispose();
	const made = new DevelopTasksStoreV0(root).registerProject({
		name: "Parser work",
		path: realpathSync(cwd),
		observedGitRoot: overview.repository?.root ?? null,
	});
	if (!made.ok) throw new Error(`registration refused: ${made.code}`);
	return made.value.id;
}

const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);

interface LaunchOptions {
	seed?: boolean;
	pair?: boolean;
	/** Serve the receipts' comparison through this instead of the real observer (to hold or fail it). */
	current?: (directory: string) => Promise<EndoReceiptCurrentV0 | null>;
	/** Launch without attempt records (an older workbench). */
	noAttempts?: boolean;
	prior?: { root: string; cwd: string; project: string };
	page?: Page;
}

async function launch(width: number, height: number, options: LaunchOptions = {}) {
	const root = options.prior?.root ?? developStore();
	const cwd = options.prior?.cwd ?? demoRepo();
	const project = options.prior?.project ?? (await registerProject(root, cwd));
	const current = await currentOf(cwd);
	if (current === null) throw new Error("the demo repository cannot be observed");
	const seeded = options.seed === false || options.prior !== undefined ? null : seedAttention(root, project, current);
	const session = new FakeSession();
	session.runActive = true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		project: new GitProjectInspectorV0({ cwd, minRefreshMs: 0 }),
		aliasOf: (id) => `endo.session.alias-of-${id.length}`,
		tasks: {
			open: (host) =>
				new DevelopWorkspaceServiceV0(
					new DevelopTasksStoreV0(root),
					options.noAttempts === true
						? {}
						: {
								attempts: new DevelopAttemptsStoreV0(root),
								receipts: { store: new DevelopReceiptsStoreV0(root), current: options.current ?? currentOf },
							},
				).forLaunch({ projectId: project, launchDirectory: cwd }, host),
		},
	});
	const server = await serve(root, { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	session.live_({ type: "agent_start", record: {} });
	session.live_(textMessage("user", "Make the parser stream: accept chunks and yield tokens as they complete."));
	session.live_(textMessage("assistant", "I'll read the tokenizer and its tests first."));
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
	const api = { session, desk, broker, server, page, approval, seeded, current, state: { root, cwd, project } };
	if (options.pair !== false) await pair(api);
	return api;
}
type Api = Awaited<ReturnType<typeof launch>>;

async function pair(api: { page: Page; broker: WorkbenchBrokerV0 }) {
	await fill(api.page, "[data-testid=pair-code]", api.broker.issuePairingCode().code);
	await api.page.click("[data-testid=pair-submit]");
	await api.page.waitFor("document.querySelector('[data-testid=composer]')");
}
const ready = (page: Page) =>
	page.waitFor("document.querySelector('[data-testid=task-cluster]')?.dataset.state === 'ready'");

const draftOf = (page: Page) => page.eval<string>("document.querySelector('[data-testid=composer]').value");
const noOverflow = (page: Page) => page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const overview = (page: Page) =>
	page.waitFor("document.querySelector('[data-testid=attention-overview]')?.dataset.evidence === 'shown'");
/** The rows of one section, in order: [title, first flag]. */
const rowsOf = (page: Page, section: string) =>
	page.eval<[string, string][]>(
		`[...document.querySelectorAll('[data-testid=attention-${section}] [data-testid=attention-row]')].map((r) => [r.querySelector('.attn-title').textContent, r.dataset.flag])`,
	);
const statuses = (root: string) =>
	(
		JSON.parse(readFileSync(join(root, "develop", "tasks.json"), "utf8")) as {
			tasks: { id: string; status: string }[];
		}
	).tasks
		.map((t) => `${t.id}:${t.status}`)
		.sort();
/** The attempt and receipt records, with their sizes and stamps: reading and navigating must leave them exactly as they were. */
function records(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const s = statSync(p);
			if (s.isDirectory()) walk(p);
			else out.push(`${p}:${s.size}:${s.mtimeMs}`);
		}
	};
	for (const dir of ["attempts", "receipts"]) walk(join(root, "develop", dir));
	return out;
}
const noAgentTraffic = (api: Api) => {
	expect(api.session.promptCalls).toEqual([]);
	expect(api.approval.requests).toEqual([]);
	expect(api.desk.applyCalls).toEqual([]);
	expect(api.desk.proposals.size).toBe(0);
	expect(api.session.records).toEqual([]);
	expect(api.page.seen.requests.filter((r) => /prompt\/propose|intervention\/propose/.test(r))).toEqual([]);
};

suite("the overview: what needs the operator, and why", () => {
	it("lists decisions, failed and inconclusive checks first, the rest below, the finished folded away, and changes nothing", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		const before = { statuses: statuses(api.state.root), records: records(api.state.root) };
		// From the conversation: one quiet line in the bar says how many tasks need the operator, and leads to the overview.
		await page.waitFor("document.querySelector('[data-testid=attention-link]')");
		expect(await page.text("[data-testid=attention-link]")).toBe("5 need attention");
		// Even from an unfinished new task: the link leaves the form (its words are kept) and opens the overview.
		await page.click("[data-testid=task-picker]");
		await page.click("[data-testid=task-new-option]");
		await page.waitFor("document.querySelector('[data-testid=task-create-form]')");
		await fill(page, "[data-testid=task-title-input]", "half-written task");
		await page.click("[data-testid=tab-conversation]");
		await page.click("[data-testid=attention-link]");
		await overview(page);
		expect(await page.eval<string>("document.querySelector('#develop-live').dataset.view")).toBe("task");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=task-create-form]') === null")).toBe(true);
		const needs = await rowsOf(page, "needs");
		// Decisions first (most recently marked for review first), then the failure, then the inconclusive check.
		expect(needs.map(([, flag]) => flag)).toEqual(["decision", "decision", "decision", "failed", "inconclusive"]);
		expect(needs.slice(3).map(([title]) => title)).toEqual(["Normalize CRLF line endings", "Unicode identifiers"]);
		const text = await page.text("[data-testid=attention-needs]");
		expect(text).toContain("Latest observed npm test exited with code 1");
		expect(text).toContain("Other runs of it here: 1 passed.");
		expect(text).toContain("Passing npm test belongs to an earlier commit (fffffff)");
		expect(text).toContain("Latest attempt: Result reported, not verified.");
		expect(text).toContain("No attempts or observed checks recorded.");
		expect(text).toContain("was stopped at its time limit");
		// A pass that followed a failure, a check from another working tree and a blocked task are under way, not urgent.
		const waiting = (await rowsOf(page, "waiting")).map(([title]) => title);
		expect(waiting[0]).toBe("Benchmark the streaming path");
		expect(waiting).toEqual(
			expect.arrayContaining(["Accept trailing commas", "Source maps for tokens", "Benchmark the streaming path"]),
		);
		const under = await page.text("[data-testid=attention-waiting]");
		expect(under).toContain("waiting on the CI runner image");
		expect(under).toContain("in a different working tree; not compared with this one");
		expect(under).toContain("Other runs of it here: 1 failed.");
		expect((await rowsOf(page, "open")).map(([title]) => title).sort()).toEqual([
			"Document the streaming API",
			"Tighten the lint configuration",
		]);
		// The finished tasks are folded away; the old failure of one of them is not shown anywhere.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=attention-done]').open")).toBe(false);
		expect(await page.text("[data-testid=attention-done]")).toContain("Done (2)");
		expect(await page.text("[data-testid=attention-overview]")).not.toContain("exited with code 2");
		// The new task's words were kept: asking for a new task again shows them.
		await page.click("[data-testid=task-picker]");
		await page.click("[data-testid=task-new-option]");
		await page.waitFor("document.querySelector('[data-testid=task-create-form]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"half-written task",
		);
		await page.click("[data-testid=task-cancel]");
		await overview(page);
		// Words, never colour alone; nothing called verified or accepted; no path on the page.
		const all = await page.text("[data-testid=attention-overview]");
		expect(all).not.toMatch(/\bverified\b(?<!not verified)|accepted|approved|priority|score/i);
		expect(all).not.toContain(api.state.root);
		expect(all).not.toContain(api.state.cwd);
		expect(await noOverflow(page)).toBe(true);
		await shot(page, "attention-instrument-overview-1440");
		// Reading changed nothing: no status, no record; and the only requests were reads.
		expect(statuses(api.state.root)).toEqual(before.statuses);
		expect(records(api.state.root)).toEqual(before.records);
		expect(page.seen.requests.filter((r) => /workspace\/tasks\//.test(r))).toEqual([]);
		expect(
			page.seen.requests.filter((r) => /attention/.test(r)).every((r) => r.endsWith("/workspace/attention")),
		).toBe(true);
		noAgentTraffic(api);
		expect(page.seen.problems).toEqual([]);
	});

	it("opens a task and the check a row is about, by pointer and by keyboard, keeping the composer's words and an unsaved edit", async () => {
		const api = await launch(1440, 900);
		const { page } = api;
		await ready(page);
		await fill(page, "[data-testid=composer]", "an unsent draft");
		await page.click("[data-testid=tab-task]");
		await overview(page);
		const before = statuses(api.state.root);
		// Pointer: the failed check's row opens its task, its attempt, and the receipt it is about.
		await page.click("[data-testid=attention-row][data-flag=failed]");
		await page.waitFor("document.querySelector('[data-receipt-id][data-focused=true]')");
		expect(await page.text("[data-testid=task-title]")).toBe("Normalize CRLF line endings");
		const focused = await page.eval<[string, string]>(
			"(() => { const r = document.querySelector('[data-receipt-id][data-focused=true]'); return [r.dataset.outcome, document.activeElement === r ? 'focused' : 'not']; })()",
		);
		expect(focused).toEqual(["failed", "focused"]);
		await shot(page, "attention-instrument-opened-1440");
		// An unsaved edit on this task.
		await page.click("[data-testid=task-edit]");
		await fill(page, "[data-testid=task-title-input]", "Normalize CRLF line endings (draft)");
		// Back to the overview, then the keyboard: Down twice and Enter opens the third row.
		await page.click("[data-testid=task-overview]");
		await overview(page);
		await page.eval("document.querySelector('[data-testid=attention-row]').focus()");
		await page.press("ArrowDown");
		await page.press("ArrowDown");
		const third = await page.eval<string>("document.activeElement.querySelector('.attn-title').textContent");
		expect(await page.eval<boolean>("document.activeElement.matches(':focus-visible')")).toBe(true);
		await page.press("Enter");
		await page.waitFor(
			`document.querySelector('[data-testid=task-title]')?.textContent === ${JSON.stringify(third)}`,
		);
		// The edit is still there when its task is opened again; the composer's words never moved.
		await page.click("[data-testid=task-overview]");
		await overview(page);
		await page.click("[data-testid=attention-row][data-flag=failed]");
		await page.waitFor("document.querySelector('[data-testid=task-edit-form]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=task-title-input]').value")).toBe(
			"Normalize CRLF line endings (draft)",
		);
		await page.click("[data-testid=tab-conversation]");
		expect(await draftOf(page)).toBe("an unsent draft");
		// Opening tasks chose them (the picker's own request) and did nothing else: no status moved, nothing reached the agent.
		expect(statuses(api.state.root)).toEqual(before);
		expect(
			page.seen.requests
				.filter((r) => /workspace\/tasks\//.test(r))
				.every((r) => r.endsWith("/workspace/tasks/select")),
		).toBe(true);
		noAgentTraffic(api);
		expect(page.seen.problems).toEqual([]);
	});

	it("a pairing revoked while the overview is being read leaves it as last read, never current", async () => {
		let release: () => void = () => {};
		let hold = false;
		const api = await launch(1440, 900, {
			current: async (dir) => {
				if (hold)
					await new Promise<void>((r) => {
						release = r;
					});
				return currentOf(dir);
			},
		});
		const { page } = api;
		await ready(page);
		await page.click("[data-testid=tab-task]");
		await overview(page);
		hold = true;
		await page.click("[data-testid=attention-refresh]");
		await page.waitFor("document.querySelector('[data-testid=attention-refresh]')?.textContent === 'Reading…'");
		api.broker.endSession();
		release();
		await page.waitFor("document.querySelector('[data-testid=attention-overview]')?.dataset.current === 'false'");
		expect(await page.text("[data-testid=attention-stale]")).toMatch(/As last read/);
		// What was read stays readable, and says so.
		expect((await rowsOf(page, "needs")).length).toBe(5);
		await shot(page, "attention-instrument-stale-1440");
		// The browser logs the refusal itself; nothing else went wrong.
		expect(page.seen.problems.every((p) => p.includes("status of 401"))).toBe(true);
	});

	it("says when no checks can be shown, and never reads an empty list as all clear", async () => {
		const absent = await launch(1440, 900, { noAttempts: true });
		await ready(absent.page);
		await absent.page.click("[data-testid=tab-task]");
		await absent.page.waitFor(
			"document.querySelector('[data-testid=attention-overview]')?.dataset.evidence === 'absent'",
		);
		expect(await absent.page.text("[data-testid=attention-evidence]")).toContain("serves no attempt records");
		// The statuses still sort the tasks: the decisions are there, nothing claims a check failed or passed.
		expect((await rowsOf(absent.page, "needs")).map(([, f]) => f)).toEqual(["decision", "decision", "decision"]);
		expect(await absent.page.text("[data-testid=attention-overview]")).not.toMatch(/exited|passed/);

		const blind = await launch(1440, 900, { current: async () => null });
		await ready(blind.page);
		await blind.page.click("[data-testid=tab-task]");
		await overview(blind.page);
		expect(await blind.page.text("[data-testid=attention-note]")).toContain("HEAD could not be read");
		expect(await blind.page.text("[data-testid=attention-needs]")).toContain(
			"cannot currently be compared with this worktree",
		);
		expect(await blind.page.text("[data-testid=attention-head]")).toBe("checks not compared: HEAD not read");
	});

	for (const [appearance, width, height] of [
		["field", 1440, 900],
		["instrument", 390, 844],
	] as const)
		it(`reads the same in ${appearance} at ${width} px`, async () => {
			const api = await launch(width, height);
			const { page } = api;
			if (appearance === "field") {
				await page.click("[data-testid=appearance-field]");
				await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
			}
			await ready(page);
			await page.waitFor("document.querySelector('[data-testid=attention-link]')");
			await shot(page, `attention-${appearance}-conversation-${width}`);
			await page.click("[data-testid=attention-link]");
			await overview(page);
			expect((await rowsOf(page, "needs")).map(([, f]) => f)).toEqual([
				"decision",
				"decision",
				"decision",
				"failed",
				"inconclusive",
			]);
			// The word, not only the colour: every flagged line says what it is.
			expect(
				await page.eval<string[]>(
					"[...document.querySelectorAll('[data-testid=attention-needs] .attn-tag')].map((t) => t.textContent)",
				),
			).toEqual(expect.arrayContaining(["Decision", "Check failed", "Inconclusive", "Recheck"]));
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `attention-${appearance}-overview-${width}`);
			await page.click("[data-testid=attention-row][data-flag=failed]");
			await page.waitFor("document.querySelector('[data-receipt-id][data-focused=true]')");
			expect(await noOverflow(page)).toBe(true);
			await shot(page, `attention-${appearance}-opened-${width}`);
			expect(page.seen.problems).toEqual([]);
		});
});
