// The denser DEVELOP workbench in a real browser (DEVELOP-UI-DENSITY-001): one head for the session and its worktree, a graphite STOP in
// both appearances, a composer whose mode, effect and request share one row, a context column that leads with the worktree's own counts,
// and an Instrument Context column that can be hidden for the conversation without losing or re-reading anything. Real broker, real Git
// (synthetic content), the real built page.
import { mkdtempSync, rmSync } from "node:fs";
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
import { cleanGitFixtures, demoRepo, haveGit } from "./git-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-density-browser-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
beforeAll(async () => {
	if (executable === null) {
		if (process.env.ENDO_REQUIRE_BROWSER === "1") throw new Error("Chromium required");
		return;
	}
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
const suite = executable === null || !haveGit ? describe.skip : describe;

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
	diff(snapshot: string, id: number) {
		this.diffs += 1;
		return this.inner.diff(snapshot, id);
	}
	dispose() {
		this.inner.dispose();
	}
}

const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		"(() => { const e = document.querySelector(" +
			JSON.stringify(selector) +
			"); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, " +
			JSON.stringify(value) +
			"); e.dispatchEvent(new Event('input', { bubbles: true })); })()",
	);

async function open(width: number, height: number, options: { running?: boolean; field?: boolean } = {}) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const approval = new Approval();
	const source = new Counting(new GitProjectInspectorV0({ cwd: demoRepo(), minRefreshMs: 0 }));
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: new FakeDesk(session),
		project: source,
	});
	const server = await serve(developStore(), { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	session.live_({ type: "agent_start", record: {} });
	for (let i = 0; i < 30; i++)
		session.live_(
			textMessage(i % 2 === 0 ? "user" : "assistant", `Line ${i} of a conversation long enough to scroll.`),
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
	}
	if (options.field === true) {
		await page.click("[data-testid=appearance-field]");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
	}
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	if (width >= 1024)
		await page.waitFor("document.querySelector('[data-testid=project-header]')?.dataset.state === 'ready'");
	return { page, source, session, broker, server, approval };
}

const box = (page: Page, selector: string) =>
	page.eval<{ top: number; bottom: number; left: number; right: number; width: number; height: number } | null>(
		"(() => { const e = document.querySelector(" +
			JSON.stringify(selector) +
			"); if (!e || e.getClientRects().length === 0) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; })()",
	);
const shown = (page: Page, selector: string) =>
	page.eval<boolean>(
		"(() => { const e = document.querySelector(" +
			JSON.stringify(selector) +
			"); return !!e && e.getClientRects().length > 0; })()",
	);
/** WCAG relative luminance and contrast, from computed rgb() strings. */
const COLOUR =
	"const lum = (s) => { const [r, g, b] = s.match(/\\d+(\\.\\d+)?/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }; const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };";
/** The stop's border pixel against the pixels painted just outside it (left, right, above) and its fill, from a PNG of the page. */
const PAINTED = (png: string) =>
	"(async () => { " +
	COLOUR +
	" const b = document.querySelector('[data-testid=stop]').getBoundingClientRect(); const raw = atob('" +
	png +
	"'); const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0)); const img = await createImageBitmap(new Blob([bytes], { type: 'image/png' })); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const x = c.getContext('2d'); x.drawImage(img, 0, 0); const px = (X, Y) => { const d = x.getImageData(Math.round(X), Math.round(Y), 1, 1).data; return 'rgb(' + d[0] + ', ' + d[1] + ', ' + d[2] + ')'; }; const y = b.top + b.height / 2; const border = px(b.left + b.width / 2, b.top + 0.5); const around = [px(b.left - 4, y), px(b.right + 4, y), px(b.left + 20, b.top - 3), px(b.left + b.width / 2, b.top - 3), px(b.right - 20, b.top - 3)]; return { outside: around.map((o) => ratio(border, o)), fill: ratio(border, px(b.left + b.width / 2, b.top + 4)) }; })()";

suite("the head of the work", () => {
	it("keeps the session and the worktree as two elements on fewer lines, with the read times in Context", async () => {
		const { page } = await open(1440, 900);
		// Two sources, two elements: the run line holds no Git fact, the worktree line no session fact.
		expect(await page.eval<boolean>("!!document.querySelector('.session-head > [data-testid=run-strip]')")).toBe(
			true,
		);
		expect(await page.eval<boolean>("!!document.querySelector('.session-head > [data-testid=project-header]')")).toBe(
			true,
		);
		expect(
			await page.eval<boolean>("!document.querySelector('[data-testid=run-strip] [data-testid=project-header]')"),
		).toBe(true);
		expect(await page.eval<string>("document.querySelector('[data-testid=project-header]').title")).toContain(
			"read with Git",
		);
		// The times of the last reads are not in the head: they are in Context, each with the clock it was read by.
		expect(await page.text("[data-testid=run-strip]")).not.toContain("clock");
		expect(await page.text("[data-testid=project-header]")).not.toContain("clock");
		expect(await page.text("#develop-context [data-testid=project-read-at]")).toContain("(broker clock)");
		expect(await page.text("#develop-context [data-testid=context-status-read]")).toContain("(browser clock)");
		// Every count is its own, in the head and in Context.
		expect(await page.text("[data-testid=project-counts]")).toMatch(/\d+ staged · \d+ unstaged · \d+ untracked/);
		const counts = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=context-counts] li')].map((li) => li.dataset.area + ':' + li.textContent)",
		);
		expect(counts.map((c) => c.split(":")[0])).toEqual(["staged", "unstaged", "untracked"]);
		expect(counts.join("|")).toMatch(
			/staged:3 staged HEAD → index\|unstaged:5 unstaged index → working tree\|untracked:2 untracked not in Git/,
		);
		// The head above the conversation is at most the tabs and two lines (it was the tabs and three bars).
		const live = await box(page, "#develop-live");
		const view = await box(page, "#develop-view-conversation");
		expect((view?.top ?? 0) - (live?.top ?? 0)).toBeLessThanOrEqual(124);
		// STOP is in view, last in the run line, and keeps its description.
		expect(
			await page.eval<boolean>(
				"document.querySelector('.run-strip').lastElementChild.contains(document.querySelector('[data-testid=stop]'))",
			),
		).toBe(true);
		expect(
			await page.eval<string>("document.querySelector('[data-testid=stop]').getAttribute('aria-describedby')"),
		).toBe("stop-reason");
		expect(
			await page.eval<boolean>(
				"document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1",
			),
		).toBe(true);
	});

	it("puts the worktree beside the session where the column is wide, and keeps a lost broker's warning in the head", async () => {
		const wide = await open(3840, 2160);
		const run = await box(wide.page, "[data-testid=run-strip]");
		const tree = await box(wide.page, "[data-testid=project-header]");
		expect(Math.abs((run?.top ?? 0) - (tree?.top ?? 1))).toBeLessThan(1);
		expect(tree?.left ?? 0).toBeGreaterThanOrEqual((run?.right ?? 0) - 1);
		const { page, server } = await open(1440, 900);
		await server.close();
		await page.click("#workbench-refresh");
		await page.waitFor("document.querySelector('[data-testid=run-strip]').dataset.connection === 'unknown'");
		const words = await box(page, "[data-testid=run-strip-words]");
		expect(words !== null && words.width > 0 && words.top >= 0).toBe(true);
		expect(await page.text("[data-testid=run-strip-words]")).toMatch(/unknown/);
		expect(await page.text("[data-testid=context-status-read]")).toContain("the broker has not answered since");
	});

	it("keeps the run line docked at the top of a phone while the page scrolls under it", async () => {
		const { page } = await open(390, 844);
		expect(await page.eval<string>("getComputedStyle(document.querySelector('.session-head')).display")).toBe(
			"contents",
		);
		await page.eval("window.scrollTo(0, document.documentElement.scrollHeight)");
		const strip = await box(page, "[data-testid=run-strip]");
		expect(strip?.top).toBe(0);
		expect(await page.eval<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
	});
});

suite("STOP on a dark screen", () => {
	for (const field of [false, true]) {
		it(
			(field ? "Field" : "Instrument") +
				": a graphite control with readable text, a visible border and a focus ring, never a lamp",
			async () => {
				const { page } = await open(1440, 900, { field });
				// Measure the settled colours, not a frame of the button's colour transition (it runs when the stop becomes enabled).
				const settled = "document.querySelector('[data-testid=stop]').getAnimations().length === 0";
				await page.waitFor(settled);
				const look = await page.eval<{ text: number; fill: number; words: string }>(
					"(() => { " +
						COLOUR +
						" const b = document.querySelector('[data-testid=stop]'); const s = getComputedStyle(b); return { text: ratio(s.color, s.backgroundColor), fill: lum(s.backgroundColor), words: b.textContent }; })()",
				);
				expect(look.words).toBe("Request stop");
				expect(look.text).toBeGreaterThanOrEqual(7);
				// The border against what is painted on either side of it, read back from a screenshot: Field's strip is transparent, so
				// its ground is whatever the field draws there, not a computed colour.
				const painted = await page.eval<{ outside: number[]; fill: number }>(
					PAINTED((await page.screenshot()).toString("base64")),
				);
				expect(Math.min(...painted.outside)).toBeGreaterThanOrEqual(3);
				expect(painted.fill).toBeGreaterThanOrEqual(3);
				// The old Field pill was #efebe3 (relative luminance 0.83). Graphite is under 0.03.
				expect(look.fill).toBeLessThan(0.03);
				await page.eval("document.querySelector('[data-testid=stop]').focus({ focusVisible: true })");
				const ring = await page.eval<string>(
					"(() => { const s = getComputedStyle(document.querySelector('[data-testid=stop]')); return s.outlineStyle + ' ' + s.outlineWidth; })()",
				);
				expect(ring).toBe("solid 2px");
				await page.hover("[data-testid=stop]");
				await page.waitFor(settled);
				const hover = await page.eval<number>(
					"(() => { " +
						COLOUR +
						" return lum(getComputedStyle(document.querySelector('[data-testid=stop]')).backgroundColor); })()",
				);
				expect(hover).toBeLessThan(0.05);
			},
		);
	}
});

suite("the composer", () => {
	it("puts the mode, what it does and the request on one row under the field, says the whole effect while focused, and keeps the draft", async () => {
		const { page } = await open(1440, 900);
		const bar = await box(page, ".composer-bar");
		const field = await box(page, "[data-testid=composer]");
		expect((bar?.top ?? 0) >= (field?.bottom ?? 1)).toBe(true);
		for (const id of ["[data-testid=mode-steer]", "[data-testid=composer-hint]", "[data-testid=send]"])
			expect(
				await page.eval<boolean>(
					`document.querySelector('.composer-bar').contains(document.querySelector('${id}'))`,
				),
			).toBe(true);
		// The group of modes has a name for assistive technology.
		expect(
			await page.eval<string>(
				"(() => { const l = document.querySelector('.composer .modes legend'); return getComputedStyle(l).display + ':' + l.textContent; })()",
			),
		).toBe("block:Send as");
		// The hint is the field's description, whole in the DOM; while the composer has focus it is drawn whole too.
		await page.click("[data-testid=mode-steer]");
		await page.eval("document.querySelector('[data-testid=composer]').focus()");
		const whole = await page.eval<boolean>(
			"(() => { const h = document.querySelector('[data-testid=composer-hint]'); return h.scrollHeight <= h.clientHeight + 1; })()",
		);
		expect(whole).toBe(true);
		expect(await page.text("[data-testid=composer-hint]")).toContain("you approve it in the attached terminal");
		// A long draft grows the field, but the conversation keeps most of the column and nothing leaves the window.
		await fill(page, "[data-testid=composer]", Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
		const scroll = await page.eval<number>(
			"document.querySelector('#develop-view-conversation .live-scroll').clientHeight",
		);
		expect(scroll).toBeGreaterThan(300);
		const form = await box(page, "form.composer");
		expect((form?.bottom ?? 1e9) <= 900).toBe(true);
		await page.click("[data-testid=tab-changes]");
		await page.click("[data-testid=tab-task]");
		await page.click("[data-testid=tab-conversation]");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toContain("line 39");
	});
});

suite("the context column", () => {
	it("lists one line a file under each comparison, and names the chosen file's comparison under the list", async () => {
		const { page, source } = await open(1440, 900);
		const heights = await page.eval<number[]>(
			"[...document.querySelectorAll('[data-testid=change-row]')].map((r) => r.getBoundingClientRect().height)",
		);
		expect(heights.length).toBeGreaterThan(5);
		for (const h of heights) expect(h).toBeLessThan(24);
		await page.eval(
			"[...document.querySelectorAll('[data-testid=change-row]')].find((r) => r.dataset.area === 'unstaged' && r.textContent.includes('tokenizer.ts')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		expect(await page.text("[data-testid=change-selected]")).toContain("Unstaged, index → working tree");
		expect(await page.text("[data-testid=change-selected]")).toContain("src/parser/tokenizer.ts");
		await page.click("[data-testid=tab-conversation]");
		const diffs = source.diffs;
		await page.click("[data-testid=change-selected-open]");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'changes'");
		expect(source.diffs).toBe(diffs);
	});

	it("on a phone, Show in Changes goes back to the work and shows the chosen file's diff, read once", async () => {
		const { page, source } = await open(390, 844);
		const details = "[data-testid=develop-crumb] button:last-child";
		await page.click(details);
		await page.waitFor("document.querySelector('[data-testid=change-row]')");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=change-row]')].find((r) => r.dataset.area === 'unstaged' && r.textContent.includes('tokenizer.ts')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		await page.click("[data-testid=tab-conversation]");
		await page.waitFor("document.querySelector('#develop-live').dataset.view === 'conversation'");
		await page.click(details);
		await page.waitFor("document.querySelector('[data-testid=change-selected-open]')");
		const diffs = source.diffs;
		await page.click("[data-testid=change-selected-open]");
		await page.waitFor(
			"document.querySelector('#develop-live')?.dataset.view === 'changes' && (document.querySelector('[data-testid=diff-table]')?.getClientRects().length ?? 0) > 0",
		);
		expect(await page.text("[data-testid=diff-comparison]")).toContain("index → working tree (unstaged)");
		expect(source.diffs).toBe(diffs);
	});
});

suite("hiding Context in Instrument", () => {
	it("gives its width to the conversation, keeps the course, reads nothing again, and comes back as it was", async () => {
		const { page, source } = await open(1440, 900);
		await page.eval(
			"[...document.querySelectorAll('[data-testid=change-row]')].find((r) => r.textContent.includes('index.ts')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=diff-view]')?.dataset.state === 'ready'");
		await page.click("[data-testid=tab-conversation]");
		await page.eval("document.querySelector('[data-testid=source-capabilities]').open = true");
		await page.eval("document.querySelector('#develop-context > .panel-body').scrollTop = 120");
		const reads = { overviews: source.overviews, diffs: source.diffs };
		const before = await box(page, "#develop-live");
		await page.eval("document.querySelector('[data-testid=context-toggle]').focus()");
		await page.press("Enter");
		await page.waitFor("getComputedStyle(document.querySelector('#develop-context')).display === 'none'");
		expect(
			await page.eval<string>(
				"document.querySelector('[data-testid=context-toggle]').getAttribute('aria-expanded')",
			),
		).toBe("false");
		expect(await page.text("[data-testid=context-toggle]")).toBe("Show context");
		expect(
			await page.eval<boolean>("document.activeElement === document.querySelector('[data-testid=context-toggle]')"),
		).toBe(true);
		const after = await box(page, "#develop-live");
		expect((after?.width ?? 0) - (before?.width ?? 0)).toBeGreaterThan(300);
		expect(await shown(page, ".develop-course")).toBe(true);
		expect(await shown(page, "[data-testid=stop]")).toBe(true);
		await page.press("Enter");
		await page.waitFor("getComputedStyle(document.querySelector('#develop-context')).display !== 'none'");
		expect(await page.eval<number>("document.querySelector('#develop-context > .panel-body').scrollTop")).toBe(120);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=source-capabilities]').open")).toBe(true);
		expect(
			await page.eval<string>("document.querySelector('button.change-row[aria-pressed=true]')?.textContent ?? ''"),
		).toContain("index.ts");
		expect({ overviews: source.overviews, diffs: source.diffs }).toEqual(reads);
	});

	it("keeps the course where the sessions are a drawer, and has no such control in one column, where Context is a stage", async () => {
		const laptop = await open(1180, 820);
		await laptop.page.click("[data-testid=context-toggle]");
		await laptop.page.waitFor("getComputedStyle(document.querySelector('#develop-context')).display === 'none'");
		expect(await shown(laptop.page, ".develop-course")).toBe(true);
		expect(await laptop.page.eval<boolean>("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
		const phone = await open(390, 844);
		expect(await shown(phone.page, "[data-testid=context-toggle]")).toBe(false);
		await phone.page.eval(
			"[...document.querySelectorAll('.develop-crumb button')].find((b) => b.textContent === 'Context').click()",
		);
		await phone.page.waitFor(
			"document.querySelector('#develop-context') && document.querySelector('#develop-context').getClientRects().length > 0",
		);
		// The same facts are one stage away: the Context stage, with its worktree block.
		expect(await shown(phone.page, "#develop-context [data-testid=context-worktree]")).toBe(true);
	});

	it("is Field's dock in Field: one state, so a hidden column stays hidden across the appearances", async () => {
		const { page } = await open(1440, 900);
		await page.click("[data-testid=context-toggle]");
		await page.click("[data-testid=appearance-field]");
		await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
		expect(
			await page.eval<string>("document.querySelector('[data-testid=dock-toggle]').getAttribute('aria-expanded')"),
		).toBe("false");
		expect(await shown(page, "[data-testid=context-toggle]")).toBe(false);
	});
});

suite("Field vertical breathing room", () => {
	it("places the session and worktree on one head line at 1440 px, aligns authority to the composer measure, and gives the conversation >600 px", async () => {
		const { page } = await open(1440, 900, { field: true });
		const run = await box(page, "[data-testid=run-strip]");
		const tree = await box(page, "[data-testid=project-header]");
		expect(run).not.toBeNull();
		expect(tree).not.toBeNull();
		expect(Math.abs((run?.top ?? 0) - (tree?.top ?? 100))).toBeLessThan(2);
		expect(tree?.left ?? 0).toBeGreaterThanOrEqual((run?.right ?? 0) - 2);

		const live = await box(page, "#develop-live");
		const view = await box(page, "#develop-view-conversation");
		expect((view?.top ?? 0) - (live?.top ?? 0)).toBeLessThanOrEqual(84);

		const authority = await box(page, "[data-testid=authority]");
		const composer = await box(page, "[data-testid=composer]");
		expect(authority).not.toBeNull();
		expect(composer).not.toBeNull();
		expect(Math.abs((authority?.width ?? 0) - (composer?.width ?? 0))).toBeLessThanOrEqual(24);
		expect(Math.abs((authority?.left ?? 0) - (composer?.left ?? 0))).toBeLessThanOrEqual(12);

		const scrollerHeight = await page.eval<number>(
			"document.querySelector('#develop-view-conversation .live-scroll').clientHeight",
		);
		expect(scrollerHeight).toBeGreaterThanOrEqual(600);
		expect(
			await page.eval<boolean>(
				"document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight + 1",
			),
		).toBe(true);
	});
});
