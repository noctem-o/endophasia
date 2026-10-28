// Research-only private plan. Publication grants no inference authority.
import { closeSync, constants, fsyncSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { readVerifiedInitialBranchSetV0 } from "../../../cli/initial-branch-set.ts";
import { initialExecutionManifestV0, initialExecutionPrivateFileV0 } from "../../../cli/initial-child-execution.ts";
import {
	type InitialContinuationOptionsV0,
	preflightInitialContinuationV0,
} from "../../../cli/initial-continuation.ts";
import type { InitialContinuationPlanV0 } from "../../../protocol/initial-continuation.ts";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";

type Options = Omit<InitialContinuationOptionsV0, "childRole">;
export type Arm = "baseline" | "alternative";
export interface StudyPlan {
	version: "endo.research.two-turn-aa.plan.0";
	options: Options;
	seed: number;
	createdAt: string;
	order: Arm[];
	expectedAnswer: string;
	procedure: "exact-token.v0";
	comparison: "verified-capture.v0";
	maxAttempts: 4;
	maxDispatches: 8;
	serverDeclaration: string;
	templates: Record<Arm, InitialContinuationPlanV0>;
	commitment: EndoKeyedDigestV0;
}
const same = (a: unknown, b: unknown) => canonicalEndoJsonV0(a) === canonicalEndoJsonV0(b);
const optionKeys = [
	"source",
	"replay",
	"outputParent",
	"preparation",
	"piExecutable",
	"upstream",
	"provider",
	"model",
	"prompt",
	"continuationPrompt",
	"wallTimeoutMs",
	"maxApprovalIdleMs",
	"maxTransferredBytes",
];
function validInputs(options: Options, expectedAnswer: string): boolean {
	if (!options || !same(Object.keys(options).sort(), [...optionKeys].sort())) return false;
	const match = /^Compute ([0-9]) plus ([0-9])\. Return only the decimal result\.$/.exec(options.prompt);
	return (
		!!match &&
		expectedAnswer === String(Number(match[1]) + Number(match[2])) &&
		options.continuationPrompt === "Repeat only the token in your immediately preceding answer." &&
		Number.isSafeInteger(options.wallTimeoutMs) &&
		options.wallTimeoutMs >= 1000 &&
		options.wallTimeoutMs <= 120000 &&
		Number.isSafeInteger(options.maxApprovalIdleMs) &&
		options.maxApprovalIdleMs >= 1000 &&
		options.maxApprovalIdleMs <= 60000 &&
		options.maxApprovalIdleMs <= options.wallTimeoutMs &&
		Number.isSafeInteger(options.maxTransferredBytes) &&
		options.maxTransferredBytes >= 1024 &&
		options.maxTransferredBytes <= 10 * 1024 * 1024
	);
}
export const orderForSeed = (seed: number): Arm[] =>
	seed % 2 === 0
		? ["baseline", "alternative", "alternative", "baseline"]
		: ["alternative", "baseline", "baseline", "alternative"];
const commitment = (key: EndoDigestKeyV0, value: Omit<StudyPlan, "commitment">) =>
	key.digest({ purpose: "endo.research.two-turn-aa.plan.0", value });

// Plans differ in attempt-specific identity and arm identity; all other committed fields must agree.
export function commonTemplate(plan: InitialContinuationPlanV0): unknown {
	const { initial, commitment: _commitment, ...continuation } = plan;
	const {
		attemptId: _attemptId,
		commitment: _initialCommitment,
		childRole: _role,
		childId: _childId,
		conditionCommitment: _condition,
		...common
	} = initial;
	return { ...continuation, initial: common };
}

async function templatesFor(options: Options, key: EndoDigestKeyV0): Promise<Record<Arm, InitialContinuationPlanV0>> {
	const branch = readVerifiedInitialBranchSetV0(
		options.source,
		options.replay,
		key,
		options.outputParent,
		options.preparation,
	);
	if (branch.status !== "verified-pristine") throw new Error("siblings are not verified pristine");
	const manifest = initialExecutionManifestV0(options);
	const a = manifest.children.baseline.condition.specification;
	const b = manifest.children.alternative.condition.specification;
	const { id: aid, description: _ad, ...ac } = a;
	const { id: bid, description: _bd, ...bc } = b;
	if (aid === bid || !same(ac, bc) || manifest.changeCategory !== "declared-noop")
		throw new Error("conditions are not matched");
	const baseline = await preflightInitialContinuationV0({ ...options, childRole: "baseline" }, key);
	const alternative = await preflightInitialContinuationV0({ ...options, childRole: "alternative" }, key);
	if (baseline.status !== "ready" || alternative.status !== "ready") throw new Error("continuation preflight refused");
	if (!same(commonTemplate(baseline.plan), commonTemplate(alternative.plan)))
		throw new Error("effective preflight mismatch");
	return { baseline: baseline.plan, alternative: alternative.plan };
}

/** Never overwrites. A partial publication is refused by the reader and is not retried. */
export async function createStudyPlan(
	path: string,
	options: Options,
	seed: number,
	expectedAnswer: string,
	serverDeclaration: string,
	key: EndoDigestKeyV0,
): Promise<StudyPlan> {
	if (
		!isAbsolute(path) ||
		!Number.isSafeInteger(seed) ||
		seed < 0 ||
		seed > 0xffffffff ||
		!validInputs(options, expectedAnswer) ||
		!serverDeclaration ||
		Buffer.byteLength(serverDeclaration) > 16384 ||
		options.wallTimeoutMs > 120000 ||
		options.maxApprovalIdleMs > 60000 ||
		options.maxTransferredBytes > 10 * 1024 * 1024
	)
		throw new Error("invalid study plan input");
	const parent = lstatSync(dirname(path));
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		parent.uid !== process.getuid?.() ||
		(parent.mode & 0o077) !== 0
	)
		throw new Error("study parent must be an owner-only directory");
	const templates = await templatesFor(options, key);
	const body = {
		version: "endo.research.two-turn-aa.plan.0" as const,
		options,
		seed,
		createdAt: new Date().toISOString(),
		order: orderForSeed(seed),
		expectedAnswer,
		procedure: "exact-token.v0" as const,
		comparison: "verified-capture.v0" as const,
		maxAttempts: 4 as const,
		maxDispatches: 8 as const,
		serverDeclaration,
		templates,
	};
	const plan = { ...body, commitment: commitment(key, body) };
	const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, canonicalEndoJsonV0(plan));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
	return plan;
}

/** Independently check the keyed plan and current lineage; preflight sends no request. */
export async function readStudyPlan(path: string, key: EndoDigestKeyV0): Promise<StudyPlan> {
	if (!isAbsolute(path)) throw new Error("absolute study path required");
	const text = initialExecutionPrivateFileV0(path, 128 * 1024);
	const plan = JSON.parse(text) as StudyPlan;
	if (!plan || typeof plan !== "object" || text !== canonicalEndoJsonV0(plan))
		throw new Error("invalid plan encoding");
	const { commitment: saved, ...body } = plan;
	if (
		!same(
			Object.keys(plan).sort(),
			[
				"version",
				"options",
				"seed",
				"createdAt",
				"order",
				"expectedAnswer",
				"procedure",
				"comparison",
				"maxAttempts",
				"maxDispatches",
				"serverDeclaration",
				"templates",
				"commitment",
			].sort(),
		) ||
		!same(saved, commitment(key, body)) ||
		plan.version !== "endo.research.two-turn-aa.plan.0" ||
		plan.procedure !== "exact-token.v0" ||
		plan.comparison !== "verified-capture.v0" ||
		plan.maxAttempts !== 4 ||
		plan.maxDispatches !== 8 ||
		typeof plan.createdAt !== "string" ||
		!Number.isFinite(Date.parse(plan.createdAt)) ||
		new Date(plan.createdAt).toISOString() !== plan.createdAt ||
		!Number.isSafeInteger(plan.seed) ||
		plan.seed < 0 ||
		plan.seed > 0xffffffff ||
		!same(plan.order, orderForSeed(plan.seed)) ||
		!validInputs(plan.options, plan.expectedAnswer) ||
		typeof plan.serverDeclaration !== "string" ||
		!plan.serverDeclaration ||
		Buffer.byteLength(plan.serverDeclaration) > 16384
	)
		throw new Error("study commitment invalid");
	const current = await templatesFor(plan.options, key);
	for (const arm of ["baseline", "alternative"] as const) {
		const stored = plan.templates[arm];
		if (
			!same(commonTemplate(stored), commonTemplate(current[arm])) ||
			stored.initial.childRole !== arm ||
			stored.initial.childId !== current[arm].initial.childId ||
			!same(stored.initial.conditionCommitment, current[arm].initial.conditionCommitment)
		)
			throw new Error("study lineage or runtime changed");
	}
	return plan;
}
