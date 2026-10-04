# Supplementary cassettes for the variance study (Pi 1.0.1, qwen3.8-27b)

These are nine replayable cassettes: one live trial per task per arm of the variance study (see
[DESIGN.md](../DESIGN.md)), recorded with its exact spec (`spec.json`; trials set to 1). They were recorded on
2026-10-04 on the same llama.cpp server session as the study's main run, through the fixed recording proxy, with
workspace snapshots that keep file times (`endo.workspace-archive.v1`).

**They are not part of the study's analysed data.** The main run's own cassettes were deleted before the operator
decided which to commit. These were recorded afterwards for that purpose, and the three spot-check trials of the main
run cannot be reproduced. `run.json` gives this recording's spec digest, ordering seed, scratch root, proxy port and
trial order.

| Directory | Task | Arm |
| :--- | :--- | :--- |
| `tool-use--a`, `--b`, `--b-c` | tool-use | A (Pi defaults), B (temperature 0, seed 1234), B+C (also `cache_prompt: false`) |
| `fix-failing-test--a`, `--b`, `--b-c` | fix-failing-test | the same three arms |
| `implement-function--a`, `--b`, `--b-c` | implement-function | the same three arms |

Each directory is a cassette fixture (`cli/cassette-fixture.ts`):
- `session.events.jsonl`;
- `capture.events.jsonl`;
- `evidence.jsonl` (empty: these trials ran no live study);
- `normalization.json`;
- `blobs/fixture-public/`: request bodies, response wire bytes, the snapshot archive and the prompt.

Every trial passed its success check, and none had a connection error or an incomplete exchange.

## Operator consent

The operator consented, on 2026-10-04, to these details appearing in committed cassettes, unscrubbed:
- their **username** (in `ls -la` output the model asked for, carried in later requests);
- the **hostname**;
- the **kernel string** (in the request headers Pi sends: `user-agent: pi (linux 7.2.6-arch2-1; x64)`);
- **dates and times** (`ls -la` modification times, snapshot file times, event timestamps).

In these files, the username and `ls` dates appear in 25 files and the kernel string in 9. The hostname appears in
none.

## Secret scan (the hard gate)

`cli/secret-scan.ts` was run over this directory exactly as committed, with every file read, JSON blobs walked and
archived files decoded. **It passed with 0 findings.** It checks for:
- API keys and tokens;
- private keys and JWTs;
- bearer tokens other than the scratch placeholder `local`;
- secret-named environment assignments;
- raw auth headers;
- absolute paths outside the allowed roots.

The only absolute paths are these three, all on the allow-list:
- the scratch root `/tmp/endo-experiment-d270240da4d6`;
- Pi's install path `/usr/lib/node_modules/@earendil-works/pi-coding-agent`;
- the Pi executable the spec names, `/usr/bin/pi` (in `spec.json`).

`tests/variance-cassettes.test.ts` re-runs the scan in the default suite.

**One normalization, declared.** The session events named the store's own location (Pi's `--session-dir`) under the
operator's home directory: a local path, not captured content, and not used by replay. It is replaced by `<store>`
(one string per trial, counted in each `normalization.json`). Nothing else is changed.

## Replaying them

```sh
# materialize one into a store, then replay it (no model is called)
node -e 'import("./cli/cassette-fixture.ts").then(m => m.materializePiCassetteFixtureV0(process.argv[1], process.argv[2]))' \
  research/variance/1.0.1/cassettes/tool-use--b <empty store directory>
endo replay <that store directory> <session> --pi "$(command -v pi)" --timing immediate --fixture
```

Replayed against Pi 1.0.1 on 2026-10-04:
- **tool-use:** EXACT under every arm.
- **The six coding-task cassettes:** each reported **environment diverged** at an exchange where `node --test` printed
  new durations, never control flow. File times are restored, so `ls -la` matched the recording.

That is the wall-clock limit `docs/replay.md` describes.
