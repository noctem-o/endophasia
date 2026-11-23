# openclaw-plugin-endophasia-status

A read-only OpenClaw tool, `endophasia_status`, that answers "what's happening with Endophasia, what needs my attention, which agent
sessions are active?" from Endophasia's own evidence-qualified status (`endo coordinator status`, schema `endo.coordinator-status.v0`).
Design, guarantees and the compatibility report: [docs/designs/coordinator-status.md](../../docs/designs/coordinator-status.md).

Written against OpenClaw 2026.10.5's `defineToolPlugin` (`openclaw/plugin-sdk/tool-plugin`, available since 2026.5.17).

## Build

```bash
npm install --omit=peer     # typebox only; OpenClaw supplies its SDK at load time
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
          // sandbox: "bwrap" (default: read-only filesystem, no network, credential stores masked) | "none"
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

It runs one fixed command built from this config (no shell, scrubbed environment, timeout, output bound, bwrap by default) and relays a
validated, qualified answer. It cannot move a task, prompt or launch an agent, approve anything, or reach Endophasia's control socket.
