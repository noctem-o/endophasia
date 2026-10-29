// Shared source-build/installed-tarball browser acceptance for DEVELOP. Reads recordings only: no assertion starts or steers anything.
import type { Browser } from "./cockpit-browser.ts";

export async function exerciseStudioDevelop(browser: Browser, address: string): Promise<{ failures: string[] }> {
	const failures: string[] = [];
	const check = (ok: boolean, message: string) => {
		if (!ok) failures.push(message);
	};
	const page = await browser.open(1360, 980);
	try {
		await page.goto(address);
		await page.settled();
		await page.click("button[data-workspace=develop]");
		await page.waitFor(
			"document.querySelector('#develop-workspace') && !document.querySelector('#develop-workspace .loading') && document.querySelector('[data-session-row]')",
		);
		const text = await page.eval<string>("document.body.innerText");
		check(text.includes("as recorded"), "recorded lifecycle states are worded as recorded");
		check(!/\b(alive|online|active now)\b/i.test(text), "no state is presented as a live process");
		check(text.includes("Project: unavailable"), "project association is stated as unavailable");
		await page.click("[data-session-row]");
		await page.waitFor("document.querySelector('[data-testid=activity-title]')");
		check(
			(await page.eval<number>("document.querySelectorAll('[data-event-row]').length")) > 0,
			"the selected recording's events are listed",
		);
		await page.click("[data-event-row]");
		await page.waitFor("document.querySelector('#develop-inspector [data-testid=event-detail]')");
		check(
			page.seen.requests
				.filter((r) => r.includes("/api/v0/develop/"))
				.every((r) => /\/develop\/(sessions(?:\?cursor=s1-|$)|session\/d1-[0-9a-f]{64}(?:\?cursor=a1-|$))/.test(r)),
			"browser uses the two DEVELOP routes with opaque tokens only",
		);
		check(
			page.seen.requests.every((url) => url.startsWith(`${new URL(address).origin}/`) || url === "about:blank"),
			"all requests remain on the Studio server",
		);
		check(await page.eval("document.documentElement.scrollWidth <= innerWidth"), "DEVELOP fits the viewport");
		check(page.seen.problems.length === 0, "no console, runtime, CSP or Trusted Types failure");
		return { failures };
	} finally {
		await page.close();
	}
}
