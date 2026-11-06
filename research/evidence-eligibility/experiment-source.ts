// Reading one experiment run directory for the eligibility projection: read-only, through the runner's own version-directed readers
// (cli/experiment-artifacts.ts), which refuse an unknown version, a malformed record or a result that is not its plan entry's. Nothing
// here writes, creates or migrates anything; a refusal is reported as a source problem and the record is left out, never guessed at.
//
// Only facts are collected here. Whether a trial is eligible for anything is decided in eligibility.ts.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	readEndoExperimentPlanFileV0,
	readEndoExperimentPlannedTrialV0,
	readEndoExperimentRunRecordFileV0,
} from "../../cli/experiment-artifacts.ts";
import type {
	EndoExperimentRunRecordV0,
	EndoExperimentTrialKeyV0,
	EndoExperimentTrialResultAnyV0,
} from "../../protocol/experiment-artifacts.ts";
import { EndoSchemaVersionErrorV0 } from "../../protocol/versioned.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import {
	ENDO_FIXTURE_DIGEST_KEYS_V0,
	endoFixtureDigestKeyPathV0,
	loadEndoFixtureDigestKeyV0,
} from "../../storage/digest-key.ts";
import type { DecisionFeatures, SourceProblem } from "./contract.ts";

/** What one trial's records say, before any eligibility rule. */
export interface TrialFacts {
	entry: EndoExperimentTrialKeyV0;
	/** Relative to the run directory. */
	path: string;
	kind: "result" | "interrupted";
	result: EndoExperimentTrialResultAnyV0 | null;
	recordSha256: string;
	schemaVersion: string;
	store: boolean;
	capture: boolean;
	checkOutput: "verified" | "mismatch" | "absent" | "unverifiable" | "unreadable" | "not-applicable";
	/** Failing checks the verified output names, only under a public fixture key; null when not read. */
	symptoms: string[] | null;
	/** How many distinct tests the verified output names (failing and passing); null when not read. */
	checksNamed: number | null;
	/** How many of them failed: counted from the whole output, before the symptom list is bounded. */
	checksFailed: number | null;
	symptomsWithheld: boolean;
	harness: { name: string; version: string | null; identityDigest: string | null } | null;
	wireModels: string[] | null;
}

export interface RunFacts {
	record: EndoExperimentRunRecordV0;
	files: Record<string, string>;
	trials: TrialFacts[];
	problems: Omit<SourceProblem, "sourceId">[];
	conditions: number;
}

const sha256File = (path: string): string => sha256HexV0(readFileSync(path));
const isDirectory = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isDirectory() === true;
const nonEmptyDirectory = (path: string): boolean => isDirectory(path) && readdirSync(path).length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What could be known when the trial's condition was assigned: the run record and the trial's plan entry, and nothing else. It takes no
 * result on purpose, so no later fact (the check, the exchanges, the end time) can enter a decision-time feature.
 */
export function decisionOfTrial(run: EndoExperimentRunRecordV0, entry: EndoExperimentTrialKeyV0): DecisionFeatures {
	const condition = run.spec.conditions.find((c) => c.id === entry.condition);
	return {
		kind: "condition-assignment",
		mechanism: "blocked-randomization",
		seed: run.seed,
		ordering: run.ordering,
		specSha256: run.specSha256,
		position: entry.position,
		task: entry.task,
		condition: entry.condition,
		conditionSha256: condition === undefined ? "" : sha256HexV0(canonicalEndoJsonV0(condition)),
		trial: entry.trial,
	};
}

const keyCache = new Map<string, EndoDigestKeyV0 | null>();
/** A committed public fixture key by its domain name, or null: an installation key is never loaded by this projection. */
function fixtureKey(keyId: string): EndoDigestKeyV0 | null {
	if (!keyCache.has(keyId))
		keyCache.set(
			keyId,
			keyId in ENDO_FIXTURE_DIGEST_KEYS_V0 ? loadEndoFixtureDigestKeyV0(endoFixtureDigestKeyPathV0(keyId)) : null,
		);
	return keyCache.get(keyId) ?? null;
}

const SHOWN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;
const MAX_SYMPTOMS = 50;
const MAX_SYMPTOM = 200;

/**
 * The failing tests a check's output names: node:test's `✖ name` lines (durations removed) and TAP's `not ok N - name`. Each name is data:
 * bounded, with control and bidirectional characters replaced, never interpreted. A failed check that names none is `check-failed-unnamed`.
 */
export function failingChecks(output: string, passed: boolean): string[] {
	const list = [...namedChecks(output).failing].sort().slice(0, MAX_SYMPTOMS);
	return !passed && list.length === 0 ? ["check-failed-unnamed"] : list;
}

/** Every test a check's output names, by result: node:test's `✔`/`✖` lines and TAP's `ok`/`not ok` lines, bounded and neutralised. */
export function namedChecks(output: string): { failing: Set<string>; passing: Set<string> } {
	const failing = new Set<string>();
	const passing = new Set<string>();
	const shown = (name: string) => {
		const s = name.replace(SHOWN, "\ufffd");
		return s.length > MAX_SYMPTOM ? `${s.slice(0, MAX_SYMPTOM - 1)}…` : s;
	};
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		const node = /^([✖✔]) (.+?)(?: \([0-9.]+m?s\))?$/.exec(line);
		if (node !== null && node[2] !== "failing tests:")
			(node[1] === "✖" ? failing : passing).add(shown(node[2] as string));
		const tap = /^(not ok|ok) [0-9]+ - (.+)$/.exec(line);
		if (tap !== null) (tap[1] === "not ok" ? failing : passing).add(shown(tap[2] as string));
	}
	for (const f of failing) passing.delete(f);
	return { failing, passing };
}

/** The run's sessions, from its journal: which run session each trial last started in. Unversioned; read only for this mapping. */
function sessionsOf(dir: string): { trial: Map<string, number>; moved: Map<string, EndoExperimentTrialKeyV0> } {
	const trial = new Map<string, number>();
	const moved = new Map<string, EndoExperimentTrialKeyV0>();
	const path = join(dir, "journal.jsonl");
	if (!existsSync(path)) return { trial, moved };
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			!isObject(e) ||
			typeof e.task !== "string" ||
			typeof e.condition !== "string" ||
			!Number.isSafeInteger(e.trial)
		)
			continue;
		const key = `${e.task}/${e.condition}/${e.trial}`;
		if (e.event === "trial-started" && Number.isSafeInteger(e.session)) trial.set(key, e.session as number);
		if (e.event === "trial-interrupted" && typeof e.movedTo === "string" && Number.isSafeInteger(e.position))
			moved.set(e.movedTo, {
				position: e.position as number,
				task: e.task,
				condition: e.condition,
				trial: e.trial as number,
			});
	}
	return { trial, moved };
}

/** The Pi identity a run session recorded (environment/session-<n>.json, unversioned), or null when it reported none. */
function harnessOf(dir: string, session: number | undefined): TrialFacts["harness"] {
	const envDir = join(dir, "environment");
	let file: string | null = null;
	if (session !== undefined && existsSync(join(envDir, `session-${session}.json`)))
		file = join(envDir, `session-${session}.json`);
	// The sole session file stands in only when the trial's session is unknown: a known session without its file is not another's.
	else if (session === undefined && isDirectory(envDir)) {
		const all = readdirSync(envDir).filter((n) => /^session-[0-9]+\.json$/.test(n));
		if (all.length === 1) file = join(envDir, all[0] as string);
	}
	if (file === null) return null;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
	if (!isObject(value) || !isObject(value.pi) || value.pi.status !== "reported" || !isObject(value.pi.value))
		return null;
	const pi = value.pi.value;
	return {
		name: "pi",
		version: typeof pi.version === "string" ? pi.version : null,
		identityDigest: typeof pi.identityDigest === "string" ? pi.identityDigest : null,
	};
}

function wireModelsOf(result: EndoExperimentTrialResultAnyV0): string[] | null {
	const seen: string[] = [];
	const add = (m: unknown) => {
		const v = typeof m === "string" ? m : isObject(m) && typeof m.value === "string" ? m.value : null;
		if (v !== null && !seen.includes(v)) seen.push(v);
	};
	if (result.schemaVersion === "endo.experiment-trial.v0") {
		for (const p of result.requestParameters) if (isObject(p)) add(p.model);
	} else for (const s of result.harness.surfaces) add((s as unknown as Record<string, unknown>).model);
	return seen;
}

/** A filesystem probe that reports failure as false, never as an exception that would end the whole corpus. */
const probe = (f: () => boolean): boolean => {
	try {
		return f();
	} catch {
		return false;
	}
};

function contentOf(trialDir: string, result: EndoExperimentTrialResultAnyV0 | null) {
	const store = probe(() => isDirectory(join(trialDir, "store")));
	const capture = probe(
		() =>
			nonEmptyDirectory(join(trialDir, "store", "capture", "events")) &&
			nonEmptyDirectory(join(trialDir, "store", "capture", "blobs")),
	);
	let problem: string | null = null;
	let checkOutput: TrialFacts["checkOutput"] = "not-applicable";
	let symptoms: string[] | null = null;
	let checksNamed: number | null = null;
	let checksFailed: number | null = null;
	let symptomsWithheld = false;
	if (result !== null && result.status === "completed" && result.check.ran) {
		const out = join(trialDir, "check.txt");
		const digest = result.check.output;
		let stat: ReturnType<typeof lstatSync> | undefined;
		let statFailed = false;
		try {
			stat = lstatSync(out, { throwIfNoEntry: false });
		} catch {
			statFailed = true;
		}
		if (statFailed) {
			checkOutput = "unreadable";
			problem = "the check output could not be examined";
		} else if (stat === undefined) checkOutput = "absent";
		else if (!stat.isFile()) {
			// A directory, link, device or other non-file where the output should be: not that trial's output, and not read.
			checkOutput = "unreadable";
			problem = "the check output is not a regular file";
		} else {
			const key = fixtureKey(digest.keyId);
			let bytes: Buffer | null = null;
			if (key !== null)
				try {
					bytes = readFileSync(out);
				} catch {
					problem = "the check output could not be read";
				}
			if (key === null) {
				checkOutput = "unverifiable";
				symptomsWithheld = true;
			} else if (bytes === null) checkOutput = "unreadable";
			else {
				const matches = bytes.length === digest.bytes && key.digestBytes(bytes).value === digest.value;
				checkOutput = matches ? "verified" : "mismatch";
				if (matches) {
					const text = bytes.toString("utf8");
					symptoms = failingChecks(text, result.check.passed);
					const named = namedChecks(text);
					checksNamed = named.failing.size + named.passing.size;
					checksFailed = named.failing.size;
				}
			}
		}
	}
	return { content: { store, capture, checkOutput, symptoms, checksNamed, checksFailed, symptomsWithheld }, problem };
}

/** Every file under a directory, by relative path, with its size and sha256: links are listed, never followed. */
function filesOf(dir: string): [string, number, string][] {
	const out: [string, number, string][] = [];
	const walk = (d: string, prefix: string) => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const s = lstatSync(p);
			if (s.isDirectory()) walk(p, `${prefix}${name}/`);
			else out.push([`${prefix}${name}`, s.size, s.isFile() ? sha256File(p) : "not-a-file"]);
		}
	};
	walk(dir, "");
	return out;
}

const problemOf = (path: string, error: unknown): Omit<SourceProblem, "sourceId"> => ({
	path,
	kind:
		error instanceof EndoSchemaVersionErrorV0
			? error.kind === "unsupported-version" || error.kind === "missing-version"
				? "unsupported-version"
				: "refused"
			: "unreadable",
	detail: error instanceof Error ? error.message.slice(0, 300) : "unreadable",
});

/** Every trial of one run directory, read now; null with a problem when the run record or plan is not acceptable. */
export function readExperimentRun(dir: string): RunFacts | { problem: Omit<SourceProblem, "sourceId"> } {
	let record: EndoExperimentRunRecordV0;
	let plan: ReturnType<typeof readEndoExperimentPlanFileV0>["plan"];
	try {
		record = readEndoExperimentRunRecordFileV0(dir);
		plan = readEndoExperimentPlanFileV0(dir).plan;
	} catch (error) {
		return { problem: problemOf(existsSync(join(dir, "experiment.json")) ? "plan.json" : "experiment.json", error) };
	}
	const files: Record<string, string> = {
		"experiment.json": sha256File(join(dir, "experiment.json")),
		"plan.json": sha256File(join(dir, "plan.json")),
	};
	const { trial: sessions, moved } = sessionsOf(dir);
	const problems: Omit<SourceProblem, "sourceId">[] = [];
	const trials: TrialFacts[] = [];
	let unrun = 0;
	const entries = [...plan.order].sort((a, b) => a.position - b.position);
	for (const entry of entries) {
		const rel = `trials/${entry.task}/${entry.condition}/${entry.trial}`;
		let result: EndoExperimentTrialResultAnyV0 | null;
		try {
			result = readEndoExperimentPlannedTrialV0(dir, entry);
		} catch (error) {
			problems.push(problemOf(`${rel}/result.json`, error));
			continue;
		}
		if (result === null) {
			unrun += 1;
			continue;
		}
		const { content, problem } = contentOf(join(dir, rel), result);
		if (problem !== null) problems.push({ path: `${rel}/check.txt`, kind: "unreadable", detail: problem });
		trials.push({
			entry,
			path: rel,
			kind: "result",
			result,
			recordSha256: sha256File(join(dir, rel, "result.json")),
			schemaVersion: result.schemaVersion,
			...content,
			harness: harnessOf(dir, sessions.get(`${entry.task}/${entry.condition}/${entry.trial}`)),
			wireModels: wireModelsOf(result),
		});
	}
	// Planned trials the copy holds no result for (never run, or not kept in this copy): counted, not guessed at.
	if (unrun > 0)
		problems.push({
			path: "trials",
			kind: "missing",
			detail: `${unrun} of ${entries.length} planned trials have no result`,
		});
	// Interrupted executions: kept by the runner, never counted. Their coordinates come from the journal's record of the move.
	const aside = join(dir, "interrupted");
	if (isDirectory(aside))
		for (const name of readdirSync(aside).sort()) {
			const rel = `interrupted/${name}`;
			const entry = moved.get(rel);
			if (entry === undefined) {
				problems.push({
					path: rel,
					kind: "problem-file",
					detail: "interrupted execution the journal does not name",
				});
				continue;
			}
			const { content } = contentOf(join(aside, name), null);
			let files: [string, number, string][];
			try {
				files = filesOf(join(aside, name));
			} catch {
				problems.push({ path: rel, kind: "unreadable", detail: "interrupted execution could not be read" });
				continue;
			}
			// Its own session (the runner names the directory `…-session-<n>`), not the rerun's; its identity is its files, not its name.
			const session = /-session-([0-9]+)$/.exec(name);
			trials.push({
				entry,
				path: rel,
				kind: "interrupted",
				result: null,
				recordSha256: sha256HexV0(canonicalEndoJsonV0({ movedTo: rel, ...entry, files })),
				schemaVersion: "interrupted",
				...content,
				harness: harnessOf(dir, session === null ? undefined : Number(session[1])),
				wireModels: null,
			});
		}
	return { record, files, trials, problems, conditions: record.spec.conditions.length };
}
