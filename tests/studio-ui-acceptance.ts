// What a real browser must find when it opens the bundled Studio frontend at its capability address. Shared by the vitest suite
// (tests/endo-studio-ui-browser.test.ts, over a build from this checkout) and the package smoke test (scripts/package-smoke.mjs, over
// the installed package), so both ask exactly the same questions. It returns the failures as sentences instead of asserting, so
// each caller reports them in its own way; an empty list is a pass. It never prints the address.
import type { Browser } from "./cockpit-browser.ts";

export interface StudioUiFacts {
	/** Every URL the page requested, with the capability replaced by `<capability>`. */
	requests: string[];
	title: string;
}

export async function exerciseStudioUi(
	browser: Browser,
	address: string,
	origin: string,
): Promise<{ failures: string[]; facts: StudioUiFacts }> {
	const failures: string[] = [];
	const tab = await browser.open(1280, 800);
	try {
		await tab.goto(address);
		await tab.waitFor(`document.querySelector('[data-testid="lazy-proof"]') !== null`, 30_000);
		await tab.eval("document.fonts.ready.then(() => true)");
		const capability = address.slice(origin.length + 1).replace(/\/$/, "");
		const redact = (text: string): string => text.split(capability).join("<capability>");
		const expect = (ok: boolean, what: string): void => {
			if (!ok) failures.push(what);
		};

		const text = (selector: string) => tab.text(selector);
		expect(
			/Integration proof/.test(await text('[data-testid="integration-proof"]')),
			"the page says it is an integration proof",
		);
		expect(
			/not an observation/.test(await text('[data-testid="integration-proof"]')),
			"the page says it is not an observation",
		);
		expect(
			/deferred module was loaded/.test(await text('[data-testid="lazy-proof"]')),
			"a lazily imported module rendered",
		);

		// Style sheet applied, and a style set through the style object applied (the CSS object model, not markup).
		const computed = await tab.eval<{
			background: string;
			border: string;
			font: string;
			icon: [boolean, number];
		}>(`(() => {
			const border = getComputedStyle(document.querySelector('[data-testid="style-prop"]')).borderLeftWidth;
			const img = document.querySelector('[data-testid="icon-image"]');
			return {
				background: getComputedStyle(document.body).backgroundColor,
				border,
				font: getComputedStyle(document.querySelector('[data-testid="font-sample"]')).fontFamily,
				icon: [img.complete, img.naturalWidth],
			};
		})()`);
		expect(
			computed.background === "rgb(12, 13, 15)",
			`the style sheet applied (body background ${computed.background})`,
		);
		expect(computed.border === "6px", `the style set from script applied (${computed.border})`);
		expect(computed.icon[0] && computed.icon[1] > 0, "the SVG image decoded");

		// The bundled font was requested, loaded and is the one in use (a declared font nothing uses is never fetched).
		const font = await tab.eval<{ loaded: boolean; statuses: string[] }>(`(() => ({
			loaded: document.fonts.check('16px "IBM Plex Sans"', "Bundled typeface sample"),
			statuses: [...document.fonts].filter((face) => face.family.includes("IBM Plex Sans")).map((face) => face.status),
		}))()`);
		expect(
			font.statuses.length === 1 && font.statuses[0] === "loaded",
			`the bundled font face loaded (${font.statuses.join(",")})`,
		);

		// Every resource the page fetched came from the server that served it, and was a success.
		const resources = await tab.eval<{ name: string; status: number; type: string }[]>(
			`performance.getEntriesByType("resource").map((e) => ({ name: e.name, status: e.responseStatus, type: e.initiatorType }))`,
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
			["the lazy module", /\/LazyProof-[A-Z0-9]+\.js$/],
			["the shared chunk", /\/chunk-[A-Z0-9]+\.js$/],
			["the font", /\/ibm-plex-sans-latin-400-normal-[A-Z0-9]+\.woff2$/],
			["the icon", /\/icon\.svg$/],
		] as const)
			expect(
				names.some((name) => pattern.test(name)),
				`${what} was requested and loaded`,
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

		const title = await tab.eval<string>("document.title");
		return { failures, facts: { requests, title } };
	} finally {
		await tab.close();
	}
}
