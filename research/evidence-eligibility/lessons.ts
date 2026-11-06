// Lesson candidates (`endo.lesson-candidates.v0`): a research-only card format for MEM-000's feasibility question, not a production memory
// schema. A card separates the observed evidence (selectors over eligible examples, numbers cited from committed analyses), the proposed
// guidance, where it applies and where it must not, its model/harness/environment scope, and what kind of claim it is. Cards are written and
// reviewed by hand (disclosed in the file's `review`); nothing here generates, rewrites or ranks guidance by its text.
//
// The text of a card (guidance, notes, diagnosis) is never interpreted: whether a card is supported, conditional or applicable is decided
// only from its structured fields and the report's examples. A sentence in a card or a source that says "always apply" changes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { ENDO_LESSON_CANDIDATES_V0, type Example } from "./contract.ts";

export const LEVERS = [
	"agent-context",
	"completion-cap",
	"reasoning-mode",
	"evaluation-infrastructure",
	"experiment-design",
] as const;
export type Lever = (typeof LEVERS)[number];
export const CLAIMS = ["observational", "diagnostic-hypothesis", "controlled-intervention"] as const;
export type Claim = (typeof CLAIMS)[number];

export interface Scope {
	model: string;
	harness: { name: string; version: string };
	/** Environment tags that must hold (for example `completion-cap:16384`). */
	environment: string[];
}

export interface Selector {
	study: string;
	stage: string | null;
	task: string;
	condition: string | null;
	outcome: "passed" | "failed" | "any";
	/** A failing check the example's verified output names, as a specific failure (not one where every check failed); null for any. */
	symptom: string | null;
}

export interface Contradiction extends Selector {
	shows: string | null;
}

export interface Card {
	id: string;
	guidance: string;
	lever: Lever;
	claim: Claim;
	scope: Scope;
	/** Task features that must all be present. */
	applies: string[];
	/** Task features any one of which makes the card inapplicable. */
	excludes: string[];
	evidence: {
		observations: Selector[];
		/**
		 * Counterexamples. Each names the `excludes` feature it shows the card must not apply under (`shows`); one with no such feature, or a
		 * feature the card does not exclude, falls inside the card's own conditions and removes its support.
		 */
		contradicting: Contradiction[];
		/**
		 * The randomized contrast a controlled claim rests on, and where its committed analysis gives the interval of the difference: a
		 * controlled claim is supported only when that interval excludes zero.
		 */
		contrast: {
			study: string;
			stage: string;
			tasks: string[];
			treatment: string;
			control: string;
			interval: { file: string; low: string; high: string };
			/** The direction of treatment − control the guidance claims: supported only when the whole interval lies on that side of zero. */
			direction: "increase" | "decrease";
		} | null;
		analysis: { file: string; pointer: string; value: number | string | boolean }[];
	};
	diagnosis: { hypothesis: string; alternatives: string[] } | null;
	/** The reviewer's judgement that the card restates a general engineering default. */
	generic: boolean;
	revoked: boolean;
	note: string;
}

export interface Target {
	name: string;
	scope: Scope;
	/** The one lever the target experiment varies between its arms; every other lever is held fixed. */
	variedLever: Lever;
	/** The context allowance shared by the static checklist and the retrieved cards. */
	contextBudgetTokens: number;
}

export interface LessonFile {
	schemaVersion: typeof ENDO_LESSON_CANDIDATES_V0;
	review: { method: "manual"; reviewer: string; date: string; disclosure: string };
	target: Target;
	cards: Card[];
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function closed(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (!isObject(v)) throw new TypeError(`${what} is not an object`);
	for (const k of Object.keys(v))
		if (!keys.includes(k)) throw new TypeError(`${what}: unknown field ${JSON.stringify(k)}`);
	for (const k of keys) if (!(k in v)) throw new TypeError(`${what}: missing field ${JSON.stringify(k)}`);
	return v;
}
const str = (v: unknown, what: string, max = 2000): string => {
	if (typeof v !== "string" || v.length === 0 || v.length > max) throw new TypeError(`${what} is not acceptable text`);
	return v;
};
const TAG = /^[a-z0-9][a-z0-9:._-]{0,80}$/;
const tags = (v: unknown, what: string): string[] => {
	if (!Array.isArray(v) || !v.every((t) => typeof t === "string" && TAG.test(t))) throw new TypeError(`${what}: tags`);
	return [...v] as string[];
};
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => {
	if (!list.includes(v as T)) throw new TypeError(`${what} is unknown`);
	return v as T;
};
function scopeOf(v: unknown, what: string): Scope {
	const o = closed(v, ["model", "harness", "environment"], what);
	const h = closed(o.harness, ["name", "version"], `${what}.harness`);
	return {
		model: str(o.model, `${what}.model`, 200),
		harness: {
			name: str(h.name, `${what}.harness.name`, 80),
			version: str(h.version, `${what}.harness.version`, 80),
		},
		environment: tags(o.environment, `${what}.environment`),
	};
}
function selectorOf(v: unknown, what: string): Selector {
	const o = closed(v, ["study", "stage", "task", "condition", "outcome", "symptom"], what);
	return {
		study: str(o.study, `${what}.study`, 120),
		stage: o.stage === null ? null : str(o.stage, `${what}.stage`, 80),
		task: str(o.task, `${what}.task`, 120),
		condition: o.condition === null ? null : str(o.condition, `${what}.condition`, 80),
		outcome: oneOf(o.outcome, ["passed", "failed", "any"] as const, `${what}.outcome`),
		symptom: o.symptom === null ? null : str(o.symptom, `${what}.symptom`, 200),
	};
}

export function readLessonFile(value: unknown): LessonFile {
	const root = closed(value, ["schemaVersion", "review", "target", "cards"], "lessons");
	if (root.schemaVersion !== ENDO_LESSON_CANDIDATES_V0)
		throw new TypeError(`lessons: unsupported version ${JSON.stringify(root.schemaVersion)}`);
	const review = closed(root.review, ["method", "reviewer", "date", "disclosure"], "review");
	if (review.method !== "manual") throw new TypeError("review.method must be manual");
	const t = closed(root.target, ["name", "scope", "variedLever", "contextBudgetTokens"], "target");
	if (!Number.isSafeInteger(t.contextBudgetTokens) || (t.contextBudgetTokens as number) <= 0)
		throw new TypeError("target.contextBudgetTokens");
	if (!Array.isArray(root.cards)) throw new TypeError("cards is not an array");
	const ids = new Set<string>();
	const cards = root.cards.map((c, i): Card => {
		const w = `cards[${i}]`;
		const o = closed(
			c,
			[
				"id",
				"guidance",
				"lever",
				"claim",
				"scope",
				"applies",
				"excludes",
				"evidence",
				"diagnosis",
				"generic",
				"revoked",
				"note",
			],
			w,
		);
		const id = str(o.id, `${w}.id`, 120);
		if (!/^lesson\.[a-z0-9-]{1,80}$/.test(id) || ids.has(id)) throw new TypeError(`${w}.id is not a new lesson id`);
		ids.add(id);
		const e = closed(o.evidence, ["observations", "contradicting", "contrast", "analysis"], `${w}.evidence`);
		if (!Array.isArray(e.observations) || !Array.isArray(e.contradicting) || !Array.isArray(e.analysis))
			throw new TypeError(`${w}.evidence lists`);
		let contrast: Card["evidence"]["contrast"] = null;
		if (e.contrast !== null) {
			const k = closed(
				e.contrast,
				["study", "stage", "tasks", "treatment", "control", "interval", "direction"],
				`${w}.evidence.contrast`,
			);
			if (!Array.isArray(k.tasks) || k.tasks.length === 0) throw new TypeError(`${w}.evidence.contrast.tasks`);
			const iv = closed(k.interval, ["file", "low", "high"], `${w}.evidence.contrast.interval`);
			if (k.treatment === k.control) throw new TypeError(`${w}.evidence.contrast compares a condition with itself`);
			contrast = {
				study: str(k.study, "study", 120),
				stage: str(k.stage, "stage", 80),
				tasks: k.tasks.map((x) => str(x, "task", 120)),
				treatment: str(k.treatment, "treatment", 80),
				control: str(k.control, "control", 80),
				direction: oneOf(k.direction, ["increase", "decrease"] as const, `${w}.evidence.contrast.direction`),
				interval: {
					file: str(iv.file, "file", 400),
					low: str(iv.low, "low", 400),
					high: str(iv.high, "high", 400),
				},
			};
		}
		let diagnosis: Card["diagnosis"] = null;
		if (o.diagnosis !== null) {
			const d = closed(o.diagnosis, ["hypothesis", "alternatives"], `${w}.diagnosis`);
			if (!Array.isArray(d.alternatives)) throw new TypeError(`${w}.diagnosis.alternatives`);
			diagnosis = {
				hypothesis: str(d.hypothesis, "hypothesis"),
				alternatives: d.alternatives.map((x) => str(x, "alternative")),
			};
		}
		if (typeof o.generic !== "boolean" || typeof o.revoked !== "boolean") throw new TypeError(`${w}: flags`);
		return {
			id,
			guidance: str(o.guidance, `${w}.guidance`, 600),
			lever: oneOf(o.lever, LEVERS, `${w}.lever`),
			claim: oneOf(o.claim, CLAIMS, `${w}.claim`),
			scope: scopeOf(o.scope, `${w}.scope`),
			applies: tags(o.applies, `${w}.applies`),
			excludes: tags(o.excludes, `${w}.excludes`),
			evidence: {
				observations: e.observations.map((s, j) => selectorOf(s, `${w}.evidence.observations[${j}]`)),
				contradicting: e.contradicting.map((s, j): Contradiction => {
					const what = `${w}.evidence.contradicting[${j}]`;
					if (!isObject(s)) throw new TypeError(`${what} is not an object`);
					if (!("shows" in s)) throw new TypeError(`${what}: missing field "shows"`);
					const { shows, ...rest } = s;
					return {
						...selectorOf(rest, what),
						shows: shows === null ? null : (tags([shows], `${what}.shows`)[0] as string),
					};
				}),
				contrast,
				analysis: e.analysis.map((a, j) => {
					const x = closed(a, ["file", "pointer", "value"], `${w}.evidence.analysis[${j}]`);
					if (!["number", "string", "boolean"].includes(typeof x.value)) throw new TypeError("analysis value");
					return {
						file: str(x.file, "file", 400),
						pointer: str(x.pointer, "pointer", 400),
						value: x.value as number | string | boolean,
					};
				}),
			},
			diagnosis,
			generic: o.generic,
			revoked: o.revoked,
			note: str(o.note, `${w}.note`),
		};
	});
	return {
		schemaVersion: ENDO_LESSON_CANDIDATES_V0,
		review: {
			method: "manual",
			reviewer: str(review.reviewer, "reviewer", 400),
			date: str(review.date, "date", 40),
			disclosure: str(review.disclosure, "disclosure"),
		},
		target: {
			name: str(t.name, "target.name", 200),
			scope: scopeOf(t.scope, "target.scope"),
			variedLever: oneOf(t.variedLever, LEVERS, "target.variedLever"),
			contextBudgetTokens: t.contextBudgetTokens as number,
		},
		cards,
	};
}

// ---- feasibility -----------------------------------------------------------------------------------------------------------------------

/** A declared approximation (UTF-8 bytes / 4, rounded up), used only to compare against the target's context allowance. */
export const approxTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

export type CardProblem =
	| "revoked"
	| "observation-unsupported"
	| "contradiction-unresolved"
	| "contradicted-within-conditions"
	| "observations-invalid-arm-only"
	| "scope-unobserved"
	| "contrast-opposite"
	| "contrast-same-arm"
	| "analysis-missing"
	| "analysis-mismatch"
	| "contrast-missing"
	| "contrast-unsupported"
	| "contrast-arm-invalid"
	| "contrast-inconclusive"
	| "diagnosis-missing"
	| "alternatives-missing";

export type TargetProblem =
	| "lever-fixed-in-target"
	| "scope-model"
	| "scope-harness"
	| "scope-environment"
	| "generic"
	| "unconditional";

export interface CardAssessment {
	id: string;
	lever: Lever;
	claim: Claim;
	supported: boolean;
	/**
	 * What support rests on: `evidence` (eligible examples, and a valid contrast when controlled), `citation-only` (an observational card whose
	 * only support is a number found in a committed analysis: the citation resolves, which is all it shows), or `none`.
	 */
	support: "evidence" | "citation-only" | "none";
	problems: CardProblem[];
	/** Per selector: lesson-eligible matches (and how many of them carry the arm-invalid caveat), and matches excluded with their reasons. */
	observations: { eligible: number; armInvalid: number; ineligible: Record<string, number> }[];
	contradicting: { eligible: number; armInvalid: number; ineligible: Record<string, number>; shows: string | null }[];
	contrast: {
		treatment: number;
		control: number;
		armInvalid: number;
		interval: { low: number | null; high: number | null; sha256: string | null };
	} | null;
	analysis: { file: string; sha256: string | null; pointer: string; found: boolean; matches: boolean }[];
	conditional: boolean;
	tokens: number;
	/** Usable as a retrieved card in the target experiment: supported, conditional, on the varied lever and within its scope. */
	usableInTarget: boolean;
	targetProblems: TargetProblem[];
}

const matchesSelector = (e: Example, s: Selector): boolean =>
	e.decision.kind === "condition-assignment" &&
	e.source.study === s.study &&
	(s.stage === null || e.source.stage === s.stage) &&
	e.decision.task === s.task &&
	(s.condition === null || e.decision.condition === s.condition) &&
	(s.outcome === "any" ||
		(e.outcome.kind === "check" && (s.outcome === "passed" ? e.outcome.passed : !e.outcome.passed))) &&
	(s.symptom === null || specificFailure(e, s.symptom));

/**
 * The named check failed, and not as one of every named check: an output where no named check passed names every
 * rule, and is evidence of none of them in particular.
 */
/**
 * No named test passed (counted from the whole output, never from the bounded symptom list). This is a test outcome only: it does not show
 * that no usable artifact exists or that nothing was implemented.
 */
export const noNamedCheckPassed = (e: Example): boolean =>
	e.checksFailed !== null && e.checksFailed > 1 && e.checksFailed === e.checksNamed;

const specificFailure = (e: Example, symptom: string): boolean => {
	const failing = e.symptoms ?? [];
	return failing.includes(symptom) && !noNamedCheckPassed(e);
};

/** The lesson-eligible examples a selector matches (duplicates never counted twice), and the excluded matches by reason. */
function matching(examples: readonly Example[], s: Selector) {
	const ineligible: Record<string, number> = {};
	const eligible: Example[] = [];
	for (const e of examples) {
		if (!matchesSelector(e, s)) continue;
		if (e.links.duplicateOf !== undefined) continue;
		const v = e.eligibility.lesson;
		if (v.eligible) eligible.push(e);
		else for (const r of v.reasons) ineligible[r] = (ineligible[r] ?? 0) + 1;
	}
	return { eligible, ineligible: Object.fromEntries(Object.entries(ineligible).sort()) };
}
const counted = (m: ReturnType<typeof matching>) => ({
	eligible: m.eligible.length,
	armInvalid: m.eligible.filter((e) => e.caveats.includes("arm-invalid")).length,
	ineligible: m.ineligible,
});

/** A committed analysis file (repository-relative), parsed, with its sha256; null when absent, outside the repository or not JSON. */
function readAnalysis(repository: string, file: string): { value: unknown; sha256: string } | null {
	const path = join(repository, file);
	if (file.split("/").includes("..") || file.startsWith("/") || !existsSync(path)) return null;
	const bytes = readFileSync(path);
	try {
		return { value: JSON.parse(bytes.toString("utf8")), sha256: sha256HexV0(bytes) };
	} catch {
		return null;
	}
}

/** RFC 6901 JSON pointer, read-only. */
function pointerGet(value: unknown, pointer: string): { found: boolean; value?: unknown } {
	if (pointer === "") return { found: true, value };
	if (!pointer.startsWith("/")) return { found: false };
	let cur: unknown = value;
	for (const raw of pointer.slice(1).split("/")) {
		const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(cur) && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < cur.length) cur = cur[Number(key)];
		else if (isObject(cur) && Object.hasOwn(cur, key)) cur = cur[key];
		else return { found: false };
	}
	return { found: true, value: cur };
}

export function assessCard(
	card: Card,
	examples: readonly Example[],
	target: Target,
	repository: string,
): CardAssessment {
	const problems = new Set<CardProblem>();
	if (card.revoked) problems.add("revoked");
	const matched = card.evidence.observations.map((s) => matching(examples, s));
	const observations = matched.map(counted);
	// An observation is either a selector over eligible examples, or (with no selector) a number cited from a committed analysis.
	const citationOnly =
		observations.length === 0 && card.evidence.analysis.length > 0 && card.claim === "observational";
	if ((observations.length === 0 && !citationOnly) || observations.some((o) => o.eligible === 0))
		problems.add("observation-unsupported");
	// Observations made only under a condition the study reported invalid describe what happened there, and support nothing more.
	if (observations.length > 0 && observations.every((o) => o.eligible > 0 && o.armInvalid === o.eligible))
		problems.add("observations-invalid-arm-only");
	// The declared scope must be one the evidence was observed in: some matched example ran that model on that harness release.
	const all = matched.flatMap((m) => m.eligible);
	if (
		all.length > 0 &&
		!all.some(
			(e) =>
				e.identity.configuredModel === card.scope.model &&
				e.identity.harness?.name === card.scope.harness.name &&
				e.identity.harness?.version === card.scope.harness.version,
		)
	)
		problems.add("scope-unobserved");
	const contradicting = card.evidence.contradicting.map((s) => ({
		...counted(matching(examples, s)),
		shows: s.shows,
	}));
	// A cited contradiction must be found too: a counterexample that cannot be checked is not one.
	if (contradicting.some((o) => o.eligible === 0)) problems.add("contradiction-unresolved");
	// A found counterexample inside the card's own conditions (it shows no feature the card excludes) is evidence against the card.
	if (contradicting.some((o) => o.eligible > 0 && (o.shows === null || !card.excludes.includes(o.shows))))
		problems.add("contradicted-within-conditions");
	const analysis = card.evidence.analysis.map((a) => {
		const file = readAnalysis(repository, a.file);
		if (file === null) {
			problems.add("analysis-missing");
			return { file: a.file, sha256: null, pointer: a.pointer, found: false, matches: false };
		}
		const got = pointerGet(file.value, a.pointer);
		const matches = got.found && got.value === a.value;
		if (!got.found) problems.add("analysis-missing");
		else if (!matches) problems.add("analysis-mismatch");
		return { file: a.file, sha256: file.sha256, pointer: a.pointer, found: got.found, matches };
	});
	let contrast: CardAssessment["contrast"] = null;
	if (card.claim === "controlled-intervention") {
		const k = card.evidence.contrast;
		if (k === null) problems.add("contrast-missing");
		else {
			const inArm = (condition: string) =>
				examples.filter(
					(e) =>
						e.decision.kind === "condition-assignment" &&
						e.links.duplicateOf === undefined &&
						e.source.study === k.study &&
						e.source.stage === k.stage &&
						k.tasks.includes(e.decision.task) &&
						e.decision.condition === condition,
				);
			const t = inArm(k.treatment);
			const c = inArm(k.control);
			const armInvalid = [...t, ...c].filter((e) =>
				e.eligibility["causal-policy"].reasons.includes("arm-invalid"),
			).length;
			const file = readAnalysis(repository, k.interval.file);
			const num = (pointer: string): number | null => {
				const got = file === null ? { found: false } : pointerGet(file.value, pointer);
				return got.found && typeof got.value === "number" ? got.value : null;
			};
			const low = num(k.interval.low);
			const high = num(k.interval.high);
			contrast = {
				treatment: t.filter((e) => e.eligibility["causal-policy"].eligible).length,
				control: c.filter((e) => e.eligibility["causal-policy"].eligible).length,
				armInvalid,
				interval: { low, high, sha256: file?.sha256 ?? null },
			};
			// A contrast of an arm with itself is no contrast (the reader refuses it; a card built in code is caught here).
			if (k.treatment === k.control) problems.add("contrast-same-arm");
			if (armInvalid > 0) problems.add("contrast-arm-invalid");
			else if (contrast.treatment === 0 || contrast.control === 0) problems.add("contrast-unsupported");
			if (low === null || high === null || low > high) problems.add("analysis-missing");
			else if (low <= 0 && high >= 0) problems.add("contrast-inconclusive");
			else if ((k.direction === "increase") !== low > 0) problems.add("contrast-opposite");
		}
	}
	if (card.claim === "diagnostic-hypothesis") {
		if (card.diagnosis === null) problems.add("diagnosis-missing");
		else if (card.diagnosis.alternatives.length === 0) problems.add("alternatives-missing");
	}
	const supported = problems.size === 0;
	const support: CardAssessment["support"] = !supported ? "none" : citationOnly ? "citation-only" : "evidence";
	const conditional = !card.generic && card.applies.length + card.excludes.length > 0;
	const targetProblems = new Set<TargetProblem>();
	if (card.lever !== target.variedLever) targetProblems.add("lever-fixed-in-target");
	if (card.scope.model !== target.scope.model) targetProblems.add("scope-model");
	if (
		card.scope.harness.name !== target.scope.harness.name ||
		card.scope.harness.version !== target.scope.harness.version
	)
		targetProblems.add("scope-harness");
	if (!card.scope.environment.every((tag) => target.scope.environment.includes(tag)))
		targetProblems.add("scope-environment");
	if (card.generic) targetProblems.add("generic");
	if (card.applies.length + card.excludes.length === 0) targetProblems.add("unconditional");
	return {
		id: card.id,
		lever: card.lever,
		claim: card.claim,
		supported,
		support,
		problems: [...problems].sort(),
		observations,
		contradicting,
		contrast,
		analysis,
		conditional,
		tokens: approxTokens(card.guidance),
		// Guidance resting on a citation alone is never put in an agent's context.
		usableInTarget: support === "evidence" && targetProblems.size === 0,
		targetProblems: [...targetProblems].sort(),
	};
}

// ---- applicability ---------------------------------------------------------------------------------------------------------------------

export interface Case {
	model: string;
	harness: { name: string; version: string };
	environment: string[];
	features: string[];
}

export interface Selection {
	selected: string[];
	abstained: boolean;
	/** Every card not selected, with why. */
	passedOver: { id: string; why: string }[];
}

/**
 * The deterministic selector the feasibility checks exercise: a card is a candidate only when it is agent guidance (lever
 * `agent-context`), supported and not revoked, its scope
 * matches the case exactly (model, harness name and version, every environment tag), every `applies` feature is present and no `excludes`
 * feature is. Candidates are ranked by how many features they matched, then by id; at most `max`. No candidate: abstain.
 */
export function selectCards(
	cards: readonly Card[],
	assessments: ReadonlyMap<string, CardAssessment>,
	c: Case,
	max = 3,
): Selection {
	const passedOver: Selection["passedOver"] = [];
	const candidates: Card[] = [];
	for (const card of [...cards].sort((a, b) => (a.id < b.id ? -1 : 1))) {
		const a = assessments.get(card.id);
		let why: string | null = null;
		if (card.revoked) why = "revoked";
		// Only guidance for the agent is ever put in its context: a configuration, evaluation or design lesson is the operator's.
		else if (card.lever !== "agent-context") why = "not-agent-guidance";
		// Supported by a citation alone is not enough to enter an agent's context (as for usability in the target).
		else if (a === undefined || a.support !== "evidence") why = "unsupported";
		else if (card.scope.model !== c.model) why = "other-model";
		else if (card.scope.harness.name !== c.harness.name || card.scope.harness.version !== c.harness.version)
			why = "other-harness-version";
		else if (!card.scope.environment.every((t) => c.environment.includes(t))) why = "other-environment";
		else if (card.excludes.some((f) => c.features.includes(f))) why = "excluded-feature";
		else if (!card.applies.every((f) => c.features.includes(f))) why = "missing-feature";
		if (why === null) candidates.push(card);
		else passedOver.push({ id: card.id, why });
	}
	candidates.sort((a, b) => b.applies.length - a.applies.length || (a.id < b.id ? -1 : 1));
	const selected = candidates.slice(0, max).map((x) => x.id);
	for (const x of candidates.slice(max)) passedOver.push({ id: x.id, why: "over-limit" });
	return { selected, abstained: selected.length === 0, passedOver: passedOver.sort((a, b) => (a.id < b.id ? -1 : 1)) };
}
