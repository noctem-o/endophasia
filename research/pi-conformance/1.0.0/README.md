# Pi 1.0.0 — recorded attachment evidence

Recorded by `tests/pi-real-runtime.test.ts` (`ENDO_PI_EXECUTABLE=… ENDO_PI_RECORD_DIR=…`) against
`@earendil-works/pi-coding-agent@1.0.0` installed with `npm install -g` into a scratch prefix, on Linux with Node
22.22.0, on 2026-10-03.

- Pi's model provider was the local fake OpenAI-compatible endpoint (`tests/fixtures/fake-openai-server.ts`) through an
  isolated `PI_CODING_AGENT_DIR/models.json`; no real model was called. Results that depend on the model (e.g. only one
  thinking level available, the model choosing to call the read tool) reflect that endpoint.
- `fingerprint.json` — the observation (paths are of the recording machine).
- `evidence.json` — every capability evidence record (local checks, static surface, live study).
- `capability-state.json` — the state derived from that evidence.
- `inconclusive.json` — live-study steps that could not be decided (none in this recording).
- `session-summary.json` — the recorded session: event kinds, counts, the record digest.

The transcripts the evidence cites lived in the recording's scratch artifact store and are not committed.
