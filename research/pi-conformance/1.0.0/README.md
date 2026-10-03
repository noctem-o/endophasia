# Pi 1.0.0 — recorded attachment evidence (verified baseline)

Recorded by `tests/pi-real-runtime.test.ts` (`ENDO_PI_EXECUTABLE=… ENDO_PI_RECORD_DIR=…`) against
`@earendil-works/pi-coding-agent@1.0.0` installed with `npm install -g` into a scratch prefix, on Linux with Node
22.22.0, on 2026-10-03, with adapter `pi-rpc-adapter.2`, mapping `pi-rpc-mapping.1`, suite `pi-rpc-suite.2`.

| File | Content |
| :--- | :--- |
| `fingerprint.json` | the observation (paths are of the recording machine) |
| `evidence.json` | every capability evidence record: local checks, the documented-surface review, the live study |
| `capability-state.json` | the state derived from that evidence |
| `inconclusive.json` | live-study steps that could not be decided (none in this recording) |
| `session-summary.json` | the recorded session: event kinds, counts, the record digest |

The transcripts the evidence cites lived in the recording's scratch artifact store and are not committed.

## What this recording establishes

Each capability in `capability-state.json` was classified by the checks named in its reason, against this one
installation, under this one configuration. Nothing in the recording was left inconclusive, which means every check
reached a decision; it does not mean every capability is supported (three are recorded as UNAVAILABLE and seven as
PARTIAL or QUALIFIED, each with its stated limits).

## What it does not establish

- **Other releases.** Evidence applies to the fingerprint it was recorded against. Any other Pi release, including a
  later 1.0.x, starts unverified and earns its own evidence through the same checks.
- **Real model behaviour.** Pi's provider was a local fake OpenAI-compatible endpoint
  (`tests/fixtures/fake-openai-server.ts`, via an isolated `PI_CODING_AGENT_DIR/models.json`). Model-dependent results
  reflect that endpoint: one thinking level available; the tool call made because the endpoint scripts one; steer and
  follow-up landing mid-run because the endpoint streams slowly. With a real model, those steps can come out
  inconclusive.
- **Switching models.** `control.model` was exercised by re-selecting the configured model only.
- **Other platforms, configurations or projects.** One OS, one Node version, an empty agent directory apart from
  `models.json`, scratch working directories with no project `.pi/` configuration, and no Pi extensions.
- **Long or concurrent sessions, compaction under load, provider retries.** Not exercised.
