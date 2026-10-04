// The task pool of the discriminating-task-set study (DESIGN.md §4), read from `tasks/<id>/`:
//
//   prompt.md           the prompt, exactly as sent (its rules are numbered lines R1., R2., ...)
//   workspace/**        the starting files (for a debugging or editing task, including the README that states the rules)
//   hidden.test.mjs     the hidden check: node:test tests named `R<n>: ...`, importing the workspace through `__WORK__`
//   reference/**        files that overlay the workspace to give a correct solution
//   naive/**            files that overlay the workspace to give a plausible wrong solution
//
// The hidden check is never written into the workspace: the success check embeds its text and writes it to a temporary
// directory only when it runs.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentTaskV0 } from "../../../protocol/experiment-spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pool, in a fixed order (DESIGN §4). */
export const TASK_IDS = [
	"slot-pack",
	"ticket-code",
	"rolling-median",
	"booking-conflicts",
	"markup-lite",
	"tax-brackets",
	"route-normalize",
	"retry-schedule",
	"inventory-bugs",
	"report-bugs",
	"fetch-cache",
	"config-extends",
] as const;

export type TaskKindV0 = "implement" | "debug" | "edit";
export const TASK_KINDS: Readonly<Record<string, TaskKindV0>> = {
	"slot-pack": "implement",
	"ticket-code": "implement",
	"rolling-median": "implement",
	"booking-conflicts": "implement",
	"markup-lite": "implement",
	"tax-brackets": "implement",
	"route-normalize": "implement",
	"retry-schedule": "implement",
	"inventory-bugs": "debug",
	"report-bugs": "debug",
	"fetch-cache": "edit",
	"config-extends": "edit",
};

export interface DiscriminatingTaskV0 {
	id: string;
	kind: TaskKindV0;
	prompt: string;
	workspace: Record<string, string>;
	hidden: string;
	reference: Record<string, string>;
	naive: Record<string, string>;
}

function files(directory: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (path: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name);
			if (statSync(full).isDirectory()) walk(full);
			else out[relative(directory, full).split("\\").join("/")] = readFileSync(full, "utf8");
		}
	};
	try {
		walk(directory);
	} catch {
		// A task may have no overlay of one kind.
	}
	return out;
}

export function loadTaskV0(id: string, root: string = join(HERE, "tasks")): DiscriminatingTaskV0 {
	const dir = join(root, id);
	return {
		id,
		kind: TASK_KINDS[id]!,
		prompt: readFileSync(join(dir, "prompt.md"), "utf8").trimEnd(),
		workspace: files(join(dir, "workspace")),
		hidden: readFileSync(join(dir, "hidden.test.mjs"), "utf8"),
		reference: files(join(dir, "reference")),
		naive: files(join(dir, "naive")),
	};
}

export const loadPoolV0 = (root?: string): DiscriminatingTaskV0[] => TASK_IDS.map((id) => loadTaskV0(id, root));

/**
 * The success check's argv: write the hidden check to a directory beside the working directory (with `__WORK__`
 * replaced by the working directory's file URL), run it with `node --test`, and exit with its status. The directory is
 * beside the workspace, so inside the scratch root when the runner runs it (no random path in the recorded output, and
 * nothing outside the scratch root), and nothing is written into the workspace.
 */
export function hiddenCheckArgv(hidden: string): string[] {
	const script = [
		'const { mkdirSync, writeFileSync, rmSync } = require("node:fs");',
		'const { basename, dirname, join } = require("node:path");',
		'const { pathToFileURL } = require("node:url");',
		'const { spawnSync } = require("node:child_process");',
		`const hidden = ${JSON.stringify(hidden)};`,
		'const dir = join(dirname(process.cwd()), "hidden-check-" + basename(process.cwd()));',
		"rmSync(dir, { recursive: true, force: true });",
		"mkdirSync(dir, { recursive: true });",
		'const file = join(dir, "hidden.test.mjs");',
		'writeFileSync(file, hidden.replaceAll("__WORK__", pathToFileURL(process.cwd() + "/").href));',
		'const run = spawnSync(process.execPath, ["--test", file], { stdio: "inherit", timeout: 50000 });',
		"rmSync(dir, { recursive: true, force: true });",
		"process.exit(run.status ?? 1);",
	].join("\n");
	return ["node", "-e", script];
}

/** The experiment task for a pool task (cli/experiment.ts's spec): the prompt, the workspace and the hidden check. */
export function experimentTaskV0(task: DiscriminatingTaskV0): EndoExperimentTaskV0 {
	return {
		id: task.id,
		prompts: [task.prompt],
		workspace: task.workspace,
		check: { argv: hiddenCheckArgv(task.hidden), timeoutMs: 60_000 },
	};
}

/** The rule numbers a text states, as lines `R<n>.`. */
export function statedRules(text: string): number[] {
	return [...text.matchAll(/^R(\d+)\./gm)].map((match) => Number(match[1]));
}

/** The rule numbers a hidden check tests, as tests named `R<n>: ...`. */
export function testedRules(hidden: string): number[] {
	return [...hidden.matchAll(/\btest\(\s*["'`]R(\d+):/g)].map((match) => Number(match[1]));
}
