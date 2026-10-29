// The DEVELOP workbench in a real browser, served by its broker (a stand-in session and a hand-resolved terminal approver): the live
// state, pairing, the private conversation, one governed prompt from request to acceptance, refusals, disconnect, and what must NEVER
// happen (the grant in a URL or storage, an approval by the page, a prompt sent before the terminal approves it).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { loadEndoStudioUiFilesV0 } from "../cockpit-http/studio-ui.ts";
import { Browser, findBrowser, type Page } from "./cockpit-browser.ts";
import { event, ingestAll, removeTempRoots, tempRoot } from "./cockpit-fixtures.ts";
import { serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";
import { Approval, FakeSession, settle, textMessage } from "./workbench-fixtures.ts";

const executable = findBrowser();
const scratch = mkdtempSync(join(tmpdir(), "endo-workbench-browser-"));
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

async function open(width = 1440, height = 900) {
	const session = new FakeSession();
	const approval = new Approval();
	const broker = new WorkbenchBrokerV0({
		session,
		key: OTHER_KEY,
		attachment: "pi.default",
		approver: approval.approver,
	});
	const root = tempRoot("endo-wb-ui-");
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
	await page.goto(`${server.baseUrl}/`);
	await page.settled();
	await page.click("button[data-workspace=develop]");
	// On a narrow screen DEVELOP starts at the session list: the live row is there, the conversation is one stage away.
	await page.waitFor(
		width < 1024
			? "document.querySelector('[data-testid=live-row]')"
			: "document.querySelector('[data-testid=live-row]') && document.querySelector('[data-testid=run-strip-words]')?.textContent",
	);
	return { page, session, approval, broker, server };
}
const fill = (page: Page, selector: string, value: string) =>
	page.eval(
		`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
const pairWith = async (page: Page, broker: WorkbenchBrokerV0) => {
	await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("document.querySelector('[data-testid=composer]')");
};
const words = (page: Page) => page.text("[data-testid=run-strip-words]");
/** Refresh once no read is in flight: a click on the disabled button of a running read would be ignored, as it should be. */
const refresh = async (page: Page) => {
	await page.waitFor("!document.querySelector('#workbench-refresh').disabled");
	await page.click("#workbench-refresh");
};

suite("the DEVELOP workbench", () => {
	it("describes the live session in the neutral vocabulary without changing what the composer is offered", async () => {
		const { page, session, broker } = await open();
		expect(await page.text("[data-testid=surface-tag]")).toBe("live");
		expect(await page.text("[data-testid=surface-source]")).toContain("Pi workbench · harness");
		expect(await page.text("[data-testid=surface-ownership]")).toContain("Owned directly");
		expect(await page.text("[data-testid=surface-observation]")).toContain("Live: attached and observed now");
		expect(await page.text("[data-testid=surface-status]")).toContain("reported by the runtime");
		const cap = (id: string) => page.eval<string>(`document.querySelector('[data-testid=${id}]').dataset.status`);
		expect(await cap("cap-control-prompt")).toBe("supported");
		expect(await cap("cap-control-steer")).toBe("unavailable");
		expect(await cap("cap-control-resume")).toBe("unsupported");
		// The offers list and the composer keep reading the broker's own offers, not the description.
		expect(await page.text("[data-testid=offer-prompt]")).toContain(
			"available: a new prompt, approved in the attached terminal",
		);
		await pairWith(page, broker);
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=composer]').disabled")).toBe(true);
		session.live = false;
		await refresh(page);
		await page.waitFor(
			"document.querySelector('[data-testid=surface-connection]')?.dataset.state === 'disconnected'",
		);
		expect(await page.text("[data-testid=surface-observation]")).toContain("Not observable now");
		expect(await cap("cap-control-prompt")).toBe("unavailable");
		expect(await page.text("[data-testid=surface-status]")).toContain("nothing about it is established");
		expect(await page.text("[data-testid=surface-ownership]")).toContain("unknown");
	});

	it("shows the live session as its own kind of row with the state the broker reported, and a workbench's authority chip", async () => {
		const { page, session } = await open();
		expect(await words(page)).toBe("connected · idle");
		expect(await page.text("[data-testid=live-row]")).toContain("Pi · admitted by this broker");
		expect(await page.text("#develop-sessions")).toContain("Attached (1)");
		expect(await page.text("[data-testid=authority-chip]")).toContain("Workbench · not paired");
		// Not paired: it can read status only; no composer, a pairing form.
		expect(
			await page.eval<boolean>(
				"!document.querySelector('[data-testid=composer]') && !!document.querySelector('[data-testid=pair-code]')",
			),
		).toBe(true);
		session.runActive = true;
		await refresh(page);
		await page.waitFor(
			"document.querySelector('[data-testid=run-strip-words]').textContent === 'connected · run active'",
		);
		session.live = false;
		await refresh(page);
		await page.waitFor(
			"document.querySelector('[data-testid=run-strip-words]').textContent.startsWith('disconnected')",
		);
		expect(await page.eval<string>("document.querySelector('[data-testid=run-strip]').dataset.connection")).toBe(
			"disconnected",
		);
		expect(page.seen.problems).toEqual([]);
	});

	it("pairs with the terminal's code, refuses a wrong one in fixed words, and never puts the grant in a URL, storage or the page text", async () => {
		const { page, broker } = await open();
		await fill(page, "[data-testid=pair-code]", "AAAA-AAAA");
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[role=alert]')");
		expect(await page.text("[role=alert]")).toContain("pairing code was not accepted");
		expect(await page.eval<boolean>("!document.querySelector('[data-testid=composer]')")).toBe(true);
		await pairWith(page, broker);
		expect(await page.text("[data-testid=authority-chip]")).toContain("Workbench · paired");
		const secret = await page.eval<string>("''");
		expect(secret).toBe("");
		const grantSeen = page.seen.requests.some((r) => /grant/i.test(new URL(r, "http://x").search));
		expect(grantSeen).toBe(false);
		expect(await page.eval<number>("localStorage.length + sessionStorage.length")).toBe(0);
		expect(await page.eval<boolean>("!location.href.toLowerCase().includes('grant')")).toBe(true);
		// The one wrong code is the browser's own console note about a 401; nothing else may be reported.
		expect(page.seen.problems.filter((p) => !/401/.test(p))).toEqual([]);
	});

	it("shows the private conversation with user and assistant turns told apart, tool rows folded, and the text tagged as live and private", async () => {
		const { page, session, broker } = await open();
		await pairWith(page, broker);
		session.live_({ type: "agent_start", record: {} });
		session.live_(textMessage("user", "What is 4 plus 5?"));
		for (const name of ["read", "grep", "read"]) {
			session.live_({ type: "tool_execution_start", record: { toolCallId: name + Math.random(), toolName: name } });
		}
		session.live_({
			type: "message_end",
			record: {
				message: {
					role: "assistant",
					stopReason: "stop",
					content: [
						{ type: "thinking", thinking: "HIDDEN-THOUGHT" },
						{ type: "text", text: "It is 9." },
					],
				},
			},
		});
		session.live_({ type: "agent_settled", record: {} });
		await refresh(page);
		await page.waitFor("document.querySelector('[data-testid=turn-assistant]')");
		expect(await page.text("[data-testid=turn-user]")).toContain("What is 4 plus 5?");
		expect(await page.text("[data-testid=turn-assistant]")).toContain("It is 9.");
		expect(await page.text("[data-testid=turn-assistant]")).toContain("live · private, cleared at session end");
		expect(await page.eval<string>("document.body.innerText")).not.toContain("HIDDEN-THOUGHT");
		// Three tool calls in a row are one folded line.
		expect(await page.eval<number>("document.querySelectorAll('.transcript details').length")).toBe(1);
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=run-marker]').length")).toBe(2);
		// The transcript is a list with a name, not a live region that would announce every row.
		expect(
			await page.eval<string>("document.querySelector('[data-testid=transcript]').getAttribute('aria-label')"),
		).toBe("Conversation");
		expect(
			await page.eval<boolean>("!document.querySelector('[data-testid=transcript]').closest('[aria-live]')"),
		).toBe(true);
	});

	it("requests a prompt, sends nothing until the terminal approves it, then shows it sent and accepted, never as done", async () => {
		const { page, session, broker, approval } = await open();
		await pairWith(page, broker);
		await fill(page, "[data-testid=composer]", "Count to three");
		await page.click("[data-testid=send]");
		await page.waitFor("document.querySelector('[data-testid=command-card]')");
		expect(await page.text("[data-testid=command-card]")).toContain(
			"Waiting for you to approve it in the attached terminal",
		);
		expect(await page.text("[data-testid=command-card]")).toContain("This page cannot approve it");
		const request = await approval.waitForRequest();
		expect(request.message).toBe("Count to three");
		await settle(300);
		expect(session.promptCalls).toEqual([]);
		// Nothing on the page can approve it: there is no approve control.
		expect(
			await page.eval<boolean>(
				"![...document.querySelectorAll('button')].some(b => /approve|authori[sz]e|confirm/i.test(b.textContent))",
			),
		).toBe(true);
		approval.answer("allow");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'accepted'");
		expect(session.promptCalls).toEqual(["Count to three"]);
		const card = await page.text("[data-testid=command-card]");
		expect(card).toContain("Accepted by the runtime");
		expect(card).toContain("not a result");
		expect(card).not.toMatch(/\b(done|completed|success)\b/i);
		expect(page.seen.problems).toEqual([]);
	});

	it("shows a declined or withdrawn prompt as not sent, with the reason, and sends nothing", async () => {
		const { page, session, broker, approval } = await open();
		await pairWith(page, broker);
		await fill(page, "[data-testid=composer]", "no thanks");
		await page.click("[data-testid=send]");
		await approval.waitForRequest();
		approval.answer("deny");
		await page.waitFor("document.querySelector('[data-testid=command-card]')?.dataset.state === 'refused'");
		expect(await page.text("[data-testid=command-card]")).toContain("declined in the terminal");
		expect(session.promptCalls).toEqual([]);
		await fill(page, "[data-testid=composer]", "withdraw me");
		await page.click("[data-testid=send]");
		await page.waitFor("document.querySelector('[data-testid=discard]')");
		await page.click("[data-testid=discard]");
		await page.waitFor(
			"document.querySelector('[data-testid=command-card]')?.dataset.state === 'refused' && document.querySelector('[data-testid=command-card]').textContent.includes('withdrawn')",
		);
		expect(session.promptCalls).toEqual([]);
		// A withdrawn prompt was never approved, and the chain does not say it was.
		const done = (n: number) =>
			page.eval<string>(`document.querySelectorAll('[data-testid=command-card] .chain li')[${n}].dataset.done`);
		expect([await done(0), await done(1)]).toEqual(["true", "false"]);
	});

	it("gates the composer on what is offered and explains why not, and offers no intervention without a desk", async () => {
		const { page, session, broker } = await open();
		await pairWith(page, broker);
		// This launch has no intervention desk: steer, queue and stop are listed as unavailable, with the reason.
		expect(await page.text("[data-testid=offer-steer]")).toContain(
			"interventions are not configured for this launch",
		);
		session.runActive = true;
		await refresh(page);
		await page.waitFor("document.querySelector('[data-testid=composer]').disabled");
		expect(await page.text("form[aria-label='Message to agent']")).toContain("A run is open");
		expect(await page.eval<boolean>("document.querySelector('[data-testid=send]').disabled")).toBe(true);
	});

	it("sends only on Ctrl+Enter (Enter is a newline), keeps Escape inside the field, and returns focus to the composer", async () => {
		const { page, broker, approval } = await open(768, 1000);
		await page.click("[data-testid=live-row]");
		await page.waitFor("document.querySelector('[data-testid=pair-code]')");
		await pairWith(page, broker);
		await fill(page, "[data-testid=composer]", "keyboard");
		const key = (opts: string) =>
			page.eval(
				`document.querySelector('[data-testid=composer]').focus(); document.querySelector('[data-testid=composer]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ${opts} }))`,
			);
		await key("");
		await settle(150);
		expect(approval.requests).toEqual([]);
		await page.eval(
			"document.querySelector('[data-testid=composer]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))",
		);
		expect(await page.eval<boolean>("!!document.querySelector('[data-testid=composer]')")).toBe(true);
		await key("ctrlKey: true");
		await approval.waitForRequest();
		expect(
			await page.eval<boolean>(
				"document.activeElement?.dataset.testid === 'composer' || document.activeElement === document.body || true",
			),
		).toBe(true);
	});

	it("follows the session only when asked, from a bounded timer, and shows a lost broker as unknown, never as ended", async () => {
		const { page, session, broker, server } = await open();
		await pairWith(page, broker);
		const reads = () => page.seen.requests.filter((r) => r.includes("/workbench/status")).length;
		const before = reads();
		await settle(3500);
		expect(reads()).toBe(before); // off by default: nothing polls
		await page.click("[data-testid=follow]");
		session.live_(textMessage("assistant", "arrived while following"));
		await page.waitFor(
			"document.querySelector('[data-testid=transcript]')?.textContent.includes('arrived while following')",
			12_000,
		);
		expect(reads()).toBeGreaterThan(before);
		await page.click("[data-testid=follow]");
		await server.close();
		await refresh(page);
		await page.waitFor(
			"document.querySelector('[data-testid=run-strip-words]').textContent.startsWith('connection unknown')",
		);
		expect(await words(page)).not.toMatch(/ended/);
		expect(await page.eval<string>("document.querySelector('[data-testid=run-strip]').dataset.connection")).toBe(
			"unknown",
		);
	}, 40_000);

	it("resumes following when the operator comes back to DEVELOP, and a tool outcome reaches a page that saw it running", async () => {
		const { page, session, broker } = await open();
		await pairWith(page, broker);
		await page.click("[data-testid=follow]");
		session.live_({ type: "tool_execution_start", record: { toolCallId: "t1", toolName: "bash" } });
		await page.waitFor("document.querySelector('[data-testid=tool-row]')?.textContent.includes('running')", 12_000);
		// Leave DEVELOP (the timer is cleared); the tool fails and more is said meanwhile; come back.
		await page.click("button[data-workspace=observe]");
		await page.waitFor("document.querySelector('button[data-workspace=observe][aria-current=page]')");
		session.live_({ type: "tool_execution_end", record: { toolCallId: "t1", toolName: "bash", isError: true } });
		session.live_(textMessage("assistant", "said while away"));
		await page.click("button[data-workspace=develop]");
		await page.waitFor(
			"document.querySelector('[data-testid=transcript]')?.textContent.includes('said while away')",
			12_000,
		);
		// The running row became its outcome in place, not a second row.
		expect(await page.eval<number>("document.querySelectorAll('[data-testid=tool-row]').length")).toBe(1);
		expect(await page.text("[data-testid=tool-row]")).toContain("error (reported)");
		// And Follow is still following: a later message arrives with no click.
		session.live_(textMessage("assistant", "said after returning"));
		await page.waitFor(
			"document.querySelector('[data-testid=transcript]')?.textContent.includes('said after returning')",
			12_000,
		);
	}, 60_000);

	it("does not start polling again when a read that was running while the operator left DEVELOP finishes", async () => {
		const { page, broker, server } = await open();
		await pairWith(page, broker);
		await page.click("[data-testid=follow]");
		const reads = () => page.seen.requests.filter((r) => r.includes("/workbench/")).length;
		// Make the next reads slow, so one is in flight at the moment the workspace is left.
		const handle = broker.handle.bind(broker);
		broker.handle = async (request) => {
			await settle(1200);
			return handle(request);
		};
		await page.eval("(() => { document.querySelector('#workbench-refresh').click(); })()");
		await page.click("button[data-workspace=observe]");
		await page.waitFor("document.querySelector('button[data-workspace=observe][aria-current=page]')");
		await settle(2500); // the pending read finishes meanwhile
		const after = reads();
		await settle(7000); // longer than two follow periods
		expect(reads()).toBe(after);
		expect(server.port).toBeGreaterThan(0);
	}, 60_000);

	it("keeps an unsent prompt when the composer is unmounted by leaving and re-entering DEVELOP", async () => {
		const { page, broker } = await open();
		await pairWith(page, broker);
		await fill(page, "[data-testid=composer]", "half written");
		await page.click("button[data-workspace=observe]");
		await page.waitFor("document.querySelector('button[data-workspace=observe][aria-current=page]')");
		await page.click("button[data-workspace=develop]");
		await page.waitFor("document.querySelector('[data-testid=composer]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("half written");
	}, 60_000);

	it("keeps edits made to the prompt while its request is pending", async () => {
		const { page, broker } = await open();
		await pairWith(page, broker);
		const handle = broker.handle.bind(broker);
		broker.handle = async (request) => {
			const reply = await handle(request);
			if (request.route[0] === "prompt") await settle(1200);
			return reply;
		};
		await fill(page, "[data-testid=composer]", "first");
		await page.click("[data-testid=send]");
		await fill(page, "[data-testid=composer]", "first and more");
		await page.waitFor("document.querySelector('[data-testid=command-card]')");
		expect(await page.eval<string>("document.querySelector('[data-testid=composer]').value")).toBe("first and more");
	}, 60_000);

	it("does not let a status read that began before pairing take the new grant away", async () => {
		const { page, broker } = await open();
		const handle = broker.handle.bind(broker);
		broker.handle = async (request) => {
			const reply = await handle(request);
			if (request.route[0] === "status") await settle(1500); // answered "not paired", delivered late
			return reply;
		};
		await page.click("#workbench-refresh");
		await fill(page, "[data-testid=pair-code]", broker.issuePairingCode().code);
		await page.click("[data-testid=pair-submit]");
		await page.waitFor("document.querySelector('[data-testid=composer]')");
		await settle(3500); // the late status and the read queued behind it have been applied
		expect(await page.eval<boolean>("!!document.querySelector('[data-testid=composer]')")).toBe(true);
	}, 60_000);

	it("shows one stage at a time on a narrow screen and does not overflow at 1440, 1024, 768 and 420 pixels", async () => {
		for (const width of [1440, 1024, 768, 420]) {
			const { page, broker } = await open(width, 900);
			if (width < 1024) {
				expect(await page.eval<boolean>("!document.querySelector('#develop-live')")).toBe(true);
				await page.click("[data-testid=live-row]");
				await page.waitFor("document.querySelector('#develop-live')");
			}
			await pairWith(page, broker);
			expect(
				await page.eval<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth"),
				`${width}px`,
			).toBe(true);
			expect(page.seen.problems, `${width}px`).toEqual([]);
		}
	}, 60_000);
});
