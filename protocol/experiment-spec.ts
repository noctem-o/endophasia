// The experiment spec (`endo.experiment-spec.v0`): what `endo experiment run` runs. A task set, the trial count N, the
// conditions, the ordering seed, and the serving inputs to use. Everything the runner records about the serving stack
// (model ids, sampling parameters as Pi sent them, the Pi fingerprint, the digest domain) is observed at run time and
// written beside the results, never declared here.
//
// A condition changes only Pi's documented configuration (docs/models.md, docs/settings.md): fields merged into the
// models.json model entry, and a settings.json. Requests are never altered in flight: the proxy is pass-through.
//
// A task is one or more prompts in a fresh scratch workspace built from a template, with an optional deterministic
// success check: a command (argv, no shell) run in the workspace after the session; exit code 0 passes.

import { isEndoIdentifierV0 } from "./identity.ts";
import { isPlainJsonObjectV0, type JsonValueV0 } from "./primitives.ts";

export const ENDO_EXPERIMENT_SPEC_SCHEMA_V0 = "endo.experiment-spec.v0";

export interface EndoExperimentCheckV0 {
	/** The command and its arguments; run without a shell, in the workspace (`cwd` relative to it). */
	argv: string[];
	cwd?: string;
	timeoutMs?: number;
}

export interface EndoExperimentTaskV0 {
	/** A slug: [a-z0-9-], at most 64 characters. */
	id: string;
	/** The prompts, sent in order; each runs to agent_settled. */
	prompts: string[];
	/** The workspace template: relative path to file content. */
	workspace: { [path: string]: string };
	check?: EndoExperimentCheckV0;
}

export interface EndoExperimentConditionV0 {
	/** A slug: [a-z0-9-], at most 64 characters. */
	id: string;
	description: string;
	/** Fields merged into the models.json model entry (Pi's documented model configuration). */
	modelEntry?: { [key: string]: JsonValueV0 };
	/** Pi's settings.json for this condition (documented settings only). */
	settings?: { [key: string]: JsonValueV0 };
}

export interface EndoExperimentSpecV0 {
	schemaVersion: typeof ENDO_EXPERIMENT_SPEC_SCHEMA_V0;
	/** `endo.experiment.*` */
	id: string;
	description: string;
	/** Trials per (task, condition). */
	trials: number;
	/** The ordering seed: an unsigned 32-bit integer, or null to draw one at the first run (it is then recorded). */
	seed: number | null;
	/** The Pi executable. */
	pi: string;
	/** The OpenAI-compatible upstream origin. */
	upstream: string;
	provider: string;
	model: string;
	/** "installation" (default use) or "fixture" (the committed public key: synthetic fixture experiments only). */
	digestDomain: "installation" | "fixture";
	/** Per-step timeout. */
	timeoutMs: number;
	tasks: EndoExperimentTaskV0[];
	conditions: EndoExperimentConditionV0[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SPEC_KEYS = new Set([
	"schemaVersion",
	"id",
	"description",
	"trials",
	"seed",
	"pi",
	"upstream",
	"provider",
	"model",
	"digestDomain",
	"timeoutMs",
	"tasks",
	"conditions",
]);

function text(value: unknown, max = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function plain(value: unknown): value is { [key: string]: JsonValueV0 } {
	return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainJsonObjectV0(value);
}

function relativePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!path.includes("\0") &&
		path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}

/** Why `value` is not a valid spec, or null when it is. */
export function endoExperimentSpecProblemV0(value: unknown): string | null {
	if (!plain(value)) return "the spec is not a JSON object";
	const v = value as Record<string, unknown>;
	for (const key of Object.keys(v)) if (!SPEC_KEYS.has(key)) return `unknown field ${key}`;
	if (v.schemaVersion !== ENDO_EXPERIMENT_SPEC_SCHEMA_V0)
		return `schemaVersion must be ${ENDO_EXPERIMENT_SPEC_SCHEMA_V0}`;
	if (typeof v.id !== "string" || !isEndoIdentifierV0(v.id, "experiment"))
		return "id must be an endo.experiment.* identifier";
	if (!text(v.description)) return "description is required";
	if (typeof v.trials !== "number" || !Number.isInteger(v.trials) || v.trials < 1 || v.trials > 10_000)
		return "trials must be an integer from 1 to 10000";
	if (
		v.seed !== null &&
		(typeof v.seed !== "number" || !Number.isInteger(v.seed) || v.seed < 0 || v.seed > 0xffffffff)
	)
		return "seed must be an unsigned 32-bit integer or null";
	for (const key of ["pi", "upstream", "provider", "model"] as const)
		if (!text(v[key], 1024)) return `${key} is required`;
	if (v.digestDomain !== "installation" && v.digestDomain !== "fixture")
		return "digestDomain must be installation or fixture";
	if (typeof v.timeoutMs !== "number" || !Number.isInteger(v.timeoutMs) || v.timeoutMs < 1000)
		return "timeoutMs must be an integer of at least 1000";
	if (!Array.isArray(v.tasks) || v.tasks.length === 0) return "tasks must be a non-empty list";
	const taskIds = new Set<string>();
	for (const task of v.tasks) {
		if (!plain(task)) return "a task is not an object";
		const t = task as Record<string, unknown>;
		for (const key of Object.keys(t))
			if (!["id", "prompts", "workspace", "check"].includes(key)) return `unknown task field ${key}`;
		if (typeof t.id !== "string" || !SLUG.test(t.id)) return "a task id must be a slug ([a-z0-9-], at most 64)";
		if (taskIds.has(t.id)) return `duplicate task ${t.id}`;
		taskIds.add(t.id);
		if (!Array.isArray(t.prompts) || t.prompts.length === 0 || !t.prompts.every((prompt) => text(prompt, 65_536)))
			return `task ${t.id}: prompts must be a non-empty list of strings`;
		if (!plain(t.workspace)) return `task ${t.id}: workspace must be an object of path to content`;
		for (const [path, content] of Object.entries(t.workspace))
			if (!relativePath(path) || typeof content !== "string") return `task ${t.id}: bad workspace entry ${path}`;
		if (t.check !== undefined) {
			if (!plain(t.check)) return `task ${t.id}: check must be an object`;
			const c = t.check as Record<string, unknown>;
			for (const key of Object.keys(c))
				if (!["argv", "cwd", "timeoutMs"].includes(key)) return `task ${t.id}: unknown check field ${key}`;
			if (
				!Array.isArray(c.argv) ||
				c.argv.length === 0 ||
				!c.argv.every((arg) => typeof arg === "string" && arg.length > 0)
			)
				return `task ${t.id}: check.argv must be a non-empty list of strings`;
			if (c.cwd !== undefined && (typeof c.cwd !== "string" || !relativePath(c.cwd)))
				return `task ${t.id}: check.cwd must be relative`;
			if (
				c.timeoutMs !== undefined &&
				(typeof c.timeoutMs !== "number" || !Number.isInteger(c.timeoutMs) || c.timeoutMs < 1)
			)
				return `task ${t.id}: check.timeoutMs must be a positive integer`;
		}
	}
	if (!Array.isArray(v.conditions) || v.conditions.length === 0) return "conditions must be a non-empty list";
	const conditionIds = new Set<string>();
	for (const condition of v.conditions) {
		if (!plain(condition)) return "a condition is not an object";
		const c = condition as Record<string, unknown>;
		for (const key of Object.keys(c))
			if (!["id", "description", "modelEntry", "settings"].includes(key)) return `unknown condition field ${key}`;
		if (typeof c.id !== "string" || !SLUG.test(c.id)) return "a condition id must be a slug ([a-z0-9-], at most 64)";
		if (conditionIds.has(c.id)) return `duplicate condition ${c.id}`;
		conditionIds.add(c.id);
		if (!text(c.description)) return `condition ${c.id}: description is required`;
		if (c.modelEntry !== undefined && !plain(c.modelEntry)) return `condition ${c.id}: modelEntry must be an object`;
		if (c.modelEntry !== undefined && "id" in (c.modelEntry as object))
			return `condition ${c.id}: modelEntry may not change the model id`;
		if (c.settings !== undefined && !plain(c.settings)) return `condition ${c.id}: settings must be an object`;
	}
	return null;
}

/** The spec, validated; throws TypeError with the reason otherwise. */
export function validateEndoExperimentSpecV0(value: unknown): EndoExperimentSpecV0 {
	const problem = endoExperimentSpecProblemV0(value);
	if (problem !== null) throw new TypeError(`not a valid ${ENDO_EXPERIMENT_SPEC_SCHEMA_V0}: ${problem}`);
	return value as EndoExperimentSpecV0;
}
