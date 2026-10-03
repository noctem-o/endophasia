# Capture and cassette replay

Cassette replay holds the model's outputs fixed and asks one question: given exactly the same model responses, does
Pi's control flow reproduce? "Reproduce" is judged layer by layer by the trajectory comparison
([trajectory.md](trajectory.md)).

A recording has three parts:

1. A recording proxy between Pi and the model endpoint captures every HTTP exchange.
2. The session's scratch root is snapshotted before Pi starts.
3. The session driver records each step it takes.

A replay restores the snapshot, serves the captured responses from a cassette, drives a fresh Pi through the same
steps, records into a new store and compares that store with the original.

```sh
endo proxy record --upstream http://127.0.0.1:8080 --store <root> [--port n] [--fixture]
endo proxy replay --store <root> --timing <as-recorded|immediate> --out <root> [--port n] [--fixture]
endo replay <store> <session> --pi "$(command -v pi)" --timing <as-recorded|immediate> [--out <root>] [--fixture]
```

`endo replay` prints one `endo.replay-report.v0` document: per-layer verdicts, cassette counters (served, misses,
unserved), flags, the driver's notes and the full comparison.

## The recording proxy

`endo proxy record` (`adapters/openai-proxy/record.ts`) is a TCP relay. It binds only a loopback IP literal: `0.0.0.0`,
`::`, LAN addresses and even `localhost` are refused. Pi reaches it through its normal provider configuration
(`models.json` `baseUrl`), and it forwards to the upstream origin.

**It never alters a byte.** What the client writes reaches the upstream as read, and what the upstream writes reaches
the client as read, in both directions, transfer framing included. A copy of each direction is parsed
(`adapters/openai-proxy/http1.ts`) only to delimit exchanges. Nothing is re-serialized.
`tests/capture-proxy.test.ts` writes hand-made bytes on raw sockets at both ends and compares them byte for byte. That
test exists because the first, Node-HTTP-based design added a `Connection` header that the client had not sent.

Per exchange, the capture log (`<store>/capture/`, an Endophasia event store) records:

- `capture.request`:
  - method and path;
  - the **request digest** a cassette matches by: the keyed digest of the canonical JSON of `{method, path, body}`,
    with the parsed JSON body, so key order and whitespace do not matter;
  - the body's keyed digest and length;
  - the headers, with secret values dropped;
  - the attempt number. An identical request seen again is attempt 2: a client retry is its own exchange.
- `capture.response`: the status and headers.
- `capture.exchange-ended`:
  - every read of the response from the upstream (a **chunk**), with its offset from the request's arrival;
  - the wire bytes' keyed digest and length;
  - how it ended: `complete`, `client-disconnected` (with the chunks relayed by then) or `upstream-error` (with the
    error code).
- `capture.connection-closed`: who closed the connection, and after which exchange.

**Secrets.** Header names containing authorization, cookie, api-key, token, secret, password, credential or session
are recorded as `{name, redacted: true}`. Their values are stored nowhere. A response head that carries one is kept
with that line removed, and says so (`headScrubbed`). The tests check every file under the store for the Authorization
value.

**Bodies.** Bodies, wire bytes, snapshot archives and prompt text go into a blob store beside the capture log
(`storage/blob-store.ts`), outside canonical evidence. Blobs are addressed by their keyed digest, never by a plain
sha256: a plain hash in a file name would be the same confirmation oracle that keyed argument digests close
([trajectory.md](trajectory.md#argument-digests-and-digest-domains)). Events carry digests and lengths only.

## The cassette server

`endo proxy replay` (`adapters/openai-proxy/cassette.ts`) answers in recorded order. The n-th request must carry the
request digest of the cassette's next exchange. It is then answered with that exchange's recorded wire bytes, written
with the recorded chunk boundaries. There is no search and no fallback.

**Misses.** A mismatch is a `capture.cassette-miss` event plus a failed request: HTTP 599 with `x-endo-cassette: miss`,
then the connection closes. A response is never improvised. The miss reasons are:

| Reason | Meaning |
| :--- | :--- |
| `unexpected-request` | The request is not the next recorded one. The position does not advance. |
| `cassette-exhausted` | Every recorded exchange was already served. |
| `truncated-exchange` | The recording never completed this exchange: no end, a missing or tampered blob, or chunks that do not add up. |
| `response-exhausted` | The recorded client disconnected mid-response. This client had not disconnected when the recorded chunks ran out: the connection is cut, nothing is added. |

**Endings follow the recording.** Recorded 429 and 500 responses are served as recorded. A recorded upstream drop is
replayed as a drop at the same chunk.

**Timing is chosen explicitly and recorded in `capture.started`:**

- `as-recorded` waits until each chunk's recorded offset.
- `immediate` writes each chunk as soon as the previous one is written.

**Digest domains.** A cassette's request digests and blobs are keyed, so the server must hold the same key. A cassette
from another digest domain is refused before anything is served, with the reason ("different digest domains"). It is
never matched and then silently missed.

## The session driver

`cli/cassette-session.ts` records a scripted session through the proxy and replays it. A scenario is a list of steps:

- `prompt`: prompt, and wait for `agent_settled`.
- `prompt-stop`: prompt; once the proxy has relayed N response chunks, STOP.
- `prompt-kill`: prompt from a child process; once the proxy has relayed N chunks, SIGKILL the child. Pi ends with its
  process group. Then reopen the same store and session.

**Recording.** The driver records each step in the capture log under the producer `capture:driver`: opens, prompts
(the text goes to the blob store), the STOP or kill point and closes. The STOP or kill point is recorded as the proxy's
delivery count at that instant: `{exchange, chunks}`.

**The scratch root.** Pi runs with a scratch root holding `home/`, `agent/` (`models.json` naming only the proxy) and
`work/` (the workspace). The whole root is snapshotted before Pi starts (`storage/workspace-snapshot.ts`, a
deterministic `endo.workspace-archive.v0`). The snapshot is recorded as `capture.workspace-snapshot`.

**A replay keeps the recording's environment:**

- **Same path.** The scratch root is restored at the same absolute path, which must not exist. Pi's requests carry the
  working directory, and recorded tool calls may name absolute paths. A replay elsewhere would not match the cassette,
  and its tools would not touch the same files.
- **Same port.** The cassette server binds the port the proxy listened on. Pi's `models.json` names that port, and
  Pi's configuration digest covers `models.json`. So the capability evidence recorded with the session (which admits
  `steering.stop`) still applies. That evidence is copied into the new store.
- **Same session id.** The new store asks Pi for the recorded session id.
- **STOP and kill at the recorded chunk.** The server pauses after exactly the recorded number of chunks of the
  recorded exchange. The driver issues the STOP or the SIGKILL, and serving resumes. The pause point is armed before the
  prompt is sent, so even `immediate` timing cannot run past it.

**Endpoints with an API key are not supported.** The snapshot includes `models.json`, so a cassette recording of an
endpoint that needs a key would capture the key. The scratch `models.json` uses the placeholder key `local`.

## What a replay establishes, and what it does not

**What EXACT shows.** EXACT on lifecycle, tools and outcome means this: with the model's responses byte-identical and
the steps, the snapshot and the STOP or kill points the same, Pi produced the same lifecycle, the same tool calls
(names, keyed argument digests, statuses, keyed result digests) and the same outcomes. Zero misses means Pi sent
exactly the recorded requests, in order.

**What it does not establish:**

- **Anything about the model.** Its outputs are held fixed. A replay says nothing about the model's determinism,
  quality or variance.
- **Tool effects outside the workspace.** Only the scratch root is snapshotted and restored. A tool that reads or
  writes elsewhere (other files, the network, the clock, the environment, other processes) is neither captured nor
  reset. Its effects can make a replay diverge, or match by coincidence.
- **That nondeterministic tools are deterministic.** A tool whose output depends on time, randomness, process ids or
  machine state can make a result digest and the next request differ. That shows up as a tools divergence or a
  cassette miss, and it is reported, not hidden. The committed tool-use scenario runs `wc -l`, which is deterministic
  on the restored file.
- **Behaviour on another machine, Pi release or configuration.** A replay binds the recorded path and port and needs
  the same digest domain. Differences in Pi's fingerprint or configuration are flagged by the comparison.
- **Usage and timing.** They are reported as deltas and never judged ([trajectory.md](trajectory.md)). Under a
  cassette, Pi's reported usage is the recorded usage, because it comes from the replayed response. Timing reflects
  the chosen timing mode.

## Tool-result digests (pi-rpc-mapping.4)

Pi documents `tool_execution_end` with `result` (`docs/json.md`), so result digests are recorded rather than marked
UNAVAILABLE. `tool.finished` records `resultDigest`: the keyed digest of `result.content`, the content the model is
given. `result.details` is tool-specific and not sent to the model (`docs/message-types.md`), so it is not digested.

The trajectory's tool entries carry `resultDigest` (`pi-trajectory.2`). Result digests compare by the same domain rule
as argument digests (`trajectory-comparison.2`). A recording made before mapping.4 has none, which makes its tool
entries UNAVAILABLE, never EXACT.
