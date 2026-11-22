// Independent, read-only verifier and report builder for protected experiments (`endo.protected-run.v0..v3`).
// Shared by `cli/experiment-protected.ts` (`endo experiment protected-report`) and the read-only Studio Evolve observer
// (`adapters/protected-experiment/observer.ts`), so there is one definition of record validity and zero duplicated verification.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	ENDO_PROTECTED_TRIAL_OF_RUN,
	type EndoProtectedModelAccessV1,
	type EndoProtectedModelSpec,
	type EndoProtectedModelTrial,
	type EndoProtectedRun,
	type EndoProtectedStagedTaskV2,
	type EndoProtectedTrial,
	endoProtectedModelConnectedV0,
	endoProtectedStagedV2,
	endoProtectedTrialIsModelConnectedV0,
	endoProtectedTrialIsStagedV2,
	endoProtectedTrialOutcomeV0,
} from "../../protocol/protected-experiment.ts";
import { ENDO_WORKSPACE_BASELINE_V0, type EndoWorkspaceBaselineV0 } from "../../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import { checkEndoProtectedRunV0, checkEndoProtectedTrialV0 } from "../../runtime/contracts/protected-experiment.ts";
import { verifyModelEvidenceV0 } from "./model-evidence.ts";
import { type EndoModelRelayPolicyV0, modelRelayPolicyDigestV0 } from "./model-relay.ts";
import { endoBaselineDigestV0, endoStagedCandidateRecordV0, verifyStagedChangeSetV0 } from "./staged-changeset.ts";

/** Refusal of a protected-experiment operation, with a bounded human-readable reason. */
export class EndoProtectedRefusalV0 extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EndoProtectedRefusalV0";
	}
}

export interface EndoProtectedReportV0 {
	/** `v1` for a model-connected run: its cells also count failures for too few model exchanges, and it states the model access. */
	schemaVersion: "endo.protected-report.v0" | "endo.protected-report.v1";
	run: { id: string; specSha256: string; seed: number; isolation: EndoProtectedRun["isolation"] };
	/** A model-connected run's declared model access: the upstream, the model, the policy's digest and the required exchanges. */
	modelAccess?: { upstream: string; model: string; policySha256: string; minExchanges: number };
	/** How each kind of outcome enters an analysis. */
	rules: string[];
	cells: {
		task: string;
		condition: string;
		planned: number;
		attempted: number;
		notAttempted: number;
		attempts: number;
		retries: number;
		qualified: number;
		passed: number;
		failed: number;
		/** Of `failed`: the agent left no acceptable submission (missing, a link, a special file, unreadable, too large). */
		failedWithoutSubmission: number;
		/** Of `failed`, a model-connected run only: fewer successful model exchanges than the spec requires, whatever the evaluator found. */
		failedBelowMinimumExchanges?: number;
		attrition: Record<string, number>;
	}[];
	refusedRecords: { path: string; reason: string }[];
}

export interface EndoProtectedInspectedAttemptV0 {
	attempt: number;
	relativePath: string;
	status: "verified" | "refused" | "missing";
	refusalReason: string | null;
	record: EndoProtectedTrial | null;
}

export interface EndoProtectedInspectedTrialV0 {
	position: number;
	task: string;
	condition: string;
	trial: number;
	outcome: "passed" | "failed" | "attrition" | "not-attempted" | "refused";
	outcomeReason: string | null;
	retries: number;
	attempts: EndoProtectedInspectedAttemptV0[];
	finalRecord: EndoProtectedTrial | null;
}

export interface EndoProtectedInspectionV0 {
	run: EndoProtectedRun;
	report: EndoProtectedReportV0;
	trials: EndoProtectedInspectedTrialV0[];
}

export interface InspectProtectedExperimentOptionsV0 {
	maxRunFileBytes?: number;
	maxTrialFileBytes?: number;
	maxAttemptsPerTrial?: number;
}

const DEFAULT_MAX_RUN_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TRIAL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DIGEST_KEY_BYTES = 4096;

/** The relay policy a spec's model access declares (adapters/sandbox/model-relay.ts). Its digest is what each record must name. */
export function endoProtectedRelayPolicyV1(m: EndoProtectedModelAccessV1): EndoModelRelayPolicyV0 {
	return {
		routes: m.routes.map((r) => ({ method: r.method, path: r.path })),
		model: m.model,
		maxRequestBytes: m.maxRequestBytes,
		maxTransferredBytes: m.maxTransferredBytes,
		maxConnections: m.maxConnections,
		maxTotalConnections: m.maxTotalConnections,
		maxExchanges: m.maxExchanges,
		maxCompletionTokens: m.maxCompletionTokens,
	};
}

/**
 * The baseline a staged task's workspace pins: computed from the spec's own contents, in memory, before any tree exists. Every file is
 * written from these bytes, non-executable, so this record is what the attempt's baseline/ and work/ trees must be.
 */
export function endoProtectedStagedBaselineV2(workspace: Readonly<Record<string, string>>): EndoWorkspaceBaselineV0 {
	const files = Object.keys(workspace)
		.sort()
		.map((path) => {
			const bytes = Buffer.from(workspace[path] as string, "utf8");
			return { path, bytes: bytes.length, sha256: sha256HexV0(bytes), executable: false };
		});
	return {
		schemaVersion: ENDO_WORKSPACE_BASELINE_V0,
		rootGitExcluded: false,
		files,
		totalBytes: files.reduce((n, f) => n + f.bytes, 0),
		sha256: endoBaselineDigestV0(false, files),
	};
}

/** An attempt that may be retried: the controller was interrupted before the agent started. */
export const retryable = (r: EndoProtectedTrial): boolean =>
	r.invalidating.includes("controller-interrupted") && r.agent.status === "not-run";

type BoundedReadResult =
	| { ok: true; text: string }
	| { ok: false; code: "missing" | "symlink" | "not-file" | "too-large" | "unreadable" };

/** Descriptor-based bounded read of a single plain file without following symlinks. */
function readPlainFileBounded(path: string, maxBytes: number): BoundedReadResult {
	const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (before === undefined) return { ok: false, code: "missing" };
	if (before.isSymbolicLink()) return { ok: false, code: "symlink" };
	if (!before.isFile()) return { ok: false, code: "not-file" };
	if (before.size > BigInt(maxBytes)) return { ok: false, code: "too-large" };
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return { ok: false, code: "unreadable" };
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile()) return { ok: false, code: "not-file" };
		if (opened.size > BigInt(maxBytes)) return { ok: false, code: "too-large" };
		const size = Number(opened.size);
		const buf = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const n = readSync(fd, buf, offset, size - offset, offset);
			if (n === 0) break;
			offset += n;
		}
		const extra = Buffer.alloc(1);
		const grew = readSync(fd, extra, 0, 1, offset) > 0;
		const after = fstatSync(fd, { bigint: true });
		if (grew || offset !== size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
			return { ok: false, code: "unreadable" };
		}
		return { ok: true, text: buf.toString("utf8") };
	} catch {
		return { ok: false, code: "unreadable" };
	} finally {
		closeSync(fd);
	}
}

/** Verify every directory segment from `base` down through `segments` is a plain (non-symlink) directory. */
function plainDirChain(base: string, segments: readonly string[]): "ok" | "missing" | "unsafe" {
	let current = base;
	for (const seg of segments) {
		current = join(current, seg);
		const st = lstatSync(current, { throwIfNoEntry: false });
		if (st === undefined) return "missing";
		if (st.isSymbolicLink() || !st.isDirectory()) return "unsafe";
	}
	return "ok";
}

function listAttemptsSafe(
	dir: string,
	task: string,
	condition: string,
	trial: number,
): {
	state: "ok" | "missing" | "unsafe";
	attempts: number[];
} {
	const chain = plainDirChain(dir, ["trials", task, condition, String(trial)]);
	if (chain !== "ok") return { state: chain, attempts: [] };
	const trialDir = join(dir, "trials", task, condition, String(trial));
	let entries: string[];
	try {
		entries = readdirSync(trialDir);
	} catch {
		return { state: "unsafe", attempts: [] };
	}
	const attempts = entries
		.map((n) => /^attempt-([1-9][0-9]*)$/.exec(n))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => Number(m[1]))
		.sort((a, b) => a - b);
	return { state: "ok", attempts };
}

/** An attempt's digest key (model/digest-key, 0600): the domain its recording's digests and blobs were made in. */
function readAttemptKeySafe(attemptDir: string) {
	if (plainDirChain(attemptDir, ["model"]) !== "ok") throw new Error("model directory unreadable");
	const keyRead = readPlainFileBounded(join(attemptDir, "model", "digest-key"), MAX_DIGEST_KEY_BYTES);
	if (!keyRead.ok) throw new Error("digest key unreadable");
	return endoDigestKeyV0(Buffer.from(keyRead.text.trim(), "hex"), "installation");
}

/**
 * Why a model-connected attempt's record does not match its own evidence, or null. The record must name the run's declared policy (the
 * relay enforced exactly it), its limits and required exchanges; and its recording, derived again from the attempt's store under the
 * attempt's key, must be the one the record summarizes, with every forwarded request one the declared policy admits
 * (verifyModelEvidenceV0). Nothing the record concludes is taken on its word.
 */
function modelEvidenceProblem(
	v: EndoProtectedModelTrial,
	attemptDir: string,
	spec: EndoProtectedModelSpec,
	declared: EndoModelRelayPolicyV0,
	declaredSha256: string,
): string | null {
	if (v.network.relay.policySha256 !== declaredSha256)
		return "the record's relay enforced another policy than the run declares";
	if (v.recording.required !== spec.modelAccess.minExchanges)
		return "the record requires another number of model exchanges than the run declares";
	if (
		v.isolation.limits.memoryMaxBytes !== spec.limits.memoryMaxBytes ||
		v.isolation.limits.cpuQuotaPercent !== spec.limits.cpuQuotaPercent
	)
		return "the record names other resource limits than the run declares";
	if (v.recording.status === "none" || v.recording.status === "inconsistent") return null;
	if (plainDirChain(attemptDir, ["model", "store"]) !== "ok") {
		return "the attempt's model recording store is not a plain directory";
	}
	let key: ReturnType<typeof readAttemptKeySafe>;
	try {
		key = readAttemptKeySafe(attemptDir);
	} catch {
		return "the attempt's digest key is not readable";
	}
	try {
		return verifyModelEvidenceV0({
			store: join(attemptDir, "model", "store"),
			key,
			policy: declared,
			recorded: v.recording,
			admitted: v.network.relay.admitted,
		});
	} catch {
		return "the attempt's model recording could not be verified";
	}
}

/**
 * Why a staged attempt's record does not match its own evidence, or null. Its baseline must be the one its spec's workspace pins (derived
 * again here, never read from the attempt); and when it says its change set verified, the staging directory on disk must still verify
 * against the record's digest, the complete pinned record and the attempt's baseline tree, with the record's summary, and the candidate it
 * names must be the tree that change set and baseline imply.
 */
function stagedEvidenceProblem(
	v: Extract<EndoProtectedTrial, { changeset: unknown }>,
	attemptDir: string,
	task: EndoProtectedStagedTaskV2,
): string | null {
	const pin = endoProtectedStagedBaselineV2(task.workspace);
	const b = v.changeset.baseline;
	if (b.sha256 !== pin.sha256 || b.files !== pin.files.length || b.totalBytes !== pin.totalBytes)
		return "the record's baseline is not the one its spec's workspace pins";
	if (v.changeset.verification.status !== "verified") return null;
	if (plainDirChain(attemptDir, ["changeset"]) !== "ok" || plainDirChain(attemptDir, ["baseline"]) !== "ok") {
		return "the attempt's staged change-set or baseline directory is not readable";
	}
	try {
		const verified = verifyStagedChangeSetV0(
			join(attemptDir, "changeset"),
			{
				expectedBaselineSha256: pin.sha256,
				expectedChangesetSha256: v.changeset.collection.changesetSha256 as string,
				baseline: pin,
				baselineTree: join(attemptDir, "baseline"),
			},
			task.submission.limits,
		);
		if (!verified.ok) return `the attempt's change set does not verify against its record (${verified.reason})`;
		if (canonicalEndoJsonV0(verified.manifest.summary) !== canonicalEndoJsonV0(v.changeset.collection.summary))
			return "the record's change-set summary is not its manifest's";
		if (endoStagedCandidateRecordV0(verified.manifest, pin).sha256 !== v.changeset.verification.candidateSha256)
			return "the record's candidate is not the tree its change set and baseline imply";
		return null;
	} catch {
		return "the attempt's staged change set could not be verified";
	}
}

/**
 * Every attempt of a run, read independently: each record by its own version and digests, none trusted from another.
 * Returns both the aggregate `EndoProtectedReportV0` and the independently verified per-trial/attempt inspection records.
 */
export function inspectProtectedExperimentV0(
	directory: string,
	options: InspectProtectedExperimentOptionsV0 = {},
): EndoProtectedInspectionV0 {
	const dir = resolve(directory);
	const maxRunBytes = options.maxRunFileBytes ?? DEFAULT_MAX_RUN_FILE_BYTES;
	const maxTrialBytes = options.maxTrialFileBytes ?? DEFAULT_MAX_TRIAL_FILE_BYTES;
	const maxAttempts = options.maxAttemptsPerTrial;
	const runFileRead = readPlainFileBounded(join(dir, "protected-run.json"), maxRunBytes);
	if (!runFileRead.ok) {
		const detail =
			runFileRead.code === "missing"
				? "protected-run.json is missing"
				: runFileRead.code === "symlink" || runFileRead.code === "not-file"
					? "protected-run.json is not a plain regular file"
					: runFileRead.code === "too-large"
						? "protected-run.json exceeds the read size limit"
						: "protected-run.json is not readable";
		throw new EndoProtectedRefusalV0(`the run record is not readable: ${detail}`);
	}
	let rawRun: unknown;
	try {
		rawRun = JSON.parse(runFileRead.text);
	} catch {
		throw new EndoProtectedRefusalV0("the run record is not readable: malformed JSON");
	}
	const read = checkEndoProtectedRunV0(rawRun);
	if (!read.ok) throw new EndoProtectedRefusalV0(`the run record is not readable: ${read.reason}`);
	const run = read.value;
	// A model-connected run's records are read against the policy its spec declares, never against the one a record names.
	const v1 = endoProtectedModelConnectedV0(run.schemaVersion);
	const declared = v1 ? endoProtectedRelayPolicyV1((run.spec as EndoProtectedModelSpec).modelAccess) : null;
	const declaredSha256 = declared === null ? null : modelRelayPolicyDigestV0(declared);
	const refusedRecords: EndoProtectedReportV0["refusedRecords"] = [];
	const cells = new Map<string, EndoProtectedReportV0["cells"][number]>();
	for (const t of run.spec.tasks)
		for (const c of run.spec.conditions)
			cells.set(`${t.id}/${c.id}`, {
				task: t.id,
				condition: c.id,
				planned: 0,
				attempted: 0,
				notAttempted: 0,
				attempts: 0,
				retries: 0,
				qualified: 0,
				passed: 0,
				failed: 0,
				failedWithoutSubmission: 0,
				...(v1 ? { failedBelowMinimumExchanges: 0 } : {}),
				attrition: {},
			});
	const inspectedTrials: EndoProtectedInspectedTrialV0[] = [];
	for (const entry of run.plan) {
		const cell = cells.get(`${entry.task}/${entry.condition}`)!;
		cell.planned++;
		const trialRel = `trials/${entry.task}/${entry.condition}/${entry.trial}`;
		const trialDir = join(dir, "trials", entry.task, entry.condition, String(entry.trial));
		const listed = listAttemptsSafe(dir, entry.task, entry.condition, entry.trial);
		if (listed.state === "unsafe") {
			cell.attempted++;
			const reason = "the trial directory is not a plain directory";
			refusedRecords.push({ path: trialRel, reason });
			cell.attrition["record-refused"] = (cell.attrition["record-refused"] ?? 0) + 1;
			inspectedTrials.push({
				position: entry.position,
				task: entry.task,
				condition: entry.condition,
				trial: entry.trial,
				outcome: "refused",
				outcomeReason: reason,
				retries: 0,
				attempts: [{ attempt: 1, relativePath: trialRel, status: "refused", refusalReason: reason, record: null }],
				finalRecord: null,
			});
			continue;
		}
		const attempts = listed.attempts;
		if (attempts.length === 0) {
			cell.notAttempted++;
			inspectedTrials.push({
				position: entry.position,
				task: entry.task,
				condition: entry.condition,
				trial: entry.trial,
				outcome: "not-attempted",
				outcomeReason: null,
				retries: 0,
				attempts: [],
				finalRecord: null,
			});
			continue;
		}
		if (maxAttempts !== undefined && attempts.length > maxAttempts) {
			cell.attempted++;
			const reason = `too many attempts recorded for this trial (limit ${maxAttempts})`;
			refusedRecords.push({ path: trialRel, reason });
			cell.attrition["record-refused"] = (cell.attrition["record-refused"] ?? 0) + 1;
			inspectedTrials.push({
				position: entry.position,
				task: entry.task,
				condition: entry.condition,
				trial: entry.trial,
				outcome: "refused",
				outcomeReason: reason,
				retries: 0,
				attempts: [{ attempt: 1, relativePath: trialRel, status: "refused", refusalReason: reason, record: null }],
				finalRecord: null,
			});
			continue;
		}
		cell.attempted++;
		let final: EndoProtectedTrial | null = null;
		let trialRetries = 0;
		const inspectedAttempts: EndoProtectedInspectedAttemptV0[] = [];
		for (const n of attempts) {
			cell.attempts++;
			// The trial's outcome is its last attempt's; an unreadable last record is attrition, never replaced by an earlier one.
			const previous = final;
			final = null;
			const attemptName = `attempt-${n}`;
			const attemptDir = join(trialDir, attemptName);
			const rel = `${trialRel}/${attemptName}/record.json`;
			if (plainDirChain(trialDir, [attemptName]) !== "ok") {
				const reason = "the attempt directory is not a plain directory";
				refusedRecords.push({ path: rel, reason });
				inspectedAttempts.push({
					attempt: n,
					relativePath: rel,
					status: "refused",
					refusalReason: reason,
					record: null,
				});
				continue;
			}
			const recordRead = readPlainFileBounded(join(attemptDir, "record.json"), maxTrialBytes);
			if (!recordRead.ok) {
				if (recordRead.code === "missing") {
					const reason = "no record (the attempt was not finalized)";
					refusedRecords.push({ path: rel, reason });
					inspectedAttempts.push({
						attempt: n,
						relativePath: rel,
						status: "missing",
						refusalReason: reason,
						record: null,
					});
				} else {
					const reason =
						recordRead.code === "symlink" || recordRead.code === "not-file"
							? "the record is not a plain regular file"
							: recordRead.code === "too-large"
								? "the record exceeds the read size limit"
								: "the record is not readable JSON";
					refusedRecords.push({ path: rel, reason });
					inspectedAttempts.push({
						attempt: n,
						relativePath: rel,
						status: "refused",
						refusalReason: reason,
						record: null,
					});
				}
				continue;
			}
			let rawTrial: unknown;
			try {
				rawTrial = JSON.parse(recordRead.text);
			} catch {
				const reason = "the record is not readable JSON";
				refusedRecords.push({ path: rel, reason });
				inspectedAttempts.push({
					attempt: n,
					relativePath: rel,
					status: "refused",
					refusalReason: reason,
					record: null,
				});
				continue;
			}
			const r = checkEndoProtectedTrialV0(rawTrial);
			if (!r.ok) {
				refusedRecords.push({ path: rel, reason: r.reason });
				inspectedAttempts.push({
					attempt: n,
					relativePath: rel,
					status: "refused",
					refusalReason: r.reason,
					record: null,
				});
				continue;
			}
			const v = r.value;
			// Each record must be this run's attempt, at these coordinates, under this run's isolation, profile and evaluator.
			const profile = run.profiles.find((x) => x.condition === entry.condition)?.sha256;
			const ev = run.evaluators.find((x) => x.task === entry.task);
			const problem =
				// Each record of the run's own version only: an offline record is never read as a model-connected one, nor the reverse.
				v.schemaVersion !== ENDO_PROTECTED_TRIAL_OF_RUN[run.schemaVersion]
					? "the record's version is not the run's"
					: v.trial.position !== entry.position ||
							v.trial.task !== entry.task ||
							v.trial.condition !== entry.condition ||
							v.trial.trial !== entry.trial ||
							v.trial.attempt !== n
						? "the record is not this run's attempt at these coordinates"
						: v.run.specSha256 !== run.specSha256 || v.run.seed !== run.seed || v.run.id !== run.spec.id
							? "the record names another run"
							: v.isolation.version !== run.isolation.version ||
									v.isolation.executableSha256 !== run.isolation.executableSha256
								? "the record names another isolation executable"
								: v.isolation.profileSha256 !== profile
									? "the record names another agent profile"
									: v.evaluation.definitionSha256 !== ev?.definitionSha256 ||
											v.evaluation.driverSha256 !== ev?.driverSha256
										? "the record names another evaluator"
										: n !== attempts.indexOf(n) + 1
											? "the attempts are not numbered from 1 without gaps"
											: (n === 1) !== (v.trial.retryOf === null) || (n > 1 && v.trial.retryOf !== n - 1)
												? "the attempt does not retry the attempt before it"
												: n > 1 && (previous === null || !retryable(previous))
													? "the attempt retries one that may not be retried (its agent ran, or its record is unreadable)"
													: ((endoProtectedTrialIsModelConnectedV0(v)
															? modelEvidenceProblem(
																	v,
																	attemptDir,
																	run.spec as EndoProtectedModelSpec,
																	declared as EndoModelRelayPolicyV0,
																	declaredSha256 as string,
																)
															: null) ??
														(endoProtectedTrialIsStagedV2(v)
															? stagedEvidenceProblem(
																	v,
																	attemptDir,
																	run.spec.tasks.find(
																		(t) => t.id === entry.task,
																	) as EndoProtectedStagedTaskV2,
																)
															: null));
			if (problem !== null) {
				refusedRecords.push({ path: rel, reason: problem });
				inspectedAttempts.push({
					attempt: n,
					relativePath: rel,
					status: "refused",
					refusalReason: problem,
					record: null,
				});
				continue;
			}
			if (v.trial.retryOf !== null) {
				cell.retries++;
				trialRetries++;
			}
			inspectedAttempts.push({ attempt: n, relativePath: rel, status: "verified", refusalReason: null, record: v });
			final = v;
		}
		if (final === null) {
			cell.attrition["record-refused"] = (cell.attrition["record-refused"] ?? 0) + 1;
			const lastReason = inspectedAttempts.at(-1)?.refusalReason ?? "record refused";
			inspectedTrials.push({
				position: entry.position,
				task: entry.task,
				condition: entry.condition,
				trial: entry.trial,
				outcome: "refused",
				outcomeReason: lastReason,
				retries: trialRetries,
				attempts: inspectedAttempts,
				finalRecord: null,
			});
			continue;
		}
		const o = endoProtectedTrialOutcomeV0(final);
		if (o.outcome === "attrition") {
			cell.attrition[o.reason as string] = (cell.attrition[o.reason as string] ?? 0) + 1;
			inspectedTrials.push({
				position: entry.position,
				task: entry.task,
				condition: entry.condition,
				trial: entry.trial,
				outcome: "attrition",
				outcomeReason: o.reason,
				retries: trialRetries,
				attempts: inspectedAttempts,
				finalRecord: final,
			});
		} else {
			cell.qualified++;
			if (o.outcome === "passed") {
				cell.passed++;
				inspectedTrials.push({
					position: entry.position,
					task: entry.task,
					condition: entry.condition,
					trial: entry.trial,
					outcome: "passed",
					outcomeReason: null,
					retries: trialRetries,
					attempts: inspectedAttempts,
					finalRecord: final,
				});
			} else {
				cell.failed++;
				if (o.reason === "model-exchanges-below-minimum")
					cell.failedBelowMinimumExchanges = (cell.failedBelowMinimumExchanges ?? 0) + 1;
				else if (final.evaluation.status !== "failed") cell.failedWithoutSubmission++;
				inspectedTrials.push({
					position: entry.position,
					task: entry.task,
					condition: entry.condition,
					trial: entry.trial,
					outcome: "failed",
					outcomeReason: o.reason,
					retries: trialRetries,
					attempts: inspectedAttempts,
					finalRecord: final,
				});
			}
		}
	}
	const access = v1 ? (run.spec as EndoProtectedModelSpec).modelAccess : null;
	const report: EndoProtectedReportV0 = {
		schemaVersion: v1 ? "endo.protected-report.v1" : "endo.protected-report.v0",
		run: { id: run.spec.id, specSha256: run.specSha256, seed: run.seed, isolation: run.isolation },
		...(access === null
			? {}
			: {
					modelAccess: {
						upstream: access.upstream,
						model: access.model,
						policySha256: declaredSha256 as string,
						minExchanges: access.minExchanges,
					},
				}),
		rules: [
			"planned counts every randomized trial; none is ever removed",
			"qualified (judged): the boundary was established and checked and the agent's termination confirmed, and then either the independent evaluator ran, or the agent left no acceptable submission",
			"passed and failed are counted among qualified trials only; a failure is the evaluator's, or the agent's own missing or unacceptable submission (failedWithoutSubmission), never inferred from missing evidence",
			"attrition (by its first invalidating condition) and notAttempted are reported beside them, never as failures, and stay in the planned denominator",
			"a retry is a new attempt naming the one it retries; the trial's outcome is its last attempt's (an unreadable one is attrition), and every attempt stays counted",
			...(v1
				? [
						"model-connected: each record's recording is read again from its attempt's store, and a record whose exchanges, policy, limits or counts do not match it is refused (record-refused attrition)",
						"model-connected: a trial with fewer successful model exchanges (answered 2xx, verified) than the spec's minimum is a failure (failedBelowMinimumExchanges), whatever the evaluator found; never a pass, never attrition",
						"model-connected: a refused request is the agent's doing and does not invalidate a trial; a failed relay, an incomplete recording or a model server's failure on a forwarded request is attrition",
					]
				: []),
			...(endoProtectedStagedV2(run.schemaVersion)
				? [
						"staged: each record's baseline is derived again from its spec's workspace, and a change set it says verified is verified again from the attempt's staging directory and baseline tree; a record that does not match is refused (record-refused attrition)",
						"staged: a change set the collector refused (a link, a special file, .git, a bound exceeded) is the agent's failure (failedWithoutSubmission); a baseline mismatch before the agent started, or a collected change set that does not verify, is attrition and is never evaluated",
					]
				: []),
		],
		cells: [...cells.values()],
		refusedRecords,
	};
	return { run, report, trials: inspectedTrials };
}

/** Every attempt of a run, read independently: each record by its own version and digests, none trusted from another. */
export function reportProtectedExperimentV0(directory: string): EndoProtectedReportV0 {
	return inspectProtectedExperimentV0(directory).report;
}
