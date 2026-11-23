// Read-only adapter for DEVELOP-EVIDENCE-BRIDGE-001 (docs/designs/develop-evidence-bridge.md).
// Reads existing DEVELOP store records (`tasks.json`, `develop/attempts/`, `events/events.log`, `develop/observations/`,
// `develop/receipts/`), observes the reader-chosen Git working tree once, and optionally inspects a protected-experiment
// directory (`endo.protected-run.v0..v3`) using `inspectProtectedExperimentV0` and read-only `verifyFixedSubmissionV0`.
//
// Strictly read-only:
// - Writes zero files and zero temporary directories.
// - Never mutates tasks.json or any store/repository/protected-run file.
// - Never applies candidate bytes to a working checkout.
// - Never executes an evaluator, check command, or coding agent.
// - Never fabricates a missing cross-space association between a DEVELOP attempt and a protected-experiment candidate.

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
	EndoBridgeProtectedExperimentV0,
	EndoDevelopEvidenceBridgeV0,
} from "../../protocol/develop-evidence-bridge.ts";
import type { EndoEventV0 } from "../../protocol/event.ts";
import {
	type EndoProtectedTaskV0,
	endoProtectedSuccessfulExchangesV1,
	endoProtectedTrialIsModelConnectedV0,
	endoProtectedTrialIsStagedV2,
} from "../../protocol/protected-experiment.ts";
import type { EndoSessionLogReadV0 } from "../../runtime/contracts/develop-attempt-execution.ts";
import { DevelopAttemptsServiceV0 } from "../../runtime/contracts/develop-attempts.ts";
import {
	endoDevelopEvidenceBridgeV0,
	endoEmptyProtectedBridgeV0,
} from "../../runtime/contracts/develop-evidence-bridge.ts";
import { DevelopObservationsServiceV0, endoReceiptCurrentOfV0 } from "../../runtime/contracts/develop-observations.ts";
import { DevelopReceiptsServiceV0 } from "../../runtime/contracts/develop-receipts.ts";
import { DevelopAttemptsStoreV0 } from "../../storage/develop-attempts.ts";
import { DevelopObservationsStoreV0 } from "../../storage/develop-observations.ts";
import { DevelopReceiptsStoreV0 } from "../../storage/develop-receipts.ts";
import { DevelopTasksStoreV0 } from "../../storage/develop-tasks.ts";
import { createEndoDurableEventStoreV0 } from "../../storage/event-store.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";
import { gitStateReaderV0 } from "../git/state-observer.ts";
import { EndoProtectedRefusalV0, inspectProtectedExperimentV0 } from "../sandbox/protected-report.ts";
import { verifyFixedSubmissionV0 } from "../sandbox/submission.ts";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_AGENT_LOG_BYTES = 64 * 1024 * 1024;

export interface ReadDevelopEvidenceBridgeOptionsV0 {
	root: string;
	attemptId: string;
	cwd?: string;
	protectedRunDir?: string;
	specPin?: string;
	/** Optional `<task>/<condition>/<trial>` selector when a protected run has multiple trials. */
	trial?: string;
	/** Tool version string (used only by DevelopObservationsServiceV0 constructor; nothing is written). */
	version?: string;
	now?: () => number;
}

export type ReadDevelopEvidenceBridgeResultV0 =
	| { ok: true; bridge: EndoDevelopEvidenceBridgeV0 }
	| { ok: false; code: "bad-request" | "not-found" | "unreadable"; reason?: string };

/** Read-only open of the event store log (matching cli/develop-service.ts without importing cli/). */
function readSessionLogReadOnly(root: string): EndoSessionLogReadV0 {
	if (!existsSync(join(root, "events", "events.log"))) return { state: "unavailable" };
	let store: ReturnType<typeof createEndoDurableEventStoreV0>;
	try {
		store = createEndoDurableEventStoreV0(root, { readOnly: true });
	} catch {
		return { state: "unavailable" };
	}
	try {
		const recovery = store.recovery();
		const events: EndoEventV0[] = [];
		while (events.length < store.length) {
			const page = store.page({ afterSequence: events.length, limit: 10_000 });
			if (page.events.length === 0) return { state: "unavailable" };
			events.push(...page.events);
		}
		return { state: recovery.truncated || recovery.sealed ? "partial" : "complete", events };
	} catch {
		return { state: "unavailable" };
	} finally {
		store.close();
	}
}

/** Stream-hash a plain regular file read-only without following symlinks or allocating unbounded memory. */
function verifyPlainFileSha256ReadOnly(path: string, expectedSha256: string, maxBytes: number): boolean {
	let before: ReturnType<typeof lstatSync> | undefined;
	try {
		before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	} catch {
		return false;
	}
	if (before === undefined || before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes))
		return false;
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return false;
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.size > BigInt(maxBytes)) return false;
		const hash = createHash("sha256");
		const buf = Buffer.alloc(65_536);
		let total = 0n;
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			total += BigInt(n);
			if (total > BigInt(maxBytes)) return false;
			hash.update(buf.subarray(0, n));
		}
		const after = fstatSync(fd, { bigint: true });
		if (total !== opened.size || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return false;
		return hash.digest("hex") === expectedSha256;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

function looksLikeCandidateTamper(reason: string | null): boolean {
	if (reason === null) return false;
	const lower = reason.toLowerCase();
	return (
		lower.includes("change set does not verify") ||
		lower.includes("staged-bytes-mismatch") ||
		lower.includes("digest-mismatch") ||
		lower.includes("candidate is not") ||
		lower.includes("baseline-mismatch") ||
		lower.includes("staged-file") ||
		lower.includes("baseline is not") ||
		lower.includes("change-set summary")
	);
}

/** Read and independently validate a protected-experiment directory for the bridge without writing anything. */
export function inspectProtectedRunForBridgeV0(options: {
	directory: string;
	specPin?: string;
	trial?: string;
}): EndoBridgeProtectedExperimentV0 {
	const dir = resolve(options.directory);
	const rawPin = options.specPin?.trim();
	const pinMissing = rawPin === undefined || rawPin === "";
	const pinMalformed = !pinMissing && !SHA256_HEX.test(rawPin);

	const base: EndoBridgeProtectedExperimentV0 = {
		...endoEmptyProtectedBridgeV0(),
		supplied: true,
		attemptAssociation: "unestablished",
		missingBindingRecord: "develop-attempt-protected-candidate-binding",
		pinStatus: pinMissing ? "missing" : pinMalformed ? "mismatched" : "matched",
		expectedSpecPin: pinMissing ? null : rawPin,
	};

	let inspection: ReturnType<typeof inspectProtectedExperimentV0>;
	try {
		inspection = inspectProtectedExperimentV0(dir);
	} catch (error) {
		const problem =
			error instanceof EndoProtectedRefusalV0 ? error.message : "protected experiment directory could not be read";
		return {
			...base,
			candidateIntegrity: pinMissing ? "pin-missing" : pinMalformed ? "pin-mismatch" : "unreadable",
			candidateDetail: problem,
			outcome: "unreadable",
			problem,
		};
	}

	const { run, report, trials } = inspection;
	const pinMatched = !pinMissing && !pinMalformed && run.specSha256 === rawPin;
	const pinStatus: EndoBridgeProtectedExperimentV0["pinStatus"] = pinMissing
		? "missing"
		: pinMatched
			? "matched"
			: "mismatched";

	// Select trial explicitly (single-trial run or explicit --trial <task>/<condition>/<trial>; never guess).
	let selected = trials.length === 1 ? trials[0] : undefined;
	if (options.trial !== undefined) {
		const parts = options.trial.split("/");
		if (parts.length !== 3 || !/^(?:0|[1-9][0-9]*)$/.test(parts[2] ?? "")) {
			return {
				...base,
				pinStatus,
				observedSpecSha256: run.specSha256,
				runId: run.spec.id,
				runSchemaVersion: run.schemaVersion,
				candidateIntegrity:
					pinStatus === "missing" ? "pin-missing" : pinStatus === "mismatched" ? "pin-mismatch" : "unreadable",
				candidateDetail: "invalid --trial selector; expected <task>/<condition>/<trial>",
				refusedRecords: report.refusedRecords,
				outcome: "unreadable",
				problem: "invalid --trial selector; expected <task>/<condition>/<trial>",
			};
		}
		const [taskId, condId, trialNumStr] = parts;
		const trialNum = Number(trialNumStr);
		selected = trials.find((t) => t.task === taskId && t.condition === condId && t.trial === trialNum);
	}

	if (selected === undefined) {
		const problem =
			options.trial !== undefined
				? `trial ${options.trial} not found in protected run ${run.spec.id}`
				: `protected run ${run.spec.id} contains ${trials.length} trials; pass --trial <task>/<condition>/<trial> to identify one`;
		return {
			...base,
			pinStatus,
			observedSpecSha256: run.specSha256,
			runId: run.spec.id,
			runSchemaVersion: run.schemaVersion,
			candidateIntegrity:
				pinStatus === "missing" ? "pin-missing" : pinStatus === "mismatched" ? "pin-mismatch" : "unreadable",
			candidateDetail: problem,
			refusedRecords: report.refusedRecords,
			outcome: "unreadable",
			problem,
		};
	}

	const evQual = run.evaluators.find((e) => e.task === selected.task);
	const qualification = evQual === undefined ? null : { reference: evQual.reference, negative: evQual.negative };
	const finalRecord = selected.finalRecord;
	const lastAttempt = selected.attempts.at(-1);

	if (finalRecord === null) {
		const reason = selected.outcomeReason ?? lastAttempt?.refusalReason ?? "no verified final trial record";
		const tampered =
			looksLikeCandidateTamper(reason) || report.refusedRecords.some((r) => looksLikeCandidateTamper(r.reason));
		const integrity: EndoBridgeProtectedExperimentV0["candidateIntegrity"] =
			pinStatus === "missing"
				? "pin-missing"
				: pinStatus === "mismatched"
					? "pin-mismatch"
					: tampered
						? "tampered"
						: selected.outcome === "not-attempted"
							? "not-collected"
							: "refused";
		return {
			...base,
			pinStatus,
			observedSpecSha256: run.specSha256,
			runId: run.spec.id,
			runSchemaVersion: run.schemaVersion,
			trialCoordinates: {
				position: selected.position,
				task: selected.task,
				condition: selected.condition,
				trial: selected.trial,
				attempt: lastAttempt?.attempt ?? 0,
			},
			qualification,
			candidateIntegrity: integrity,
			candidateDetail: reason,
			refusedRecords: report.refusedRecords,
			outcome: selected.outcome,
			problem: reason,
		};
	}

	const attemptDir = join(
		dir,
		"trials",
		selected.task,
		selected.condition,
		String(selected.trial),
		`attempt-${finalRecord.trial.attempt}`,
	);
	const outputDigestVerified =
		finalRecord.agent.outputSha256 === null
			? null
			: verifyPlainFileSha256ReadOnly(
					join(attemptDir, "agent.log"),
					finalRecord.agent.outputSha256,
					MAX_AGENT_LOG_BYTES,
				);

	let candidateMode: "staged-changeset" | "fixed-paths";
	let candidateIntegrity: EndoBridgeProtectedExperimentV0["candidateIntegrity"];
	let baselineSha256: string | null = null;
	let changesetSha256: string | null = null;
	let candidateSha256: string | null = null;
	let submissionSha256: string | null = null;
	let candidateDetail: string;

	if (endoProtectedTrialIsStagedV2(finalRecord)) {
		candidateMode = "staged-changeset";
		baselineSha256 = finalRecord.changeset.baseline.sha256;
		changesetSha256 = finalRecord.changeset.collection.changesetSha256;
		candidateSha256 = finalRecord.changeset.verification.candidateSha256;
		if (finalRecord.changeset.verification.status === "verified" && candidateSha256 !== null) {
			candidateIntegrity = "verified";
			candidateDetail =
				"Staged change set and baseline verified read-only against sealed record; candidate is reconstructable, but has NO stored binding to this DEVELOP attempt.";
		} else if (finalRecord.changeset.collection.status !== "collected") {
			candidateIntegrity = "not-collected";
			candidateDetail = `Staged change set was not collected (${finalRecord.changeset.collection.status}).`;
		} else {
			candidateIntegrity = "refused";
			candidateDetail = `Staged change set verification status is ${finalRecord.changeset.verification.status} (${finalRecord.changeset.verification.reason ?? "unverified"}).`;
		}
	} else {
		candidateMode = "fixed-paths";
		submissionSha256 = finalRecord.submission.sha256;
		if (finalRecord.submission.status === "collected" && submissionSha256 !== null) {
			const specTask = run.spec.tasks.find((t) => t.id === selected.task) as EndoProtectedTaskV0 | undefined;
			if (specTask === undefined) {
				candidateIntegrity = "refused";
				candidateDetail = "Task definition missing from protected-run.json.";
			} else {
				const checked = verifyFixedSubmissionV0(
					join(attemptDir, "submission"),
					specTask.submission,
					submissionSha256,
					run.spec.limits,
				);
				if (checked.ok) {
					candidateIntegrity = "verified";
					candidateDetail =
						"Fixed-path submission bytes verified read-only in memory against sealed manifest SHA-256; has NO stored binding to this DEVELOP attempt.";
				} else {
					candidateIntegrity =
						checked.reason === "staged-bytes-mismatch" || checked.reason === "unexpected-entry"
							? "tampered"
							: "refused";
					candidateDetail = checked.detail;
				}
			}
		} else {
			candidateIntegrity = "not-collected";
			candidateDetail = `Submission status is ${finalRecord.submission.status}.`;
		}
	}

	// Pin failures override candidate integrity so an unpinned or wrong-pin run is never reported as verified.
	if (pinStatus === "missing") {
		candidateIntegrity = "pin-missing";
		candidateDetail = "Operator --spec-pin was not provided; protected-run identity is unpinned.";
	} else if (pinStatus === "mismatched") {
		candidateIntegrity = "pin-mismatch";
		candidateDetail = `Operator --spec-pin does not match protected-run.json specSha256 (${run.specSha256.slice(0, 12)}).`;
	}

	let modelRecording: EndoBridgeProtectedExperimentV0["modelRecording"] = null;
	if (endoProtectedTrialIsModelConnectedV0(finalRecord)) {
		modelRecording = {
			status: finalRecord.recording.status,
			required: finalRecord.recording.required,
			answeredVerified: endoProtectedSuccessfulExchangesV1(finalRecord),
			totalExchanges: finalRecord.recording.exchanges.length,
		};
	}

	return {
		...base,
		pinStatus,
		observedSpecSha256: run.specSha256,
		runId: run.spec.id,
		runSchemaVersion: run.schemaVersion,
		trialCoordinates: {
			position: finalRecord.trial.position,
			task: finalRecord.trial.task,
			condition: finalRecord.trial.condition,
			trial: finalRecord.trial.trial,
			attempt: finalRecord.trial.attempt,
		},
		recordSha256: finalRecord.recordSha256,
		preflightStatus: finalRecord.preflight.status,
		agent: {
			status: finalRecord.agent.status,
			exitCode: finalRecord.agent.exitCode,
			signal: finalRecord.agent.signal,
			termination: finalRecord.agent.termination,
			scopeEstablished: finalRecord.agent.scope?.established ?? null,
			scopeEnded: finalRecord.agent.scope?.ended ?? null,
			outputDigestVerified,
		},
		qualification,
		evaluation: {
			status: finalRecord.evaluation.status,
			cases:
				finalRecord.evaluation.cases === null
					? null
					: { total: finalRecord.evaluation.cases.total, passed: finalRecord.evaluation.cases.passed },
			reason: finalRecord.evaluation.reason,
			definitionSha256: finalRecord.evaluation.definitionSha256,
			driverSha256: finalRecord.evaluation.driverSha256,
			outputSha256: finalRecord.evaluation.outputSha256,
		},
		modelRecording,
		candidateIntegrity,
		candidateMode,
		baselineSha256,
		changesetSha256,
		candidateSha256,
		submissionSha256,
		candidateDetail,
		invalidating: [...finalRecord.invalidating],
		refusedRecords: report.refusedRecords,
		outcome: selected.outcome,
		problem: selected.outcomeReason,
	};
}

/**
 * Assemble a complete, strictly read-only evidence bridge for one DEVELOP attempt.
 * Reuses existing stores, services and validators; writes nothing, mutates no status, runs no evaluator.
 */
export async function readDevelopEvidenceBridgeV0(
	options: ReadDevelopEvidenceBridgeOptionsV0,
): Promise<ReadDevelopEvidenceBridgeResultV0> {
	const readAtMs = (options.now ?? Date.now)();
	const tasksStore = new DevelopTasksStoreV0(options.root);
	const attemptsStore = new DevelopAttemptsStoreV0(options.root);
	const receiptsStore = new DevelopReceiptsStoreV0(options.root);
	const observationsStore = new DevelopObservationsStoreV0(options.root);

	const attemptsService = new DevelopAttemptsServiceV0(tasksStore, attemptsStore, {
		sessionLog: () => readSessionLogReadOnly(options.root),
	});
	const got = attemptsService.get(options.attemptId);
	if (!got.ok) {
		const code = got.code === "bad-request" ? "bad-request" : got.code === "not-found" ? "not-found" : "unreadable";
		return { ok: false, code, ...(got.reason === undefined ? {} : { reason: got.reason }) };
	}
	const report = got.value;

	const revisionObserver = new GitRevisionObserverV0();
	const receiptsService = new DevelopReceiptsServiceV0(tasksStore, attemptsStore, receiptsStore, {
		observe: (directory, opts) => revisionObserver.observe(directory, opts),
		// Read-only bridge never executes checks; this runner throws if ever invoked.
		run: () => {
			throw new Error("read-only evidence bridge cannot run checks");
		},
		version: options.version ?? "0.0.0",
	});
	const observationsService = new DevelopObservationsServiceV0(tasksStore, attemptsStore, observationsStore, {
		reader: gitStateReaderV0(revisionObserver),
		version: options.version ?? "0.0.0",
	});

	const directory = options.cwd ?? receiptsService.defaultDirectory(options.attemptId);
	// Observe the working tree ONCE and share that exact observation across provenance and receipt relations.
	const takenNow = directory === null ? null : await observationsService.take(directory, { within: true });
	const current = endoReceiptCurrentOfV0(takenNow);

	const receiptsRead = receiptsService.list(options.attemptId, current);
	const receiptList = receiptsRead.ok ? receiptsRead.receipts : null;
	const receiptProblems = receiptsRead.ok ? receiptsRead.problems.length : 0;

	const provenance = (await observationsService.provenance(
		options.attemptId,
		takenNow,
		receiptList === null ? null : receiptList.map((r) => r.receipt),
	)) ?? {
		state: "none" as const,
		observations: [],
		basis: null,
		start: null,
		end: null,
		head: null,
		span: null,
		now: null,
		checked: [],
		overlaps: [],
		notes: [],
	};

	const tasksRead = tasksStore.read();
	const taskRecord = tasksRead.ok
		? (tasksRead.file.tasks.find((t) => t.id === report.attempt.taskId && t.projectId === report.attempt.projectId) ??
			null)
		: null;

	const protectedExperiment =
		options.protectedRunDir === undefined
			? endoEmptyProtectedBridgeV0()
			: inspectProtectedRunForBridgeV0({
					directory: options.protectedRunDir,
					...(options.specPin === undefined ? {} : { specPin: options.specPin }),
					...(options.trial === undefined ? {} : { trial: options.trial }),
				});

	const bridge = endoDevelopEvidenceBridgeV0({
		report,
		task:
			taskRecord === null
				? null
				: { status: taskRecord.status, revision: taskRecord.revision, history: taskRecord.history },
		receipts: receiptList,
		receiptProblems,
		comparedWith: directory,
		current,
		provenance,
		protectedExperiment,
		readAtMs,
	});
	return { ok: true, bridge };
}
