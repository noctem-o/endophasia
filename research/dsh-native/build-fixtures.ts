// Turns the raw captures of the study (kept OUTSIDE the repository, `<research-data>/dsh-native/run-final/raw/<case>/`) into the sanitised,
// committed fixtures under research/dsh-native/fixtures/real/. Deterministic: the same raw capture gives the same bytes.
//
//   node research/dsh-native/build-fixtures.ts [<raw-dir> [<destination>]]
//
// Each case holds `session.v4.jsonl.zstd` (the log DSH persisted), `stream.ndjson` (the headless `--json` stream) and, where an
// observer ran, `observer.ndjson` (the live `session/event` feed a passive Cordis plugin saw). The fixtures are the decoded and
// sanitised log, the sanitised stream, and `comparison.json`: the measured relationship between the three, which is the evidence.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { endoSecretScanV0 } from "../../cli/secret-scan.ts";
import { researchDataRoot } from "../data.ts";
import { checkDshLog, dshLogAcceptable, encodeDshJsonl, readDshLog } from "./log.ts";
import { findLeaks, Sanitiser } from "./sanitise.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const DEFAULT_RAW = join(researchDataRoot(), "dsh-native", "run-final", "raw");
export const FIXTURES = join(HERE, "fixtures", "real");

export const STUDY_PROMPTS = {
	"tool-read":
		"Use the read tool to read the file notes.txt in the current directory, then reply with only the number of lines it contains.",
	"no-key-error":
		"Use the read tool to read the file notes.txt in the current directory, then reply with only the number of lines it contains.",
	"crash-killed": "Without using any tools, write the integers from 1 to 400 separated by commas, then stop.",
	"crash-resumed": "Reply with the single word: ok",
	"stub-retry": "hello",
} as const;

export const CASES = Object.keys(STUDY_PROMPTS) as (keyof typeof STUDY_PROMPTS)[];

const readUtf8 = (path: string): string =>
	new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));

const lines = (text: string): unknown[] =>
	text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/** The measured relationship between the persisted log, the live feed and the `--json` stream of one case. */
function compare(raw: string, name: string, events: { type: string }[]): Record<string, unknown> {
	let live: { type: string }[] | null = null;
	let frames: Record<string, number> | null = null;
	try {
		const observed = lines(readUtf8(join(raw, name, "observer.ndjson"))) as {
			feed: string;
			event?: { type: string };
			kind?: string;
		}[];
		frames = {};
		live = observed.filter((o) => o.feed === "session/event").map((o) => o.event!);
		for (const o of observed.filter((x) => x.feed === "agent/assistant-stream"))
			frames[o.kind ?? "?"] = (frames[o.kind ?? "?"] ?? 0) + 1;
	} catch (error) {
		// Missing observation is unknown, not zero. Malformed observation must not be disguised as missing.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const json = (value: unknown): string => JSON.stringify(value);
	const same = live === null ? null : live.length === events.length && json(live) === json(events);
	const prefix = live === null ? null : events.every((e, i) => json(e) === json(live[i]));
	// The live feed carries only what was appended after the observer attached. When it starts later than seq 0, say where, and
	// whether it is exactly the rest of the persisted log; the persisted events before it were never announced.
	const first = live === null || live.length === 0 ? null : (live[0] as { seq?: number }).seq;
	const offset = typeof first === "number" ? first : null;
	const suffix =
		live === null || offset === null
			? null
			: live.length === events.length - offset && live.every((e, i) => json(e) === json(events[offset + i]));
	const unannounced =
		live === null || offset === null || offset === 0
			? []
			: events.slice(0, offset).map((e) => `${(e as { seq?: number }).seq}:${e.type}`);
	const stream = lines(readUtf8(join(raw, name, "stream.ndjson"))) as { type: string; phase?: string }[];
	return {
		persistedEvents: events.length,
		liveEvents: live?.length ?? null,
		liveEqualsPersisted: same,
		persistedIsPrefixOfLive: prefix,
		liveFirstSeq: offset,
		liveIsExactlyThePersistedSuffixFromThere: suffix,
		persistedEventsNeverAnnouncedLive: unannounced,
		liveOnlyTypes: live === null ? null : live.slice(events.length).map((e) => e.type),
		transientAssistantStreamFrames: frames,
		jsonStreamLines: stream.length,
		jsonStreamTypes: [...new Set(stream.map((l) => (l.type === "status" ? `status:${l.phase}` : l.type)))],
	};
}

export function buildFixtures(raw: string, destination = FIXTURES): void {
	// Prepare every byte before opening the destination for mutation.
	const output = new Map<string, string>();
	const vocabulary = JSON.parse(readFileSync(join(HERE, "vocabulary.json"), "utf8"));
	const home = homedir();
	const comparison: Record<string, unknown> = {};
	for (const name of CASES) {
		// reproduce.ts lays a run out as <out>/<scenario>/{home,ws} beside <out>/raw/<case>/ (both crash cases share "crash").
		const runDir = dirname(raw);
		const scenarioDir = name.startsWith("crash") ? "crash" : name;
		const sanitiser = new Sanitiser({
			paths: [
				{ prefix: join(runDir, scenarioDir, "ws"), label: "workspace" },
				{ prefix: runDir, label: "study" },
				{ prefix: join(researchDataRoot(), "dsh-native"), label: "study" },
				{ prefix: home, label: "home" },
			],
			keepUserTexts:
				name === "crash-resumed" ? [STUDY_PROMPTS[name], STUDY_PROMPTS["crash-killed"]] : [STUDY_PROMPTS[name]],
			canaries: [],
		});
		const read = readDshLog(readFileSync(join(raw, name, "session.v4.jsonl.zstd")));
		if (
			read.header === null ||
			read.tail.kind !== "clean" ||
			read.problems.length > 0 ||
			!dshLogAcceptable(checkDshLog(read, vocabulary))
		)
			throw new Error(`${name}: capture is not clean valid evidence (${read.tail.kind}); raw bytes left untouched`);
		// Comparison includes raw type labels; pass it through the same path/id sanitiser and final privacy gate.
		comparison[name] = sanitiser.sanitiseStreamLine(compare(raw, name, read.events));
		const clean = sanitiser.sanitiseLog(read.header, read.events);
		const eventsText = encodeDshJsonl(clean.header, clean.events);
		const stream = lines(readUtf8(join(raw, name, "stream.ndjson"))).map((line) =>
			sanitiser.sanitiseStreamLine(line),
		);
		const streamText = `${stream.map((line) => JSON.stringify(line)).join("\n")}\n`;
		output.set(`${name}.events.jsonl`, eventsText);
		output.set(`${name}.stream.ndjson`, streamText);
	}
	output.set("comparison.json", `${JSON.stringify(comparison, null, "\t")}\n`);
	for (const [file, text] of output) {
		const leaks = [
			...findLeaks(text, [home, researchDataRoot(), "You are a coding agent"]),
			...endoSecretScanV0([{ where: file, text }], ["/fixture"]).findings.map((f) => f.kind),
		];
		if (leaks.length > 0) throw new Error(`${file} still leaks: ${leaks.join("; ")}`);
	}
	// Sibling staging keeps rename on one filesystem. On a publication error restore the previous complete directory.
	const target = resolve(destination);
	mkdirSync(dirname(target), { recursive: true });
	const staging = mkdtempSync(join(dirname(target), `.${basename(target)}-stage-`));
	const backup = join(staging, "previous");
	const ready = join(staging, "ready");
	try {
		mkdirSync(ready);
		for (const [file, text] of output) writeFileSync(join(ready, file), text);
		const hadPrevious = existsSync(target);
		if (hadPrevious) renameSync(target, backup);
		try {
			renameSync(ready, target);
		} catch (error) {
			if (hadPrevious) renameSync(backup, target);
			throw error;
		}
	} finally {
		// If rollback itself failed, retain the backup for recovery.
		if (!existsSync(backup) || existsSync(target)) rmSync(staging, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	buildFixtures(process.argv[2] ?? DEFAULT_RAW, process.argv[3] ?? FIXTURES);
