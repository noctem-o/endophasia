// Runs the path-sensitivity study (DESIGN.md §4, §9): one steering experiment per path, in a shuffled order, each into
// its own directory.
//
//   node research/path-sensitivity/1.0.1/run-paths.ts pilot <out dir>
//   node research/path-sensitivity/1.0.1/run-paths.ts main <paths> <out dir> [--seed n]
//
// `<out>/paths.json` records the seed, the shuffled order, and each path's scratch-root hash before anything runs. An
// interrupted run resumes: a finished path is skipped, an unfinished one is resumed by the runner. A path whose
// capability study does not admit steering (the run stops before any trial) is rerun once; if it stops again it is
// recorded as missing and the next path runs (DESIGN §9). Any other failure stops the driver.

import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEndoExperimentV0 } from "../../../cli/experiment.ts";
import type { EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { mulberry32V0, shuffleV0 } from "../../../runtime/contracts/statistics.ts";
import { EXCLUDED_PATHS, PILOT_LABELS, pathSpec, sampleLabels, scratchHashOf } from "./make-spec.ts";

export interface PathsRecordV0 {
	schemaVersion: "endo.path-sensitivity-paths.v0";
	kind: "pilot" | "main";
	seed: number;
	order: string[];
	hashes: Record<string, string>;
	excluded: readonly string[];
	missing: string[];
}

export interface RunPathsOptionsV0 {
	out: string;
	kind: "pilot" | "main";
	labels: readonly string[];
	seed?: number;
	/** The spec of a path. The default is the study's (make-spec.ts); a test may supply another. */
	makeSpec?: (label: string) => EndoExperimentSpecV0;
	scratchParent?: string;
	log?: (line: string) => void;
}

/** The record of a run's paths: read if it exists (a resume), otherwise written before any path runs. */
export function pathsRecordV0(options: RunPathsOptionsV0): PathsRecordV0 {
	const file = join(options.out, "paths.json");
	const makeSpec = options.makeSpec ?? ((label: string) => pathSpec(label));
	if (existsSync(file)) {
		const record = JSON.parse(readFileSync(file, "utf8")) as PathsRecordV0;
		if (JSON.stringify([...record.order].sort()) !== JSON.stringify([...options.labels].sort()))
			throw new TypeError(`${file} records other paths than ${options.labels.join(", ")}`);
		return record;
	}
	const hashes = Object.fromEntries(options.labels.map((label) => [label, scratchHashOf(makeSpec(label))]));
	const clash = Object.entries(hashes).find(([, hash]) =>
		EXCLUDED_PATHS.includes(hash as (typeof EXCLUDED_PATHS)[number]),
	);
	if (clash !== undefined)
		throw new TypeError(`path ${clash[0]} hashes to the excluded path ${clash[1]}; choose another label`);
	if (new Set(Object.values(hashes)).size !== options.labels.length) throw new TypeError("two paths hash alike");
	const seed = options.seed ?? randomBytes(4).readUInt32BE(0);
	const order = options.kind === "pilot" ? [...options.labels] : shuffleV0([...options.labels], mulberry32V0(seed));
	const record: PathsRecordV0 = {
		schemaVersion: "endo.path-sensitivity-paths.v0",
		kind: options.kind,
		seed,
		order,
		hashes,
		excluded: EXCLUDED_PATHS,
		missing: [],
	};
	mkdirSync(options.out, { recursive: true });
	writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
	return record;
}

export async function runPathsV0(options: RunPathsOptionsV0): Promise<PathsRecordV0> {
	const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
	const makeSpec = options.makeSpec ?? ((label: string) => pathSpec(label));
	const out = resolve(options.out);
	const record = pathsRecordV0({ ...options, out });
	const journal = (event: Record<string, unknown>) =>
		appendFileSync(
			join(out, "paths-journal.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
		);
	for (const [index, label] of record.order.entries()) {
		if (record.missing.includes(label)) continue;
		log(`path ${index + 1}/${record.order.length}: ${label} (scratch ${record.hashes[label]})`);
		journal({ event: "path-started", label, hash: record.hashes[label] });
		let attempts = 0;
		for (;;) {
			attempts += 1;
			try {
				const spec = makeSpec(label);
				const summary = await runEndoExperimentV0({
					spec,
					dir: join(out, label),
					// The study's specs are in the fixture domain (synthetic tasks); fixture mode must be explicit for them.
					fixtureExperiment: spec.digestDomain === "fixture",
					log: (line) => log(`  ${line}`),
					...(options.scratchParent === undefined ? {} : { scratchParent: options.scratchParent }),
				});
				journal({ event: "path-finished", label, ...summary });
				break;
			} catch (error) {
				const message = String((error as Error).message ?? error);
				// The only failure with a rule (DESIGN §9): the capability study did not admit steering.
				if (!/the live study did not admit/.test(message)) throw error;
				journal({ event: "path-capability-refused", label, attempt: attempts, message: message.slice(0, 400) });
				if (attempts >= 2) {
					record.missing.push(label);
					writeFileSync(join(out, "paths.json"), `${JSON.stringify(record, null, "\t")}\n`);
					log(`  ${label} is missing: its capability study did not admit steering twice`);
					break;
				}
				log(`  ${label}: capability study refused; rerunning once`);
			}
		}
	}
	return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [kind, ...rest] = process.argv.slice(2);
	const seedIndex = rest.indexOf("--seed");
	const seed = seedIndex === -1 ? undefined : Number(rest[seedIndex + 1]);
	const positional = rest.filter((entry, index) => entry !== "--seed" && index !== seedIndex + 1);
	const run = async () => {
		if (kind === "pilot" && positional.length === 1)
			return runPathsV0({
				out: positional[0]!,
				kind: "pilot",
				labels: [...PILOT_LABELS],
				...(seed === undefined ? {} : { seed }),
			});
		if (
			kind === "main" &&
			positional.length === 2 &&
			Number.isInteger(Number(positional[0])) &&
			Number(positional[0]) > 0
		)
			return runPathsV0({
				out: positional[1]!,
				kind: "main",
				labels: sampleLabels(Number(positional[0])),
				...(seed === undefined ? {} : { seed }),
			});
		throw new TypeError("usage: run-paths.ts pilot <out> | main <paths> <out> [--seed n]");
	};
	run().then(
		(record) =>
			process.stdout.write(
				`${JSON.stringify({ order: record.order, missing: record.missing, seed: record.seed }, null, "\t")}\n`,
			),
		(error: unknown) => {
			process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
			process.exit(1);
		},
	);
}
