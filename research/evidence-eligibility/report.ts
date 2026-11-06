// MEM-000: the evidence-eligibility report (README.md).
//
//   node research/evidence-eligibility/report.ts --out <dir> [--corpus <file>] [--lessons <file>] [--data <dir>] [--store <dir>]
//
// Reads the corpus's sources read-only and writes three files to <dir>: report.json (every example), manifest.json (sources, digests,
// exclusions, the report's digest) and summary.md. The output never holds an absolute path, a timestamp or any prompt, reasoning, request or
// tool text: the same inputs give the same bytes on any machine. <dir> may not be inside any source it reads.

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { researchDataRoot } from "../data.ts";
import {
	CAVEATS,
	ENDO_ELIGIBILITY_EXTRACTOR_V0,
	ENDO_EVIDENCE_ELIGIBILITY_MANIFEST_V0,
	ENDO_EVIDENCE_ELIGIBILITY_REPORT_V0,
	type Example,
	OBJECTIVES,
	type Objective,
	REASONS,
	type Reason,
	type SourceEntry,
	type SourceProblem,
} from "./contract.ts";
import { type Corpus, type CorpusSource, type Location, readCorpus } from "./corpus.ts";
import { readDevelopStore } from "./develop-source.ts";
import { attemptExample, experimentExample, linkExamples } from "./eligibility.ts";
import { readExperimentRun } from "./experiment-source.ts";
import {
	assessCard,
	type CardAssessment,
	type Case,
	type LessonFile,
	noNamedCheckPassed,
	readLessonFile,
	selectCards,
} from "./lessons.ts";
import { judgeReadiness, type ReadinessReport } from "./readiness.ts";
import { type RunValidity, readStudyValidity } from "./validity.ts";

export const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));

export interface Roots {
	repository: string;
	/** The research-data directory, or null when it is absent (as on CI). */
	researchData: string | null;
	/** A DEVELOP store root the operator named, or null. */
	store: string | null;
}

export interface ApplicabilityCase {
	id: string;
	purpose: string;
	case: Case;
	expect: { selected: string[]; abstained: boolean };
}

export interface Built {
	report: Record<string, unknown>;
	manifest: Record<string, unknown>;
	summary: string;
}

const rootOf = (roots: Roots, location: Location): string | null =>
	location === "repository" ? roots.repository : location === "research-data" ? roots.researchData : roots.store;
const isDirectory = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
const sha256File = (p: string) => sha256HexV0(readFileSync(p));

/** The run directories a source names: itself, or (with `children`) each subdirectory holding an experiment.json, by name. */
function runsOf(s: CorpusSource, dir: string): { id: string; dir: string; path: string; label: string }[] {
	if (!s.children) return [{ id: s.id, dir, path: s.path, label: dir.split("/").filter(Boolean).pop() ?? s.id }];
	return readdirSync(dir)
		.sort()
		.filter((n) => isDirectory(join(dir, n)) && existsSync(join(dir, n, "experiment.json")))
		.map((n) => ({ id: `${s.id}/${n}`, dir: join(dir, n), path: `${s.path}/${n}`, label: n }));
}

export function buildEligibility(
	corpus: Corpus,
	roots: Roots,
	lessons: LessonFile | null,
	cases: readonly ApplicabilityCase[] = [],
): Built {
	const sources: SourceEntry[] = [];
	const problems: SourceProblem[] = [];
	const examples: Example[] = [];
	const created = new Map<string, string>();
	const validityFiles = new Map<string, { value: unknown; sha256: string } | null>();
	const documents = new Map<string, string | null>();
	const docSha = (file: string): string | null => {
		if (!documents.has(file)) {
			const p = join(roots.repository, file);
			documents.set(file, existsSync(p) ? sha256File(p) : null);
		}
		return documents.get(file) ?? null;
	};

	for (const s of corpus.sources) {
		const root = rootOf(roots, s.location);
		const dir = root === null ? null : s.path === "." ? root : join(root, s.path);
		const base = { kind: s.kind, study: s.study, stage: s.stage, location: s.location } as const;
		if (dir === null || !isDirectory(dir)) {
			sources.push({ ...base, id: s.id, path: s.path, status: "missing", files: {}, examples: 0 });
			problems.push({ sourceId: s.id, path: s.path, kind: "missing", detail: `not present at ${s.location}` });
			continue;
		}
		if (s.kind === "develop-store") {
			const read = readDevelopStore(dir);
			if ("problem" in read) {
				sources.push({ ...base, id: s.id, path: s.path, status: "refused", files: {}, examples: 0 });
				problems.push({ sourceId: s.id, ...read.problem });
				continue;
			}
			for (const p of read.problems) problems.push({ sourceId: s.id, ...p });
			const made = read.attempts.map((a) =>
				attemptExample({ sourceId: s.id, location: `${s.location}/${s.path}` }, a),
			);
			examples.push(...made);
			sources.push({ ...base, id: s.id, path: s.path, status: "read", files: {}, examples: made.length });
			continue;
		}
		for (const run of runsOf(s, dir)) {
			const read = readExperimentRun(run.dir);
			if ("problem" in read) {
				sources.push({ ...base, id: run.id, path: run.path, status: "refused", files: {}, examples: 0 });
				problems.push({ sourceId: run.id, ...read.problem });
				continue;
			}
			for (const p of read.problems) problems.push({ sourceId: run.id, ...p });
			const files: Record<string, string> = { ...read.files };
			// The study's validity reading, from its committed analysis, cited by path and digest.
			let validity: RunValidity | null = null;
			const v = corpus.validity.find((x) => x.study === s.study && x.stage === s.stage);
			if (v !== undefined) {
				if (!validityFiles.has(v.file)) {
					const p = join(roots.repository, v.file);
					let parsed: { value: unknown; sha256: string } | null = null;
					if (existsSync(p))
						try {
							parsed = { value: JSON.parse(readFileSync(p, "utf8")), sha256: sha256File(p) };
						} catch {
							// Not JSON: the reader below refuses it as it refuses any other shape.
							parsed = { value: undefined, sha256: sha256File(p) };
						}
					validityFiles.set(v.file, parsed);
				}
				const f = validityFiles.get(v.file) ?? null;
				if (f === null)
					problems.push({
						sourceId: run.id,
						path: v.file,
						kind: "missing",
						detail: "validity analysis not present",
					});
				else {
					files[`repository:${v.file}`] = f.sha256;
					try {
						validity =
							readStudyValidity(v.reader, f.value, { path: v.file, sha256: f.sha256 }, [run.label]).get(
								run.label,
							) ?? null;
					} catch (error) {
						problems.push({
							sourceId: run.id,
							path: v.file,
							kind: "refused",
							detail: error instanceof Error ? error.message.slice(0, 300) : "refused",
						});
					}
				}
			}
			const declared = corpus.declarations.filter(
				(d) =>
					(d.kind === "run-invalid" && d.source === run.id) || (d.kind === "task-examined" && d.study === s.study),
			);
			for (const d of declared) {
				const sha = docSha(d.document);
				if (sha !== null) files[`repository:${d.document}`] = sha;
				else
					problems.push({
						sourceId: run.id,
						path: d.document,
						kind: "missing",
						detail: "declaring document not present",
					});
			}
			const ctx = {
				sourceId: run.id,
				study: s.study,
				stage: s.stage,
				location: `${s.location}/${run.path}`,
				record: read.record,
				validity,
				runInvalid: declared.some((d) => d.kind === "run-invalid"),
				examinedTasks: new Set(declared.flatMap((d) => (d.kind === "task-examined" ? [d.task] : []))),
				conditions: read.conditions,
				// Any planned trial without a usable outcome breaks the randomized set: no result, a refused record, or a runner error.
				attrition:
					read.problems.some((p) => p.path === "trials" || p.path.startsWith("trials/")) ||
					read.trials.some((t) => t.kind === "result" && t.result?.status === "error"),
			};
			const made = read.trials.map((t) => experimentExample(ctx, t));
			examples.push(...made);
			created.set(run.id, read.record.createdAt);
			sources.push({ ...base, id: run.id, path: run.path, status: "read", files, examples: made.length });
		}
	}
	const linked = linkExamples(examples, created);
	const sortedSources = [...sources].sort((a, b) => (a.id < b.id ? -1 : 1));
	// A reader's message can name the file it refused by absolute path: each root is replaced by its location's name.
	const named: [string, string][] = (
		[
			[roots.store, "store"],
			[roots.researchData, "research-data"],
			[roots.repository, "repository"],
		] as [string | null, string][]
	)
		.filter((x): x is [string, string] => x[0] !== null)
		.map(([root, name]) => [resolve(root).replace(/\/+$/, ""), name] as [string, string])
		.sort((a, b) => b[0].length - a[0].length);
	const scrub = (text: string): string => named.reduce((t, [root, name]) => t.split(root).join(name), text);
	for (const p of problems) p.detail = scrub(p.detail);
	const sortedProblems = [...problems].sort((a, b) =>
		a.sourceId === b.sourceId ? (a.path < b.path ? -1 : 1) : a.sourceId < b.sourceId ? -1 : 1,
	);

	// ---- totals, over distinct records (a duplicate copy is counted once, at its canonical location) ----
	const distinct = linked.filter((e) => e.links.duplicateOf === undefined);
	const totals = Object.fromEntries(
		OBJECTIVES.map((o) => {
			const reasons: Record<string, number> = {};
			for (const e of distinct) for (const r of e.eligibility[o].reasons) reasons[r] = (reasons[r] ?? 0) + 1;
			return [
				o,
				{
					eligible: distinct.filter((e) => e.eligibility[o].eligible).length,
					ineligible: distinct.filter((e) => !e.eligibility[o].eligible).length,
					reasons: Object.fromEntries(Object.entries(reasons).sort()),
				},
			];
		}),
	) as Record<Objective, { eligible: number; ineligible: number; reasons: Record<string, number> }>;
	const byStudy: Record<string, Record<Objective, number> & { examples: number }> = {};
	for (const e of linked) {
		if (e.links.duplicateOf !== undefined) continue;
		const k = e.source.study ?? `(${e.source.kind})`;
		byStudy[k] ??= { examples: 0, descriptive: 0, symptom: 0, lesson: 0, "causal-policy": 0 };
		byStudy[k].examples++;
		for (const o of OBJECTIVES) if (e.eligibility[o].eligible) byStudy[k][o]++;
	}

	// ---- recurring symptoms, over symptom-eligible trials ----
	const cells = new Map<
		string,
		{
			study: string;
			stage: string;
			task: string;
			condition: string;
			trials: number;
			failed: number;
			noneNamedPassed: number;
			families: Map<string, number>;
		}
	>();
	for (const e of linked) {
		if (!e.eligibility.symptom.eligible || e.decision.kind !== "condition-assignment" || e.outcome.kind !== "check")
			continue;
		const k = `${e.source.study}|${e.source.stage}|${e.decision.task}|${e.decision.condition}`;
		const c = cells.get(k) ?? {
			study: e.source.study ?? "",
			stage: e.source.stage ?? "",
			task: e.decision.task,
			condition: e.decision.condition,
			trials: 0,
			failed: 0,
			noneNamedPassed: 0,
			families: new Map<string, number>(),
		};
		c.trials++;
		if (!e.outcome.passed) {
			c.failed++;
			// No named test passed. That is all it says: not that no usable artifact exists, nor that nothing was implemented (truncation or a
			// missing implementation would need its own evidence). It is never evidence of one specific rule.
			const failing = e.symptoms ?? [];
			if (noNamedCheckPassed(e)) c.noneNamedPassed++;
			const family = JSON.stringify(failing);
			c.families.set(family, (c.families.get(family) ?? 0) + 1);
		}
		cells.set(k, c);
	}
	const symptoms = [...cells.keys()].sort().map((k) => {
		const c = cells.get(k)!;
		return {
			study: c.study,
			stage: c.stage,
			task: c.task,
			condition: c.condition,
			trials: c.trials,
			failed: c.failed,
			noNamedCheckPassed: c.noneNamedPassed,
			families: [...c.families.entries()]
				.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
				.map(([family, count]) => ({ failing: JSON.parse(family) as string[], count })),
		};
	});

	// ---- lessons and readiness ----
	let lessonPart: Record<string, unknown> | null = null;
	let readiness: ReadinessReport | null = null;
	if (lessons !== null) {
		const assessments: CardAssessment[] = lessons.cards.map((c) =>
			assessCard(c, linked, lessons.target, roots.repository),
		);
		const byId = new Map(assessments.map((a) => [a.id, a]));
		const checks = cases.map((c) => {
			const got = selectCards(lessons.cards, byId, c.case);
			const passed =
				got.abstained === c.expect.abstained &&
				canonicalEndoJsonV0(got.selected) === canonicalEndoJsonV0([...c.expect.selected]);
			return { id: c.id, purpose: c.purpose, expected: c.expect, got, passed };
		});
		lessonPart = { review: lessons.review, target: lessons.target, assessments, applicability: checks };
		readiness = judgeReadiness({
			sources: sortedSources,
			problems: sortedProblems,
			examples: linked,
			cards: lessons.cards,
			assessments,
			target: lessons.target,
			researchDataRead: corpus.sources.some(
				(s) =>
					s.location === "research-data" &&
					sortedSources.some((x) => x.id.startsWith(s.id) && x.status === "read"),
			),
		});
	}

	const report = {
		schemaVersion: ENDO_EVIDENCE_ELIGIBILITY_REPORT_V0,
		extractor: { ...ENDO_ELIGIBILITY_EXTRACTOR_V0 },
		corpus: { id: corpus.id, sha256: sha256HexV0(canonicalEndoJsonV0(corpus)) },
		lessons: lessons === null ? null : { sha256: sha256HexV0(canonicalEndoJsonV0(lessons)) },
		roots: {
			researchData: roots.researchData === null ? "absent" : "read",
			store: roots.store === null ? "not-given" : "read",
		},
		reasons: { ...REASONS },
		caveats: { ...CAVEATS },
		sources: sortedSources,
		problems: sortedProblems,
		totals,
		byStudy: Object.fromEntries(Object.entries(byStudy).sort()),
		symptoms,
		examples: linked,
		lessonFeasibility: lessonPart,
		readiness,
	};
	const reportText = canonicalEndoJsonV0(report as unknown as Record<string, unknown>);
	// Exclusions a reader must see by name: those a study or a document decided, and those that make a record unusable.
	const NAMED: readonly Reason[] = [
		"trial-excluded",
		"run-invalid",
		"arm-invalid",
		"exclusions-unresolved",
		"conflicting-duplicate",
		"duplicate-record",
		"interrupted-execution",
		"check-output-mismatch",
		"outcome-missing",
		"receipt-predates-attempt",
		"receipt-project-mismatch",
		"receipt-revision-ambiguous",
	];
	// A duplicate is the same record read twice, not an exclusion of evidence: it is accounted for by count and by the digest of its list.
	const exclusions = distinct
		.map((e) => ({
			id: e.id,
			reasons: [...new Set(OBJECTIVES.flatMap((o) => e.eligibility[o].reasons))]
				.filter((r) => NAMED.includes(r))
				.sort(),
		}))
		.filter((x) => x.reasons.length > 0);
	const duplicateList = linked
		.filter((e) => e.links.duplicateOf !== undefined)
		.map((e) => ({ id: e.id, duplicateOf: e.links.duplicateOf as string }));
	const manifest = {
		schemaVersion: ENDO_EVIDENCE_ELIGIBILITY_MANIFEST_V0,
		extractor: report.extractor,
		corpus: report.corpus,
		lessons: report.lessons,
		roots: report.roots,
		report: {
			file: "report.json",
			sha256: sha256HexV0(reportText),
			examples: linked.length,
			distinct: distinct.length,
			duplicates: linked.length - distinct.length,
		},
		sources: sortedSources,
		problems: sortedProblems,
		totals,
		exclusions,
		duplicates: { count: duplicateList.length, sha256: sha256HexV0(canonicalEndoJsonV0(duplicateList)) },
		lessonFeasibility:
			lessonPart === null
				? null
				: {
						review: lessonPart.review,
						target: lessonPart.target,
						assessments: (lessonPart.assessments as CardAssessment[]).map((a) => ({
							id: a.id,
							lever: a.lever,
							claim: a.claim,
							supported: a.supported,
							usableInTarget: a.usableInTarget,
							problems: a.problems,
							targetProblems: a.targetProblems,
						})),
						applicability: (lessonPart.applicability as { id: string; passed: boolean }[]).map((c) => ({
							id: c.id,
							passed: c.passed,
						})),
					},
		readiness,
	};
	return {
		report,
		manifest,
		summary: summaryOf(report as never, manifest.report.sha256, exclusions.length),
	};
}

function summaryOf(
	r: {
		corpus: { id: string; sha256: string };
		roots: { researchData: string; store: string };
		sources: SourceEntry[];
		problems: SourceProblem[];
		totals: Record<Objective, { eligible: number; ineligible: number; reasons: Record<string, number> }>;
		byStudy: Record<string, Record<Objective, number> & { examples: number }>;
		symptoms: {
			study: string;
			stage: string;
			task: string;
			condition: string;
			trials: number;
			failed: number;
			noNamedCheckPassed: number;
			families: { failing: string[]; count: number }[];
		}[];
		lessonFeasibility: { assessments: CardAssessment[]; applicability: { id: string; passed: boolean }[] } | null;
		readiness: ReadinessReport | null;
	},
	reportSha: string,
	exclusions: number,
): string {
	const L: string[] = [];
	L.push("# Evidence eligibility (MEM-000)", "");
	L.push(
		`Corpus \`${r.corpus.id}\` (sha256 \`${r.corpus.sha256.slice(0, 16)}…\`), report sha256 \`${reportSha.slice(0, 16)}…\`.`,
	);
	L.push(`Research data: **${r.roots.researchData}**. DEVELOP store: **${r.roots.store}**.`, "");
	const read = r.sources.filter((s) => s.status === "read").length;
	const partial = r.problems.filter((p) => p.kind === "missing" && p.path === "trials");
	const unrun = partial.reduce((n, p) => n + Number(/^([0-9]+) of /.exec(p.detail)?.[1] ?? 0), 0);
	const other = r.problems.length - partial.length - r.sources.filter((s) => s.status === "missing").length;
	L.push(
		`Sources: ${r.sources.length} (${read} read, ${r.sources.filter((s) => s.status === "missing").length} missing, ${r.sources.filter((s) => s.status === "refused").length} refused). Planned trials with no result in the copy read: ${unrun}. Other problems: ${other}. Examples with a named exclusion: ${exclusions}.`,
		"",
	);
	L.push(
		"## Eligible examples by objective",
		"",
		"| Study | Examples | Descriptive | Symptom | Lesson | Causal policy |",
		"| :-- | --: | --: | --: | --: | --: |",
	);
	for (const [study, c] of Object.entries(r.byStudy))
		L.push(`| ${study} | ${c.examples} | ${c.descriptive} | ${c.symptom} | ${c.lesson} | ${c["causal-policy"]} |`);
	L.push(
		"",
		"Duplicates are counted once, at their canonical copy (here and below).",
		"",
		"## Why examples are not eligible",
		"",
	);
	for (const o of OBJECTIVES) {
		const t = r.totals[o];
		const reasons = Object.entries(t.reasons)
			.map(([k, n]) => `\`${k}\` ${n}`)
			.join(", ");
		L.push(`- **${o}**: ${t.eligible} eligible, ${t.ineligible} not${reasons === "" ? "" : `: ${reasons}`}.`);
	}
	L.push("", "## Recurring failure symptoms (symptom-eligible trials with a failed check)", "");
	L.push(
		"Zero passing named checks means every test the output names failed. It does not show that no usable artifact was produced, nor that nothing was implemented: this projection reads no truncation or workspace evidence per trial. It is never counted as evidence of one specific rule.",
		"",
		"| Study / stage | Task | Condition | Failed / trials | Zero passing named checks | Most common specific failing checks (count) |",
		"| :-- | :-- | :-- | --: | --: | :-- |",
	);
	for (const s of r.symptoms.filter((x) => x.failed > 0))
		L.push(
			`| ${s.study} / ${s.stage} | ${s.task} | ${s.condition} | ${s.failed}/${s.trials} | ${s.noNamedCheckPassed} | ${
				s.families
					.filter((f) => f.failing.length <= 3)
					.slice(0, 2)
					.map((f) => `${f.failing.length === 0 ? "(none named)" : f.failing.join("; ")} (${f.count})`)
					.join(" · ") || "—"
			} |`,
		);
	if (r.lessonFeasibility !== null) {
		L.push(
			"",
			"## Lesson candidates",
			"",
			"| Card | Lever | Claim | Support | Usable in target | Problems |",
			"| :-- | :-- | :-- | :-- | :-- | :-- |",
		);
		for (const a of r.lessonFeasibility.assessments)
			L.push(
				`| ${a.id} | ${a.lever} | ${a.claim} | ${a.support === "none" ? "no" : a.support} | ${a.usableInTarget ? "yes" : "no"} | ${[...a.problems, ...a.targetProblems].join(", ") || "none"} |`,
			);
		const passed = r.lessonFeasibility.applicability.filter((c) => c.passed).length;
		L.push(
			"",
			`Applicability checks: ${passed} of ${r.lessonFeasibility.applicability.length} behaved as specified.`,
		);
	}
	if (r.readiness !== null) {
		L.push("", "## MEM-001 readiness", "");
		for (const [name, j] of [
			["Evidence", r.readiness.evidence],
			["Lessons", r.readiness.lessons],
			["Evaluator", r.readiness.evaluator],
			["Overall", r.readiness.overall],
		] as const) {
			L.push(`**${name}: ${j.status}**`, "");
			for (const c of j.conditions) L.push(`- ${c}`);
			L.push("");
		}
		L.push(`The rules point to option **${r.readiness.suggests.option}**: ${r.readiness.suggests.because}.`);
	}
	return `${L.join("\n").trimEnd()}\n`;
}

// ---- command ----------------------------------------------------------------------------------------------------------------------------

const within = (parent: string, child: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** The real path, resolving links through the nearest existing ancestor when the path does not exist yet. */
const real = (p: string): string => {
	let head = resolve(p);
	const rest: string[] = [];
	while (!existsSync(head)) {
		const parent = resolve(head, "..");
		if (parent === head) break;
		rest.unshift(head.slice(parent.length).replace(/^\/+/, ""));
		head = parent;
	}
	return join(existsSync(head) ? realpathSync(head) : head, ...rest);
};

/** `endo.applicability-cases.v0`, strictly: closed records, a known version, the selector's case shape. */
export function readCases(value: unknown): ApplicabilityCase[] {
	const obj = (v: unknown, keys: string[], what: string): Record<string, unknown> => {
		if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError(`${what} is not an object`);
		const o = v as Record<string, unknown>;
		for (const k of Object.keys(o))
			if (!keys.includes(k)) throw new TypeError(`${what}: unknown field ${JSON.stringify(k)}`);
		for (const k of keys) if (!(k in o)) throw new TypeError(`${what}: missing field ${JSON.stringify(k)}`);
		return o;
	};
	const strings = (v: unknown, what: string): string[] => {
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
			throw new TypeError(`${what} is not a list of strings`);
		return [...v] as string[];
	};
	const root = obj(value, ["schemaVersion", "disclosure", "cases"], "cases");
	if (root.schemaVersion !== "endo.applicability-cases.v0")
		throw new TypeError(`cases: unsupported version ${JSON.stringify(root.schemaVersion)}`);
	if (!Array.isArray(root.cases)) throw new TypeError("cases.cases is not an array");
	return root.cases.map((c, i) => {
		const o = obj(c, ["id", "purpose", "case", "expect"], `cases[${i}]`);
		const k = obj(o.case, ["model", "harness", "environment", "features"], `cases[${i}].case`);
		const h = obj(k.harness, ["name", "version"], `cases[${i}].case.harness`);
		const x = obj(o.expect, ["selected", "abstained"], `cases[${i}].expect`);
		if (typeof o.id !== "string" || typeof o.purpose !== "string" || typeof k.model !== "string")
			throw new TypeError(`cases[${i}]`);
		if (typeof h.name !== "string" || typeof h.version !== "string" || typeof x.abstained !== "boolean")
			throw new TypeError(`cases[${i}]`);
		return {
			id: o.id,
			purpose: o.purpose,
			case: {
				model: k.model,
				harness: { name: h.name, version: h.version },
				environment: strings(k.environment, `cases[${i}].case.environment`),
				features: strings(k.features, `cases[${i}].case.features`),
			},
			expect: { selected: strings(x.selected, `cases[${i}].expect.selected`), abstained: x.abstained },
		};
	});
}

/** A new file only: never an existing name, never through a link. */
const createFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Write the three outputs without ever writing into an existing inode. Each is written to a new temporary file in the output directory (created
 * exclusively, never through a link), flushed, and renamed over its name. A rename replaces the directory entry, so an output name that was a
 * hard link to a source file only loses that name: the source inode is never opened for writing. An output name that is a symbolic link or
 * not a plain file is refused before anything is written.
 *
 * Races: the directory is resolved to its real path once, checked against every source, and its identity (device and inode) is checked again
 * before the renames. Node has no openat/renameat, so a process able to replace the output directory's parents during the write could still
 * redirect it; the check narrows that window to the renames themselves. On refusal or failure the temporary files are removed and nothing
 * else is touched.
 */
export function writeOutputs(built: Built, out: string, sourceDirs: readonly string[]): void {
	const inside = (dir: string) => sourceDirs.some((source) => within(real(source), dir));
	if (inside(real(out))) throw new TypeError("the output directory is inside a source the report reads");
	mkdirSync(out, { recursive: true });
	const dir = realpathSync(out);
	if (inside(dir)) throw new TypeError("the output directory is inside a source the report reads");
	const identity = lstatSync(dir);
	if (!identity.isDirectory()) throw new TypeError("the output directory is not a directory");
	const files: [string, string][] = [
		["report.json", canonicalEndoJsonV0(built.report)],
		["manifest.json", canonicalEndoJsonV0(built.manifest)],
		["summary.md", built.summary],
	];
	for (const [name] of files) {
		const s = lstatSync(join(dir, name), { throwIfNoEntry: false });
		if (s !== undefined && !s.isFile()) throw new TypeError(`the output ${name} exists and is not a plain file`);
	}
	const temporary: string[] = [];
	try {
		const written = files.map(([name, text]) => {
			const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
			const fd = openSync(tmp, createFlags, 0o644);
			temporary.push(tmp);
			try {
				writeSync(fd, text);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return [tmp, join(dir, name)] as const;
		});
		const now = lstatSync(dir, { throwIfNoEntry: false });
		if (
			now === undefined ||
			!now.isDirectory() ||
			now.dev !== identity.dev ||
			now.ino !== identity.ino ||
			realpathSync(dir) !== dir
		)
			throw new TypeError("the output directory changed while the report was written");
		for (const [name] of files) {
			const s = lstatSync(join(dir, name), { throwIfNoEntry: false });
			if (s !== undefined && !s.isFile()) throw new TypeError(`the output ${name} exists and is not a plain file`);
		}
		for (const [tmp, final] of written) {
			renameSync(tmp, final);
			temporary.splice(temporary.indexOf(tmp), 1);
		}
	} finally {
		for (const tmp of temporary) rmSync(tmp, { force: true });
	}
}

/** Every directory the corpus resolves to, for the output check. */
export function sourceDirectories(corpus: Corpus, roots: Roots): string[] {
	return corpus.sources.flatMap((s) => {
		const root = rootOf(roots, s.location);
		return root === null ? [] : [s.path === "." ? root : join(root, s.path)];
	});
}

function main(argv: string[]): void {
	const arg = (name: string): string | undefined => {
		const i = argv.indexOf(name);
		return i === -1 ? undefined : argv[i + 1];
	};
	const out = arg("--out");
	if (out === undefined) throw new TypeError("--out <dir> is required");
	const here = fileURLToPath(new URL("./", import.meta.url));
	const corpus = readCorpus(JSON.parse(readFileSync(arg("--corpus") ?? join(here, "corpus.v0.json"), "utf8")));
	const lessonsPath = arg("--lessons") ?? join(here, "lessons.v0.json");
	const lessons = existsSync(lessonsPath) ? readLessonFile(JSON.parse(readFileSync(lessonsPath, "utf8"))) : null;
	const casesPath = arg("--cases") ?? join(here, "applicability-cases.v0.json");
	const cases = existsSync(casesPath) ? readCases(JSON.parse(readFileSync(casesPath, "utf8"))) : [];
	const data = arg("--data") ?? researchDataRoot();
	const store = arg("--store");
	const roots: Roots = {
		repository: REPOSITORY,
		researchData: isDirectory(data) ? resolve(data) : null,
		store: store === undefined ? null : resolve(store),
	};
	const built = buildEligibility(corpus, roots, lessons, cases);
	writeOutputs(built, resolve(out), sourceDirectories(corpus, roots));
	const r = built.manifest as { readiness: ReadinessReport | null; report: { examples: number; sha256: string } };
	process.stdout.write(
		`${r.report.examples} examples; report sha256 ${r.report.sha256}${r.readiness === null ? "" : `; MEM-001 readiness ${r.readiness.overall.status}`}\n`,
	);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2));
