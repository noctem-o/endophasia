// Generates the completion-cap study's experiment specs (DESIGN.md §4, §6, §8) from one source:
//
//   node research/completion-cap/1.0.1/make-spec.ts pilot            -> spec-pilot.json (1 path, 2 trials per cell)
//
// The main specs are made at run time (`mainSpec`): one spec per path holding every arm as a condition, so the runner's
// blocked randomization interleaves the arms; paths differ only in `id`. Everything here is synthetic.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndoExperimentSpecV0 } from "../../../protocol/experiment-spec.ts";
import { experimentTaskV0, loadTaskV0 } from "../../discriminating-tasks/1.0.1/tasks.ts";
import { PINNED } from "../../pinned-environment/1.0.1/make-spec.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The session timeout, for every arm (DESIGN §3). */
export const TIMEOUT_MS = 3_600_000;
export const TASKS = ["booking-conflicts", "config-extends", "fetch-cache", "markup-lite"] as const;
export const PRIMARY_TASKS = ["fetch-cache", "markup-lite"] as const;
export const BRIEF_SENTENCE =
	"Keep your reasoning short: decide on an approach quickly, write the code, run the tests, and fix what fails.";

const handler = (body: string) =>
	`// Endophasia completion-cap study arm (DESIGN.md §4). A documented before_provider_request handler.\nexport default function (pi: any) {\n\tpi.on("before_provider_request", (event: any) => ${body});\n}\n`;

const systemWith = (sentence: string) =>
	`{\n\t\tconst messages = (event.payload.messages ?? []).map((message: any, index: number) =>\n\t\t\tindex === 0 && message.role === "system"\n\t\t\t\t? { ...message, content: typeof message.content === "string" ? \`\${message.content}\\n\\n\${${JSON.stringify(sentence)}}\` : [...message.content, { type: "text", text: ${JSON.stringify(sentence)} }] }\n\t\t\t\t: message,\n\t\t);\n\t\treturn { ...event.payload, messages };\n\t}`;

/** The arms (DESIGN §4): what each handler does, and the request fields it must leave in every request (M-inj). */
export const ARMS = {
	a: {
		description: "A: Pi's defaults (cap 16384), a no-op handler",
		source: handler("undefined"),
		cap: 16384,
		extra: {},
	},
	b: {
		description: "B: cap 32768",
		source: handler("({ ...event.payload, max_completion_tokens: 32768 })"),
		cap: 32768,
		extra: {},
	},
	c: {
		description: "C: cap 49152",
		source: handler("({ ...event.payload, max_completion_tokens: 49152 })"),
		cap: 49152,
		extra: {},
	},
	d: {
		description: "D: cap 16384, one sentence appended to the system message",
		source: handler(systemWith(BRIEF_SENTENCE)),
		cap: 16384,
		extra: {},
	},
	e: {
		description: "E: cap 16384, thinking off per request (chat_template_kwargs)",
		source: handler("({ ...event.payload, chat_template_kwargs: { enable_thinking: false } })"),
		cap: 16384,
		extra: { chat_template_kwargs: { enable_thinking: false } },
	},
} as const;
export type ArmIdV0 = keyof typeof ARMS;
export const ARM_IDS = Object.keys(ARMS) as ArmIdV0[];

const BASE = {
	schemaVersion: "endo.experiment-spec.v0" as const,
	seed: null,
	pi: "/usr/bin/pi",
	upstream: "http://127.0.0.1:8080",
	provider: "endolocal",
	model: "qwen3.8-27b",
	digestDomain: "fixture" as const,
	timeoutMs: TIMEOUT_MS,
};

function build(id: string, description: string, trials: number, arms: readonly ArmIdV0[]): EndoExperimentSpecV0 {
	return {
		...BASE,
		id,
		description,
		trials,
		tasks: TASKS.map((task) => experimentTaskV0(loadTaskV0(task))),
		conditions: arms.map((arm) => ({
			id: `arm-${arm}`,
			description: ARMS[arm].description,
			extensions: { "endo-arm.ts": ARMS[arm].source },
			environment: PINNED,
		})),
	};
}

/** The pilot: one path, every arm, 2 trials per cell (DESIGN §6). */
export const pilotSpec = (arms: readonly ArmIdV0[] = ARM_IDS): EndoExperimentSpecV0 =>
	build(
		"endo.experiment.completion-cap-1.0.1-pilot",
		"Completion-cap study pilot (research/completion-cap/1.0.1/DESIGN.md §6)",
		2,
		arms,
	);

/** One path of the main run: every arm, N trials per cell. Only `id` and `description` differ between paths. */
export function mainSpec(label: string, trials: number, arms: readonly ArmIdV0[]): EndoExperimentSpecV0 {
	if (!/^[a-z0-9-]{1,40}$/.test(label))
		throw new TypeError(`a path label is [a-z0-9-], at most 40 characters: ${label}`);
	if (!Number.isInteger(trials) || trials < 1) throw new TypeError("trials must be a positive integer");
	return build(
		`endo.experiment.completion-cap-1.0.1-${label}`,
		`Completion-cap study, path ${label} (DESIGN.md §8)`,
		trials,
		arms,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(join(HERE, "spec-pilot.json"), `${JSON.stringify(pilotSpec(), null, "\t")}\n`);
}
