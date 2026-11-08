# Protected model access (EVAL-ISO-002)

**Status:** the mechanism is implemented and verified on this host, with real Pi 1.5.0 and a real local model. The pieces are the relay,
the bridge, the socket mount, resource limits, and a research driver with independent verification. It is **not** wired into
`endo experiment protected-run`. That integration (a spec field and a trial record version) is an owner decision (§7).

It builds on EVAL-ISO-001 ([protected-experiments.md](protected-experiments.md)), whose §10 sketched it. Everything there still holds:
- an empty root;
- every namespace new;
- no network but `lo`;
- the preflight probes;
- a systemd scope per sandbox;
- termination confirmed by an empty cgroup.

## 1. The boundary

```
sandbox (own network namespace: lo only)                          host
  Pi ──HTTP──▶ 127.0.0.1:18080 ──▶ bridge ──▶ /run/endo/model.sock ═╪═▶ relay socket (private dir 0700, socket 0600)
                                                                    │      │ every byte, both ways
                                                                    │      ▼
                                                                    │   recording proxy, governed admission (127.0.0.1:ephemeral)
                                                                    │      │ only what the judge admits; recorded into a capture log
                                                                    │      ▼
                                                                    │   model server (llama.cpp router at 127.0.0.1:8081)
```

- **One socket is the only way out.** The sandbox's network namespace still holds only `lo`, so host loopback, the LAN and the internet
  stay unreachable (§4). The relay's socket is bind-mounted alone, never its directory, under a new mount kind `socket`. A profile with
  one says `network: "model-relay"`. The profile builder refuses a `socket` mount whose source is not a socket, or whose role is not
  `model-relay`.
- **The policy is enforced on the host, not in the sandbox.** The bridge is about 20 lines of trusted code that the controller writes
  and mounts read-only by digest. It only makes the socket reachable over TCP, because Pi speaks HTTP to a base URL. It enforces nothing:
  an agent that kills or bypasses it can still reach only the same socket.
- **The relay reuses the recording proxy unchanged in its governed profile** (`adapters/openai-proxy/record.ts`, already used by the
  initial-continuation studies):
  - a complete request is buffered and judged **before any upstream connection is opened**;
  - a refusal closes the client's connection, and the model server is never contacted.
  
  The judge is `admitModelRequestV0` (`adapters/sandbox/model-relay.ts`).

## 2. The policy

| Rule | Enforced by | Default for Pi |
| :-- | :-- | :-- |
| **Routes:** method and exact path, with no prefix match, no query string, and no CONNECT | the judge | `POST /v1/chat/completions` only (`ENDO_PI_MODEL_ROUTES_V0`) |
| **Model:** the JSON body's `model` must equal the declared one, so the agent cannot select another, or make a router load one | the judge | the trial's model |
| **Body:** a JSON object | the judge | |
| **Request size** | the judge; the governed proxy's own 1 MiB bound | 1 MiB |
| **A declared body length** (no chunked framing, no `Expect`, no `Upgrade`) | the governed proxy, before the judge (`unjudged`) | GET, DELETE, CONNECT and anything unparseable are refused |
| **Bytes through the relay**, both ways, for the session | the proxy's `maxTransferredBytes` | 256 MiB in the driver |
| **Connections open at once** | the relay's socket server | 8 |

**The route list was measured, not guessed.** Real Pi 1.5.0 was run inside the sandbox, against a fake model server that logs every
request, through a scripted tool run. It made only `POST /v1/chat/completions`. No `GET /v1/models` and no health check were seen (§4).

**Refused, among others:**
- llama.cpp's administration endpoints (`/models/load`, `/models/unload`, `/slots`, `/props`, `/metrics`, `/health`, `/tokenize`);
- `GET /v1/models`;
- `/v1/completions`;
- path tricks (`//v1/…`, `/v1/../…`, a trailing slash, a query string);
- another model;
- a non-object body;
- an oversized body;
- a raw CONNECT;
- a byte stream that is not HTTP (starting like a TLS record).

The policy's identity is the sha256 of its canonical JSON, independent of route order (`modelRelayPolicyDigestV0`).

## 3. What else changed, and why

| Change | Where | Why |
| :-- | :-- | :-- |
| **Governed rejections no longer consume an exchange number**, and neither does a governed upload that never completes (numbered when complete; Codex) | `adapters/openai-proxy/record.ts` | **Found by this work.** A bodiless request refused by the governed profile, such as an agent's `GET /slots`, was recorded as `capture.unparsed` with no exchange, but its number was taken. The cassette loader requires contiguous exchanges, so one refused GET made the **whole recording unreadable as a cassette**. Now a head is numbered only once it is an exchange. Readers are unaffected, and the ungoverned proxy is unchanged. The regression test is the relay's own recording test. Moving the increment back makes it fail. |
| **Resource limits on a sandbox's scope** (optional) | `adapters/sandbox/containment.ts`, `runSandboxV0` | `MemoryMax` with `MemorySwapMax=0`, and `CPUQuota`, are set on the scope, so the kernel enforces them on the whole cgroup. A limited scope is not `--collect`ed, so a failure's result (`oom-kill`) can be read before the unit is reset. Without limits, nothing changes: EVAL-ISO-001's arguments are identical. |
| **The `socket` mount kind and `network: "model-relay"`** | `adapters/sandbox/bubblewrap.ts` | Described in §1. `endo.protected-trial.v0`'s writer refuses any network other than `none`, so an offline record can never describe a relay sandbox. |

## 4. Evidence (this host: Arch, systemd 262, bubblewrap 0.13.1, Node 26.12.1, Pi 1.5.0; 2026-11-08)

**`tests/protected-model-relay.test.ts`: 33 passed, 1 skipped** (the real-model case, opt-in), with `ENDO_PI_DIST` set.

- **The judge:** 19 refused routes; another model, a missing model, non-object bodies, an oversized body; policy validation; the digest.
- **The host side:**
  - the admitted request is forwarded and recorded;
  - six refused requests never reach the model server, which logs exactly one request;
  - the recording loads as a cassette, which before the numbering fix it did not;
  - a raw CONNECT, a non-HTTP stream and an oversized request are refused;
  - the connection bound holds;
  - the directory is 0700 and the socket 0600, and both are removed on close;
  - altered blobs do not verify.
- **Real isolation:** a probe inside a relay sandbox observed:

  | Probe | Observed |
  | :-- | :-- |
  | `POST /v1/chat/completions` (declared model) | `status 200` |
  | Another model; `GET /slots`; `POST /models/load`; `GET /v1/models` | connection closed (ECONNRESET), each |
  | The model server's own loopback port | `ECONNREFUSED` |
  | 192.0.2.1:80 | `ENETUNREACH` |
  | Network interfaces | `lo` |

  Termination was confirmed, and the model server saw only the one admitted request. A memory hog in a sandbox limited to 128 MiB was
  killed by the kernel, the scope's result was `oom-kill`, and termination was confirmed. The same profile without limits is unchanged.
- **Real Pi 1.5.0 inside the sandbox**, with a fake model server and a scripted bash tool call:
  - the tool ran inside and wrote `/work`;
  - all of Pi's requests were `POST /v1/chat/completions`, all admitted, all recorded, none refused;
  - termination was confirmed.
- **Real Pi and a real local model** (Muse Glimmer 30B on the llama.cpp router, opt-in):
  - the test's one prompt answered `ready` in 4.2 seconds, with one exchange, complete;
  - a research trial (`research/protected-eval/model-connected/trial.ts`) asked Pi to create `hello.txt`. The model did, in **10 exchanges**,
    every one admitted, recorded and verified, with no refusals. Exit 0, termination confirmed, limits 2 GiB and 400% CPU.
  - Four of its nine tool calls asked for commands the minimal runtime does not hold (`hexdump`, `od`, `python3`, `wc`; exit 127). **The
    runtime set is part of a trial's condition** and visibly shapes the agent's behaviour. A study must declare it and keep it fixed.
  - The trial's directory is under `~/projects/endophasia-research/eval-iso-002/`, outside the repository.
- **Independent verification:** `trial.ts verify <dir>` reads the trial again in a new process. It runs 18 checks, four rounds of Codex
  review having added to the first 14:
  - the record's seal;
  - the policy's digest, computed independently of the locale. The relay judges by a frozen copy of the policy taken at start, so a
    caller changing its own object afterwards changes neither admission nor the digest;
  - the boundary and termination;
  - **the recording is complete**: no capture write failed, and every exchange has its response, complete and verified;
  - the bytes through the relay are within the policy's bound;
  - the cassette loads, matches the record exchange by exchange (route, request digest, integrity), and verifies;
  - every recorded request is within the policy, **body included**: route, model, size, a JSON object, no repeated top-level key;
  - no more complete exchanges than admitted requests, and **at least one** complete, admitted model exchange: over an empty cassette
    every other check would hold vacuously;
  - stdout and stderr digests;
  - the workspace digest, which must exist: a workspace with no digest fails instead of matching a null;
  - the runtime files on this host still match the recorded ones;
  - the installed Pi is unchanged.

  A second real trial (`trial-20261108-215630`: the same task, Glimmer, 8 exchanges) passes all 18. The first trial (`…-195634`) passes
  every check except `recording-complete`, which it fails as **unknown**: its record predates the recording-failure count. That is the
  intended reading of a missing field.

  An opt-in test runs a fake-model trial, then tampers with it. Each change fails its own check, and the seal stays valid wherever the
  record was resealed:
  - an edited record fails `seal` and `termination`;
  - appended stdout fails `stdout-digest`;
  - a file planted in the workspace fails `workspace-digest`;
  - damaged blobs fail `cassette-matches-record`;
  - a failed capture write fails `recording-complete`;
  - a changed runtime digest fails `runtime-unchanged`;
  - a transfer over the cap fails `transfer-within-policy`;
  - a workspace with no digest fails `workspace-digest`.
- **Mutations**, each restored afterwards; each made the suite fail:

  | Mutation | Tests failed |
  | :-- | :-- |
  | Any route admitted | 20 |
  | Model not pinned | 3 |
  | The connection bound counts both sockets of a connection (a bug the test caught during development) | 1 |
  | Exchange numbering moved back before the governed check | 1 |
  | Any file accepted as a `socket` mount | 1 |
  | Limits dropped from the scope | 1 |
  | (review fixes) Each of Codex's ten findings on this PR, reverted one at a time | 1 each |

## 5. Threat model: what this does and does not stop

**Stops (shown above):**
- the agent reaching any network destination other than the relay;
- the agent reaching the model server's administration, model loading or other routes;
- the agent selecting another model;
- unbounded requests or connections;
- runaway memory or CPU;
- processes outliving the trial;
- a recording an agent can make unreadable with a refused request.

**Does not stop:**
- **What the model is asked.** Any prompt is admitted, within the size bound. The relay controls access to the model, not the content
  of requests.
- **Resource use on the model server.** One admitted request can still ask for a long generation (`max_tokens`). The relay does not
  rewrite or cap request fields. Capping `max_tokens` would mean altering requests, which the recording proxy deliberately never does.
- **Timing side channels** through the shared model server, and the model server's own vulnerabilities, reachable through the one
  admitted route.
- Everything EVAL-ISO-001 §8 lists: kernel exploits, a hostile host account, no seccomp filter.

## 6. Limitations

- **Linux** with bubblewrap, unprivileged user namespaces and a systemd user manager, as for EVAL-ISO-001.
- **Pi's runtime closure is assembled by hand** in the driver: node, bash (also mounted at `/usr/bin/sh`), `cat`, `head`, `ls`, `grep`,
  and Pi's `dist` tree.
  - The bundle needs nothing from `node_modules`; that was checked by running it.
  - The `dist` tree is 22 MB, holds no links, and is digested (`endoTreeDigestV0`).
  - Pi locks and writes its agent directory, so it gets a per-attempt writable copy, which then keeps Pi's state as evidence.
- **One route.** A Pi configuration that uses another API (Anthropic messages, Responses) needs its routes measured and declared.
- **`max_tokens` and other request fields are not policed** (§5).
- **The `scope.result` of a limited sandbox** is known only when the scope failed. systemd unloads one that ended cleanly, so `null`
  also means success.
- **The record is a research record** (`endo.model-connected-trial.v0`, `provisional: true`), sealed with a plain sha256. The digests
  detect accidents, not a forger with the host account (EVAL-ISO-001 §8).
- **Replay.** The recording is a cassette, so it can be served without the model (`adapters/openai-proxy/cassette.ts`). Replaying a Pi
  run from it is a separate question, with its own fidelity limits: see the counterfactual replay research (Phase 5 of this assignment).

## 7. Decisions deferred to the owner

1. **Integration into `endo experiment protected-run`:**
   - a spec field naming the model access (upstream, model, routes, limits);
   - a new trial record version (`endo.protected-trial.v1`) carrying the relay's policy digest, the cassette summary and the limits;
   - the reader's consistency rules (for example, `admitted` at least the complete exchanges).
   
   `endo.protected-trial.v0` refuses any relay, and stays as it is.
2. **Default limits** (memory, CPU, transferred bytes, `max_tokens`), and whether a trial may set its own.
3. **Whether to cap or rewrite request fields** at the relay. That would be a departure from byte-for-byte recording.
4. **Whether `GET /v1/models` (or other read-only routes) should be admitted** for harnesses that probe before use. Pi 1.5.0 does not.
5. **The runtime set** for model-connected trials: a fixed, declared tool set per study (the trial above shows that it matters).
6. **Running the real-model tests anywhere but an operator's workstation.**

## 8. Reproduce

```sh
npx vitest --run tests/protected-model-relay.test.ts                                     # judge, host side, real isolation
ENDO_PI_DIST=/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist \
  npx vitest --run tests/protected-model-relay.test.ts                                   # + real Pi (fake model), verification
ENDO_PI_DIST=… ENDO_MODEL_ENDPOINT=http://127.0.0.1:8081 ENDO_MODEL_ID=<loaded model> \
  npx vitest --run tests/protected-model-relay.test.ts -t "REAL local model"             # + a real local model
node research/protected-eval/model-connected/trial.ts run --out <new dir> --pi-dist <dist> \
  --upstream http://127.0.0.1:8081 --model <id> --prompt "<task>"
node research/protected-eval/model-connected/trial.ts verify <dir> --pi-dist <dist>
```
