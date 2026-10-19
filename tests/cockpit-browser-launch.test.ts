// The browser driver's failure paths. A launch that fails has no `Browser` for the caller to close, so it must end the browser's
// process group and remove its profile itself, or the suite leaves a running process (and its pipe, which can keep CI waiting).
// A connection that is lost after a launch must fail every command still waiting for an answer, and every later one, at once.
// Discovery must not wait on a candidate that never answers. These use stand-in executables and a local WebSocket server, so
// they need no Chromium.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Browser, findBrowser } from "./cockpit-browser.ts";

const scratch = mkdtempSync(join(tmpdir(), "endo-cockpit-launch-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
/** What a stand-in wrote to a file (it may land a moment after the launch has already failed). */
const written = async (file: string): Promise<string> => {
	for (let i = 0; i < 50; i += 1) {
		try {
			const text = readFileSync(file, "utf8");
			if (text.trim() !== "") return text;
		} catch {
			// not written yet
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`nothing appeared in ${file}`);
};
const pidIn = async (file: string): Promise<number> => Number((await written(file)).trim());
const gone = async (pid: number) => {
	for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
	return !alive(pid);
};

/** The profile directory the launch gave a stand-in (the driver passes it as --user-data-dir). Named by that, not listed in the
 *  temporary directory, so a real browser another test file has open at the same time is not mistaken for a leftover. */
const profileOf = async (argsFile: string): Promise<string> => {
	const match = /--user-data-dir=(\S+)/.exec(await written(argsFile));
	if (match === null) throw new Error("the stand-in was given no profile directory");
	return match[1]!;
};

/** A stand-in browser: writes its pid and arguments, runs `body`, then (if it is still running) sleeps. A helper joins its group. */
function stand(name: string, body: string): { path: string; pidFile: string; childFile: string; argsFile: string } {
	const path = join(scratch, name);
	const pidFile = join(scratch, `${name}.pid`);
	const childFile = join(scratch, `${name}.child`);
	const argsFile = join(scratch, `${name}.args`);
	writeFileSync(
		path,
		`#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\necho "$@" > ${JSON.stringify(argsFile)}\n(sleep 120 & echo $! > ${JSON.stringify(childFile)}; wait) &\n${body.replaceAll("@CHILD@", JSON.stringify(childFile))}\n`,
	);
	chmodSync(path, 0o755);
	return { path, pidFile, childFile, argsFile };
}

describe("a browser that fails to start leaves nothing behind", () => {
	it("one that never announces its address: the launch times out, its whole group is ended and its profile removed", async () => {
		const browser = stand("silent", "sleep 120");
		await expect(Browser.launch(browser.path, 400)).rejects.toThrow(/did not start/);
		const pid = await pidIn(browser.pidFile);
		const helper = await pidIn(browser.childFile);
		expect(await gone(pid)).toBe(true);
		expect(await gone(helper)).toBe(true); // a helper in the same group is ended too
		expect(existsSync(await profileOf(browser.argsFile))).toBe(false);
	});

	it("one that announces an address nothing listens on: the connection fails, and the same cleanup runs", async () => {
		const browser = stand(
			"unreachable",
			'while [ ! -s @CHILD@ ]; do sleep 0.05; done\necho "DevTools listening on ws://127.0.0.1:9/devtools/browser/none" >&2\nsleep 120',
		);
		await expect(Browser.launch(browser.path, 5_000)).rejects.toThrow(/cannot reach the browser/);
		expect(await gone(await pidIn(browser.pidFile))).toBe(true);
		expect(await gone(await pidIn(browser.childFile))).toBe(true);
		expect(existsSync(await profileOf(browser.argsFile))).toBe(false);
	});

	it("one that exits at once: the launch says so and the profile is removed", async () => {
		const browser = stand("exits", "while [ ! -s @CHILD@ ]; do sleep 0.05; done\nexit 3");
		await expect(Browser.launch(browser.path, 5_000)).rejects.toThrow(/exited at startup/);
		expect(await gone(await pidIn(browser.childFile))).toBe(true);
		expect(existsSync(await profileOf(browser.argsFile))).toBe(false);
	});

	it("one that is killed by a signal before it announces anything: the launch fails instead of waiting for an exit already seen", async () => {
		const browser = stand("signalled", "while [ ! -s @CHILD@ ]; do sleep 0.05; done\nkill -TERM $$");
		await expect(Browser.launch(browser.path, 5_000)).rejects.toThrow(/exited at startup/);
		expect(await gone(await pidIn(browser.childFile))).toBe(true);
		expect(existsSync(await profileOf(browser.argsFile))).toBe(false);
	}, 15_000);

	it("one that announces an address whose server accepts the connection and never completes the handshake: the wait is bounded and cleaned up", async () => {
		const held: Socket[] = [];
		const silent = createServer((socket) => held.push(socket)); // accepts, says nothing, never closes
		await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
		const { port } = silent.address() as { port: number };
		try {
			const browser = stand(
				"stalled",
				`while [ ! -s @CHILD@ ]; do sleep 0.05; done\necho "DevTools listening on ws://127.0.0.1:${port}/devtools/browser/none" >&2\nsleep 120`,
			);
			await expect(Browser.launch(browser.path, 600)).rejects.toThrow(/did not complete the connection/);
			expect(await gone(await pidIn(browser.pidFile))).toBe(true);
			expect(await gone(await pidIn(browser.childFile))).toBe(true);
			expect(existsSync(await profileOf(browser.argsFile))).toBe(false);
		} finally {
			for (const socket of held) socket.destroy();
			await new Promise<void>((resolve) => silent.close(() => resolve()));
		}
	}, 15_000);

	it("one that cannot be run at all: the launch fails and nothing is left or waited on", async () => {
		await expect(Browser.launch(join(scratch, "no-such-browser"), 5_000)).rejects.toThrow(/could not be started/);
	});
});

/** A DevTools endpoint that is only as much WebSocket as the driver needs: it completes the handshake, records the commands it is
 *  sent (their text, in order) and answers or drops the connection when a test says so. */
async function endpoint(): Promise<{
	url: string;
	received: string[];
	connected: Promise<Socket>;
	frame: (socket: Socket, text: string) => void;
	closeGracefully: (socket: Socket) => void;
	stop: () => Promise<void>;
}> {
	const received: string[] = [];
	const sockets: Socket[] = [];
	const arrival = Promise.withResolvers<Socket>();
	const server = createHttpServer();
	server.on("upgrade", (request, socket: Socket) => {
		const accept = createHash("sha1")
			.update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		sockets.push(socket);
		// Client frames are masked text frames of a short command (several can arrive in one chunk); a close frame ends the scan.
		socket.on("data", (chunk: Buffer) => {
			for (let at = 0; at + 2 <= chunk.length; ) {
				if ((chunk[at]! & 0x0f) !== 1) return;
				const length = chunk[at + 1]! & 0x7f;
				const head = at + (length === 126 ? 4 : 2);
				const size = length === 126 ? chunk.readUInt16BE(at + 2) : length;
				const mask = chunk.subarray(head, head + 4);
				const payload = Buffer.from(chunk.subarray(head + 4, head + 4 + size));
				for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
				received.push(payload.toString("utf8"));
				at = head + 4 + size;
			}
		});
		socket.on("error", () => undefined);
		arrival.resolve(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	return {
		url: `ws://127.0.0.1:${port}/devtools/browser/fixture`,
		received,
		connected: arrival.promise,
		frame(socket, text) {
			const payload = Buffer.from(text);
			socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload])); // short, unmasked text frame
		},
		closeGracefully(socket) {
			socket.write(Buffer.from([0x88, 0x00]));
			socket.end();
		},
		async stop() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

/** Whatever `work` is, it must be over within `ms`: a promise that is still waiting fails the test instead of hanging it. */
const within = <T>(ms: number, work: Promise<T>, what: string): Promise<T> =>
	Promise.race([
		work,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`${what} was still waiting after ${ms} ms`)), ms),
		),
	]);

async function launched(devtools: { url: string }, name: string): Promise<Browser> {
	const browser = stand(name, `echo "DevTools listening on ${devtools.url}" >&2\nsleep 120`);
	return Browser.launch(browser.path, 5_000);
}

describe("a connection lost after launch fails what is waiting, and what comes after", () => {
	it("an abrupt drop rejects every outstanding command, then a new command at once, and close is harmless and repeatable", async () => {
		const devtools = await endpoint();
		const browser = await launched(devtools, "drops");
		try {
			const socket = await devtools.connected;
			const outstanding = [browser.send("A.one"), browser.send("A.two"), browser.send("A.three")].map((p) =>
				p.then(
					() => "resolved",
					(error: Error) => error.message,
				),
			);
			for (let i = 0; i < 100 && devtools.received.length < 3; i += 1) await new Promise((r) => setTimeout(r, 20));
			expect(devtools.received.length).toBe(3); // all three were sent and none answered
			socket.destroy();
			const outcomes = await within(5_000, Promise.all(outstanding), "the outstanding commands");
			for (const outcome of outcomes) expect(outcome).toMatch(/connection to the browser was lost/);
			const started = Date.now();
			await expect(browser.send("B.late")).rejects.toThrow(/connection to the browser was lost/);
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			await within(10_000, browser.close(), "close");
			await within(10_000, browser.close(), "a second close"); // idempotent from the caller's side
			await devtools.stop();
		}
	}, 30_000);

	it("a close frame is the same loss, and an answer already given still counts", async () => {
		const devtools = await endpoint();
		const browser = await launched(devtools, "closes");
		try {
			const socket = await devtools.connected;
			const answered = browser.send("A.answered");
			const waiting = browser.send("A.waiting").then(
				() => "resolved",
				(error: Error) => error.message,
			);
			for (let i = 0; i < 100 && devtools.received.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
			devtools.frame(socket, '{"id":1,"result":{"ok":true}}');
			expect(await within(5_000, answered, "the answered command")).toEqual({ ok: true });
			devtools.closeGracefully(socket);
			expect(await within(5_000, waiting, "the waiting command")).toMatch(/connection to the browser was lost/);
		} finally {
			await within(10_000, browser.close(), "close");
			await devtools.stop();
		}
	}, 30_000);

	it("a message that is not JSON, or answers nothing outstanding, is ignored rather than thrown from the socket", async () => {
		const devtools = await endpoint();
		const browser = await launched(devtools, "garbled");
		try {
			const socket = await devtools.connected;
			const waiting = browser.send("A.waiting").then(
				() => "resolved",
				(error: Error) => error.message,
			);
			for (let i = 0; i < 100 && devtools.received.length < 1; i += 1) await new Promise((r) => setTimeout(r, 20));
			devtools.frame(socket, "this is not json");
			devtools.frame(socket, '{"id":999,"result":{}}'); // nothing waits for it
			devtools.closeGracefully(socket);
			expect(await within(5_000, waiting, "the waiting command")).toMatch(/connection to the browser was lost/);
			devtools.frame(socket, '{"id":1,"result":{}}'); // too late: written after the loss, harmless
		} finally {
			await within(10_000, browser.close(), "close");
			await devtools.stop();
		}
	}, 30_000);

	it("an intentional close rejects what is waiting, says it was closed, and later commands fail the same way", async () => {
		const devtools = await endpoint();
		const browser = await launched(devtools, "intentional");
		try {
			await devtools.connected;
			const waiting = browser.send("A.waiting").then(
				() => "resolved",
				(error: Error) => error.message,
			);
			const closing = browser.close();
			expect(await within(5_000, waiting, "the waiting command")).toMatch(/browser was closed/);
			await within(10_000, closing, "close");
			await expect(browser.send("B.after")).rejects.toThrow(/browser was closed/);
			await within(10_000, browser.close(), "a second close");
		} finally {
			await within(10_000, browser.close(), "close");
			await devtools.stop();
		}
	}, 30_000);
});

describe("browser discovery does not wait on a candidate that never answers", () => {
	const script = (name: string, body: string): string => {
		const path = join(scratch, name);
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	};

	it("skips a stalled candidate within the bound and takes the next that answers", () => {
		const stalled = script("probe-stalled", "exec sleep 30");
		const working = script("probe-working", "echo 'Chromium 1'");
		const started = Date.now();
		expect(findBrowser({ candidates: [stalled, working], probeMs: 400 })).toBe(working);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("is not held by a wrapper whose helper keeps the output open after the wrapper itself is ended", () => {
		const wrapper = script("probe-wrapper", "(sleep 8) &\nwait"); // the helper outlives the wrapper and expires on its own
		const started = Date.now();
		expect(findBrowser({ candidates: [wrapper], probeMs: 400 })).toBeNull();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("rejects a candidate that fails, one that is missing and an empty one, and finds none", () => {
		const failing = script("probe-failing", "exit 3");
		expect(
			findBrowser({ candidates: [failing, join(scratch, "probe-missing"), "", undefined], probeMs: 400 }),
		).toBeNull();
	});

	it("keeps the order of the candidates: the first that answers wins", () => {
		const first = script("probe-first", "echo first");
		const second = script("probe-second", "echo second");
		expect(findBrowser({ candidates: [first, second], probeMs: 400 })).toBe(first);
	});
});
