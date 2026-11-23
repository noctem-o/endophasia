# openclaw-plugin-endophasia-status

A read-only OpenClaw tool, `endophasia_status`, that answers "what's happening with Endophasia, what needs my attention, which agent
sessions are active?" from Endophasia's own evidence-qualified status (`endo coordinator status`, schema `endo.coordinator-status.v0`).
Design, guarantees and the compatibility report: [docs/designs/coordinator-status.md](../../docs/designs/coordinator-status.md).

Written against OpenClaw 2026.10.5's `defineToolPlugin` (`openclaw/plugin-sdk/tool-plugin`). It has been exercised against 2026.10.5
only, so the `openclaw` peer is pinned to exactly that version; widen it only after running the tests and the loader smoke on another.

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
          projects: [{ id: "endo.project.<32 hex>", label: "my-project" }],
          // bwrapPath: "/usr/bin/bwrap"   // always sandboxed: read-only filesystem, no network, credential stores masked
          // staleAfterSeconds: 600, timeoutMs: 20000
          // disclose: { taskTitles: false }   // task titles are your private words
        },
      },
    },
  },
}
```

The tool is `optional`: allowlist it explicitly, ideally on an agent whose only tool it is. Installing it into a live gateway changes that
gateway's configuration; this repository does not do that for you.

## What it can and cannot do

It runs one fixed command built from this config (no shell, scrubbed environment, timeout, output bound, always
inside bubblewrap; if bubblewrap is missing or cannot start the answer is `unavailable` and endo never runs) and relays a
validated, qualified answer. It cannot move a task, prompt or launch an agent, approve anything, or reach Endophasia's control socket.
