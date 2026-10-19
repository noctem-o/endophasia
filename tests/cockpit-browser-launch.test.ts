// The browser driver's failure paths. A launch that fails has no `Browser` for the caller to close, so it must end the browser's
// process group and remove its profile itself, or the suite leaves a running process (and its pipe, which can keep CI waiting).
// These use stand-in executables, so they need no Chromium.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Browser } from "./cockpit-browser.ts";

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

	it("one that cannot be run at all: the launch fails and nothing is left or waited on", async () => {
		await expect(Browser.launch(join(scratch, "no-such-browser"), 5_000)).rejects.toThrow(/could not be started/);
	});
});
