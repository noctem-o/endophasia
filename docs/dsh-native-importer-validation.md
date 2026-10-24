# DSH importer repair validation

PR #71 is stacked on #70. The parent is `e2fb3e4177d348c3d03b4f02b2eeb285622d0797`, whose Codex receipt reports no major issues
and whose five CI jobs passed. The old importer head was `a37fdc68c7d8dc30bcd538bc3a912171f4ad3118`: green CI there did not test
the repaired parent, and GitHub reported a merge conflict. Four importer review threads remained unresolved.

## Parent integration

Merge commit `ad625a27a` brings the repaired parent into the existing importer branch without rewriting either branch. The reader
is moved, not copied: `adapters/dsh-native/log.ts` is byte-for-byte identical to the parent's `research/dsh-native/log.ts`. The new
repair tests and harness imports now use that location too. This carries every parser repair, including raw JSONL bounds,
checksums, strict UTF-8, physical-row/frame integrity, cumulative bounds, tool-result pairing and safe event counters. The
parent's corrected sanitised fixture bytes are unchanged by this PR's repair. The initial combined integration check passed
174 targeted tests; the separate existing importer/recovery suites passed 62 tests in the advisor's independent run.

## Findings and corrections

| Finding | Correction and regression |
| --- | --- |
| Header metadata interpreted before validation | Importer-local guard mirrors the pinned physical `format.ts` header shape before the structural checker runs, adding the existing nonempty identity requirement. Tests cover absent/wrong required fields, boolean seed metadata, safe integer boundaries, encoded negative zero, optional fields, absolute cwd and unknown/retired keys. Invalid input leaves both empty and populated stores unchanged. Shared reader behavior is unchanged. |
| Raw ID mistaken for a coordinate | `session` always means a raw DSH ID by default. `sessionKind: "endo-coordinate"` explicitly selects a validated DSH coordinate. Tests cover prefix-looking IDs, hashed IDs, two simultaneously imported sessions whose selectors look alike, and no fallback when the raw ID is absent. |
| Open outcome reports zero turns | Count derived `lifecycle.turn-started` events within the current open run and reset on each run start. Tests cover zero, one and two steps plus a closed run followed by an open run. The retained real crash capture now reports one started turn. Projection version advances to `dsh-native-trajectory.2`. |
| Header-only retry ignores a changed fork cut | Compare the stored `inheritedCut` with the freshly derived cut before any append. A shifted marker with the same header is history-changed even when only the header was previously stored. An unchanged cut still resumes and becomes idempotent. |
| Importer content-kind counters inherit prototype properties | Use a null-prototype dictionary, with repeated `constructor`, `toString` and `__proto__` counts checked through import/store JSON. |
| Arbitrary raw source IDs can contain private paths | Retain plain identifier tokens only; other raw runtime IDs are explicitly withheld as UNAVAILABLE while their stable coordinates remain usable. The coordinate is never called the runtime ID. Path, Windows and spaced-ID regressions cover memory/projection, and the durable privacy test includes an unsafe source-ID canary. |
| Bomb test stopped at missing checksum | Enable checksums on the adversarial compressed frame and require a size-related refusal, so it continues exercising decompression bounds after the parent reader promotion. |

Mapping advances to `dsh-native-mapping.3` because safe content counts and runtime-ID withholding change stored interpretations.
Mappings 1/2 are refused, not silently upgraded. The fork-cut check uses the already-recorded cut and does not weaken keyed row
or header verification. No protocol, store, neutral runtime, Studio, Pi or ACP schema/implementation changed.

The first new review regression run produced **33 failures and 7 passes** before the corresponding fixes. Later cases also cover
the adjacent privacy boundary and explicit selector failures. Final targeted results are recorded below and in the PR comments.

## Evidence-backed cold imports

All five original `run-final/raw/<case>/session.v4.jsonl.zstd` captures were imported into separate fresh durable stores beneath
a newly created private `0700` research-data root, using an ephemeral private digest key. These are retained runtime captures,
not new model runs and not reads of active DSH state. Every source file was hash-checked unchanged after the experiment.

| Capture | Source rows | Projected outcomes and started turns |
| --- | ---: | --- |
| tool-read | 21 | completed, 2 |
| no-key-error | 16 | failed, 1 |
| crash-killed | 13 | open, 1 |
| crash-resumed | 25 | unclassified, 1; completed, 1 |
| stub-retry | 19 | completed, 1 |

Each identical re-import returned unchanged. Stored events, durable log and trajectory passed the secret/path scan and checks
for private home/system-prompt content. Importing the killed then resumed capture yielded the same trajectory digest as a
one-shot resumed import, under the same key and injected clock. DSH-written closers remain unclassified. No inference endpoint,
active DSH sessions, profiles, locks or services were touched. Private experiment summaries remain outside the repository.

## Reproduction and scope

```sh
PATH=/home/noctem/.nvm/versions/node/v22.19.0/bin:$PATH \
  ENDO_DSH_CHECKOUT=/home/noctem/deepseek-harness \
  npx vitest run tests/dsh-native-*.test.ts tests/release-readiness.test.ts
npm run typecheck
npm run lint
PATH=/home/noctem/.nvm/versions/node/v22.19.0/bin:$PATH \
  ENDO_DSH_CHECKOUT=/home/noctem/deepseek-harness ENDO_REQUIRE_BROWSER=1 npm test
npm run build
npm run test:package
```

The final targeted run passes **255 tests**, including the isolated pinned-source stub reproduction and all inherited regressions. The first repair run passed 244 before the additional pairing tests.
Full-suite/build/package results and exact CI identity are reported in the final PR verification comment. Runtime nondeterminism,
single-writer stores, incomplete source evidence, conservative recovery interpretation and unverified Windows/live-write cases
retain the limits in the importer documentation. Parent source provenance remains pinned and clean.

## Merge order

Keep #71 based on #70 until the owner merges #70. Then retarget to `main` and rerun CI against that actual base. If the owner
squash-merges or rebases #70, restack the importer onto the resulting main commit first. Earlier fixture bytes and mapping-2
imports are historical inputs; use fresh validation stores and retain normal changed-history/mapping refusal for old stores.

## Additional fresh-review finding: tool-call pairing

The fresh review of `e2346122e` found that token-filtering a valid tool-call ID such as `call/1` or an ID longer than 128
characters erased the request/result correspondence. Eight initial regressions failed before repair. The mapper now records a
`callIdDigest` for every string ID using HMAC over `["dsh-tool-call-id.v1", rawId]`, on requests, results and optional approval
call references. No raw call ID or raw-ID fallback is retained. The projector pairs validated digest key IDs and values, avoiding
both loss of identity and collisions between a raw token and an encoded/hash-looking token.

Known tool calls and results must carry string IDs before any append, including inherited source rows. Empty strings remain
valid string identities rather than being treated as missing. Regressions cover slash, long, Unicode and empty IDs, malformed or
missing IDs, partial and repeated imports, recovery-written results, and a raw ID resembling another ID's digest. The durable
privacy test now has 16 canaries, including an unsafe call ID. Recovery results still expose no claimed tool outcome or result
digest, even when their call identity pairs correctly.

The final representation is mapping 4 and projection 3; mapping-3 imports are refused instead of keeping their old dropped
pairing keys. Earlier mapping-3/projection-2 results above describe the first repair commit, not the final representation.
The first repair commit passed 4,751 tests with 47 skips and all five CI jobs. Final-head checks and fresh review are reported in
the PR verification comment; the parent reader, fixtures and source provenance remain unchanged.

The focused advisor reviewed the final pairing implementation without concrete blockers and independently passed 120 importer/review/recovery tests. The maker repeated all five private retained-capture imports under mapping 4: privacy/idempotence/source-hash checks passed, real tool-read remained one request paired to one result, and incremental recovery still matched one-shot import. No new model run or active-state access was added.
