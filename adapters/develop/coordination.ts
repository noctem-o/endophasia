// Host-side re-verification for DEVELOP coordination (docs/designs/coordinator-assignment-implementation.md): the Git and protected-run
// facts the operator CLI needs BEFORE it calls the coordination store, and the identity/workspace readers the host projection injects.
// Read-only: Git runs through the hardened read-only observer (adapters/git/revision-observer.ts); protected attempts are re-assessed with
// the existing 15-check reader (adapters/develop/protected-attempt.ts). Nothing is written, checked out, fetched or launched, and no
// coordination lock is held while any of this runs.

import { realpathSync } from "node:fs";
import type { EndoCandidateIdentityReadingV0 } from "../../protocol/coordinator-coordination.ts";
import {
	ENDO_GIT_OID_PATTERN_V0,
	type EndoCandidateRefV0,
	type EndoWorkspaceRegistrationV0,
} from "../../protocol/develop-coordination.ts";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import type { EndoDevelopProjectV0 } from "../../protocol/develop-tasks.ts";
import type { EndoCandidateDeclarationV0 } from "../../storage/develop-coordination.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";
import { readProtectedAttemptRecordsV0, readProtectedAttemptV0 } from "./protected-attempt.ts";

export type EndoCoordinationResolveFailureV0 = {
	ok: false;
	code: "bad-request" | "cross-project" | "not-found" | "unsupported";
	detail: string;
};

const real = (path: string): string | null => {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
};

export class DevelopCoordinationGitV0 {
	readonly #observer: GitRevisionObserverV0;

	constructor(observer: GitRevisionObserverV0 = new GitRevisionObserverV0()) {
		this.#observer = observer;
	}

	/** The worktree at `path` now: its real top, common directory, HEAD and cleanliness; null when Git cannot observe it. */
	async workspace(path: string): Promise<EndoReceiptCurrentV0 | null> {
		const observed = await this.#observer.observe(path);
		if (!observed.ok) return null;
		const o = observed.observation;
		return { worktree: o.worktree, commonDir: o.commonDir, commit: o.commit, clean: o.dirty.length === 0 };
	}

	/**
	 * Where an assignment's workspace stands: the project's registered path, or another worktree of the SAME repository (same Git common
	 * directory). Anything else is refused. The path returned is canonical (real).
	 */
	async resolveWorkspace(
		project: EndoDevelopProjectV0,
		given: string,
	): Promise<
		{ ok: true; worktreePath: string; registration: EndoWorkspaceRegistrationV0 } | EndoCoordinationResolveFailureV0
	> {
		const worktreePath = real(given);
		if (worktreePath === null)
			return { ok: false, code: "bad-request", detail: "--worktree must be an existing directory" };
		const projectPath = real(project.path);
		if (projectPath !== null && projectPath === worktreePath)
			return { ok: true, worktreePath, registration: "project-path" };
		const [mine, theirs] = await Promise.all([
			this.workspace(worktreePath),
			projectPath === null ? null : this.workspace(projectPath),
		]);
		if (mine === null || theirs === null)
			return {
				ok: false,
				code: "bad-request",
				detail: "the worktree or the project could not be observed with Git",
			};
		if (mine.worktree !== worktreePath)
			return { ok: false, code: "bad-request", detail: "--worktree must be the top of a Git working tree" };
		if (mine.commonDir !== theirs.commonDir)
			return {
				ok: false,
				code: "cross-project",
				detail: "the worktree belongs to a different repository than the project",
			};
		return { ok: true, worktreePath, registration: "same-repository-unregistered" };
	}

	/**
	 * An ordinary Git candidate: the exact commit (a FULL object id; branch names and short ids are refused) and the tree Git resolves it
	 * to, in a worktree of the project's repository. The caller passes the result to the store, which records it as operator-declared.
	 */
	async resolveGitCandidate(
		project: EndoDevelopProjectV0,
		worktree: string,
		commit: string,
		attemptId: string | null,
	): Promise<{ ok: true; candidate: EndoCandidateDeclarationV0 } | EndoCoordinationResolveFailureV0> {
		if (!ENDO_GIT_OID_PATTERN_V0.test(commit))
			return {
				ok: false,
				code: "bad-request",
				detail:
					"--commit must be a full 40- or 64-hex object id; branch names, tags and short ids are not immutable candidates",
			};
		const place = await this.resolveWorkspace(project, worktree);
		if (!place.ok) return place;
		const observed = await this.workspace(place.worktreePath);
		if (observed === null)
			return { ok: false, code: "bad-request", detail: "the worktree could not be observed with Git" };
		const tree = await this.#observer.commitTree(place.worktreePath, commit);
		if (tree === null)
			return { ok: false, code: "not-found", detail: `commit ${commit} does not resolve in this repository` };
		return {
			ok: true,
			candidate: {
				kind: "git-commit",
				commonDir: observed.commonDir,
				worktreePath: place.worktreePath,
				commitSha: commit,
				treeSha: tree,
				attemptId,
			},
		};
	}

	/** Re-verify a stored candidate now. A Git candidate: same repository and the same commit → tree; a protected one: re-established. */
	async identity(root: string, c: EndoCandidateRefV0): Promise<EndoCandidateIdentityReadingV0> {
		if (c.kind === "protected-candidate") return protectedIdentityV0(root, c);
		const observed = await this.workspace(c.worktreePath);
		if (observed === null) return "unavailable";
		if (observed.commonDir !== c.commonDir) return "mismatch";
		const tree = await this.#observer.commitTree(c.worktreePath, c.commitSha);
		return tree === c.treeSha ? "verified" : "mismatch";
	}
}

/**
 * A protected candidate as the existing reader establishes it NOW: the attempt's launch and binding re-assessed (15 checks), the
 * association `established` (never merely operator-declared), and the binding sealing a staged-changeset candidate digest.
 */
export function resolveProtectedCandidateV0(
	root: string,
	attemptId: string,
): { ok: true; candidate: EndoCandidateDeclarationV0 } | EndoCoordinationResolveFailureV0 {
	const reading = readProtectedAttemptV0({ root, attemptId });
	if (reading === null)
		return { ok: false, code: "not-found", detail: `no protected launch or binding for ${attemptId}` };
	if (reading.attemptAssociation !== "established")
		return {
			ok: false,
			code: "unsupported",
			detail: `the protected association reads ${reading.attemptAssociation}, not established`,
		};
	const { binding } = readProtectedAttemptRecordsV0(root, attemptId);
	if (binding.state !== "present") return { ok: false, code: "not-found", detail: "no usable binding record" };
	const c = binding.record.target.candidate;
	if (c.mode !== "staged-changeset")
		return {
			ok: false,
			code: "unsupported",
			detail: "only staged-changeset protected candidates carry a candidate digest",
		};
	return {
		ok: true,
		candidate: {
			kind: "protected-candidate",
			attemptId,
			runId: binding.record.target.runId,
			bindingSha256: binding.record.bindingSha256,
			candidateSha256: c.candidateSha256,
		},
	};
}

function protectedIdentityV0(
	root: string,
	c: Extract<EndoCandidateRefV0, { kind: "protected-candidate" }>,
): EndoCandidateIdentityReadingV0 {
	try {
		const now = resolveProtectedCandidateV0(root, c.attemptId);
		if (!now.ok || now.candidate.kind !== "protected-candidate") return "not-established";
		return now.candidate.bindingSha256 === c.bindingSha256 &&
			now.candidate.candidateSha256 === c.candidateSha256 &&
			now.candidate.runId === c.runId
			? "established"
			: "not-established";
	} catch {
		return "unavailable";
	}
}
