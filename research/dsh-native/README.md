# DeepSeek Harness native-attachment study (PR 1)

Evidence for [docs/dsh-native-attachment.md](../../docs/dsh-native-attachment.md). Not an adapter: nothing here is imported by
`protocol/`, `runtime/`, `storage/`, `cockpit/`, Studio or `adapters/`, and nothing here depends on DSH or Cordis.

| File | What it is |
| --- | --- |
| `provenance.json` | DSH commit, version, licence and the sha256 of every DSH source file and upstream fixture the audit rests on |
| `vocabulary.json` | DSH's 62 persisted event types and the 65 type-fingerprint roots (`docs/persistence-schema.json`), pinned |
| `matrix.json` | The native-versus-ACP-versus-Endophasia fidelity matrix; every event type in exactly one row (a test enforces it) |
| (moved) | The read-only reader, `log.ts`, now lives in `adapters/dsh-native/` and is imported from there; see [docs/dsh-native-importer.md](../../docs/dsh-native-importer.md) |
| `sanitise.ts` | Deterministic sanitiser (system prompt, injected context, paths, ids, dates) and `findLeaks` |
| `synthetic.ts` | SYNTHETIC cases built from a real fixture: torn frame, corrupt frame, unknown types, fork, compaction |
| `inventory.ts` | Regenerates `provenance.json` and `vocabulary.json` from a DSH checkout (read-only on the checkout) |
| `reproduce.ts` | Runs a scenario in a throwaway DSH home with an empty environment and the egress-capable plugins disabled |
| `build-fixtures.ts` | Turns raw captures into `fixtures/real/` |
| `instruments/` | The passive `session/event` observer and the deterministic stub provider used by `reproduce.ts` |
| `fixtures/real/` | Sanitised output of a REAL DSH 0.2.1-rc.2 runtime, plus `comparison.json` (live feed versus persisted log versus `--json`) |

Raw captures (the zstd logs DSH wrote, the unsanitised streams and the observer feeds) stay outside the repository, in
`../endophasia-research/dsh-native/raw/<case>/` (see [research/DATA.md](../DATA.md)). They hold the real system prompt and local
paths and are never committed.

## Safety rules of the harness

* `DSH_HOME` and `HOME` point into a scratch directory; the user's `~/.dsh` is never read or written.
* The child process gets an empty environment plus `PATH`, `HOME`, `DSH_*` and a placeholder model key. No inherited API key, `.env`
  value or proxy reaches it.
* Permission mode `read-only`, telemetry disabled, and the rows listed in `DISABLED_ROWS` (DeepSeek routes and account, session-log
  upload, package inventory, telemetry, web tools, shell and job tools, subagents, workflows) are disabled in the profile patch.
* The observer only registers `emit`-mode listeners. It never registers on a waterfall hook (`agent/request`, `tools/*`,
  `approval/request`), which could change behaviour.
* The crash scenario kills only the child process the harness started.
