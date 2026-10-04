// Replay committed cassette fixtures against a real Pi, repeatedly, and report each replay's per-layer verdict.
//
//   node scripts/replay-cassette-fixtures.ts --pi "$(command -v pi)" [--dir research/pi-conformance/1.0.1/cassettes]
//     [--times 5] [--timings as-recorded,immediate] [--sessions a,b] [--out results.json] [--timeout-ms 300000]
//
// Each replay materializes the fixture into a fresh scratch store, restores the recorded scratch root at its recorded
// path, serves the cassette on the recorded port, drives a fresh Pi through the recorded steps, and compares the new
// store with the recording (docs/replay.md). Replays run one at a time (they share the recorded path and port). No
// model is called: a request the cassette does not hold is a miss, never forwarded.

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readEndoCaptureEventsV0 } from "../adapters/openai-proxy/capture-log.ts";
import type { EndoCassetteTimingV0 } from "../adapters/openai-proxy/cassette.ts";
import { materializePiCassetteFixtureV0 } from "../cli/cassette-fixture.ts";
import { replayPiCassetteSessionV0 } from "../cli/cassette-session.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoFixtureDigestKeyPathV0 } from "../storage/digest-key.ts";
import { PI_CONFORMANCE_DIRECTORY } from "./record-lifecycle-fixture.ts";

export interface PiReplayRowV0 {
	session: string;
	timing: EndoCassetteTimingV0;
	run: number;
	lifecycle: string;
	tools: string;
	outcome: string;
	usage: string;
	timingLayer: string;
	flags: string[];
	served: number;
	misses: number;
	unserved: number;
	missReasons: string[];
	notes: string[];
	/** For a judged layer that is not EXACT: its verdict. */
	details: Record<string, unknown>;
	comparisonDigest: string;
	wallMsDelta: number | null;
}

export async function replayPiCassetteFixturesV0(options: {
	pi: string;
	dir: string;
	times: number;
	timings: readonly EndoCassetteTimingV0[];
	sessions: readonly string[] | null;
	timeoutMs: number;
	log?: (line: string) => void;
}): Promise<PiReplayRowV0[]> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const names = readdirSync(options.dir)
		.filter((name) => statSync(join(options.dir, name)).isDirectory())
		.filter((name) => options.sessions === null || options.sessions.includes(name))
		.sort();
	const rows: PiReplayRowV0[] = [];
	for (const name of names) {
		for (const timing of options.timings) {
			for (let run = 1; run <= options.times; run += 1) {
				const scratch = mkdtempSync(join(tmpdir(), "endo-replay-run-"));
				try {
					const store = materializePiCassetteFixtureV0(join(options.dir, name), join(scratch, "recorded"));
					const out = join(scratch, "replayed");
					const report = await replayPiCassetteSessionV0({
						store,
						out,
						pi: options.pi,
						timing,
						keySource: { kind: "fixture", path: endoFixtureDigestKeyPathV0() },
						timeoutMs: options.timeoutMs,
						holdMs: 30_000,
					});
					const layers = report.comparison.layers;
					const details: Record<string, unknown> = {};
					for (const layer of ["lifecycle", "tools", "outcome"] as const)
						if (layers[layer].status !== "EXACT") details[layer] = layers[layer];
					const misses = readEndoCaptureEventsV0(out)
						.filter((event) => event.kind === "capture.cassette-miss")
						.map((event) => String((event.payload as { reason?: unknown }).reason));
					const row: PiReplayRowV0 = {
						session: name,
						timing,
						run,
						lifecycle: layers.lifecycle.status,
						tools: layers.tools.status,
						outcome: layers.outcome.status,
						usage: layers.usage.status,
						timingLayer: layers.timing.status,
						flags: report.comparison.flags.map((flag) => flag.kind),
						served: report.served,
						misses: report.misses,
						unserved: report.unserved,
						missReasons: misses,
						notes: report.notes,
						details,
						comparisonDigest: report.comparison.digest,
						wallMsDelta: layers.timing.status === "DELTAS" ? layers.timing.totals.wallMs : null,
					};
					rows.push(row);
					log(
						`${name} ${timing} #${run}: lifecycle ${row.lifecycle}, tools ${row.tools}, outcome ${row.outcome}; served ${row.served}, misses ${row.misses}, unserved ${row.unserved}${row.flags.length ? `; flags ${row.flags.join(",")}` : ""}${row.notes.length ? `; notes: ${row.notes.join("; ")}` : ""}`,
					);
				} finally {
					rmSync(scratch, { recursive: true, force: true });
				}
			}
		}
	}
	return rows;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	const flag = (name: string) => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};
	const pi = flag("--pi");
	if (pi === undefined) {
		process.stderr.write("--pi is required\n");
		process.exit(2);
	}
	const timings = (flag("--timings") ?? "as-recorded,immediate").split(",") as EndoCassetteTimingV0[];
	replayPiCassetteFixturesV0({
		pi,
		dir: resolve(flag("--dir") ?? join(PI_CONFORMANCE_DIRECTORY, "1.0.1", "cassettes")),
		times: Number(flag("--times") ?? "5"),
		timings,
		sessions: flag("--sessions")?.split(",") ?? null,
		timeoutMs: Number(flag("--timeout-ms") ?? "300000"),
	}).then(
		(rows) => {
			const out = flag("--out");
			if (out !== undefined)
				writeFileSync(out, canonicalEndoJsonV0({ schemaVersion: "endo.replay-results.v0", rows }));
			process.stderr.write("done\n");
		},
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
