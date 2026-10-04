# Cassettes of the pinned-environment study (Pi 1.0.1, qwen3.8-27b)

These are twelve replayable cassettes from the study's main run ([DESIGN.md](../DESIGN.md) §10), one per task per arm.
For each (task, arm) cell, the cassette is the first completed trial in plan order (`selection.json`). Every one is
trial #0 of its cell. They were recorded on 2026-10-04 in the main run (seed 3619119635), through the recording
proxy, with workspace snapshots that keep file times (`endo.workspace-archive.v1`). The pinned arms also record their
environment (`capture.environment`).

| Directory | Task | Arm |
| :--- | :--- | :--- |
| `tool-use--a-p`, `--b-p`, `--b-c-p`, `--b-c-u` | tool-use | A-p, B-p, B+C-p (environment pinned), B+C-u (unpinned) |
| `fix-failing-test--…` | fix-failing-test | the same four arms |
| `implement-function--…` | implement-function | the same four arms |

Each directory is a cassette fixture (`cli/cassette-fixture.ts`):
- `session.events.jsonl`;
- `capture.events.jsonl`;
- `evidence.jsonl` (empty: the trials ran no live study);
- `normalization.json`;
- `blobs/fixture-public/`: request bodies, response wire bytes, the snapshot archive and the prompt.

Every trial passed its success check, and none had a connection error or an incomplete exchange.

## Operator consent

The operator consented, on 2026-10-04, to these details appearing in committed cassettes, unscrubbed:
- their **username** (in `ls -la` output the model asked for, carried in later requests);
- the **hostname**;
- the **kernel string** (in the request headers Pi sends: `user-agent: pi (linux 7.2.6-arch2-1; x64)`);
- **dates and times** (`ls -la` modification times, snapshot file times, event timestamps).

In these files, the username appears in 24 files and the kernel string in 12. The hostname appears in none.

## Secret scan (the hard gate)

`cli/secret-scan.ts` was run over this directory exactly as committed, with every file read, JSON blobs walked and
archived files decoded. **It passed with 0 findings.**

The only absolute paths are on the allow-list:
- the scratch root, `/tmp/endo-experiment-93a1cbaf3653`;
- Pi's install path, `/usr/lib/node_modules/@earendil-works/pi-coding-agent`.

`tests/pinned-environment-cassettes.test.ts` re-runs the scan in the default suite.

**One normalization, declared.** The session events named the store's own location (Pi's `--session-dir`) under the
operator's home directory. That is a local path, not captured content, and replay does not use it. It is replaced by
`<store>`: one string per trial, counted in each `normalization.json`. Nothing else is changed.

## Replaying them

```sh
# materialize one into a store, then replay it (no model is called)
node -e 'import("./cli/cassette-fixture.ts").then(m => m.materializePiCassetteFixtureV0(process.argv[1], process.argv[2]))' \
  research/pinned-environment/1.0.1/cassettes/implement-function--b-c-p <empty store directory>
endo replay <that store directory> <session> --pi "$(command -v pi)" --timing immediate --fixture
```

A replay of a pinned cassette reapplies the recorded variables. The snapshot restores the `env/` reporter and the
fixed file times.

Replayed against Pi 1.0.1 on 2026-10-04 (`../analysis/cassette-replays.json`):
- **The 9 pinned cassettes:** EXACT on every layer with 0 misses, the coding tasks included.
- **`tool-use--b-c-u`:** EXACT.
- **`fix-failing-test--b-c-u` and `implement-function--b-c-u`:** **environment diverged**, at exchange 7 and 5. That
  is the wall-clock limit `docs/replay.md` describes: later tool output differed. Never control flow.
