# Raw run data of the path-sensitivity study

The complete run directories, as `endo experiment run` wrote them, kept so others can inspect any trial. Each trial
directory holds its event store (`store/`: the session's events, the capture log, the keyed blobs of every request and
response, Pi's own session file), its `result.json` and the success check's output.

| Directory | What it is | Paths | Trials |
| :--- | :--- | ---: | ---: |
| `pilot/` | the pilot (DESIGN §9a), two paths outside the sample | 2 | 24 |
| `main/` | the main run, 30 paths, seed 3826429729; its analysis is in `../analysis/` and its summaries in `../main/` | 30 | 360 |

Each path is one run directory (`main/p01/` and so on) with its `evidence/` (the capability study's Pi evidence and its
own capture log: model traffic that is not part of any trial), its `report/` and its `trials/`.

Everything is synthetic, in the `fixture-public` digest domain (`research/fixture-keys/`), so the keyed digests offer no
secrecy and the stores can be read with the committed key. `endo trajectory show` and `endo replay` work on a trial store
here, but `endo replay` restores the scratch root at its **recorded absolute path** (Pi's system prompt carries it, and
that path is the factor this study varies), so a replay needs that path free: see `docs/replay.md`.

## Operator consent and the secret scan

The operator consented on 2026-10-04 to committing this data, and to their username, hostname, kernel string and dates
appearing in committed run data, unscrubbed.

`cli/secret-scan.ts` was run over this directory exactly as committed (every file read, JSON blobs walked, archived
files decoded): **no API key, token, private key, JWT, bearer token, secret-named environment assignment or auth header
was found.** Its one kind of finding was **absolute paths outside the scratch roots**, 1,856 of them, which the operator
allowed, as an explicit exception to the gate, for exactly these (listed in `allowed-paths.json`):

- the stores' own location under the operator's home directory, `/home/noctem/projects/endophasia/.artifacts/path-sensitivity`,
  which Pi's session files record. The event logs are checksummed, so the path cannot be rewritten without breaking the
  stores;
- the 32 temporary directories of the capability studies (an `endo-pi-study-<random>` directory in the system temp
  directory, one per path).

Every other absolute path is under a run's scratch root (an `endo-experiment-<hash>` directory in the system temp
directory) or is Pi's install path or executable. `tests/path-sensitivity-raw-data.test.ts` re-runs the scan with exactly
this allow-list, so a new kind of finding, or a path outside it, fails the suite.
