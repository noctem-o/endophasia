// The project context and the Changes review in a real browser: the live broker, a real Git repository (synthetic content only), the real
// built page. What an operator sees and does: where the session works, what changed there, one file's diff, the way back to the
// conversation with STOP and the draft still in reach, and what the page says when it cannot know. Set ENDO_SHOTS_DIR to also write
// screenshots (of these synthetic fixtures; no private transcript or source is ever on screen).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GitProjectInspectorV0 } from "../adapters/git/project-inspector.ts";
import { WorkbenchBrokerV0, type WorkbenchProjectSourceV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { cleanGitFixtures, commitedRepo, demoRepo, fixtureDir, git, haveGit, write } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-project-browser-"));
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

/** A project source that counts what it is asked, so a test can say what the page did NOT read. */
class Counting implements WorkbenchProjectSourceV0 {
	overviews = 0;
	diffs = 0;
	readonly inner: GitProjectInspectorV0;
	constructor(inner: GitProjectInspectorV0) {
		this.inner = inner;
	}
	overview() {
		this.overviews += 1;
		return this.inner.overview();
	}
	/** A slow Git: every diff takes this much longer, so quick keys overlap their requests. */
	diffDelayMs = 0;
	maxDiffsAtOnce = 0;
	#running = 0;
	async diff(snapshot: string, id: number) {
		this.diffs += 1;
		this.#running += 1;
		this.maxDiffsAtOnce = Math.max(this.maxDiffsAtOnce, this.#running);
		try {
			if (this.diffDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.diffDelayMs));
			return await this.inner.diff(snapshot, id);
		} finally {
			this.#running -= 1;
		}
	}
	dispose() {
		this.inner.dispose();
	}
}

async function open(
	width: number,
	height: number,
	options: {
		cwd?: string | null;
		project?: boolean;
		gitPath?: string;
		running?: boolean;
		pair?: boolean;
		root?: string;
	} = {},
) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const source =
		options.project === false
			? null
			: new Counting(
					new GitProjectInspectorV0({
						cwd: options.cwd ?? demoRepo(),
						minRefreshMs: 0,
						...(options.gitPath === undefined ? {} : { gitPath: options.gitPath }),
					}),
				);
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		...(source === null ? {} : { project: source }),
	});
	const server = await serve(options.root ?? developStore(), {
		ui,
		workbench: broker,
		readBudget: { duty: 1, burstMs: 1e6 },
	});
	session.live_({ type: "agent_start", record: {} });
	session.live_(textMessage("user", "Make the parser stream: accept chunks and yield tokens as they complete."));
	session.live_(
		textMessage(
			"assistant",
			"I'll read the tokenizer and its tests first, then change the buffering in small steps.",
		),
	);
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor("document.querySelector('[data-testid=live-row]')");
	if (width < 1024) {
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('#develop-live')");
	} else await page.waitFor("document.querySelector('[data-testid=run-strip-words]')?.textContent");
	const api = { session, desk, broker, server, page, source, approval };
	if (options.pair !== false) await pair(api);
	return api;
}
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
async function pair(api: { page: Page; broker: WorkbenchBrokerV0 }) {
	await fill(api.page, "[data-testid=pair-code]", api.broker.issuePairingCode().code);
	await api.page.click("[data-testid=pair-submit]");
	await api.page.waitFor("document.querySelector('[data-testid=composer]')");
}
const ready = (page: Page) =>
	page.waitFor(
		"document.querySelector('[data-testid=project-counts]') || document.querySelector('[data-testid=project-unavailable]')",
	);
const rows = (page: Page) =>
	page.eval<string[]>(
		"[...document.querySelectorAll('[data-testid=change-row]')].map(r => r.dataset.area + ':' + r.dataset.status + ':' + r.querySelector('.change-name').textContent)",
	);
const choose = async (page: Page, name: string, area?: string) => {
	await page.eval(
		`[...document.querySelectorAll('[data-testid=change-row]')].find(r => r.querySelector('.change-name').textContent === ${JSON.stringify(name)} && (${JSON.stringify(area ?? "")} === '' || r.dataset.area === ${JSON.stringify(area ?? "")})).click()`,
	);
	await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state !== 'loading'");
};
const noOverflow = (page: Page) => page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth");
const view = (page: Page) => page.eval<string>("document.querySelector('#develop-live').dataset.view");

suite("the worktree beside the conversation", () => {
	it("tells the operator where the session works, what changed there, and keeps the conversation the main surface", async () => {
		const { page, source } = await open(1440, 900);
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		const bar = await page.text("[data-testid=project-header]");
		expect(bar).toContain("endophasia-demo");
		expect(bar).toContain("branch");
		expect(bar).toContain("main");
		// Each area is counted on its own: there is no single "changes by the agent" number.
		expect(await page.text("[data-testid=project-counts]")).toMatch(/\d+ staged · \d+ unstaged · \d+ untracked/);
		expect(await page.eval<string>("document.querySelector('[data-testid=project-header]').dataset.state")).toBe(
			"ready",
		);
		expect(await page.text("[data-testid=project-read-at]")).toContain("broker clock");
		expect(await page.text("[data-testid=context-worktree]")).toContain(
			"configured: the directory Pi was launched in",
		);
		// One automatic read after pairing, and nothing else.
		expect(source?.overviews).toBe(1);
		expect(source?.diffs).toBe(0);
		// The conversation is what is open, and it fills the height: the page itself does not scroll.
		expect(await view(page)).toBe("conversation");
		expect(await page.eval<boolean>("document.documentElement.scrollHeight <= window.innerHeight + 1")).toBe(true);
		// The composer is docked at the bottom of the centre column, inside the viewport.
		expect(
			await page.eval<boolean>(
				"(() => { const r = document.querySelector('form.composer').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.bottom > window.innerHeight - 40; })()",
			),
		).toBe(true);
		await shot(page, "project-conversation-1440");
		expect(page.seen.problems).toEqual([]);
	});

	it("reads a changed file in the centre, keeps STOP and the draft in reach, and returns with Escape", async () => {
		const { page, source } = await open(1440, 900);
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await fill(page, "[data-testid=composer]", "mention the tokenizer tests");
		await choose(page, "tokenizer.ts");
		expect(await view(page)).toBe("changes");
		expect(source?.diffs).toBe(1);
		expect(await page.text("[data-testid=diff-comparison]")).toContain("index → working tree (unstaged)");
		const code = await page.text("[data-testid=diff-table]");
		expect(code).toContain("tokenizeStream");
		// STOP, the run strip and the composer are still on screen while a diff is read; the draft was not lost.
		expect(
			await page.eval<boolean>(
				"!!document.querySelector('[data-testid=stop]') && document.querySelector('[data-testid=stop]').getBoundingClientRect().top > 0",
			),
		).toBe(true);
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
			"mention the tokenizer tests",
		);
		expect(await page.eval<string>("document.querySelector('[data-testid=diff-position]').textContent")).toMatch(
			/^\d+ of \d+$/,
		);
		await shot(page, "project-diff-1440");
		// j and k move through the files in the order of the list; typing in the composer is not a shortcut.
		const before = await page.text("[data-testid=diff-position]");
		await page.eval("document.activeElement && document.activeElement.blur()");
		await page.press("j");
		await page.waitFor(
			`document.querySelector('[data-testid=diff-position]').textContent !== ${JSON.stringify(before)}`,
		);
		await page.press("k");
		await page.waitFor(
			`document.querySelector('[data-testid=diff-position]').textContent === ${JSON.stringify(before)}`,
		);
		await page.eval("document.querySelector('[data-testid=composer]').focus()");
		await page.press("j");
		// The letter went into the field, as typing does, and did not move the file.
		expect(await page.text("[data-testid=diff-position]")).toBe(before);
		await fill(page, "[data-testid=composer]", "mention the tokenizer tests");
		// Escape returns to the conversation, with focus on its tab, and the draft is still there.
		await page.eval("document.activeElement.blur()");
		await page.press("Escape");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'conversation'");
		expect(await page.eval<string>("document.activeElement?.id")).toBe("develop-tab-conversation");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
			"mention the tokenizer tests",
		);
		expect(page.seen.problems).toEqual([]);
	});

	it("lists a file changed in the index and again in the working tree as two entries, each under its own comparison", async () => {
		const { page } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		const all = await rows(page);
		expect(all.filter((r) => r.endsWith(":parser.test.ts"))).toEqual([
			"staged:modified:parser.test.ts",
			"unstaged:modified:parser.test.ts",
		]);
		await choose(page, "parser.test.ts", "staged");
		expect(await page.text("[data-testid=diff-comparison]")).toContain("HEAD → index (staged)");
		const staged = await page.text("[data-testid=diff-table]");
		await choose(page, "parser.test.ts", "unstaged");
		expect(await page.text("[data-testid=diff-comparison]")).toContain("index → working tree (unstaged)");
		expect(await page.text("[data-testid=diff-table]")).not.toBe(staged);
	});

	it("shows an untracked, a deleted, a renamed and a binary file each for what it is", async () => {
		const { page } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		const all = await rows(page);
		expect(all).toContain("untracked:untracked:stream.ts");
		expect(all).toContain("unstaged:deleted:unused.ts");
		expect(all).toContain("staged:renamed:streaming.md");
		expect(await page.text("[data-testid=changes]")).toContain("docs/streaming.md ← docs/old-name.md");
		await choose(page, "stream.ts");
		expect(await page.text("[data-testid=diff-comparison]")).toContain("untracked: not in Git");
		expect(await page.eval<number>("document.querySelectorAll('.diff-added').length")).toBeGreaterThan(0);
		expect(await page.eval<number>("document.querySelectorAll('.diff-removed').length")).toBe(0);
		await choose(page, "unused.ts");
		expect(await page.eval<number>("document.querySelectorAll('.diff-removed').length")).toBe(1);
		await choose(page, "logo.png");
		expect(await page.text("[data-testid=diff-view]")).toContain("Binary file: no lines are shown.");
		await choose(page, "streaming.md");
		expect(await page.text("[data-testid=diff-view]")).toMatch(/rename from docs\/old-name\.md/);
		// Added and removed lines are told apart by a sign, which assistive technology also hears, not by colour alone.
		await choose(page, "tokenizer.ts");
		expect(
			await page.eval<boolean>(
				"[...document.querySelectorAll('.diff-added .sign')].every(c => c.textContent.includes('+') && c.textContent.includes('added'))",
			),
		).toBe(true);
	});

	it("says once that Git does not show who made a change, and never attributes one to the agent", async () => {
		const { page } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		const text = await page.eval<string>("document.body.innerText");
		expect(text.match(/Git does not show who made them/g)).toHaveLength(1);
		expect(text).toContain("nothing here attributes them to the agent");
		expect(text).not.toMatch(/changed by the agent|agent changed|agent's changes|made by the agent|agent edit/i);
		// A recorded session has no worktree at all, whoever the live one is.
		await page.eval("document.querySelector('.session-row:not(.live-row)').click()");
		await page.waitFor("!document.querySelector('[data-testid=project-header]')");
		expect(await page.eval<string>("document.body.innerText")).toContain("Project: unavailable for every session");
	});

	it("does not read again by itself: not while following, not after a long wait, and a refresh is one explicit read", async () => {
		const { page, source } = await open(1440, 900);
		await ready(page);
		await page.eval("document.querySelector('[data-testid=follow]').click()");
		await new Promise((resolve) => setTimeout(resolve, 3600));
		expect(source?.overviews).toBe(1);
		await page.click("[data-testid=project-refresh]");
		await page.waitFor("document.querySelector('[data-testid=project-refresh]').textContent === 'Refresh worktree'");
		expect(source?.overviews).toBe(2);
		expect(source?.diffs).toBe(0);
	});
});

suite("when the worktree moves on, or cannot be known", () => {
	it("shows a stale list as stale, never refreshes it behind the operator's back, and recovers with one explicit read", async () => {
		const repo = demoRepo();
		const { page, source } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		write(repo, "src/parser/stream.ts", "export const changed = 1;\n// after the list was read\n");
		await choose(page, "stream.ts");
		await page.waitFor("document.querySelector('[data-testid=diff-stale]')");
		expect(await page.text("[data-testid=diff-stale]")).toContain("The worktree changed after");
		expect(await page.text("[data-testid=diff-stale]")).not.toContain("after the list was read");
		expect(await page.eval<string>("document.querySelector('[data-testid=project-header]').dataset.current")).toBe(
			"no",
		);
		// Git said so: out of date. (When nothing could check, the chip says "unconfirmed".)
		expect(await page.text("[data-testid=project-not-current]")).toBe("out of date");
		await shot(page, "project-stale-1440");
		expect(source?.overviews).toBe(1);
		// One explicit refresh: the list is current again, and the file that was being read is read again from the new list.
		await page.click("[data-testid=diff-stale] button");
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		expect(source?.overviews).toBe(2);
		expect(await page.text("[data-testid=diff-table]")).toContain("after the list was read");
		expect(await page.eval<string>("document.querySelector('[data-testid=project-header]').dataset.current")).toBe(
			"yes",
		);
	});

	it("says a file left the list when a refresh no longer has it", async () => {
		const repo = demoRepo();
		const { page } = await open(1440, 900, { cwd: repo });
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "stream.ts");
		rmSync(join(repo, "src/parser/stream.ts"));
		await page.click("[data-testid=project-refresh]");
		await page.waitFor("document.querySelector('[data-testid=diff-gone]')");
		expect(await page.text("[data-testid=diff-gone]")).toContain("That file is no longer in this change list.");
	});

	it("is quiet where there is nothing to review: a clean worktree, an unborn branch, a detached HEAD, several worktrees", async () => {
		const clean = await open(1440, 900, { cwd: commitedRepo() });
		await ready(clean.page);
		expect(await clean.page.text("[data-testid=project-counts]")).toBe("clean");
		expect(await clean.page.text("[data-testid=changes-clean]")).toContain(
			"Clean: nothing staged, unstaged or untracked.",
		);
		await clean.page.click("[data-testid=tab-changes]");
		expect(await clean.page.text("[data-testid=diff-empty]")).toContain("Nothing is changed in the worktree.");
		await clean.page.close();

		const unborn = fixtureDir("unborn");
		git(unborn, "init", "-q", "-b", "trunk");
		const born = await open(1440, 900, { cwd: unborn });
		await ready(born.page);
		expect(await born.page.text("[data-testid=project-head]")).toContain("unborn branch trunk");
		await born.page.close();

		const root = commitedRepo();
		const sibling = join(fixtureDir("trees"), "feature");
		git(root, "worktree", "add", "-q", sibling, "-b", "feature");
		const detached = join(fixtureDir("trees"), "detached");
		git(root, "worktree", "add", "-q", "--detach", detached);
		const linked = await open(1440, 900, { cwd: detached });
		await ready(linked.page);
		expect(await linked.page.text("[data-testid=project-head]")).toContain("detached HEAD");
		// The other worktrees are places Git knows, folded away, and said not to be sessions.
		expect(await linked.page.text("[data-testid=other-worktrees]")).toContain(
			"Other worktrees of this repository (2)",
		);
		expect(await linked.page.text("[data-testid=other-worktrees]")).toContain("not sessions");
		expect(await linked.page.eval<boolean>("!document.querySelector('[data-testid=other-worktrees]').open")).toBe(
			true,
		);
		// They are not in the session list: there is still one live row.
		expect(await linked.page.eval<number>("document.querySelectorAll('[data-testid=live-row]').length")).toBe(1);
		expect(linked.page.seen.problems).toEqual([]);
	});

	it("says why a directory cannot be shown, in the page's own words and never Git's", async () => {
		const plain = await open(1440, 900, { cwd: fixtureDir("plain") });
		await ready(plain.page);
		expect(await plain.page.text("[data-testid=project-unavailable]")).toContain(
			"Not a Git worktree: Pi's launch directory is not inside a repository.",
		);
		expect(await plain.page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBe(0);
		await plain.page.click("[data-testid=tab-changes]");
		expect(await plain.page.text("[data-testid=diff-view]")).toBeTruthy();
		await shot(plain.page, "project-not-a-repository-1440");
		await plain.page.close();
		const nogit = await open(1440, 900, { cwd: commitedRepo(), gitPath: join(fixtureDir("nogit"), "git") });
		await ready(nogit.page);
		expect(await nogit.page.text("[data-testid=project-unavailable]")).toContain(
			"Git could not be run: no Git executable was found.",
		);
		expect(await nogit.page.eval<string>("document.body.innerText")).not.toMatch(/ENOENT|spawn|fatal:/);
		expect(plain.page.seen.problems).toEqual([]);
	});

	it("offers no Changes view at all when the workbench has no project context, and reads nothing", async () => {
		const { page } = await open(1440, 900, { project: false });
		await page.waitFor("document.querySelector('[data-testid=composer]')");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(
			await page.eval<boolean>(
				"!document.querySelector('[data-testid=tab-changes]') && !document.querySelector('[data-testid=project-header]')",
			),
		).toBe(true);
		expect(await page.text("[data-testid=context-worktree]")).toContain(
			"This workbench does not offer worktree reading.",
		);
		expect(page.seen.problems).toEqual([]);
	});

	it("asks to pair before it shows anything, and a reload leaves nothing behind", async () => {
		const api = await open(1440, 900, { pair: false });
		expect(await api.page.text("[data-testid=project-header]")).toContain("pair this page to read it");
		expect(await api.page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBe(0);
		await pair(api);
		await ready(api.page);
		await api.page.waitFor("document.querySelector('[data-testid=change-row]')");
		// A reload drops the page's memory: the grant, the list and the selection are gone, and nothing was kept in the browser.
		await api.page.goto(`${api.server.baseUrl}/`);
		await api.page.settled();
		await api.page.click("button[data-workspace=develop]");
		await api.page.waitFor("document.querySelector('[data-testid=pair-code]')");
		expect(await api.page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBe(0);
		expect(await api.page.text("[data-testid=project-header]")).toContain("pair this page to read it");
		expect(
			await api.page.eval<boolean>(
				"localStorage.length === 0 && sessionStorage.length === 0 && !location.href.includes('snapshot') && !document.cookie",
			),
		).toBe(true);
	});

	it("marks the worktree not current when the session has ended, and keeps what was last confirmed readable", async () => {
		const { page, session } = await open(1440, 900);
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		session.live = false;
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=project-not-current]')");
		expect(await page.text("[data-testid=project-header]")).toContain("branch");
		expect(await page.text("[data-testid=context-disconnected]")).toContain("what was last read");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBeGreaterThan(
			0,
		);
	});
});

suite("the layout at every size", () => {
	for (const [width, height] of [
		[390, 844],
		[768, 1024],
		[1024, 768],
		[1200, 800],
		[1366, 768],
		[1920, 1080],
		[2560, 1440],
		[3840, 2160],
	] as const) {
		it(`keeps the conversation, the worktree and the composer on screen at ${width}x${height} without sideways scroll`, async () => {
			const { page } = await open(width, height);
			await ready(page);
			await page.waitFor(
				"document.querySelector('[data-testid=change-row]') || document.querySelector('[data-testid=tab-changes]')",
			);
			expect(await noOverflow(page)).toBe(true);
			expect(await page.eval<boolean>("!!document.querySelector('[data-testid=project-header]')")).toBe(true);
			expect(await page.eval<boolean>("!!document.querySelector('[data-testid=composer]')")).toBe(true);
			// Reading a diff does not overflow either, and a long line scrolls inside its own region.
			await page.click("[data-testid=tab-changes]");
			if (width >= 1024) {
				await page.waitFor("document.querySelector('[data-testid=change-row]')");
				await choose(page, "tokenizer.ts");
			} else {
				await page.click("[data-testid=develop-crumb] button:last-child");
				await page.waitFor("document.querySelector('[data-testid=change-row]')");
				await choose(page, "tokenizer.ts");
				await page.waitFor("document.querySelector('[data-testid=diff-table]')");
			}
			expect(await noOverflow(page)).toBe(true);
			expect(await page.eval<boolean>("!!document.querySelector('[data-testid=diff-table]')")).toBe(true);
			if (width >= 1024) {
				// The transcript column does not stretch across a huge screen: its measure is bounded.
				await page.click("[data-testid=tab-conversation]");
				expect(
					await page.eval<boolean>(
						"document.querySelector('.turn-text').getBoundingClientRect().width <= 72 * 14",
					),
				).toBe(true);
				await page.click("[data-testid=tab-changes]");
			}
			await shot(page, `project-diff-${width}x${height}`);
			expect(page.seen.problems).toEqual([]);
		});
	}

	it("makes the sessions list a drawer at laptop widths, closed by choosing and by Escape, never a trap", async () => {
		const { page } = await open(1200, 800);
		await ready(page);
		expect(await page.eval<string>("getComputedStyle(document.querySelector('#develop-nav-wrap')).display")).toBe(
			"none",
		);
		expect(
			await page.eval<boolean>(
				"getComputedStyle(document.querySelector('[data-testid=sessions-toggle]')).display !== 'none'",
			),
		).toBe(true);
		await page.click("[data-testid=sessions-toggle]");
		expect(
			await page.eval<string>(
				"document.querySelector('[data-testid=sessions-toggle]').getAttribute('aria-expanded')",
			),
		).toBe("true");
		expect(await page.eval<string>("getComputedStyle(document.querySelector('#develop-nav-wrap')).display")).not.toBe(
			"none",
		);
		await shot(page, "project-drawer-1200");
		await page.eval("document.activeElement.blur()");
		await page.press("Escape");
		await page.waitFor("getComputedStyle(document.querySelector('#develop-nav-wrap')).display === 'none'");
		await page.click("[data-testid=sessions-toggle]");
		await page.eval("document.querySelector('.session-row:not(.live-row)').click()");
		await page.waitFor(
			"getComputedStyle(document.querySelector('#develop-nav-wrap')).display === 'none' || !document.querySelector('[data-testid=sessions-toggle]')",
		);
	});

	it("handles a very large diff and a very long path without moving the page", async () => {
		const repo = commitedRepo();
		write(
			repo,
			"a.txt",
			`${Array.from({ length: 7000 }, (_, i) => `line ${i} ${"x".repeat(i % 97 === 0 ? 2600 : 20)}`).join("\n")}\n`,
		);
		const longName = `${"deeply-nested-directory/".repeat(8)}${"a-very-long-file-name-".repeat(4)}end.ts`;
		write(repo, longName, "export {};\n");
		const { page } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "a.txt");
		expect(await page.text("[data-testid=diff-meta]")).toContain("cut at the display limit");
		expect(await page.text("[data-testid=diff-meta]")).toContain("some long lines were cut short");
		expect(
			await page.eval<boolean>(
				"(() => { const s = document.querySelector('.diff-scroll'); return s.scrollHeight > s.clientHeight && s.scrollWidth > s.clientWidth; })()",
			),
		).toBe(true);
		// However tall the diff is, the page itself does not grow: it scrolls inside its own region.
		expect(await page.eval<boolean>("document.documentElement.scrollHeight <= window.innerHeight + 1")).toBe(true);
		expect(await noOverflow(page)).toBe(true);
		// A long path is cut with an ellipsis in its row and kept whole in the tooltip.
		const title = await page.eval<string>(
			"[...document.querySelectorAll('[data-testid=change-row]')].find(r => r.title.includes('end.ts')).title",
		);
		expect(title).toContain(longName);
		expect(
			await page.eval<boolean>(
				"(() => { const r = [...document.querySelectorAll('[data-testid=change-row]')].find(r => r.title.includes('end.ts')); return r.getBoundingClientRect().right <= r.parentElement.getBoundingClientRect().right + 1; })()",
			),
		).toBe(true);
	});

	it("reaches the list and the diff from the keyboard: arrows move focus, Enter reads, the diff region can be focused and scrolled", async () => {
		const { page } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await page.eval("document.querySelector('[data-testid=change-row][tabindex=\"0\"]').focus()");
		const first = await page.eval<string>("document.activeElement.querySelector('.change-name').textContent");
		await page.press("ArrowDown");
		const second = await page.eval<string>("document.activeElement.querySelector('.change-name')?.textContent ?? ''");
		expect(second).not.toBe("");
		expect(second).not.toBe(first);
		// Moving with the arrows read nothing: only choosing does.
		expect(await view(page)).toBe("conversation");
		await page.press("Enter");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'changes'");
		expect(
			await page.eval<boolean>("document.querySelector('[data-testid=diff-view]').dataset.state !== 'idle'"),
		).toBe(true);
		expect(await page.eval<number>("document.querySelector('.diff-scroll').tabIndex")).toBe(0);
		expect(await page.eval<string>("document.querySelector('.diff-scroll').getAttribute('aria-label')")).toBe("Diff");
		// The tabs are a tab list, with the selected one the only stop and Left and Right moving between them.
		expect(
			await page.eval<string>("document.querySelector('[role=tablist]').getAttribute('aria-label')"),
		).toBeTruthy();
		expect(
			await page.eval<string>("document.querySelector('[data-testid=tab-changes]').getAttribute('aria-selected')"),
		).toBe("true");
		expect(await page.eval<number>("document.querySelector('[data-testid=tab-conversation]').tabIndex")).toBe(-1);
	});

	it("reaches a file from the context stage on a narrow screen and comes back to the conversation with the back crumb", async () => {
		const { page } = await open(390, 844);
		await ready(page);
		await page.click("[data-testid=develop-crumb] button:last-child");
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "tokenizer.ts");
		await page.waitFor(
			"document.querySelector('#develop-live') && document.querySelector('[data-testid=diff-table]')",
		);
		expect(await view(page)).toBe("changes");
		await page.click("[data-testid=diff-back]");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'conversation'");
		expect(await page.eval<boolean>("!!document.querySelector('[data-testid=turn-user]')")).toBe(true);
	});
});

suite("nothing here can change the repository, authorise or run anything", () => {
	it("has no control that stages, commits, reverts, checks out, pushes, approves or runs a command", async () => {
		const { page } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "tokenizer.ts");
		const labels = await page.eval<string[]>(
			"[...document.querySelectorAll('button, [role=button], a, input[type=submit]')].map(b => (b.textContent + ' ' + (b.title || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase())",
		);
		for (const label of labels) {
			expect(label, label).not.toMatch(
				/\b(stage|unstage|commit|revert|discard|checkout|push|pull|reset|stash|restore|approve|authori[sz]e|confirm|execute)\b/,
			);
		}
		expect(await page.eval<number>("document.querySelectorAll('iframe, object, embed, form[action]').length")).toBe(
			0,
		);
		// The page spoke only to the broker's closed routes, with GET for everything it read.
		const urls = await page.eval<string[]>("performance.getEntriesByType('resource').map(e => e.name)");
		const unexpected = urls
			.filter((u) => u.includes("/api/v0/"))
			.map((u) => u.replace(/^https?:\/\/[^/]+\/[^/]+/, ""))
			.filter(
				(u) =>
					!/^\/api\/v0\/(workbench\/(status|transcript|pair|project|project\/diff)|develop\/|snapshot)/.test(u),
			);
		expect(unexpected).toEqual([]);
		expect(urls.filter((u) => /project\/diff/.test(u)).every((u) => /snapshot=[0-9a-f]{16}&file=\d+$/.test(u))).toBe(
			true,
		);
		// No path, branch or file name is in any URL the page used.
		expect(urls.some((u) => u.includes("tokenizer") || u.includes("src%2F") || u.includes("/src/"))).toBe(false);
	});

	it("leaves STOP, STEER, QUEUE and prompt exactly as governed as before: requested here, approved only in the terminal", async () => {
		const { page, approval, desk } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "tokenizer.ts");
		await page.click("[data-testid=stop]");
		await page.waitFor("document.querySelector('[data-testid=stop-status]')");
		expect(await page.text("[data-testid=stop-status]")).toContain("Stop requested · awaiting terminal approval");
		const request = await approval.waitForRequest();
		expect(request.operation).toBe("stop");
		// Reading a diff approved nothing: no request reached the desk.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(desk.applyCalls).toEqual([]);
	});
});

suite("what Opus's second review found, pinned", () => {
	it("never reads an unknown as 'nothing changed': a directory that is not a repository says its changes are unknown", async () => {
		const { page } = await open(1440, 900, { cwd: fixtureDir("plain") });
		await ready(page);
		await page.click("[data-testid=tab-changes]");
		const text = await page.text("[data-testid=diff-empty]");
		expect(text).toContain("Changes unknown:");
		expect(text).not.toContain("Nothing is changed");
		expect(await page.text("[data-testid=changes]")).toContain("Changes: unknown");
		expect(await page.text("[data-testid=project-unavailable]")).not.toContain(
			"Worktree unavailable: Not a Git worktree: ",
		);
	});

	it("says a file cannot be read once the grant is gone, instead of reading forever, and keeps the last confirmed list", async () => {
		const { page, session } = await open(1440, 900);
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		session.live = false;
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=project-not-current]')");
		await choose(page, "tokenizer.ts");
		expect(await page.eval<string>("document.querySelector('[data-testid=diff-view]').dataset.state")).toBe("failed");
		expect(await page.text("[data-testid=diff-view]")).toContain("no longer paired");
		expect(await page.text("[data-testid=diff-view]")).not.toContain("Reading");
		expect(await page.text("[data-testid=project-not-current]")).toBe("unconfirmed");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBeGreaterThan(
			0,
		);
	});

	it("names the session in the run strip, and shows STOP last with a short clause and the whole sentence as its description", async () => {
		const { page } = await open(1440, 900);
		expect(await page.text("[data-testid=run-strip-session]")).toContain("pi.fake-session-1");
		const visible = await page.eval<string>("document.querySelector('.stop-short')?.textContent ?? ''");
		expect(visible).toContain("approve in the terminal");
		expect(
			await page.eval<string>("document.querySelector('[data-testid=stop]').getAttribute('aria-describedby')"),
		).toBe("stop-reason");
		expect(await page.text("[data-testid=stop-reason]")).toContain("Asks Pi to abort the run that is open");
		expect(
			await page.eval<boolean>("document.querySelector('[data-testid=stop-reason]').classList.contains('sr-only')"),
		).toBe(true);
		// STOP is the last thing in the strip.
		expect(
			await page.eval<boolean>(
				"document.querySelector('.run-strip').lastElementChild.contains(document.querySelector('[data-testid=stop]'))",
			),
		).toBe(true);
	});

	it("tells the operator something arrived in the conversation while changes are being read", async () => {
		const { page, session } = await open(1440, 900);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "tokenizer.ts");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=conversation-new]')")).toBe(true);
		session.live_(textMessage("assistant", "Should I also update the docs?"));
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=conversation-new]')");
		expect(await page.text("[data-testid=tab-conversation]")).toContain("new");
		await page.click("[data-testid=tab-conversation]");
		await page.waitFor("!document.querySelector('[data-testid=conversation-new]')");
	});

	it("scrolls the diff with PageDown and PageUp from the list, and keeps the file being read in view as j and k step through a long list", async () => {
		const repo = commitedRepo();
		for (let i = 0; i < 60; i++)
			write(repo, `many/file-${String(i).padStart(3, "0")}.txt`, `${"line\n".repeat(200)}`);
		const { page, source } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelectorAll('[data-testid=change-row]').length >= 60");
		if (source !== null) source.diffDelayMs = 90;
		await choose(page, "file-000.txt");
		await page.eval("document.activeElement.blur()");
		const top = () => page.eval<number>("document.querySelector('.diff-scroll').scrollTop");
		expect(await top()).toBe(0);
		await page.press("PageDown");
		await page.waitFor("document.querySelector('.diff-scroll').scrollTop > 100");
		await page.press("PageUp");
		await page.waitFor("document.querySelector('.diff-scroll').scrollTop === 0");
		// A held key: 25 presses a millisecond apart, faster than a diff can be read.
		await page.eval(
			"(async () => { for (let i = 0; i < 25; i++) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 1)); } })()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-position]').textContent.startsWith('26 of')");
		// The file being read is READ, however fast the keys came: the newest request wins and none ends as "busy".
		await page.waitFor("document.querySelector('[data-testid=diff-view]').dataset.state === 'ready'");
		expect(await page.text("[data-testid=diff-view]")).not.toContain("Another inspection");
		// One diff at a time asked of the broker, however many keys: the newest file wins, the ones in between are not asked for.
		expect(source?.maxDiffsAtOnce).toBe(1);
		expect(source?.diffs ?? 99).toBeLessThan(15);
		// The selected row is inside the visible part of its scrolling column.
		expect(
			await page.eval<boolean>(
				"(() => { const r = document.querySelector('button.change-row[aria-pressed=true]').getBoundingClientRect(); const c = document.querySelector('#develop-context .panel-body').getBoundingClientRect(); return r.top >= c.top - 1 && r.bottom <= c.bottom + 1; })()",
			),
		).toBe(true);
	});

	it("keeps the sign column in view when a wide diff scrolls sideways, and dims a selected mode that cannot be requested now", async () => {
		const repo = commitedRepo();
		write(repo, "a.txt", `${"w".repeat(1500)}\none\n`);
		const { page } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await choose(page, "a.txt");
		expect(await page.eval<string>("getComputedStyle(document.querySelector('.diff .sign')).position")).toBe(
			"sticky",
		);
		await page.eval("document.querySelector('.diff-scroll').scrollLeft = 400");
		expect(
			await page.eval<boolean>(
				"(() => { const s = document.querySelector('.diff .diff-added .sign'); const c = document.querySelector('.diff-scroll').getBoundingClientRect(); const r = s.getBoundingClientRect(); return r.left >= c.left && r.right < c.left + 140; })()",
			),
		).toBe(true);
		// A run is open, so a NEW prompt cannot be requested: the selected Prompt mode reads as unavailable, not as ready.
		expect(await page.eval<string>("document.querySelector('.mode[data-mode=prompt]').dataset.offered")).toBe("no");
		expect(await page.eval<string>("document.querySelector('.mode[data-mode=steer]').dataset.offered")).toBe("yes");
	});

	it("returns from a diff to the conversation with Escape on a narrow screen, not to the sessions list, and shows the list when nothing is selected", async () => {
		const { page } = await open(390, 844);
		await ready(page);
		await page.click("[data-testid=tab-changes]");
		// Nothing selected: the list is here, not on another stage.
		await page.waitFor("document.querySelector('[data-testid=diff-empty] [data-testid=change-row]')");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=diff-empty] [data-testid=change-row]')].find(r => r.textContent.includes('tokenizer')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-table]')");
		await page.eval("document.activeElement && document.activeElement.blur()");
		await page.press("Escape");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'conversation'");
		expect(
			await page.eval<boolean>(
				"!!document.querySelector('#develop-live') && !document.querySelector('[data-testid=live-row]')",
			),
		).toBe(true);
	});

	it("takes focus into the drawer, closes it with Escape (even from its filter) and with a click outside, and gives focus back", async () => {
		const { page } = await open(1200, 800);
		await ready(page);
		await page.click("[data-testid=sessions-toggle]");
		await page.waitFor("document.querySelector('#develop-nav-wrap').contains(document.activeElement)");
		await page.eval("document.querySelector('#develop-nav-wrap input').focus()");
		await page.press("Escape");
		await page.waitFor("getComputedStyle(document.querySelector('#develop-nav-wrap')).display === 'none'");
		expect(await page.eval<string>("document.activeElement.dataset.testid")).toBe("sessions-toggle");
		await page.click("[data-testid=sessions-toggle]");
		await page.eval(
			"document.querySelector('#develop-inspector, #develop-context').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))",
		);
		await page.waitFor("getComputedStyle(document.querySelector('#develop-nav-wrap')).display === 'none'");
	});
});

suite("what the operator's own Git hides", () => {
	it("says untracked files are hidden where the repository turns them off, rather than calling the worktree clean without qualification", async () => {
		const repo = commitedRepo();
		git(repo, "config", "status.showUntrackedFiles", "no");
		write(repo, "stray.txt", "x\n");
		const { page } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelector('[data-testid=incomplete-untracked-hidden]')");
		expect(await page.text("[data-testid=project-counts]")).toContain("untracked files hidden by this repository");
		expect(await page.text("[data-testid=incomplete-untracked-hidden]")).toContain("none are listed or counted");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=change-row]').length")).toBe(0);
	});
});

suite("two files that look the same", () => {
	it("reads each as itself, and steps through both with the keyboard, when their names are the same once made safe", async () => {
		const repo = commitedRepo();
		write(repo, "a\nb.txt", "the one with a newline\n");
		write(repo, "a\u240ab.txt", "the one with a picture\n");
		const { page } = await open(1440, 900, { cwd: repo });
		await ready(page);
		await page.waitFor("document.querySelectorAll('[data-testid=change-row]').length === 2");
		const body = () => page.text("[data-testid=diff-table]");
		await page.eval("document.querySelectorAll('[data-testid=change-row]')[1].click()");
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		const second = await body();
		await page.eval("document.querySelectorAll('[data-testid=change-row]')[0].click()");
		await page.waitFor("document.querySelector('[data-testid=diff-position]').textContent.startsWith('1 of')");
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		const first = await body();
		expect(first).not.toBe(second);
		expect([first, second].sort()).toEqual([
			expect.stringContaining("the one with a newline"),
			expect.stringContaining("the one with a picture"),
		]);
		// j from the first reaches the second (it is not skipped), and k comes back.
		await page.eval("document.activeElement && document.activeElement.blur()");
		await page.press("j");
		await page.waitFor("document.querySelector('[data-testid=diff-position]').textContent.startsWith('2 of')");
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		expect(await body()).toBe(second);
	});
});
