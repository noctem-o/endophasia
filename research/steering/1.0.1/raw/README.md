# Raw run data of the steering study

The complete run directories, as `endo experiment run` wrote them, kept so others can inspect any trial. Each trial
directory holds its event store (`store/`: the session's events, the capture log, the keyed blobs of every request and
response, Pi's own session file), its `result.json` and the success check's output.

| Directory | What it is | Trials |
| :--- | :--- | ---: |
| `pilot/` | the pilot (DESIGN §9a), seed 3312024923 | 18 |
| `main/` | the main run, seed 3004904282 (its analysis is in `../analysis/`, its report in `../main/`) | 120 |
| `posthoc-pilot-path/` | post-hoc: the pilot spec again, new ordering seed (RESULTS.md, "a post-hoc finding") | 18 |
| `posthoc-main-path/` | post-hoc: one block of the main spec, new ordering seed | 6 |
| `logs/` | the runner's and the report command's output | |

Each run directory also has `evidence/` (the capability study's Pi evidence and its own capture log: model traffic that
is not part of any trial) and `report/` (the experiment report).

Everything is synthetic, in the `fixture-public` digest domain (`research/fixture-keys/`), so the keyed digests offer no
secrecy and the stores can be read with the committed key. `endo trajectory show <trial store> <session>` and
`endo replay` work on a trial store here, but `endo replay` restores the scratch root at its **recorded absolute
path** (Pi's system prompt carries it), so a replay needs that path free: see `docs/replay.md`.

## Operator consent and the secret scan

The operator consented to committing this data on 2026-10-04, and to their username, hostname, kernel string and dates
appearing in committed run data, unscrubbed.

`cli/secret-scan.ts` was run over this directory exactly as committed (every file read, JSON blobs walked, archived
files decoded): **no API key, token, private key, JWT, bearer token, secret-named environment assignment or auth header
was found.** Its one kind of finding was **absolute paths outside the scratch roots**, 692 of them, which the operator
allowed, as an explicit exception to the gate, for exactly these:

- the stores' own location under the operator's home directory, `/home/noctem/projects/endophasia/.artifacts/steering-1.0.1`,
  which Pi's session files record. The event logs are checksummed, so the path cannot be rewritten without breaking the
  stores (the exported cassettes, which are plain files, replace it with `<store>` instead);
- four temporary directories of the capability study, `/tmp/endo-pi-study-ExgR0h`, `-qRaeRX`, `-KgMwCy` and `-hbemp8`.

Every other absolute path is under a run's scratch root (an `endo-experiment-<hash>` directory in the system temp
directory) or is Pi's install path or
executable. `tests/steering-raw-data.test.ts` re-runs the scan with exactly this allow-list, so a new kind of finding, or
a path outside it, fails the suite.
