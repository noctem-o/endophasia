// Requesting a prepared work attempt from the paired live workbench page (docs/designs/develop-attempt-workbench.md), in a real browser:
// the real built page, the real broker over a REAL attachment to the fake Pi (a real child process speaking Pi's RPC, a real event store),
// the real task and attempt stores, and a hand-resolved terminal approver standing in for the operator's terminal.
//
// The operator's journey: open the task, read the frozen brief, request it from the page, see it wait for the terminal, follow the
// conversation without losing the draft, approve on the terminal, and read the attempt's execution from the records. And what must NOT
// happen: the page approving, a brief taken from the page, a second send, a withdrawn or declined request consuming the attempt, the
// task's status changing. Set ENDO_SHOTS_DIR to also write screenshots (synthetic fixtures; no private text).
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { endoDevelopServiceV0 } from "../cli/develop-service.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { renderEndoDevelopBriefV0 } from "../protocol/develop-attempts.ts";
import { DevelopAttemptDispatchV0 } from "../runtime/contracts/develop-attempt-dispatch.ts";
import { DevelopAttemptsServiceV0 } from "../runtime/contracts/develop-attempts.ts";
import { DevelopAttemptsStoreV0 } from "../storage/develop-attempts.ts";
import { DevelopTasksStoreV0 } from "../storage/develop-tasks.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";
import { Approval } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-attempt-request-browser-"));
let browser: Browser;
let ui: Record<string, Uint8Array>;
const tabs: Page[] = [];
const cleanup: (() => void | Promise<void>)[] = [];
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
	for (const done of cleanup.splice(0).reverse()) await done();
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
});
const suite = executable === null ? describe.skip : describe;

const shot = async (page: Page, name: string) => {
	const dir = process.env.ENDO_SHOTS_DIR;
	if (dir !== undefined && dir !== "") writeFileSync(join(dir, `${name}.png`), await page.screenshot());
};
const ok = <T>(r: { ok: true; value: T } | { ok: false; code: string }): T => {
	if (!r.ok) throw new Error(r.code);
	return r.value;
};
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);

/** A store with a registered project, its selected task and one prepared attempt; a fake Pi attached in that directory; the page paired. */
async function launch(width = 1440, height = 900, scenario = "") {
	const install = installFakePi("1.0.0");
	cleanup.push(() => install.remove());
	const root = realpathSync(mkdtempSync(join(scratch, "root-")));
	const cwd = realpathSync(mkdtempSync(join(scratch, "cwd-")));
	const tasks = new DevelopTasksStoreV0(root);
	const project = ok(tasks.registerProject({ name: "Parser work", path: cwd, observedGitRoot: null }));
	const task = ok(
		tasks.createTask(
			project.id,
			{ title: "Accept trailing commas", acceptance: "The parser tests pass" },
			{ select: true },
		),
	);
	const attempts = new DevelopAttemptsStoreV0(root);
	const service = new DevelopAttemptsServiceV0(tasks, attempts);
	const attempt = ok(service.prepare(project.id, task.id, { objective: "Allow a trailing comma in arrays" }));
	const pi = new PiAttachmentV0({
		root,
		cwd,
		executable: install.bin,
		env: fakePiEnv({ FAKE_PI_STEP_MS: "20" }),
		requestTimeoutMs: 3_000,
		digestKey: OTHER_KEY,
	});
	await pi.checkLocal();
	install.setScenario(scenario);
	const session = await pi.openSession();
	cleanup.push(() => session.close());
	const approval = new Approval();
	// As cli/workbench.ts constructs it with --project: the tasks and attempts read through the shared service, and the dispatcher.
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: session.owner.attachment,
		approver: approval.approver,
		tasks: {
			open: (host) => endoDevelopServiceV0(root).forLaunch({ projectId: project.id, launchDirectory: cwd }, host),
		},
		attempts: new DevelopAttemptDispatchV0(tasks, attempts, { projectId: project.id, launchDirectory: cwd }),
	});
	cleanup.push(() => broker.dispose());
	const server = await serve(root, { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
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
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
	return { root, cwd, tasks, service, project, task, attempt, session, approval, broker, page };
}
type Api = Awaited<ReturnType<typeof launch>>;

const openAttempt = async (page: Page) => {
	await page.click("[data-testid=tab-task]");
	await page.waitFor("document.querySelector('#develop-live').dataset.view === 'task'");
	// The Task view opens on the overview: the selected task is chosen from the picker, as an operator would.
	await page.waitFor("document.querySelector('[data-testid=task-picker]')");
	await page.click("[data-testid=task-picker]");
	await page.waitFor("document.querySelector('[data-testid=task-option][aria-selected=true]')");
	await page.click("[data-testid=task-option][aria-selected=true]");
	await page.waitFor("document.querySelector('[data-testid=attempt] details')");
	await page.eval("document.querySelector('[data-testid=attempt] details').open = true");
	await page.waitFor("document.querySelector('[data-testid=attempt-request-send]')");
};
const requestsTo = (page: Page, pattern: RegExp) => page.seen.requests.filter((r) => pattern.test(r));
const statusOf = (api: Api) => {
	const file = api.tasks.read();
	if (!file.ok) throw new Error("task file unreadable");
	return file.file.tasks.find((t) => t.id === api.task.id)?.status;
};
const draft = (page: Page) => page.eval<string>("document.querySelector('[data-testid=composer]').value");

suite("requesting a prepared attempt from the live workbench page", () => {
	it("asks by name, waits for the terminal, sends the exact brief once, and reads the execution back from the records", async () => {
		const api = await launch();
		const { page } = api;
		const brief = renderEndoDevelopBriefV0(api.attempt);
		// A draft written before: it is the operator's, and nothing here touches it.
		await fill(page, "[data-testid=composer]", "a note I am still writing");
		await openAttempt(page);
		expect(await page.eval<string>("document.querySelector('[data-testid=attempt-brief]').value")).toBe(brief);
		expect(await page.text("[data-testid=attempt-request-what]")).toContain("APPROVE ATTEMPT");
		// The strip names the prepared attempt as ready, from the attempts' records.
		await page.waitFor("document.querySelector('[data-testid=next-step]')?.dataset.kind === 'ready'");
		await shot(page, "attempt-ready");

		await page.click("[data-testid=attempt-request-send]");
		const request = await api.approval.waitForRequest();
		expect(request).toMatchObject({
			operation: "attempt",
			requestedFrom: "page",
			message: brief,
			attempt: { attemptId: api.attempt.id, taskId: api.task.id },
		});
		// Only the id travelled: the request body named the attempt and nothing else.
		expect(requestsTo(page, /\/attempt\/propose$/)).toHaveLength(1);
		await page.waitFor(
			"document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'awaiting-approval'",
		);
		expect(await page.text("[data-testid=attempt-request-status]")).toContain(
			"Waiting for approval in the attached terminal",
		);
		await page.waitFor("document.querySelector('[data-testid=next-step]')?.dataset.kind === 'awaiting-approval'");
		await shot(page, "attempt-awaiting-approval");
		// Nothing was sent, and nothing was bound: the page cannot approve.
		expect(api.session.piSessionId).not.toBeNull();
		expect(ok(api.service.get(api.attempt.id)).authorized).toBeNull();

		// To the conversation and back: the request is shown there as the attempt's, the draft is kept, and the Task view is as it was.
		await page.click("[data-testid=tab-conversation]");
		await page.waitFor(
			`document.querySelector('[data-testid=command-card]')?.dataset.attempt === ${JSON.stringify(api.attempt.id)}`,
		);
		expect(await page.text("[data-testid=command-card]")).toContain("they are not this attempt");
		expect(await draft(page)).toBe("a note I am still writing");
		// While it waits, the composer cannot send another prompt.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=send]').disabled")).toBe(true);

		api.approval.answer("allow");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'accepted'", 20_000);
		expect(await page.text("[data-testid=command-card]")).toContain("Sent once. Pi replied: started");
		expect(await draft(page)).toBe("a note I am still writing");

		// Back in Task: once the attempts are read again, the attempt shows what the session recorded, and can no longer be requested.
		await page.click("[data-testid=tab-task]");
		// The run's end is read from the session's log, as the operator would: by reading the tasks again until it is recorded.
		for (let i = 0; i < 40; i += 1) {
			const run = await page.eval<string>(
				"document.querySelector('[data-testid=attempt-execution]')?.dataset.run ?? ''",
			);
			if (run === "completed") break;
			await page.waitFor("!document.querySelector('[data-testid=tasks-refresh]').disabled");
			await page.click("[data-testid=tasks-refresh]");
			await new Promise((r) => setTimeout(r, 250));
		}
		await page.waitFor("document.querySelector('[data-testid=attempt-execution]')?.dataset.run === 'completed'");
		const exec = await page.text("[data-testid=attempt-execution]");
		expect(exec).toContain("Pi reported the run completed. Not verified");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=attempt-request-send]')")).toBe(true);
		await page.waitFor("document.querySelector('[data-testid=next-step]')?.dataset.kind === 'no-check'");
		await shot(page, "attempt-run-ended");

		// The records: the authorisation names this session and was approved on the terminal; the task is still open; nothing was retried.
		const read = ok(api.service.get(api.attempt.id));
		expect(read.authorized).toMatchObject({ via: "workbench-terminal", attemptId: api.attempt.id });
		expect(read.state).toBe("prepared");
		expect(statusOf(api)).toBe("open");
		expect(api.approval.requests).toHaveLength(1);
		expect(page.seen.problems).toEqual([]);
	}, 90_000);

	it("a withdrawal sends nothing and leaves the attempt to be requested again, as a new request", async () => {
		const api = await launch();
		const { page } = api;
		await openAttempt(page);
		await page.click("[data-testid=attempt-request-send]");
		await api.approval.waitForRequest();
		await page.waitFor("document.querySelector('[data-testid=attempt-request-withdraw]')");
		await page.click("[data-testid=attempt-request-withdraw]");
		await page.waitFor("document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'refused'");
		expect(await page.text("[data-testid=attempt-request-status]")).toContain("it can be requested again");
		expect(ok(api.service.get(api.attempt.id)).authorized).toBeNull();

		// The attempt is as it was: it can be requested again, and the second request is a new one, shown whole again on the terminal.
		await page.waitFor("!document.querySelector('[data-testid=attempt-request-send]')?.disabled");
		await page.click("[data-testid=attempt-request-send]");
		await page.waitFor(
			"document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'awaiting-approval'",
		);
		expect(api.approval.requests).toHaveLength(2);
		expect(api.approval.requests[1]?.proposalId).not.toBe(api.approval.requests[0]?.proposalId);
		expect(statusOf(api)).toBe("open");
		expect(page.seen.problems).toEqual([]);
	}, 60_000);

	it("stays usable on a narrow screen and from the keyboard", async () => {
		const api = await launch(390, 844);
		const { page } = api;
		await openAttempt(page);
		expect(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
		// The control is a real button with its effect as its description, and it is reached by focus.
		const described = await page.eval<string>(
			"(() => { const b = document.querySelector('[data-testid=attempt-request-send]'); return document.getElementById(b.getAttribute('aria-describedby'))?.textContent ?? ''; })()",
		);
		expect(described).toContain("Nothing is sent unless you type its APPROVE ATTEMPT phrase there");
		await page.eval("document.querySelector('[data-testid=attempt-request-send]').focus()");
		await page.press("Enter");
		await api.approval.waitForRequest();
		await page.waitFor(
			"document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'awaiting-approval'",
		);
		expect(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth")).toBe(true);
		await shot(page, "attempt-narrow-awaiting");
		api.approval.answer("deny");
		await page.waitFor("document.querySelector('[data-testid=attempt-request-status]')?.dataset.state === 'refused'");
		expect(await page.text("[data-testid=attempt-request-status]")).toContain("declined in the terminal");
		expect(ok(api.service.get(api.attempt.id)).authorized).toBeNull();
	}, 60_000);
});
