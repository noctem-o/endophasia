// A minimal headless-Chromium driver for the cockpit page tests: launch a real browser with no GPU, open a page, evaluate in it,
// click, wait, and capture what it logged, requested and violated. It speaks the DevTools protocol over Node's own WebSocket, so
// no browser-automation package is needed. The browser is found on PATH or by CHROME_BIN; `findBrowser()` is null when there is
// none, and the tests that need one skip with that stated.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function findBrowser(): string | null {
	const candidates = [process.env.CHROME_BIN, "chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
	for (const name of candidates) {
		if (!name) continue;
		const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
		if (probe.status === 0) return name;
	}
	return null;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
}

export interface Seen {
	/** Console errors and warnings, uncaught exceptions and security (CSP, Trusted Types) violations, as text. */
	problems: string[];
	/** Every URL the page requested, in order. */
	requests: string[];
}

export class Browser {
	private child: ChildProcess;
	private socket!: WebSocket;
	private next = 1;
	private pending = new Map<number, Pending>();
	private listeners: ((method: string, params: Record<string, unknown>, sessionId: string | undefined) => void)[] = [];
	private profile: string;

	private constructor(child: ChildProcess, profile: string) {
		this.child = child;
		this.profile = profile;
	}

	static async launch(executable: string): Promise<Browser> {
		const profile = mkdtempSync(join(tmpdir(), "endo-cockpit-chrome-"));
		const child = spawn(
			executable,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-sandbox",
				"--disable-dev-shm-usage",
				"--no-first-run",
				"--no-default-browser-check",
				"--disable-extensions",
				"--hide-scrollbars",
				"--remote-debugging-port=0",
				`--user-data-dir=${profile}`,
				"about:blank",
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		const browser = new Browser(child, profile);
		const url = await new Promise<string>((resolve, reject) => {
			let text = "";
			const timer = setTimeout(() => reject(new Error("the browser did not start")), 30_000);
			child.stderr!.on("data", (chunk: Buffer) => {
				text += chunk.toString();
				const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
				if (match) {
					clearTimeout(timer);
					resolve(match[1]!);
				}
			});
			child.once("exit", () => reject(new Error("the browser exited at startup")));
		});
		await new Promise<void>((resolve, reject) => {
			browser.socket = new WebSocket(url);
			browser.socket.addEventListener("open", () => resolve());
			browser.socket.addEventListener("error", () => reject(new Error("cannot reach the browser")));
			browser.socket.addEventListener("message", (event) => browser.dispatch(String(event.data)));
		});
		return browser;
	}

	private dispatch(text: string): void {
		const message = JSON.parse(text) as {
			id?: number;
			result?: Record<string, unknown>;
			error?: { message: string };
			method?: string;
			params?: Record<string, unknown>;
			sessionId?: string;
		};
		if (message.id !== undefined) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending?.reject(new Error(message.error.message));
			else pending?.resolve(message.result ?? {});
		} else if (message.method)
			for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId);
	}

	send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
		const id = this.next++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	onEvent(listener: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void): void {
		this.listeners.push(listener);
	}

	/** Open a new tab, with a viewport, recording what it logs and requests. */
	async open(width = 1440, height = 900): Promise<Page> {
		const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
		const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as {
			sessionId: string;
		};
		const seen: Seen = { problems: [], requests: [] };
		this.onEvent((method, params, session) => {
			if (session !== sessionId) return;
			if (method === "Runtime.exceptionThrown")
				seen.problems.push(`exception: ${JSON.stringify(params.exceptionDetails).slice(0, 300)}`);
			if (method === "Log.entryAdded") {
				const entry = params.entry as { level: string; source: string; text: string };
				if (entry.level === "error" || entry.level === "warning")
					seen.problems.push(`${entry.source}: ${entry.text}`);
			}
			if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "warning"))
				seen.problems.push(`console.${String(params.type)}`);
			if (method === "Network.requestWillBeSent") seen.requests.push((params.request as { url: string }).url);
		});
		for (const domain of ["Page", "Runtime", "Log", "Network"]) await this.send(`${domain}.enable`, {}, sessionId);
		await this.send(
			"Emulation.setDeviceMetricsOverride",
			{ width, height, deviceScaleFactor: 1, mobile: false },
			sessionId,
		);
		return new Page(this, sessionId, targetId, seen);
	}

	async close(): Promise<void> {
		try {
			this.socket.close();
		} catch {
			// already closed
		}
		this.child.kill("SIGKILL");
		await new Promise((resolve) => (this.child.exitCode === null ? this.child.once("exit", resolve) : resolve(null)));
		rmSync(this.profile, { recursive: true, force: true });
	}
}

export class Page {
	private browser: Browser;
	private sessionId: string;
	private targetId: string;
	readonly seen: Seen;

	constructor(browser: Browser, sessionId: string, targetId: string, seen: Seen) {
		this.browser = browser;
		this.sessionId = sessionId;
		this.targetId = targetId;
		this.seen = seen;
	}

	/** Close the tab, so a long suite does not hold every page it opened. */
	async close(): Promise<void> {
		await this.browser.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
	}

	async goto(url: string): Promise<void> {
		await this.browser.send("Page.navigate", { url }, this.sessionId);
	}

	/** Evaluate an expression in the page (awaiting a promise) and return its JSON value. */
	async eval<T = unknown>(expression: string): Promise<T> {
		const result = (await this.browser.send(
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			this.sessionId,
		)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
		if (result.exceptionDetails)
			throw new Error(
				`in the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
			);
		return result.result.value;
	}

	/** Poll the page until `predicate` (an expression) is truthy, for at most `timeoutMs`. */
	async waitFor(predicate: string, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				if (await this.eval<boolean>(`Boolean(${predicate})`)) return;
			} catch {
				// the page may be between documents
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for: ${predicate}`);
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
	}

	/** Wait for the page to finish a read: its body says `ready` or `error`, and not busy. */
	async settled(attempts?: number): Promise<void> {
		const need = attempts === undefined ? "" : ` && Number(document.body.dataset.attempts) >= ${attempts}`;
		await this.waitFor(
			`document.body && document.body.dataset.busy === "false" && ["ready","error"].includes(document.body.dataset.state)${need}`,
		);
	}

	async click(selector: string): Promise<void> {
		await this.eval(
			`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("no element ${selector.replace(/"/g, "'")}"); e.click(); })()`,
		);
	}

	async text(selector: string): Promise<string> {
		return this.eval<string>(
			`(document.querySelector(${JSON.stringify(selector)}) ?? {textContent: ""}).textContent`,
		);
	}

	async screenshot(): Promise<Buffer> {
		const { data } = (await this.browser.send("Page.captureScreenshot", { format: "png" }, this.sessionId)) as {
			data: string;
		};
		return Buffer.from(data, "base64");
	}
}
