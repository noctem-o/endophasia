// Turns the raw captures of the study (kept OUTSIDE the repository, `<research-data>/dsh-native/raw/<case>/`) into the sanitised,
// committed fixtures under research/dsh-native/fixtures/real/. Deterministic: the same raw capture gives the same bytes.
//
//   node research/dsh-native/build-fixtures.ts [<raw-dir>]
//
// Each case holds `session.v4.jsonl.zstd` (the log DSH persisted), `stream.ndjson` (the headless `--json` stream) and, where an
// observer ran, `observer.ndjson` (the live `session/event` feed a passive Cordis plugin saw). The fixtures are the decoded and
// sanitised log, the sanitised stream, and `comparison.json`: the measured relationship between the three, which is the evidence.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { researchDataRoot } from "../data.ts";
import { encodeDshJsonl, readDshLog } from "./log.ts";
import { Sanitiser } from "./sanitise.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
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

const lines = (text: string): unknown[] =>
	text
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

/** The measured relationship between the persisted log, the live feed and the `--json` stream of one case. */
function compare(raw: string, name: string, events: { type: string }[]): Record<string, unknown> {
	let live: { type: string }[] | null = null;
	let frames: Record<string, number> = {};
	let flushes = 0;
	try {
		const observed = lines(readFileSync(join(raw, name, "observer.ndjson"), "utf8")) as {
			feed: string;
			event?: { type: string };
			kind?: string;
		}[];
		live = observed.filter((o) => o.feed === "session/event").map((o) => o.event!);
		flushes = observed.filter((o) => o.feed === "session/flush").length;
		for (const o of observed.filter((x) => x.feed === "agent/assistant-stream"))
			frames[o.kind ?? "?"] = (frames[o.kind ?? "?"] ?? 0) + 1;
	} catch {
		frames = {};
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
	const stream = lines(readFileSync(join(raw, name, "stream.ndjson"), "utf8")) as { type: string; phase?: string }[];
	return {
		persistedEvents: events.length,
		liveEvents: live?.length ?? null,
		liveEqualsPersisted: same,
		persistedIsPrefixOfLive: prefix,
		liveFirstSeq: offset,
		liveIsExactlyThePersistedSuffixFromThere: suffix,
		persistedEventsNeverAnnouncedLive: unannounced,
		liveOnlyTypes: live === null ? null : live.slice(events.length).map((e) => e.type),
		sessionFlushCallbacks: flushes,
		transientAssistantStreamFrames: frames,
		jsonStreamLines: stream.length,
		jsonStreamTypes: [...new Set(stream.map((l) => (l.type === "status" ? `status:${l.phase}` : l.type)))],
	};
}

export function buildFixtures(raw: string, out = FIXTURES): void {
	mkdirSync(out, { recursive: true });
	const home = homedir();
	const comparison: Record<string, unknown> = {};
	for (const name of CASES) {
		const sanitiser = new Sanitiser({
			paths: [
				{ prefix: join(researchDataRoot(), "dsh-native", "ws"), label: "workspace" },
				{ prefix: join(researchDataRoot(), "dsh-native"), label: "study" },
				{ prefix: home, label: "home" },
			],
			keepUserTexts: [STUDY_PROMPTS[name]],
			canaries: [],
		});
		const read = readDshLog(readFileSync(join(raw, name, "session.v4.jsonl.zstd")));
		if (read.header === null) throw new Error(`${name}: no header`);
		comparison[name] = compare(raw, name, read.events);
		const clean = sanitiser.sanitiseLog(read.header, read.events);
		writeFileSync(join(out, `${name}.events.jsonl`), encodeDshJsonl(clean.header, clean.events));
		const stream = lines(readFileSync(join(raw, name, "stream.ndjson"), "utf8")).map((line) =>
			sanitiser.sanitiseStreamLine(line),
		);
		writeFileSync(join(out, `${name}.stream.ndjson`), `${stream.map((line) => JSON.stringify(line)).join("\n")}\n`);
	}
	writeFileSync(join(out, "comparison.json"), `${JSON.stringify(comparison, null, "\t")}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	buildFixtures(process.argv[2] ?? join(researchDataRoot(), "dsh-native", "raw"));
