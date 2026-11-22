// Read-only observer of completed protected experiments (`endo.protected-run.v0..v3`) under an operator-named directory
// (`endo studio --protected-runs <dir>`).
//
// Security & provenance boundaries (matching adapters/observe-representation/observer.ts and adapters/omp/observer.ts):
// - Read-only: never creates, writes, or modifies any file or directory.
// - Explicit operator opt-in only: never scans HOME or guesses historical paths.
// - Bounded directory traversal (depth <= 2, max 256 scanned entries, max 64 runs), refusing symlinks and non-regular files.
// - Reuses `inspectProtectedExperimentV0` (adapters/sandbox/protected-report.ts) as the sole definition of validity.
// - Opaque selectors (`e1-<32 hex>`) are keyed digests under Studio's dedicated cockpit key over relative place, inode
//   identity, size, mtime and SHA-256 of `protected-run.json`: replacing or modifying a run invalidates held selectors (404).
// - Zero raw host paths (`agent.directory`, `evaluator.file`, absolute roots), hidden evaluator cases, model keys, or
//   private transcripts ever appear in returned payloads.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	ENDO_PROTECTED_RUN_V0,
	ENDO_PROTECTED_RUN_V1,
	ENDO_PROTECTED_RUN_V2,
	ENDO_PROTECTED_RUN_V3,
	type EndoProtectedModelSpec,
	type EndoProtectedRun,
	endoProtectedModelConnectedV0,
	endoProtectedStagedV2,
	endoProtectedTrialIsModelConnectedV0,
	endoProtectedTrialIsStagedV2,
} from "../../protocol/protected-experiment.ts";
import {
	ENDO_EVOLVE_EXPERIMENT_LIMITS_V0,
	ENDO_EVOLVE_EXPERIMENT_SELECTOR_PATTERN_V0,
	ENDO_EVOLVE_PROTECTED_EXPERIMENT_DETAIL_SCHEMA_V0,
	ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0,
	type EndoEvolveEvidenceAvailabilityV0,
	type EndoEvolveExperimentTypeV0,
	type EndoEvolveProtectedArtifactProvenanceV0,
	type EndoEvolveProtectedAttemptViewV0,
	type EndoEvolveProtectedExperimentDetailV0,
	type EndoEvolveProtectedExperimentSummaryV0,
	type EndoEvolveProtectedExperimentsIndexV0,
	type EndoEvolveProtectedExperimentsObserverV0,
	type EndoEvolveProtectedModelRecordingProvenanceV0,
	type EndoEvolveProtectedTrialViewV0,
	type EndoEvolveRunCountsV0,
} from "../../protocol/protected-experiment-observation.ts";
import type { EndoDigestKeyV0 } from "../../runtime/contracts/keyed-digest.ts";
import {
	type EndoProtectedInspectedAttemptV0,
	type EndoProtectedInspectionV0,
	EndoProtectedRefusalV0,
	inspectProtectedExperimentV0,
} from "../sandbox/protected-report.ts";

const SELECTOR_PURPOSE = "endo.evolve-protected-experiment-selector.v0";

const SUPPORTED_RUN_VERSIONS: ReadonlySet<string> = new Set([
	ENDO_PROTECTED_RUN_V0,
	ENDO_PROTECTED_RUN_V1,
	ENDO_PROTECTED_RUN_V2,
	ENDO_PROTECTED_RUN_V3,
]);

const INTERNAL_SUBDIRS: ReadonlySet<string> = new Set([
	"trials",
	"work",
	"baseline",
	"changeset",
	"candidate",
	"submission",
	"model",
	".git",
	"node_modules",
]);

export interface ProtectedExperimentObserverOptionsV0 {
	/** Existing directory holding one protected run (`protected-run.json`) or a bounded collection of run subdirectories. */
	root: string;
	/** Studio's dedicated cockpit key: opaque selectors are bound to it. */
	key: EndoDigestKeyV0;
}

interface DiscoveredRunDir {
	dirPath: string;
	runFilePath: string;
	relLabel: string;
}

type BoundedReadV0 =
	| { ok: true; bytes: Buffer; dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint }
	| { ok: false; state: "too-large" | "unreadable"; reason: string };

function readRunFileBounded(path: string, maxBytes: number): BoundedReadV0 {
	const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	if (before === undefined || before.isSymbolicLink() || !before.isFile()) {
		return { ok: false, state: "unreadable", reason: "protected-run.json is not a plain regular file." };
	}
	if (before.size > BigInt(maxBytes)) {
		return { ok: false, state: "too-large", reason: "protected-run.json exceeds the 16 MiB bounded read limit." };
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return { ok: false, state: "unreadable", reason: "protected-run.json could not be opened." };
	}
	try {
		const opened = fstatSync(fd, { bigint: true });
		if (!opened.isFile()) {
			return { ok: false, state: "unreadable", reason: "protected-run.json is not a plain regular file." };
		}
		if (opened.size > BigInt(maxBytes)) {
			return { ok: false, state: "too-large", reason: "protected-run.json exceeds the 16 MiB bounded read limit." };
		}
		if (
			before.dev !== opened.dev ||
			before.ino !== opened.ino ||
			before.size !== opened.size ||
			before.mtimeNs !== opened.mtimeNs
		) {
			return { ok: false, state: "unreadable", reason: "protected-run.json changed while being read." };
		}
		const size = Number(opened.size);
		const bytes = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const n = readSync(fd, bytes, offset, size - offset, offset);
			if (n === 0) break;
			offset += n;
		}
		const extra = Buffer.alloc(1);
		const grew = readSync(fd, extra, 0, 1, offset) > 0;
		const after = fstatSync(fd, { bigint: true });
		const still = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		if (after.size > BigInt(maxBytes)) {
			return { ok: false, state: "too-large", reason: "protected-run.json exceeds the 16 MiB bounded read limit." };
		}
		if (
			grew ||
			offset !== size ||
			after.size !== opened.size ||
			after.mtimeNs !== opened.mtimeNs ||
			still === undefined ||
			still.dev !== opened.dev ||
			still.ino !== opened.ino ||
			still.size !== opened.size ||
			still.mtimeNs !== opened.mtimeNs
		) {
			return { ok: false, state: "unreadable", reason: "protected-run.json changed while being read." };
		}
		return { ok: true, bytes, dev: opened.dev, ino: opened.ino, size: opened.size, mtimeNs: opened.mtimeNs };
	} catch {
		return { ok: false, state: "unreadable", reason: "protected-run.json could not be read." };
	} finally {
		closeSync(fd);
	}
}

/** Resolve an operator-named `--protected-runs` directory, or throw a TypeError if unusable. */
export function resolveProtectedRunsRootV0(given: string): string {
	let root: string;
	try {
		root = realpathSync(given);
	} catch {
		throw new TypeError("--protected-runs must name an existing directory");
	}
	if (!lstatSync(root).isDirectory()) throw new TypeError("--protected-runs must name an existing directory");
	return root;
}

function sanitizeLabel(rel: string): string {
	const normalized = rel === "" ? "." : rel.split(sep).join("/");
	const safe = normalized.replace(/[^\x20-\x7e]/g, "?").slice(0, 128);
	return safe.length > 0 ? safe : ".";
}

function sanitizeText(text: string, maxLen = 240): string {
	const cleaned = text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[^\x20-\x7e]/g, "?")
		.trim();
	return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
}

function experimentTypeOf(runSchemaVersion: EndoProtectedRun["schemaVersion"]): EndoEvolveExperimentTypeV0 {
	const model = endoProtectedModelConnectedV0(runSchemaVersion);
	const staged = endoProtectedStagedV2(runSchemaVersion);
	if (model && staged) return "model-connected-staged";
	if (model) return "model-connected-fixed";
	if (staged) return "offline-staged";
	return "offline-fixed";
}

function countsOf(inspection: EndoProtectedInspectionV0): EndoEvolveRunCountsV0 {
	let planned = 0;
	let attempted = 0;
	let notAttempted = 0;
	let qualified = 0;
	let passed = 0;
	let failed = 0;
	let attrition = 0;
	let retries = 0;
	for (const cell of inspection.report.cells) {
		planned += cell.planned;
		attempted += cell.attempted;
		notAttempted += cell.notAttempted;
		qualified += cell.qualified;
		passed += cell.passed;
		failed += cell.failed;
		retries += cell.retries;
		for (const count of Object.values(cell.attrition)) attrition += count;
	}
	return {
		planned,
		attempted,
		notAttempted,
		qualified,
		passed,
		failed,
		attrition,
		retries,
		refusedRecords: inspection.report.refusedRecords.length,
	};
}

function availabilityOf(counts: EndoEvolveRunCountsV0): EndoEvolveEvidenceAvailabilityV0 {
	if (counts.refusedRecords > 0) return "has-refusals";
	if (counts.attempted === 0) return "not-started";
	if (counts.notAttempted > 0) return "partial";
	return "complete";
}

function projectAttempt(a: EndoProtectedInspectedAttemptV0): EndoEvolveProtectedAttemptViewV0 {
	const v = a.record;
	if (v === null) {
		return {
			attempt: a.attempt,
			retryOf: null,
			recordStatus: a.status,
			refusalReason: a.refusalReason === null ? null : sanitizeText(a.refusalReason),
			trialSchemaVersion: null,
			recordSha256: null,
			recordedAt: null,
			finalized: null,
			preflightStatus: null,
			agent: null,
			evaluation: null,
			submission: null,
			modelRecording: null,
			invalidating: [],
		};
	}
	let submission: EndoEvolveProtectedArtifactProvenanceV0;
	if (endoProtectedTrialIsStagedV2(v)) {
		const summary = v.changeset.collection.summary;
		const changedFileCount =
			summary === null
				? null
				: summary.addedFiles + summary.modifiedFiles + summary.deletedFiles + summary.modeChangedFiles;
		const refusalCount = Object.values(v.changeset.collection.refusalCounts).reduce((sum, n) => sum + n, 0);
		submission = {
			mode: "staged-changeset",
			baselineStatus: v.changeset.baseline.status,
			baselineSha256: v.changeset.baseline.sha256,
			collectionStatus: v.changeset.collection.status,
			changesetSha256: v.changeset.collection.changesetSha256,
			verificationStatus: v.changeset.verification.status,
			verificationReason: v.changeset.verification.reason,
			candidateSha256: v.changeset.verification.candidateSha256,
			changedFileCount,
			refusalCount,
			refusalsOmitted: v.changeset.collection.refusalsOmitted,
		};
	} else {
		submission = {
			mode: "fixed-paths",
			status: v.submission.status,
			sha256: v.submission.sha256,
			fileCount: v.submission.files.length,
			refusalCount: v.submission.refusals.length,
		};
	}
	let modelRecording: EndoEvolveProtectedModelRecordingProvenanceV0 | null = null;
	if (endoProtectedTrialIsModelConnectedV0(v)) {
		const answeredVerified = v.recording.exchanges.filter((e) => e.class === "answered" && e.verified).length;
		const refusedRequests =
			v.network.relay.refusals === null
				? null
				: Object.values(v.network.relay.refusals).reduce((sum, n) => sum + n, 0);
		modelRecording = {
			status: v.recording.status,
			required: v.recording.required,
			answeredVerified,
			totalExchanges: v.recording.exchanges.length,
			refusedRequests,
			policySha256: v.network.relay.policySha256,
		};
	}
	return {
		attempt: v.trial.attempt,
		retryOf: v.trial.retryOf,
		recordStatus: "verified",
		refusalReason: null,
		trialSchemaVersion: v.schemaVersion,
		recordSha256: v.recordSha256,
		recordedAt: v.recordedAt,
		finalized: v.controller.finalized,
		preflightStatus: v.preflight.status,
		agent: {
			status: v.agent.status,
			exitCode: v.agent.exitCode,
			signal: v.agent.signal,
			durationMs: v.agent.durationMs,
			termination: v.agent.termination,
		},
		evaluation: {
			status: v.evaluation.status,
			cases:
				v.evaluation.cases === null ? null : { total: v.evaluation.cases.total, passed: v.evaluation.cases.passed },
			reason: v.evaluation.reason === null ? null : sanitizeText(v.evaluation.reason),
			definitionSha256: v.evaluation.definitionSha256,
			driverSha256: v.evaluation.driverSha256,
			outputSha256: v.evaluation.outputSha256,
		},
		submission,
		modelRecording,
		invalidating: [...v.invalidating],
	};
}

export class ProtectedExperimentObserverV0 implements EndoEvolveProtectedExperimentsObserverV0 {
	readonly #root: string;
	readonly #key: EndoDigestKeyV0;

	constructor(options: ProtectedExperimentObserverOptionsV0) {
		this.#root = resolveProtectedRunsRootV0(options.root);
		this.#key = options.key;
	}

	#selectorFor(relLabel: string, identityToken: string): string {
		const digest = this.#key.digest({ purpose: SELECTOR_PURPOSE, relLabel, identityToken }).value;
		return `e1-${digest.slice(0, 32)}`;
	}

	#discover(): {
		candidates: DiscoveredRunDir[];
		skipped: EndoEvolveProtectedExperimentsIndexV0["skipped"];
	} {
		const skipped = { links: 0, notDirectory: 0, overLimit: 0, unreadable: 0 };
		const candidates: DiscoveredRunDir[] = [];
		try {
			if (realpathSync(this.#root) !== this.#root) {
				skipped.links += 1;
				return { candidates, skipped };
			}
		} catch {
			skipped.unreadable += 1;
			return { candidates, skipped };
		}

		let scannedEntries = 0;
		const visit = (dir: string, depth: number): void => {
			// Check if this directory itself holds protected-run.json.
			const runFile = join(dir, "protected-run.json");
			const runStat = lstatSync(runFile, { throwIfNoEntry: false });
			if (runStat !== undefined) {
				if (candidates.length >= ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRuns) {
					skipped.overLimit += 1;
					return;
				}
				const rel = relative(this.#root, dir);
				candidates.push({ dirPath: dir, runFilePath: runFile, relLabel: sanitizeLabel(rel) });
				return;
			}
			if (depth >= ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxScanDepth) return;
			let names: string[];
			try {
				names = readdirSync(dir).sort();
			} catch {
				skipped.unreadable += 1;
				return;
			}
			for (const name of names) {
				if (INTERNAL_SUBDIRS.has(name)) continue;
				if (scannedEntries >= ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxScanEntries) {
					skipped.overLimit += 1;
					break;
				}
				scannedEntries += 1;
				const child = join(dir, name);
				const st = lstatSync(child, { throwIfNoEntry: false });
				if (st === undefined) continue;
				if (st.isSymbolicLink()) {
					skipped.links += 1;
					continue;
				}
				if (!st.isDirectory()) {
					// Plain files beside run directories (e.g. specs, notes) are ignored, not run dirs.
					continue;
				}
				visit(child, depth + 1);
			}
		};

		visit(this.#root, 0);
		return { candidates, skipped };
	}

	#evaluateCandidate(candidate: DiscoveredRunDir): {
		summary: EndoEvolveProtectedExperimentSummaryV0;
		inspection: EndoProtectedInspectionV0 | null;
	} {
		const read = readRunFileBounded(candidate.runFilePath, ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRunFileBytes);
		if (!read.ok) {
			const selector = this.#selectorFor(candidate.relLabel, `failed:${read.state}`);
			return {
				summary: {
					selector,
					label: candidate.relLabel,
					state: read.state,
					problem: read.reason,
					runId: null,
					runSchemaVersion: null,
					reportSchemaVersion: null,
					experimentType: null,
					specSha256: null,
					seed: null,
					createdAt: null,
					taskCount: null,
					conditionCount: null,
					counts: null,
					evidenceAvailability: null,
				},
				inspection: null,
			};
		}
		const contentSha256 = createHash("sha256").update(read.bytes).digest("hex");
		const selector = this.#selectorFor(
			candidate.relLabel,
			`${read.dev.toString()}:${read.ino.toString()}:${read.size.toString()}:${read.mtimeNs.toString()}:${contentSha256}`,
		);
		let parsed: unknown;
		try {
			parsed = JSON.parse(read.bytes.toString("utf8"));
		} catch {
			return {
				summary: {
					selector,
					label: candidate.relLabel,
					state: "invalid",
					problem: "protected-run.json is not valid JSON.",
					runId: null,
					runSchemaVersion: null,
					reportSchemaVersion: null,
					experimentType: null,
					specSha256: null,
					seed: null,
					createdAt: null,
					taskCount: null,
					conditionCount: null,
					counts: null,
					evidenceAvailability: null,
				},
				inspection: null,
			};
		}
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const ver = (parsed as { schemaVersion?: unknown }).schemaVersion;
			if (typeof ver === "string" && !SUPPORTED_RUN_VERSIONS.has(ver)) {
				return {
					summary: {
						selector,
						label: candidate.relLabel,
						state: "unsupported-version",
						problem: "Unsupported protected-run schema version.",
						runId: null,
						runSchemaVersion: sanitizeText(ver, 80),
						reportSchemaVersion: null,
						experimentType: null,
						specSha256: null,
						seed: null,
						createdAt: null,
						taskCount: null,
						conditionCount: null,
						counts: null,
						evidenceAvailability: null,
					},
					inspection: null,
				};
			}
		}
		let inspection: EndoProtectedInspectionV0;
		try {
			inspection = inspectProtectedExperimentV0(candidate.dirPath, {
				maxRunFileBytes: ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRunFileBytes,
				maxTrialFileBytes: ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxTrialFileBytes,
				maxAttemptsPerTrial: ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxAttemptsPerTrial,
			});
		} catch (error) {
			const reason =
				error instanceof EndoProtectedRefusalV0
					? sanitizeText(error.message)
					: "Protected experiment records failed independent validation.";
			return {
				summary: {
					selector,
					label: candidate.relLabel,
					state: "invalid",
					problem: reason,
					runId: null,
					runSchemaVersion: null,
					reportSchemaVersion: null,
					experimentType: null,
					specSha256: null,
					seed: null,
					createdAt: null,
					taskCount: null,
					conditionCount: null,
					counts: null,
					evidenceAvailability: null,
				},
				inspection: null,
			};
		}

		const counts = countsOf(inspection);
		const expType = experimentTypeOf(inspection.run.schemaVersion);
		return {
			summary: {
				selector,
				label: candidate.relLabel,
				state: "readable",
				problem: null,
				runId: inspection.run.spec.id,
				runSchemaVersion: inspection.run.schemaVersion,
				reportSchemaVersion: inspection.report.schemaVersion,
				experimentType: expType,
				specSha256: inspection.run.specSha256,
				seed: inspection.run.seed,
				createdAt: inspection.run.createdAt,
				taskCount: inspection.run.spec.tasks.length,
				conditionCount: inspection.run.spec.conditions.length,
				counts,
				evidenceAvailability: availabilityOf(counts),
			},
			inspection,
		};
	}

	list(): EndoEvolveProtectedExperimentsIndexV0 {
		const { candidates, skipped } = this.#discover();
		const runs = candidates.map((c) => this.#evaluateCandidate(c).summary);
		return {
			schemaVersion: ENDO_EVOLVE_PROTECTED_EXPERIMENTS_INDEX_SCHEMA_V0,
			available: true,
			runs,
			skipped,
		};
	}

	detail(selector: string): EndoEvolveProtectedExperimentDetailV0 | null {
		if (!ENDO_EVOLVE_EXPERIMENT_SELECTOR_PATTERN_V0.test(selector)) return null;
		const { candidates } = this.#discover();
		for (const candidate of candidates) {
			const evaluated = this.#evaluateCandidate(candidate);
			if (evaluated.summary.selector !== selector) continue;
			if (evaluated.summary.state !== "readable" || evaluated.inspection === null) return null;
			const { run, report, trials } = evaluated.inspection;
			const v1 = endoProtectedModelConnectedV0(run.schemaVersion);
			const access = v1 ? (run.spec as EndoProtectedModelSpec).modelAccess : null;
			const staged = endoProtectedStagedV2(run.schemaVersion);

			const refusedLimit = ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxRefusedRecords;
			const refusedRecords = report.refusedRecords.slice(0, refusedLimit).map((r) => ({
				path: sanitizeText(r.path, 200),
				reason: sanitizeText(r.reason, 240),
			}));
			const refusedRecordsOmitted = Math.max(0, report.refusedRecords.length - refusedLimit);

			const trialLimit = ENDO_EVOLVE_EXPERIMENT_LIMITS_V0.maxTrials;
			const projectedTrials: EndoEvolveProtectedTrialViewV0[] = trials.slice(0, trialLimit).map((t) => {
				const attempts = t.attempts.map(projectAttempt);
				return {
					position: t.position,
					task: t.task,
					condition: t.condition,
					trial: t.trial,
					outcome: t.outcome,
					outcomeReason: t.outcomeReason === null ? null : sanitizeText(t.outcomeReason),
					attemptCount: attempts.length,
					retryCount: t.retries,
					finalAttempt: attempts.at(-1) ?? null,
					attempts,
				};
			});
			const trialsOmitted = Math.max(0, trials.length - trialLimit);

			return {
				schemaVersion: ENDO_EVOLVE_PROTECTED_EXPERIMENT_DETAIL_SCHEMA_V0,
				selector,
				label: candidate.relLabel,
				runSchemaVersion: run.schemaVersion,
				reportSchemaVersion: report.schemaVersion,
				experimentType: experimentTypeOf(run.schemaVersion),
				run: {
					id: run.spec.id,
					description: sanitizeText(run.spec.description, 400),
					runner: run.runner,
					specSha256: run.specSha256,
					seed: run.seed,
					seedSource: run.seedSource,
					ordering: run.ordering,
					createdAt: run.createdAt,
					isolation: {
						mechanism: run.isolation.mechanism,
						version: run.isolation.version,
						executableSha256: run.isolation.executableSha256,
						containment: {
							mechanism: run.isolation.containment.mechanism,
							version: run.isolation.containment.version,
							systemdRunSha256: run.isolation.containment.systemdRunSha256,
							tasksMax: run.isolation.containment.tasksMax,
						},
					},
				},
				modelAccess:
					access === null || report.modelAccess === undefined
						? null
						: {
								upstream: access.upstream,
								model: access.model,
								policySha256: report.modelAccess.policySha256,
								minExchanges: access.minExchanges,
								maxExchanges: access.maxExchanges,
								maxCompletionTokens: access.maxCompletionTokens,
							},
				tasks: run.spec.tasks.map((t) => {
					const ev = run.evaluators.find((e) => e.task === t.id);
					return {
						id: t.id,
						submissionMode: staged ? "staged-changeset" : "fixed-paths",
						evaluatorDefinitionSha256: ev?.definitionSha256 ?? t.evaluator.sha256,
						evaluatorDriverSha256: ev?.driverSha256 ?? "",
						referenceQualified: ev?.reference ?? "passed",
						negativeQualified: ev?.negative ?? null,
					};
				}),
				conditions: run.spec.conditions.map((c) => {
					const prof = run.profiles.find((p) => p.condition === c.id);
					return {
						id: c.id,
						description: sanitizeText(c.description, 240),
						profileSha256: prof?.sha256 ?? "",
					};
				}),
				rules: [...report.rules],
				cells: report.cells.map((cell) => ({
					...cell,
					attrition: { ...cell.attrition },
				})),
				refusedRecords,
				refusedRecordsOmitted,
				trials: projectedTrials,
				trialsOmitted,
			};
		}
		return null;
	}
}
