# Governed Pi initial-child acceptance and A/A feasibility pilot

On one machine, a Pi 1.0.4 source recording and four separately approved fresh initial-child turns used Nanbeige4.3-33B through a local llama.cpp OpenAI-compatible endpoint. These observations concern the source-tree checkpoint and initial-child execution APIs, not a published package or a general process fork. The private captures, receipts and installation digest key are not published; this note cannot independently reproduce the results from repository contents alone.

## Source and replay

The source was a single tool-free turn. Its offline cassette replay served one request with no misses or unserved exchanges; lifecycle, tool calls, tool results and outcome compared EXACT. Usage and timing had deltas. The checkpoint candidate independently qualified from the source and replay stores. The durable receipt for a separately approved baseline child independently verified against the parent, prepared siblings and recorded execution evidence.

The captured source and baseline-child requests were not byte-identical. Both were `POST /v1/chat/completions`, named `nanbeige4.3-33b`, and carried the same user message and explicit parameters. They had no tool definitions or developer message. The system-message difference was the recorded working directory in Pi's `<cwd>` section. A separate read-only diagnostic replaced only the uniquely occurring, independently verified cwd value in that field; the resulting request-body bytes matched. This is **cwd-adjusted diagnostic equality**, not exact wire equality. Captured proxy host and content-length headers differed; authorization values were redacted.

## Four-request A/A pilot

The pilot's plan was recorded before execution. Two independently prepared sibling pairs had the same supported configuration (`thinkingLevel: off`) and no other condition manipulation. Pair labels distinguished identities, not treatments. Four fresh, tool-free single-turn attempts were run sequentially in randomized pair blocks, with a fixed synthetic prompt requesting the word `ready`. Each exact preflight commitment received separate local approval. Each attempt was bounded to one completion request, 120 seconds and 10 MiB total transfer; the guard also limited request and response size. A separately tested guard refused excess requests before forwarding. Synthetic fake-Pi and fake-endpoint tests exercised the guard, approval wiring, receipts and response analysis before live dispatch.

All four attempts completed. Each guard recorded one forwarded request and no violation; each captured a complete HTTP 200 response and independently verified durable execution receipt. No tool calls or results were observed. The source checkpoint remained qualified and both sibling pairs verified pristine after execution. One unused preflight was replaced and separately approved because its guard process did not persist while awaiting approval; no completion was sent under that discarded preflight.

| Trial in execution order | Prompt tokens | Completion tokens | Reported cached tokens | Last response-chunk offset (seconds) | Final answer |
| :--- | ---: | ---: | ---: | ---: | :--- |
| Pair 1 baseline | 597 | 16 | 521 | 1.68 | `ready` |
| Pair 1 alternative | 600 | 19 | 536 | 2.00 | `ready` |
| Pair 2 baseline | 599 | 18 | 536 | 1.88 | `ready` |
| Pair 2 alternative | 600 | 27 | 536 | 2.72 | `ready` |

The offset is measured from captured request arrival to the last response chunk, not full execution wall time. Cached-token counts are server reports, not evidence of cache contents or how the cache affected an answer.

All six raw request-body pairs differed. Each request had one verified cwd in its system message; after adjusting only that field, all six body-byte comparisons matched. All explicit top-level parameters matched: `model: nanbeige4.3-33b`, `stream: true`, `stream_options.include_usage: true`, `store: false` and `max_completion_tokens: 16384`. Tool definitions, tool choice, temperature and seed were absent. Their absence does not establish server defaults. The captured proxy host headers differed; authorization was redacted and unavailable.

All four exact final-answer text strings were `ready`, satisfying the prespecified case-sensitive check. The complete captured response wires differed pairwise, as did the separately captured model-returned reasoning field. Neither the private reasoning text nor the request and response captures are published here. Wire differences can include framing and metadata as well as content.

## Interpretation and evidence limits

The observed workflow succeeded four times and the final-answer text agreed in these four cases. It does not establish exact wire-request equality, model determinism, path causality, treatment effects, population-level reproducibility or general process-fork capability. The path was an observed consequence of isolated runtimes, not a randomized causal intervention. The server's omitted-parameter defaults, model weights, GPU state and cache contents were not verified. Four observations warrant descriptive reporting, not significance claims.

The private evidence was re-read using the installation digest key and the existing receipt and checkpoint verifiers. The qualified checkpoint covers an initial workspace and evidence boundary, not a restored historical Pi process or a complete external-environment snapshot. The verifier and the private captures provide the evidence for this local acceptance; the captures, raw paths, transcripts and key are deliberately excluded from the repository.
