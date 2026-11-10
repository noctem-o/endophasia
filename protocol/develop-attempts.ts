// DEVELOP work attempts (docs/designs/develop-work-attempts.md): one operator-prepared request on one task, the brief rendered from it, and
// the operator's own notes of a handoff and of an outcome. Three closed record kinds, each in its own file under `<root>/develop/attempts/`,
// each written ONCE and never rewritten (storage/develop-attempts.ts):
//
//   <id>.prepared.json   endo.develop-attempt.v0           the request: the task's words as they were, objective, constraints, report-back
//   <id>.handoff.json    endo.develop-attempt-handoff.v0   "I gave it to <target>": the operator's statement, not proof anyone read it
//   <id>.outcome.json    endo.develop-attempt-outcome.v0   "this was reported" or "I stopped": the operator's statement, never verified
//
// An attempt is not a process, a session, a lease, an approval or a result. Nothing here sends anything, reads an agent's reply, or changes a
// task: the task file is not written by anything that uses this module, and its status moves only by the operator's own task commands.
// State is DERIVED from which records exist; there is no "done" and no claim of success. The brief is a pure function of the prepared record
// alone, so every caller (the CLI, the workbench route) shows the same bytes, whatever has happened to the task file since.
//
// What is never stored here: a transcript, model output, a prompt sent to a model, a session handle, a path, a credential.

import type { EndoDevelopAttemptExecutionViewV0 } from "./develop-attempt-execution.ts";
import type { EndoAttemptProvenanceViewV0 } from "./develop-provenance.ts";
import type { EndoDevelopReceiptViewV0 } from "./develop-receipts.ts";
import { checkEndoDevelopTextV0, ENDO_PROJECT_ID_PATTERN_V0, ENDO_TASK_ID_PATTERN_V0 } from "./develop-tasks.ts";
import type {
	EndoCriterionStateV0,
	EndoLedgerCheckV0,
	EndoPlannedCheckStateV0,
	EndoVerificationPlanV0,
} from "./develop-verification.ts";
import { validateEndoVerificationPlanV0 } from "./develop-verification.ts";
import { EndoInvalidRecordV0, endoFirstUnknownKeyV0 } from "./versioned.ts";

export const ENDO_DEVELOP_ATTEMPT_SCHEMA_V0 = "endo.develop-attempt.v0";
/** v1 (DEVELOP-VERIFY-001): a prepared attempt with a verification plan, rendered with brief v1. v0 is unchanged and still written. */
export const ENDO_DEVELOP_ATTEMPT_SCHEMA_V1 = "endo.develop-attempt.v1";
export const ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0 = "endo.develop-attempt-handoff.v0";
export const ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0 = "endo.develop-attempt-outcome.v0";
/**
 * v5 (DEVELOP-BEHAVIOUR-001): each receipt carries its standard output's digest and size (`stdout`), and each planned check its declared
 * behaviour (`expect`) and what the latest receipt at HEAD observed of it (`behaviour`). v4 (DEVELOP-PROVENANCE-001) added `head` and each
 * attempt's provenance. v3 (DEVELOP-VERIFY-001): each attempt carries its verification plan and the acceptance ledger derived from it (null without a plan).
 * v2 (Slice I) added its execution, when it was sent to Pi through the workbench (protocol/develop-attempt-execution.ts). v1 (Slice F)
 * added verification receipts; v0 (Slice E), v1 and v2 are no longer served.
 */
export const ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V5 = "endo.develop-attempts-view.v5";
/** The renderer an attempt is shown with. A later renderer is a new value: an old attempt's brief never changes under it. */
export const ENDO_DEVELOP_BRIEF_V0 = "endo.develop-brief.v0";
/** v0's sections, plus "How the result will be checked" from the attempt's verification plan. Used only by v1 attempts. */
export const ENDO_DEVELOP_BRIEF_V1 = "endo.develop-brief.v1";

export const ENDO_ATTEMPT_ID_PATTERN_V0 = /^endo\.attempt\.[0-9a-f]{32}$/;

/**
 * Closed bounds. A prepared record holds at most seven bounded texts (each ≤ 4 000 characters, so ≤ 12 000 bytes once written as JSON) and,
 * in v1, a verification plan (≤ 16 KiB as JSON), and fits `maxPreparedBytes` with room; a handoff or outcome is small. The directory holds at most `maxAttempts` attempts, `maxPerTask` per task.
 */
// The counts are checked when an attempt is prepared, without a lock, so two prepares at the same moment can pass them by one each: they
// are bounds on growth, not a security boundary, and a read never refuses because of them.
export const ENDO_DEVELOP_ATTEMPT_LIMITS_V0 = Object.freeze({
	maxAttempts: 500,
	maxPerTask: 50,
	maxPreparedBytes: 112 * 1024,
	maxNoteFileBytes: 16 * 1024,
	/** A `--*-file` input: a regular file, read whole, at most this many bytes. */
	maxInputFileBytes: 16 * 1024,
});

export type EndoDevelopTaskWordV0 = "title" | "description" | "acceptance";

/** What every prepared record holds, whatever its version. */
interface EndoDevelopAttemptCommonV0 {
	id: string;
	projectId: string;
	taskId: string;
	preparedAtMs: number;
	/** Copied from the task file when the attempt was prepared: the words the brief was written on, and the task revision they were read at. */
	task: { revision: number; projectName: string; title: string; description: string; acceptance: string };
	objective: string;
	constraints: string;
	reportBack: string;
	recordedBy: "operator";
	via: "cli";
}

/**
 * `<id>.prepared.json`: immutable. v0 has no verification plan and renders brief v0; v1 carries the operator's plan
 * (protocol/develop-verification.ts) and renders brief v1, so the plan is part of the text the operator approves. A version and its brief
 * renderer always go together.
 */
export type EndoDevelopAttemptV0 = EndoDevelopAttemptCommonV0 &
	(
		| { schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_SCHEMA_V0; brief: typeof ENDO_DEVELOP_BRIEF_V0 }
		| {
				schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_SCHEMA_V1;
				brief: typeof ENDO_DEVELOP_BRIEF_V1;
				verification: EndoVerificationPlanV0;
		  }
	);

/** The attempt's verification plan, or null for a v0 attempt (prepared without one). */
export const endoAttemptPlanV0 = (attempt: EndoDevelopAttemptV0): EndoVerificationPlanV0 | null =>
	attempt.schemaVersion === ENDO_DEVELOP_ATTEMPT_SCHEMA_V1 ? attempt.verification : null;

/** `<id>.handoff.json`: the operator's statement that they handed the brief to `target`. `recordedAtMs` is when they RECORDED it. */
export interface EndoDevelopAttemptHandoffV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0;
	attemptId: string;
	recordedAtMs: number;
	/** A label the operator chose ("Claude Code"). Shown, never interpreted. */
	target: string;
	note: string | null;
	recordedBy: "operator";
	via: "cli";
}

/** `<id>.outcome.json`: what the operator recorded as reported (never verified here), or that they stopped without claiming success. */
export interface EndoDevelopAttemptOutcomeV0 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0;
	attemptId: string;
	recordedAtMs: number;
	kind: "reported" | "abandoned";
	/** reported: what was reported (not blank). abandoned: an optional reason ("" when none). */
	note: string;
	recordedBy: "operator";
	via: "cli";
}

export type EndoDevelopAttemptStateV0 = "prepared" | "handed-off" | "reported" | "abandoned";

/** The state, from which records exist. An outcome decides it whether or not a handoff was recorded, and in whichever order they were. */
export function endoDevelopAttemptStateV0(
	handoff: EndoDevelopAttemptHandoffV0 | null,
	outcome: EndoDevelopAttemptOutcomeV0 | null,
): EndoDevelopAttemptStateV0 {
	if (outcome !== null) return outcome.kind;
	return handoff === null ? "prepared" : "handed-off";
}

/** The label each state is shown with, everywhere. "Reported" is never shown without "not verified". */
export const ENDO_DEVELOP_ATTEMPT_LABELS_V0: Readonly<Record<EndoDevelopAttemptStateV0, string>> = Object.freeze({
	prepared: "Prepared",
	"handed-off": "Handoff recorded",
	reported: "Result reported, not verified",
	abandoned: "Abandoned",
});

// ---- validation ---------------------------------------------------------------------------------------------------------------------

const bad = (what: string): never => {
	throw new EndoInvalidRecordV0(what);
};
const closed = (v: unknown, keys: readonly string[], what: string): Record<string, unknown> => {
	if (
		typeof v !== "object" ||
		v === null ||
		Array.isArray(v) ||
		(Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
	)
		return bad(`${what} is not an object`);
	if (endoFirstUnknownKeyV0(v, keys) !== undefined) return bad(`${what} has an unknown member`);
	for (const key of keys) if (!Object.hasOwn(v, key)) return bad(`${what} lacks ${key}`);
	return v as Record<string, unknown>;
};
const stamp = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15 ? v : bad(`${what} is not a time`);
const count = (v: unknown, what: string): number =>
	typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : bad(`${what} is not a count`);
const exact = <T extends string>(v: unknown, value: T, what: string): T =>
	v === value ? value : bad(`${what} is not ${value}`);
const matching = (v: unknown, pattern: RegExp, what: string): string =>
	typeof v === "string" && pattern.test(v) ? v : bad(`${what} is not well formed`);

/** Text under the task protocol's own rules, unchanged. A one-line value must already be trimmed: what was written is what is read. */
function words(v: unknown, rule: "title" | "name" | "note" | "text", what: string, nonBlank = false): string {
	const checked = checkEndoDevelopTextV0(rule, v);
	if (!checked.ok || (rule !== "text" && checked.text !== v)) return bad(`${what} is not acceptable text`);
	if (nonBlank && checked.text.trim() === "") return bad(`${what} is blank`);
	return checked.text;
}

/** The operator's input for a new attempt, checked: what `prepare` accepts. */
export function checkEndoDevelopAttemptInputV0(input: {
	objective: unknown;
	constraints?: unknown;
	reportBack?: unknown;
}): { ok: true; objective: string; constraints: string; reportBack: string } | { ok: false } {
	try {
		return {
			ok: true,
			objective: words(input.objective, "text", "objective", true),
			constraints: words(input.constraints ?? "", "text", "constraints"),
			reportBack: words(input.reportBack ?? "", "text", "reportBack"),
		};
	} catch {
		return { ok: false };
	}
}

const ATTEMPT_KEYS_V0 = [
	"schemaVersion",
	"id",
	"projectId",
	"taskId",
	"preparedAtMs",
	"task",
	"objective",
	"constraints",
	"reportBack",
	"brief",
	"recordedBy",
	"via",
] as const;

export function validateEndoDevelopAttemptV0(value: unknown): EndoDevelopAttemptV0 {
	const version =
		typeof value === "object" && value !== null ? (value as Record<string, unknown>).schemaVersion : undefined;
	const v1 = version === ENDO_DEVELOP_ATTEMPT_SCHEMA_V1;
	const r = closed(value, v1 ? [...ATTEMPT_KEYS_V0, "verification"] : ATTEMPT_KEYS_V0, "attempt");
	const t = closed(r.task, ["revision", "projectName", "title", "description", "acceptance"], "attempt.task");
	const common = {
		id: matching(r.id, ENDO_ATTEMPT_ID_PATTERN_V0, "id"),
		projectId: matching(r.projectId, ENDO_PROJECT_ID_PATTERN_V0, "projectId"),
		taskId: matching(r.taskId, ENDO_TASK_ID_PATTERN_V0, "taskId"),
		preparedAtMs: stamp(r.preparedAtMs, "preparedAtMs"),
		task: {
			revision: count(t.revision, "task.revision"),
			projectName: words(t.projectName, "name", "task.projectName"),
			title: words(t.title, "title", "task.title"),
			description: words(t.description, "text", "task.description"),
			acceptance: words(t.acceptance, "text", "task.acceptance"),
		},
		objective: words(r.objective, "text", "objective", true),
		constraints: words(r.constraints, "text", "constraints"),
		reportBack: words(r.reportBack, "text", "reportBack"),
		recordedBy: exact(r.recordedBy, "operator", "recordedBy"),
		via: exact(r.via, "cli", "via"),
	};
	if (v1)
		return {
			schemaVersion: ENDO_DEVELOP_ATTEMPT_SCHEMA_V1,
			...common,
			brief: exact(r.brief, ENDO_DEVELOP_BRIEF_V1, "brief"),
			verification: validateEndoVerificationPlanV0(r.verification),
		};
	return {
		schemaVersion: exact(r.schemaVersion, ENDO_DEVELOP_ATTEMPT_SCHEMA_V0, "schemaVersion"),
		...common,
		brief: exact(r.brief, ENDO_DEVELOP_BRIEF_V0, "brief"),
	};
}

export function validateEndoDevelopAttemptHandoffV0(value: unknown): EndoDevelopAttemptHandoffV0 {
	const r = closed(
		value,
		["schemaVersion", "attemptId", "recordedAtMs", "target", "note", "recordedBy", "via"],
		"handoff",
	);
	return {
		schemaVersion: exact(r.schemaVersion, ENDO_DEVELOP_ATTEMPT_HANDOFF_SCHEMA_V0, "schemaVersion"),
		attemptId: matching(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		recordedAtMs: stamp(r.recordedAtMs, "recordedAtMs"),
		target: words(r.target, "name", "target"),
		note: r.note === null ? null : words(r.note, "note", "note", true),
		recordedBy: exact(r.recordedBy, "operator", "recordedBy"),
		via: exact(r.via, "cli", "via"),
	};
}

export function validateEndoDevelopAttemptOutcomeV0(value: unknown): EndoDevelopAttemptOutcomeV0 {
	const r = closed(
		value,
		["schemaVersion", "attemptId", "recordedAtMs", "kind", "note", "recordedBy", "via"],
		"outcome",
	);
	const kind = r.kind === "reported" || r.kind === "abandoned" ? r.kind : bad("kind is not reported or abandoned");
	return {
		schemaVersion: exact(r.schemaVersion, ENDO_DEVELOP_ATTEMPT_OUTCOME_SCHEMA_V0, "schemaVersion"),
		attemptId: matching(r.attemptId, ENDO_ATTEMPT_ID_PATTERN_V0, "attemptId"),
		recordedAtMs: stamp(r.recordedAtMs, "recordedAtMs"),
		kind,
		// What was reported must be said; a reason for stopping is optional.
		note: kind === "reported" ? words(r.note, "text", "note", true) : words(r.note, "note", "note"),
		recordedBy: exact(r.recordedBy, "operator", "recordedBy"),
		via: exact(r.via, "cli", "via"),
	};
}

/** The task's words that differ from the attempt's copy. A revision change caused only by a status move or a session link is not a change. */
export function endoDevelopTaskWordsChangedV0(
	attempt: EndoDevelopAttemptV0,
	task: { title: string; description: string; acceptance: string },
): EndoDevelopTaskWordV0[] {
	return (["title", "description", "acceptance"] as const).filter((k) => attempt.task[k] !== task[k]);
}

// ---- the brief ----------------------------------------------------------------------------------------------------------------------

/**
 * The text inside a backtick fence longer than any run of backticks in it (at least three), so that in a Markdown rendering the text cannot
 * close its fence. This protects RENDERING only: a model reading the brief sees the words whatever the fences say, and the provenance
 * paragraph at the top, not the fences, is what tells it whose words these are. An empty field is said outside any fence, as `(empty)`, so
 * it cannot be confused with a field whose text is "(empty)".
 */
function fenced(text: string): string {
	if (text === "") return "(empty)";
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}text\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** The fixed request used when the operator wrote no report-back request. Visible in the brief, as every other word of it. */
export const ENDO_DEVELOP_DEFAULT_REPORT_BACK_V0 =
	"Tell the operator what you changed (files, commits), what you ran to check it and what it printed, and what is left undone. The operator checks your report separately; it is not taken as verification.";

/**
 * The brief: plain text for the operator to copy into any coding agent. A pure function of the prepared record alone, with no provider
 * wording, no hidden text and no claim that anything ran. Every operator-written text, the task's title and the project's name included, is
 * quoted exactly inside a fence; only identifiers, a revision number and a time are written outside one.
 */
export function renderEndoDevelopBriefV0(attempt: EndoDevelopAttemptV0): string {
	const t = attempt.task;
	const plan = endoAttemptPlanV0(attempt);
	return [
		`# Work brief ${attempt.id}`,
		"",
		`Prepared by the operator in Endophasia on ${new Date(attempt.preparedAtMs).toISOString()}, for ${attempt.taskId} (revision ${t.revision}).`,
		"This brief is the operator's request. It is not an approval: it grants no tools, permissions or access. Endophasia does not read your",
		"reply; the operator records the outcome. The text inside each section's fence is the operator's, quoted exactly; Endophasia's own",
		"words are outside the fences.",
		"",
		"## Task and project",
		fenced(`${t.title}\n${t.projectName}`),
		"",
		"## Objective",
		fenced(attempt.objective),
		"",
		"## Task description",
		fenced(t.description),
		"",
		"## Acceptance criteria",
		fenced(t.acceptance),
		"",
		"## Constraints and exclusions",
		fenced(attempt.constraints),
		"",
		...(plan === null ? [] : planSection(plan)),
		"## What to report back",
		// The default is Endophasia's wording, not the operator's: it is written outside any fence, and says so.
		attempt.reportBack === ""
			? `(empty; Endophasia's default request:) ${ENDO_DEVELOP_DEFAULT_REPORT_BACK_V0}`
			: fenced(attempt.reportBack),
		"",
		`End of brief ${attempt.id}.`,
		"",
	].join("\n");
}

/**
 * A behavioural check's expectation, as the brief states it. The fence cannot show whether the text ends with a line break, so Endophasia
 * says so outside it, with the byte count.
 */
function expectedLines(e: { exitCode: number; stdout: string }): string[] {
	const bytes = new TextEncoder().encode(e.stdout).length;
	if (bytes === 0)
		return [
			`What the operator expects it to do: exit with code ${e.exitCode} and write nothing to standard output. Endophasia compares the`,
			"output byte for byte; standard error is not compared.",
		];
	return [
		`What the operator expects it to do: exit with code ${e.exitCode} and write exactly this to standard output (${bytes} bytes as UTF-8; it ${e.stdout.endsWith("\n") ? "ends with a line break" : "does not end with a line break"}).`,
		"Endophasia compares the output byte for byte; standard error is not compared.",
		fenced(e.stdout),
	];
}

/**
 * Brief v1's one extra section: the verification plan. Endophasia's words are outside the fences, the operator's (argv, what a check shows,
 * each criterion) inside; check names are validated identifiers and are written outside. The argv is written as a JSON list, so its exact
 * arguments are unambiguous.
 */
function planSection(plan: EndoVerificationPlanV0): string[] {
	const out = [
		"## How the result will be checked",
		"The operator's verification plan. After your work, the operator may run these checks through Endophasia, in a clean, committed",
		"working tree, and judges the criteria that no check addresses. Your own report of running them is not taken as their result.",
		"",
	];
	for (const c of plan.checks)
		out.push(
			`Check \`${c.name}\`, the command as an argument list:`,
			fenced(JSON.stringify(c.argv)),
			"What the operator says it shows:",
			fenced(c.shows),
			...(c.expect === undefined ? [] : expectedLines(c.expect)),
			"",
		);
	plan.criteria.forEach((c, i) => {
		out.push(
			`Criterion ${i + 1}:`,
			fenced(c.text),
			c.checks.length === 0
				? "Checked by: the operator's judgment (no check)."
				: `Checked by: ${c.checks.map((n) => `\`${n}\``).join(", ")}.`,
			"",
		);
	});
	return out;
}

// ---- the workbench's read model -----------------------------------------------------------------------------------------------------

/**
 * An attempt's verification plan and its acceptance ledger, as the page shows them (docs/designs/develop-verification-plans.md): each
 * planned check with its argv made display-safe and its state relative to the launch directory now; each criterion with the state that
 * follows from its checks. Derived at the read, never stored. `current` and `otherCommit` name receipts in the attempt's own `receipts.list`.
 */
export interface EndoAttemptVerificationViewV0 {
	checks: (Pick<EndoLedgerCheckV0, "name" | "current" | "atHead" | "otherCommit" | "runs" | "behaviour"> & {
		argv: string[];
		shows: string;
		state: EndoPlannedCheckStateV0;
	})[];
	criteria: { text: string; checks: string[]; state: EndoCriterionStateV0 }[];
	unplanned: number;
}

export interface EndoDevelopAttemptViewV5 {
	id: string;
	state: EndoDevelopAttemptStateV0;
	preparedAtMs: number;
	taskRevision: number;
	objective: string;
	handoff: { recordedAtMs: number; target: string; note: string | null } | null;
	outcome: { recordedAtMs: number; kind: "reported" | "abandoned"; note: string } | null;
	/** The task's words that changed since preparation (empty when none did, or when the task cannot be read now). */
	taskWordsChanged: EndoDevelopTaskWordV0[];
	brief: string;
	/**
	 * The attempt's verification receipts (docs/designs/develop-verification-receipts.md), oldest first, each related to the launch
	 * directory's HEAD at this read. `unreadable`: the attempt's receipt directory could not be read (none are shown). `problems`: files in
	 * it that are not usable receipts.
	 */
	receipts: { state: "ready" | "unreadable"; list: EndoDevelopReceiptViewV0[]; problems: number };
	/**
	 * When the operator authorised sending this attempt's brief to a Pi session through the workbench: what the session's own records say
	 * happened (docs/designs/develop-attempt-execution.md). Null when no authorisation is recorded. Never a verdict on the work.
	 */
	execution: EndoDevelopAttemptExecutionViewV0 | null;
	/** The operator's verification plan and the ledger derived from it; null for an attempt prepared without a plan. */
	verification: EndoAttemptVerificationViewV0 | null;
	/**
	 * What Git showed of the working tree around this attempt, and how that relates to the tree now and to the commits its checks ran at
	 * (docs/designs/develop-candidate-provenance.md). Null when this reader does not read observations, or the attempt was neither
	 * authorised nor observed. Never authorship.
	 */
	provenance: EndoAttemptProvenanceViewV0 | null;
}

/**
 * `GET workspace/attempts`: the attempts of the task the project has SELECTED (chosen from the task file, never from the request). No path,
 * session id or scope: attempts carry none. `problems` counts files in the directory that could not be used (they are not shown).
 */
export interface EndoDevelopAttemptsViewV5 {
	schemaVersion: typeof ENDO_DEVELOP_ATTEMPTS_VIEW_SCHEMA_V5;
	state: "ready" | "no-task" | "unreadable";
	taskId: string | null;
	attempts: EndoDevelopAttemptViewV5[];
	problems: number;
	/**
	 * The working tree every receipt relation, ledger state and "now" in this view was compared with: its HEAD and whether it was clean,
	 * as read for THIS view, and when. Null when this reader compares with nothing (no receipts); `commit` null when it could not be
	 * observed. Other panels (the Context panel's changes) are separate reads at their own times.
	 */
	head: { readAtMs: number; commit: string | null; clean: boolean | null } | null;
}
