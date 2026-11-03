// One operator-named check, run and observed (docs/designs/develop-verification-receipts.md): the single place a verification receipt's
// process is started. It runs EXACTLY the executable and arguments it is given (the caller takes them from the operator's command line and
// nowhere else), with no shell, in a process group this process owns (adapters/rpc-jsonl/process-group.ts: a keeper leads the group, so a
// group signal never reaches a reused group ID, and the keeper ends the group if this process dies).
//
//   stdin       closed at once (an empty pipe): a check cannot wait for input
//   output      passed through to the operator's sinks as it comes, never buffered whole, counted, never kept
//   time        `timeoutMs`; then SIGTERM to the group, and SIGKILL after `graceMs`
//   interrupt   the same, at once; a second interrupt skips the grace
//   end         when the command exits by itself, whatever of its group still runs is noted (`strayProcesses`) and killed
//   pipes       once the group is gone, the output pipes must close within `pipeWaitMs`; if they do not, a process outside the group
//               holds them (`escapedProcess`), and they are closed from this side
//
// It reports what it saw. It decides nothing about passing or failing (protocol/develop-receipts.ts does, from these facts and Git's).
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import type { EndoReceiptExecutionV0 } from "../../protocol/develop-receipts.ts";
import { ProcessGroupV0 } from "../rpc-jsonl/process-group.ts";

export interface CheckRunOptionsV0 {
	/** The path to spawn (already resolved by the caller) and the arguments after it. */
	executable: string;
	args: readonly string[];
	cwd: string;
	/** The check's complete environment. */
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
	maxOutputBytes: number;
	/** Where the check's stdout and stderr go as they come (the CLI sends both to its own stderr). */
	stdout: Writable;
	stderr: Writable;
	/** Aborted once: stop the check (SIGTERM, then SIGKILL after the grace). Aborted twice (`hurry`): SIGKILL at once. */
	interrupt?: AbortSignal;
	hurry?: AbortSignal;
	/** For tests. Defaults: 5 000 ms and 2 000 ms. */
	graceMs?: number;
	pipeWaitMs?: number;
}

export interface CheckRunResultV0 {
	execution: EndoReceiptExecutionV0;
	output: { stdoutBytes: number; stderrBytes: number };
	/** Null where it cannot be seen (no /proc): never "none" for "unknown". */
	strayProcesses: boolean | null;
	escapedProcess: boolean;
	/** From the spawn to the end of the group, on a monotonic clock. */
	durationMs: number;
}

type Stop = "timed-out" | "interrupted" | "output-limit";

export async function runCheckV0(options: CheckRunOptionsV0): Promise<CheckRunResultV0> {
	const graceMs = options.graceMs ?? 5_000;
	const pipeWaitMs = options.pipeWaitMs ?? 2_000;
	const started = performance.now();
	const group = new ProcessGroupV0(options.executable, options.args, {
		cwd: options.cwd,
		env: options.env,
		stderr: "pipe",
	});
	group.stdin?.on("error", () => {});
	group.stdin?.end();

	let stopped: Stop | null = null;
	/** Set once the command has exited: from then on nothing is stopped, and a late reason is never given to an ended check. */
	let finished = false;
	/** The output went over the limit, whenever that was. */
	let overLimit = false;
	let graceTimer: ReturnType<typeof setTimeout> | undefined;
	const stop = (why: Stop): void => {
		if (stopped !== null || finished) return;
		stopped = why;
		group.signalGroup("SIGTERM");
		graceTimer = setTimeout(() => group.killGroup(), graceMs);
	};
	const hurry = (): void => {
		if (finished) return;
		if (stopped === null) stopped = "interrupted";
		group.killGroup();
	};

	const counts = { stdoutBytes: 0, stderrBytes: 0 };
	const ended: Promise<void>[] = [];
	const paused = new Set<Readable>();
	/** Once the group is gone, nothing is held back: what is left in a pipe is drained at once, so a slow sink is never an escape. */
	let draining = false;
	// A sink that fails (the operator's terminal closed, a pipe reader went away) stops being written to; the check is still observed,
	// counted and recorded. Without a listener, its error would end this process with no receipt.
	const broken = new Set<Writable>();
	for (const sink of new Set([options.stdout, options.stderr]))
		sink.on("error", () => {
			broken.add(sink);
			for (const from of paused) from.resume();
			paused.clear();
		});
	const pump = (from: Readable | null, to: Writable, key: keyof typeof counts): void => {
		if (from === null) return;
		ended.push(
			new Promise<void>((resolve) => {
				from.on("end", resolve);
				from.on("close", resolve);
				from.on("error", () => resolve());
			}),
		);
		from.on("data", (chunk: Buffer) => {
			counts[key] += chunk.length;
			if (counts.stdoutBytes + counts.stderrBytes > options.maxOutputBytes) {
				// Over the limit at any time, also while the pipes drain after the group is gone (a process outside it still writing): the
				// check is stopped if it runs, its output is no longer read, and the receipt says so.
				overLimit = true;
				if (!finished) stop("output-limit");
				else {
					group.stdout?.destroy();
					group.stderr?.destroy();
				}
				return;
			}
			if (broken.has(to)) return;
			// Backpressure while the check runs: a slow terminal pauses the check's output rather than growing a buffer here.
			if (!to.write(chunk) && !draining) {
				from.pause();
				paused.add(from);
				to.once("drain", () => {
					paused.delete(from);
					from.resume();
				});
			}
		});
	};
	pump(group.stdout, options.stdout, "stdoutBytes");
	pump(group.stderr, options.stderr, "stderrBytes");

	const timeout = setTimeout(() => stop("timed-out"), options.timeoutMs);
	const onInterrupt = (): void => stop("interrupted");
	if (options.interrupt?.aborted === true) onInterrupt();
	options.interrupt?.addEventListener("abort", onInterrupt, { once: true });
	options.hurry?.addEventListener("abort", hurry, { once: true });

	const exit = await group.exited;
	clearTimeout(timeout);
	// What is still running in the group after the command exited by itself: noted (or "unknown" without /proc), then killed with the rest.
	const members = stopped === null && !exit.spawnFailed ? group.liveMembers() : false;
	const strayProcesses = members === undefined ? null : members;
	await group.release();
	finished = true;
	clearTimeout(graceTimer);
	draining = true;
	for (const from of paused) from.resume();
	paused.clear();
	const durationMs = Math.max(0, Math.round(performance.now() - started));
	options.interrupt?.removeEventListener("abort", onInterrupt);
	options.hurry?.removeEventListener("abort", hurry);

	// The group is gone. Pipes still open now are held by a process that left it.
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	const closed = await Promise.race([
		Promise.all(ended).then(() => true),
		new Promise<boolean>((resolve) => {
			waitTimer = setTimeout(() => resolve(false), pipeWaitMs);
		}),
	]);
	clearTimeout(waitTimer);
	if (!closed) {
		group.stdout?.destroy();
		group.stderr?.destroy();
	}

	const why = stopped as Stop | null;
	const execution: EndoReceiptExecutionV0 = exit.spawnFailed
		? { kind: "spawn-failed" }
		: why !== null
			? { kind: why }
			: overLimit
				? { kind: "output-limit" }
				: exit.code !== null
					? { kind: "exited", code: exit.code }
					: { kind: "signaled", signal: exit.signal ?? "SIGKILL" };
	return { execution, output: counts, strayProcesses, escapedProcess: !closed, durationMs };
}
