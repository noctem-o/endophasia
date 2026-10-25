// Shared source-build/installed-tarball browser acceptance. No assertion uses a raw coordinate as a browser request argument.
import type { Browser, Page } from "./cockpit-browser.ts";

export async function chooseRecording(page: Page, side: "a" | "b", source: "pi" | "dsh", index = 0): Promise<void> {
	await page.eval(
		`(() => { const e = document.querySelector('#recording-${side}'); const options = [...e.options].filter(o => !o.disabled && o.value.startsWith('${source}:')); e.value = options[${index}].value; e.dispatchEvent(new Event('change', {bubbles:true})); })()`,
	);
}

export async function exerciseStudioCompare(
	browser: Browser,
	address: string,
): Promise<{ failures: string[]; image: Buffer }> {
	const failures: string[] = [];
	const page = await browser.open(1360, 980);
	const check = (ok: boolean, message: string) => {
		if (!ok) failures.push(message);
	};
	try {
		await page.goto(address);
		await page.settled();
		check(
			page.seen.requests.filter((r) => r.includes("/api/")).length === 1,
			"Observe starts with a single snapshot read",
		);
		await page.click("button[data-workspace=compare]");
		await page.waitFor(
			"document.querySelector('#compare-workspace')?.dataset.busy === 'false' && document.querySelector('#recording-a option[value^=\"pi:\"]') && document.querySelector('#recording-b option[value^=\"dsh:\"]')",
		);
		await chooseRecording(page, "a", "pi");
		await chooseRecording(page, "b", "dsh");
		await page.eval("document.querySelector('#recording-a').focus()");
		await page.press("Tab");
		check(
			await page.eval("document.activeElement.id === 'recording-b'"),
			"recording controls follow keyboard tab order",
		);
		await page.eval("document.querySelector('#compare-run').focus()");
		await page.press("Enter");
		await page.waitFor("document.querySelector('#compare-result')");
		check(
			await page.eval("document.querySelectorAll('.compare-verdict').length === 4"),
			"four independent authoritative verdicts are drawn",
		);
		check((await page.text("#compare-timing")).includes("UNAVAILABLE"), "DSH observer timing remains unavailable");
		check((await page.text("#compare-usage")).includes("B minus A"), "usage direction is explicit");
		check(
			(await page.text("#compare-order")).includes("does not establish causation"),
			"ordering is not a causal claim",
		);
		check(
			(await page.text("#compare-flags")).includes("mapping-differs"),
			"mixed source mapping qualifications remain visible",
		);
		check(
			await page.eval("document.activeElement.id === 'compare-run'"),
			"keyboard focus returns to the initiating control",
		);
		const image = await page.screenshot();
		const reads = page.seen.requests.filter((r) => r.includes("/api/")).length;
		await page.press("r");
		await page.click("button[data-workspace=observe]");
		await page.click("button[data-workspace=compare]");
		check(
			await page.eval("Boolean(document.querySelector('#compare-result'))"),
			"Compare result survives workspace navigation",
		);
		check(
			page.seen.requests.filter((r) => r.includes("/api/")).length === reads,
			"navigation and Observe shortcut cause no extra reads",
		);
		await page.reducedMotion();
		await page.resize(390, 900);
		check(await page.eval("matchMedia('(prefers-reduced-motion: reduce)').matches"), "reduced motion is supported");
		check(await page.eval("document.documentElement.scrollWidth <= innerWidth"), "Compare fits a 390px viewport");
		check(
			await page.eval(
				"[...document.querySelectorAll('#recording-a, #recording-b')].every(e => e.labels.length === 1)",
			),
			"both selection controls have accessible labels",
		);
		check(
			page.seen.requests.every((url) => url.startsWith(`${new URL(address).origin}/`) || url === "about:blank"),
			"all requests remain on the Studio server",
		);
		check(
			page.seen.requests
				.filter((r) => r.includes("/api/v0/compare/"))
				.every((r) => /\/compare\/(candidates(?:\?|$)|selected\/)/.test(r)),
			"browser uses discovery and opaque selection routes only",
		);
		check(page.seen.problems.length === 0, "no console, runtime, CSP or Trusted Types failure");
		return { failures, image };
	} finally {
		await page.close();
	}
}
