// Project-scoped, write-once store for structured advisory reviews
// (`<root>/develop/coordination-reviews/<projectId>/<reviewId>.json`, E2-D).
//
// Invariants:
// - Partitioned strictly by `projectId` so `--project`-scoped Coordinator status/brief sandboxes mount ONLY the
//   requested project's directory and cannot read foreign projects' reviews.
// - Strictly write-once via `storage/write-once.ts` (`O_EXCL` temp -> fsync -> `link(2)`).
// - Temporary files matching `WRITE_ONCE_TEMPORARY_V0` are ignored on reads.
// - Reviews remain strictly `advisory-agent-review` / `agent-reported` and NEVER write into `develop/receipts/`.
// - Cross-project candidate or assignment references are refused without writing.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { EndoCandidateRefV0, EndoIntendedHarnessFamilyV0 } from "../protocol/develop-coordination.ts";
import {
	ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0,
	ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0,
	ENDO_REVIEW_ID_PATTERN_V0,
	type EndoAdvisoryReviewCheckoutV0,
	type EndoAdvisoryReviewFindingV0,
	type EndoAdvisoryReviewVerdictV0,
	type EndoDevelopAdvisoryReviewV0,
	validateEndoDevelopAdvisoryReviewV0,
} from "../protocol/develop-coordination-reviews.ts";
import { ENDO_PROJECT_ID_PATTERN_V0 } from "../protocol/develop-tasks.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { DevelopAttemptsStoreV0 } from "./develop-attempts.ts";
import { DevelopCoordinationStoreV0 } from "./develop-coordination.ts";
import { ENDO_DEVELOP_DIRECTORY_V0 } from "./develop-tasks.ts";
import {
	checkDirectoriesSyncV0,
	ensureDirectoriesSyncV0,
	readBoundedJsonSyncV0,
	readDirectoryNamesAtMostV0,
	WRITE_ONCE_TEMPORARY_V0,
	writeOnceSyncV0,
} from "./write-once.ts";

export const ENDO_DEVELOP_COORDINATION_REVIEWS_DIRECTORY_V0 = "coordination-reviews";

export interface EndoAdvisoryReviewProblemV0 {
	name: string;
	reason: string;
}

export type EndoProjectReviewsReadV0 =
	| {
			ok: true;
			reviews: EndoDevelopAdvisoryReviewV0[];
			problems: EndoAdvisoryReviewProblemV0[];
			truncated: boolean;
			enumerated: number;
			bytes: number;
	  }
	| { ok: false; reason: "bad-request" | "unsafe-path" | "too-many" | "io" };

export interface EndoRecordAdvisoryReviewInputV0 {
	projectId: string;
	candidateTaskId: string;
	candidateId: string;
	assignmentId: string | null;
	attemptId: string | null;
	reviewer: {
		participantId: string;
		harnessFamily: EndoIntendedHarnessFamilyV0 | null;
		sessionKey: string | null;
		runtimeFingerprintId: string | null;
	};
	verdict: EndoAdvisoryReviewVerdictV0;
	summary: string;
	findings: EndoAdvisoryReviewFindingV0[];
	agentClaimedChecks: string | null;
	checkout: EndoAdvisoryReviewCheckoutV0;
	recordedBy: "operator" | "controller";
}

export type EndoWriteAdvisoryReviewResultV0 =
	| { ok: true; review: EndoDevelopAdvisoryReviewV0 }
	| {
			ok: false;
			code:
				| "bad-request"
				| "not-found"
				| "cross-project"
				| "unreadable"
				| "limit"
				| "unsafe-path"
				| "storage-failed";
			detail?: string;
	  };

function subjectFromCandidate(candidate: EndoCandidateRefV0): EndoDevelopAdvisoryReviewV0["subject"] {
	if (candidate.kind === "git-commit") {
		return {
			kind: "git-commit",
			commonDir: candidate.commonDir,
			commitSha: candidate.commitSha,
			treeSha: candidate.treeSha,
		};
	}
	return {
		kind: "protected-candidate",
		attemptId: candidate.attemptId,
		runId: candidate.runId,
		bindingSha256: candidate.bindingSha256,
		candidateSha256: candidate.candidateSha256,
	};
}

export class DevelopCoordinationReviewsStoreV0 {
	readonly #root: string;
	readonly #develop: string;
	readonly #dir: string;
	readonly #now: () => number;
	readonly #beforeLink: (() => void) | undefined;

	constructor(root: string, options: { now?: () => number; beforeLink?: () => void } = {}) {
		this.#root = root;
		this.#develop = join(root, ENDO_DEVELOP_DIRECTORY_V0);
		this.#dir = join(this.#develop, ENDO_DEVELOP_COORDINATION_REVIEWS_DIRECTORY_V0);
		this.#now = options.now ?? Date.now;
		this.#beforeLink = options.beforeLink;
	}

	get directory(): string {
		return this.#dir;
	}

	projectDirectory(projectId: string): string {
		return join(this.#dir, projectId);
	}

	/**
	 * Record one immutable advisory review bound to an exact declared candidate in `projectId`.
	 * Refuses cross-project candidate or assignment references and never touches `develop/receipts/`.
	 */
	recordReview(input: EndoRecordAdvisoryReviewInputV0): EndoWriteAdvisoryReviewResultV0 {
		if (!ENDO_PROJECT_ID_PATTERN_V0.test(input.projectId))
			return { ok: false, code: "bad-request", detail: "invalid projectId" };
		const coord = new DevelopCoordinationStoreV0(this.#root).read();
		if (!coord.ok)
			return { ok: false, code: "unreadable", detail: `coordination store unreadable (${coord.reason})` };
		const taskEntry = coord.file.taskCandidates.find((t) => t.taskId === input.candidateTaskId);
		if (taskEntry === undefined)
			return { ok: false, code: "not-found", detail: `task ${input.candidateTaskId} has no declared candidates` };
		if (taskEntry.projectId !== input.projectId)
			return {
				ok: false,
				code: "cross-project",
				detail: `candidate task ${input.candidateTaskId} belongs to another project`,
			};
		const candidate = taskEntry.candidates.find((c) => c.candidateId === input.candidateId);
		if (candidate === undefined)
			return { ok: false, code: "not-found", detail: `candidate ${input.candidateId} not found on task` };

		if (input.assignmentId !== null) {
			const assignment = coord.file.assignments.find((a) => a.assignmentId === input.assignmentId);
			if (assignment === undefined)
				return { ok: false, code: "not-found", detail: `assignment ${input.assignmentId}` };
			if (assignment.projectId !== input.projectId)
				return {
					ok: false,
					code: "cross-project",
					detail: `assignment ${input.assignmentId} belongs to another project`,
				};
		}
		if (input.attemptId !== null) {
			const attemptsRead = new DevelopAttemptsStoreV0(this.#root).read();
			if (!attemptsRead.ok)
				return { ok: false, code: "unreadable", detail: `attempts unreadable (${attemptsRead.reason})` };
			const entry = attemptsRead.entries.find((e) => e.attempt.id === input.attemptId);
			if (entry === undefined) return { ok: false, code: "not-found", detail: `attempt ${input.attemptId}` };
			if (entry.attempt.projectId !== input.projectId) {
				return {
					ok: false,
					code: "cross-project",
					detail: `attempt ${input.attemptId} belongs to another project`,
				};
			}
		}

		// Bound count per project before writing.
		const existing = this.readProject(input.projectId);
		if (!existing.ok) {
			return {
				ok: false,
				code: existing.reason === "unsafe-path" ? "unsafe-path" : "storage-failed",
				detail: `review directory ${existing.reason}`,
			};
		}
		if (
			existing.reviews.length + existing.problems.length >=
			ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0.maxReviewsPerProject
		)
			return { ok: false, code: "limit", detail: "per-project advisory review limit reached" };

		const reviewId = `endo.review.${randomBytes(16).toString("hex")}`;
		let review: EndoDevelopAdvisoryReviewV0;
		try {
			review = validateEndoDevelopAdvisoryReviewV0({
				schemaVersion: ENDO_DEVELOP_ADVISORY_REVIEW_SCHEMA_V0,
				reviewId,
				projectId: input.projectId,
				candidateTaskId: input.candidateTaskId,
				candidateId: input.candidateId,
				subject: subjectFromCandidate(candidate),
				assignmentId: input.assignmentId,
				attemptId: input.attemptId,
				reviewer: input.reviewer,
				standing: "advisory-agent-review",
				basis: "agent-reported",
				verdict: input.verdict,
				summary: input.summary,
				findings: input.findings,
				agentClaimedChecks: input.agentClaimedChecks,
				checkout: input.checkout,
				recordedBy: input.recordedBy,
				recordedAtMs: this.#now(),
			});
		} catch (error) {
			return { ok: false, code: "bad-request", detail: error instanceof Error ? error.message : "invalid review" };
		}

		const bytes = Buffer.from(`${canonicalEndoJsonV0(review as never)}\n`, "utf8");
		if (bytes.length > ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0.maxRecordBytes)
			return { ok: false, code: "limit", detail: "review record exceeds byte limit" };

		const projDir = this.projectDirectory(input.projectId);
		if (!ensureDirectoriesSyncV0([this.#develop, this.#dir, projDir]))
			return { ok: false, code: "unsafe-path", detail: "review directory path is unsafe" };

		const written = writeOnceSyncV0(projDir, `${review.reviewId}.json`, bytes, this.#beforeLink);
		if (written !== "created")
			return { ok: false, code: "storage-failed", detail: `write-once review returned ${written}` };
		return { ok: true, review };
	}

	/** Read all advisory reviews in ONE project directory only (read-only, link-refusing, bounded). */
	readProject(projectId: string, budget?: { files: number; bytes: number }): EndoProjectReviewsReadV0 {
		if (!ENDO_PROJECT_ID_PATTERN_V0.test(projectId)) return { ok: false, reason: "bad-request" };
		const projDir = this.projectDirectory(projectId);
		const dirs = checkDirectoriesSyncV0([this.#develop, this.#dir, projDir]);
		if (dirs === "missing") return { ok: true, reviews: [], problems: [], truncated: false, enumerated: 0, bytes: 0 };
		if (dirs !== "ok") return { ok: false, reason: dirs };

		const maxEntries =
			budget !== undefined
				? Math.max(0, budget.files)
				: ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0.maxReviewsPerProject + 64;
		let names: string[] | null;
		try {
			names = readDirectoryNamesAtMostV0(projDir, maxEntries);
		} catch {
			return { ok: false, reason: "io" };
		}
		if (names === null) return { ok: false, reason: "too-many" };

		const reviews: EndoDevelopAdvisoryReviewV0[] = [];
		const problems: EndoAdvisoryReviewProblemV0[] = [];
		let usedBytes = 0;
		let truncated = false;
		const reserve = (size: number): boolean => {
			if (budget !== undefined && usedBytes + size > budget.bytes) {
				truncated = true;
				return false;
			}
			usedBytes += size;
			return true;
		};

		for (const name of names) {
			if (WRITE_ONCE_TEMPORARY_V0.test(name)) continue;
			if (!name.endsWith(".json")) {
				problems.push({ name, reason: "unknown-file" });
				continue;
			}
			const stem = name.slice(0, -5);
			if (!ENDO_REVIEW_ID_PATTERN_V0.test(stem)) {
				problems.push({ name, reason: "unknown-file" });
				continue;
			}
			const read = readBoundedJsonSyncV0(
				join(projDir, name),
				ENDO_DEVELOP_ADVISORY_REVIEW_LIMITS_V0.maxRecordBytes,
				reserve,
			);
			if (!read.ok) {
				if (truncated) break;
				problems.push({ name, reason: read.reason });
				continue;
			}
			try {
				const record = validateEndoDevelopAdvisoryReviewV0(read.value);
				if (record.reviewId !== stem || record.projectId !== projectId) {
					problems.push({ name, reason: "misnamed" });
					continue;
				}
				reviews.push(record);
			} catch {
				problems.push({ name, reason: "invalid" });
			}
		}

		reviews.sort((a, b) => (a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : 0));
		return { ok: true, reviews, problems, truncated, enumerated: names.length, bytes: usedBytes };
	}
}
