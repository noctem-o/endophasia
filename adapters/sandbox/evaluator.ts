// The independent evaluator of protected experiments (endo.function-evaluator.v0): the trusted controller decides the result, in its own
// process, from results computed in a separate sandbox.
//
// The evaluation sandbox holds, read-only, the exported copy of the submission, a trusted driver (pinned by digest) and the cases' INPUTS
// only. The cases' expected results never enter any sandbox. The driver calls the submitted function once per input and prints the
// results; the submission's code runs there too, so it can print anything, but it cannot produce a pass without producing the expected
// results, which it never sees. The agent's workspace, its environment and its own test output play no part.
//
// Before any trial runs, the evaluator is qualified: a known-correct reference must pass every case, and a declared negative must fail.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type EndoFunctionEvaluatorV0,
	type EndoProtectedLimitsV0,
	type EndoProtectedTrialV0,
	readEndoFunctionEvaluatorV0,
} from "../../protocol/protected-experiment.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	buildSandboxProfileV0,
	type EndoBubblewrapV0,
	type EndoRuntimeFileV0,
	type EndoSandboxProfileV0,
	runSandboxV0,
} from "./bubblewrap.ts";
import type { EndoContainmentV0 } from "./containment.ts";
import { exportSubmissionV0 } from "./submission.ts";

/** The trusted driver. It is the evaluator's control logic; the submission is only ever the module it imports. */
export const ENDO_EVALUATOR_DRIVER_V0 = String.raw`import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const job = JSON.parse(readFileSync("/eval/inputs.json", "utf8"));
const results = [];
let fn = null;
try {
	const mod = await import(pathToFileURL("/submission/" + job.entry).href);
	fn = typeof mod[job.export] === "function" ? mod[job.export] : null;
} catch {
	fn = null;
}
for (const args of job.inputs) {
	if (fn === null) { results.push({ ok: false }); continue; }
	try {
		const value = await fn(...structuredClone(args));
		const text = JSON.stringify(value);
		results.push(text === undefined ? { ok: false } : { ok: true, value: JSON.parse(text) });
	} catch {
		results.push({ ok: false });
	}
}
process.stdout.write("\nENDO-EVALUATION " + JSON.stringify(results) + "\n");
`;
export const ENDO_EVALUATOR_DRIVER_SHA256_V0 = sha256HexV0(ENDO_EVALUATOR_DRIVER_V0);

export interface EndoLoadedEvaluatorV0 {
	definition: EndoFunctionEvaluatorV0;
	sha256: string;
	/** The definition file and its directory, by real path (a link to the definition resolves to where its material really is). */
	file: string;
	directory: string;
}

/** The evaluator definition, read from the operator's file and checked against the digest the spec pins. */
export function loadEvaluatorV0(
	file: string,
	pinned: string,
	submission: readonly string[],
): { ok: true; evaluator: EndoLoadedEvaluatorV0 } | { ok: false; detail: string } {
	let bytes: Buffer;
	try {
		bytes = readFileSync(file);
	} catch {
		return { ok: false, detail: "the evaluator definition could not be read" };
	}
	const sha256 = sha256HexV0(bytes);
	if (sha256 !== pinned) return { ok: false, detail: "the evaluator definition is not the one the spec pins" };
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		return { ok: false, detail: "the evaluator definition is not JSON" };
	}
	const read = readEndoFunctionEvaluatorV0(value);
	if (!read.ok) return { ok: false, detail: read.message };
	if (!submission.includes(read.value.entry))
		return { ok: false, detail: "the evaluator's entry is not a submitted file" };
	const real = realpathSync(file);
	return { ok: true, evaluator: { definition: read.value, sha256, file: real, directory: dirname(real) } };
}

export type EndoEvaluationV0 = Pick<EndoProtectedTrialV0["evaluation"], "status" | "cases" | "reason" | "outputSha256">;

export interface EndoEvaluatorContextV0 {
	bwrap: EndoBubblewrapV0;
	containment: EndoContainmentV0;
	runtime: readonly EndoRuntimeFileV0[];
	node: string;
	limits: EndoProtectedLimitsV0;
}

/** The evaluation sandbox's profile for one submission copy. */
export function evaluationProfileV0(
	ctx: EndoEvaluatorContextV0,
	submissionDir: string,
	jobDir: string,
	job: string,
): EndoSandboxProfileV0 {
	return buildSandboxProfileV0({
		runtime: ctx.runtime,
		mounts: [
			{ target: "/submission", kind: "ro-dir", role: "submission-copy", source: submissionDir },
			{
				target: "/eval/driver.mjs",
				kind: "ro-file",
				role: "evaluator-driver",
				source: join(jobDir, "driver.mjs"),
				sha256: ENDO_EVALUATOR_DRIVER_SHA256_V0,
			},
			{
				target: "/eval/inputs.json",
				kind: "ro-file",
				role: "evaluator-inputs",
				source: join(jobDir, "inputs.json"),
				sha256: sha256HexV0(job),
			},
		],
		env: { HOME: "/home/agent", PATH: "/usr/bin", TMPDIR: "/tmp" },
		cwd: "/tmp",
		tmpfsBytes: ctx.limits.tmpfsBytes,
	});
}

/** Evaluate one exported submission copy. `jobDir` is a new controller-private directory for the driver and the inputs. */
export async function evaluateV0(
	ctx: EndoEvaluatorContextV0,
	evaluator: EndoLoadedEvaluatorV0,
	submissionDir: string,
	jobDir: string,
	record: Pick<Parameters<typeof runSandboxV0>[3], "onScope" | "onLauncher"> = {},
): Promise<EndoEvaluationV0> {
	const d = evaluator.definition;
	mkdirSync(jobDir, { mode: 0o700 });
	const job = canonicalEndoJsonV0({ entry: d.entry, export: d.export, inputs: d.cases.map((c) => c.input) });
	writeFileSync(join(jobDir, "driver.mjs"), ENDO_EVALUATOR_DRIVER_V0, { mode: 0o444, flag: "wx" });
	writeFileSync(join(jobDir, "inputs.json"), job, { mode: 0o444, flag: "wx" });
	let run: Awaited<ReturnType<typeof runSandboxV0>>;
	try {
		run = await runSandboxV0(
			ctx.bwrap,
			evaluationProfileV0(ctx, submissionDir, jobDir, job),
			[ctx.node, "/eval/driver.mjs"],
			{
				timeoutMs: ctx.limits.evaluationTimeoutMs,
				outputBytes: ctx.limits.outputBytes,
				containment: ctx.containment,
				...record,
			},
		);
	} catch {
		return {
			status: "could-not-run",
			cases: null,
			reason: "the evaluation sandbox could not be launched",
			outputSha256: null,
		};
	}
	const outputSha256 = sha256HexV0(Buffer.concat([run.stdout, run.stderr]));
	if (!run.started)
		return { status: "could-not-run", cases: null, reason: "the evaluation sandbox did not start", outputSha256 };
	if (run.termination !== "confirmed")
		return { status: "could-not-run", cases: null, reason: "the evaluation sandbox did not end", outputSha256 };
	if (run.timedOut) return { status: "failed", cases: null, reason: "timed-out", outputSha256 };
	const frames = run.stdout
		.toString("utf8")
		.split("\n")
		.filter((l) => l.startsWith("ENDO-EVALUATION "));
	if (frames.length !== 1 || run.truncated.stdout > 0)
		return {
			status: "failed",
			cases: null,
			reason: frames.length === 0 ? "no-result" : "ambiguous-result",
			outputSha256,
		};
	let results: unknown;
	try {
		results = JSON.parse((frames[0] as string).slice("ENDO-EVALUATION ".length));
	} catch {
		return { status: "failed", cases: null, reason: "unreadable-result", outputSha256 };
	}
	if (!Array.isArray(results) || results.length !== d.cases.length)
		return { status: "failed", cases: null, reason: "wrong-result-count", outputSha256 };
	let passed = 0;
	d.cases.forEach((c, i) => {
		const r = results[i] as { ok?: unknown; value?: unknown } | null;
		if (r === null || typeof r !== "object" || r.ok !== true || !("value" in r)) return;
		try {
			if (canonicalEndoJsonV0(r.value) === canonicalEndoJsonV0(c.expected)) passed++;
		} catch {
			// not plain JSON: not the expected value
		}
	});
	const total = d.cases.length;
	return { status: passed === total ? "passed" : "failed", cases: { total, passed }, reason: null, outputSha256 };
}

/**
 * Qualify an evaluator before any trial: its reference (exported under the task's own submission policy) must pass every case, and its
 * negative, when declared, must fail. Anything else refuses the run.
 */
export async function qualifyEvaluatorV0(
	ctx: EndoEvaluatorContextV0,
	evaluator: EndoLoadedEvaluatorV0,
	submission: readonly string[],
	scratch: string,
): Promise<{ ok: true; negative: "failed" | null } | { ok: false; detail: string }> {
	const d = evaluator.definition;
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const check = async (name: "reference" | "negative", relative: string) => {
		const copy = join(scratch, `${name}-submission`);
		const exported = exportSubmissionV0(join(evaluator.directory, relative), submission, ctx.limits, copy);
		if (exported.status !== "collected") return { status: "not-collected" as const };
		return evaluateV0(ctx, evaluator, copy, join(scratch, `${name}-job`));
	};
	const reference = await check("reference", d.reference);
	if (reference.status !== "passed")
		return { ok: false, detail: `the evaluator's reference did not pass (${reference.status})` };
	if (d.negative === null) return { ok: true, negative: null };
	const negative = await check("negative", d.negative);
	if (negative.status !== "failed")
		return { ok: false, detail: `the evaluator's negative did not fail (${negative.status})` };
	return { ok: true, negative: "failed" };
}
