/**
 * Capture and cassette replay (docs/replay.md).
 *
 *   endo proxy record --upstream <origin> --store <root> [--port n] [--fixture]
 *       A pass-through OpenAI-compatible proxy on 127.0.0.1 that records every exchange into <root>/capture/. Point
 *       Pi's models.json baseUrl at the printed origin + /v1. Runs until SIGINT or SIGTERM.
 *   endo proxy replay --store <root> --timing <as-recorded|immediate> --out <root> [--port n] [--fixture]
 *       Serves the cassette recorded in <root>/capture/ in order; misses are explicit. Runs until SIGINT or SIGTERM.
 *   endo replay <store> <session> --pi <path> --timing <as-recorded|immediate> [--out <root>] [--fixture]
 *       [--timeout-ms n] [--hold-ms n]
 *       Restore the recorded scratch root, start a fresh Pi against the cassette, drive the recorded steps, record into
 *       a new store and compare it with the original, layer by layer. Prints one canonical-JSON report.
 *
 * Digest domain: the installation key, unless --fixture names the committed public fixture key (for fixtures only;
 * its digests offer no secrecy). A cassette from another domain is refused with the reason. --timing has no default:
 * the choice is recorded.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import {
	type EndoCassetteTimingV0,
	loadEndoCassetteV0,
	startEndoCassetteServerV0,
} from "../adapters/openai-proxy/cassette.ts";
import { startEndoRecordingProxyV0 } from "../adapters/openai-proxy/record.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoFixtureDigestKeyPathV0 } from "../storage/digest-key.ts";
import {
	type PiCassetteKeySourceV0,
	piCassetteKeyV0,
	piCassetteSessionV0,
	replayPiCassetteSessionV0,
} from "./cassette-session.ts";

function parse(argv: readonly string[], valued: readonly string[], switches: readonly string[]) {
	const flags = new Map<string, string>();
	const on = new Set<string>();
	const positional: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (switches.includes(arg)) on.add(arg);
		else if (valued.includes(arg)) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) throw new TypeError(`the flag ${arg} needs a value`);
			flags.set(arg, value);
			index += 1;
		} else if (arg.startsWith("--")) throw new TypeError(`unknown flag ${arg}`);
		else positional.push(arg);
	}
	return { flags, on, positional };
}

function keySource(fixture: boolean): PiCassetteKeySourceV0 {
	return fixture ? { kind: "fixture", path: endoFixtureDigestKeyPathV0() } : { kind: "installation" };
}

function timingOf(value: string | undefined): EndoCassetteTimingV0 {
	if (value !== "as-recorded" && value !== "immediate")
		throw new TypeError("--timing must be chosen explicitly: as-recorded or immediate");
	return value;
}

function integer(value: string | undefined, flag: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new TypeError(`${flag} must be a non-negative integer`);
	return parsed;
}

function untilSignal(): Promise<void> {
	return new Promise((resolve) => {
		process.once("SIGINT", resolve);
		process.once("SIGTERM", resolve);
	});
}

/** `proxy record --upstream <origin> --store <root> [--port n] [--fixture]` */
export async function proxyRecordCommand(argv: readonly string[]): Promise<void> {
	const { flags, on, positional } = parse(argv, ["--upstream", "--store", "--port"], ["--fixture"]);
	const upstream = flags.get("--upstream");
	const store = flags.get("--store");
	if (positional.length > 0 || upstream === undefined || store === undefined)
		throw new TypeError("usage: endo proxy record --upstream <origin> --store <root> [--port n] [--fixture]");
	const log = new EndoCaptureLogV0(store, piCassetteKeyV0(keySource(on.has("--fixture"))), "record", {
		async: true,
	});
	const proxy = await startEndoRecordingProxyV0({ upstream, log, port: integer(flags.get("--port"), "--port", 0) });
	process.stderr.write(
		`recording ${proxy.origin} -> ${upstream} into ${store}/capture (point baseUrl at ${proxy.origin}/v1)\n`,
	);
	await untilSignal();
	await proxy.close();
	log.record("capture.stopped", {});
	log.close();
	process.stdout.write(canonicalEndoJsonV0({ listen: proxy.origin, store, keyId: log.key.keyId }));
}

/** `proxy replay --store <root> --timing <t> --out <root> [--port n] [--fixture]` */
export async function proxyReplayCommand(argv: readonly string[]): Promise<void> {
	const { flags, on, positional } = parse(argv, ["--store", "--timing", "--out", "--port"], ["--fixture"]);
	const store = flags.get("--store");
	const out = flags.get("--out");
	if (positional.length > 0 || store === undefined || out === undefined)
		throw new TypeError(
			"usage: endo proxy replay --store <root> --timing <as-recorded|immediate> --out <root> [--port n] [--fixture]",
		);
	const timing = timingOf(flags.get("--timing"));
	const key = piCassetteKeyV0(keySource(on.has("--fixture")));
	const cassette = loadEndoCassetteV0(store, key);
	const log = new EndoCaptureLogV0(out, key, "replay");
	const server = await startEndoCassetteServerV0({
		cassette,
		key,
		storeRoot: store,
		timing,
		log,
		port: integer(flags.get("--port"), "--port", 0),
	});
	process.stderr.write(`serving ${cassette.exchanges.length} exchange(s) at ${server.origin} (${timing})\n`);
	await untilSignal();
	await server.close();
	log.close();
	process.stdout.write(
		canonicalEndoJsonV0({
			listen: server.origin,
			served: server.served,
			misses: server.misses,
			unserved: server.remaining,
		}),
	);
}

/** `replay <store> <session> --pi <path> --timing <t> [--out <root>] [--fixture] [--timeout-ms n] [--hold-ms n]` */
export async function replayCommand(argv: readonly string[]): Promise<void> {
	const { flags, on, positional } = parse(
		argv,
		["--pi", "--timing", "--out", "--timeout-ms", "--hold-ms"],
		["--fixture"],
	);
	const pi = flags.get("--pi");
	if (positional.length !== 2 || pi === undefined)
		throw new TypeError(
			"usage: endo replay <store> <session> --pi <path> --timing <as-recorded|immediate> [--out <root>] [--fixture] [--timeout-ms n] [--hold-ms n]",
		);
	const [store, session] = positional as [string, string];
	const timing = timingOf(flags.get("--timing"));
	// Checked before anything starts: a replay of the wrong session would be wasted work.
	const wanted = session.startsWith("endo.session.pi.") ? session : `endo.session.pi.${session}`;
	const recorded = piCassetteSessionV0(store);
	if (recorded !== wanted)
		throw new TypeError(`the cassette in ${store} recorded ${recorded}, not ${wanted}; nothing was replayed`);
	const out = flags.get("--out") ?? mkdtempSync(join(tmpdir(), "endo-replay-"));
	const report = await replayPiCassetteSessionV0({
		store,
		out,
		pi,
		timing,
		keySource: keySource(on.has("--fixture")),
		timeoutMs: integer(flags.get("--timeout-ms"), "--timeout-ms", 300_000),
		holdMs: integer(flags.get("--hold-ms"), "--hold-ms", 30_000),
	});
	const layers = report.comparison.layers;
	process.stdout.write(
		canonicalEndoJsonV0({
			schemaVersion: "endo.replay-report.v0",
			session: report.session,
			timing,
			out,
			cassette: { served: report.served, misses: report.misses, unserved: report.unserved },
			layers: {
				lifecycle: layers.lifecycle.status,
				tools: layers.tools.status,
				outcome: layers.outcome.status,
				usage: layers.usage.status,
				timing: layers.timing.status,
			},
			flags: report.comparison.flags.map((flag) => flag.kind),
			notes: report.notes,
			comparison: report.comparison,
		}),
	);
}

export const PROXY_COMMANDS_V0: Record<string, (argv: readonly string[]) => Promise<void>> = {
	record: proxyRecordCommand,
	replay: proxyReplayCommand,
};
