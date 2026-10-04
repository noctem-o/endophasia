# Cassettes of the steering study (Pi 1.0.1, qwen3.8-27b)

These are six replayable cassettes from the study's main run ([DESIGN.md](../DESIGN.md) §10), one per task per arm.
For each (task, arm) cell, the cassette is the first completed trial in plan order (`selection.json`); every one is
trial #0 of its cell. They were recorded on 2026-10-04 in the main run (seed 3004904282), through the recording proxy,
with workspace snapshots that keep file times (`endo.workspace-archive.v1`) and the pinned environment
(`capture.environment`). The steered ones carry the intervention's driver steps (`pi-cassette-driver.2`), and the
capability evidence that admitted the controls.

| Directory | Task | Arm |
| :--- | :--- | :--- |
| `tool-use--base`, `--steer`, `--queue` | tool-use | no intervention; STEER; QUEUE |
| `implement-function--base`, `--steer`, `--queue` | implement-function | the same three arms |

Each directory is a cassette fixture (`cli/cassette-fixture.ts`):
- `session.events.jsonl`, which holds the intervention chain of a steered trial (proposal, authorization, request,
  acceptance, consumption, consequence);
- `capture.events.jsonl`, with the driver's steps and each exchange;
- `evidence.jsonl`: Pi's capability evidence for the steering controls (empty for a baseline trial, which needs none);
- `normalization.json`;
- `blobs/fixture-public/`: request bodies, response wire bytes, the snapshot archive, the prompt and the message.

Every trial passed its success check, and none had a connection error or an incomplete exchange.

## Operator consent

The operator consented, on 2026-10-04, to these details appearing in committed cassettes, unscrubbed:
- their **username**;
- the **hostname**;
- the **kernel string** (in the request headers Pi sends: `user-agent: pi (linux 7.2.6-arch2-1; x64)`);
- **dates and times** (snapshot file times, event timestamps).

In these files the username appears in none, the hostname in none, and the kernel string in 6.

## Secret scan (the hard gate)

`cli/secret-scan.ts` was run over this directory exactly as committed, with every file read, JSON blobs walked and
archived files decoded. **It passed with 0 findings.**

The only absolute paths are on the allow-list:
- the scratch root, `/tmp/endo-experiment-372c52355fe7`;
- Pi's install path, `/usr/lib/node_modules/@earendil-works/pi-coding-agent`.

`tests/steering-cassettes.test.ts` re-runs the scan in the default suite.

**One normalization, declared.** The session events named the store's own location (Pi's `--session-dir`) under the
operator's home directory. That is a local path, not captured content, and replay does not use it. It is replaced by
`<store>`: one string per trial, counted in each `normalization.json`. Nothing else is changed.

## Replaying them

```sh
# materialize one into a store, then replay it (no model is called)
node -e 'import("./cli/cassette-fixture.ts").then(m => m.materializePiCassetteFixtureV0(process.argv[1], process.argv[2]))' \
  research/steering/1.0.1/cassettes/tool-use--steer <empty store directory>
endo replay <that store directory> <session> --pi "$(command -v pi)" --timing immediate --fixture
```

A replay of a steered cassette re-issues the intervention at the recorded delivery point (exchange 2, chunk 1) with
the same proposal digest, and reports it.

Replayed against Pi 1.0.1 on 2026-10-04 (`../analysis/cassette-replays.json`): **all 22 replays are EXACT** with 0
misses: each of the 4 steered cassettes 5 times (3 immediate, 2 as-recorded), and each of the 2 baseline cassettes once.
`ENDO_PI_EXECUTABLE="$(command -v pi)" npx vitest --run tests/steering-cassettes.test.ts` repeats them.
