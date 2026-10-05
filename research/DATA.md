# Where the studies' raw run data lives

The raw run directories of the studies (every trial's event store, capture log, keyed request and response blobs, Pi's own session
file, the success check's output) are **not in this repository**. They are hundreds of megabytes per study and tens of thousands of
files, and a repository that carries them makes every change expensive to check. The studies' **designs, results, analyses, run
summaries, per-trial result files where small, and the cassettes** stay here. Everything the written results report can be re-derived from the raw data;
the raw data is the evidence behind them.

| Study | Raw run data | Files | On disk | Archive (zstd) |
| :--- | :--- | ---: | ---: | ---: |
| [Steering](steering/1.0.1/RESULTS.md) | `steering/1.0.1/raw/` | 4,120 | 119 MB | 2.9 MB |
| [Path-sensitivity](path-sensitivity/1.0.1/RESULTS.md) | `path-sensitivity/1.0.1/raw/` | 10,531 | 273 MB | 7.3 MB |
| [Discriminating-task](discriminating-tasks/1.0.1/RESULTS.md) | `discriminating-tasks/1.0.1/raw/` | 3,701 | 614 MB | 20.3 MB |
| [Completion-cap](completion-cap/1.0.1/RESULTS.md) | `completion-cap/1.0.1/raw/` (and `logs/`) | 10,170 | 1.5 GB | 48.0 MB |

## Getting it

The data is kept beside this checkout, in `../endophasia-research/` (laid out as `<study>/1.0.1/raw/`), and is published as one archive per study.
**Download link: (to be added by the maintainer).** The archives' checksums:

```
    3a5aa1f97b26ce8a4072d3268b85595e0f73e5c7dbd094024689d5e210598d08  completion-cap-1.0.1.tar.zst
    a5f88bc1e2125ec7d464aead25d0ce952b1aef5913853c3610baadcb0acac22f  discriminating-tasks-1.0.1.tar.zst
    3e1ddb4cde8cd043d574b70c6669e11cfcfaca2ec4df3cb39c0dcf65ff9685a1  path-sensitivity-1.0.1.tar.zst
    ac5c07be7493071cdb7f60a4e794b21e18468fca1703b54e28dc55f4be413bcf  steering-1.0.1.tar.zst
```

To restore a study: `tar --zstd -xf <study>-1.0.1.tar.zst -C <directory>` (each archive holds `<study>/1.0.1/...`), then point the tools at it with
`ENDO_RESEARCH_DATA=<directory>` (the default is `../endophasia-research`). `research/data.ts` resolves the location.

## What reads it

- `tests/steering-raw-data.test.ts`, `tests/path-sensitivity-raw-data.test.ts`, `tests/discriminating-tasks-raw-data.test.ts` and `tests/completion-cap-raw-data.test.ts` run the secret scan over a study's
  raw data with its reviewed, documented path exception, and open a trial store. **They are skipped when the data is absent** (as on CI).
- `scripts/verify-consumption.ts` re-checks every recorded `intervention.consumed` in the steering and path-sensitivity data (it reports nothing to do when the data is absent).
- `research/path-sensitivity/1.0.1/post-hoc-baseline.ts` reads the path-sensitivity data.
- `endo trajectory show` and `endo replay` work on any trial store there (see `docs/replay.md`).

## Consent, secrets and what is in the data

Everything is synthetic, in the `fixture-public` digest domain (`research/fixture-keys/`), so the keyed digests offer no secrecy. The operator consented on 2026-10-04 to their
username, hostname, kernel string and dates appearing in committed run data, unscrubbed. `cli/secret-scan.ts` was run over each study's raw data: **no API key, token, private key,
JWT, bearer token, secret-named environment assignment or auth header was found in any of them.** Its one kind of finding is absolute paths outside the scratch roots, which each study's
data directory lists by category (`raw/allowed-paths.json` or `allowed-paths.json`, and `raw/README.md` for the three older studies). **Review those lists before publishing the data:**
the completion-cap data's list includes two paths of a repository checkout that an agent read, a path of the operator's other projects that an agent's filesystem search printed,
and a path of the operator's own Claude Code scratchpad (see the completion-cap results, Validity).
