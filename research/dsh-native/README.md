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
| `build-fixtures.ts` | Validates all clean raw captures, stages a complete sanitised set, then publishes `fixtures/real/` |
| `instruments/` | The passive `session/event` observer and the deterministic stub provider used by `reproduce.ts` |
| `fixtures/real/` | Sanitised output of a REAL DSH 0.2.1-rc.2 runtime, plus `comparison.json` (live feed versus persisted log versus `--json`) |

Raw captures (the zstd logs DSH wrote, the unsanitised streams and the observer feeds) stay outside the repository, in
`../endophasia-research/dsh-native/run-final/raw/<case>/` (see [research/DATA.md](../DATA.md)). They hold the real system prompt and local
paths and are never committed.

## Safety rules of the harness

* `DSH_HOME` and `HOME` point into a scratch directory; the user's `~/.dsh` is never read or written.
* The child process gets an empty environment plus `PATH`, `HOME`, `DSH_*` and a placeholder model key. No inherited API key, `.env`
  value or proxy reaches it.
* Permission mode `read-only`, telemetry disabled, and the rows listed in `DISABLED_ROWS` (DeepSeek routes and account, session-log
  upload, package inventory, telemetry, web tools, shell and job tools, subagents, workflows) are disabled in the profile patch.
* The observer only registers `emit`-mode listeners. It never registers on a waterfall hook (`agent/request`, `tools/*`,
  `approval/request`), which could change behaviour.
* The crash scenario kills only the child process the harness started, verifies a delivered SIGKILL and the close signal, then
  requires a zero-exit resume, an unchanged captured prefix, recovery markers and a completed new turn.
* Execution requires the exact clean provenance pin, including a clean entire working tree. Scratch roots must be new and empty
  or carry this harness's ownership marker; symlinked roots/cleanup ancestors are refused. Repeated runs replace only that
  scenario's scratch home/workspace and raw outputs (both crash outputs), never other scenarios or historical raw data.
  Relative checkout paths are resolved against the caller's directory before children change to the scratch workspace.
* Scratch roots must belong to the current user and are restricted to `0700` before captures are written or reused. This root
  protects child-created raw artifacts regardless of their file modes. Dynamic paths and model URLs are quoted YAML scalars.
* Each child has a 120-second deadline. `no-key-error` deliberately requires CLI exit 1 plus a persisted failed turn; other
  ordinary cases require exit 0. Model reads remain permission-mode read-only, not an OS filesystem sandbox; fixed benign prompts
  are used, never user-supplied tasks.

## Rebuilding and new experiments

The builder's default input is the historical `run-final/raw/` above. It refuses torn tails, read problems and structural errors:
valid recovered prefixes remain useful to the reader but cannot be published as clean runtime fixtures. Missing observer data is
`null`, including transient frame counts and `persistedEventsNeverAnnouncedLive`. An existing empty observer capture measures zero
live events and lists every persisted row as absent. That absence field describes the supplied capture, including rows before
attachment or after capture stopped; it makes no claim about unobserved execution. Mismatched correspondence is unknown (`null`).
Malformed observer JSON or UTF-8 fails the build. Every observed session-event envelope must identify the captured header's
nonempty session ID; missing or mixed identities fail before publication, rather than filtering evidence. The cold reader requires
the pinned writer's checksum flag on every complete compressed frame (the upstream decoder itself is more permissive). Its
`frames` count describes structurally complete frames found, including frames that cannot decode.

All output, including `comparison.json`, passes sanitisation and privacy scanning. The study's residual path gate examines decoded
JSON strings and keys, refuses unexpected absolute paths (including unlisted Unix roots, Windows paths and file URIs), and permits
only normalised `/fixture` paths. Relative event names and web URLs are not local paths. The builder prepares the entire set before writing a sibling staging directory and publishes
with directory renames and rollback on synchronous failure. It is not crash-atomic across the two renames: after abrupt process or
host death, a `.real-stage-*` sibling may hold `previous/` for manual recovery. Do not run concurrent builders for one destination.

Withheld lengths describe the original captured text's JavaScript string length. Each user message is scrubbed once, including
nested inbox copies. A later audit corrected 20 formerly double-scrubbed length placeholders in the five event fixtures against
the retained clean raw captures; no private text, event structure, stream or comparison changed. See `VALIDATION.md` for the audit.

For new experiments, use a new empty output root; retain historical evidence. The optional second positional builder argument
selects a separate destination. Destinations must be disjoint from the canonical raw root and source case/file targets, including
symlink aliases; publication inside raw evidence is also refused. Live-only event types are computed after a verified durable
suffix; mismatched correspondence is unknown (`null`). See the complete commands in [the reproduction section](../../docs/dsh-native-attachment.md#9-reproduce)
and the [repair validation record](VALIDATION.md).
