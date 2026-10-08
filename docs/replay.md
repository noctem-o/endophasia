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

### Connections

The client's connection to the proxy and the proxy's connection to the upstream have separate lifetimes.

- **The client connection is the keep-alive.** It carries as many exchanges as the client sends. The proxy ends it only
  when the response says so (`Connection: close`, an HTTP/1.0 response without keep-alive, or a body framed by the
  close), when the request said so, when the upstream fails, or when the client does.
- **The upstream gets one fresh connection per exchange (a hop).** It is opened when the exchange's request reaches the
  front of the line, carries that one request and its one response, and is closed by the proxy when both are complete.
  An upstream that closes a connection after its response, as llama.cpp does, closes a hop nobody is using: the
  next request opens a new one. This is the RFC 9112 §9.3–9.6 race, removed by construction rather than retried.
  (Before endo-capture.2 the proxy held one upstream connection per client connection, and a request sent as the
  upstream closed it was lost: 2 of the steering study's 622 requests. That result stands as recorded.)
- **Why a request cannot enter an earlier exchange's connection.** The proxy splits the client's bytes at the request
  parser's message ends; every byte after one request's end belongs to the next. A request's bytes are written only to
  the hop its own slot opened, and a slot's hop is closed when its exchange completes, before the next slot starts.
  The slots' bytes concatenate to exactly what the client wrote.
- **Pipelining.** A client may send several requests without waiting. They are forwarded one at a time, in order, each
  after the previous response is complete, and answered in order. Waiting request bytes are held verbatim, at most 4 MiB;
  above that the proxy stops reading the client (TCP backpressure). Pipelined requests therefore reach the upstream later
  than they used to, never earlier or interleaved. If a response ends the connection, the requests behind it are not
  forwarded and are recorded as such.
- **TLS.** Each hop is its own TLS session with the upstream's host name as SNI, so an https upstream pays a handshake per
  exchange.
- **What is never retried.** Nothing. A request's bytes are written to at most one connection, and a failure is never
  hidden by sending them again, because a POST cannot be told apart from a duplicate once it may have reached the
  upstream. An agent's own retry is its own exchange (attempt 2), as before.
- **How a genuine failure is recorded.** `capture.exchange-ended` with `outcome: "upstream-error"` also carries
  `transport: {phase, forwarded}` (endo-capture.2). `phase` is `connect` (the upstream could not be reached),
  `awaiting-response` (it closed or failed before any response byte), `mid-response` (it was cut after response bytes) or
  `not-forwarded` (the request was never sent: the connection ended first). `forwarded` says whether any request byte was
  written to a connected upstream. Analysis reads these fields, not the error text. The old
  "the upstream had closed the connection before this request arrived" error cannot be produced any more; analysis of
  endo-capture.1 recordings (`research/completion-cap/1.0.1/analyze.ts`) still reads it as the transport retry it was.
- **Tunnels.** A `101` response, or a 2xx response to `CONNECT`, ends the exchange at the response head and turns the
  connection into a tunnel on the same hop, both ways, unparsed. Nothing after the head is recorded. A reset on a tunnelled
  (or otherwise unparsed) hop reaches the client as a reset; an orderly upstream end stays orderly. (For ordinary HTTP
  exchanges an upstream error still closes the client with `destroy()`, which the client sees as a FIN.)
- **Streams that are not HTTP.** The proxy decides from the bytes alone, never a clock. The first bytes must be the start of
  a known method (`GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `CONNECT`, `TRACE`); then a token, then a
  valid request line. A stream that cannot be an HTTP/1.x request is relayed untouched on one hop and recorded as
  `capture.unparsed`. Unsupported: a non-HTTP client that sends `TOKEN something` with no newline and then waits for the
  upstream.
- **Early answers.** An upstream that answers before the request has been uploaded is recorded request first. If it then
  stops reading while the client is held back, the exchange is ended after `hopDrainMs` (default 5 s) with no progress.
- **Bytes after a response.** Bytes an upstream sends on a hop after its response is complete belong to no exchange and are
  dropped, not relayed.

### What is recorded

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
    error code, and for `upstream-error` the `transport` classification above).
- `capture.connection-closed`: who ended the client connection, and after which exchange. `upstream` means the proxy ended
  it because of a response's (or the request's own) `Connection: close`, a close-delimited body or an upstream failure;
  `client` means the client did.

**Secrets.** Header names containing authorization, cookie, api-key, token, secret, password, credential or session
are recorded as `{name, redacted: true}`. Their values are stored nowhere. A response head that carries one is kept
with that line removed, and says so (`headScrubbed`). The tests check every file under the store for the Authorization
value.

**Bodies.** Bodies, wire bytes, snapshot archives and prompt text go into a blob store beside the capture log
(`storage/blob-store.ts`), outside canonical evidence. Blobs are addressed by their keyed digest, never by a plain
sha256: a plain hash in a file name would be the same confirmation oracle that keyed argument digests close
([trajectory.md](trajectory.md#argument-digests-and-digest-domains)). Events carry digests and lengths only.

### From the captured request to harness-surface evidence

A captured request body stays a blob. What becomes canonical evidence from it is the effective harness surface
(`endo.harness-surface.v0`, derived on demand by `adapters/openai-proxy/harness-surface.ts`; the experiment runner
embeds it in each trial, [experiments.md](experiments.md#the-effective-harness-surface)). For a recognized
chat-completions request:

| part of the request | in canonical evidence | in the blob only |
| :--- | :--- | :--- |
| `model`, `stream` | the values, as separate observed fields | |
| `system` / `developer` messages | keyed digest, length, role and position, in wire order | the text |
| `tools` | keyed digest per definition (and a plain name), ordered and membership digests | the definitions |
| every other top-level field | the value when short, else a keyed digest; absent stays absent | |
| `user`, `assistant` and `tool` messages | nothing: task input is not harness surface | the text |

The recorder is unchanged: it still relays bytes unmodified and records off the byte path, the request digest and the
cassette matching are what they were, and the capture version stays `endo-capture.2` (nothing the proxy writes
changed). The surface is a reading of the log, never written back into it. A request that is not a recognized
chat-completions request is UNAVAILABLE with a reason.

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

**Classified misses.** An `unexpected-request` miss also records where the replayed request first differs from the
recorded one (`divergence`):
- **`environment`:** the first differing message is a tool result. What a tool observed changed: its output. The
  model's replies and Pi's control flow were identical up to that point.
- **`control-flow`:** anything else differs first: an assistant, user or system message, or another request field.

`endo replay` reports the first miss as "environment diverged at <exchange>" or "control flow diverged at
<exchange>", and lists every miss with its classification.

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
`work/` (the workspace). The whole root is snapshotted before Pi starts (`storage/workspace-snapshot.ts`,
`endo.workspace-archive.v1`): every file's content, every entry's kind, and every entry's modification time, including
the root's. The snapshot is recorded as `capture.workspace-snapshot`.

**File times are restored, as state.** A tool such as `ls -la` prints modification times. A replay that restored the
files with fresh times would show the tool a different workspace, so a v1 snapshot restores the recorded times:
files and links first, then directories deepest first, then the root. Older `v0` snapshots carry no times and restore
with fresh ones.

**A pinned environment** (an experiment condition's `environment`, [experiments.md](experiments.md)) is applied
before the snapshot: its files under `<root>/env/`, then its fixed time on every entry. It is recorded as
`capture.environment`: the variables as Pi saw them, the file time, and each file's sha256 and length. A replay
reapplies the recorded variables to Pi's session environment. The files and times come back with the snapshot. A
recording without `capture.environment` replays with none.

**Interventions** (`prompt-intervene`, [steering.md](steering.md)) are replayed like STOP. A recording with an
intervention is driver version `pi-cassette-driver.2` (every other stays `.1`, so existing cassettes are unchanged), and
the replayer accepts both. The replay arms the pause at the recorded delivery point before the prompt. It then
re-issues the intervention through an intervention desk on the replay's store, with the same session and nonce, so the
same proposal digest, and only then resumes the cassette. A `steer` or `follow_up` is acknowledged by Pi at once, so
it is awaited before the cassette resumes; Pi answers an `abort` only once idle, so a STOP is sent, the cassette
resumed, and the answer awaited. The report lists each intervention re-issued: its operation, recorded and re-issued
points, whether its digest matches the recording's, and what the desk answered. **A replayer meeting a driver step it
does not know refuses**, rather than skipping it and showing a confusing cassette miss.

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

**What EXACT shows.** EXACT on lifecycle, tool calls, tool results and outcome means this: with the model's responses byte-identical and
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
  See [the wall-clock limit](#the-wall-clock-limit).
- **Behaviour on another machine, Pi release or configuration.** A replay binds the recorded path and port and needs
  the same digest domain. Differences in Pi's fingerprint or configuration are flagged by the comparison.
- **Usage and timing.** They are reported as deltas and never judged ([trajectory.md](trajectory.md)). Under a
  cassette, Pi's reported usage is the recorded usage, because it comes from the replayed response. Timing reflects
  the chosen timing mode.

## The wall-clock limit

**A replay never fakes time.** The clock, durations and anything else a tool measures while it runs belong to the
replay's own run, not the recording's.

**What is restored:** the workspace's state, file times included. **What is not:** time itself. A tool that prints a
time it reads while running (`node --test` durations, `date`, a log timestamp), or a time Pi or the tool writes
during the session, gives different output on replay. That output enters the next request, and the cassette
correctly refuses a request it does not hold: an explicit `unexpected-request` miss, classified `environment`.

Observed in the variance study (`research/variance/1.0.1/RESULTS.md`): replays of coding-task trials missed at the
second request. `ls -la` printed the restore time (the snapshot then kept no times), and `node --test` printed new
durations. File times are now restored; durations cannot be.

A session whose tools print wall-clock values can be replayed only up to the first such output. Holding those values
fixed is the experiment's job: a pinned environment, such as a test reporter without durations, as a declared
condition.

## Tool-result digests (pi-rpc-mapping.4)

Pi documents `tool_execution_end` with `result` (`docs/json.md`), so result digests are recorded rather than marked
UNAVAILABLE. `tool.finished` records `resultDigest`: the keyed digest of `result.content`, the content the model is
given. `result.details` is tool-specific and not sent to the model (`docs/message-types.md`), so it is not digested.

The trajectory's tool results carry `resultDigest` (its own `toolResults` layer since `pi-trajectory.3`). Result digests
compare by the same domain rule as argument digests (`trajectory-comparison.3`). A recording made before mapping.4 has none, which makes its tool
entries UNAVAILABLE, never EXACT.
