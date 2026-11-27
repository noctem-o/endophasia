// DEVELOP-UX-002 in a real browser, served by the real broker over the real HTTP guards (a stand-in session, a hand-resolved terminal).
// What the page shows of the mode and of session control, the everyday loop (pair once, send repeatedly, stop, give up), a reload that
// does not renew anything, and an Everyday launch on a host with no execution boundary, which is Strict and says why.
//
// The enforced boundary here is a STAND-IN the test constructs: it makes the broker's authority path reachable. It confines nothing,
// and nothing in this file is evidence of containment.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkbenchBrokerV0, type WorkbenchControlOptionsV0 } from "../adapters/pi/workbench.ts";
import { hostExecutionProtectionV0 } from "../cli/execution-protection.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import type { EndoExecutionProtectionStatusV0 } from "../runtime/contracts/execution-protection.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeDesk, FakeSession, settle } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-ux2-browser-"));
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
});
afterAll(async () => {
	await browser?.close();
	rmSync(scratch, { recursive: true, force: true });
	removeTempRoots((r) => rmSync(r, { recursive: true, force: true }));
});
const suite = executable === null ? describe.skip : describe;

const WORKSPACE = "/work/project";
const STAND_IN: EndoExecutionProtectionStatusV0 = {
	state: "enforced",
	level: "workspace",
	mechanism: "test-stand-in.v0",
	session: "endo.session.pi.fake-session-1",
	workspaceRoot: WORKSPACE,
	limitations: [],
};

async function open(control: WorkbenchControlOptionsV0 | null, width = 1440, height = 900) {
	const session = new FakeSession();
	const desk = new FakeDesk(session);
	desk.hold = false;
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
		interventions: desk,
		...(control === null ? {} : { control }),
	});
	const root = tempRoot("endo-ux2-ui-");
	ingestAll(root, [
		event(
			"harness.attached",
			{},
			{ session: "endo.session.pi.fake-session-1", producer: "pi-rpc-adapter:pi.default" },
		),
	]);
	const server = await serve(root, { ui, workbench: broker, readBudget: { duty: 1, burstMs: 1e6 } });
	const page = await browser.open(width, height);
	tabs.push(page);
	const enter = async () => {
		await page.goto(`${server.baseUrl}/`);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		// On a narrow screen DEVELOP starts at the session list: the conversation, and the strip above its input, are one stage away.
		if (width < 1024) {
			await page.waitFor("document.querySelector('[data-testid=live-row]')");
			await page.click("[data-testid=live-row]");
		}
		await page.waitFor("document.querySelector('[data-testid=authority]')");
	};
	await enter();
	return { page, session, desk, approval, broker, server, enter };
}
const everyday = (): WorkbenchControlOptionsV0 => ({
	mode: "everyday",
	workspaceRoot: WORKSPACE,
	protection: { observe: () => STAND_IN },
});
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const pairWith = async (page: Page, code: string) => {
	await fill(page, "[data-testid=pair-code]", code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
};
const data = (page: Page, name: string) =>
	page.eval<string>(`document.querySelector('[data-testid=authority]').dataset.${name}`);
const sendPrompt = async (page: Page, text: string) => {
	await fill(page, "[data-testid=composer]", text);
	await page.waitFor("!document.querySelector('[data-testid=send]').disabled");
	await page.click("[data-testid=send]");
};

suite("Everyday in the page (a stand-in boundary: authority only, not containment)", () => {
	it("pairs once, then sends prompt after prompt with no terminal approval, worded as authorised by the session grant", async () => {
		const { page, session, approval, broker, server } = await open(everyday());
		expect(await page.text("[data-testid=authority-mode]")).toBe("Mode: Everyday");
		expect(await data(page, "control")).toBe("off");
		const issued = broker.issuePairingCode({ control: true });
		expect(issued.control).not.toBeNull();
		await pairWith(page, issued.code);
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'held'");
		const control = await page.text("[data-testid=authority-control]");
		expect(control).toContain("Session control on · prompt, steer, queue, stop · until ");
		expect(control).toContain("200 sends left");
		expect(await page.text("[data-testid=authority-scope]")).toContain(WORKSPACE);
		expect(await page.text("[data-testid=authority-scope]")).toContain("cannot be renewed or widened from this page");
		expect(await page.text("[data-testid=authority-chip]")).toContain("paired · session control on");
		expect(await page.text("[data-testid=send]")).toBe("Send prompt");
		expect(await page.text("[data-testid=composer-hint]")).toContain("without a terminal approval");
		expect(await page.text("[data-testid=offer-prompt]")).toContain("sent under this page's session control");
		for (let i = 1; i <= 3; i++) {
			await sendPrompt(page, `message ${i}`);
			await page.waitFor(
				`document.querySelector('[data-testid=command-card]')?.dataset.state === 'accepted' && ${JSON.stringify(session.promptCalls.length)} < 99`,
			);
			for (let n = 0; n < 100 && session.promptCalls.length < i; n++) await settle(20);
			expect(session.promptCalls).toHaveLength(i);
			// The composer is free again for the next one.
			await page.waitFor("document.querySelector('[data-testid=composer]').value === ''");
		}
		expect(session.promptCalls).toEqual(["message 1", "message 2", "message 3"]);
		// The terminal was asked nothing.
		expect(approval.requests).toEqual([]);
		const card = await page.text("[data-testid=command-card]");
		expect(card).toContain("authorised by the session grant");
		expect(card).not.toContain("approved in the terminal");
		expect(await page.eval<string>("document.querySelector('[data-testid=command-card] [data-by]').dataset.by")).toBe(
			"session-grant",
		);
		// The records agree with the page: authorised by the grant, never as typed.
		expect(
			session.records.filter((r) => r.kind === "workbench.prompt-authorized").map((r) => r.payload.confirmation),
		).toEqual(["session-grant", "session-grant", "session-grant"]);
		// Nothing of the authority is kept anywhere a reload, another tab or another origin could find it.
		expect(await page.eval<number>("localStorage.length + sessionStorage.length")).toBe(0);
		expect(await page.eval<string>("document.cookie")).toBe("");
		const grantId = String(session.records[0]!.payload.grantId);
		for (const url of page.seen.requests) {
			expect(url.startsWith(server.baseUrl)).toBe(true);
			expect(url).not.toContain(grantId);
			expect(url).not.toContain("session-grant");
		}
		expect(await page.eval<string>("location.href")).not.toContain(grantId);
		expect(page.seen.problems).toEqual([]);
	});

	it("a reload renews nothing: the page is unpaired, and pairing again with a plain code gives no session control", async () => {
		const { page, session, approval, broker, enter } = await open(everyday());
		await pairWith(page, broker.issuePairingCode({ control: true }).code);
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'held'");
		await enter();
		// Its memory is gone, and with it both tokens.
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=composer]')")).toBe(true);
		expect(await data(page, "control")).not.toBe("held");
		expect(await page.text("[data-testid=authority-chip]")).toContain("not paired");
		await pairWith(page, broker.issuePairingCode().code);
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'off'");
		expect(await page.text("[data-testid=authority-control]")).toContain(
			"Session control off (the last grant ended: a page was paired again)",
		);
		expect(await page.text("[data-testid=send]")).toBe("Request prompt");
		await sendPrompt(page, "after the reload");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'awaiting-approval'");
		expect((await approval.waitForRequest()).phrase).toMatch(/^APPROVE PROMPT /);
		expect(session.promptCalls).toEqual([]);
		expect(await page.text("[data-testid=command-card]")).toContain("approved in the terminal");
		expect(session.records.filter((r) => r.kind === "workbench.session-control-granted")).toHaveLength(1);
	});

	it("gives session control up from the page, and a stop under it is sent at once", async () => {
		const { page, session, desk, approval, broker } = await open(everyday());
		await pairWith(page, broker.issuePairingCode({ control: true }).code);
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'held'");
		session.runActive = true;
		await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
		await page.click("#workbench-refresh");
		await page.waitFor(
			"document.querySelector('[data-testid=stop]') && !document.querySelector('[data-testid=stop]').disabled",
		);
		expect(await page.text("[data-testid=stop]")).toBe("Stop");
		expect(await page.text("[data-testid=stop-reason]")).toContain("sent at once, without a terminal approval");
		await page.click("[data-testid=stop]");
		for (let n = 0; n < 100 && desk.applyCalls.length < 1; n++) await settle(20);
		expect(desk.applyCalls).toHaveLength(1);
		expect(approval.requests).toEqual([]);
		expect(desk.authorizations[0]!.authority).toMatchObject({
			kind: "local-operator",
			confirmation: "session-grant",
		});
		await page.waitFor("document.querySelector('[data-testid=intervention-card]')?.dataset.state === 'accepted'");
		expect(await page.text("[data-testid=intervention-card]")).toContain("authorised by the session grant");
		await page.click("[data-testid=authority-relinquish]");
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'off'");
		expect(await page.text("[data-testid=authority-control]")).toContain(
			"the last grant ended: this page gave it up",
		);
		expect(await page.text("[data-testid=authority-chip]")).not.toContain("session control");
		expect(session.records.at(-1)!.payload).toMatchObject({ reason: "revoked-by-page" });
		// Still paired: the composer is there, and asks again.
		expect(await page.eval<boolean>("!!document.querySelector('[data-testid=composer]')")).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});

	it("says when the grant has ended on the terminal's side, and the next send waits for the terminal", async () => {
		const { page, session, approval, broker } = await open(everyday());
		await pairWith(page, broker.issuePairingCode({ control: true }).code);
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'held'");
		broker.revokeSessionControl();
		// The page has not read yet: it still says Send. The broker, not the page, decides; the request waits for its phrase.
		await sendPrompt(page, "after the revoke");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'awaiting-approval'");
		expect(session.promptCalls).toEqual([]);
		await approval.waitForRequest();
		await page.waitFor("document.querySelector('[data-testid=authority]').dataset.control === 'off'");
		expect(await page.text("[data-testid=authority-control]")).toContain("it was revoked in the terminal");
		expect(await page.text("[data-testid=command-card]")).toContain(
			"Waiting for you to approve it in the attached terminal",
		);
	});
});

suite("Everyday where it cannot be in effect, and Strict", () => {
	it("an Everyday launch on a host with no execution boundary is Strict, and the page says exactly why", async () => {
		const { page, session, approval, broker } = await open({
			mode: "everyday",
			workspaceRoot: WORKSPACE,
			protection: hostExecutionProtectionV0({
				uid: () => 1000,
				writable: (path) => path === "/run/docker.sock",
				read: () => null,
			}),
		});
		expect(await page.text("[data-testid=authority-mode]")).toBe("Mode: Strict");
		expect(await data(page, "requested")).toBe("everyday");
		expect(await data(page, "effective")).toBe("strict");
		const why = await page.text("[data-testid=authority-unavailable]");
		expect(why).toContain("Everyday was requested and is not in effect");
		expect(why).toContain("No attested execution boundary is available for this launch.");
		expect(await page.text("[data-testid=authority]")).toContain("the Docker daemon's socket");
		const issued = broker.issuePairingCode({ control: true });
		expect(issued.control).toBeNull();
		await pairWith(page, issued.code);
		expect(await data(page, "control")).toBe("off");
		expect(await page.text("[data-testid=authority-control]")).toBe(
			"Every prompt, steer, queue and stop is approved in the attached terminal.",
		);
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=authority-relinquish]')")).toBe(true);
		expect(await page.text("[data-testid=send]")).toBe("Request prompt");
		await sendPrompt(page, "needs its phrase");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'awaiting-approval'");
		await approval.waitForRequest();
		expect(session.promptCalls).toEqual([]);
		expect(session.records.map((r) => r.kind)).toEqual(["workbench.prompt-proposed"]);
		expect(page.seen.problems).toEqual([]);
	});

	it("a Strict launch says Strict and nothing about a mode that was not asked for; it fits a phone", async () => {
		const { page, broker } = await open(null, 390, 844);
		expect(await page.text("[data-testid=authority-mode]")).toBe("Mode: Strict");
		expect(await data(page, "requested")).toBe("strict");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=authority-unavailable]')")).toBe(true);
		expect(broker.issuePairingCode({ control: true }).control).toBeNull();
		expect(
			await page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
		).toBe(true);
		expect(page.seen.problems).toEqual([]);
	});
});
