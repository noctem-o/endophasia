# COORDINATOR-MODEL-POOL-001 (M1): a provider-agnostic local Coordinator Model Pool

*   **Status:** implemented on branch `feat/coordinator-model-pool-001` (draft PR). Local, read-only, advisory only.
*   **Baseline:** `origin/main` @ `7666b0842` (merge of #187; #184, #185 and #186 are ancestors, verified with `git merge-base --is-ancestor`).
*   **Contract:** [S0 Appendix A](coordinator-automation.md#appendix-a-separately-actionable-implementation-brief--m1-coordinator-model-pool-001).
    M0 is [COORDINATOR-RUNTIME-001](coordinator-runtime.md); its threat model and invariants carry over unchanged.
*   **Not in M1:** hosted inference, credentials, OpenRouter, scheduling, daemons, timers, operational harness routing, standing
    authorisations, assignment or store mutation, E4. See §8.

## 1. What changed

`endo coordinator brief` used one fixed binding: `http://127.0.0.1:8091`, model `Inkling-2-Mini-Uncensored-AD-Q4_K`. M1 lets the operator
name several local OpenAI-compatible endpoints in a file and has the Coordinator pick one by a zero-token health observation:

```text
endo coordinator brief [<root> | --root dir] --project <id> [--pool <config.json> [--member <memberId>]] [--quiet]
endo coordinator pool check [--pool <config.json>] [--quiet]
```

Without `--pool`, `brief` runs the M0 path itself: same target, same `/props` router gate, same relay policy (digest-identical, tested),
same wire behaviour, same output. `--member` without `--pool` is a usage error. `pool check` without `--pool` observes M0's endpoint
as a one-member pool. The model a briefing uses is now a parameter of one admitted attempt; the Coordinator's project scope, its single
`endophasia_status` tool, its sandbox, its evidence requirements and its lack of authority do not depend on it.

| Layer (S0 §2) | Module | Role |
| :--- | :--- | :--- |
| Configuration | `protocol/coordinator-model-pool.ts` | Closed `endo.coordinator-model-pool.v0` schema, loopback origin rule, member ordering |
| Runtime contract | `runtime/contracts/coordinator-model-pool.ts` | Readiness vocabulary, observer seam, `selectCoordinatorModelV0`, provenance and check types |
| Observation | `adapters/coordinator/model-pool-probe.ts` | `probeLocalEndpointV0`: bounded GET-only health observation |
| Relay | `adapters/coordinator/model-relay.ts` (+ `openclaw.ts`, `wire.ts`) | Frozen per-briefing target; Coordinator policy over the unchanged generic relay |
| Host orchestration | `adapters/coordinator/model-pool.ts` | Pool file reader, `pool check`, pooled briefing substrate |
| CLI | `cli/coordinator.ts`, `cli/help.ts` | `--pool`, `--member`, `pool check` |
| Contract | `runtime/contracts/coordinator-brief.ts` | Optional `modelPool` provenance; five new closed refusals |

## 2. Configuration (`endo.coordinator-model-pool.v0`)

[`coordinator-model-pool.example.json`](coordinator-model-pool.example.json) is an illustrative pool for the existing local endpoint.
It carries no credential and deliberately does not guess the operator's model identifier: replace the placeholder with the canonical model
name the server serves, taken from the server's own configuration (§9).

```json
{
  "schemaVersion": "endo.coordinator-model-pool.v0",
  "selection": { "fallback": "availability", "unconfirmedModel": "permit" },
  "members": [{
    "memberId": "local-primary", "kind": "local-openai-compat", "endpoint": "http://127.0.0.1:8091",
    "modelId": "REPLACE-WITH-THE-EXACT-id-FROM-GET-models", "priority": 100,
    "maxPromptBytes": 8192, "maxOutputTokens": 2048, "timeoutMs": 135000, "advisoryOnly": true
  }]
}
```

Every object is closed (an unknown key, including `apiKey` or `__proto__`, is refused) and every field is required, so nothing is
defaulted silently. The file must be a regular file whose last component is not a symbolic link, at most 64 KiB, UTF-8, and must not
repeat a key at any depth (JSON parsers disagree about which duplicate wins).

| Field | Rule |
| :--- | :--- |
| `selection.fallback` | `availability` (an ineligible member lets the next eligible one be used) or `none` (only the first in order is considered) |
| `selection.unconfirmedModel` | `permit` or `refuse` a member whose endpoint is healthy but whose model is not observed loaded (§3) |
| `memberId` | 1–64 of `[a-z0-9-]`, no leading/trailing hyphen, unique |
| `kind` | `local-openai-compat`; `hosted-relay` is parsed for M2 and never contacted in M1 |
| `endpoint` | local: exactly `http://127.0.0.1:<1..65535>`; hosted: an `https` origin written exactly as its canonical origin |
| `modelId` | 1–256 printable ASCII, no spaces; sent in every request and required verbatim in the server's listing |
| `priority` | integer 0–1000, higher preferred |
| `maxPromptBytes` | 1024–8192 (M0's 8192 is the ceiling) |
| `maxOutputTokens` | 256–2048 (M0's 2048 is the ceiling) |
| `timeoutMs` | 5000–135000 (M0's 135 s agent deadline is the ceiling) |
| `advisoryOnly` | must be `true` |

Two members with the same `endpoint` and `modelId` are refused as ambiguous; the same endpoint with different models is allowed (a
llama.cpp router serves several). A pool may only lower M0's bounds. Raising them (for longer reasoning, say) needs its own evidence.

**Endpoint rule.** The local rule is a whole-string match, not a URL-parser decision: `localhost`, `127.1`, `0x7f.0.0.1`, `0177.0.0.1`,
`2130706433`, `127.0.0.2`, `0.0.0.0`, any IPv6 form (`[::1]`, `[::ffff:127.0.0.1]`), a trailing dot or slash, a path, query, fragment,
userinfo, `https`, upper-case scheme, leading zeros and out-of-range ports are all refused before anything is opened. Nothing is
resolved through DNS. IPv6 loopback is refused because M0's recording proxy (`adapters/openai-proxy/record.ts`) passes the URL
`hostname` (`[::1]`, bracketed) straight to `net.connect` and cannot reach it; changing the shared proxy is out of scope (§8).

## 3. Health observation (`probeLocalEndpointV0`)

The probe sends only GET requests without a query string, never a completion, never a credential. Every request shares one 3 s
deadline that settles the request directly on expiry or cancellation, has an 8 KiB head and 256 KiB body bound, `Connection: close`,
no agent pooling, a `lookup` that refuses to resolve, and a check on connect that the peer is `127.0.0.1` on the configured port.
A 3xx or a 101 upgrade is refused, never followed. It never throws for anything a server does; every outcome is a readiness value.

What it may send was decided by reading llama.cpp's `tools/server` sources at master (`server.cpp`, `server-context.cpp`,
`server-models.cpp`), not only its README, because the README's "exempt from idle reload" list is not the whole story:

| Request | Sent when | Why it is passive |
| :--- | :--- | :--- |
| `GET /health` | always | Answered by the server itself; exempt from idle sleep. 200 healthy; 503 `Loading model` is `loading`. |
| `GET /props` | after a 200 health | Router: `get_router_props` with no `model` answers itself. Single server: `create_response(true)` (no wake), cached while asleep. |
| `GET /models` | single llama.cpp server only (`build_info` and `total_slots` present) | `get_models`: `create_response(true)`, cached while asleep, "must be accessible during sleep". |
| `GET /v1/models` | only when `/props` is 404 (not llama.cpp) | A catalog; membership is not residency evidence. |

| Not sent | Evidence |
| :--- | :--- |
| `/slots` (any mode) | Single server: `get_slots` uses `create_response()` without bypass, which calls `wait_until_no_sleep()`: it **wakes** a sleeping model and counts as activity. Router: `routes.get_slots = proxy_get`, which with the default autoload calls `ensure_model_ready()` and **loads** the model. |
| `/metrics` | Single server: posts a metrics task with `metrics_reset_bucket` (changes what a Prometheus scraper sees). Router: proxied like `/slots`. |
| `/models` or `/v1/models` on a router | Same handler (`get_router_models`) for both routes; it calls `get_all_meta()`, which runs a pending `load_models()` reconciliation when `need_reload` is set (after a download completes) and can **unload** a running model whose source changed. |
| any `?model=`, `?autoload=`, `?reload=` | Routed or reconciling forms. |

A `/props` with `role: "router"` is treated as a router whether or not its build is recognised. A `/props` document that identifies
neither a router nor a single llama.cpp server gets no catalog request (`backend-unidentified`).

**Consequence.** No local llama.cpp observation in M1 can confirm free capacity or saturation without a side effect, so the probe never
reports `ready` or `saturated`, and a router member's model state is never read. S0 Appendix A assumed `/slots?fail_on_no_slot=1` was a
passive saturation probe; the source shows it is not (§8 deviations). `ready` and `saturated` stay in the vocabulary for an observer that
has a passive capacity signal (S1, M2), and selection and provenance handle them.

| Readiness | M1 probe reports it when | Eligible |
| :--- | :--- | :--- |
| `ready` | never (reserved for passive capacity evidence) | yes; the only state with `capacityConfirmed: true` |
| `capacity-unknown` | single llama.cpp server, awake (`is_sleeping: false`), exact id listed | yes, `capacityConfirmed: false` |
| `model-unconfirmed` | any router; a single server asleep or not saying; a generic catalog entry; no listing; unidentified backend | only with `unconfirmedModel: "permit"` |
| `loading` | `/health` 503 `Loading model` | no |
| `saturated` | never (reserved) | no |
| `model-unavailable` | exact id not listed (an alias or a similar name is not the id) | no |
| `unhealthy` | an error status from `/health`, `/props` or the listing | no |
| `unreachable` | connection failed or closed early, deadline, cancellation | no |
| `probe-refused` | redirect, upgrade, oversized or malformed answer, unexpected peer | no |

A closed `detail` word (e.g. `router-model-state-not-observed`, `model-sleeping`, `slots-not-observable`) says how each was reached, and
the observation records every request and status. An observation is a fact at one instant with `basis: "controller-observed"`; it says
nothing about whether the next inference request will succeed.

**What this means for the operator's router.** With the router at `127.0.0.1:8091`, every member on it reads `model-unconfirmed`, so a
pool of router members needs `"unconfirmedModel": "permit"` (as the example and the implicit M0 pool use). Fallback between router
members then happens only when the whole router is unhealthy, unreachable or loading; a model that fails to load is discovered by
the inference request, which is final (§4). That is the honest limit of a side-effect-free observation of llama.cpp router mode today.

## 4. Selection (`selectCoordinatorModelV0`)

Members are ordered by `priority` descending, then `memberId` by code unit, so the file's member order never matters. Selection
observes lazily: a member is probed only when every member above it was skipped, and a hosted member is skipped as `hosted-not-permitted`
without being observed. The first eligible member is selected; `fallbackOccurred` is true when any member above it was skipped. With
`fallback: "none"` only the first member is considered. All skips are recorded in order with their reason.

`--member <id>` observes that member alone. If it is missing, hosted or ineligible, the briefing is refused (`member-not-found`,
`member-not-permitted`, `member-unavailable`); another member is never substituted and never contacted. The spec's `--model-member`
spelling is not accepted; `--member` is the documented public syntax (`--model-member` gets the usage error).

**Selection and inference are separate.** Fallback happens only before inference is dispatched. Once the selected member's target is
handed to the M0 runner, its result is final: a refusal (`tool-expansion-suggested`, `ungrounded`, …), a provider error
(`model-unavailable`), a truncation or a timeout is returned as unavailable, and no other member is tried. This is deliberate: a failure
after dispatch is ambiguous (the model may have produced output, the status may have been delivered), and replaying a partly completed
conversation on another model would let fallback launder a refusal. Provenance carries the constant `inferenceFailover: "never"`.
A pre-dispatch connection failure is the one case that could safely fail over; M1 does not, and §10 hands that to M2 with the
condition it would need.

## 5. Relay generalisation

The briefing's target is built once from the selected member and frozen:
`{ origin, model, maxOutputTokens, maxPromptBytes, timeoutMs, pinResponseModel }`. The generic relay
(`adapters/sandbox/model-relay.ts`, shared with protected evaluation) is unchanged; `adapters/coordinator/model-relay.ts` only builds the
Coordinator policy for a target and starts the relay with the wire gates. Relative to M0:

*   **Unchanged:** bubblewrap profile and mounts, empty network namespace with only the loopback bridge, scratch HOME, no inherited
    skills/plugins/tool search, exactly one `endophasia_status` definition, per-turn synthetic bearer, the exact request gate (tool set,
    `stream`, sampling parameters, no `n_predict`/`max_completion_tokens`), tool-call/tool-result pairing with the observed id
    normalisation, one route, 512 KiB requests, 8 MiB transfer, 4/8 connections, 2 exchanges, no redirect (only a 200 event stream is
    admitted), answer backstop, cleanup.
*   **Parameterised by the target:** upstream origin, model (relay policy, OpenClaw provider config and `--model`), generation bound
    (relay policy, wire, plugin payload override, OpenClaw `maxTokens`), prompt bound, and the agent deadline (`--timeout`, and the
    process kill at deadline + 20 s, exactly M0's 135/155 s for M0's target).
*   **New for pool members only:** every streamed chunk must name exactly the configured model, or the briefing is refused as
    `model-identity-mismatch` (an omitted `model` is refused too). The host enforces the member's `timeoutMs` itself: the agent is
    aborted at the deadline and any result after it is `inference-timeout`. Both are off for M0's target, so the default path's wire
    behaviour and its 135 s / 155 s deadlines are unchanged.
*   **New option:** an external `AbortSignal`. A cancelled briefing is `unavailable` whatever arrived; the result is computed only after
    the sandbox exits and the relay is closed, so nothing late can be accepted.

**Reasoning and truncation.** OpenClaw runs with `--thinking off` and the model is declared `reasoning: false`; no backend-specific
reasoning-control parameter is added, so backends that lack one are unaffected. A completion whose only output is `reasoning_content`
has empty answer text and cannot be available (measured: OpenClaw exits non-zero, giving `runtime-unavailable`; the relay's own
`ungrounded` check stands behind it). `finish_reason: "length"` is `generation-limit`.

## 6. Provenance and measurements

A pooled result carries `modelPool` (absent on the M0 path):

```json
{ "schemaVersion": "endo.coordinator-model-pool-provenance.v0", "poolSha256": "…",
  "selectionMode": "priority", "requestedMemberId": null,
  "selectedMemberId": "secondary", "selectedModelId": "model-b", "selectedEndpoint": "http://127.0.0.1:…",
  "selectedReadiness": "capacity-unknown", "capacityConfirmed": false,
  "fallbackOccurred": true, "skippedMembers": [{ "memberId": "primary", "reason": "saturated" }],
  "inferenceFailover": "never",
  "measurements": { "observationElapsedMs": 4, "inferenceElapsedMs": 8123, "promptTokens": 1840,
                    "completionTokens": 612, "exchanges": 2, "failureCategory": null } }
```

`runtime.model` is the member's `modelId`, and both the pooled substrate and `briefFromCoordinatorSubstrateV0` refuse an available
result whose `runtime.model` differs from `modelPool.selectedModelId`. Evidence digests (`readAtMs`, `projectionSha256`,
`modelViewSha256`) are unchanged. Token counts are the server's self-reported `usage`, summed over exchanges that reported it; unknown
measurements are `null`. Nothing is persisted: no inference journal, no new store. A selection refusal yields
`runtime: { harness, provider: "none", model: "none" }`, no answer and no evidence.

New closed refusals on `EndoCoordinatorBriefRefusalV0`: `no-healthy-member`, `member-not-found`, `member-unavailable`,
`member-not-permitted`, `model-identity-mismatch`. Configuration errors are not refusals: the CLI exits 1 with a message naming the file
and the first problem, before any endpoint is contacted.

## 7. Acceptance tests

All in `tests/coordinator-model-pool.test.ts` against deterministic fakes on ephemeral `127.0.0.1` ports. The fake llama.cpp router
counts as a "load" any request the real router could turn into one (any POST, any `?model=`/`?autoload=`/`?reload=`, any router
`/slots`), so "zero loads" is checked against router semantics, not just against our own request list.

| ID | Evidence |
| :--- | :--- |
| AT01 | M0 target, inference settings and relay policy digest equal M0's literal values; M0 wire still admits any response model; the existing `coordinator-brief` suite passes unchanged, including its opt-in installed-OpenClaw cases (M0 path, 6 cases). |
| AT02 | 31 malformed documents refused by the parser; 8 unsafe files (missing, directory, symlink, oversized, not JSON, repeated nested and top-level keys, bad limit) refused by the reader and by `pool check` (exit 1, empty stdout); the member's listener sees **zero connections**. `--member` misuse diagnostics. |
| AT03 | Highest priority, `memberId` tie-break, independent of three file orders; only the selected member is observed. |
| AT04 | Six ineligible primary states each fall back with exact `skippedMembers` (injected observer, since the M1 probe cannot observe saturation); end-to-end, an unhealthy primary's server gets no completion and the runner receives only the secondary's frozen target; full provenance and measurements asserted. |
| AT05 | All members unreachable: typed `no-healthy-member`, `model: "none"`, no answer, no evidence, runner never called. |
| AT06 | Explicit loading member refused `member-unavailable`; the higher-priority healthy member receives **zero connections**; unknown and hosted members refused. |
| AT07 | 29 endpoint spellings refused (IPv4 short/hex/octal/decimal forms, other 127/8 and 0.0.0.0, IPv6 incl. mapped, userinfo confusion, trailing dot/slash, path, query, fragment, https, ports). Listeners on the same port at `127.0.0.1` **and** `::1` receive zero connections when the CLI is given `localhost`, `[::1]`, `127.1`, decimal and trailing-slash forms. A `/health` 307 is not followed (target sees zero connections). Through the real relay, an upstream 307 is refused and its `Location` never contacted. |
| AT08 | A router in each of six model states, ten single/generic server shapes and three unidentified `/props` shapes: exact request paths asserted, all GET, no `Authorization`, no query string. The fake counts as a load anything the real server could turn into a load, unload, wake or activity (any POST or query, any `/slots` or `/metrics`, any router catalog request): zero in every case, including the `pool check` CLI over a router and a single server. |
| AT09 | A healthy router is `model-unconfirmed` whatever its model's state; a generic catalog entry is `model-unconfirmed`; `capacityConfirmed` is never true from the M1 probe; `pool check` reports `capacityConfirmed: false`. |
| AT10 | Probe: silent endpoint times out at its deadline and its late answer is ignored; cancellation; refused port; oversized body and head; interrupted body; non-HTTP bytes; malformed listings; a `101` upgrade and a close-without-response settle within the deadline (the review's R3 hang). Real relay: interrupted stream yields no completed response; a 9 MiB response is cut at the 8 MiB transfer bound; foreign-model and `n_predict: -1` requests never reach the upstream. Installed OpenClaw (opt-in): a hanging member ends `inference-timeout` at its own 20 s deadline (measured 21.2 s) with one completion and none afterwards; a cancelled slow stream ends unavailable. |
| AT11 | Pooled wire refuses a response naming another model and one omitting `model`; through the real relay the answer never reaches the agent; a runner reporting another model gets `model-identity-mismatch`; the contract refuses an available result inconsistent with its provenance; a listing with only `Model-A`/`model-a:Q4` is `model-unavailable`. Installed OpenClaw (opt-in): substituted final response refused. |
| AT12 | For a member with a lower generation bound: extra tool, M0's larger `max_tokens`, generated `exec`, foreign project, path-traversal selector, extra selector key, fabricated result, wrong call id. |
| AT13 | Reasoning-only completion has empty answer text; `length` finish is visible. Installed OpenClaw (opt-in): reasoning-only ends unavailable and truncation ends `generation-limit`. |
| AT14 | Five post-dispatch outcomes (`tool-expansion-suggested`, `model-unavailable`, `generation-limit`, `ungrounded`, `tool-not-permitted`) are final; the next member gets **zero connections**. |
| AT15 | A real fixture store and project are fingerprinted before and after `pool check` (in-process and CLI), a successful pooled briefing and an explicit refusal; unchanged. `pool check` takes no store at all. |
| AT16 | Hosted members (one pointing at a live listener) are skipped unobserved; explicit hosted member refused; a pool of only hosted members refuses; the listener gets zero connections; `coordinatorTargetFromMemberV0` and the probe refuse hosted members. |

The opt-in installed-OpenClaw cases run with `ENDO_COORDINATOR_OPENCLAW=$HOME/.local/bin/openclaw` (bubblewrap required) and use the
same deterministic fake provider; they never contact a model server.

## 8. Adversarial review, verification, deviations and limits

### Independent adversarial review

A read-only reviewer subagent (a different model, OpenAI GPT-6.2 Astra, high reasoning) ran on this workstation against `126653599`,
with the checkout read-only, no live model server and no hosted API, then re-verified the fixes. Every finding:

| ID | Severity | Finding | Disposition |
| :--- | :--- | :--- | :--- |
| R1 | high | `/slots` wakes a sleeping single-model server (`wait_until_no_sleep`) and counts as activity; `is_sleeping` was read two requests earlier | **Fixed:** `/slots` is never sent; capacity is `capacity-unknown`. Verified in source. |
| R2 | medium | A router catalog request runs a pending reconciliation that can unload a model; first fix still listed when a router's build was unrecognised (`/v1/models` is the same handler) | **Fixed:** no catalog request to any router or unidentified backend. Verified in source. |
| R3 | high | A 101 response produced only `close`; the probe never settled, even after its deadline | **Fixed:** settles directly on abort, request close, response close; upgrades refused. Regression test. |
| R4 | medium | A pooled stream without any `model` field skipped the identity check | **Fixed:** every pooled chunk must name the configured model. Regression test. |
| R5 | medium | A generic catalog entry was reported as loaded; an unrecognised `/props` was labelled llama.cpp; `/slots` `[]` produced `ready` | **Fixed:** catalog membership is `model-unconfirmed`; llama.cpp needs `build_info` and `total_slots`; no `ready` from the probe. |
| R6 | medium | `timeoutMs: 5001` gave OpenClaw 6 s and the host 25 s; no elapsed check | **Fixed:** host deadline at `timeoutMs` for pool members, `inference-timeout`; M0 unchanged. Opt-in test. |
| R7 | low | `exchanges` counted parsed responses, not admitted requests | **Fixed:** `relay.admitted()`. |
| R8 | medium | This report's first draft called a router catalog request passive and told the operator to run it | **Fixed:** §3 and §9 rewritten. |
| D1 | design authority (open) | Loopback pins the socket destination, not the listener's identity or the weights it serves; a matching `model` string is what the server *reported*. Provenance that must survive a replaced or lying listener needs authenticated service/model identity. M0's threat model already trusts the local model server; M1 keeps that trust and does not resolve it. |
| D2 | design authority (open) | `unconfirmedModel: "refuse"` governs selection-time evidence only. The inference request itself can still cold-load (or, on a router, trigger reconciliation) after an eviction; only an upstream no-autoload guarantee could prevent that. |

The reviewer also reported as sound: literal IPv4 and port validation, no DNS, no IPv6; a Node global-proxy fixture saw zero probe
requests; no redirect following; `pool check` reads no store and publishes no response bodies; exact-project projection, single
status tool, paired tool result, per-turn bearer and the bubblewrap profile unchanged; explicit selection never switches; fallback is
pre-inference only, uses the selected member's declared limits, and adds no authority; no shell interpolation of model ids; duplicate
and prototype keys, oversized files, final-component symlinks, FIFOs, non-ASCII/control ids and limits above M0 rejected; the default
path keeps M0's target, gates, policy digest and limits.

### Verification

VERIFICATION_TOTALS

### Deviations from S0 Appendix A

1.  **`--member`, not `--model-member`**, as briefed: the documented public CLI syntax wins.
2.  **No `/slots` probe.** Appendix A specifies `GET /slots?fail_on_no_slot=1`. llama.cpp's source shows it wakes (single) or loads
    (router) a model, so it would violate the zero-side-effect requirement; capacity is reported unknown instead (§3).
3.  **`model-unconfirmed` and its policy.** Appendix A's eligibility was "healthy". M1 separates endpoint health from model residency and
    makes the operator choose (`unconfirmedModel`), because a healthy router says nothing about the model.
4.  **IPv4 loopback only.** Appendix A says "loopback". `[::1]` is refused because the shared recording proxy cannot connect to a
    bracketed IPv6 host; fixing that touches protected-evaluation code (§10).
5.  **Module placement.** Appendix A names `adapters/coordinator/model-relay.ts` as the existing relay; the generic relay is
    `adapters/sandbox/model-relay.ts` (shared with protected evaluation, unchanged). The new `adapters/coordinator/model-relay.ts`
    holds only the Coordinator's target and policy.
6.  **Extra closed refusals:** `member-unavailable`, `member-not-permitted` (Appendix A had `no-healthy-member`, `member-not-found`,
    `endpoint-not-loopback`), `model-identity-mismatch` and `inference-timeout`. `endpoint-not-loopback` is a configuration error
    (CLI exit 1 before any contact), not a runtime refusal, because a non-loopback local member cannot be loaded at all.
7.  **Provenance shape.** `selectedMemberId`, `fallbackOccurred` and `skippedMembers` are nested in `modelPool` with the selected
    model, endpoint, readiness, capacity flag, pool digest and measurements.

### Limits and unverified assumptions

*   **Not run against the operator's server.** Every claim about llama.cpp behaviour comes from its master sources and README, not
    from the operator's build `b12622`. In particular, that the streamed `model` equals the configured id (needed for pooled briefings
    not to be refused) is unverified on the live router; §9 says how to check it.
*   The fallback a router pool can perform is coarse (whole-router health), for the reasons in §3.
*   Trust limits carried from M0 are unchanged and not resolved: the local model server, installed OpenClaw/Node/bubblewrap and the
    kernel are trusted; model output is untrusted prose behind a wording backstop.
*   Multiple members may share one GPU; endpoint count is not capacity.

## 9. Operator smoke test (not run; needs the operator's authorisation)

Run against the server at `127.0.0.1:8091`. Step 2 sends only `/health` and `/props` (no inference, no catalog request). Step 3 runs one
real briefing (two completions, up to 2 × 2048 generated tokens) and, like M0's `endo coordinator brief`, lets the router load the
model if it is unloaded.

1.  Write the pool. Copy the example, delete the second (placeholder) member, and set `modelId` to the **canonical model name the
    router serves**, taken from the router's own configuration (its `--models-preset` INI or `--models-dir` file name), not an
    alias. M0 used `Inkling-2-Mini-Uncensored-AD-Q4_K`. Do not query `/models` to find it: on a router that request can run a pending
    reconciliation (§3).

    ```sh
    cp docs/designs/coordinator-model-pool.example.json ~/.config/endo-pool.json && $EDITOR ~/.config/endo-pool.json
    ```

2.  Zero-token observation. Expect `local-primary: model-unconfirmed (router-model-state-not-observed; llama.cpp-router)` and a
    selection with `capacityConfirmed: false`.

    ```sh
    endo coordinator pool check --pool ~/.config/endo-pool.json
    ```

3.  One pooled briefing on that member, then the M0 path for comparison:

    ```sh
    endo coordinator brief <root> --project <endo.project.id> --pool ~/.config/endo-pool.json --member local-primary
    endo coordinator brief <root> --project <endo.project.id>
    ```

Check `availability`, `modelPool.selectedModelId` and `modelPool.measurements`. A `model-identity-mismatch` refusal means the
streamed `model` field differs from `modelId`: llama.cpp reports the instance's model name (`meta->model_name`), so use the canonical
name rather than an alias. `member-unavailable` from step 3 with `model-unconfirmed` means the pool says `"unconfirmedModel": "refuse"`.

## 10. M2 handoff

M2 adds operator-approved hosted advisory inference (OpenRouter first). The seams it needs exist and nothing in M1 needs replacing:

1.  **Configuration.** `hosted-relay` members already parse with an `https` origin. M2 adds a credential *reference* (never a value in
    the file; e.g. an environment-variable or keyring name) and an explicit per-member operator approval, and lifts the
    `hosted-not-permitted` skip in `selectCoordinatorModelV0` only for approved members. Keep the closed schema: introduce `v1` rather
    than loosening `v0`.
2.  **Observer.** `EndoCoordinatorMemberObserverV0` is the seam: a hosted observer reports quota/rate signals as readiness without
    spending tokens, and must keep "unknown" distinct from "available" exactly as `capacity-unknown` does locally.
3.  **Relay.** The generic relay and recording proxy already support `https` upstreams with system roots. M2 needs a host-side
    credential injection step after admission (the sandbox must still never see a provider key), a target with an https origin, and
    a decision on `pinResponseModel` for providers that rewrite `model` (OpenRouter returns a provider-qualified id).
4.  **Disclosure.** A hosted member sends the prompt and the trimmed status view off the machine. That is a new disclosure the
    operator must approve per member; record it in provenance (`selectedEndpoint` already does).
5.  **Failover.** Keep `inferenceFailover: "never"` unless M2 proves a pre-dispatch failure (connection refused before any request
    byte was admitted) and adds a separate, tested contract for it; never fail over after a model refusal.
6.  **IPv6 loopback** needs a one-line fix in `record.ts` (strip brackets before `net.connect`) plus tests in the protected suites,
    if it is wanted at all.

## 11. S1 integration opportunities that need no M1 change

*   `observe-health` can call `probeLocalEndpointV0` per member directly: it is zero-token, bounded, returns a frozen
    `controller-observed` record with `observedAtMs`, and never throws for server behaviour.
*   `resources.json` can store `EndoCoordinatorMemberObservationV0` values as they are; `readiness` already separates `saturated`,
    `loading`, `model-unconfirmed` and `capacity-unknown`, which a single percentage would collapse.
*   `endo coordinator pool check` is already a one-shot JSON observation suitable for a manual or timer-driven tick.
*   S2 can pass a recorded-observation observer (with S1's freshness rule) to `selectCoordinatorModelV0` instead of probing live, since
    the observer is injected.
*   `poolSha256` lets a schedule record which pool revision an advisory brief used.
*   Endpoint count is not hardware capacity: members can share one GPU (the example's two members share `127.0.0.1:8091`). S1's resource
    model must attribute members to devices itself; M1 does not pretend to.
