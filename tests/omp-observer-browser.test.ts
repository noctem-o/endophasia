// Oh My Pi saved sessions in DEVELOP, in a real browser over the production server: the navigator group, a session's committed activity
// and its inspector, in both appearances and at phone width; no private text anywhere on the page; no control offered; and the Pi
// workbench and the recorded store unaffected. Synthetic journals only. Skipped locally without Chromium; required in CI.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OmpSavedSessionObserverV0 } from "../adapters/omp/observer.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import type { EndoOmpObserverV0 } from "../protocol/omp-observation.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { CANARY, conversation, header, resetIds, session, titleSlot } from "./fixtures/omp-journals.ts";
import { developStore } from "./studio-develop-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-omp-browser-"));
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
	resetIds();
	await Promise.all(tabs.splice(0).map((p) => p.close()));
	await stopServers();
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null ? describe.skip : describe;
const ID_A = "019a0000-0000-7000-8000-00000000000a";
const ID_B = "019a0000-0000-7000-8000-00000000000b";
let made = 0;

function ompDirectory(): string {
	made += 1;
	const dir = join(scratch, `omp-${made}`, `-home-${CANARY}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `a_${ID_A}.jsonl`), session(ID_A));
	// One still mid-turn and without an exit: it must not read as running.
	writeFileSync(
		join(dir, `b_${ID_B}.jsonl`),
		`${titleSlot()}${header(ID_B)}${conversation().text.split("\n").slice(0, 4).join("\n")}\n`,
	);
	writeFileSync(join(dir, "c_unsupported.jsonl"), `${header("019c", { version: 9 })}`);
	return join(scratch, `omp-${made}`);
}

async function open(width = 1440, height = 900, withOmp: boolean | "fail-first" = true) {
	const omp = ompDirectory();
	const real = new OmpSavedSessionObserverV0({ root: omp, key: OTHER_KEY });
	let calls = 0;
	// An observer whose first listing fails (the server answers 500), as a transient failure or a refused read would.
	const flaky: EndoOmpObserverV0 = {
		sessions() {
			calls += 1;
			if (calls === 1) throw new Error("transient");
			return real.sessions();
		},
		session: (selector) => real.session(selector),
	};
	const server = await serve(developStore(), {
		ui,
		readBudget: { duty: 1, burstMs: 1e6 },
		onError: () => {},
		...(withOmp === "fail-first" ? { omp: flaky } : withOmp ? { omp: real } : {}),
	});
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor(
		"document.querySelector('#develop-workspace') && !document.querySelector('#develop-workspace .loading') && document.querySelector('#develop-refresh')",
	);
	return { page, server };
}
const rows = (page: Page) =>
	page.eval<string[]>("[...document.querySelectorAll('[data-testid=omp-row]')].map((e) => e.textContent)");

suite("Oh My Pi saved sessions in DEVELOP", () => {
	it("lists them in their own group, as a snapshot, never live, and opens one's committed activity and inspector", async () => {
		const { page } = await open();
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		expect(await page.text("[data-testid=omp-group] h3")).toBe("Oh My Pi · saved files (3)");
		expect(await page.text("[data-testid=omp-snapshot]")).toContain("cannot tell whether it is running");
		const listed = await rows(page);
		expect(listed.join("|")).toContain(`omp ${ID_A.slice(-8)}`);
		expect(listed.join("|")).toContain("exit saved");
		expect(listed.join("|")).toContain("turn open when saved");
		expect(listed.join("|")).toContain("format not read");
		const tags = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=omp-group] [data-testid=surface-tag]')].map((e) => e.textContent)",
		);
		expect(new Set(tags)).toEqual(new Set(["recorded only"]));
		// Open the one mid-turn: a recorded claim, no connection, no control, and the page says what it cannot know.
		await page.eval(
			`[...document.querySelectorAll('[data-testid=omp-row]')].find((e) => e.textContent.includes(${JSON.stringify(ID_B.slice(-8))})).click()`,
		);
		await page.waitFor(
			"document.querySelector('[data-testid=omp-detail]') && document.querySelector('[data-testid=omp-activity]')",
		);
		expect(await page.text("[data-testid=surface-source]")).toContain("Oh My Pi saved session");
		expect(await page.text("[data-testid=surface-ownership]")).toContain("Owned by another process");
		expect(await page.text("[data-testid=omp-exit]")).toContain("may still hold this session");
		expect(await page.text("[data-testid=omp-activity-note]")).toContain("a persisted snapshot, not a live view");
		const control = await page.eval<string[]>(
			"['prompt','steer','queue','stop','resume'].map((a) => document.querySelector('[data-testid=cap-control-' + a + ']').dataset.status)",
		);
		expect(control).toEqual(["unsupported", "unsupported", "unsupported", "unsupported", "unsupported"]);
		const kinds = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=omp-item]')].map((e) => e.dataset.kind)",
		);
		expect(kinds).toEqual(["model-change", "other", "user-message", "assistant-message"]);
		// No composer, no stop control, no workbench request.
		expect(await page.eval<number>("document.querySelectorAll('textarea, [data-testid=stop]').length")).toBe(0);
		expect(page.seen.requests.filter((r) => r.includes("/workbench/") && !r.endsWith("/workbench/status"))).toEqual(
			[],
		);
		expect(page.seen.problems).toEqual([]);
	});

	it("shows no private text anywhere on the page, in either appearance, at any width, and asks only the fixed routes", async () => {
		for (const [width, height] of [
			[1440, 900],
			[390, 844],
		] as const) {
			const { page } = await open(width, height);
			await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
			await page.eval(
				`[...document.querySelectorAll('[data-testid=omp-row]')].find((e) => e.textContent.includes(${JSON.stringify(ID_A.slice(-8))})).click()`,
			);
			await page.waitFor("document.querySelectorAll('[data-testid=omp-item]').length > 5");
			for (const appearance of ["instrument", "field"] as const) {
				if (appearance === "field") {
					await page.click("[data-testid=appearance-field]");
					await page.waitFor("document.querySelector('#develop-workspace').dataset.appearance === 'field'");
				}
				const text = await page.eval<string>("document.documentElement.outerHTML");
				expect(text, `${width} ${appearance}`).not.toContain(CANARY);
				expect(text).not.toContain("AKIA");
				expect(
					await page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
				).toBe(true);
			}
			const omp = page.seen.requests.filter((r) => r.includes("/develop/omp/"));
			expect(omp.every((r) => /\/api\/v0\/develop\/omp\/(sessions|session\/o1-[0-9a-f]{32})$/.test(r))).toBe(true);
			expect(page.seen.problems).toEqual([]);
		}
	});

	it("without --omp-sessions shows nothing of OMP and the recorded list is unchanged", async () => {
		const { page } = await open(1440, 900, false);
		await page.waitFor("document.querySelectorAll('[data-testid=session-row]').length > 0");
		expect(
			await page.eval<number>("document.querySelectorAll('[data-testid=omp-group], [data-testid=omp-row]').length"),
		).toBe(0);
		expect(page.seen.problems).toEqual([]);
	});

	it("keeps the error and a way to read again when the first read fails, and reads the list when asked", async () => {
		const { page } = await open(1440, 900, "fail-first");
		await page.waitFor("document.querySelector('[data-testid=omp-problem]')");
		expect(await page.text("[data-testid=omp-group] h3")).toBe("Oh My Pi · saved files");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=omp-row]').length")).toBe(0);
		await page.click("[data-testid=omp-read-again]");
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=omp-problem]').length")).toBe(0);
	});

	it("reaches the inspector on a phone: choose a session, then Details, then back to its activity", async () => {
		const { page } = await open(390, 844);
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		await page.eval(
			`[...document.querySelectorAll('[data-testid=omp-row]')].find((e) => e.textContent.includes(${JSON.stringify(ID_A.slice(-8))})).click()`,
		);
		await page.waitFor(
			"document.querySelector('[data-testid=omp-activity]') && document.querySelector('[data-testid=omp-details]')",
		);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=omp-detail]').length")).toBe(0);
		await page.click("[data-testid=omp-details]");
		await page.waitFor("document.querySelector('[data-testid=omp-detail]')");
		expect(await page.text("[data-testid=omp-exit]")).toContain("reported by OMP");
		expect(await page.text("[data-testid=surface-source]")).toContain("Oh My Pi saved session");
		await page.eval(
			"[...document.querySelectorAll('[data-testid=develop-crumb] button')].find((b) => b.textContent.includes('Activity')).click()",
		);
		await page.waitFor("document.querySelector('[data-testid=omp-activity]')");
		expect(
			await page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
		).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("offers no Details control on a wide screen, where the inspector is beside the activity", async () => {
		const { page } = await open();
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		await page.click("[data-testid=omp-row]");
		await page.waitFor(
			"document.querySelector('[data-testid=omp-detail]') && document.querySelector('[data-testid=omp-activity]')",
		);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=omp-details]').length")).toBe(0);
	});

	it("moves between OMP rows with the arrow keys, Home and End", async () => {
		const { page } = await open();
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		const focused = () =>
			page.eval<number>("[...document.querySelectorAll('[data-testid=omp-row]')].indexOf(document.activeElement)");
		await page.eval("document.querySelector('[data-testid=omp-row]').focus()");
		await page.press("ArrowDown");
		expect(await focused()).toBe(1);
		await page.press("End");
		expect(await focused()).toBe(2);
		await page.press("Home");
		expect(await focused()).toBe(0);
	});

	it("reads again only when asked: nothing is polled", async () => {
		const { page } = await open();
		await page.waitFor("document.querySelectorAll('[data-testid=omp-row]').length === 3");
		const before = page.seen.requests.filter((r) => r.includes("/develop/omp/sessions")).length;
		await new Promise((r) => setTimeout(r, 300));
		expect(page.seen.requests.filter((r) => r.includes("/develop/omp/sessions")).length).toBe(before);
		await page.click("[data-testid=omp-read-again]");
		await page.waitFor(
			`performance.getEntriesByType('resource').filter((e) => e.name.includes('/develop/omp/sessions')).length === ${before + 1}`,
		);
	});
});
