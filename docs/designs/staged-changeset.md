# Staged change sets: boundary-agnostic multi-file collection

Status: **implemented as a library (`protocol/staged-changeset.ts`, `adapters/sandbox/staged-changeset.ts`).** Not yet wired into `endo develop`, `endo attempt`, or `endo experiment protected-run`.

## 1. Purpose

`adapters/sandbox/submission.ts` (`exportSubmissionV0`) collects a fixed list of explicitly declared paths from a terminated sandbox workspace. That fits fixed-path research fixtures (`develop-isolate-004`, `develop-acceptance-001`), where the spec already knows which file to collect.

Real coding work against a repository changes an arbitrary set of files: additions, content edits, executable-bit changes, and deletions. This module provides the boundary-agnostic collection, verification, and host-safe review primitive between:

- a **baseline workspace** captured as a canonical, digest-pinned manifest (`endo.workspace-baseline.v0`), and
- a **terminated candidate workspace** (from Bubblewrap, a guest VM, or any other isolation boundary).

## 2. What it establishes — and what it never claims

| Claim | Status |
| :--- | :--- |
| The observed file-level difference between a baseline manifest and a candidate tree at collection time | **Established** by `endo.staged-changeset.v0` and verified staged bytes |
| That staged bytes on disk still match `manifest.json` and the operator's baseline/changeset pins | **Established** by `verifyStagedChangeSetV0` (offline, read-only) |
| That the agent's processes exited before collection | **Not established here.** The caller must confirm termination first; stat re-checks detect concurrent edits during collection (`changed-during-collection`) but do not replace termination confirmation |
| Who authored any change | **Not claimed.** A difference between two trees is not authorship |
| Permission to apply changes to a host checkout | **Not granted.** Staging produces a read-only artifact for review; nothing writes back to a checkout |
| Protection against a same-uid host writer | **Not claimed.** Staged files are local unsigned files readable/modifiable by anything holding the operator's uid |

## 3. Staging layout and invariants

When `collectStagedChangeSetV0` succeeds (`status: "collected"`), it creates a new, controller-owned `stagingDir` (failing if it already exists):

```text
<stagingDir>/
├── manifest.json     # canonical endo.staged-changeset.v0 JSON, mode 0o444
└── files/
    └── <path>        # every added, modified, and mode-changed file, mode 0o444
```

Invariants:

1. **No partial staging on refusal.** Every candidate file is checked and hashed within bounds before `stagingDir` is created. Any refusal returns `{ status: "refused", manifest: null, stagingDir: null, refusals }` without creating `stagingDir`.
2. **Bounded memory.** Unchanged candidate files are hashed and immediately discarded; only changed files (`added`, `modified`, `mode`) are buffered, bounded by `maxTotalStagedBytes` and `maxChangedFiles`.
3. **Never executable on the host.** Every file under `files/` is written with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and `chmod 0o444`. The owner execute bit (`mode & 0o100`) is recorded solely as `executable: boolean` metadata in `manifest.json`. `verifyStagedChangeSetV0` refuses any staged file carrying any execute bit (`mode & 0o111`).
4. **No `.git` metadata in candidate workspaces.** Any `.git` file, directory, or link anywhere in a candidate workspace is refused with `git-metadata`. `captureWorkspaceBaselineV0` supports `skipRootGit: true` when reading a Git checkout or `admitWorkspaceV0` snapshot, recording `rootGitExcluded: true` explicitly; nested `.git` is always refused.
5. **No symbolic links, hard links, special files, or mount crossings.** On Linux, directory traversal pins each directory via `O_PATH | O_NOFOLLOW` and `/proc/self/fd`, checking both `stat.dev` and `/proc/self/fdinfo` `mnt_id`. Agent-caused filesystem errors (`EACCES`, `EPERM`, `ENOENT`, `ENOTDIR`, `ELOOP`, `EISDIR`) become `unreadable` refusals; host I/O errors (`EIO`, `EMFILE`, ...) propagate.
6. **Subprocess-free review preview.** `renderStagedChangeSetPreviewV0` verifies the staging directory first, classifies binary vs. UTF-8 text deterministically (NUL byte or invalid UTF-8 → `binary`), verifies baseline files by `before.sha256` before diffing when `baselineDir` is provided, and computes bounded unified diffs in pure TypeScript without invoking `git` or a shell.
7. **Every manifest describes a possible tree.** Both validators reject a regular file that has a descendant in the same tree with `EndoInvalidRecordV0`, after the sorted/unique path check and before any digest is consulted. A path `p` is an ancestor of `q` when `q` starts with `p + "/"`; `src` is an ancestor of `src/index.ts` but not of `src.ts` or `src-old/x`.
   - **Baseline (`endo.workspace-baseline.v0`).** Every entry is a regular file of one tree, so no entry may be an ancestor of another entry.
   - **Change set (`endo.staged-changeset.v0`), before-state.** Every change with a non-null `before` (`modified`, `mode`, `deleted`) asserts a regular file in the baseline, so no two such paths may be ancestor and descendant.
   - **Change set, after-state.** Every change with a non-null `after` (`added`, `modified`, `mode`) asserts a regular file in the candidate, so no two such paths may be ancestor and descendant.
   - **Across the two states an ancestor/descendant pair stays valid**, because it is how a file is replaced by a directory or a directory by a file. Baseline file `src` `deleted` plus `src/index.ts` `added` (file → directory) is accepted, and so is `src/a.ts` and `src/b.ts` `deleted` plus file `src` `added` (directory → file).

   The check is a membership test of each proper `/`-boundary prefix against the set of paths on that side, so its cost is bounded by total path length. It deliberately does not rely on sort adjacency: lexicographic order puts `a-b` between `a` and `a/c`. `collectStagedChangeSetV0` never produces a violation (a tree walk yields no file beneath a file), so this only narrows what a hostile or buggy producer can hand `verifyStagedChangeSetV0`. It changes no record shape and no canonical digest input. The manifest alone cannot show a conflict between an `added` path and an *unchanged* baseline file, because unchanged files are not listed. Catching that needs the pinned baseline itself, not just its digest.
