// DEVELOP-VALIDATION-001, experiment E: open `endo workspace open` on a disposable store, pair with the code the host prints (this
// exercises the pairing protocol in a host with no agent and no execution surface; it is not a human action), choose the task, and
// save the page's text and screenshots at 1440 and 390 px. Usage:
//   node research/develop-validation/browser-read.ts <store> <project-id> <task-title> <out-dir>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, findBrowser } from "../../tests/cockpit-browser.ts";

const [store, project, title, out] = process.argv.slice(2);
const cli = new URL("../../dist/cli/index.js", import.meta.url).pathname;
const host = spawn(process.execPath, [cli, "workspace", "open", "--root", store!, "--project", project!], {
	stdio: ["pipe", "pipe", "pipe"],
});
let log = "";
const seen = (re: RegExp) =>
	new Promise<RegExpMatchArray>((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`timed out waiting for ${re}: ${log}`)), 20_000);
		const look = () => {
			const m = log.match(re);
			if (m) {
				clearTimeout(t);
				resolve(m);
			} else setTimeout(look, 50);
		};
		look();
	});
const append = (d: Buffer) => {
	log += d;
};
host.stdout.on("data", append);
host.stderr.on("data", append);
const browser = await Browser.launch(findBrowser() ?? "chromium");
try {
	const code = (await seen(/pairing code ([A-Z0-9]{4}-[A-Z0-9]{4})/))[1]!;
	const url = (await seen(/(http:\/\/127\.0\.0\.1:\d+\/\S+)/))[1]!;
	const page = await browser.open(1440, 1000);
	await page.reducedMotion();
	await page.goto(url);
	await page.waitFor("document.querySelector('[data-testid=pair-code]')");
	await page.eval(
		`(() => { const i = document.querySelector('[data-testid=pair-code]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(code)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`,
	);
	await page.click("[data-testid=pair-submit]");
	await page.waitFor("!document.querySelector('[data-testid=pair-code]')");
	// Wait for the overview's own signal that its checks were read (as the product's browser tests do), and record if it never comes.
	let evidence = "shown";
	try {
		await page.waitFor(
			"document.querySelector('[data-testid=attention-overview]')?.dataset.evidence === 'shown'",
			20_000,
		);
	} catch {
		evidence = String(
			await page.eval<string>(
				"document.querySelector('[data-testid=attention-overview]')?.dataset.evidence ?? 'no overview'",
			),
		);
	}
	await page.settled();
	writeFileSync(join(out!, "overview-evidence.txt"), evidence);
	writeFileSync(join(out!, "overview.txt"), await page.eval<string>("document.body.innerText"));
	writeFileSync(join(out!, "overview-1440.png"), await page.screenshot());
	// Open the task from the overview: the first element whose text is the task's title.
	const opened = await page.eval<boolean>(
		`(() => { const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => e.innerText.includes(${JSON.stringify(title)})); if (!el) return false; el.click(); return true; })()`,
	);
	await page.settled();
	await new Promise((r) => setTimeout(r, 800));
	writeFileSync(join(out!, "task.txt"), `opened=${opened}\n${await page.eval<string>("document.body.innerText")}`);
	const full = await page.eval<number>("document.documentElement.scrollHeight");
	await page.resize(1440, Math.min(full, 6000));
	writeFileSync(join(out!, "task-1440.png"), await page.screenshot());
	await page.resize(390, 900);
	await page.settled();
	const tall = await page.eval<number>("document.documentElement.scrollHeight");
	writeFileSync(
		join(out!, "overflow-390.txt"),
		String(await page.eval<boolean>("document.documentElement.scrollWidth <= window.innerWidth")),
	);
	await page.resize(390, Math.min(tall, 9000));
	writeFileSync(join(out!, "task-390.png"), await page.screenshot());
} finally {
	await browser.close();
	host.kill("SIGINT");
	await new Promise((r) => setTimeout(r, 500));
	if (host.exitCode === null) host.kill("SIGKILL");
	writeFileSync(
		join(out!, "host.log"),
		log.replace(/http:\/\/127\.0\.0\.1:\d+\/\S+/g, "<private address>").replace(/[A-Z0-9]{4}-[A-Z0-9]{4}/g, "<code>"),
	);
}
