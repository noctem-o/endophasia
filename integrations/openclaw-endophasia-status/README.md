# openclaw-plugin-endophasia-status

A read-only OpenClaw tool, `endophasia_status`, that answers "what's happening with Endophasia, what needs my attention, which agent
sessions are active?" from Endophasia's own evidence-qualified status (`endo coordinator status`, schema `endo.coordinator-status.v0`).
Design, guarantees and the compatibility report: [docs/designs/coordinator-status.md](../../docs/designs/coordinator-status.md).

Written against OpenClaw's `defineToolPlugin` (`openclaw/plugin-sdk/tool-plugin`). The built plugin has been run through OpenClaw
2026.5.18 and 2026.10.5 (2026.10.5 on George's host by this PR's author; both by the ENDO-29 review), and through no other version, so
the `openclaw` peer is `>=2026.5.18 <=2026.10.5`. Widen it only after running the tests and the loader smoke on another version.

## Build

```bash
npm install --omit=peer --no-package-lock   # typebox 1.3.34 only (exact pin, no dependencies of its own)
npm run build               # dist/index.js (bundles the repository's status validator)
openclaw plugins build --entry ./dist/index.js --check
openclaw plugins validate --entry ./dist/index.js
```

## Configure (operator only)

```json5
{
  plugins: {
    entries: {
      "endophasia-status": {
        enabled: true,
        config: {
          endo: { node: "/usr/bin/node", entry: "/path/to/endophasia/cli/index.ts" },
          storeRoot: "/home/<you>/.local/share/endophasia/store",
          // root: the project's registered working tree, the only project path the sandbox mounts
          projects: [{ id: "endo.project.<32 hex>", root: "/path/to/project", label: "my-project" }],
          // bwrapPath: "/usr/bin/bwrap"   // always sandboxed; there is no unsandboxed mode
          // staleAfterSeconds: 600, timeoutMs: 20000
          // disclose: { taskTitles: false, detail: false }
          //   taskTitles: include your task titles (your private words)
          //   detail: also return the whole validated status (check commands with their argv, commit ids, session and runtime ids,
          //           project names, store-wide session counts). Off by default; leave it off for anything that leaves the host.
        },
      },
    },
  },
}
```

**The tool is not isolated by having to be named.** It registers as `optional`, but on OpenClaw 2026.10.5 the `full` tool profile resolves
to `allow: ["*"]`, and that wildcard grants `endophasia_status` without the operator ever naming it (measured by the ENDO-29 review on
George's host). Run it only on a dedicated agent whose tool list is exactly `["endophasia_status"]`, with no profile or wildcard that
would add `exec` or any other tool. Installing it into a live gateway changes that gateway's configuration; this repository does not do
that for you.

**2026.11.7 (e31bbf0) shell compatibility.** Measured on Arch Linux with the declared TypeBox 1.3.34: metadata build check and validation
passed, lint exited zero with one TypeBox runtime-code-generation warning, and scratch-state runtime inspection loaded the optional
`endophasia_status` tool with no diagnostics and an SDK deprecation advisory. The peer range adds only this tested release. It does not
certify the plugin in a systemd service or a production Gateway. The separate
[`endo coordinator brief` runner](../../docs/designs/coordinator-runtime.md) uses this plugin's trimmed view but independently enforces
the embedded agent's tool surface and does not mount project roots.

## What it can and cannot do

It runs one fixed command built from this config: no shell, a scrubbed environment, a timeout, an output bound, and always inside
bubblewrap. If bubblewrap is missing or cannot start, the answer is `unavailable` and endo never runs. The sandbox has no network and an
empty root. It gets read-only binds of only `/usr` and a few `/etc` files, the node binary, endo's code, the store's `develop/` and
`events/`, and the requested projects' roots. Use standalone checkouts: Git pointer files, symlinked `.git` paths, and `.git/commondir`
entries are refused before launch as `unavailable` (`project-git-layout-refused`). The launcher never mounts a path supplied by Git metadata. This excludes Capy linked worktrees; primary checkouts work. A project-root symlink resolving outside its configured parent is refused before launch (`project-root-refused`). The accepted canonical mount paths are in `projectRoots` only when `disclose.detail` is on, so default remote replies don’t disclose host paths.
Your home directory, the gateway's credential stores, the store's
control socket and other projects are not mounted. The answer is validated (labels re-derived, scope reconciled with the request) and trimmed
to what a status answer needs (see `disclose.detail`). It reports visible receipt outcomes and their relation to HEAD. A surviving passing receipt does not prove overall task verification, so passes alone produce `incomplete` with `receipt-history-unverifiable`. It cannot move a task, prompt or launch an agent, approve anything, or reach
Endophasia's control socket.

What it does not establish: a read still reaches everything inside those mounts that the gateway user can read, including any pathname
Unix socket that happens to live in a mounted project tree or its Git directory. Read-only binds and a network namespace do not stop a
`connect()` to such a socket. The sandbox reduces what a compromised read can reach; it is not proof of confinement, and the trimming of
the answer is output filtering, not isolation.
