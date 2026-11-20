import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureWorkspaceBaselineV0,
	collectStagedChangeSetV0,
	endoBaselineDigestV0,
	endoChangeSetDigestV0,
	renderStagedChangeSetPreviewV0,
	verifyStagedChangeSetV0,
} from "../adapters/sandbox/staged-changeset.ts";
import { admitWorkspaceV0 } from "../adapters/sandbox/workspace-admission.ts";
import {
	DEFAULT_ENDO_CHANGESET_LIMITS_V0,
	ENDO_STAGED_CHANGESET_V0,
	ENDO_WORKSPACE_BASELINE_V0,
	type EndoChangeSetLimitsV0,
	isPlainChangeSetPathV0,
	readEndoStagedChangeSetManifestV0,
	readEndoWorkspaceBaselineV0,
} from "../protocol/staged-changeset.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fresh(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `endo-changeset-${prefix}-`));
	cleanup.push(dir);
	return dir;
}

const sha = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

function writeTree(root: string, files: Record<string, string | Buffer>, executables: string[] = []): void {
	const execSet = new Set(executables);
	for (const [rel, data] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(dirnameOf(full), { recursive: true });
		writeFileSync(full, data);
		chmodSync(full, execSet.has(rel) ? 0o755 : 0o644);
	}
}

function dirnameOf(p: string): string {
	const idx = p.lastIndexOf("/");
	return idx === -1 ? "." : p.slice(0, idx);
}

describe("protocol/staged-changeset strict schema validation", () => {
	it("distinguishes not-an-object, missing-version, version-not-string, unsupported-version, and invalid", () => {
		for (const reader of [readEndoWorkspaceBaselineV0, readEndoStagedChangeSetManifestV0]) {
			expect(reader(null)).toMatchObject({ ok: false, kind: "not-an-object" });
			expect(reader([])).toMatchObject({ ok: false, kind: "not-an-object" });
			expect(reader({})).toMatchObject({ ok: false, kind: "missing-version" });
			expect(reader({ schemaVersion: 123 })).toMatchObject({ ok: false, kind: "version-not-string" });
			expect(reader({ schemaVersion: "endo.future.v999" })).toMatchObject({
				ok: false,
				kind: "unsupported-version",
			});
		}
	});

	it("rejects unknown fields, unsorted/duplicate paths, .git paths, no-op changes, and summary contradictions", () => {
		const validShaA = sha("a");
		const validShaB = sha("b");
		const base = {
			schemaVersion: ENDO_WORKSPACE_BASELINE_V0,
			rootGitExcluded: false,
			files: [{ path: "a.txt", bytes: 1, sha256: validShaA, executable: false }],
			totalBytes: 1,
			sha256: endoBaselineDigestV0(false, [{ path: "a.txt", bytes: 1, sha256: validShaA, executable: false }]),
		};
		expect(readEndoWorkspaceBaselineV0(base)).toMatchObject({ ok: true });
		expect(readEndoWorkspaceBaselineV0({ ...base, extra: true })).toMatchObject({ ok: false, kind: "invalid" });
		expect(readEndoWorkspaceBaselineV0({ ...base, totalBytes: 2 })).toMatchObject({ ok: false, kind: "invalid" });
		expect(
			readEndoWorkspaceBaselineV0({
				...base,
				files: [
					{ path: "b.txt", bytes: 1, sha256: validShaA, executable: false },
					{ path: "a.txt", bytes: 1, sha256: validShaA, executable: false },
				],
				totalBytes: 2,
			}),
		).toMatchObject({ ok: false, kind: "invalid" });

		const changes = [
			{
				path: "a.txt",
				kind: "modified" as const,
				before: { bytes: 1, sha256: validShaA, executable: false },
				after: { bytes: 1, sha256: validShaB, executable: false },
			},
		];
		const manifest = {
			schemaVersion: ENDO_STAGED_CHANGESET_V0,
			baselineSha256: base.sha256,
			baselineRootGitExcluded: false,
			changes,
			summary: {
				baselineFiles: 1,
				candidateFiles: 1,
				unchangedFiles: 0,
				addedFiles: 0,
				modifiedFiles: 1,
				modeChangedFiles: 0,
				deletedFiles: 0,
				stagedBytes: 1,
			},
			changesetSha256: endoChangeSetDigestV0(base.sha256, false, changes),
		};
		expect(readEndoStagedChangeSetManifestV0(manifest)).toMatchObject({ ok: true });
		expect(readEndoStagedChangeSetManifestV0({ ...manifest, unknownField: 1 })).toMatchObject({
			ok: false,
			kind: "invalid",
		});
		// Identical sha256 cannot be `modified`.
		expect(
			readEndoStagedChangeSetManifestV0({
				...manifest,
				changes: [
					{
						path: "a.txt",
						kind: "modified",
						before: { bytes: 1, sha256: validShaA, executable: false },
						after: { bytes: 1, sha256: validShaA, executable: true },
					},
				],
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
		// Identical executable bit cannot be `mode`.
		expect(
			readEndoStagedChangeSetManifestV0({
				...manifest,
				changes: [
					{
						path: "a.txt",
						kind: "mode",
						before: { bytes: 1, sha256: validShaA, executable: false },
						after: { bytes: 1, sha256: validShaA, executable: false },
					},
				],
				summary: { ...manifest.summary, modifiedFiles: 0, modeChangedFiles: 1 },
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
		// Summary contradiction.
		expect(
			readEndoStagedChangeSetManifestV0({
				...manifest,
				summary: { ...manifest.summary, unchangedFiles: 5 },
			}),
		).toMatchObject({ ok: false, kind: "invalid" });
		// Path safety checks.
		expect(isPlainChangeSetPathV0("src/index.ts")).toBe(true);
		expect(isPlainChangeSetPathV0(".git/config")).toBe(false);
		expect(isPlainChangeSetPathV0("nested/.git/hooks/pre-commit")).toBe(false);
		expect(isPlainChangeSetPathV0("../escape")).toBe(false);
		expect(isPlainChangeSetPathV0("/etc/passwd")).toBe(false);
		expect(isPlainChangeSetPathV0("src/a\u202eb.ts")).toBe(false);
		expect(isPlainChangeSetPathV0("src/a\\b.ts")).toBe(false);
	});
});

describe("staged change-set collection, verification, and preview", () => {
	it("collects added, modified, mode-changed, and deleted files while leaving unchanged files unstaged", () => {
		const baseDir = fresh("base");
		const candDir = fresh("cand");
		const staging = join(fresh("stage"), "out");

		writeTree(
			baseDir,
			{
				"README.md": "keep me\n",
				"src/calc.mjs": "export const add = (a, b) => a - b;\n",
				"bin/run.sh": "#!/bin/sh\necho hi\n",
				"old/unused.txt": "bye\n",
			},
			[],
		);
		writeTree(
			candDir,
			{
				"README.md": "keep me\n",
				"src/calc.mjs": "export const add = (a, b) => a + b;\n",
				"bin/run.sh": "#!/bin/sh\necho hi\n",
				"src/new-helper.mjs": "export const id = (x) => x;\n",
				"src/empty.txt": "",
			},
			["bin/run.sh", "src/new-helper.mjs"],
		);

		const baselineRes = captureWorkspaceBaselineV0(baseDir);
		expect(baselineRes.ok).toBe(true);
		if (!baselineRes.ok) return;

		const collected = collectStagedChangeSetV0(baselineRes.baseline, candDir, staging);
		expect(collected.status).toBe("collected");
		if (collected.status !== "collected") return;

		expect(collected.manifest.summary).toEqual({
			baselineFiles: 4,
			candidateFiles: 5,
			unchangedFiles: 1,
			addedFiles: 2,
			modifiedFiles: 1,
			modeChangedFiles: 1,
			deletedFiles: 1,
			stagedBytes:
				Buffer.byteLength("#!/bin/sh\necho hi\n") +
				Buffer.byteLength("export const add = (a, b) => a + b;\n") +
				Buffer.byteLength("export const id = (x) => x;\n") +
				0,
		});
		expect(collected.manifest.changes.map((c) => [c.path, c.kind])).toEqual([
			["bin/run.sh", "mode"],
			["old/unused.txt", "deleted"],
			["src/calc.mjs", "modified"],
			["src/empty.txt", "added"],
			["src/new-helper.mjs", "added"],
		]);

		// Unchanged and deleted files are not present in staging/files.
		expect(existsSync(join(staging, "files", "README.md"))).toBe(false);
		expect(existsSync(join(staging, "files", "old/unused.txt"))).toBe(false);
		// Added/modified/mode files ARE staged and strictly non-executable (0o444) on the host.
		for (const rel of ["bin/run.sh", "src/calc.mjs", "src/empty.txt", "src/new-helper.mjs"]) {
			const mode = statSync(join(staging, "files", rel)).mode & 0o777;
			expect(mode, rel).toBe(0o444);
		}
		expect(statSync(join(staging, "manifest.json")).mode & 0o777).toBe(0o444);
		// Executability is preserved in manifest metadata.
		expect(collected.manifest.changes.find((c) => c.path === "bin/run.sh")).toMatchObject({
			kind: "mode",
			before: { executable: false },
			after: { executable: true },
		});
		expect(collected.manifest.changes.find((c) => c.path === "src/new-helper.mjs")).toMatchObject({
			kind: "added",
			after: { executable: true },
		});

		// Offline verifier accepts with exact pins.
		const verified = verifyStagedChangeSetV0(staging, {
			expectedBaselineSha256: baselineRes.baseline.sha256,
			expectedChangesetSha256: collected.manifest.changesetSha256,
		});
		expect(verified).toEqual({ ok: true, manifest: collected.manifest });

		// Never reuses an existing staging directory.
		expect(() => collectStagedChangeSetV0(baselineRes.baseline, candDir, staging)).toThrow();
		// Refuses a baseline whose sha256 does not match its entries.
		expect(() =>
			collectStagedChangeSetV0(
				{ ...baselineRes.baseline, sha256: "0".repeat(64) },
				candDir,
				join(fresh("bad-base"), "out"),
			),
		).toThrow(/baseline sha256/i);
	});

	it("collects and verifies an empty change set cleanly", () => {
		const baseDir = fresh("empty-base");
		const candDir = fresh("empty-cand");
		const staging = join(fresh("empty-stage"), "out");
		writeTree(baseDir, { "a.txt": "same\n" });
		writeTree(candDir, { "a.txt": "same\n" });
		mkdirSync(join(candDir, "empty-subdir"));

		const base = captureWorkspaceBaselineV0(baseDir);
		if (!base.ok) throw new Error("baseline failed");
		const res = collectStagedChangeSetV0(base.baseline, candDir, staging);
		expect(res.status).toBe("collected");
		if (res.status !== "collected") return;
		expect(res.manifest.changes).toEqual([]);
		expect(res.manifest.summary.unchangedFiles).toBe(1);
		expect(verifyStagedChangeSetV0(staging)).toEqual({ ok: true, manifest: res.manifest });
	});

	it("refuses symlinks, hardlinks, .git metadata, FIFOs, depth/size/count limits, and races without creating staging", () => {
		const limits: EndoChangeSetLimitsV0 = {
			maxFileBytes: 1024,
			maxTotalStagedBytes: 2048,
			maxWorkspaceBytes: 8192,
			maxWalkedEntries: 50,
			maxChangedFiles: 10,
			maxDepth: 3,
		};

		const makeBase = () => {
			const dir = fresh("adv-base");
			writeTree(dir, { "src/a.mjs": "before\n", "README.md": "readme\n" });
			const res = captureWorkspaceBaselineV0(dir, limits);
			if (!res.ok) throw new Error("baseline failed");
			return res.baseline;
		};
		const baseline = makeBase();

		const makeCand = () => {
			const dir = fresh("adv-cand");
			writeTree(dir, { "src/a.mjs": "after\n", "README.md": "readme\n" });
			return dir;
		};

		const cases: [string, (w: string) => void, string, string][] = [
			["symlink file", (w) => symlinkSync("/etc/passwd", join(w, "src/leak")), "src/leak", "symbolic-link"],
			[
				"dangling symlink",
				(w) => symlinkSync("/nonexistent-target", join(w, "src/dangling")),
				"src/dangling",
				"symbolic-link",
			],
			["symlink directory", (w) => symlinkSync("/etc", join(w, "etc-link")), "etc-link", "symbolic-link"],
			["hard link", (w) => linkSync(join(w, "README.md"), join(w, "src/hard")), "src/hard", "hard-link"],
			[
				"top-level .git directory",
				(w) => {
					mkdirSync(join(w, ".git"));
					writeFileSync(join(w, ".git/config"), "[core]\n");
				},
				".git",
				"git-metadata",
			],
			[
				"nested .git file",
				(w) => writeFileSync(join(w, "src/.git"), "gitdir: /tmp/evil\n"),
				"src/.git",
				"git-metadata",
			],
			[
				"oversized single file",
				(w) => writeFileSync(join(w, "src/big.bin"), Buffer.alloc(1025)),
				"src/big.bin",
				"too-large",
			],
			[
				"directory nesting beyond maxDepth",
				(w) => {
					mkdirSync(join(w, "a/b/c/d"), { recursive: true });
					writeFileSync(join(w, "a/b/c/d/leaf.txt"), "deep");
				},
				"a/b/c/d",
				"too-deep",
			],
			[
				"total staged bytes over bound",
				(w) => {
					writeFileSync(join(w, "src/f1.bin"), Buffer.alloc(900, 1));
					writeFileSync(join(w, "src/f2.bin"), Buffer.alloc(900, 2));
					writeFileSync(join(w, "src/f3.bin"), Buffer.alloc(900, 3));
				},
				"src/f3.bin",
				"total-too-large",
			],
			[
				"unsafe filename with bidi override",
				(w) => writeFileSync(join(w, "src/bad\u202ename.txt"), "spoof"),
				"src/bad\u202ename.txt",
				"unsafe-path",
			],
		];

		for (const [label, attack, expectedPath, expectedReason] of cases) {
			const cand = makeCand();
			attack(cand);
			const staging = join(fresh("adv-stage"), "out");
			const res = collectStagedChangeSetV0(baseline, cand, staging, limits);
			expect(res.status, label).toBe("refused");
			expect(res.refusals, label).toContainEqual({ path: expectedPath, reason: expectedReason });
			expect(existsSync(staging), label).toBe(false);
		}

		// Symlink workspace root itself.
		const realCand = makeCand();
		const rootLink = join(fresh("root-link"), "alias");
		symlinkSync(realCand, rootLink);
		const rootStaging = join(fresh("root-stage"), "out");
		expect(collectStagedChangeSetV0(baseline, rootLink, rootStaging, limits)).toEqual({
			status: "refused",
			manifest: null,
			stagingDir: null,
			refusals: [{ path: ".", reason: "symbolic-link" }],
		});
		expect(existsSync(rootStaging)).toBe(false);

		// Too many changed files.
		const manyCand = makeCand();
		for (let i = 0; i < 12; i++) writeFileSync(join(manyCand, `f${String(i).padStart(2, "0")}.txt`), `v${i}`);
		const manyStage = join(fresh("many-stage"), "out");
		const manyRes = collectStagedChangeSetV0(baseline, manyCand, manyStage, limits);
		expect(manyRes.status).toBe("refused");
		expect(manyRes.refusals[0]?.reason).toBe("too-many-files");
		expect(existsSync(manyStage)).toBe(false);

		// TOCTOU race: file mutated after open.
		const raceCand = makeCand();
		const raceStage = join(fresh("race-stage"), "out");
		const raceRes = collectStagedChangeSetV0(baseline, raceCand, raceStage, limits, {
			afterOpen: (rel) => {
				if (rel === "src/a.mjs") writeFileSync(join(raceCand, "src/a.mjs"), "mutated mid-read!\n");
			},
		});
		expect(raceRes.status).toBe("refused");
		expect(raceRes.refusals).toContainEqual({ path: "src/a.mjs", reason: "changed-during-collection" });
		expect(existsSync(raceStage)).toBe(false);

		// TOCTOU race: file unlinked and replaced after open.
		const swapCand = makeCand();
		const swapStage = join(fresh("swap-stage"), "out");
		const swapRes = collectStagedChangeSetV0(baseline, swapCand, swapStage, limits, {
			afterOpen: (rel) => {
				if (rel === "src/a.mjs") {
					unlinkSync(join(swapCand, "src/a.mjs"));
					writeFileSync(join(swapCand, "src/a.mjs"), "after\n");
				}
			},
		});
		expect(swapRes.status).toBe("refused");
		expect(swapRes.refusals).toContainEqual({ path: "src/a.mjs", reason: "changed-during-collection" });
		expect(existsSync(swapStage)).toBe(false);

		// TOCTOU race: directory mutated during walk.
		const dirRaceCand = makeCand();
		const dirRaceStage = join(fresh("dir-race-stage"), "out");
		const dirRaceRes = collectStagedChangeSetV0(baseline, dirRaceCand, dirRaceStage, limits, {
			afterDirOpen: (rel) => {
				if (rel === "src") writeFileSync(join(dirRaceCand, "src/injected.txt"), "race");
			},
		});
		expect(dirRaceRes.status).toBe("refused");
		expect(dirRaceRes.refusals).toContainEqual({ path: "src", reason: "changed-during-collection" });
		expect(existsSync(dirRaceStage)).toBe(false);

		// Agent-caused error becomes refusal; host I/O error propagates.
		const fail = (code: string) => (rel: string) => {
			if (rel === "src/a.mjs") throw Object.assign(new Error(code), { code });
		};
		expect(
			collectStagedChangeSetV0(baseline, makeCand(), join(fresh("err-stage"), "out"), limits, {
				afterOpen: fail("EACCES"),
			}),
		).toMatchObject({ status: "refused", refusals: [{ path: "src/a.mjs", reason: "unreadable" }] });
		for (const code of ["EIO", "EMFILE"]) {
			expect(() =>
				collectStagedChangeSetV0(baseline, makeCand(), join(fresh("host-err"), "out"), limits, {
					afterOpen: fail(code),
				}),
			).toThrow(code);
		}
	});

	it.runIf(process.platform === "linux" && process.getuid?.() !== 0)(
		"refuses an unreadable (0o000) file in the candidate workspace without creating staging",
		() => {
			const baseDir = fresh("perm-base");
			const candDir = fresh("perm-cand");
			writeTree(baseDir, { "a.txt": "before\n" });
			writeTree(candDir, { "a.txt": "before\n", "secret.txt": "locked\n" });
			const locked = join(candDir, "secret.txt");
			chmodSync(locked, 0o000);
			try {
				const base = captureWorkspaceBaselineV0(baseDir);
				if (!base.ok) throw new Error("baseline failed");
				const staging = join(fresh("perm-stage"), "out");
				const res = collectStagedChangeSetV0(base.baseline, candDir, staging);
				expect(res).toEqual({
					status: "refused",
					manifest: null,
					stagingDir: null,
					refusals: [{ path: "secret.txt", reason: "unreadable" }],
				});
				expect(existsSync(staging)).toBe(false);
			} finally {
				chmodSync(locked, 0o600);
			}
		},
	);

	it.runIf(spawnSync("/usr/bin/mkfifo", ["--version"]).status === 0)("refuses a FIFO without blocking", () => {
		const baseDir = fresh("fifo-base");
		const candDir = fresh("fifo-cand");
		writeTree(baseDir, { "a.txt": "x" });
		writeTree(candDir, { "a.txt": "x" });
		spawnSync("/usr/bin/mkfifo", [join(candDir, "pipe")]);

		const base = captureWorkspaceBaselineV0(baseDir);
		if (!base.ok) throw new Error("baseline failed");
		const staging = join(fresh("fifo-stage"), "out");
		const res = collectStagedChangeSetV0(base.baseline, candDir, staging);
		expect(res).toEqual({
			status: "refused",
			manifest: null,
			stagingDir: null,
			refusals: [{ path: "pipe", reason: "not-a-regular-file" }],
		});
		expect(existsSync(staging)).toBe(false);
	});

	it("detects every form of post-collection tampering in verifyStagedChangeSetV0", () => {
		const makeStaged = () => {
			const baseDir = fresh("tamp-base");
			const candDir = fresh("tamp-cand");
			const staging = join(fresh("tamp-stage"), "out");
			writeTree(baseDir, { "a.txt": "old\n", "gone.txt": "delete me\n" });
			writeTree(candDir, { "a.txt": "new\n" });
			const base = captureWorkspaceBaselineV0(baseDir);
			if (!base.ok) throw new Error("baseline failed");
			const res = collectStagedChangeSetV0(base.baseline, candDir, staging);
			if (res.status !== "collected") throw new Error("collect failed");
			return { staging, manifest: res.manifest, baseline: base.baseline };
		};

		// 1. Staged file byte tampered.
		{
			const { staging } = makeStaged();
			chmodSync(join(staging, "files/a.txt"), 0o600);
			writeFileSync(join(staging, "files/a.txt"), "evil");
			chmodSync(join(staging, "files/a.txt"), 0o444);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "staged-bytes-mismatch" });
		}
		// 2. Staged file made executable.
		{
			const { staging } = makeStaged();
			chmodSync(join(staging, "files/a.txt"), 0o555);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "executable-staged-file" });
		}
		// 3. Extra rogue file under staging/files.
		{
			const { staging } = makeStaged();
			writeFileSync(join(staging, "files/rogue.txt"), "hi");
			chmodSync(join(staging, "files/rogue.txt"), 0o444);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "unexpected-staged-entry" });
		}
		// 4. Staged file planted for a deleted path.
		{
			const { staging } = makeStaged();
			writeFileSync(join(staging, "files/gone.txt"), "resurrected");
			chmodSync(join(staging, "files/gone.txt"), 0o444);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "unexpected-staged-entry" });
		}
		// 5. Missing staged file.
		{
			const { staging } = makeStaged();
			rmSync(join(staging, "files/a.txt"));
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "missing-staged-file" });
		}
		// 6. Unexpected empty directory under staging/files.
		{
			const { staging } = makeStaged();
			mkdirSync(join(staging, "files/empty"));
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "unexpected-staged-entry" });
		}
		// 7. Extra top-level entry in staging directory.
		{
			const { staging } = makeStaged();
			writeFileSync(join(staging, "extra.json"), "{}");
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "unexpected-staged-entry" });
		}
		// 8. Symlink replacing a staged file.
		{
			const { staging } = makeStaged();
			rmSync(join(staging, "files/a.txt"));
			symlinkSync("/etc/passwd", join(staging, "files/a.txt"));
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "unsafe-staged-file" });
		}
		// 9. Manifest digest tampered.
		{
			const { staging, manifest } = makeStaged();
			chmodSync(join(staging, "manifest.json"), 0o600);
			writeFileSync(
				join(staging, "manifest.json"),
				JSON.stringify({ ...manifest, changesetSha256: "0".repeat(64) }),
			);
			chmodSync(join(staging, "manifest.json"), 0o444);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "digest-mismatch" });
		}
		// 10. Pin mismatch.
		{
			const { staging } = makeStaged();
			expect(verifyStagedChangeSetV0(staging, { expectedBaselineSha256: "f".repeat(64) })).toMatchObject({
				ok: false,
				reason: "pin-mismatch",
			});
			expect(verifyStagedChangeSetV0(staging, { expectedChangesetSha256: "f".repeat(64) })).toMatchObject({
				ok: false,
				reason: "pin-mismatch",
			});
		}
		// 11. Symlink staging root itself and symlinked/executable manifest.json.
		{
			const { staging } = makeStaged();
			const alias = join(fresh("stage-alias"), "link");
			symlinkSync(staging, alias);
			expect(verifyStagedChangeSetV0(alias)).toMatchObject({ ok: false, reason: "invalid-staging-dir" });
			chmodSync(join(staging, "manifest.json"), 0o555);
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "executable-staged-file" });
			chmodSync(join(staging, "manifest.json"), 0o600);
			const moved = join(fresh("moved-manifest"), "manifest.json");
			writeFileSync(moved, readFileSync(join(staging, "manifest.json")));
			rmSync(join(staging, "manifest.json"));
			symlinkSync(moved, join(staging, "manifest.json"));
			expect(verifyStagedChangeSetV0(staging)).toMatchObject({ ok: false, reason: "invalid-manifest" });
		}
	});

	it("renders host-safe unified diffs, binary markers, trailing-newline edits, truncation, and refuses moved baselines", () => {
		const baseDir = fresh("prev-base");
		const candDir = fresh("prev-cand");
		const staging = join(fresh("prev-stage"), "out");

		writeTree(baseDir, {
			"src/math.mjs": "line1\nline2\nreturn a - b;\nline4\n",
			"src/nl.txt": "hello",
			"assets/logo.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
			"bin/script.sh": "#!/bin/sh\necho ok\n",
			"old.txt": "removed line\n",
		});
		writeTree(
			candDir,
			{
				"src/math.mjs": "line1\nline2\nreturn a + b;\nline4\n",
				"src/nl.txt": "hello\n",
				"assets/logo.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]),
				"bin/script.sh": "#!/bin/sh\necho ok\n",
				"src/added.txt": "first\nsecond\n",
			},
			["bin/script.sh"],
		);

		const base = captureWorkspaceBaselineV0(baseDir);
		if (!base.ok) throw new Error("baseline failed");
		const collected = collectStagedChangeSetV0(base.baseline, candDir, staging);
		expect(collected.status).toBe("collected");
		if (collected.status !== "collected") return;

		// Without baselineDir: added and mode render, modified/deleted honestly report baseline-unavailable.
		const noBase = renderStagedChangeSetPreviewV0(staging);
		expect(noBase.ok).toBe(true);
		if (!noBase.ok) return;
		expect(noBase.entries.find((e) => e.path === "src/added.txt")).toMatchObject({
			content: "added-text",
			truncated: false,
		});
		expect(noBase.entries.find((e) => e.path === "src/math.mjs")).toMatchObject({
			content: "baseline-unavailable",
			diff: null,
		});
		expect(noBase.entries.find((e) => e.path === "bin/script.sh")).toMatchObject({
			content: "mode-only",
			diff: null,
		});

		// With verified baselineDir: unified diffs render accurately, including trailing-newline-only edit and binary detection.
		const withBase = renderStagedChangeSetPreviewV0(staging, { baselineDir: baseDir });
		expect(withBase.ok).toBe(true);
		if (!withBase.ok) return;

		const mathEntry = withBase.entries.find((e) => e.path === "src/math.mjs")!;
		expect(mathEntry.content).toBe("unified-diff");
		expect(mathEntry.diff).toContain("--- a/src/math.mjs\n+++ b/src/math.mjs");
		expect(mathEntry.diff).toContain("-return a - b;");
		expect(mathEntry.diff).toContain("+return a + b;");

		const nlEntry = withBase.entries.find((e) => e.path === "src/nl.txt")!;
		expect(nlEntry.content).toBe("unified-diff");
		expect(nlEntry.diff).toContain("-hello\n\\ No newline at end of file\n+hello");

		expect(withBase.entries.find((e) => e.path === "assets/logo.bin")).toMatchObject({
			content: "binary",
			diff: null,
		});
		expect(withBase.entries.find((e) => e.path === "old.txt")).toMatchObject({
			content: "unified-diff",
		});
		expect(withBase.entries.find((e) => e.path === "old.txt")?.diff).toContain("-removed line");

		// Line truncation flag works cleanly.
		const trunc = renderStagedChangeSetPreviewV0(staging, { baselineDir: baseDir, maxDiffLinesPerFile: 3 });
		expect(trunc.ok).toBe(true);
		if (trunc.ok) {
			expect(trunc.entries.find((e) => e.path === "src/math.mjs")?.truncated).toBe(true);
		}

		// Mutating baselineDir after collection causes explicit baseline-mismatch refusal.
		writeFileSync(join(baseDir, "src/math.mjs"), "drifted baseline\n");
		const drifted = renderStagedChangeSetPreviewV0(staging, { baselineDir: baseDir });
		expect(drifted).toMatchObject({ ok: false, reason: "baseline-mismatch" });

		// Replacing a baseline file with a symlink causes baseline-unreadable refusal.
		rmSync(join(baseDir, "src/math.mjs"));
		symlinkSync("/etc/passwd", join(baseDir, "src/math.mjs"));
		const linkedBase = renderStagedChangeSetPreviewV0(staging, { baselineDir: baseDir });
		expect(linkedBase).toMatchObject({ ok: false, reason: "baseline-unreadable" });
	});

	it.runIf(process.platform === "linux")(
		"composes end-to-end with admitWorkspaceV0 on a real Git checkout (skipRootGit: true)",
		() => {
			const dir = fresh("git-e2e");
			const repo = join(dir, "repo");
			const evidenceRoot = join(dir, "evidence");
			const internalRoot = join(dir, "internal");
			for (const p of [repo, evidenceRoot, internalRoot]) mkdirSync(p);

			const git = (...args: string[]) =>
				execFileSync("/usr/bin/git", args, {
					cwd: repo,
					env: { HOME: dir, PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
					stdio: "pipe",
				});
			git("init", "-q");
			writeTree(repo, { "calc.mjs": "console.log(2 + 3 * 4);\n", "README.md": "calc\n" });
			git("add", ".");

			const admitted = admitWorkspaceV0({ root: repo, evidenceRoot, internalRoots: [internalRoot] });
			expect(admitted.ok).toBe(true);
			if (!admitted.ok) return;

			try {
				// Without skipRootGit, the admitted snapshot's `.git` is explicitly refused.
				expect(captureWorkspaceBaselineV0(admitted.snapshot)).toMatchObject({
					ok: false,
					refusals: [{ path: ".git", reason: "git-metadata" }],
				});

				// With skipRootGit: true, the working files are captured and rootGitExcluded is recorded explicitly.
				const baselineRes = captureWorkspaceBaselineV0(admitted.snapshot, DEFAULT_ENDO_CHANGESET_LIMITS_V0, {
					skipRootGit: true,
				});
				expect(baselineRes.ok).toBe(true);
				if (!baselineRes.ok) return;
				expect(baselineRes.baseline.rootGitExcluded).toBe(true);
				expect(baselineRes.baseline.files.map((f) => f.path)).toEqual(["README.md", "calc.mjs"]);

				// Copy working files (without .git) into a disposable candidate directory and simulate an agent edit.
				const writable = join(dir, "sandbox-work");
				mkdirSync(writable);
				cpSync(join(admitted.snapshot, "calc.mjs"), join(writable, "calc.mjs"));
				cpSync(join(admitted.snapshot, "README.md"), join(writable, "README.md"));
				writeFileSync(join(writable, "calc.mjs"), "console.log(14);\n");
				writeFileSync(join(writable, "calc.test.mjs"), "if (14 !== 14) process.exit(1);\n");

				const staging = join(dir, "staged");
				const collected = collectStagedChangeSetV0(baselineRes.baseline, writable, staging);
				expect(collected.status).toBe("collected");
				if (collected.status !== "collected") return;
				expect(collected.manifest.baselineRootGitExcluded).toBe(true);
				expect(collected.manifest.changes.map((c) => [c.path, c.kind])).toEqual([
					["calc.mjs", "modified"],
					["calc.test.mjs", "added"],
				]);

				const preview = renderStagedChangeSetPreviewV0(staging, {
					expectedBaselineSha256: baselineRes.baseline.sha256,
					baselineDir: admitted.snapshot,
				});
				expect(preview.ok).toBe(true);
				if (!preview.ok) return;
				expect(preview.entries.find((e) => e.path === "calc.mjs")?.diff).toContain("-console.log(2 + 3 * 4);");
				expect(preview.entries.find((e) => e.path === "calc.mjs")?.diff).toContain("+console.log(14);");
				// Original checkout was never touched.
				expect(readFileSync(join(repo, "calc.mjs"), "utf8")).toBe("console.log(2 + 3 * 4);\n");
			} finally {
				admitted.dispose();
			}
		},
	);
});
