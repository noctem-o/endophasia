// Research building block. Not an operator-facing command: a real server observer is not yet supplied.
import { closeSync, constants, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	approveContinuationTurnV0,
	approveInitialContinuationV0,
	executeInitialContinuationV0,
	preflightInitialContinuationV0,
	verifyInitialContinuationEvidenceV0,
} from "../../../cli/initial-continuation.ts";
import type {
	InitialContinuationBoundaryV0,
	InitialContinuationPlanV0,
} from "../../../protocol/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0 } from "../../../runtime/contracts/keyed-digest.ts";
import { readStudy, sealSlot, slotPath } from "./reader.ts";
import { commonTemplate, readStudyPlan } from "./study-plan.ts";

/** Caller callbacks are trusted test/operator inputs, not evidence of a human or of server identity. */
export interface CoordinatorHooks {
	checkEnvironment: () => Promise<boolean>;
	first: (plan: InitialContinuationPlanV0, phrase: string) => Promise<string | null>;
	second: (boundary: InitialContinuationBoundaryV0, phrase: string) => Promise<string | null>;
}
function publishExclusive(file: string, value: unknown): void {
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const parent = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
async function checkUntilAbort(check: () => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
	if (!signal) return check();
	if (signal.aborted) return false;
	let onAbort: () => void = () => {};
	try {
		return await Promise.race([
			check(),
			new Promise<false>((resolve) => {
				onAbort = () => resolve(false);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** A slot is spent even if declined or interrupted. The caller must never reuse it. */
export async function runNextSlot(
	studyFile: string,
	key: EndoDigestKeyV0,
	hooks: CoordinatorHooks,
	signal?: AbortSignal,
): Promise<string> {
	if (signal?.aborted) throw new Error("cancelled");
	const study = await readStudyPlan(studyFile, key);
	const previous = await readStudy(studyFile, key);
	if (previous.status === "four-receipts") throw new Error("study already has four slots");
	if (previous.trials.length > 0 && !previous.effectiveParametersEqual) throw new Error("prior parity unavailable");
	if (!(await checkUntilAbort(hooks.checkEnvironment, signal))) throw new Error("environment gate refused");
	const position = previous.trials.length + 1;
	const arm = study.order[position - 1]!;
	const preflight = await preflightInitialContinuationV0({ ...study.options, childRole: arm }, key);
	if (preflight.status !== "ready") throw new Error("preflight refused");
	const expected = study.templates[arm];
	if (
		!same(commonTemplate(preflight.plan), commonTemplate(expected)) ||
		preflight.plan.initial.childId !== expected.initial.childId ||
		!same(preflight.plan.initial.conditionCommitment, expected.initial.conditionCommitment)
	)
		throw new Error("preflight changed");
	const start = sealSlot(key, "start", {
		position,
		arm,
		studyCommitment: study.commitment,
		plan: preflight.plan,
		startedAt: new Date().toISOString(),
	});
	publishExclusive(slotPath(studyFile, position, "start"), start);
	let status = "no-request-cancelled",
		receipt: string | null = null;
	try {
		const firstPhrase = `APPROVE FIRST ${preflight.plan.initial.attemptId}`;
		const approvalDeadline = performance.now() + 300000;
		const approvalSignal = AbortSignal.any([AbortSignal.timeout(300000), ...(signal ? [signal] : [])]);
		const firstAnswer = await Promise.race([
			hooks.first(preflight.plan, firstPhrase),
			new Promise<null>((resolve) => {
				if (approvalSignal.aborted) resolve(null);
				else approvalSignal.addEventListener("abort", () => resolve(null), { once: true });
			}),
		]);
		if (firstAnswer !== firstPhrase || approvalSignal.aborted || performance.now() >= approvalDeadline) return status;
		if (!(await checkUntilAbort(hooks.checkEnvironment, approvalSignal))) return status;
		// The environment check can itself outlast the approval window or cancellation.
		// Never mint a fresh approval from an answer that has already expired.
		if (approvalSignal.aborted || performance.now() >= approvalDeadline) return status;
		const first = approveInitialContinuationV0(
			preflight.plan,
			preflight.plan.commitment,
			"approve first tool-free turn",
		);
		// Once execution is entered an exception cannot establish that dispatch did not occur.
		status = "outcome-unknown";
		const result = await executeInitialContinuationV0(
			preflight.plan,
			first,
			study.options.prompt,
			study.options.continuationPrompt,
			key,
			async (boundary) => {
				if (!(await hooks.checkEnvironment())) return null;
				const phrase = `APPROVE CONTINUATION ${boundary.attemptId}`;
				if ((await hooks.second(boundary, phrase)) !== phrase || !(await hooks.checkEnvironment())) return null;
				return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
			},
			signal,
		);
		if ("area" in result) {
			receipt = join(result.area, "receipt.json");
			const verified = await verifyInitialContinuationEvidenceV0(
				study.options.source,
				study.options.replay,
				key,
				receipt,
			);
			status =
				verified.status === "verified" && result.status === "completed"
					? "completed"
					: verified.status === "first-turn-verified"
						? "first-turn-verified"
						: result.status === "outcome-unknown" ||
								existsSync(join(result.area, "dispatch-1.json")) ||
								existsSync(join(result.area, "dispatch-2.json"))
							? "outcome-unknown"
							: "failed-or-unverifiable";
		} else status = "no-request-refused";
		return status;
	} finally {
		publishExclusive(
			slotPath(studyFile, position, "end"),
			sealSlot(key, "end", {
				position,
				startCommitment: start.commitment,
				status,
				receipt,
				endedAt: new Date().toISOString(),
			}),
		);
	}
}
