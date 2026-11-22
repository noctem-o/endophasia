// Staged change sets checked against the COMPLETE pinned baseline (docs/designs/protected-staged-changeset.md): the residual gap #163 left
// open, where a digest-valid manifest can name an "added" path that collides with an unchanged baseline file, which the manifest alone
// cannot reveal. Also the reconstruction of a candidate from pristine baseline bytes plus verified changes, and the version 2/3 spec
// readers. Deterministic, filesystem-only: no sandbox, no process, no listener.

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureWorkspaceBaselineV0,
	collectStagedChangeSetV0,
	endoChangeSetDigestV0,
	endoStagedCandidateRecordV0,
	reconstructStagedCandidateV0,
	verifyStagedChangeSetV0,
} from "../adapters/sandbox/staged-changeset.ts";
import { endoProtectedStagedBaselineV2 } from "../cli/experiment-protected.ts";
import {
	ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2,
	ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2,
	readEndoProtectedSpecV0,
} from "../protocol/protected-experiment.ts";
import {
	DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	ENDO_STAGED_CHANGESET_V0,
	type EndoChangeSetLimitsV0,
	type EndoStagedChangeV0,
	type EndoWorkspaceBaselineV0,
} from "../protocol/staged-changeset.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoProtectedChangeSetRefusalsV2 } from "../runtime/contracts/protected-experiment.ts";

const cleanup: string[] = [];
function chmodTree(path: string): void {
	try {
		const s = statSync(path);
		chmodSync(path, s.isDirectory() ? 0o700 : 0o600);
		if (s.isDirectory()) for (const n of readdirSync(path)) chmodTree(join(path, n));
	} catch {
		// gone
	}
}
afterEach(() => {
	for (const dir of cleanup.splice(0)) {
		chmodTree(dir);
		rmSync(dir, { recursive: true, force: true });
	}
});
const fresh = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), `endo-staged-${prefix}-`));
	cleanup.push(dir);
	return dir;
};
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

const LIMITS: EndoChangeSetLimitsV0 = {
	maxFileBytes: 65_536,
	maxTotalStagedBytes: 262_144,
	maxWorkspaceBytes: 1_048_576,
	maxWalkedEntries: 256,
	maxChangedFiles: 32,
	maxDepth: 8,
};

function writeTree(root: string, files: Record<string, string>): void {
	mkdirSync(root, { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content, { mode: 0o644 });
	}
}

/** A baseline pinned from content (as the controller pins a task's workspace) and materialized as a trusted tree. */
function pinned(files: Record<string, string>): { baseline: EndoWorkspaceBaselineV0; dir: string } {
	const baseline = endoProtectedStagedBaselineV2(files);
	const dir = join(fresh("baseline"), "tree");
	writeTree(dir, files);
	const captured = captureWorkspaceBaselineV0(dir, LIMITS);
	if (!captured.ok || captured.baseline.sha256 !== baseline.sha256) throw new Error("baseline did not materialize");
	return { baseline, dir };
}

const state = (content: string, executable = false) => ({
	bytes: Buffer.byteLength(content),
	sha256: sha(content),
	executable,
});

/**
 * A handcrafted staging directory whose manifest is valid on its own and digest-consistent (the summary and both digests recomputed), as a
 * hostile or buggy producer could write it. "unchanged" is how many baseline files the producer claims it left untouched.
 */
function handcrafted(
	baseline: EndoWorkspaceBaselineV0,
	changes: EndoStagedChangeV0[],
	staged: Record<string, string>,
	unchanged: number,
): string {
	const dir = join(fresh("staging"), "staging");
	mkdirSync(join(dir, "files"), { recursive: true });
	for (const [path, content] of Object.entries(staged)) {
		mkdirSync(dirname(join(dir, "files", path)), { recursive: true });
		writeFileSync(join(dir, "files", path), content, { mode: 0o444 });
	}
	const n = (k: EndoStagedChangeV0["kind"]) => changes.filter((c) => c.kind === k).length;
	const summary = {
		baselineFiles: unchanged + n("modified") + n("mode") + n("deleted"),
		candidateFiles: unchanged + n("modified") + n("mode") + n("added"),
		unchangedFiles: unchanged,
		addedFiles: n("added"),
		modifiedFiles: n("modified"),
		modeChangedFiles: n("mode"),
		deletedFiles: n("deleted"),
		stagedBytes: changes.reduce((t, c) => t + (c.after?.bytes ?? 0), 0),
	};
	const manifest = {
		schemaVersion: ENDO_STAGED_CHANGESET_V0,
		baselineSha256: baseline.sha256,
		baselineRootGitExcluded: false,
		changes,
		summary,
		changesetSha256: endoChangeSetDigestV0(baseline.sha256, false, changes, summary),
	};
	writeFileSync(join(dir, "manifest.json"), canonicalEndoJsonV0(manifest), { mode: 0o444 });
	return dir;
}

const BASE = { "README.md": "readme\n", lib: "lib is a file\n", "src/a.mjs": "export const a = 1;\n" };

describe("verifyStagedChangeSetV0 against the complete pinned baseline record and tree", () => {
	it("refuses an added path beneath an unchanged baseline file, which the manifest and its pins alone accept", () => {
		const { baseline } = pinned(BASE);
		const staging = handcrafted(
			baseline,
			[{ path: "lib/x.mjs", kind: "added", before: null, after: state("x\n") }],
			{ "lib/x.mjs": "x\n" },
			3,
		);
		// The gap: digest-valid, pin-valid, and a possible tree on the manifest's own terms.
		expect(verifyStagedChangeSetV0(staging, { expectedBaselineSha256: baseline.sha256 }, LIMITS)).toMatchObject({
			ok: true,
		});
		// Closed by the baseline record.
		const v = verifyStagedChangeSetV0(staging, { expectedBaselineSha256: baseline.sha256, baseline }, LIMITS);
		expect(v).toMatchObject({ ok: false, reason: "baseline-conflict" });
		expect((v as { detail: string }).detail).toContain("lib/x.mjs beneath regular file lib");
	});

	it("refuses an added path above an unchanged baseline file, and an added path the baseline already holds", () => {
		const { baseline } = pinned(BASE);
		const above = handcrafted(
			baseline,
			[{ path: "src", kind: "added", before: null, after: state("s\n") }],
			{ src: "s\n" },
			3,
		);
		expect(verifyStagedChangeSetV0(above, {}, LIMITS)).toMatchObject({ ok: true });
		expect(verifyStagedChangeSetV0(above, { baseline }, LIMITS)).toMatchObject({
			ok: false,
			reason: "baseline-conflict",
		});
		const again = handcrafted(
			baseline,
			[{ path: "README.md", kind: "added", before: null, after: state("other\n") }],
			{ "README.md": "other\n" },
			3,
		);
		expect(verifyStagedChangeSetV0(again, {}, LIMITS)).toMatchObject({ ok: true });
		expect(verifyStagedChangeSetV0(again, { baseline }, LIMITS)).toMatchObject({
			ok: false,
			reason: "baseline-conflict",
			detail: "added path README.md is already a baseline file",
		});
	});

	it("refuses a before state that is not the baseline's, a deletion of a file the baseline lacks, and a lying count", () => {
		const { baseline } = pinned(BASE);
		const wrongBefore = handcrafted(
			baseline,
			[{ path: "README.md", kind: "modified", before: state("not the readme\n"), after: state("new\n") }],
			{ "README.md": "new\n" },
			2,
		);
		expect(verifyStagedChangeSetV0(wrongBefore, {}, LIMITS)).toMatchObject({ ok: true });
		expect(verifyStagedChangeSetV0(wrongBefore, { baseline }, LIMITS)).toMatchObject({
			reason: "baseline-conflict",
			detail: "the before state of README.md is not the baseline's",
		});
		const ghost = handcrafted(
			baseline,
			[{ path: "ghost", kind: "deleted", before: state("g\n"), after: null }],
			{},
			3,
		);
		expect(verifyStagedChangeSetV0(ghost, { baseline }, LIMITS)).toMatchObject({ reason: "baseline-conflict" });
		// Claims one unchanged file where the baseline record leaves two: the counts contradict the record.
		const fewer = handcrafted(
			baseline,
			[{ path: "README.md", kind: "deleted", before: state("readme\n"), after: null }],
			{},
			1,
		);
		expect(verifyStagedChangeSetV0(fewer, { baseline }, LIMITS)).toMatchObject({
			reason: "baseline-conflict",
			detail: "the manifest's baseline file count is not the baseline's",
		});
	});

	it("refuses impossible manifests with recomputed valid digests: ancestor conflicts in the before and in the after state", () => {
		const { baseline } = pinned(BASE);
		const before = handcrafted(
			baseline,
			[
				{ path: "lib", kind: "deleted", before: state("lib is a file\n"), after: null },
				{ path: "lib/y", kind: "deleted", before: state("y\n"), after: null },
			],
			{},
			2,
		);
		expect(verifyStagedChangeSetV0(before, { baseline }, LIMITS)).toMatchObject({
			ok: false,
			reason: "invalid-manifest",
		});
		const after = handcrafted(
			baseline,
			[
				{ path: "n", kind: "added", before: null, after: state("n\n") },
				{ path: "n/m", kind: "added", before: null, after: state("m\n") },
			],
			// A tree cannot hold both on disk; the manifest is refused before any staged file is read.
			{ "n/m": "m\n" },
			3,
		);
		expect(verifyStagedChangeSetV0(after, { baseline }, LIMITS)).toMatchObject({
			ok: false,
			reason: "invalid-manifest",
		});
	});

	it("refuses when the trusted baseline tree on disk is not the pinned record, and needs the record to judge a tree", () => {
		const { baseline, dir } = pinned(BASE);
		const work = join(fresh("work"), "w");
		writeTree(work, { ...BASE, "README.md": "changed\n" });
		const staging = join(fresh("c"), "s");
		expect(collectStagedChangeSetV0(baseline, work, staging, LIMITS).status).toBe("collected");
		expect(verifyStagedChangeSetV0(staging, { baseline, baselineTree: dir }, LIMITS)).toMatchObject({ ok: true });
		writeFileSync(join(dir, "src/a.mjs"), "export const a = 2;\n");
		expect(verifyStagedChangeSetV0(staging, { baseline, baselineTree: dir }, LIMITS)).toMatchObject({
			ok: false,
			reason: "baseline-mismatch",
		});
		expect(() => verifyStagedChangeSetV0(staging, { baselineTree: dir }, LIMITS)).toThrow(/baseline record/);
	});
});

describe("reconstructStagedCandidateV0: a fresh candidate from pristine baseline bytes plus verified changes", () => {
	function collected() {
		const { baseline, dir } = pinned({ ...BASE, "bin/run.sh": "#!/bin/sh\n", "old/x": "x\n", "old/y": "y\n" });
		const work = join(fresh("work"), "w");
		// README.md deleted; lib file -> directory; old/ directory -> file; bin/run.sh mode only; src/a.mjs modified; new.txt added.
		writeTree(work, {
			"src/a.mjs": "export const a = 42;\n",
			"lib/index.mjs": "export {};\n",
			"new.txt": "new\n",
			"bin/run.sh": "#!/bin/sh\n",
			old: "old is a file\n",
		});
		chmodSync(join(work, "bin/run.sh"), 0o755);
		const staging = join(fresh("c"), "s");
		const c = collectStagedChangeSetV0(baseline, work, staging, LIMITS);
		if (c.status !== "collected") throw new Error(JSON.stringify(c.refusals));
		return { baseline, dir, work, staging, manifest: c.manifest };
	}

	it("rebuilds exactly the implied tree, read-only, never executable, with every kind of change", () => {
		const { baseline, dir, staging, manifest } = collected();
		expect(manifest.summary).toMatchObject({
			addedFiles: 3,
			modifiedFiles: 1,
			modeChangedFiles: 1,
			deletedFiles: 4,
			unchangedFiles: 0,
		});
		expect(verifyStagedChangeSetV0(staging, { baseline, baselineTree: dir }, LIMITS)).toMatchObject({ ok: true });
		const out = join(fresh("candidate"), "candidate");
		const r = reconstructStagedCandidateV0(manifest, baseline, dir, staging, out, LIMITS);
		if (!r.ok) throw new Error(r.detail);
		expect(r.candidate.sha256).toBe(endoStagedCandidateRecordV0(manifest, baseline).sha256);
		expect(r.candidate.files.map((f) => f.path)).toEqual([
			"bin/run.sh",
			"lib/index.mjs",
			"new.txt",
			"old",
			"src/a.mjs",
		]);
		expect(r.candidate.files.find((f) => f.path === "bin/run.sh")?.executable).toBe(true);
		for (const f of r.candidate.files) {
			expect(statSync(join(out, f.path)).mode & 0o777).toBe(0o444);
			expect(sha(readFileSync(join(out, f.path)))).toBe(f.sha256);
		}
		expect(existsSync(join(out, "README.md"))).toBe(false);
	});

	it("refuses staged bytes swapped after verification, and a baseline file swapped after verification, leaving nothing", () => {
		const a = collected();
		chmodSync(join(a.staging, "files/src/a.mjs"), 0o644);
		writeFileSync(join(a.staging, "files/src/a.mjs"), "export const a = 43;\n");
		chmodSync(join(a.staging, "files/src/a.mjs"), 0o444);
		const out = join(fresh("candidate"), "candidate");
		expect(reconstructStagedCandidateV0(a.manifest, a.baseline, a.dir, a.staging, out, LIMITS)).toMatchObject({
			ok: false,
			reason: "staged-bytes-mismatch",
		});
		expect(existsSync(out)).toBe(false);
		// A baseline file the candidate keeps unchanged, swapped on disk.
		const { baseline, dir } = pinned(BASE);
		const work = join(fresh("work"), "w");
		writeTree(work, { ...BASE, "new.txt": "n\n" });
		const staging = join(fresh("c"), "s");
		const c = collectStagedChangeSetV0(baseline, work, staging, LIMITS);
		if (c.status !== "collected") throw new Error("not collected");
		writeFileSync(join(dir, "README.md"), "swapped\n");
		const out2 = join(fresh("candidate"), "candidate");
		expect(reconstructStagedCandidateV0(c.manifest, baseline, dir, staging, out2, LIMITS)).toMatchObject({
			ok: false,
			reason: "baseline-mismatch",
		});
		expect(existsSync(out2)).toBe(false);
	});
});

describe("the version 2 and 3 protected specs", () => {
	const spec = (task: Record<string, unknown>, version = "endo.protected-experiment-spec.v2") => ({
		schemaVersion: version,
		id: "endo.experiment.staged-test",
		description: "test",
		seed: 1,
		trials: 1,
		limits: {
			agentTimeoutMs: 1000,
			evaluationTimeoutMs: 1000,
			outputBytes: 4096,
			tmpfsBytes: 1_048_576,
			maxFileBytes: 1024,
			maxTotalBytes: 4096,
		},
		runtime: { executables: ["/usr/bin/node"] },
		tasks: [
			{
				id: "t",
				workspace: { "README.md": "x\n" },
				submission: { mode: "staged-changeset", limits: LIMITS },
				evaluator: { file: "/nonexistent/evaluator.json", sha256: "a".repeat(64) },
				...task,
			},
		],
		conditions: [{ id: "c", description: "c", agent: { directory: "/nonexistent/agent", argv: ["/usr/bin/node"] } }],
	});

	it("reads a staged task, and refuses one without explicit bounds, past the collector's defaults, or with an impossible workspace", () => {
		expect(readEndoProtectedSpecV0(spec({}))).toMatchObject({ ok: true });
		const reads = (task: Record<string, unknown>) => readEndoProtectedSpecV0(spec(task)).ok;
		expect(reads({ submission: { mode: "staged-changeset" } })).toBe(false);
		expect(reads({ submission: { mode: "copy-everything", limits: LIMITS } })).toBe(false);
		expect(reads({ submission: { mode: "staged-changeset", limits: { ...LIMITS, maxWalkedEntries: 9000 } } })).toBe(
			false,
		);
		expect(reads({ submission: ["README.md"] })).toBe(false);
		expect(reads({ workspace: { ".git/config": "x" } })).toBe(false);
		expect(reads({ workspace: { a: "x", "a/b": "y" } })).toBe(false);
	});

	it("never reads a staged task in a version 0 spec, and still reads a fixed-path one there", () => {
		expect(readEndoProtectedSpecV0(spec({}, "endo.protected-experiment-spec.v0")).ok).toBe(false);
		expect(readEndoProtectedSpecV0(spec({ submission: ["README.md"] }, "endo.protected-experiment-spec.v0")).ok).toBe(
			true,
		);
	});
});

describe("a staged record's refusals: every refusal the collector can make, bounded explicitly when the record is sealed", () => {
	const PATH_MAX = ENDO_PROTECTED_CHANGESET_REFUSAL_PATH_MAX_V2;
	const LIST_MAX = ENDO_PROTECTED_CHANGESET_REFUSALS_MAX_V2;
	/** A refused path of exactly `length` characters: two walkable directories and a name the collector refuses as unsafe. */
	const longPath = (length: number) => `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(length - 202)}`;

	it("the collector itself refuses paths past the record's bound, and more refusals than the record lists", () => {
		const { baseline } = pinned({ "README.md": "x\n" });
		const work = join(fresh("work"), "w");
		writeTree(work, { "README.md": "x\n", [longPath(PATH_MAX + 3)]: "x" });
		for (let i = 0; i <= LIST_MAX; i++) symlinkSync("/etc/passwd", join(work, `l${String(i).padStart(5, "0")}`));
		const c = collectStagedChangeSetV0(baseline, work, join(fresh("c"), "s"), DEFAULT_ENDO_CHANGESET_LIMITS_V0);
		expect(c.status).toBe("refused");
		if (c.status !== "refused") return;
		expect(c.refusals).toHaveLength(LIST_MAX + 2);
		expect(c.refusals.filter((r) => r.reason === "symbolic-link")).toHaveLength(LIST_MAX + 1);
		expect(c.refusals.find((r) => r.reason === "unsafe-path")?.path).toBe(longPath(PATH_MAX + 3));
		const bounded = endoProtectedChangeSetRefusalsV2(c.refusals);
		expect(bounded.refusals).toHaveLength(LIST_MAX);
		expect(bounded.refusalsOmitted).toBe(2);
		expect(bounded.refusals[0]).toEqual({
			path: longPath(PATH_MAX + 3).slice(0, PATH_MAX),
			reason: "unsafe-path",
			truncated: { length: PATH_MAX + 3, sha256: sha(longPath(PATH_MAX + 3)) },
		});
	});

	it("keeps a path at the bound whole, and cuts one past it with its full length and digest", () => {
		for (const length of [PATH_MAX - 1, PATH_MAX, PATH_MAX + 1, PATH_MAX + 3, PATH_MAX + 4]) {
			const path = longPath(length);
			const [r] = endoProtectedChangeSetRefusalsV2([{ path, reason: "unsafe-path" }]).refusals;
			if (length <= PATH_MAX) expect(r, String(length)).toEqual({ path, reason: "unsafe-path", truncated: null });
			else
				expect(r, String(length)).toEqual({
					path: path.slice(0, PATH_MAX),
					reason: "unsafe-path",
					truncated: { length, sha256: sha(path) },
				});
		}
		// Never cut inside a surrogate pair: the kept prefix stays well-formed text.
		const astral = `${"d".repeat(PATH_MAX - 1)}\u{1F600}x`;
		const [r] = endoProtectedChangeSetRefusalsV2([{ path: astral, reason: "unsafe-path" }]).refusals;
		expect(r?.path).toBe("d".repeat(PATH_MAX - 1));
		expect(r?.path.isWellFormed()).toBe(true);
		expect(r?.truncated).toEqual({ length: PATH_MAX + 2, sha256: sha(astral) });
	});

	it("lists every refusal up to the bound and counts the rest, in the collector's order", () => {
		const of = (n: number) =>
			Array.from({ length: n }, (_, i) => ({
				path: `l${String(i).padStart(5, "0")}`,
				reason: "symbolic-link" as const,
			}));
		for (const [n, listed, omitted] of [
			[LIST_MAX - 1, LIST_MAX - 1, 0],
			[LIST_MAX, LIST_MAX, 0],
			[LIST_MAX + 1, LIST_MAX, 1],
			[LIST_MAX + 2, LIST_MAX, 2],
		] as const) {
			const b = endoProtectedChangeSetRefusalsV2(of(n));
			expect(b.refusals, String(n)).toHaveLength(listed);
			expect(b.refusalsOmitted, String(n)).toBe(omitted);
			expect(b.refusals.at(-1)?.path, String(n)).toBe(of(n)[listed - 1]?.path);
		}
	});
});
