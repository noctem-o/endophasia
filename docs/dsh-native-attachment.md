# DeepSeek Harness native attachment: conformance and architecture study

**Status:** study (PR 1). It decides how a later PR should attach Endophasia to DeepSeek Harness (DSH) and states, with evidence,
what that attachment can and cannot observe. It adds **no adapter**, changes no protocol, runtime, store, Pi or ACP behaviour and
no Studio code. Everything it adds lives in `research/dsh-native/`, `tests/dsh-native-study.test.ts` and this page.

The question: *can Endophasia attach to DSH through a native, high-fidelity observation interface, preserving more than ACP v1/v2,
while staying harness-neutral inside?* The answer, in one paragraph: **yes, through the durable Session log, read cold.** The log is
an append-only, versioned, lossless JSON record that already contains what ACP drops (attempts, retries, per-call usage, the
request configuration, the authority envelope, ancestry, structured failures, ordering). A live Cordis observer adds nothing the log
does not hold, is *structurally incomplete* (it never sees restored history or resume markers) and would run code inside the host.
The smallest defensible architecture is therefore a read-only **cold importer of closed sessions** (option B), with the live
observer (A) and the SDK (C2) deferred. ACP stays the interoperability path (C1) and is unchanged.

## 1. What was verified, and against what

Evidence is labelled throughout by basis. **RUNTIME**: observed in a real DSH runtime in this study. **UPSTREAM**: a fixture
committed by DSH (MIT), referenced, not copied. **SOURCE**: read in the DSH source at the pinned commit. **SYNTHETIC**: built by code
from a RUNTIME fixture (`research/dsh-native/synthetic.ts`) and said so wherever it is used.

| Item | Observed |
| --- | --- |
| DSH checkout | `~/deepseek-harness`, commit `687f282e8625c6b8d11ff58211a90524be2e4317` (`dsh-v0.2.1-rc.2`, version 0.2.1-rc.2), working tree clean, MIT |
| Runtime entry point | `node --import tsx/esm apps/cli/src/bin.ts` (the `pnpm dsh` script); **no global `dsh`**, no build step needed to run from source |
| Session format | `SESSION_FORMAT_VERSION = 4`; latest *released* format 4 (tag `dsh-v0.2.0-rc.2`, `docs/session-format-status.md`) |
| Running instance | one `pnpm dsh web` process was running. **Not touched**: its process id, uptime and listening ports were checked before and after, and nothing was attached to it |
| Model route | llama.cpp server on `127.0.0.1:8080`; `/v1/models` lists the id **`qwen38-local`** (not the `qwen3.8-27b` alias in the brief); DSH reaches it as provider `local`, adapter `llm-pi-ai`, `openai-completions` |
| Profile composition | a single user profile, `web`: the shipped base and web bundles, three experimental bundles (agent team, voice input, inspector) and four third-party plugin bundles (`dsh-context` 0.74.0, `dsh-genui` 0.3.1, `dsh-mnemon` 0.5.34, `pi2dsh` 0.27.0). Only its composition was read, never its settings values |
| Real sessions | two persisted sessions under the user's DSH home. **Never read**: only their existence, the log format generation and that each has a `session.lock` were looked at; sizes and modification times were compared before and after to show they were untouched |
| Credentials | `~/.dsh/.credentials.yaml` exists; never read |

Local configuration and historical session files are treated as sensitive: nothing in this study quotes them, and the committed
fixtures come only from scratch runs that used a throwaway home (below).

## 2. The native observation surfaces, and how stable each is

DSH is "an all-plugin Cordis agent harness". Its own rule (`AGENTS.md`): *public APIs are pre-stable; update every consumer*, while
**released Session data** carries compatibility obligations: committed format generations are never moved, overwritten or deleted,
and a format change needs an adjacent migration. That asymmetry decides the architecture: the **data format is the most stable
surface DSH has; its APIs are not.**

| Surface | What it is | Stability | Notes |
| --- | --- | --- | --- |
| Persisted Session log, format 4 | Per-session directory with `session.v4.jsonl[.zstd]` and an empty `session.lock`; header row then one JSON row per durable event | **Released format**, with immutable earlier generations and migration obligations | Type fingerprints in `docs/persistence-schema.json` (65 roots: header, envelope, 62 event types) are the real contract. V4 may still take *compatible* additions (`docs/session-format-status.md`), so the version number alone is not a compatibility gate |
| `session/event` (Cordis `emit`) | Post-commit feed of every appended event, scope-filtered per agent | **Pre-stable API** (`@deepseek-ai/dsh-session` is published, non-private, with exports) | Fires after the in-memory append; the persistence plugin is one more listener in the same dispatch, and the write becomes durable only at `session/flush`. Observer failures are contained. See §3 |
| `ctx.sessions` / `Session.events` | Live in-memory Session store | Pre-stable API | Needs code inside the host |
| `session-query` service | List/filter/read live-first, cold read with in-memory *interrupted* closers | Pre-stable API | In-process only; not a standalone reader |
| `session/flush` | Parallel durability checkpoint | Pre-stable API | The turn loop does **not** await it at turn boundaries |
| Web `/export` ZIP | User-driven download of a session tree: canonical `session[.vN].jsonl`, `subagents/<id>/…`, `media/`, `files/`; flush barrier first; **no manifest** | Product feature | A snapshot that avoids the zstd and torn-tail problems; the JSONL entries sit inside a deflated ZIP, so reading it needs a ZIP reader |
| Headless `--json` | NDJSON projection: `session`, `status`, `text`, `thinking`, `tool_call`, `tool_result`, `final` | Product interface | **Lossy by design**: commit-point emission hides retried attempts; strings capped at 8 KiB |
| SDK JSON-RPC (`dsh-sdk-protocol`, `dsh-sdk-jsonrpc-server`) | Stdio server forwarding **every native session event** as `session.event` notifications | Pre-stable API | Native fidelity, but the client spawns and drives the runtime; `session/resume` takes ownership and appends closers. This is a control path |
| ACP (`dsh-acp`) | Standard ACP **v1**, automation-only | Standard protocol | Updates are *derived from committed* `assistant/message`, `tool/call`, `tool/result` (`packages/acp/acp/src/updates.ts`). No v2 |
| Experimental packages (`agent-team`, `hook-protocol`, `tool-workflow`) | Plugin-merged events (`team/*`, `hook/*`, `tool-workflow/*`) | **Experimental**: "not a product-support commitment" | Payloads can change without a format bump |
| `agent/assistant-stream`, `agent/error`, `agent/status`, `agent/inbox/inserted`, `…/claimed`, `…/discarded` | Live Cordis events | Internal / pre-stable | Process-local; not persisted (`agent/inbox/spliced` is persisted) |
| `agent/request`, `agent/request-error`, `tools/pre-execute`, `tools/post-execute`, `approval/request`, … | **Waterfall** hooks | Internal extension points | A listener can *change* behaviour. An observer must never register here |

**Emission, recording, persistence and recovery are four different things** and the study keeps them apart:

* *Emission*: `session/event` announces a committed append. It is `emit`-mode, so an observer cannot veto or alter it.
* *Upstream persistence*: a persistence plugin is just another `session/event` listener that queues a background write; it becomes
  durable at `session/flush`. The feed therefore **runs ahead of the disk**, and a crash loses what was committed but not flushed.
* *Endophasia-side recording*: what an Endophasia adapter writes to its own event store. Nothing is recorded by DSH on Endophasia's
  behalf; DSH's `seq` and `time` are source facts, never Endophasia's `sequence`/`at`.
* *Replay recovery*: on resume DSH restores the stored log, closes an orphaned last turn with synthetic closers, and continues. That
  is a DSH action that *writes*; a cold reader must never trigger it.

## 3. What a real DSH runtime demonstrated

A scratch run, never the user's instance. `research/dsh-native/reproduce.ts` builds, per scenario, a throwaway `DSH_HOME` and
`HOME`, a workspace holding `notes.txt`, an **empty environment** (a placeholder key stands in for the keyless local server),
permission mode `read-only`, telemetry disabled, and a profile patch that disables every row able to reach another network or run
commands (DeepSeek routes and account, session-log upload, package inventory, session-title LLM, telemetry, web tools, bash, jobs,
subagents including forks, workflows, the plugin manager, the API gateway and MCP resources). A passive observer plugin registers only on emit-mode events (never on a waterfall hook, never on the awaited `session/flush`). Egress was **measured** for the stub scenario by running the whole harness inside an empty network namespace (`unshare -rn`): it completes, so it needs no network. For the Qwen scenarios the only intended egress is the loopback model route; that was designed, not measured. Read-only mode blocks *writes*; it does not confine the model's reads, so the prompts were fixed and benign and a hostile prompt would not have been contained by the permission mode alone.

| Case | Capture | What it proves |
| --- | --- | --- |
| `tool-read` (Qwen) | One turn, two steps, one `read` call, answer `3`, exit 0; 21 events | The committed vocabulary, ordering and usage; the live feed is **JSON-equal** to the persisted log (after re-serialising); dozens of streaming chunk frames were visible live and are kept only inside the messages |
| `no-key-error` (Qwen route) | The model adapter refuses before sending anything, for want of a key; turn ends `error` with `PI_AI_ERROR` (a client-side failure, not a provider refusal) | A failure is a structured reason on `turn/end` plus a committed `assistant/attempt`; `agent/error` fired live and is *not* separately durable |
| `stub-retry` (**deterministic stub provider**, real runtime) | First request fails `RATE_LIMIT` 429, second succeeds | `assistant/attempt` → `llm/retry` → `llm/retry-started` → `assistant/message`, linked by `retryId`. **The `--json` stream shows none of it** |
| `crash-killed` (Qwen, SIGKILL of the study's own child) | 13 events on disk, turn and step open | The partial assistant output (dozens of chunk frames) exists in **no durable form**: not in the log, not as an event on `session/event`; only the transient `agent/assistant-stream` frames carried it |
| `crash-resumed` (Qwen) | Resume with `--session-id` appends `step/end` and `turn/end` reason `interrupted`, then an untagged `session/end-seed`, then turn 2 | Recovery is an upstream *write*. The closers' `time` is **copied from the last event** (the title), seconds before the resume that wrote them. Seqs 0 to 15 were never announced on `session/event` |

What the experiment did *not* produce (and the evidence is therefore weaker): a real compaction, a fork or a subagent child, an
approval ask, a cancellation, a real provider retry, and a crash that tears a write (SIGKILL landed between flushes). Those rest on
SOURCE, UPSTREAM fixtures (`apps/cli/tests/profiles/headless/tests/expected/…`, MIT, cited by path and sha256 in
`provenance.json`) and SYNTHETIC logs.

**A concurrent reader** sampled the log every 15 ms during an earlier ad-hoc killed run (not part of the reproducible harness): it saw
two states (7 rows, then 14 rows), each a whole number of complete frames; no torn state was seen. That is one sample of a short
run, not a proof; torn tails are handled by the frame scanner and tested exhaustively on SYNTHETIC cuts (every byte offset of the last frame).

**How the fixtures were made.** All five cases in `fixtures/real/` were produced by the committed `reproduce.ts` (the stub case with no
model, the others against the local Qwen server), decoded by `log.ts`, and sanitised by `sanitise.ts`. The model's wording and token
counts therefore differ between runs; only the stub case is reproducible structure-for-structure by the opt-in test.

### Findings that change the design

1. **The log is the superset; the live feed is a subset.** JSON-equal for events appended after attach; absent for everything
   before it. A live-only observer cannot reconstruct a session or see resume-time closers.
2. **DSH synthesises history on resume** (`interrupted` closers, an untagged end-seed) with a *copied* timestamp. Those are DSH's
   words about a crash, not an observation, and must not become `lifecycle.interrupted`, which Endophasia reserves for its own
   observation of a runtime exit.
3. **Names collide.** A DSH *turn* is an Endophasia *run* (open input to settlement); a DSH *step* (one model call plus its tools)
   is an Endophasia *turn*. Mapping by name would shift every count by one level.
4. **"Request header" is not an HTTP header.** `request/header` is the call configuration and tool schemas for that request. HTTP
   request headers, endpoint and raw provider bodies are not logged anywhere.
5. **Tool timing is not available.** There is no tool-start event; `tool/call` is committed with the model message. The call-to-
   result interval includes queueing and approval wait.
6. **Usage is per assistant message and optional field by field.** Absent counts are absent, not zero; `EndoTrajectoryTokensV0`
   requires `cacheRead`, `cacheWrite` and `totalTokens`, so the trajectory `tokens` entry would be `UNAVAILABLE` whenever one is
   missing (the observed second message has no `cacheWriteTokens`).
7. **The log is a full transcript.** System prompt, injected environment sections, tool arguments, file contents and diffs are
   verbatim. Any importer must digest at the read boundary.

## 4. Native versus ACP versus Endophasia

The full table is `research/dsh-native/matrix.json` (20 rows; each of DSH's **62 event types appears in exactly one row**, enforced
by a test) with, per row: native availability (persisted and live), DSH's ACP v1 equivalent, ACP v2 (not offered), Endophasia's
existing representation, preserved and lost information, evidence basis, confidence, hazards and unavailable fields. Verdicts use
the vocabulary of `adapters/acp/loss.ts` (`EXACT`, `QUALIFIED`, `LOSSY`, `UNREPRESENTABLE`). The condensed view:

| Capability | Native log | DSH ACP v1 | Endophasia today | Verdict (native → Endophasia) |
| --- | --- | --- | --- | --- |
| Turn boundaries and reasons | all seven reasons, abort cause, structured failure | none | `lifecycle.run-*` | QUALIFIED (naming collision; queued follow-ups open new DSH turns; `blocked`/`max-tokens` have no Endophasia outcome: Pi's rule sends other stop reasons to `run-completed` with the reported reason, so PR 2 must decide, not default) |
| Step boundaries | yes | none | `lifecycle.turn-*` | QUALIFIED |
| Assistant output and usage | content, per-call usage, provider/model/response id, chunk timing | message and thought chunks; usage is **context occupancy**, not per-call | `message.completed`, usage layer | QUALIFIED (optional counts) |
| Failed attempts and retries | `assistant/attempt`, `llm/retry*` | none | Pi `retry.*` only | QUALIFIED |
| Tool calls and results | `callId`, raw argument string, error name/code/reason, tool meta | `tool_call` / `tool_call_update` (no code/meta) | `tool.started/finished`, keyed digests | QUALIFIED (digest over canonical JSON; unparseable arguments → `UNAVAILABLE`) |
| Request configuration | full snapshot per request epoch | model and effort options only | `configuredModel` | QUALIFIED |
| Authority envelope | preset, sandbox mode, policy, ask/decision pairs | live permission request only | `authority-decision` | QUALIFIED (observation, never authorisation) |
| Fork, seed, subagent ancestry | header + tagged end-seed | unsupported | none | LOSSY today (no Endophasia target yet; ACP: UNREPRESENTABLE); needs a source-reference design |
| Compaction | shadowed seqs, summary model, usage | none | `lifecycle.compacted` | QUALIFIED (the log is a superset of the surface) |
| Orchestration (teams, workflows, jobs, hooks) | experimental events | none | none | LOSSY (count only) |
| Streaming deltas | only as the compact embedded stream | aggregated chunks | none | LOSSY |
| Live-only signals | none persisted | partly | none | LOSSY |

### What native DSH preserves beyond ACP

Per-call token usage (ACP only reports context occupancy); the provider, model and response id of each call; the full request
configuration and tool inventory per epoch; every failed attempt, the retry decision and its delay; structured failure facts;
stable call ids with the raw argument string and the tool's error identity; the authority envelope and the ask/decision audit; the
ordering of everything by a contiguous `seq`; session ancestry and the exact inherited prefix; compaction provenance; and the
fact that something was *not* announced.

### What Endophasia cannot faithfully observe

Tool execution start or duration; request start time; HTTP headers, endpoint and raw provider bodies; the cost of a call; usage of
a failed attempt; partial output of a killed stream; anything committed in memory but not yet flushed when the process died;
plugin composition, versions and configuration (the log never states which plugins ran); who answered an approval beyond its
outcome; and the identity of the model behind an alias (`qwen38-local` is a name the server accepted). These stay `UNAVAILABLE`.

### Causal and ordering claims

`seq` gives a total order *within one session*. Nothing in the log relates an event in one session to one in another (a fork child
reuses the parent's `seq` values for the shared prefix), so no cross-session order and no causal claim may be derived from it.
`parentSession` is lineage, not influence: a subagent child has a parent and inherits nothing (`isSeeded: false`). Request
boundaries are `request/header` events; step brackets contain them; neither says why a request happened.

## 5. Architecture options

| | Option | Fidelity | Cost and risk | Verdict |
| --- | --- | --- | --- | --- |
| A | Native opt-in Cordis observer plugin on `session/event` | JSON-equal to the log from attach onward; **blind to restored history and resume markers**; the only option that can also see transient frames and a live `agent/error` | Runs code inside the host; depends on a pre-stable API and plugin loading; nothing it sees is more durable than the log | Defer |
| **B** | **Read-only cold import of the persisted/exported log** | Everything in the log, including recovery closers (as DSH's words) | Depends on a *released* format with fingerprints; reads zstd frames; must never open a write handle; a session still being written lags and may have a torn tail; there is no reliable "closed" signal | **Choose** |
| C1 | ACP v1 attachment (existing adapter) | The ACP ceiling above | Already supported | Keep, unchanged |
| C2 | SDK JSON-RPC attachment | Native event fidelity | Endophasia would spawn and drive the runtime; resume takes ownership; control path | Reject for observation |
| D | Hybrid: durable backfill plus live events | B plus the crash window | Two sources to reconcile, an in-host plugin, double-count hazards | Defer until the crash window is a stated requirement |

**Decision: B, as a cold importer.** Reasons, each tied to evidence: the log already contains every native fact the live feed carries
(JSON-equal in every case where the observer was attached from the start); the feed cannot reconstruct history; the persisted format is
the one DSH *promises* to keep stable; B needs no code inside DSH and cannot affect it; and B keeps Endophasia's principle that it does
not own or replace the harness.

**The strongest case for A or D, stated plainly:** a live observer is the only way to capture what a *crash* destroys: the streamed
prefix of an assistant message (dozens of chunk frames in the killed run) and an `agent/error` that never reaches a `turn/end`. The
log cannot contain them, so a cold importer will report an interrupted turn with no content, which is honest but not complete. This
study judges that evidence incomplete-by-construction rather than required: Endophasia's no-content policy would digest the partial
text anyway, and a record "of what a process said before it died" is a different claim from "what DSH recorded". It becomes a
requirement only if a later study needs crash-window evidence; then D is the next step, with B as its backfill.

Option B has three input forms, in order of preference for PR 2: **(1)** a session read from the persistence directory; **(2)** the
same canonical JSONL taken from a Web `/export` ZIP (flush-barriered, includes subagent sessions, needs a ZIP reader); **(3)** a
session still being written, accepted only up to the last complete frame and always reported as such. There is **no "closed" signal**:
`session.lock` persists after release and an end-seed marker is documented as not a liveness signal; probing the lock would take it
and could make a DSH resume fail. So every session must be treated as possibly open.

## 6. Handoff for PR 2 (the smallest safe scope)

**Build** `adapters/dsh-native/` as an import adapter with **no DSH or Cordis dependency**:

1. **Reader.** Promote `research/dsh-native/log.ts` after the review fixes recorded in §8 (frame scanner, torn-tail and torn-row
   reporting, decoded-size bound, v4 only). Refuse any other format version and any unknown required type; count ignorable
   unknowns as loss. It must be demonstrably read-only: no write handle, no lock, no repair, bounded memory. **Decision for PR 2:** DSH
   itself recovers the complete rows of a torn final frame through a write handle; the study's reader is stricter and drops that
   frame's rows (reported). Decide explicitly whether to keep that conservative rule; it must never change the digest of the
   complete prefix.
2. **Identity and idempotence.** Source reference = (DSH session id, `seq`); the **format generation is an attribute, not part of the
   identity**, so a future V5 migration does not duplicate every import. Import is incremental and idempotent: re-importing a longer
   log appends only events beyond the stored high-water `seq` and verifies the earlier prefix is unchanged. Never reuse `seq` as
   `storageSequence`; `at` is the import time (from an injected clock, so tests are byte-stable) and DSH's `time` goes into the
   payload as *reported*. Coordinate: `endo.session.dsh.<encoded session id>`.
3. **Privacy at the read boundary.** Digest content with the existing keyed-digest domain (as the Pi and ACP adapters do); never
   persist prompts, system text, injected context, reasoning or tool text; counts and digests only. A canary test over the whole
   output is mandatory.
4. **Mapping.** DSH turn to Endophasia run and DSH step to Endophasia turn, as QUALIFIED (a queued follow-up or a goal round opens a
   new DSH turn where a Pi run would span it). `turn/end` reasons follow the Pi adapter's rules: `completed` and any other reported,
   non-error, non-abort reason to `run-completed` with the reported reason, `aborted` to `run-aborted` (the cause kind kept),
   `error` to `run-failed`. `blocked` is the open question. `interrupted` and `forked` closers are carried with a payload field
   saying DSH wrote them after the fact (within the existing payload shape, no new schema), never as `lifecycle.interrupted`. Tool
   calls and results to `tool.started/finished` with keyed digests over canonical JSON (unparseable arguments `UNAVAILABLE`);
   attempts and retries to the existing retry kinds; usage into the trajectory layer only when the required counts are present,
   else `UNAVAILABLE` with the reason; request header as environment evidence; authority records as observations.
5. **Loss accounting.** An `endo.dsh-native-loss-accounting.v0` table in the style of `adapters/acp/loss.ts`, generated from
   `matrix.json` and tied to the pinned vocabulary by a test.
6. **Ancestry.** Apply the fork cut only when the header and the last *tagged* `session/end-seed` agree, else the cut is
   `UNAVAILABLE`. Import a child's own events and carry the parent as a *reference*; do not copy the inherited prefix.
7. **Open sessions.** Import only complete frames, report the tail, import again later; never take the lock or open for write.

**Do not build in PR 2:** the live observer, the SDK client, any control path, resume, ZIP support (unless needed), a Studio route,
orchestration/team/hook interpretation, or any change to `endo.trajectory.v1`.

**Acceptance for PR 2** (additional to the tests here): the fixtures in `research/dsh-native/fixtures/real/` map to trajectories
that validate; the importer opens files read-only (asserted); a torn tail or torn row never changes the digest of the complete
prefix; a re-import of a longer log is idempotent; a version 3 or 5 header, an unknown required type and a non-ignorable `plugin:`
record are refused; a decompression bomb is refused at the bound; an unterminated final row is reported; compare(a, a) is EXACT on
the layers a reports; no DSH string appears in any harness-neutral module.

## 7. Compatibility and upgrade hazards

* **Format.** V4 is released but explicitly *not frozen* for compatible additions. A log carries **neither a type fingerprint nor the
  writer's version**, so a reader cannot check "this event has the pinned fingerprint". What it can do is *pinned tolerant parsing*:
  read the fields it knows from the pinned shapes, define what it does with unknown fields, and refuse unknown required types and
  other format versions. The fingerprints (`vocabulary.json`) are for the study and for a CI check against a DSH checkout, not for the
  importer at run time. A future V5 arrives as a new generation file beside the old one.
* **Plugin events.** Part of the vocabulary comes from optional or experimental packages (teams, hooks, workflows, jobs), and plugin
  records are stamped `ignorable`. An unknown *non-ignorable* type means a newer harness and the whole log is refused.
* **Provider shapes.** `replayState` (pi-ai, version 2) is adapter-private. Read provider and model; treat the rest as opaque.
* **Pre-stable APIs.** Anything that needs Cordis moves with every DSH release (`AGENTS.md`).
* **Reproducibility.** `ENDO_DSH_CHECKOUT=<checkout> npx vitest run tests/dsh-native-study.test.ts` checks the provenance hashes and
  re-runs the stub-provider scenario against the checkout, comparing everything but timing. Without the variable those two tests
  are reported as skipped. If the checkout moved, the test says to re-audit.

## 8. Review, disagreements and limits

* **Independent reviews.** An Opus design review before the experiments and an Opus review of the full diff after. The latter found,
  and this revision fixed: rows silently dropped when a complete zstd frame ended mid-row; `plugin:` records exempted from the
  required-type rule; unbounded decoded memory; a skippable-frame and reserved-bit laxity; a path-deletion hazard in the harness
  (`--scenario` is now whitelisted); an observer that registered on the awaited `session/flush`; subagent-fork and surfaces left
  enabled in the experiment profile; a digest in the fixtures that confirmed the user's name (withheld text is now length only);
  sanitiser holes (inbox splice, titles, chunk ids); an opt-in test that passed vacuously (now `skipIf`); and tests that let nine
  mutants survive (all killed now). **Codex could not run**: the independent Codex pass failed immediately with a usage-limit error
  and produced no findings; this PR therefore has one independent reviewer, not two.
* **Disagreement settled by evidence.** An early draft leaned towards a hybrid. The review argued, and the evidence confirmed, that
  the live feed adds only the crash window; the choice stayed B alone, with the crash window named in §5.
* The `crash-killed` case is a clean kill between flushes, not a torn write. Torn tails are SYNTHETIC.
* One local model and one machine: timing, reasoning text and token counts are not claims about DSH or Qwen in general. Qwen output
  is not deterministic; only the stub-provider scenario is reproducible structure-for-structure.
* The experiment disabled many plugins to keep the run closed. It therefore says little about how those plugins record state.
* The study's reader returns fewer events than DSH would restore from a damaged tail, and is stricter about frame shapes than needed
  for correctness; both are deliberate and stated.

## 9. Reproduce

```sh
# 1. Pin the audit: provenance and vocabulary from a DSH checkout (read-only on the checkout)
node research/dsh-native/inventory.ts ~/deepseek-harness --write

# 2. Re-run a scenario in a throwaway home (stub-retry needs no model; the others need the local model server)
node research/dsh-native/reproduce.ts --dsh ~/deepseek-harness --out ~/projects/endophasia-research/dsh-native --scenario stub-retry

# 3. Rebuild the sanitised fixtures from the raw captures (raw data stays outside the repository)
node research/dsh-native/build-fixtures.ts

# 4. The deterministic tests; add ENDO_DSH_CHECKOUT to include the opt-in reproduction
npx vitest run tests/dsh-native-study.test.ts
```

See `research/dsh-native/README.md` for the layout and the safety rules of the harness.
