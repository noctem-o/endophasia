// Bubblewrap's launch window (containers/bubblewrap#633; 0.13.1 affected), reproduced deliberately: a process is STRANDED on purpose.
//
// NOT run by default, and not on an operator's workstation. It runs only where ENDO_DISPOSABLE_STRANDED_TEST=1 is set, in a separately
// authorised, disposable environment (a throwaway VM or container with its own systemd user manager). Its cleanup does not depend on
// this test: the scope carries RuntimeMaxSec=20, so the user manager ends it after 20 seconds whatever happens here, and the test also
// stops it in `finally`.
//
// How it targets the window (bubblewrap.c at v0.13.1): the launcher writes its JSON status (line ~3170) and then, with
// --userns-block-fd, blocks reading that fd (~3176) BEFORE it releases the sandbox's first process through `child_wait_fd` (~3185). That
// process is meanwhile blocked in `read (child_wait_fd)` (~3238), before it arms its own parent-death signal (~3535). Holding the block
// fd open and never writing it keeps the launcher inside exactly that interval. The test then SIGKILLs the launcher and asserts the
// stranded state that characterises the window (alive, reparented, blocked on an eventfd read), before showing that stopping the
// sandbox's scope ends it.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectBubblewrapV0 } from "../adapters/sandbox/bubblewrap.ts";
import {
	detectContainmentV0,
	newScopeUnitV0,
	processInScopeV0,
	scopeArgsV0,
	stopScopeV0,
} from "../adapters/sandbox/containment.ts";

const authorised = process.env.ENDO_DISPOSABLE_STRANDED_TEST === "1";
const bwrap = authorised ? detectBubblewrapV0() : null;
const contained = authorised && bwrap?.ok === true ? await detectContainmentV0() : null;

const procState = (pid: number) => {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { alive: true, ppid: Number(fields[1]), wchan: readFileSync(`/proc/${pid}/wchan`, "utf8") };
	} catch {
		return { alive: false, ppid: -1, wchan: "" };
	}
};

describe.runIf(authorised && bwrap?.ok === true && contained?.ok === true)(
	"bubblewrap's launch window (#633), disposable environment only",
	() => {
		it("strands the sandbox's first process by killing the launcher inside the window, and stopping the scope ends it", async () => {
			if (bwrap?.ok !== true || contained?.ok !== true) throw new Error("unreachable");
			const c = contained.containment;
			const unit = newScopeUnitV0();
			const opts = [
				"--unshare-all",
				"--unshare-user",
				"--die-with-parent",
				"--new-session",
				"--clearenv",
				"--ro-bind",
				"/usr",
				"/usr",
				"--symlink",
				"usr/lib",
				"/lib",
				"--symlink",
				"usr/lib64",
				"/lib64",
				"--json-status-fd",
				"3",
				"--userns-block-fd",
				"5",
			];
			// The independent deadline: RuntimeMaxSec=20 on the scope itself.
			const launcher = spawn(
				c.systemdRun,
				scopeArgsV0(c, unit, 20, [bwrap.bwrap.path, "--args", "4", "--", "/usr/bin/sleep", "1000"]),
				{
					env: c.env,
					stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
				},
			);
			(launcher.stdio[4] as NodeJS.WritableStream).end(Buffer.from(`${opts.join("\0")}\0`));
			let status = "";
			(launcher.stdio[3] as NodeJS.ReadableStream).on("data", (b: Buffer) => {
				status += b.toString("utf8");
			});
			try {
				for (let i = 0; i < 200 && !/"child-pid"/.test(status); i++) await new Promise((r) => setTimeout(r, 25));
				const child = Number(/"child-pid":\s*([0-9]+)/.exec(status)?.[1]);
				expect(child).toBeGreaterThan(0);
				expect(processInScopeV0(launcher.pid as number, unit)).toBe(true);
				// Inside the window: the launcher is blocked on the block fd, the child on child_wait_fd (an eventfd read).
				expect(procState(child).wchan).toMatch(/eventfd/);
				process.kill(launcher.pid as number, "SIGKILL");
				await new Promise((r) => setTimeout(r, 500));
				// Stranded: alive, reparented away from the dead launcher, still blocked on the eventfd that nothing will ever write.
				const stranded = procState(child);
				expect(stranded.alive).toBe(true);
				expect(stranded.ppid).not.toBe(launcher.pid);
				expect(stranded.wchan).toMatch(/eventfd/);
				// The containment ends it: the user manager stops the scope, and the process is gone.
				expect(await stopScopeV0(c, unit)).toBe("confirmed");
				expect(procState(child).alive).toBe(false);
			} finally {
				launcher.kill("SIGKILL");
				await stopScopeV0(c, unit);
			}
		}, 60_000);
	},
);
