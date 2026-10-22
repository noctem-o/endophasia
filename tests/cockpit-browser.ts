// A minimal headless-Chromium driver for the cockpit page tests: launch a real browser with no GPU, open a page, evaluate in it,
// click, wait, and capture what it logged, requested and violated. It speaks the DevTools protocol over Node's own WebSocket, so
// no browser-automation package is needed. The browser is found on PATH or by CHROME_BIN; `findBrowser()` is null when there is
// none, and the tests that need one skip with that stated.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a candidate gets to answer `--version`. A browser that is merely cold answers well inside it; one that stalls does not hold up discovery. */
const PROBE_MS = 10_000;

/**
 * The first candidate that answers `--version` with success, in order, or null. A candidate that fails, is missing or does not answer
 * within `probeMs` is passed over. The probe's output is not read (the exit status is all it needs): with no pipe to wait on, a wrapper
 * script whose helper keeps running cannot hold the probe past its timeout.
 */
export function findBrowser(
	options: { candidates?: readonly (string | undefined)[]; probeMs?: number } = {},
): string | null {
	const candidates = options.candidates ?? [
		process.env.CHROME_BIN,
		"chromium",
		"chromium-browser",
		"google-chrome",
		"google-chrome-stable",
	];
	for (const name of candidates) {
		if (!name) continue;
		const probe = spawnSync(name, ["--version"], {
			stdio: "ignore",
			timeout: options.probeMs ?? PROBE_MS,
			killSignal: "SIGKILL",
		});
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
	private socket: WebSocket | undefined;
	private next = 1;
	private pending = new Map<number, Pending>();
	/** Set once, by `lose`: why no command can be sent or answered any more. */
	private lost: Error | undefined;
	private closing: Promise<void> | undefined;
	private listeners: ((method: string, params: Record<string, unknown>, sessionId: string | undefined) => void)[] = [];
	private profile: string;

	private constructor(child: ChildProcess, profile: string) {
		this.child = child;
		this.profile = profile;
	}

	/**
	 * Start the browser and connect to it. `startupMs` bounds the wait for it to announce its DevTools address. A launch that fails at
	 * either step ends the whole process group and removes the profile before it throws: the caller has no `Browser` to close then.
	 */
	static async launch(executable: string, startupMs = 30_000): Promise<Browser> {
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
			{ stdio: ["ignore", "ignore", "pipe"], detached: true }, // its own process group, so close() can end every helper
		);
		const browser = new Browser(child, profile);
		try {
			const url = await new Promise<string>((resolve, reject) => {
				let text = "";
				const fail = (message: string): void => {
					clearTimeout(timer);
					reject(new Error(message));
				};
				const timer = setTimeout(() => fail("the browser did not start"), startupMs);
				child.stderr!.on("data", (chunk: Buffer) => {
					text += chunk.toString();
					const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
					if (match) {
						clearTimeout(timer);
						resolve(match[1]!);
					}
				});
				child.once("exit", () => fail("the browser exited at startup"));
				child.once("error", () => fail("the browser could not be started"));
			});
			await new Promise<void>((resolve, reject) => {
				const socket = new WebSocket(url);
				browser.socket = socket;
				// A browser that accepts the connection and never completes the handshake neither opens nor fails it: bound the wait too.
				const timer = setTimeout(() => reject(new Error("the browser did not complete the connection")), startupMs);
				socket.addEventListener("open", () => {
					clearTimeout(timer);
					resolve();
				});
				socket.addEventListener("error", () => {
					clearTimeout(timer);
					reject(new Error("cannot reach the browser"));
				});
				browser.watch(socket);
			});
		} catch (error) {
			await browser.close();
			throw error;
		}
		return browser;
	}

	/** Every way the connection can end leads to `lose`; a message that cannot be used is dropped, not thrown from the socket. */
	private watch(socket: WebSocket): void {
		socket.addEventListener("message", (event) => {
			if (this.lost === undefined) this.dispatch(String(event.data));
		});
		socket.addEventListener("close", (event) =>
			this.lose(`the connection to the browser was lost (close code ${event.code})`),
		);
		socket.addEventListener("error", () => this.lose("the connection to the browser was lost (socket error)"));
	}

	/**
	 * The one transition out of "connected": nothing can be sent or answered afterwards. Every command still waiting is rejected with
	 * `reason`, and the list is emptied first so that nothing can settle twice. Later calls change nothing (the first reason stands).
	 */
	private lose(reason: string): void {
		if (this.lost !== undefined) return;
		this.lost = new Error(reason);
		const waiting = [...this.pending.values()];
		this.pending.clear();
		for (const command of waiting) command.reject(this.lost);
	}

	/** Whether the connection has ended, so polling for a page state is pointless. */
	get isLost(): boolean {
		return this.lost !== undefined;
	}

	private dispatch(text: string): void {
		let message: {
			id?: number;
			result?: Record<string, unknown>;
			error?: { message: string };
			method?: string;
			params?: Record<string, unknown>;
			sessionId?: string;
		};
		try {
			message = JSON.parse(text);
		} catch {
			return; // not a DevTools message; nothing waits for it
		}
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
			if (this.lost !== undefined) return reject(this.lost);
			if (this.socket === undefined) return reject(new Error("the browser is not connected"));
			this.pending.set(id, { resolve, reject });
			try {
				this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
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

	/** End the browser. Safe to call more than once, and while commands are waiting: they are rejected as closed. */
	close(): Promise<void> {
		this.closing ??= this.shutdown();
		return this.closing;
	}

	private async shutdown(): Promise<void> {
		this.lose("the browser was closed");
		try {
			this.socket?.close();
		} catch {
			// already closed
		}
		// A browser is several processes (zygote, renderers, utility): end the whole group, then wait for the main one. A browser that
		// never started has no process to end or wait for.
		const pid = this.child.pid;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				this.child.kill("SIGKILL");
			}
			// A child that died of a signal has no exit code but has already emitted its exit: waiting for it again would never end.
			const over = this.child.exitCode !== null || this.child.signalCode !== null;
			await new Promise((resolve) => (over ? resolve(null) : this.child.once("exit", resolve)));
		}
		// The profile is scratch in the temporary directory: a helper that was still writing is retried, and a leftover is not a test failure.
		try {
			rmSync(this.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch {
			// left for the operating system's temporary-file cleanup
		}
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

	/** Change the viewport of this tab, as a window resize does. */
	async resize(width: number, height: number): Promise<void> {
		await this.browser.send(
			"Emulation.setDeviceMetricsOverride",
			{ width, height, deviceScaleFactor: 1, mobile: false },
			this.sessionId,
		);
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
			} catch (error) {
				// the page may be between documents; a lost connection is not that, and polling it would only wait out the timeout
				if (this.browser.isLost) throw error;
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

	/** A real key press (down and up) as the browser's input pipeline sees it, so default actions run (Escape closes a dialog, Enter presses a button). */
	async press(key: string): Promise<void> {
		const codes: Record<string, { code: string; vk: number; text?: string }> = {
			Escape: { code: "Escape", vk: 27 },
			Enter: { code: "Enter", vk: 13, text: "\r" },
			ArrowDown: { code: "ArrowDown", vk: 40 },
			ArrowUp: { code: "ArrowUp", vk: 38 },
			Tab: { code: "Tab", vk: 9 },
			r: { code: "KeyR", vk: 82, text: "r" },
		};
		const spec = codes[key] ?? { code: key, vk: key.toUpperCase().charCodeAt(0), text: key };
		const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk };
		await this.browser.send(
			"Input.dispatchKeyEvent",
			{
				type: spec.text === undefined ? "rawKeyDown" : "keyDown",
				...base,
				...(spec.text === undefined ? {} : { text: spec.text }),
			},
			this.sessionId,
		);
		await this.browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, this.sessionId);
	}

	/** Move the real pointer over the centre of an element. */
	async hover(selector: string): Promise<void> {
		const at = await this.eval<{ x: number; y: number }>(
			`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
		);
		await this.browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, this.sessionId);
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
