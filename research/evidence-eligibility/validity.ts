// Study validity, read from the studies' own committed analyses. Each reader knows exactly one analysis format and refuses any other shape;
// it never re-derives a verdict. What a study did not record by name stays unresolved: a count of excluded trials without their identities
// makes every trial of that cell unresolved, not valid.

import type { ValidityReader } from "./corpus.ts";

export type ArmStatus = "valid" | "invalid" | "checks-incomplete";

/** One run's validity as its study recorded it. */
export interface RunValidity {
	/** The repository-relative analysis file and its sha256. */
	file: string;
	fileSha256: string;
	/** By condition id; `*` applies to every condition of the run. */
	arms: Record<string, ArmStatus>;
	/** `task/condition/trial` keys the study excluded by name. */
	excluded: string[];
	/** Tasks whose excluded trials the study counted without naming them. */
	unresolvedTasks: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (reader: string, what: string): never => {
	throw new TypeError(`${reader}: ${what}`);
};

/** The validity of each run label (the run directory's last path segment) the analysis covers. */
export function readStudyValidity(
	reader: ValidityReader,
	value: unknown,
	file: { path: string; sha256: string },
	labels: readonly string[],
): Map<string, RunValidity> {
	return reader === "completion-cap-analysis.v0"
		? completionCap(value, file, labels)
		: discriminatingTasks(value, file, labels);
}

function completionCap(value: unknown, file: { path: string; sha256: string }, labels: readonly string[]) {
	const r = "completion-cap-analysis.v0";
	if (!isObject(value)) return fail(r, "not an object");
	const { paths, armValidity, sensitivity, cells } = value;
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) return fail(r, "paths");
	if (!isObject(armValidity)) return fail(r, "armValidity");
	if (!isObject(sensitivity) || !Array.isArray(sensitivity.invalidTrials)) return fail(r, "sensitivity.invalidTrials");
	if (!Array.isArray(cells)) return fail(r, "cells");
	const arms: Record<string, ArmStatus> = {};
	for (const [arm, v] of Object.entries(armValidity)) {
		if (!isObject(v) || typeof v.valid !== "boolean") return fail(r, `armValidity.${arm}`);
		arms[`arm-${arm}`] = v.valid ? "valid" : "invalid";
	}
	const byPath = new Map<string, string[]>();
	for (const t of sensitivity.invalidTrials) {
		if (
			!isObject(t) ||
			typeof t.path !== "string" ||
			typeof t.arm !== "string" ||
			typeof t.task !== "string" ||
			!Number.isSafeInteger(t.trial)
		)
			return fail(r, "an invalid trial");
		const list = byPath.get(t.path) ?? [];
		list.push(`${t.task}/arm-${t.arm}/${t.trial}`);
		byPath.set(t.path, list);
	}
	// The named exclusions must account for every invalid trial the cells count; otherwise the cells with a shortfall are unresolved.
	const named = new Map<string, number>();
	for (const list of byPath.values())
		for (const key of list) {
			const [task, condition] = key.split("/");
			named.set(`${task}/${condition}`, (named.get(`${task}/${condition}`) ?? 0) + 1);
		}
	const unresolved = new Set<string>();
	for (const c of cells) {
		if (!isObject(c) || typeof c.arm !== "string" || typeof c.task !== "string" || !Number.isSafeInteger(c.invalid))
			return fail(r, "a cell");
		if ((named.get(`${c.task}/arm-${c.arm}`) ?? 0) !== c.invalid) unresolved.add(c.task);
	}
	const out = new Map<string, RunValidity>();
	for (const label of labels) {
		if (!paths.includes(label)) continue;
		out.set(label, {
			file: file.path,
			fileSha256: file.sha256,
			arms: { ...arms },
			excluded: [...(byPath.get(label) ?? [])].sort(),
			unresolvedTasks: [...unresolved].sort(),
		});
	}
	return out;
}

const PASS = (v: unknown): boolean => v === "PASS" || (isObject(v) && v.status === "PASS");

function discriminatingTasks(value: unknown, file: { path: string; sha256: string }, labels: readonly string[]) {
	const r = "discriminating-tasks-analysis.v0";
	if (!isObject(value)) return fail(r, "not an object");
	const { validity, tasks } = value;
	if (!isObject(validity) || !Array.isArray(tasks)) return fail(r, "validity or tasks");
	const unresolved: string[] = [];
	for (const t of tasks) {
		if (!isObject(t) || typeof t.task !== "string" || !Number.isSafeInteger(t.invalid)) return fail(r, "a task");
		// The analysis counts invalid trials per task over every path and never names them.
		if ((t.invalid as number) > 0) unresolved.push(t.task);
	}
	// Either one set of checks for the single run (the screen), or one per path label (the confirmation).
	const single = Object.keys(validity).every((k) => /^M/.test(k));
	const status = (checks: unknown): ArmStatus => {
		if (!isObject(checks) || Object.keys(checks).length === 0) return fail(r, "a validity entry");
		return Object.values(checks).every(PASS) ? "valid" : "checks-incomplete";
	};
	const out = new Map<string, RunValidity>();
	for (const label of labels) {
		const checks = single ? validity : validity[label];
		if (checks === undefined) continue;
		out.set(label, {
			file: file.path,
			fileSha256: file.sha256,
			arms: { "*": status(checks) },
			excluded: [],
			unresolvedTasks: [...unresolved].sort(),
		});
	}
	return out;
}
