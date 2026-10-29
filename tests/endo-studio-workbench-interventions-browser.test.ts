// STEER, QUEUE and STOP in a real browser, served by the workbench broker (a stand-in session, a controllable desk and a hand-resolved
// terminal approver): the three modes told apart, STOP in the run strip with every state named for what is known, the intervention cards
// and what each claims, and what must never appear: a control on a recording, an approve button, a stop called done before the evidence.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { removeTempRoots } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { comparePiEvents } from "./studio-compare-fixtures.ts";
import { developStore } from "./studio-develop-fixtures.ts";
import { Approval, FakeDesk, FakeSession, settle, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-workbench-iv-browser-"));
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
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null ? describe.skip : describe;

/** A recording whose last recorded state is a run that never ended: "running", as a recording, and nothing live. */
function historicalRunningStore(): string {
	const terminal = [
		"lifecycle.run-completed",
		"lifecycle.run-aborted",
		"lifecycle.run-failed",
		"lifecycle.run-unclassified",
	];
	return developStore(
		comparePiEvents("baseline", "endo.session.pi.histrunning").filter((e) => !terminal.includes(e.kind)),
	);
}

async function open(width = 1440, height = 900, options: { running?: boolean; root?: string } = {}) {
	const session = new FakeSession();
	session.runActive = options.running ?? true;
	const desk = new FakeDesk(session);
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
	});
	const root = options.root ?? developStore();
	const server = await serve(root, { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	const page = await browser.open(width, height);
	tabs.push(page);
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	await page.waitFor(
		width < 1024
			? "document.querySelector('[data-testid=live-row]')"
			: "document.querySelector('[data-testid=live-row]') && document.querySelector('[data-testid=run-strip-words]')?.textContent",
	);
	if (width < 1024) {
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('#develop-live')");
	}
	return { page, session, desk, approval, broker, server };
}
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const pairWith = async (page: Page, broker: WorkbenchBrokerV0) => {
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor(
		"document.querySelector('[data-testid=composer]') || document.querySelector('[data-testid=mode-steer]')",
	);
};
const refresh = async (page: Page) => {
	await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
	await page.click("#workbench-refresh");
};
const card = (page: Page, op: string) => page.text(`[data-testid=intervention-card][data-op=${op}]`);

suite("steer, queue and stop in the DEVELOP workbench", () => {
	it("tells the three modes apart, shows each one's delivery semantics, and keeps the draft when the mode changes", async () => {
		const { page, broker, session } = await open(1440, 900, { running: false });
		await pairWith(page, broker);
		const hint = () => page.text("[data-testid=composer-hint]");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=mode-prompt]').checked")).toBe(true);
		expect(await hint()).toContain("Sends a NEW prompt: it starts a run and is not an intervention");
		await fill(page, "[data-testid=composer]", "a half written thought");
		// No run is open: steer and queue are not offered, and the page says why instead of drawing disabled power.
		await page.click("[data-testid=mode-steer]");
		expect(await hint()).toContain("No run is open");
		expect(await page.eval<string>("document.querySelector('[data-testid=send]').textContent")).toBe("Request steer");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=send]').disabled")).toBe(true);
		session.runActive = true;
		await refresh(page);
		await page.waitFor("!document.querySelector('[data-testid=composer]').disabled");
		// The mode is the operator's choice: a run opening does not switch it, and the draft followed it across.
		expect(await page.eval<boolean>("document.querySelector('[data-testid=mode-steer]').checked")).toBe(true);
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
			"a half written thought",
		);
		expect(await hint()).toContain("after the current turn's tool calls and before the next model request");
		expect(await hint()).toContain("interventions folder");
		await page.click("[data-testid=mode-queue]");
		expect(await hint()).toContain("when the agent has no more tool calls or steering");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
			"a half written thought",
		);
		// Back to a prompt while a run is open: it is the one thing that is not offered now.
		await page.click("[data-testid=mode-prompt]");
		expect(await hint()).toContain("A run is open");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=composer]').disabled")).toBe(true);
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe(
			"a half written thought",
		);
		expect(await page.eval<string>("document.querySelector('form.composer').dataset.mode")).toBe("prompt");
		expect(page.seen.problems).toEqual([]);
	});

	it("requests a steer, sends nothing until the terminal approves it, and calls Pi's reply acceptance, not use", async () => {
		const { page, broker, session, desk, approval } = await open();
		await pairWith(page, broker);
		await page.click("[data-testid=mode-steer]");
		await fill(page, "[data-testid=composer]", "also mention the tests");
		await page.click("[data-testid=send]");
		await page.waitFor("document.querySelector('[data-testid=intervention-card]')");
		const asked = await card(page, "steer");
		expect(asked).toContain("Requested. Waiting for you to approve it in the attached terminal");
		expect(asked).toContain("This page cannot approve it");
		expect(asked).toContain("also mention the tests"); // the page's own copy, tagged
		expect(asked).toContain("live · private, cleared at session end");
		const request = await approval.waitForRequest();
		expect(request).toMatchObject({ operation: "steer", message: "also mention the tests" });
		await settle(300);
		expect(desk.applyCalls).toEqual([]);
		// There is no control on the page that approves.
		expect(
			await page.eval<boolean>(
				"![...document.querySelectorAll('button')].some(b => /approve|authori[sz]e|confirm/i.test(b.textContent))",
			),
		).toBe(true);
		approval.answer("allow");
		await page.waitFor("document.querySelector('[data-testid=intervention-card]')?.dataset.state === 'sent'");
		expect(await card(page, "steer")).toContain("Sent to Pi. Waiting for its reply");
		// The draft was cleared by the request that carried it.
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("");
		desk.release([...desk.proposals.keys()][0]!);
		await page.waitFor("document.querySelector('[data-testid=intervention-card]')?.dataset.state === 'accepted'");
		const accepted = await card(page, "steer");
		expect(accepted).toContain("Pi accepted it. That is a reply, not proof the message was used");
		// Consumption is its own claim, not implied by acceptance: not checked, then not established when the capture says so.
		expect(accepted).toContain("Consumption: not checked");
		expect(accepted).not.toMatch(/\b(consumed|delivered|applied|worked|done|completed)\b/i);
		await page.click("[data-testid=check-evidence]");
		await page.waitFor(
			"document.querySelector('[data-testid=consumption]')?.textContent.includes('not established')",
		);
		expect(await page.text("[data-testid=consumption]")).toContain("this session store holds no proxy capture");
		desk.consumptionResult = { status: "observed", exchange: 4, captureEvent: "endo.event.c4" };
		await page.click("[data-testid=check-evidence]");
		await page.waitFor("document.querySelector('[data-testid=consumption]')?.textContent.includes('observed')");
		expect(await page.text("[data-testid=consumption]")).toContain("it does not show it helped");
		expect(
			await page.eval<string>(
				"document.querySelector('[data-testid=intervention-card] .chain li:nth-child(5)').dataset.done",
			),
		).toBe("true");
		// The conversation went on meanwhile, and the card sits where the request was made.
		session.live_(textMessage("assistant", "after the steer"));
		await refresh(page);
		await page.waitFor("document.querySelector('[data-testid=turn-assistant]')");
		const order = await page.eval<string[]>(
			"[...document.querySelectorAll('[data-testid=transcript] > li')].map(l => l.dataset.testid || l.className.split(' ').join('.'))",
		);
		expect(order.indexOf("intervention-card")).toBeLessThan(order.indexOf("turn-assistant"));
		expect(page.seen.problems).toEqual([]);
	});

	it("shows a declined, withdrawn or expired request as not sent, and never as approved when it was not", async () => {
		const { page, broker, desk, approval } = await open();
		await pairWith(page, broker);
		await page.click("[data-testid=mode-queue]");
		await fill(page, "[data-testid=composer]", "later please");
		await page.click("[data-testid=send]");
		await approval.waitForRequest();
		approval.answer("deny");
		await page.waitFor("document.querySelector('[data-testid=intervention-card]')?.dataset.state === 'refused'");
		expect(await card(page, "queue")).toContain("Not sent: it was declined in the terminal");
		expect(
			await page.eval<string>(
				"document.querySelectorAll('[data-testid=intervention-card] .chain li')[1].dataset.done",
			),
		).toBe("false");
		await fill(page, "[data-testid=composer]", "withdraw me");
		await page.click("[data-testid=send]");
		await page.waitFor("document.querySelector('[data-testid=withdraw]')");
		await page.click("[data-testid=withdraw]");
		await page.waitFor(
			"document.querySelectorAll('[data-testid=intervention-card][data-state=refused]').length === 2",
		);
		expect(await page.eval<string>("document.body.innerText")).toContain("it was withdrawn before it was approved");
		expect(desk.applyCalls).toEqual([]);
	});

	it("puts STOP in the run strip and names each state for what is known, never calling a dispatched stop done", async () => {
		const { page, broker, session, desk, approval } = await open();
		// Unpaired, it is shown disabled with the reason; the message composer does not carry it.
		expect(await page.eval<boolean>("!!document.querySelector('[data-testid=run-strip] [data-testid=stop]')")).toBe(
			true,
		);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=stop]').disabled")).toBe(true);
		expect(await page.text("[data-testid=run-strip]")).toContain("Pair this page to request a stop");
		await pairWith(page, broker);
		expect(await page.eval<boolean>("!document.querySelector('form.composer [data-testid=stop]')")).toBe(true);
		expect(await page.text("[data-testid=run-strip]")).toContain("Pi answers only once it is idle");
		session.live_({ type: "agent_start", record: {} });
		await page.click("[data-testid=stop]");
		await page.waitFor("document.querySelector('[data-testid=stop-status]')");
		expect(await page.text("[data-testid=stop-status]")).toContain("Stop requested · awaiting terminal approval");
		const request = await approval.waitForRequest();
		expect(request).toMatchObject({ operation: "stop", message: null });
		// A stop in flight withholds the rest and does not offer a second.
		expect(await page.text("#develop-context")).toContain("unavailable");
		approval.answer("allow");
		await page.waitFor("document.querySelector('[data-testid=stop-status]')?.dataset.state === 'sent'");
		expect(await page.text("[data-testid=stop-status]")).toContain(
			"Stop dispatched to Pi · reply pending until the run is idle",
		);
		// Wherever the page reports on the stop (the run strip and the cards), a dispatched stop is never called done.
		const pending = await page.eval<string>(
			"[...document.querySelectorAll('[data-testid=run-strip], [data-testid=intervention-card]')].map(e => e.innerText).join('\\n')",
		);
		expect(pending).not.toMatch(/\b(stopped|completed|done|ended successfully|succeeded)\b/i);
		// Pi's reply, and the run's end as Pi reported it: two separate facts, each shown when it is seen.
		desk.release([...desk.proposals.keys()][0]!, { status: "accepted", requestId: "r", disposition: null });
		await page.waitFor(
			"document.querySelector('[data-testid=intervention-card][data-op=stop]')?.dataset.state === 'accepted'",
		);
		let stopped = await card(page, "stop");
		expect(stopped).toContain("Pi acknowledged the stop request");
		expect(stopped).toContain("no end of the run has been seen yet");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=stop-status]')")).toBe(true);
		session.live_({
			type: "message_end",
			record: { message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "" }] } },
		});
		session.live_({ type: "agent_settled", record: {} });
		session.runActive = false;
		await refresh(page);
		await page.waitFor("document.querySelector('[data-testid=run-ended]')");
		stopped = await card(page, "stop");
		expect(stopped).toContain("The run this was made in has ended: aborted, as Pi reported");
		expect(stopped).toContain("not shown to be caused by this request");
		// With no run open the control is gone, not disabled.
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=stop]')")).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("says outcome unknown when a sent request's reply was lost, and withdraws a stop that waits for the terminal", async () => {
		const { page, broker, desk, approval } = await open();
		await pairWith(page, broker);
		await page.click("[data-testid=stop]");
		await page.waitFor("document.querySelector('[data-testid=stop-withdraw]')");
		await page.click("[data-testid=stop-withdraw]");
		await page.waitFor(
			"document.querySelector('[data-testid=intervention-card][data-op=stop]')?.dataset.state === 'refused'",
		);
		expect(desk.applyCalls).toEqual([]);
		approval.requests.length = 0;
		await page.click("[data-testid=stop]");
		await approval.waitForRequest();
		approval.answer("allow");
		await page.waitFor("document.querySelector('[data-testid=stop-status]')?.dataset.state === 'sent'");
		const id = [...desk.proposals.keys()].at(-1)!;
		desk.release(id, { status: "refused", requestId: "r", reason: "runtime-failed", detail: "Pi did not answer" });
		await page.waitFor("document.querySelector('[data-testid=intervention-card][data-op=stop][data-state=unknown]')");
		const unknown = await page.text("[data-testid=intervention-card][data-op=stop][data-state=unknown]");
		expect(unknown).toContain("Outcome unknown: it was sent, and Pi's reply was not seen");
		expect(unknown).not.toContain("Not sent");
	});

	it("explains a capability the runtime does not admit, and offers no control for a session that is not connected", async () => {
		const { page, broker, desk, session } = await open();
		desk.admitted.steer = "steering.steer is not admitted by conformance evidence for this runtime";
		await pairWith(page, broker);
		await refresh(page);
		await page.click("[data-testid=mode-steer]");
		await page.waitFor("document.querySelector('[data-testid=composer-hint]').textContent.includes('not admitted')");
		expect(await page.text("[data-testid=composer-hint]")).toContain(
			"steering.steer is not admitted by conformance evidence",
		);
		expect(await page.eval<boolean>("document.querySelector('[data-testid=send]').disabled")).toBe(true);
		expect(await page.text("[data-testid=offer-steer]")).toContain("unavailable");
		expect(await page.text("[data-testid=offer-queue]")).toContain("available");
		session.live = false;
		await refresh(page);
		await page.waitFor(
			"document.querySelector('[data-testid=run-strip-words]').textContent.startsWith('disconnected')",
		);
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=stop]')")).toBe(true);
		expect(await page.text("[data-testid=offer-stop]")).toContain("unavailable");
	});

	it("exposes no live control on a recording, even one whose last recorded state is a running run", async () => {
		const { page, broker } = await open(1440, 900, { running: false, root: historicalRunningStore() });
		await pairWith(page, broker);
		// Choose a recorded session in the rail: the conversation and its controls give way to the recording.
		await page.eval(
			"(() => { const b = [...document.querySelectorAll('[data-session-row]')].find(e => !e.matches('[data-testid=live-row]')); b.click(); })()",
		);
		await page.waitFor("document.querySelector('[data-testid=activity-title]')");
		for (const hidden of ["stop", "composer", "send", "mode-steer", "mode-queue", "intervention-card", "withdraw"])
			expect(await page.eval<boolean>(`!document.querySelector('[data-testid=${hidden}]')`), hidden).toBe(true);
		expect(await page.eval<boolean>("!document.querySelector(\"form[aria-label='Message to agent']\")")).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("sends a steer on Ctrl+Enter only, and does not overflow at 1440, 1024, 768 and 420 pixels with a request open", async () => {
		for (const width of [1440, 1024, 768, 420]) {
			const { page, broker, approval } = await open(width, 900);
			await pairWith(page, broker);
			await page.click("[data-testid=mode-steer]");
			await fill(page, "[data-testid=composer]", "a long steering message ".repeat(12));
			await page.eval(
				"document.querySelector('[data-testid=composer]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))",
			);
			await settle(150);
			expect(approval.requests, `${width}px: Enter alone sends nothing`).toEqual([]);
			await page.eval(
				"document.querySelector('[data-testid=composer]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))",
			);
			await approval.waitForRequest();
			await page.waitFor("document.querySelector('[data-testid=intervention-card]')");
			expect(
				await page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
				`${width}px`,
			).toBe(true);
			expect(page.seen.problems, `${width}px`).toEqual([]);
		}
	}, 60_000);
});
