# Protected model access (EVAL-ISO-002)

**Status:** the mechanism is implemented and verified on this host, with real Pi 1.5.0 and a real local model. The pieces are the relay,
the bridge, the socket mount, resource limits, and a research driver with independent verification.

*Later (2026-11-09, EVAL-ISO-003):* it is wired into `endo experiment protected-run` as an explicit, versioned route: a version 1 spec
declares the model access, each attempt gets its own relay, and each trial is an `endo.protected-trial.v1` record that the report checks
against the recording itself (§9). The research driver below stays a research driver.

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
  When a signal ends the command it runs, the bridge exits as a shell would (128 + the signal's number), so the record keeps which
  signal ended Pi.
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
| **Connections over the relay's life**, including ones that send nothing (each is still recorded) | the relay's socket server | 1024 in the driver |
| **Exchanges admitted over the relay's life**, on one kept-alive connection too (each writes several durable events and its bodies, so many small requests could grow the host's log far past the bytes on the wire); the verifier refuses any recorded exchange past it | the judge, before the policy's other rules | 512 in the driver |

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
- **The trial directory and the workspace's starting state** (Codex, #136):
  - the trial directory is made by one non-recursive mkdir when it is used, then checked to be a real directory of this user's, and set
    to exactly 0700. A name taken meanwhile (another user's directory, a link) is refused, never adopted. Its missing parents are made
    one at a time and each set to 0700, and so are the trial's own subdirectories. A umask that
    removes the owner's own bits (0177) is refused before anything is made: Pi, in the sandbox, inherits it, so such a trial could only
    fail part way. The umask is part of the trial's condition, because the workspace digest
    includes file modes (and `ls -l` shows them): a trial runs under `--umask` when given, else the caller's, records it as
    `agent.umask`, and restores the caller's afterwards. A repeat holds its source's;
  - the workspace root's time is set to 2000-01-01T00:00:00Z before Pi starts, and recorded (`workspace.initialRootMtimeS`): the agent
    sees it (`ls -la`), and a clock time would make identical runs differ. **One difference remains:** the sandbox's own root (`..` from
    `/work`) is made by bubblewrap at each run and shows that run's setup time. Measured: two runs a minute apart printed the same `.`
    and different `..` lines. Removing it would mean changing the sandbox's root, which this change does not do.
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
  *Later (EVAL-ISO-003):* a policy may now carry a generation bound, and a version 1 spec must: a request that does not state one within
  it is **refused**, still never rewritten (§9.6). The research driver's policy has none, and is unchanged.
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
- **`max_tokens` and other request fields are not policed** (§5) by the research driver. A version 1 protected run polices the
  generation bound (§9.6); other fields (sampling settings, tools, prompts) are recorded, not policed.
- **The `scope.result` of a limited sandbox** is known only when the scope failed. systemd unloads one that ended cleanly, so `null`
  also means success.
- **The record is a research record** (`endo.model-connected-trial.v0`, `provisional: true`), sealed with a plain sha256. The digests
  detect accidents, not a forger with the host account (EVAL-ISO-001 §8).
- **Replay.** The recording is a cassette, so it can be served without the model (`adapters/openai-proxy/cassette.ts`). Replaying a Pi
  run from it is a separate question, with its own fidelity limits: see the counterfactual replay research (Phase 5 of this assignment).

## 7. Decisions deferred to the owner

*Later (2026-11-09):* taken in EVAL-ISO-003, as §9.9 records. The list as written:

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

# EVAL-ISO-003 (§9)
npx vitest --run tests/protected-model-records.test.ts tests/protected-model-run.test.ts  # v1 spec, record, reader; real runs
ENDO_PI_DIST=… npx vitest --run tests/protected-model-run.test.ts                        # + real Pi through protected-run (fake model)
node research/protected-eval/model-connected/pi-condition.ts --pi-dist <dist> --agent-out <new dir> \
  --model <loaded model> > spec.json                                                     # a Pi condition against a local model
endo experiment protected-run spec.json --out <new dir> && endo experiment protected-report <dir>
```

## 9. EVAL-ISO-003: model-connected protected experiments (integrated)

`endo experiment protected-run` now runs a **version 1 spec** (`endo.protected-experiment-spec.v1`): the same runner as EVAL-ISO-001, with
each attempt's agent reaching one declared local model only through a relay of its own. The decisions of §7 this settles, and how, are at
the end of this section. A version 0 spec runs exactly as before; nothing reads one version as the other.

```sh
endo experiment protected-run <spec v1> --out <dir> [--retry-interrupted] [--max-attempts n]
endo experiment protected-report <dir>          # endo.protected-report.v1 for a model-connected run
node research/protected-eval/model-connected/pi-condition.ts --pi-dist <dist> --agent-out <new dir> --model <id> > spec.json
```

### 9.1 Architecture: what was reused, and what was chosen

| Considered | Verdict |
| :-- | :-- |
| **A.** Drive the research driver (`trial.ts`) from the runner | Rejected. It is one Pi trial with its own record, no plan, no preflight, no evaluator and no resume; the runner already has all of those. Making it the engine would make a research record the product's |
| **B.** A shared orchestration layer for both | Rejected for orchestration: two consumers, one of them research, do not justify a layer. Taken for **evidence only**: the reader's derivation (`adapters/sandbox/model-evidence.ts`) is shared, and `exchangesOutsidePolicyV0` moved there from the driver (re-exported unchanged) |
| **C.** A small adapter in the runner around the merged primitives | **Chosen.** Per attempt: start `startModelRelayV0` after the preflight, mount its socket with `modelRelayMountsV0`'s bridge, run the agent behind `bridgedCommandV0` under scope limits, close the relay, summarize the recording. Nothing of the relay, proxy, capture log, sandbox, containment or evaluator was reimplemented |

The production contract has **no Pi assumption**. A condition is an agent directory and an argv, as in version 0. A model-connected agent
is told, by environment names only, where the model is (`ENDO_MODEL_ORIGIN`, the bridge at `http://127.0.0.1:18080`), which model
(`ENDO_MODEL_ID`) and the generation bound every request must state (`ENDO_MODEL_MAX_COMPLETION_TOKENS`). Pi is one such agent: its
launcher, prompt and a copy of its `dist` live in the agent directory (`research/protected-eval/model-connected/pi-condition.ts`).

### 9.2 The spec (`endo.protected-experiment-spec.v1`)

Version 0's fields, and:
- **`modelAccess`** (required): `upstream` (only `http://127.0.0.1:<port>`: a local server, never a remote, possibly paid, service),
  `model`, `routes`, `maxRequestBytes`, `maxTransferredBytes`, `maxConnections`, `maxTotalConnections`, `maxExchanges`,
  `maxCompletionTokens` and `minExchanges` (at least 1, at most `maxExchanges`). It is the relay's policy, field for field; the run's
  declared policy digest is `modelRelayPolicyDigestV0` of it.
- **`limits.memoryMaxBytes`, `limits.cpuQuotaPercent`** (required): the agent scope's `MemoryMax` (with no swap) and `CPUQuota`.
- **`runtime.aliases`**: an executable mounted again at another path, by digest (`/usr/bin/sh` for `/usr/bin/bash`, which Pi's bash
  tool needs; the host's `sh` is a link, and links are refused). An alias may not shadow the workspace, the agent, `/run`, `/tmp`,
  `/home`, `/proc`, `/dev` or an executable.

Model access is **opt-in by version**: a version 0 spec with `modelAccess` is refused (unknown field), as is a version 1 spec without it.
Sampling settings are **not** declared: nothing on the relay's side can establish what the server applied (§9.7).

### 9.3 An attempt

1. **Preflight**, in the agent's profile: version 0's probes, and two more. `net-model-relay` must connect to `/run/endo/model.sock`
   (the declared way out is there), and `net-model-server-direct` must find the model server's port on the sandbox's loopback refused.
   The preflight mounts a session **probe socket** at the relay's place: same target, kind and role, so the logical profile and its
   digest are the agent's exactly. The runner checks this (the agent's profile, with the attempt's real relay socket, must have the
   digest the boundary was checked under) rather than assuming it.
2. **The relay** starts only once the boundary is established, with a new private recording directory (`model/`, 0700) and a new
   digest key (`model/digest-key`, 0600). Its socket directory is recorded (`relay.json`) before the agent starts. A relay that cannot
   start is recorded (`relay-unavailable`), and the agent never runs.
3. **The agent** runs behind the bridge, under the scope's memory and CPU limits. Its facts (`agent-ended.json`) are written before the
   relay is closed.
4. **The relay is closed**, dropping open connections and flushing the recording (the #136 fix), and then the record's model facts are
   **derived from the recording on disk** (`summarizeModelRecordingV0`), not from the relay's word: its counters are kept beside them.
5. Collection and the **offline** evaluator sandbox are version 0's, unchanged. The evaluator never has a relay.

### 9.4 The record (`endo.protected-trial.v1`)

Version 0's record, with:
- `isolation.requested.network: "model-relay"`, the socket mount (kind `socket`) and the bridge's digest; `isolation.limits`;
- `agent.scope.result` (`oom-kill` when the memory limit killed a process; `null` otherwise, which includes success: §6);
- `network.relay`: the **established** policy's digest (the relay's frozen snapshot), its status (`not-started`, `failed-to-start`,
  `ran`, `interrupted`), and, when it ran, what it admitted, refused by reason (route, size, body, model, `generation`, unjudged,
  connections, exchanges), the bytes through it, and failed capture writes;
- `recording`: its status (`complete`, `incomplete`, `unknown`, `none`, `inconsistent`), its digest domain, the required minimum, and
  each exchange by number, method and target as sent (any HTTP token, any target within the proxy's 256 KiB head bound: the agent chooses
  them), keyed request digest, status, class and whether it verifies. `inconsistent` is the controller's fallback when a summary would not
  make a consistent record: it claims no exchange, keeps the store, and makes the trial attrition. No known input produces it (§9.8, the
  review); it exists so that a recording an agent shaped can never stop the controller or every resume after it.

Each exchange's **class** comes from the recording itself:

| Class | Meaning | Whose doing |
| :-- | :-- | :-- |
| `answered` | the model server's response relayed to its end | |
| `client-disconnected` | the agent's side closed first. With a status, it was forwarded (the model server answered). Without one, the recording cannot say whether it was forwarded (awaiting the answer) or still queued behind another request on the connection (never judged) | the agent |
| `model-failed` | forwarded (or its connection attempted); the model server's side failed | the model server: **attrition** |
| `transfer-bound` | forwarded; ended by the relay when the session's traffic reached `maxTransferredBytes`, which destroys every connection. The model server did not fail | the agent, as a refusal is |
| `refused` | not forwarded because of a governed refusal on its connection, the judge's or one ahead of it that the agent pipelined | the agent |
| `not-forwarded` | queued behind another request on a connection that ended first; never judged | |
| `unended` | no end recorded | an incomplete recording: **attrition** |

Only `answered` with a 2xx status and verified bodies is a **successful** exchange.

**Consistency rules** (the reader refuses a record that breaks one), among others:
- an agent never runs without its relay, and a relay never starts before the boundary is established;
- the relay's counters exist exactly when it ran;
- `complete` exactly when the recording loads, no capture write failed, and every exchange ended and verifies;
- in a complete recording, **the requests the judge admitted lie between the exchanges certainly forwarded** (answered, failed by the model
  server, or ended by the agent after an answer began) **and those possibly forwarded** (ended by the agent before any answer): two
  independent accounts of the same requests. The recording cannot tell an abandoned forwarded request from an abandoned queued one, so
  the rule is a bound, not an equality: an exact rule let an agent make its own record unsealable (§9.8, the review);
- a relay not started after an established boundary only in an attempt finalized on resume;
- `unknown` exactly when the relay was interrupted (an asynchronous log may lose its last writes with its controller);
- exchanges numbered 1, 2, 3… without a gap; a status only where the class can have one;
- exactly one socket mount, at the relay's place, with the bridge.

**Invalidating conditions** are version 0's, and `relay-unavailable`, `recording-incomplete`, `model-upstream-error` and
`recording-inconsistent`, derived from the facts as before, never omitted or invented.

**Outcome:**
- Attrition first, as before.
- Then, for an agent that ran, **fewer successful model exchanges than `minExchanges` is a judged failure**
  (`model-exchanges-below-minimum`), whatever the evaluator found. The evaluator's result is kept as its fact. It is never a pass, because an empty recording says nothing about the
  model, and never attrition, because the agent decides whether it calls the model, and an agent able to leave the denominator could bias
  a comparison.
- A refused request does not invalidate a trial: it is the agent's doing, and it is counted.

### 9.5 The independent reader

`endo experiment protected-report` reads a version 1 run's records only as version 1 (an offline record in it is refused, and the
reverse), and for each:
- the relay's established policy digest must equal the digest of the run's **declared** policy; the limits and the required minimum must
  be the run's;
- the recording is **derived again** from the attempt's store under its key, and must be exactly the record's summary;
- the relay's admitted count must lie between the certainly and the possibly forwarded exchanges, and the certainly forwarded must be at
  most `maxExchanges`;
- every certainly forwarded request is **judged again** from its recorded body under the declared policy: route, size, a JSON object,
  no repeated key, the model, and the generation bound. Others are not judged again: a refusal also ends what the agent pipelined behind
  it, and an abandoned queued request was never judged, so some may be inadmissible without the relay having erred. A forwarded request
  the agent abandoned before any answer is therefore counted but not judged again: the judge admitted it, which the count shows.

A record that fails any of these is refused (`record-refused` attrition), naming why. The report's cells add
`failedBelowMinimumExchanges`, and it states the declared model access.

The reader uses the same derivation code as the controller: what is independent is the process, and the trust (nothing the record
concludes is taken on its word). A matching digest shows the evidence is the one recorded, **not** that no one with the host account
rewrote both (EVAL-ISO-001 §8).

### 9.6 The generation bound (§7.2, §7.3)

**Refusal, never rewriting.** A request is admitted only if it states a bound, in `max_tokens`, `max_completion_tokens` or llama.cpp's
`n_predict` (every one present an integer from 1 to `maxCompletionTokens`), for one choice (`n` and llama.cpp's `n_cmpl` each absent
or 1). A rewritten request would no longer be what the
agent sent, and the recording is byte for byte. Version 1 requires the bound: there is no unbounded production mode. Policies without it
(the research driver's, and every one recorded before) judge and digest exactly as before.

**What it bounds, measured** (llama.cpp b11429, Muse Glimmer 30B, one prompt, 2026-11-09): `max_completion_tokens: 6` and
`max_tokens: 6` each stopped at 6 completion tokens (`finish_reason: length`); with neither, the same prompt ran to 311. Pi 1.5.0 sends
`max_completion_tokens` (its configured `maxTokens`), which the example's launcher sets to the declared bound.

**`n_predict` is llama.cpp's own field, and it wins** (measured, same build): `max_tokens: 3` alone stopped at 3; with `n_predict: -1`
beside it, the same prompt ran to 311; with `n_predict: 40`, to 40, also beside `max_completion_tokens: 3`. Before the review (§9.8), a
request with `max_tokens: 1, n_predict: -1` was admitted and ran unbounded. `n_predict` is now judged like the other two.

**`n_cmpl` is llama.cpp's choice count, and `n` only its fallback alias** (source: `tools/server/server-schema.cpp`; the b11429 library
carries the same field and description; not measured against a running server). It is limited to the server's slots (`--parallel`), so
`{"n": 1, "n_cmpl": 4}` would ask a four-slot server for four completions of up to the bound each. Found in the Stage 0 review (§9.8),
it is now refused like `n` over 1.

**What it does not bound:**
- a server that ignores these fields, or reads yet another one (the cap is then only a stated one; the three were measured for this
  llama.cpp build only). An allowlist of request fields would close this, at the price of refusing whatever a harness sends that the list
  does not know; it is left as a follow-up;
- prompt processing, which grows with the request (bounded by `maxRequestBytes`) and the exchanges (`maxExchanges`);
- whether a reasoning model's hidden tokens count against it (not measured);
- the model server's own memory and time, which no limit on the agent's scope reaches.

**Total model-resource containment is not claimed.**

### 9.7 Threat model, added to §5

**Stops (shown, §9.8):**
- an undeclared route, model or generation;
- direct access to the model server or any host service;
- exchanges, connections or bytes past their bounds;
- an agent reaching hidden evaluator material, the run directory, the recording or its key;
- a relay failure, an incomplete recording or a model failure being read as a valid trial;
- a record that does not match its recording, of another version, or under another policy, being counted;
- a resume under a changed policy, model, runtime or version.

**Does not stop, or establish:**
- **The served model's identity:** the model *name* is pinned; the weights behind it are not (a router can serve other weights under
  the same alias). The sampling settings the server applied are not established either (llama.cpp takes its defaults from its
  command line, which the relay never sees). Each request as sent is in the recording.
- **Agent-caused attrition:** an agent that crashes the model server through the one admitted route turns its trial into
  `model-upstream-error`; one that fills the host disk through `/work` can make the recording incomplete. Both are attrition, reported
  by condition, as version 0 reports the controller's failures.
- **The probe socket is not the relay:** the preflight shows the socket's place and the sandbox's other boundaries; the relay's
  enforcement is shown by its own tests and judged again by the reader for every certainly forwarded request.
- **`net-model-server-direct` shows little on its own:** it connects to the model's port on the sandbox's *own* loopback, where nothing
  listens unless the network namespace is the host's. `net-host-loopback` already shows that; this probe repeats it at the port that
  matters, and fails when the host's network is shared (tested). It does not show anything `net-host-loopback` does not.
- **Leftovers:** a controller killed between the relay making its socket directory and recording it (`relay.json`) leaves that
  directory in `$XDG_RUNTIME_DIR`; a killed session's own directory is removed only by a later session of the same run directory, with
  the same `$XDG_RUNTIME_DIR`. Both are empty of anything but sockets and the bridge, and the runtime directory is cleared at logout.
- Everything §5 and EVAL-ISO-001 §8 list.

### 9.8 Evidence (this host: Arch, systemd 262, bubblewrap 0.13.1, Node 26.12.1; 2026-11-09)

**Tests** (each test is run as it is written, nothing simulated where a real sandbox is used):

| File | Real isolation | Covers |
| :-- | :-- | :-- |
| `tests/protected-model-records.test.ts` (17) | no: runs everywhere | the generation bound (each way to break it, `n_predict` included), the earlier digest kept; the v1 spec's refusals (21 variants); v0 and v1 never read as each other; the outcome rules; 23 contradictory records refused; the reader over a real relay's recording: classes, pipelined refusals, a model failure, a response still streaming at close, four agent-shaped connections (pipelined then dropped, junk after a forwarded request, an unusual method, a 9000-byte target) each still making a record that seals and that the reader accepts, and each tampering refused |
| `tests/protected-model-run.test.ts` (11, and 1 opt-in) | **yes** (skipped, and says so, where the host cannot isolate) | an honest agent; an adversary (11 attacks, below); an agent that never calls the model; the exchange bound; a dead model server; a relay that cannot start; a weakened boundary; four tamperings of finished runs; a resume under a changed policy, model or version; a controller killed between the agent's end and the relay's close; an agent killed at its deadline mid-response; real Pi through `protected-run` (opt-in, `ENDO_PI_DIST`) |

**The adversary, from inside its sandbox:** `POST /models/load`, `GET /v1/models`, `GET /slots`, another model, no generation bound, a
bound over the limit, `n: 4`, a trailing slash, a query string: each connection closed, and the model server saw exactly the one
admitted request. The model server's port on loopback: `ECONNREFUSED`. 192.0.2.1: `ENETUNREACH`. The evaluator's definition, the run
directory and the user's runtime directory, by host path: `ENOENT`. `/run/endo` holds only `bridge.cjs` and `model.sock`, and is
read-only (`EROFS`). Its environment: the three `ENDO_MODEL_*` names, `HOME`, `PATH`, `PWD`, `TMPDIR`. Its trial is still judged on its
submission (a pass): refusals are the agent's doing.

**Found by these tests, and fixed:** closing the recording proxy while a response was still streaming lost that exchange's end
(`adapters/openai-proxy/record.ts`, from #134/#136). `close()` waited one immediate for the destroyed sockets' close handlers, but a
socket's `close` comes in a later phase of the event loop, so the end was recorded after `close()` had resolved and the log was closed.
Any response that had streamed for 300 ms or more was affected: in a protected run, an agent stopped at its deadline mid-response left an
`unended` exchange, an incomplete recording, and so attrition it had caused. `close()` now ends the clients first and awaits each socket's
close. Both new tests fail on the earlier `close()`; the #136 test still passes; so does every suite that uses the proxy.

**Mutations** (the scratch harness weakened one check at a time, ran both files, and restored it):

| Weakened | Caught by |
| :-- | :-- |
| The generation bound always holds; several choices admitted | 4 tests; 2 tests |
| The reader skips: the admitted count's bounds; re-judging forwarded requests; the exchange list's equality; the recording altogether | 1 each bound; 1; 2; 1 |
| Model failures read as `not-forwarded` | 2 |
| Too few exchanges not a failure | 2 |
| The record's rules: complete ⇔ whole; the admitted count's bounds; one socket mount | 1 each |
| `model-upstream-error`, `recording-incomplete` not invalidating | 3; 1 |
| The report accepts another policy; another record version | 1; 1 |
| The relay's direct-server probe always passes | 1 |
| A relay failure recorded as never started | 1 |
| The upstream allowed off loopback | 1 |
| Resume leaves the relay's socket directory; the previous session's directory | 1; 1 |
| The agent's facts written after the relay closes | 1 |
| The recording read before the relay has closed | 1 (missed until the deadline test was added; that test found the bug above) |
| `close()` without awaiting the sockets; without ending the clients first | 2; 2 |

One change was **removed** instead: queuing a recording job made after its connection closed. No test could make it matter once clients
close first, and an unproven change does not stay in a trust boundary.

**Real Pi and a real local model, through `endo experiment protected-run`** (Pi 1.5.0, Muse Glimmer 30B on llama.cpp b11429, the
example spec from `pi-condition.ts`: one trial, 2 GiB, 400% CPU, at most 40 exchanges of at most 2048 tokens; 2026-11-09):
- 37 probes established, `net-model-relay` connected, `net-model-server-direct` `ECONNREFUSED`;
- Pi completed in 61 s, termination confirmed;
- 10 requests, all admitted, none refused (every one stated `max_completion_tokens: 2048`), recording complete;
- 9 exchanges `answered`; the last `client-disconnected`: Pi left the stream before the server ended it. It does not count as successful;
- the independent evaluator passed all 7 cases;
- the report read the record against its recording again and refused nothing: `qualified 1, passed 1`.

Repeated on the final code, after the review's fixes (`run-060904`): Pi completed in 54 s; 10 requests, all admitted and all `answered`
with 200 (this time none ended by Pi first, so that varies between runs); recording complete; 7 of 7 cases; the report refused nothing.
Two runs are evidence that the route works end to end, not a measurement of the model or of Pi.

The run directories are under `~/projects/endophasia-research/eval-iso-003/`, outside the repository.

**Full checks on this branch:**
- `typecheck`, `build`: clean. `lint`: the one existing warning.
- `vitest` (final, with `ENDO_PI_DIST` set): 6644 passed, 70 skipped, none failed. Before the review's fixes, without it: 6640 passed.
- One intermittent failure was seen in separate runs, in EVAL-ISO-001's "controller itself is killed" test (the sandbox must die within
  10 s of its killed controller). Measured on unchanged `main` too: 1 of 12 runs failed there, 1 of 12 here. It is the launch window
  EVAL-ISO-001 §2 documents, not this change.

**Independent review.** Eva is not available in this environment (no tool or session for it), so a separate reviewer (a fresh agent,
given the code and the threat areas, not this document's reasoning) read the diff and attacked it. Its findings, each checked here
before it was acted on:

| Finding | Checked | Remediation |
| :-- | :-- | :-- |
| **High.** An agent could make its own record unsealable, which threw in the controller, and threw again on every resume, stopping the run. Four ways: pipeline two requests and drop the connection (the queued one ended `client-disconnected`, counted forwarded, so forwarded > admitted); junk after a forwarded request (the governed refusal relabelled the forwarded one `refused`); a method token like `M-SEARCH`; a target over 8192 bytes | confirmed with its reproductions | the proxy ends a forwarded request that a later refusal cut as `client-disconnected`, never `refused`; the forwarded rule is a bound (certainly ≤ admitted ≤ possibly); methods and targets are bounded as the proxy parses them; and a summary that still would not seal is written `inconsistent` (attrition), never thrown. A test drives all four through a real relay and requires a record that seals and that the reader accepts |
| **Medium.** The generation bound is bypassed by llama.cpp's `n_predict` | confirmed on the real server (311 tokens past `max_tokens: 3`) | `n_predict` judged with the others; tested |
| **Low-medium.** A record with an established boundary, no relay, no agent, finalized normally, sealed and counted as a judged failure | confirmed | refused unless finalized on resume; the minimum rule applies only to an agent that ran |
| Docs: an unfilled evidence placeholder; `client-disconnected` described as forwarded; the record-unreadable claim; `GET /v1/models` declarable; §9 before §8 | confirmed | corrected (this section) |
| A thrown agent launch left no `model-ended.json`, so a resume would misreport the relay | confirmed by reading | written in the `finally` that closes the relay |
| Leftover directories; `net-model-server-direct` proves little | agreed | documented (§9.7), not changed |

**Stage 0 review** (a later, separate review of this branch, 2026-11-09). Each was reproduced on this branch's earlier head, and its
regression test fails there:

| Finding | Checked | Remediation |
| :-- | :-- | :-- |
| **Medium.** Reaching the relay's transfer bound mid-response was recorded `model-failed`, so the trial became `model-upstream-error` attrition: a false account of the model server, and a way for the agent's own traffic (honest or not) to remove a trial from the judged denominator | reproduced through a real relay: a stream cut at a 3000-byte bound, recorded `model-failed`, status 200 | the proxy records an exchange its transfer bound ended as such, and the reader classes it `transfer-bound`: forwarded, the agent's doing, never successful, never invalidating |
| **Low-medium.** llama.cpp's `n_cmpl` (with `n` as its alias) multiplies generation past the one-choice rule, up to the server's slots | read in the llama.cpp source, matched in the b11429 library; not measured live (no model was loaded for it) | `n_cmpl` judged with `n`; tested |

The reviewer also reported as sound: version 0's reading, sealing and digests; the policy digest without the bound; the proxy's new
`close()` (no hang, and in-flight exchanges now end the same way every time); the relay's ordering; retries; and the report's checks.

Each review fix was mutation-tested as above: undoing the proxy's relabelling fix, narrowing the method, making either forwarded rule an
equality, accepting the not-started record, dropping `n_predict`, or not invalidating `inconsistent`, each fails a test. Three of them
were missed at first, because the fake model answered at once; the scenario test was given a model server that holds its answer back,
and all are caught.

### 9.9 The decisions of §7, as taken here

1. **Integration:** done, as this section describes: a spec field, `endo.protected-trial.v1`, and the reader's rules.
2. **Default limits:** none. Version 1 requires every limit to be declared; the example's are 2 GiB, 400% CPU, 256 MiB through the
   relay, 40 exchanges, 2048 tokens per request.
3. **Request fields:** refused, never rewritten (§9.6).
4. **`GET /v1/models`:** not admissible in version 1. Every admitted request must be a JSON object naming the model and a bound, and
   a GET without a body is refused before the judge (unjudged), so declaring the route would admit nothing. A harness that probes it first
   is not supported; Pi 1.5.0 does not.
5. **The runtime set:** declared per spec, with aliases, and part of the profile digest.
6. **Real-model tests:** opt-in, on the operator's workstation only, bounded (§9.8).
