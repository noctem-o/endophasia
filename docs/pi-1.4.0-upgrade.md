# Case study: Pi 1.0.4 → 1.4.0

What changes for Endophasia's Pi adapter between Pi 1.0.4 and Pi 1.4.0, and what was actually tested. This is an
assessment of one upgrade. It does not promote 1.4.0 to the verified baseline: `PI_VERIFIED_BASELINE_VERSIONS` is
unchanged, and an operator's 1.4.0 earns admission on its own evidence like any other release
([harness-upgrades.md](harness-upgrades.md)).

## Sources and setup

- **Version-pinned documentation.** The npm packages ship their docs. `docs/rpc.md`, `docs/json.md`,
  `docs/rpc-commands.md`, `docs/session-format.md`, `docs/message-types.md` and `docs/compaction.md` were compared between
  the 1.0.4 and 1.4.0 packages. The `CHANGELOG.md` in the 1.4.0 package was read for 1.1.0 through 1.4.0. The
  `pi.dev/docs/latest` pages describe only the newest release, so they were not used to describe 1.0.4.
- **Isolated executables.** Both releases were installed with `npm install --ignore-scripts` into session scratch
  directories, never globally. Tarballs: `pi-coding-agent-1.0.4.tgz` (sha512 `+956nfMF…IcIdaw==`) and
  `pi-coding-agent-1.4.0.tgz` (sha512 `Z41LpZ3y…tIyiQg==`). The operator's installed Pi (1.0.1 in `/usr/lib`) was not
  run, installed over or changed. Its launcher was hashed and its `rpc.md` compared, read-only. `~/.pi` was not changed.
  The `harness check` and real-runtime runs below used a scratch `HOME` and agent directory. A first `--version`
  sanity run of each scratch release did not.
- **Runs.**
  1. `endo harness check` against 1.0.4 and then 1.4.0, into one scratch store with an empty Pi configuration, a
     scratch `HOME` and agent directory, and `PI_OFFLINE=1`. These are the automatic local checks: no prompt, no
     provider. The upgrade was then read back with `endo harness status`.
  2. The opt-in real-runtime suites (`tests/pi-real-runtime.test.ts`, `tests/pi-reasoning-leak.test.ts`) with
     `ENDO_PI_EXECUTABLE` set to each release. They run Pi against the repository's **fake** OpenAI-compatible endpoint,
     with a scratch `HOME` and agent directory. That includes Endophasia's live study, at no provider cost.

  Both runs passed on both releases. The raw outputs (stores, evidence, states, transcripts) are kept outside the
  repository, in the research data directory, under `pi-upgrade-1.0.4-to-1.4.0/`.

Labels in the matrix:

- **documented**: stated in the pinned Pi docs or changelog.
- **static**: verified by reading Endophasia's code against those docs.
- **experimental**: observed in the runs above, under their conditions.
- **unknown**: nothing here establishes it.

## Compatibility matrix

| Interface | Finding | Label |
| :-- | :-- | :-- |
| RPC framing and response correlation | `rpc.md` is byte-identical between the two packages. The local checks and the live study completed on 1.4.0 with no protocol error. | documented; experimental |
| Commands used by the adapter | `rpc-commands.md` and `session-format.md` are byte-identical. | documented |
| Session state and entry cursor | `session.identity`, `session.entries-cursor`, `continuity.active-path`, `session.overview` and `runtime.metrics` get the same classifications on both releases. | experimental |
| Lifecycle and terminal events | Since 1.1.0, `agent_settled` carries `aborted`. The mapping and the lifecycle ignore it: a run's end is still read from the last assistant `stopReason`. The live study's `run.identity` check treats any key outside its 1.0.0 key table as a possible run identifier. On 1.4.0 it classifies **MISMATCH**, observing "lifecycle events carried undocumented keys (agent_settled.aborted)"; on 1.0.4 it classifies UNAVAILABLE. This is the check's intended "needs review" signal, not a fault in Pi: `aborted` is a documented field, not a run id. `lifecycle.trace` is PARTIAL on both. | documented; static; experimental |
| Streaming, reasoning and tool results | Since 1.1.0, `tool_execution_end` carries `durationMs`. Assistant messages may carry `thinkingLevel`, and tool results may carry `nestedCalls`. The mapping picks named fields and ignores the rest, so none of these is recorded, and none is rejected. The reasoning relay test passed on 1.4.0: a thinking block reached the live transcript, in order, and no byte reached the store. 1.3.0 drops thinking blocks from an earlier model when the model is switched; what the model sees after a switch was not tested. | documented; static; experimental; unknown |
| Steering, follow-up and STOP | The RPC commands are unchanged. Steer, follow-up and stop are PARTIAL on both releases, for the same reasons: no receipt ids, and an untargeted abort. 1.2.0 (breaking) counts a run as busy while it starts, and an abort requested in that window aborts the run once it starts. The live study does not send STOP in that window, so the change is not exercised. | documented; experimental; unknown |
| Recovery and reconnection | 1.3.0 restores a resumed session's active tools. 1.4.0 fixes sessions that broke after recovering from a response cut off at the output limit. Endophasia's killed-and-resumed lifecycle fixture exists only for 1.0.1. Resume on 1.4.0 was not recorded. | documented; unknown |
| Runtime metrics and model controls | `get_session_stats` is unchanged. `control.model` is EXACT and `control.thinking` QUALIFIED on both, against the fake endpoint only. With no model configured, `control.model` is inconclusive, and `harness check` now says so. 1.1.0 changed cost computation for prompt-length pricing tiers, so costs recorded under different releases are not like for like. 1.3.0 changed how `--model` alone picks a provider. Endophasia passes `--provider` with `--model` when given both; `--model` alone may resolve differently. | documented; experimental; unknown |
| Retries and compaction | Several releases widen automatic retry. 1.4.0 summaries use the model's output limit. 1.2.0 omits thinking blocks from compaction summaries. These change trajectories and token use, not the RPC surface. Fake-only in Endophasia's tests. | documented; unknown |
| Configuration | 1.2.0 (breaking) publishes JSON schemas for settings, models, keybindings and themes, and validates themes at startup. The configuration digest covers `settings.json` and `models.json` content, not how a release interprets it. An upgrade changes the identity, which already invalidates evidence. | documented; static |
| Provenance and identity | The fingerprint's entrypoint, `dist/bundle/cli.js`, is a **160-byte launcher**. Its SHA-256 (`e79626f2…`) is identical in 1.0.1, 1.0.4 and 1.4.0. The program is in `cli-runtime.js` and `chunks/`, which the entrypoint digest does not cover (protocol/harness.ts says so). So a "strong" Pi identity rests on the reported version and the package manifest. A same-version change to the runtime files would not change the identity. | experimental |
| Pi Durable | Not used. `@earendil-works/pi-durable` is a forbidden import under the Studio boundary test, and the adapter speaks only `pi --mode rpc`. Pi Durable's persistence changes do not reach this interface. | static |

## What the upgrade report says

`endo harness status` on the scratch store, after `check` against 1.0.4 and then 1.4.0:

```text
Upstream assessment for pi.default (from recorded state; the installed Pi was not examined)
  Current:  1.4.0 (unverified-release) / fingerprint 4ea682a86223, strong identity, observed 2026-10-31T12:28:21.971Z
  Previous: 1.0.4 (unverified-release) / fingerprint 7b7d8b8a6ad9, strong identity, observed 2026-10-31T12:28:21.098Z
  Changes:  realPath, package, version; version order higher (a lower version is not assumed safer, nor a higher one compatible)
  [x] identity-observed: recorded 2026-10-31T12:28:21.971Z (strong identity); this report did not examine the installed executable
  [x] protocol-checked: 7 capabilities stand on local protocol checks of this identity (selected exchanges, no agent run)
  [x] capability-qualified: 6 admitted: 6 by local checks, 0 by a live study, 0 by a documented-surface review; each within its recorded limits
  [ ] behaviour-compared: not established by capability evidence: …
  [ ] reproducibility-established: not established by capability evidence: …
  To establish control.model: endo harness check (offline; no prompt, no provider call)
  To establish lifecycle.trace, usage.entries, tool.activity, steering.steer, steering.follow-up, steering.stop: endo harness study --authorize-live-study (agent work; may cost provider usage)
  To establish run.identity, operation.outcome: a documented-surface review exists only for reviewed releases; otherwise the authorized live study
  …
```

The entrypoint is not listed among the changes because its bytes did not change (see Provenance above).

## Unresolved, and follow-up

- **The `run.identity` key table.** Adding `aborted` to the `agent_settled` keys is a change to what `pi.live.study`
  checks. It needs its own check version, so that evidence recorded under the old table stops applying. Mapping
  `agent_settled.aborted` into the lifecycle, as a reported signal beside the stop reason, would be a mapping-version
  bump. Neither is done here.
- **Identity beyond the launcher.** Covering Pi's runtime files, for example a digest over `dist/` or over the files
  the launcher loads, would detect same-version rebuilds. It changes the identity basis, which invalidates every
  recorded fingerprint's evidence, so it needs its own decision.
- **Behaviour.** Nothing here compares model outputs, tool decisions, compaction, retry or timing between the two
  releases. That needs recorded sessions under each release, compared with `endo trajectory diff`, which flags the
  runtime difference itself.
- The repository has two baselines. Packaging acceptance uses Pi 1.0.0 (`PI_VERIFIED_BASELINE_VERSIONS`), and the
  research studies use Pi 1.0.1 ([attachment.md](attachment.md)). This case study does not change either.
