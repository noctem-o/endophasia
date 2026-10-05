# Raw run data of the discriminating-task study

The complete run directories, as `endo experiment run` wrote them, kept so others can inspect any trial. Each trial directory holds
its event store (`store/`: the session's events, the capture log, the keyed blobs of every request and response, Pi's own session file),
its `result.json` and the success check's output (`check.txt`).

| Directory | What it is | Runs | Trials |
| :--- | :--- | ---: | ---: |
| `pilot/` | the screen (DESIGN §6, §9a): 12 tasks × 6 trials, one run | 1 | 72 |
| `confirm/` | the confirmation: `c1` to `c4`, 3 tasks × 5 trials each; `paths.json` records the seed, order and scratch hashes | 4 | 60 |

Everything is synthetic, in the `fixture-public` digest domain (`research/fixture-keys/`), so the keyed digests offer no secrecy and
the stores can be read with the committed key.

## Operator consent and the secret scan

The operator consented on 2026-10-04 to committing this data, and to their username, hostname, kernel string and dates appearing in
committed run data, unscrubbed.

`cli/secret-scan.ts` was run over this directory exactly as committed (every file read, JSON blobs walked, archived files decoded):
**no API key, token, private key, JWT, bearer token, secret-named environment assignment or auth header was found.** Its one kind of
finding was **absolute paths outside the scratch roots**, which are allow-listed in `allowed-paths.json` (the operator approved
committing the data, on the earlier studies' exception for exactly this kind of path; the list is new and is reported here):

- the stores' own location under the operator's home directory (`storesLocation`), which Pi's session files record. The event logs are
  checksummed, so the path cannot be rewritten without breaking the stores;
- 48 throwaway-script paths the agent itself wrote to (`agentWrittenPaths`, mostly `/tmp/verify….mjs`, `/tmp/check.mjs`);
- 6 example paths that appear in the tasks' own text (`taskExamplePaths`: `/etc/app/main.json` and similar in `config-extends`).

`tests/discriminating-tasks-raw-data.test.ts` re-runs the scan with exactly this allow-list, so a new kind of finding, or a path
outside it, fails the suite.
