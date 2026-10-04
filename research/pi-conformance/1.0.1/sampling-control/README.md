# Pi 1.0.1: sampling control for chat models

A conformance finding, recorded as an `endo.conformance-study.v0` suite (`suite.json`). It answers one question: can
Pi 1.0.1, through its documented surfaces, set the sampling parameters it sends to a chat model?

The answer is "only through an extension". Pi's documented configuration cannot set them.

| Scenario | Classification | In short |
| :--- | :--- | :--- |
| `sampling-fields-sent-by-default` | EXACT | Pi sends no sampling field (no temperature, top_p, top_k, min_p, typical_p, seed or penalties), so the server's defaults apply. |
| `sampling-control-by-configuration` | UNAVAILABLE | No documented `models.json` or `settings.json` field sets chat sampling. The only documented `temperature` belongs to llama.cpp classifier models. |
| `sampling-control-by-extension` | QUALIFIED | A `before_provider_request` extension (Pi's shipped `examples/extensions/provider-payload.ts`, the `onPayload` contract in `docs/custom-provider.md`) made Pi send `temperature: 0` and `seed: 42`. The proxy changed nothing. |

## How it was established (2026-10-04)

- **Default requests.**
  - Every recorded request had exactly the same top-level fields besides `messages` and `tools`: `model`, `stream`,
    `stream_options {include_usage: true}`, `store: false` and `max_completion_tokens: 16384`.
  - The requests checked: the 8 requests of the committed cassette fixtures (`../cassettes/`), the PR E1 smoke run,
    and a print-mode probe.
  - `tests/sampling-control.test.ts` re-checks the committed cassette requests.
- **Configuration.** The documented configuration surfaces were reviewed: `docs/models.md`, `docs/settings.md` and
  `docs/custom-provider.md`. Every installed doc was also searched for `temperature`, `top_p`, `top_k`, `min_p`,
  `seed`, `sampling` and `penalty`. Each doc's sha256 is in the evidence. The opt-in real suite re-checks the digests
  against the installed Pi.
- **Extension.**
  - A scratch Pi ran in print mode through the capture proxy, with and without a five-line extension in its scratch
    agent directory's `extensions/`. The extension handles `before_provider_request` and returns
    `{ ...event.payload, temperature: 0, seed: 42 }`.
  - The evidence includes the canonical-JSON sha256 of both request-parameter objects. Your Pi configuration was never
    touched.

## What it does not establish

- Whether a server honours `temperature` and `seed`. That's the server's property, not Pi's.
- Anything about undocumented settings, which are out of scope by rule.
- Other provider APIs (only `openai-completions` against llama.cpp was observed).
- Other Pi releases.

An extension is code that Pi loads, not a configuration field. A study that changes sampling this way is changing Pi's
behaviour through a documented extension point. The request is still unaltered in flight.
