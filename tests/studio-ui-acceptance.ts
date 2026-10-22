// What a real browser must find when it opens the bundled Studio frontend at its capability address. Shared by the vitest suite
// (tests/endo-studio-ui-browser.test.ts, over a build from this checkout) and the package smoke test (scripts/package-smoke.mjs, over
// the installed package), so both ask exactly the same questions. It returns the failures as sentences instead of asserting, so
// each caller reports them in its own way; an empty list is a pass. It never prints the address.
//
// The caller says which store the server was started over, and what that store holds, from outside the page: the page is asked to agree
// with that, not to define it. A populated store is held to what the Observe workspace must show of it; an absent store is held to
// showing absence, as absence: not as an empty log and not as a failure.
import type { Browser } from "./cockpit-browser.ts";

export interface StudioUiFacts {
	/** Every URL the page requested, with the capability replaced by `<capability>`. */
	requests: string[];
	title: string;
}

export interface StudioUiExpectation {
	store: "absent" | "populated";
	/** For a populated store: how many events its log holds (all of them in the first window), and the kind of the first. */
	events?: number;
	firstKind?: string;
}

export async function exerciseStudioUi(
	browser: Browser,
	address: string,
	origin: string,
	expected: StudioUiExpectation = { store: "absent" },
): Promise<{ failures: string[]; facts: StudioUiFacts }> {
	const failures: string[] = [];
	const tab = await browser.open(1280, 800);
	try {
		await tab.goto(address);
		await tab.waitFor(
			`document.body && document.body.dataset.busy === "false" && ["ready","error"].includes(document.body.dataset.state)`,
			30_000,
		);
		await tab.eval("document.fonts.ready.then(() => true)");
		const capability = address.slice(origin.length + 1).replace(/\/$/, "");
		const redact = (text: string): string => text.split(capability).join("<capability>");
		const expect = (ok: boolean, what: string): void => {
			if (!ok) failures.push(what);
		};
		const text = (selector: string) => tab.text(selector);
		const count = (selector: string) =>
			tab.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

		// The shell: the instrument's name, the four workspaces with Observe the one in use, and the page's read-only state.
		expect(
			(await tab.eval<string>("document.title")) === "Endophasia Studio",
			"the page is titled Endophasia Studio",
		);
		expect(
			(
				await tab.eval<string[]>(
					`[...document.querySelectorAll("nav.workspaces button")].map((b) => b.dataset.workspace)`,
				)
			).join() === "observe,compare,capabilities,evolve",
			"the four workspaces are named",
		);
		expect(
			(await tab.eval<string>(
				`document.querySelector('nav.workspaces [aria-current="page"]').dataset.workspace`,
			)) === "observe",
			"Observe is the workspace in use",
		);
		expect(/Read-only/.test(await text(".readonly")), "the page says it is read-only");
		expect(
			(await tab.eval<number>(
				`document.querySelectorAll("[data-testid^=integration-proof], [data-testid=lazy-proof]").length`,
			)) === 0,
			"the integration proof is gone: this is the real frontend",
		);
		expect(
			/by this browser's clock/.test(await text("#read-status")),
			"the read is stamped with the browser's clock",
		);
		expect((await tab.eval<string>("document.body.dataset.state")) === "ready", "the first read produced a snapshot");

		// What the store holds, as the workspace shows it.
		if (expected.store === "populated") {
			const rows = await count("#timeline tr[data-seq]");
			expect(rows === expected.events, `the timeline shows ${expected.events} events (${rows})`);
			const kinds = await tab.eval<string[]>(
				`[...document.querySelectorAll("#timeline tr[data-seq] .kind")].map((e) => e.textContent)`,
			);
			expect(kinds[0] === expected.firstKind, `the first event is ${expected.firstKind} (${kinds[0]})`);
			expect((await count("#overview g[data-seq]")) === expected.events, "the overview has one mark per event");
			expect(
				/whole log as read/.test(await text('[data-testid="overview-coverage"]')),
				"the overview says it covers the whole log as read",
			);
			expect(
				/readable/.test(await text("#runtime")) && /pi\.default/.test(await text("#runtime")),
				"the runtime panel names the attachment and its source condition",
			);
			expect(
				(await count("#capabilities button.caprow")) > 0,
				"the capabilities are listed with their recorded status",
			);
			expect(/independent sources/i.test(await text("#sources")), "the sources say they are independent");
			expect(
				(await count("[data-testid=attention] .attention-item")) === 0,
				"nothing needs attention in a healthy store",
			);
			// Selecting an event opens its record in the inspector, and the overview and the table agree on which.
			await tab.click("#timeline tr[data-seq='2'] button.seq");
			expect(/Event at position 2/.test(await text("#inspector")), "selecting an event opens its inspector");
			expect(/Presented fields/.test(await text("#inspector")), "the inspector shows the presented fields");
			expect(
				/Selected: position 2\./.test(await text("[data-testid=selection-bar]")),
				"the table says which event is selected",
			);
			await tab.click("[data-focus=selection-action]");
			expect(
				await tab.eval<boolean>(
					`document.activeElement.closest("tr") && document.activeElement.closest("tr").dataset.seq === "2"`,
				),
				"Show in table puts focus on the selected row, with no further read",
			);
			expect(
				(await tab.eval<string>(`document.querySelector("#overview .omark-wrap.selected").dataset.seq`)) === "2",
				"the overview marks the same event",
			);
			// A style the frontend sets from script (the log-extent bracket) is applied: the CSS object model is allowed by the policy.
			const bracket = await tab.eval<number>(
				`document.querySelector(".extent-window").getBoundingClientRect().width`,
			);
			expect(bracket > 20, `the log-extent bracket, set from script, is drawn (${bracket}px)`);
		} else {
			expect(
				/No event log exists under this store root/.test(await text("#timeline")),
				"an absent log is said to be absent",
			);
			expect((await count("#timeline table")) === 0, "no table is drawn for a log that is not there");
			expect(/absent/.test(await text("[data-testid=attention]")), "the absent source is called out");
			expect(
				/nothing to draw/.test(await text('[data-testid="overview-coverage"]')),
				"the overview says there is nothing to draw",
			);
		}

		// A workspace that is not built is loaded on demand, says so, and shows nothing of the store.
		await tab.click("button[data-workspace=compare]");
		await tab.waitFor(`document.querySelector("[data-testid=unavailable-compare]")`, 15_000);
		expect(
			/is not available yet/.test(await text("[data-testid=unavailable-compare]")),
			"an unbuilt workspace says it is not available",
		);
		expect((await count("tr[data-seq]")) === 0, "and draws no record");
		await tab.click("button[data-workspace=observe]");

		// The bundled fonts were requested, loaded and are the ones in use (a declared font nothing uses is never fetched).
		const font = await tab.eval<{ sans: boolean; mono: boolean; faces: string[] }>(`(() => ({
			sans: document.fonts.check('13px "IBM Plex Sans"', "Endophasia"),
			mono: document.fonts.check('13px "IBM Plex Mono"', "0123"),
			faces: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family + " " + face.weight),
		}))()`);
		expect(font.sans && font.mono, "both bundled typefaces are available");
		expect(
			font.faces.includes('"IBM Plex Sans" 400') || font.faces.includes("IBM Plex Sans 400"),
			`the Sans 400 face loaded (${font.faces.join(", ")})`,
		);
		expect(
			font.faces.some((face) => /Mono/.test(face)),
			"the Mono face loaded",
		);

		// Every resource the page fetched came from the server that served it, and was a success.
		const resources = await tab.eval<{ name: string; status: number }[]>(
			`performance.getEntriesByType("resource").filter((e) => !e.name.includes("/api/")).map((e) => ({ name: e.name, status: e.responseStatus }))`,
		);
		const names = resources.map((entry) => entry.name);
		expect(
			resources.every((entry) => entry.status === 200),
			"every resource answered 200",
		);
		expect(
			names.every((name) => name.startsWith(`${address}assets/`)),
			"every resource is under the capability's assets path",
		);
		for (const [what, pattern] of [
			["the entry script", /\/main-[A-Z0-9]+\.js$/],
			["the style sheet", /\/main-[A-Z0-9]+\.css$/],
			["the lazy module", /\/Unavailable-[A-Z0-9]+\.js$/],
			["the shared chunk", /\/chunk-[A-Z0-9]+\.js$/],
			["the sans font", /\/ibm-plex-sans-latin-400-normal-[A-Z0-9]+\.woff2$/],
			["the mono font", /\/ibm-plex-mono-latin-400-normal-[A-Z0-9]+\.woff2$/],
		] as const)
			expect(
				names.some((name) => pattern.test(name)),
				`${what} was requested and loaded`,
			);
		// The one endpoint it reads is read once at open, and not again until asked: switching workspace and selecting read nothing.
		const reads = tab.seen.requests.filter((url) => url.includes("/api/"));
		expect(
			reads.length === 1 &&
				/\/api\/v0\/snapshot\?afterSequence=0&limit=100$/.test(redact(reads[0]!).replace("<capability>", "")),
			`one snapshot read, of the first window (${reads.length})`,
		);

		// Nothing outside the server: not a request, not a console message, not a policy violation.
		const requests = tab.seen.requests.map(redact);
		expect(
			tab.seen.requests.every((url) => url.startsWith(`${origin}/`) || url === "about:blank"),
			"no request went anywhere but the server that served the page",
		);
		expect(
			tab.seen.problems.length === 0,
			`no console error, uncaught exception, policy or Trusted Types violation: ${tab.seen.problems.map(redact).join(" | ")}`,
		);

		// The Trusted Types requirement still holds under the framework: a string reaching an HTML sink throws.
		const sink = await tab.eval<string>(
			`(() => { try { document.body.innerHTML = "<b>x</b>"; return "allowed"; } catch (e) { return e.name; } })()`,
		);
		expect(sink === "TypeError", `an HTML sink still throws under Trusted Types (${sink})`);
		const policies = await tab.eval<string>(
			`(() => { try { window.trustedTypes.createPolicy("x", {}); return "allowed"; } catch (e) { return e.name; } })()`,
		);
		expect(policies === "TypeError", `no Trusted Types policy can be created (${policies})`);
		expect((await count("script:not([src])")) === 0, "no inline script is on the page");

		const title = await tab.eval<string>("document.title");
		return { failures, facts: { requests, title } };
	} finally {
		await tab.close();
	}
}

/**
 * The same page at a narrow width: the inspector is a modal dialog that carries the source warnings with it, Escape closes it, and focus
 * goes back to the row it was opened from. Run against a store with a degraded log, where the warning exists to be carried.
 */
export async function exerciseStudioUiNarrow(browser: Browser, address: string): Promise<string[]> {
	const failures: string[] = [];
	const tab = await browser.open(420, 900);
	try {
		await tab.goto(address);
		await tab.waitFor(
			`document.body && document.body.dataset.busy === "false" && document.body.dataset.state === "ready"`,
			30_000,
		);
		const expect = (ok: boolean, what: string): void => {
			if (!ok) failures.push(what);
		};
		expect(
			await tab.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1"),
			"the page does not scroll sideways at 420px",
		);
		expect(
			/degraded/.test(await tab.text("[data-testid=attention]")),
			"the degraded source is called out in the shell",
		);
		await tab.eval(`document.querySelector("#timeline tr[data-seq='3'] button.seq").focus()`);
		await tab.click("#timeline tr[data-seq='3'] button.seq");
		expect(
			await tab.eval<boolean>(`document.querySelector("dialog#inspector").open`),
			"the inspector opened as a modal dialog",
		);
		expect(
			/degraded/.test(await tab.text("dialog#inspector [data-testid=dialog-attention]")),
			"the degraded source is called out inside the dialog, where the page behind is inert",
		);
		await tab.press("Escape");
		await tab.waitFor(`document.querySelector("dialog#inspector").open === false`, 5000);
		expect(
			await tab.eval<boolean>(
				`document.activeElement && document.activeElement.closest("tr") && document.activeElement.closest("tr").dataset.seq === "3"`,
			),
			"focus is back on the row the dialog was opened from",
		);
		expect(
			tab.seen.problems.length === 0,
			`no console error or policy violation at 420px: ${tab.seen.problems.join(" | ")}`,
		);
		return failures;
	} finally {
		await tab.close();
	}
}
