// Terminal-governed A/A operator command (research tooling; not part of the `endo` CLI or its package).
//
//   node research/governed-initial-continuation/aa/operate.ts --inspect /absolute/private-config.json
//   node research/governed-initial-continuation/aa/operate.ts --run     /absolute/private-config.json
//
//   --inspect  read-only. Validates the configuration and describes what --run would ask to approve. It starts no
//              server, no Pi and no study, binds no port, sends no request and writes nothing.
//   --run      interactive. Requires that stdin and stdout are the process's controlling terminal. Approvals are typed
//              there, one exact phrase per server launch and per turn. No flag, environment variable, file, default or
//              piped input is ever an approval, and there is no unattended or remote path.
//
// The configuration is one private owner-only file with every field explicit (see AaOperatorConfigV0). Like
// read-private.ts and inspect-linux.ts this is a research script: production `cli/` never imports `research/`.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline/promises";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import { readEndoDigestKeyV0 } from "../../../storage/digest-key.ts";
import {
	type AaTerminalV0,
	inspectAaV0,
	parseAaOperatorConfigV0,
	renderAaOutcomeV0,
	runAaOperatorV0,
} from "./operator.ts";

const USAGE =
	"usage: node research/governed-initial-continuation/aa/operate.ts (--inspect | --run) /absolute/private-config.json";
const CONFIG_MAX_BYTES = 16384;

/** The configuration is private by construction: owner-only, a regular file, never followed through a link. */
function readConfigFile(path: string): string {
	if (!isAbsolute(path)) throw new TypeError("the private configuration path must be absolute");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.size > CONFIG_MAX_BYTES ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0
		)
			throw new TypeError("configuration must be a private owner-only regular file of at most 16 KiB");
		return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
	} finally {
		closeSync(fd);
	}
}

/** A Linux dev_t as /proc/<pid>/stat spells a terminal number (the kernel's `new_encode_dev`). */
function kernelDeviceNumber(rdev: bigint): number {
	const major = ((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn);
	const minor = (rdev & 0xffn) | ((rdev >> 12n) & ~0xffn);
	return Number((minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n));
}
/**
 * Both ends must be this process's controlling terminal itself: a pipe, a file, a socket, or a terminal that is not
 * the one this session was started from (including any terminal when the process has none) is refused.
 */
function requireControllingTerminal(): void {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new TypeError(
			"--run needs a terminal on both stdin and stdout; approvals are never read from a pipe or a file",
		);
	let controlling: number;
	try {
		const stat = readFileSync("/proc/self/stat", "utf8");
		controlling = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]);
	} catch {
		throw new TypeError("--run needs a controlling terminal it can verify (Linux /proc)");
	}
	if (!Number.isSafeInteger(controlling) || controlling === 0)
		throw new TypeError("--run needs a controlling terminal");
	for (const fd of [0, 1])
		if (kernelDeviceNumber(fstatSync(fd, { bigint: true }).rdev) !== controlling)
			throw new TypeError("--run needs stdin and stdout to be the controlling terminal");
}

/** A readline over the controlling terminal. Closing it, for any reason, aborts `controller`. */
function openTerminal(controller: AbortController): AaTerminalV0 & { close(): void } {
	const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	const cancel = () => controller.abort();
	input.once("close", cancel);
	input.on("SIGINT", cancel);
	// A hung-up terminal can make writes fail with EIO/EPIPE; that must not kill the process before cleanup runs.
	process.stdout.on("error", cancel);
	return {
		write: (text) => {
			process.stdout.write(text);
		},
		ask: async (prompt, timeoutMs, signal) => {
			if (signal.aborted) return null;
			try {
				return await input.question(prompt, {
					signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
				});
			} catch {
				return null;
			}
		},
		close: () => {
			input.removeListener("close", cancel);
			input.removeListener("SIGINT", cancel);
			process.stdout.removeListener("error", cancel);
			input.close();
		},
	};
}

async function main(): Promise<void> {
	const [mode, path, ...extra] = process.argv.slice(2);
	if ((mode !== "--inspect" && mode !== "--run") || path === undefined || extra.length > 0 || path.startsWith("--"))
		throw new TypeError(USAGE);
	const config = parseAaOperatorConfigV0(readConfigFile(path));
	const key = readEndoDigestKeyV0(config.keyFile, (warning) => {
		throw new TypeError(warning);
	});
	if (mode === "--inspect") {
		process.stdout.write(
			canonicalEndoJsonV0({ mode: "inspect", effects: "none", requestsSent: 0, summary: inspectAaV0(config, key) }),
		);
		return;
	}
	requireControllingTerminal();
	const controller = new AbortController();
	// Handlers only abort. They stay installed through cleanup, so a second signal cannot skip the end record.
	const onSignal = () => controller.abort();
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	for (const name of signals) process.on(name, onSignal);
	const terminal = openTerminal(controller);
	try {
		const outcome = await runAaOperatorV0(config, key, terminal, controller.signal);
		terminal.write(renderAaOutcomeV0(outcome));
		process.exitCode = outcome.verdict === "complete-under-declared-assumptions" ? 0 : 1;
	} finally {
		terminal.close();
		for (const name of signals) process.removeListener(name, onSignal);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : "operator stopped"}\n`);
	process.exitCode = 1;
});
