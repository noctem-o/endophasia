# COORDINATOR-MODEL-POOL-001 (M1): a provider-agnostic local Coordinator Model Pool

*   **Status:** implemented on branch \`feat/coordinator-model-pool-001\` (draft PR). Local, read-only, advisory only.
*   **Baseline:** \`origin/main\` @ \`7666b0842\` (merge of #187; #184, #185 and #186 are ancestors, verified with \`git merge-base --is-ancestor\`).
*   **Contract:** [S0 Appendix A](coordinator-automation.md#appendix-a-separately-actionable-implementation-brief--m1-coordinator-model-pool-001).
    M0 is [COORDINATOR-RUNTIME-001](coordinator-runtime.md); its threat model and invariants carry over unchanged.
*   **Not in M1:** hosted inference, credentials, OpenRouter, scheduling, daemons, timers, operational harness routing, standing
    authorisations, assignment or store mutation, E4. See §7.

## 1. What changed

\`endo coordinator brief\` used one fixed binding: \`http://127.0.0.1:8091\`, model \`Inkling-2-Mini-Uncensored-AD-Q4_K\`. M1 lets the operator
name several local OpenAI-compatible endpoints in a file and has the Coordinator pick one by a zero-token health observation:

\`\`\`text
endo coordinator brief [<root> | --root dir] --project <id> [--pool <config.json> [--member <memberId>]] [--quiet]
endo coordinator pool check [--pool <config.json>] [--quiet]
\`\`\`

Without \`--pool\`, \`brief\` runs the M0 path itself: same target, same \`/props\` router gate, same relay policy (digest-identical, tested),
same wire behaviour, same output. \`--member\` without \`--pool\` is a usage error. \`pool check\` without \`--pool\` observes M0's endpoint
as a one-member pool. The model a briefing uses is now a parameter of one admitted attempt; the Coordinator's project scope, its single
\`endophasia_status\` tool, its sandbox, its evidence requirements and its lack of authority do not depend on it.

| Layer (S0 §2) | Module | Role |
| :--- | :--- | :--- |
| Configuration | \`protocol/coordinator-model-pool.ts\` | Closed \`endo.coordinator-model-pool.v0\` schema, loopback origin rule, member ordering |
| Runtime contract | \`runtime/contracts/coordinator-model-pool.ts\` | Readiness vocabulary, observer seam, \`selectCoordinatorModelV0\`, provenance and check types |
| Observation | \`adapters/coordinator/model-pool-probe.ts\` | \`probeLocalEndpointV0\`: bounded GET-only health observation |
| Relay | \`adapters/coordinator/model-relay.ts\` (+ \`openclaw.ts\`, \`wire.ts\`) | Frozen per-briefing target; Coordinator policy over the unchanged generic relay |
| Host orchestration | \`adapters/coordinator/model-pool.ts\` | Pool file reader, \`pool check\`, pooled briefing substrate |
| CLI | \`cli/coordinator.ts\`, \`cli/help.ts\` | \`--pool\`, \`--member\`, \`pool check\` |
| Contract | \`runtime/contracts/coordinator-brief.ts\` | Optional \`modelPool\` provenance; five new closed refusals |

## 2. Configuration (\`endo.coordinator-model-pool.v0\`)

[\`coordinator-model-pool.example.json\`](coordinator-model-pool.example.json) is an illustrative pool for the existing local endpoint.
It carries no credential and deliberately does not guess the operator's model identifier: replace the placeholder with the exact \`id\`
that \`GET /models\` lists (§9).

\`\`\`json
{
  "schemaVersion": "endo.coordinator-model-pool.v0",
  "selection": { "fallback": "availability", "unconfirmedModel": "permit" },
  "members": [{
    "memberId": "local-primary", "kind": "local-openai-compat", "endpoint": "http://127.0.0.1:8091",
    "modelId": "REPLACE-WITH-THE-EXACT-id-FROM-GET-models", "priority": 100,
    "maxPromptBytes": 8192, "maxOutputTokens": 2048, "timeoutMs": 135000, "advisoryOnly": true
  }]
}
\`\`\`

Every object is closed (an unknown key, including \`apiKey\` or \`__proto__\`, is refused) and every field is required, so nothing is
defaulted silently. The file must be a regular file whose last component is not a symbolic link, at most 64 KiB, UTF-8, and must not
repeat a key at any depth (JSON parsers disagree about which duplicate wins).

| Field | Rule |
| :--- | :--- |
| \`selection.fallback\` | \`availability\` (an ineligible member lets the next eligible one be used) or \`none\` (only the first in order is considered) |
| \`selection.unconfirmedModel\` | \`permit\` or \`refuse\` a member whose endpoint is healthy but whose model is not observed loaded (§3) |
| \`memberId\` | 1–64 of \`[a-z0-9-]\`, no leading/trailing hyphen, unique |
| \`kind\` | \`local-openai-compat\`; \`hosted-relay\` is parsed for M2 and never contacted in M1 |
| \`endpoint\` | local: exactly \`http://127.0.0.1:<1..65535>\`; hosted: an \`https\` origin written exactly as its canonical origin |
| \`modelId\` | 1–256 printable ASCII, no spaces; sent in every request and required verbatim in the server's listing |
| \`priority\` | integer 0–1000, higher preferred |
| \`maxPromptBytes\` | 1024–8192 (M0's 8192 is the ceiling) |
| \`maxOutputTokens\` | 256–2048 (M0's 2048 is the ceiling) |
| \`timeoutMs\` | 5000–135000 (M0's 135 s agent deadline is the ceiling) |
| \`advisoryOnly\` | must be \`true\` |

Two members with the same \`endpoint\` and \`modelId\` are refused as ambiguous; the same endpoint with different models is allowed (a
llama.cpp router serves several). A pool may only lower M0's bounds. Raising them (for longer reasoning, say) needs its own evidence.

**Endpoint rule.** The local rule is a whole-string match, not a URL-parser decision: \`localhost\`, \`127.1\`, \`0x7f.0.0.1\`, \`0177.0.0.1\`,
\`2130706433\`, \`127.0.0.2\`, \`0.0.0.0\`, any IPv6 form (\`[::1]\`, \`[::ffff:127.0.0.1]\`), a trailing dot or slash, a path, query, fragment,
userinfo, \`https\`, upper-case scheme, leading zeros and out-of-range ports are all refused before anything is opened. Nothing is
resolved through DNS. IPv6 loopback is refused because M0's recording proxy (\`adapters/openai-proxy/record.ts\`) passes the URL
\`hostname\` (\`[::1]\`, bracketed) straight to \`net.connect\` and cannot reach it; changing the shared proxy is out of scope (§8).

## 3. Health observation (\`probeLocalEndpointV0\`)

The probe sends only GET requests, never a completion, never a credential, never \`?model=\`, \`?autoload=\` or \`?reload=\`. Every request
shares one 3 s deadline, has an 8 KiB head and 256 KiB body bound, \`Connection: close\`, no agent pooling, a \`lookup\` that refuses to
resolve, and a check on connect that the peer is \`127.0.0.1\` on the configured port. A 3xx is refused (\`probe-refused\`/\`redirect\`), never
followed. It never throws for anything a server does; every outcome is one of the readiness values below.

| Step | Request | Why it is passive (llama.cpp \`tools/server\`, read at master) |
| :--- | :--- | :--- |
| 1 | \`GET /health\` | Answered by the server itself; listed as exempt from idle reload. 200 healthy; 503 \`Loading model\` is \`loading\`. |
| 2 | \`GET /props\` (no \`model\`) | The router's own properties (\`get_router_props\` with an empty name) or a single server's; exempt. Identifies router vs single and \`build_info\`. 404 means a non-llama.cpp server. |
| 3 | \`GET /models\` (llama.cpp) or \`GET /v1/models\` | Router listing (\`get_router_models\`), computed without loading; exempt. Requires exactly one entry whose \`id\` equals \`modelId\`. |
| 4 | \`GET /slots?fail_on_no_slot=1\` | **Only** for a single-model llama.cpp server that reports \`is_sleeping: false\`. 200 idle slot, 503 saturated. |

**Why the router is never asked for slots.** In router mode \`/slots\` is routed through \`proxy_get\` (\`server.cpp\`:
\`routes.get_slots = models_routes->proxy_get\`), which, with the default \`--models-autoload\`, calls \`models.ensure_model_ready(name)\`:
a slot probe for an unloaded model **loads it**. \`?autoload=false\` exists in current sources but cannot be confirmed for the operator's
build (\`b12622\`) without testing against the live router, which is out of scope, and a check-then-probe would still race an eviction.
So a router member's capacity is always \`capacity-unknown\`. \`/slots\` is also not on the idle-reload exemption list, which is why a single
server is asked only when it says it is awake; a server that does not report \`is_sleeping\` is not asked.

| Readiness | Meaning | Eligible |
| :--- | :--- | :--- |
| \`ready\` | Model present and an idle slot observed (single-model llama.cpp only) | yes; the only state with \`capacityConfirmed: true\` |
| \`capacity-unknown\` | Model observed loaded; slots not observable without side effects | yes, with \`capacityConfirmed: false\` |
| \`model-unconfirmed\` | Healthy, but the model is listed \`unloaded\`/\`sleeping\`, or no listing exists | only with \`unconfirmedModel: "permit"\` |
| \`loading\` | Server or model loading | no |
| \`saturated\` | \`/slots\` reports no idle slot | no |
| \`model-unavailable\` | Exact id not listed, load \`failed\`, \`downloading\`/\`incomplete\` | no |
| \`unhealthy\` | \`/health\` (or a later step) answered with an error status | no |
| \`unreachable\` | Connection failed, deadline, cancellation | no |
| \`probe-refused\` | Redirect, oversized or malformed answer, unexpected peer, unknown router status value | no |

A closed \`detail\` word (e.g. \`slots-not-probed-router\`, \`model-sleeping\`, \`no-idle-slot\`) says how each was reached, and the observation
records every request and status. An observation is a fact at one instant with \`basis: "controller-observed"\`; it says nothing about
whether the next inference request will succeed.

## 4. Selection (\`selectCoordinatorModelV0\`)

Members are ordered by \`priority\` descending, then \`memberId\` by code unit, so the file's member order never matters. Selection
observes lazily: a member is probed only when every member above it was skipped, and a hosted member is skipped as \`hosted-not-permitted\`
without being observed. The first eligible member is selected; \`fallbackOccurred\` is true when any member above it was skipped. With
\`fallback: "none"\` only the first member is considered. All skips are recorded in order with their reason.

\`--member <id>\` observes that member alone. If it is missing, hosted or ineligible, the briefing is refused (\`member-not-found\`,
\`member-not-permitted\`, \`member-unavailable\`); another member is never substituted and never contacted. The spec's \`--model-member\`
spelling is not accepted; \`--member\` is the documented public syntax (\`--model-member\` gets the usage error).

**Selection and inference are separate.** Fallback happens only before inference is dispatched. Once the selected member's target is
handed to the M0 runner, its result is final: a refusal (\`tool-expansion-suggested\`, \`ungrounded\`, …), a provider error
(\`model-unavailable\`), a truncation or a timeout is returned as unavailable, and no other member is tried. This is deliberate: a failure
after dispatch is ambiguous (the model may have produced output, the status may have been delivered), and replaying a partly completed
conversation on another model would let fallback launder a refusal. Provenance carries the constant \`inferenceFailover: "never"\`.
A pre-dispatch connection failure is the one case that could safely fail over; M1 does not, and §10 hands that to M2 with the
condition it would need.

## 5. Relay generalisation

The briefing's target is built once from the selected member and frozen:
\`{ origin, model, maxOutputTokens, maxPromptBytes, timeoutMs, pinResponseModel }\`. The generic relay
(\`adapters/sandbox/model-relay.ts\`, shared with protected evaluation) is unchanged; \`adapters/coordinator/model-relay.ts\` only builds the
Coordinator policy for a target and starts the relay with the wire gates. Relative to M0:

*   **Unchanged:** bubblewrap profile and mounts, empty network namespace with only the loopback bridge, scratch HOME, no inherited
    skills/plugins/tool search, exactly one \`endophasia_status\` definition, per-turn synthetic bearer, the exact request gate (tool set,
    \`stream\`, sampling parameters, no \`n_predict\`/\`max_completion_tokens\`), tool-call/tool-result pairing with the observed id
    normalisation, one route, 512 KiB requests, 8 MiB transfer, 4/8 connections, 2 exchanges, no redirect (only a 200 event stream is
    admitted), answer backstop, cleanup.
*   **Parameterised by the target:** upstream origin, model (relay policy, OpenClaw provider config and \`--model\`), generation bound
    (relay policy, wire, plugin payload override, OpenClaw \`maxTokens\`), prompt bound, and the agent deadline (\`--timeout\`, and the
    process kill at deadline + 20 s, exactly M0's 135/155 s for M0's target).
*   **New for pool members only:** a streamed chunk whose \`model\` names another model is refused as \`model-identity-mismatch\`. It is
    off for M0's target so the default path's wire behaviour is byte-for-byte unchanged.
*   **New option:** an external \`AbortSignal\`. A cancelled briefing is \`unavailable\` whatever arrived; the result is computed only after
    the sandbox exits and the relay is closed, so nothing late can be accepted.

**Reasoning and truncation.** OpenClaw runs with \`--thinking off\` and the model is declared \`reasoning: false\`; no backend-specific
reasoning-control parameter is added, so backends that lack one are unaffected. A completion whose only output is \`reasoning_content\`
has empty answer text and cannot be available (measured: OpenClaw exits non-zero, giving \`runtime-unavailable\`; the relay's own
\`ungrounded\` check stands behind it). \`finish_reason: "length"\` is \`generation-limit\`.

## 6. Provenance and measurements

A pooled result carries \`modelPool\` (absent on the M0 path):

\`\`\`json
{ "schemaVersion": "endo.coordinator-model-pool-provenance.v0", "poolSha256": "…",
  "selectionMode": "priority", "requestedMemberId": null,
  "selectedMemberId": "secondary", "selectedModelId": "model-b", "selectedEndpoint": "http://127.0.0.1:…",
  "selectedReadiness": "capacity-unknown", "capacityConfirmed": false,
  "fallbackOccurred": true, "skippedMembers": [{ "memberId": "primary", "reason": "saturated" }],
  "inferenceFailover": "never",
  "measurements": { "observationElapsedMs": 4, "inferenceElapsedMs": 8123, "promptTokens": 1840,
                    "completionTokens": 612, "exchanges": 2, "failureCategory": null } }
\`\`\`

\`runtime.model\` is the member's \`modelId\`, and both the pooled substrate and \`briefFromCoordinatorSubstrateV0\` refuse an available
result whose \`runtime.model\` differs from \`modelPool.selectedModelId\`. Evidence digests (\`readAtMs\`, \`projectionSha256\`,
\`modelViewSha256\`) are unchanged. Token counts are the server's self-reported \`usage\`, summed over exchanges that reported it; unknown
measurements are \`null\`. Nothing is persisted: no inference journal, no new store. A selection refusal yields
\`runtime: { harness, provider: "none", model: "none" }\`, no answer and no evidence.

New closed refusals on \`EndoCoordinatorBriefRefusalV0\`: \`no-healthy-member\`, \`member-not-found\`, \`member-unavailable\`,
\`member-not-permitted\`, \`model-identity-mismatch\`. Configuration errors are not refusals: the CLI exits 1 with a message naming the file
and the first problem, before any endpoint is contacted.

## 7. Acceptance tests

All in \`tests/coordinator-model-pool.test.ts\` against deterministic fakes on ephemeral \`127.0.0.1\` ports. The fake llama.cpp router
counts as a "load" any request the real router could turn into one (any POST, any \`?model=\`/\`?autoload=\`/\`?reload=\`, any router
\`/slots\`), so "zero loads" is checked against router semantics, not just against our own request list.

| ID | Evidence |
| :--- | :--- |
| AT01 | M0 target, inference settings and relay policy digest equal M0's literal values; M0 wire still admits any response model; the existing \`coordinator-brief\` suite passes unchanged, including its opt-in installed-OpenClaw cases (M0 path, 6 cases). |
| AT02 | 31 malformed documents refused by the parser; 8 unsafe files (missing, directory, symlink, oversized, not JSON, repeated nested and top-level keys, bad limit) refused by the reader and by \`pool check\` (exit 1, empty stdout); the member's listener sees **zero connections**. \`--member\` misuse diagnostics. |
| AT03 | Highest priority, \`memberId\` tie-break, independent of three file orders; only the selected member is observed. |
| AT04 | Six ineligible primary states each fall back with exact \`skippedMembers\`; end-to-end, the saturated primary's server never gets a completion and the runner receives only the secondary's frozen target; full provenance and measurements asserted. |
| AT05 | All members unreachable: typed \`no-healthy-member\`, \`model: "none"\`, no answer, no evidence, runner never called. |
| AT06 | Explicit saturated member refused \`member-unavailable\`; the higher-priority healthy member receives **zero connections**; unknown and hosted members refused. |
| AT07 | 29 endpoint spellings refused (IPv4 short/hex/octal/decimal forms, other 127/8 and 0.0.0.0, IPv6 incl. mapped, userinfo confusion, trailing dot/slash, path, query, fragment, https, ports). Listeners on the same port at \`127.0.0.1\` **and** \`::1\` receive zero connections when the CLI is given \`localhost\`, \`[::1]\`, \`127.1\`, decimal and trailing-slash forms. A \`/health\` 307 is not followed (target sees zero connections). Through the real relay, an upstream 307 is refused and its \`Location\` never contacted. |
| AT08 | 17 server shapes: exact request paths asserted, all GET, no \`Authorization\`, router never asked for \`/slots\`, zero loads and zero completions; \`pool check\` CLI over a router and a single server likewise. |
| AT09 | A healthy router with the model unloaded, sleeping, loading, failed, downloading or unlisted is never \`ready\`; \`capacityConfirmed\` is true only after an observed idle slot; \`pool check\` reports \`capacityConfirmed: false\` for a router selection. |
| AT10 | Probe: silent endpoint times out at its deadline and its late answer is ignored; cancellation; refused port; oversized body and head; interrupted body; non-HTTP bytes; malformed listings. Real relay: interrupted stream yields no completed response; a 9 MiB response is cut at the 8 MiB transfer bound; foreign-model and \`n_predict: -1\` requests never reach the upstream. Installed OpenClaw (opt-in): a hanging upstream and a cancelled slow stream both end unavailable within bound, with no further completion afterwards. |
| AT11 | Pooled wire refuses a response naming another model; through the real relay the answer never reaches the agent; a runner reporting another model gets \`model-identity-mismatch\`; the contract refuses an available result inconsistent with its provenance; a listing with only \`Model-A\`/\`model-a:Q4\` is \`model-unavailable\`. Installed OpenClaw (opt-in): substituted final response refused. |
| AT12 | For a member with a lower generation bound: extra tool, M0's larger \`max_tokens\`, generated \`exec\`, foreign project, path-traversal selector, extra selector key, fabricated result, wrong call id. |
| AT13 | Reasoning-only completion has empty answer text; \`length\` finish is visible. Installed OpenClaw (opt-in): reasoning-only ends unavailable and truncation ends \`generation-limit\`. |
| AT14 | Five post-dispatch outcomes (\`tool-expansion-suggested\`, \`model-unavailable\`, \`generation-limit\`, \`ungrounded\`, \`tool-not-permitted\`) are final; the next member gets **zero connections**. |
| AT15 | A real fixture store and project are fingerprinted before and after \`pool check\` (in-process and CLI), a successful pooled briefing and an explicit refusal; unchanged. \`pool check\` takes no store at all. |
| AT16 | Hosted members (one pointing at a live listener) are skipped unobserved; explicit hosted member refused; a pool of only hosted members refuses; the listener gets zero connections; \`coordinatorTargetFromMemberV0\` and the probe refuse hosted members. |

The opt-in installed-OpenClaw cases run with \`ENDO_COORDINATOR_OPENCLAW=$HOME/.local/bin/openclaw\` (bubblewrap required) and use the
same deterministic fake provider; they never contact a model server.

REVIEW_AND_VERIFICATION_PLACEHOLDER

## 9. Operator smoke test (not run; needs the operator's authorisation)

These steps use the running server at \`127.0.0.1:8091\`. Steps 1–3 are GET requests on the exempt routes and request no inference;
step 4 performs one real briefing (two completions, up to 2 × 2048 generated tokens) and, with \`"unconfirmedModel": "permit"\`, will load
the model if it is unloaded, exactly as M0's \`endo coordinator brief\` already does.

\`\`\`sh
# 1. The exact model id to put in the pool (passive; never add ?model= or ?reload=).
curl -s --max-time 3 http://127.0.0.1:8091/models | jq -r '.data[] | "\(.id)\t\(.status.value)"'
# 2. Write the pool: copy the example and set modelId to that exact id.
cp docs/designs/coordinator-model-pool.example.json ~/.config/endo-pool.json && $EDITOR ~/.config/endo-pool.json
# 3. Zero-token observation (expect capacity-unknown / slots-not-probed-router for a loaded router model).
endo coordinator pool check --pool ~/.config/endo-pool.json
# 4. One pooled briefing, explicitly on that member (compare with the M0 path: endo coordinator brief <root> --project <id>).
endo coordinator brief <root> --project <endo.project.id> --pool ~/.config/endo-pool.json --member local-primary
\`\`\`

What to look for in step 4: \`availability\` and \`modelPool.selectedModelId\`. A \`model-identity-mismatch\` refusal means the server's
streamed \`model\` field differs from the configured \`modelId\`: llama.cpp sets it to the instance's model name (\`meta->model_name\`, the
first alias or the file-derived name), so configure the canonical \`id\` from step 1, not an alias. Removing the second, placeholder
member from the example (or giving it a real id) avoids a \`model-unavailable\` skip in \`pool check\`.

## 10. M2 handoff

M2 adds operator-approved hosted advisory inference (OpenRouter first). The seams it needs exist and nothing in M1 needs replacing:

1.  **Configuration.** \`hosted-relay\` members already parse with an \`https\` origin. M2 adds a credential *reference* (never a value in
    the file; e.g. an environment-variable or keyring name) and an explicit per-member operator approval, and lifts the
    \`hosted-not-permitted\` skip in \`selectCoordinatorModelV0\` only for approved members. Keep the closed schema: introduce \`v1\` rather
    than loosening \`v0\`.
2.  **Observer.** \`EndoCoordinatorMemberObserverV0\` is the seam: a hosted observer reports quota/rate signals as readiness without
    spending tokens, and must keep "unknown" distinct from "available" exactly as \`capacity-unknown\` does locally.
3.  **Relay.** The generic relay and recording proxy already support \`https\` upstreams with system roots. M2 needs a host-side
    credential injection step after admission (the sandbox must still never see a provider key), a target with an https origin, and
    a decision on \`pinResponseModel\` for providers that rewrite \`model\` (OpenRouter returns a provider-qualified id).
4.  **Disclosure.** A hosted member sends the prompt and the trimmed status view off the machine. That is a new disclosure the
    operator must approve per member; record it in provenance (\`selectedEndpoint\` already does).
5.  **Failover.** Keep \`inferenceFailover: "never"\` unless M2 proves a pre-dispatch failure (connection refused before any request
    byte was admitted) and adds a separate, tested contract for it; never fail over after a model refusal.
6.  **IPv6 loopback** needs a one-line fix in \`record.ts\` (strip brackets before \`net.connect\`) plus tests in the protected suites,
    if it is wanted at all.

## 11. S1 integration opportunities that need no M1 change

*   \`observe-health\` can call \`probeLocalEndpointV0\` per member directly: it is zero-token, bounded, returns a frozen
    \`controller-observed\` record with \`observedAtMs\`, and never throws for server behaviour.
*   \`resources.json\` can store \`EndoCoordinatorMemberObservationV0\` values as they are; \`readiness\` already separates \`saturated\`,
    \`loading\`, \`model-unconfirmed\` and \`capacity-unknown\`, which a single percentage would collapse.
*   \`endo coordinator pool check\` is already a one-shot JSON observation suitable for a manual or timer-driven tick.
*   S2 can pass a recorded-observation observer (with S1's freshness rule) to \`selectCoordinatorModelV0\` instead of probing live, since
    the observer is injected.
*   \`poolSha256\` lets a schedule record which pool revision an advisory brief used.
*   Endpoint count is not hardware capacity: members can share one GPU (the example's two members share \`127.0.0.1:8091\`). S1's resource
    model must attribute members to devices itself; M1 does not pretend to.
