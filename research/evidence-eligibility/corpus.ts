// The corpus file (`endo.evidence-corpus.v0`): which sources the projection reads, which study analyses it cites for validity, and which
// facts are declared by a document rather than observed. Strict: an unknown field, an unknown version or an unknown reader is refused,
// never ignored. The corpus names locations by role (`repository`, `research-data`, `store`), never by absolute path, so the same file
// describes the same corpus on any machine.

import { ENDO_EVIDENCE_CORPUS_V0 } from "./contract.ts";

export type Location = "repository" | "research-data" | "store";
const LOCATIONS: readonly Location[] = ["repository", "research-data", "store"];

export interface CorpusSource {
	id: string;
	kind: "experiment-run" | "develop-store";
	study: string | null;
	stage: string | null;
	location: Location;
	/** Relative to the location; `children` reads each immediate subdirectory holding an experiment.json as its own run. */
	path: string;
	children: boolean;
}

export type ValidityReader = "completion-cap-analysis.v0" | "discriminating-tasks-analysis.v0";
const READERS: readonly ValidityReader[] = ["completion-cap-analysis.v0", "discriminating-tasks-analysis.v0"];

export interface CorpusValidity {
	study: string;
	stage: string;
	reader: ValidityReader;
	/** Repository-relative path of the committed analysis file. */
	file: string;
}

export type CorpusDeclaration =
	| { kind: "run-invalid"; source: string; document: string; note: string }
	| { kind: "task-examined"; study: string; task: string; document: string; note: string };

export interface Corpus {
	schemaVersion: typeof ENDO_EVIDENCE_CORPUS_V0;
	id: string;
	description: string;
	sources: CorpusSource[];
	validity: CorpusValidity[];
	declarations: CorpusDeclaration[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SLUG = /^[a-z0-9][a-z0-9._/-]{0,200}$/;
const RELATIVE = /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]{1,400}$/;

function closed(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
	if (!isObject(value)) throw new TypeError(`${what} is not an object`);
	for (const k of Object.keys(value))
		if (!keys.includes(k)) throw new TypeError(`${what}: unknown field ${JSON.stringify(k)}`);
	for (const k of keys) if (!(k in value)) throw new TypeError(`${what}: missing field ${JSON.stringify(k)}`);
	return value;
}
const text = (v: unknown, what: string, pattern?: RegExp): string => {
	if (typeof v !== "string" || v.length === 0 || v.length > 2000 || (pattern !== undefined && !pattern.test(v)))
		throw new TypeError(`${what} is not acceptable`);
	return v;
};
const nullable = (v: unknown, what: string): string | null => (v === null ? null : text(v, what, SLUG));

/** The corpus, exactly as written, or a TypeError naming the problem. */
export function readCorpus(value: unknown): Corpus {
	const root = closed(value, ["schemaVersion", "id", "description", "sources", "validity", "declarations"], "corpus");
	if (root.schemaVersion !== ENDO_EVIDENCE_CORPUS_V0)
		throw new TypeError(`corpus: unsupported version ${JSON.stringify(root.schemaVersion)}`);
	if (!Array.isArray(root.sources) || !Array.isArray(root.validity) || !Array.isArray(root.declarations))
		throw new TypeError("corpus: sources, validity and declarations must be arrays");
	const ids = new Set<string>();
	const sources = root.sources.map((s, i): CorpusSource => {
		const o = closed(s, ["id", "kind", "study", "stage", "location", "path", "children"], `sources[${i}]`);
		const id = text(o.id, `sources[${i}].id`, SLUG);
		if (ids.has(id)) throw new TypeError(`sources[${i}]: duplicate id ${id}`);
		ids.add(id);
		if (o.kind !== "experiment-run" && o.kind !== "develop-store")
			throw new TypeError(`sources[${i}].kind is unknown`);
		if (!LOCATIONS.includes(o.location as Location)) throw new TypeError(`sources[${i}].location is unknown`);
		if (typeof o.children !== "boolean") throw new TypeError(`sources[${i}].children is not a boolean`);
		const path = o.path === "." ? "." : text(o.path, `sources[${i}].path`, RELATIVE);
		return {
			id,
			kind: o.kind,
			study: nullable(o.study, `sources[${i}].study`),
			stage: nullable(o.stage, `sources[${i}].stage`),
			location: o.location as Location,
			path,
			children: o.children,
		};
	});
	const validity = root.validity.map((v, i): CorpusValidity => {
		const o = closed(v, ["study", "stage", "reader", "file"], `validity[${i}]`);
		if (!READERS.includes(o.reader as ValidityReader)) throw new TypeError(`validity[${i}].reader is unknown`);
		return {
			study: text(o.study, `validity[${i}].study`, SLUG),
			stage: text(o.stage, `validity[${i}].stage`, SLUG),
			reader: o.reader as ValidityReader,
			file: text(o.file, `validity[${i}].file`, RELATIVE),
		};
	});
	const declarations = root.declarations.map((d, i): CorpusDeclaration => {
		if (!isObject(d)) throw new TypeError(`declarations[${i}] is not an object`);
		if (d.kind === "run-invalid") {
			const o = closed(d, ["kind", "source", "document", "note"], `declarations[${i}]`);
			return {
				kind: "run-invalid",
				source: text(o.source, `declarations[${i}].source`, SLUG),
				document: text(o.document, `declarations[${i}].document`, RELATIVE),
				note: text(o.note, `declarations[${i}].note`),
			};
		}
		if (d.kind === "task-examined") {
			const o = closed(d, ["kind", "study", "task", "document", "note"], `declarations[${i}]`);
			return {
				kind: "task-examined",
				study: text(o.study, `declarations[${i}].study`, SLUG),
				task: text(o.task, `declarations[${i}].task`, SLUG),
				document: text(o.document, `declarations[${i}].document`, RELATIVE),
				note: text(o.note, `declarations[${i}].note`),
			};
		}
		throw new TypeError(`declarations[${i}].kind is unknown`);
	});
	return {
		schemaVersion: ENDO_EVIDENCE_CORPUS_V0,
		id: text(root.id, "id", SLUG),
		description: text(root.description, "description"),
		sources,
		validity,
		declarations,
	};
}
