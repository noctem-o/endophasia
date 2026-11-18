# DEVELOP-ISOLATE-002: workspace admission and launch attestation

This follow-up is based on #152. It is not wired into the workbench, does not enable Everyday or Protected, and does not add a credential route.

## Workspace admission and Git

A list of Git overrides cannot make the existing host inspector safe against a concurrently modified repository. For example, it enumerates the names of filters before invoking Git; the repository can change between those reads. A network boundary around Pi alone does not cover the inspector's own reads. This slice instead produces a bounded private copy and runs two fixed, read-only Git operations inside Bubblewrap. It never supplies Git with the original configuration.

The caller must supply its evidence root and internal roots. Admission requires a canonical absolute workspace path and refuses overlap in either direction with those roots (including configured aliases), symlink path components, a root mount point, nested mounts, symlinks and hardlinked files in copied entries, special files, nested Git directories, and any top-level `.git` other than a real directory. Gitfiles and linked worktrees are not supported. Linux O_PATH descriptors pin each opened object before classification or reading; the copier checks mount identity, bounded byte counts and modification metadata, and never binds the original. This is not an atomic filesystem snapshot or authorization to mount an arbitrary live checkout read-write.

Only a small standalone SHA-1 Git projection is copied: HEAD, index, refs, packed refs, loose objects and ordinary packs. Hooks, worktree config, includes, alternates and submodule Git metadata are not copied. A conservative check of the local config refuses unsupported fields, then substitutes a fixed generated config; none of the source values reach Git. The only operations are status and unstaged diff. No host system/global config, shell, helper path, protocol or network is available. There is no fallback to host Git or the existing inspector.

| Configuration surface | Why it cannot run here |
| --- | --- |
| `core.hooksPath`, `core.fsmonitor`, `core.pager`, `core.sshCommand` | Refused before launch; hooks omitted, pager and fsmonitor disabled. |
| `diff.*.textconv`, `diff.external`, `filter.*.clean\|smudge\|process` | Refused before launch; external diff and textconv disabled; no drivers reach Git, even if attributes select one. |
| `uploadpack.packObjectsHook`, `protocol.*.allow` (including `ext`) | Refused before launch. No upload/fetch command, helpers or protocols are enabled. |
| `include.path`, `includeIf` | Refused as data by admission; Git never parses the source file. |
| `gpg.program`, `credential.helper` | Refused before launch; no signing, authentication or provider route. |

The new tests make writable hostile Git fixtures that name a disposable canary script. They assert the exact rejected directive and the absence of the canary, plus the specific path, alias or metadata refusal for unsafe paths. A separate test changes the original after admission and checks that the generated config and copied work file are unchanged. On Arch, the opt-in test also observed a real staged/modified file in the sandbox's status and real unstaged diff, with confirmed scope cleanup. The restriction to a small standalone repository, text status/diff output, and the assumption of a trusted host operator remain; the full workbench inspector is not changed.
