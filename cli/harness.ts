/**
 * The `endo harness` commands: attach Endophasia to a harness the user installed (Pi in v0), inspect what is known
 * about it, and run checks. Each command prints one canonical-JSON document to stdout; a runtime-change notification
 * is also printed to stderr as plain text, so an operator sees it without reading JSON.
 *
 *   endo harness status   <root> [--attachment a]                       registry only, read-only; starts nothing
 *   endo harness identify <root> [selection]                            fingerprint and compare; starts no session
 *   endo harness check    <root> [selection] [--force]                  identify + automatic local checks
 *   endo harness study    <root> [selection] --authorize-live-study      the live study (agent work, provider cost)
 *   endo harness attach   <root> [selection] [--prompt text] [--wait ms] identify + local checks + record a session
 *
 * selection: [--attachment a] [--pi /path/to/pi] [--provider p --model m] [--tools a,b|none] [--cwd dir]
 *
 * None of these installs, updates, downgrades or replaces Pi.
 */

import { type PiAttachmentOptionsV0, PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { piVersionStandingV0 } from "../adapters/pi/version.ts";
import type { EndoHarnessNotificationV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";

interface ParsedV0 {
	root: string;
	flags: Map<string, string>;
	switches: Set<string>;
}

const VALUE_FLAGS = new Set([
	"--attachment",
	"--pi",
	"--provider",
	"--model",
	"--tools",
	"--cwd",
	"--prompt",
	"--wait",
]);
const SWITCHES = new Set(["--force", "--authorize-live-study"]);

function parse(argv: readonly string[], usage: string): ParsedV0 {
	const args = [...argv];
	const root = args.shift();
	if (root === undefined || root.startsWith("--")) throw new TypeError(usage);
	const flags = new Map<string, string>();
	const switches = new Set<string>();
	while (args.length > 0) {
		const flag = args.shift()!;
		if (SWITCHES.has(flag)) {
			switches.add(flag);
			continue;
		}
		if (!VALUE_FLAGS.has(flag)) throw new TypeError(`unknown flag ${flag}`);
		const value = args.shift();
		if (value === undefined) throw new TypeError(`the flag ${flag} needs a value`);
		flags.set(flag, value);
	}
	return { root, flags, switches };
}

function options(parsed: ParsedV0): PiAttachmentOptionsV0 {
	const tools = parsed.flags.get("--tools");
	if (parsed.flags.has("--provider") && !parsed.flags.has("--model"))
		throw new TypeError("--provider requires --model");
	return {
		root: parsed.root,
		...(parsed.flags.has("--attachment") ? { attachment: parsed.flags.get("--attachment")! } : {}),
		...(parsed.flags.has("--pi") ? { executable: parsed.flags.get("--pi")! } : {}),
		...(parsed.flags.has("--provider") ? { provider: parsed.flags.get("--provider")! } : {}),
		...(parsed.flags.has("--model") ? { model: parsed.flags.get("--model")! } : {}),
		...(parsed.flags.has("--cwd") ? { cwd: parsed.flags.get("--cwd")! } : {}),
		...(tools === undefined ? {} : { tools: tools === "none" ? "none" : tools.split(",") }),
	};
}

/** Print a notification to stderr as text. */
export function printNotificationV0(
	notification: EndoHarnessNotificationV0 | null,
	write = (text: string) => process.stderr.write(text),
): void {
	if (notification === null) return;
	write(`\n${notification.title}\n\n${notification.lines.map((line) => `  ${line}`).join("\n")}\n\n`);
}

function print(value: unknown): void {
	console.log(canonicalEndoJsonV0(JSON.parse(JSON.stringify(value))));
}

/**
 * `harness status <root> [--attachment a]` — the recorded identity, change, notice and capability state. The registry
 * is opened read-only: status creates no directory (an unknown attachment reports nothing recorded) and cuts nothing.
 */
export async function harnessStatusCommand(argv: readonly string[]): Promise<void> {
	const parsed = parse(argv, "usage: endo harness status <root> [--attachment a]");
	const registry = openEndoHarnessRegistryV0(parsed.root, parsed.flags.get("--attachment") ?? "pi.default", {
		readOnly: true,
	});
	const fingerprints = registry.list("fingerprint");
	const current = fingerprints.at(-1) ?? null;
	const previous =
		[...fingerprints].reverse().find((print) => print.identity.digest !== current?.identity.digest) ?? null;
	print({
		attachment: registry.attachment,
		recovery: registry.recovery(),
		current,
		versionStanding: current === null ? null : piVersionStandingV0(current.reported.version),
		previousDifferent: previous,
		lastChange: registry.last("change"),
		lastNotification: registry.last("notification"),
		capabilityState: registry.last("state"),
		evidenceRecords: registry.list("evidence").length,
	});
}

/** `harness identify <root> [selection]` — fingerprint the selected Pi and compare. */
export async function harnessIdentifyCommand(argv: readonly string[]): Promise<void> {
	const parsed = parse(argv, "usage: endo harness identify <root> [--pi path] [--attachment a]");
	const pi = new PiAttachmentV0(options(parsed));
	const identified = await pi.identify();
	printNotificationV0(identified.notification);
	print({ ...identified, state: pi.state() });
}

/** `harness check <root> [selection] [--force]` — identify and run the automatic local checks. */
export async function harnessCheckCommand(argv: readonly string[]): Promise<void> {
	const parsed = parse(argv, "usage: endo harness check <root> [--pi path] [--attachment a] [--force]");
	const pi = new PiAttachmentV0(options(parsed));
	const identified = await pi.identify();
	printNotificationV0(identified.notification);
	const checked = await pi.checkLocal({ force: parsed.switches.has("--force") });
	print({ change: identified.change, ran: checked.ran, state: checked.state });
}

/** `harness study <root> [selection] --authorize-live-study` — the live study, only with the explicit switch. */
export async function harnessStudyCommand(argv: readonly string[]): Promise<void> {
	const parsed = parse(
		argv,
		"usage: endo harness study <root> --authorize-live-study [--pi path] [--provider p --model m]",
	);
	if (!parsed.switches.has("--authorize-live-study")) {
		throw new TypeError(
			"the live study sends prompts, runs a read-only tool and calls the configured model provider, which may cost money; rerun with --authorize-live-study to authorize it",
		);
	}
	const pi = new PiAttachmentV0(options(parsed));
	const identified = await pi.identify();
	printNotificationV0(identified.notification);
	await pi.checkLocal();
	const studied = await pi.studyLive({ authorized: true });
	print({ change: identified.change, inconclusive: studied.inconclusive, state: studied.state });
}

/** `harness attach <root> [selection] [--prompt text] [--wait ms]` — record a session; optionally send one prompt. */
export async function harnessAttachCommand(argv: readonly string[]): Promise<void> {
	const parsed = parse(argv, "usage: endo harness attach <root> [--pi path] [--prompt text] [--wait ms]");
	const wait = parsed.flags.has("--wait") ? Number(parsed.flags.get("--wait")) : 120_000;
	if (!Number.isSafeInteger(wait) || wait < 0) throw new TypeError("--wait must be a non-negative integer");
	const pi = new PiAttachmentV0(options(parsed));
	const identified = await pi.identify();
	printNotificationV0(identified.notification);
	const checked = await pi.checkLocal();
	const session = await pi.openSession();
	let disposition: string | null = null;
	let settled: boolean | null = null;
	try {
		const prompt = parsed.flags.get("--prompt");
		if (prompt !== undefined) {
			disposition = await session.prompt(prompt);
			settled = await session.waitForSettled(wait);
		}
	} finally {
		await session.close();
	}
	print({
		change: identified.change,
		piSessionId: session.piSessionId,
		prompt: disposition === null ? null : { disposition, settled },
		counters: session.counters,
		state: checked.state,
	});
}

export const HARNESS_COMMANDS_V0: Readonly<Record<string, (argv: readonly string[]) => Promise<void>>> = {
	status: harnessStatusCommand,
	identify: harnessIdentifyCommand,
	check: harnessCheckCommand,
	study: harnessStudyCommand,
	attach: harnessAttachCommand,
};
