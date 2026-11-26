// Host-side re-verification for DEVELOP coordination (docs/designs/coordinator-assignment-implementation.md, E2-C):
// the Git and protected-run facts the operator CLI and dispatchers need BEFORE calling the coordination store, and
// the identity/workspace readers the host projection injects.
//
// Read-only: Git runs through the hardened read-only observer (adapters/git/revision-observer.ts); protected attempts
// are re-assessed with the existing 15-check reader (adapters/develop/protected-attempt.ts). Nothing is written,
// created, checked out, fetched, deleted, or merged, and no coordination lock is held while any of this runs.

import { lstatSync, realpathSync } from "node:fs";
import type { EndoCandidateIdentityReadingV0 } from "../../protocol/coordinator-coordination.ts";
import {
	ENDO_GIT_OID_PATTERN_V0,
	type EndoCandidateRefV0,
	type EndoRegisteredWorktreeV0,
	type EndoWorkspaceRegistrationV0,
} from "../../protocol/develop-coordination.ts";
import type { EndoReceiptCurrentV0 } from "../../protocol/develop-receipts.ts";
import type { EndoDevelopProjectV0 } from "../../protocol/develop-tasks.ts";
import type { EndoCandidateDeclarationV0 } from "../../storage/develop-coordination.ts";
import { inspectLinkedGitPointerV0 } from "../../storage/git-worktree-pointer.ts";
import { GitRevisionObserverV0 } from "../git/revision-observer.ts";
import { readProtectedAttemptRecordsV0, readProtectedAttemptV0 } from "./protected-attempt.ts";

export type EndoCoordinationResolveFailureV0 = {
	ok: false;
	code: "bad-request" | "cross-project" | "not-found" | "unsupported" | "worktree-not-registered";
	detail: string;
};

export interface EndoValidatedSiblingWorktreeV0 {
	worktreePath: string;
	commonDir: string;
	gitDir: string;
	headCommit: string;
	headTree: string;
	clean: boolean;
}

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
	 * Strictly validate a candidate sibling Git worktree for explicit operator registration (E2-C).
	 * Checks canonical path (rejects symlinked leaf or `.git`), shared `commonDir` with `project.path`,
	 * bidirectional `.git` <-> `<commonDir>/worktrees/<name>/gitdir` identity, and hardened Git observation.
	 */
	async validateSiblingWorktree(
		project: EndoDevelopProjectV0,
		given: string,
	): Promise<{ ok: true; worktree: EndoValidatedSiblingWorktreeV0 } | EndoCoordinationResolveFailureV0> {
		// Refuse a symlinked worktree path directly if caller passed an exact path whose leaf is a symlink?
		// Wait: on registration we resolve canonical path first, then verify the canonical path is a plain directory
		// and not a primary checkout, and verify `.git` is NOT a symlink.
		const worktreePath = real(given);
		if (worktreePath === null)
			return { ok: false, code: "bad-request", detail: "--worktree must be an existing directory" };
		const wtStat = lstatSync(worktreePath, { throwIfNoEntry: false });
		if (wtStat === undefined || !wtStat.isDirectory())
			return { ok: false, code: "bad-request", detail: "--worktree must be a plain directory" };

		const projectPath = real(project.path);
		if (projectPath === null)
			return { ok: false, code: "bad-request", detail: "the project's primary path does not exist" };
		if (worktreePath === projectPath)
			return {
				ok: false,
				code: "bad-request",
				detail:
					"the project's primary checkout is already registered in tasks.json; pass a sibling linked worktree",
			};

		const primaryObs = await this.#observer.observe(projectPath);
		if (!primaryObs.ok)
			return {
				ok: false,
				code: "bad-request",
				detail: `the project's primary checkout could not be observed with Git (${primaryObs.reason})`,
			};
		const primaryCommonDir = primaryObs.observation.commonDir;

		const pointer = inspectLinkedGitPointerV0(worktreePath, primaryCommonDir);
		if (!pointer.ok) return { ok: false, code: "bad-request", detail: pointer.detail };

		const siblingObs = await this.#observer.observe(worktreePath);
		if (!siblingObs.ok)
			return {
				ok: false,
				code: "bad-request",
				detail: `the sibling worktree could not be observed with Git (${siblingObs.reason})`,
			};
		if (siblingObs.observation.worktree !== worktreePath)
			return { ok: false, code: "bad-request", detail: "--worktree must be the top of a Git working tree" };
		if (!siblingObs.observation.linked)
			return { ok: false, code: "bad-request", detail: "sibling worktree must be a linked Git worktree" };
		if (siblingObs.observation.commonDir !== primaryCommonDir)
			return {
				ok: false,
				code: "cross-project",
				detail: "the sibling worktree belongs to a different repository than the project",
			};

		return {
			ok: true,
			worktree: {
				worktreePath,
				commonDir: primaryCommonDir,
				gitDir: pointer.gitDir,
				headCommit: siblingObs.observation.commit,
				headTree: siblingObs.observation.tree,
				clean: siblingObs.observation.dirty.length === 0,
			},
		};
	}

	/**
	 * Re-validate an already-registered sibling worktree before dispatch or HEAD observation (E2-C, AT14).
	 * Detects path substitution, symlink replacement, stale registration, and malicious `.git` pointer tampering.
	 */
	async revalidateRegisteredWorktree(
		project: EndoDevelopProjectV0,
		registered: EndoRegisteredWorktreeV0,
	): Promise<{ ok: true; worktree: EndoValidatedSiblingWorktreeV0 } | EndoCoordinationResolveFailureV0> {
		if (registered.projectId !== project.id)
			return { ok: false, code: "cross-project", detail: "registered worktree belongs to another project" };
		// Reject symlink substitution at the registered path itself (lstat BEFORE realpath).
		const st = lstatSync(registered.worktreePath, { throwIfNoEntry: false });
		if (st === undefined || !st.isDirectory())
			return {
				ok: false,
				code: "worktree-not-registered",
				detail: "registered worktree path is missing, substituted with a symlink, or no longer a directory",
			};
		const canonicalNow = real(registered.worktreePath);
		if (canonicalNow !== registered.worktreePath)
			return {
				ok: false,
				code: "worktree-not-registered",
				detail: "registered worktree path no longer resolves canonically (possible path substitution)",
			};
		const validated = await this.validateSiblingWorktree(project, registered.worktreePath);
		if (!validated.ok) return { ok: false, code: "worktree-not-registered", detail: validated.detail };
		if (
			validated.worktree.commonDir !== registered.commonDir ||
			validated.worktree.gitDir !== registered.gitDir ||
			validated.worktree.worktreePath !== registered.worktreePath
		)
			return {
				ok: false,
				code: "worktree-not-registered",
				detail: "registered worktree identity (commonDir/gitDir) no longer matches registration",
			};
		return validated;
	}

	/**
	 * Observe a registered sibling worktree's HEAD ONLY after full re-validation; returns null on any mismatch/tampering.
	 */
	async observeRegisteredWorktree(
		project: EndoDevelopProjectV0,
		registered: EndoRegisteredWorktreeV0,
	): Promise<EndoReceiptCurrentV0 | null> {
		const valid = await this.revalidateRegisteredWorktree(project, registered);
		if (!valid.ok) return null;
		return {
			worktree: valid.worktree.worktreePath,
			commonDir: valid.worktree.commonDir,
			commit: valid.worktree.headCommit,
			clean: valid.worktree.clean,
		};
	}

	/**
	 * Where an assignment's workspace stands: the project's registered path, an explicitly registered sibling worktree
	 * (re-validated against `registeredWorktrees`), or another unregistered worktree of the SAME repository.
	 * Anything else is refused. The path returned is canonical (real).
	 */
	async resolveWorkspace(
		project: EndoDevelopProjectV0,
		given: string,
		registeredWorktrees: readonly EndoRegisteredWorktreeV0[] = [],
	): Promise<
		{ ok: true; worktreePath: string; registration: EndoWorkspaceRegistrationV0 } | EndoCoordinationResolveFailureV0
	> {
		const worktreePath = real(given);
		if (worktreePath === null)
			return { ok: false, code: "bad-request", detail: "--worktree must be an existing directory" };
		const projectPath = real(project.path);
		if (projectPath !== null && projectPath === worktreePath)
			return { ok: true, worktreePath, registration: "project-path" };

		const reg = registeredWorktrees.find((w) => w.projectId === project.id && w.worktreePath === worktreePath);
		if (reg !== undefined) {
			const valid = await this.revalidateRegisteredWorktree(project, reg);
			if (!valid.ok) return valid;
			return { ok: true, worktreePath, registration: "registered-sibling" };
		}

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
		registeredWorktrees: readonly EndoRegisteredWorktreeV0[] = [],
	): Promise<{ ok: true; candidate: EndoCandidateDeclarationV0 } | EndoCoordinationResolveFailureV0> {
		if (!ENDO_GIT_OID_PATTERN_V0.test(commit))
			return {
				ok: false,
				code: "bad-request",
				detail:
					"--commit must be a full 40- or 64-hex object id; branch names, tags and short ids are not immutable candidates",
			};
		const place = await this.resolveWorkspace(project, worktree, registeredWorktrees);
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

	/** Re-verify a stored candidate now. A Git candidate: same repository and the same commit -> tree; a protected one: re-established. */
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
