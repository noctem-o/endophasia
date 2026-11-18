# Private activity reports

`protocol/private-activity.ts` defines what an adapter may present, not a command an adapter may execute. Develop reads it through the closed Studio wire gate in `model/private-activity-wire.ts`.

## Observation type and presentation category

Two separate fields describe a row. **`kind`** is the type of observation the provider made. **`category`** is only how the page groups and words the row.

| `kind` | Means | References | Status |
| --- | --- | --- | --- |
| `tool` | the provider's lifecycle report for one tool invocation | `name` (native tool), `callId` (native, nullable) | `requested · running` open; `completed · failed · unknown` as the end report said |
| `file-change` | the provider's own structured report that files changed | `nativeRef` (provider item, nullable); no tool name, no call id | `reported` (one report, no lifecycle) · `in-progress` · `completed · failed · declined · unknown` |
| `activity` | other structured harness activity (a search, an MCP call, a plan step) | `name` (native type), `nativeRef` | as for `file-change` |

A file-change report is not a tool invocation and is not a filesystem observation: it may carry only `Path` and a counted `Edits`, never a command, output or exit code. Every kind can share a category. A Pi `edit` is a `tool` row drawn under the `file-change` category, because Pi reported a tool call, and Pi has no structured file-change feed. No status is invented: a provider that gave one report shows `reported, no lifecycle`. An open state, or a lone report, must be the first observation of its occurrence; a later one may only name an earlier occurrence. The browser folds a later report into its first row only when the kind, source, turn, category and native reference all match and the first row is still open.

Before and after, for a Codex-shaped synthetic `fileChange` item:

```ts
// before (7b7ac3d): forced to call itself a tool, with an empty tool lifecycle
{ kind: "tool", source: "synthetic-codex", name: "fileChange", callId: null, category: "file-change", status: "completed", ... }
// after: what it is
{ kind: "file-change", source: "synthetic-codex", nativeRef: "fc_fixture", category: "file-change", status: "completed", ... }
```

The page words it as *file change · completed · reported by synthetic-codex*, *File-change report … Not a tool call, and not an observed filesystem write.* A Pi tool row is unchanged in shape. It is worded *bash · git status --short · completed · reported by pi-live* and *Tool call · activity #1 · command · pi-live report.*

## Identity and ordering

Join the transcript to the existing status on **launchId**, not on a display name. Status supplies the attachment instance and presented Endophasia session (possibly an alias). Pi's native session ID stays in the attachment, used to derive the existing Endophasia session identity and to guard the private transcript. Do not expose an unaliased native session ID behind an existing alias. The source is the existing `pi-live` integration. A turn is a launch-local ordinal assigned on a native turn start; absence means unknown. It is neither a Pi turn ID nor a durable work attempt. No activity is attributed to an attempt by timing.

Every accepted native boundary gets a new transcript **seq** before pagination; **occurrence** names its first correlated observation, also scoped to this launch. A tool row's native **callId**, and a non-tool row's **nativeRef**, are optional provider references, never either of those identifiers. Only a tool row has a callId: none is invented for a file change or other activity. For start/end/start/end all named c1 the sequence is 1/2/3/4 and occurrences are 1/1/3/3. Previously only the first row survived. The page still advances by the last *delivered sequence*, never the folded row number.

Pi emits starts before preparation and ends with the same tool name and call ID, including in its parallel path. Match only a sole outstanding start within the same turn/lifecycle segment. A second simultaneous start for the same key makes that key ambiguous for the rest of the segment. Missing IDs, invalid names, unmatched ends and additional end reports remain separate rows. Re-delivery of the same transcript sequence is not another observation. If a start has scrolled out, its end still carries the assigned occurrence; the page shows the end without inventing the missing fields. At 400 distinct outstanding keys, the next key disables matching until the next boundary, rather than evicting just enough information to make an ambiguous match look unique.

This is correlation of an ordered Pi stream, not an exactly-once protocol. A delayed duplicate end arriving *after* an identical ID and name have been reused and started again is indistinguishable from a legitimate end. Without a stronger native reference, no adapter can distinguish those histories. Counts of displayed rows in malformed streams count observations, not verified executions.

## Disclosure, authentication and evidence

1. Pi reports native events. They can be wrong: even a truncated assistant request can produce a start and an error without executing the requested tool.
2. The adapter constructs bounded private fields before the broker answers. A missing field is unavailable; a present but unadmitted value (including ordinary `cargo test`) is withheld by policy. No secret detector runs. An edit count is calculated from a provider list, not from filesystem writes. Truncation follows validation of the complete candidate. Allowed names, IDs and numeric values remain provider assertions, not a defense against a malicious covert channel.
3. Canonical records continue to use their existing mappings and keyed digests. No new store, log, evidence schema or cross-session join is introduced. Observe and Compare do not receive private text to reconstruct their durable views.
4. Independent verifier and OS observations remain on their separate evidence paths. No lifecycle value or private field in this contract establishes execution, exit code, task correctness or enforcement.

The transcript route still requires the current page pairing. The browser removes rendered rows and its reducer's transcript on known pairing loss, disconnect, launch or session change, and on pairing again. Requests that predate a known boundary cannot apply a late grant, status or page. A lower watermark cannot roll back the conversation. An observed native session change permanently clears that broker's transcript. Reconnecting a process does not reopen it. A newly authorised page may of course read the same session's retained broker history. Giving up **session control** does not unpair a reader.

A hidden, offline or non-following page does not instantly learn of remote revocation. An already delivered byte cannot be recalled. These changes do not erase browser heap snapshots, screenshots, clipboard contents, Pi session files or an independently configured recording proxy.

## Descriptor: observation is not control, and neither is authority

The private page carries one `descriptor` with two separate maps. Every key is always present, and every value says how it is known: `assessed` (admitted by the existing runtime assessment, the `protocol/harness.ts` capability state), `observed` (seen on *this* connection, which promises nothing about another), `advertised` (a provider claim nothing here checked), `unavailable` (no path in this integration) or `unknown`.

- **`observation`** lists what Endophasia can receive or present: native session identity, stable tool-call identity, tool boundaries, bounded argument and result previews, structured file changes, subagent observation.
- **`providerControls`** lists what the provider claims or has demonstrated about acting on a run: interrupt, steer, approvals, tool cancellation, resume.

No capability is redefined. For Pi, `assessed` comes only from the attachment's existing `session.identity`, `tool.activity`, `steering.stop` and `steering.steer` entries when they are `admitted`. A partial or missing entry becomes `unknown`. One observed start and end makes `toolBoundaries` `observed` for this connection only. Stable call identity and resume stay `unknown`. Approvals, tool cancellation, file changes and subagents are `unavailable`.

**Neither map authorises anything.** What the page may request is decided only by the broker's offers, the terminal approval or session-control grant, and execution protection. The descriptor does not grant sandbox authority, bypass an approval, enable protected execution, promote a workspace, imply OS-level enforcement or assert verified task completion. A test enumerates every source file that mentions the descriptor and pins the list: the Pi transcript producer, the protocol types, the Studio wire gate, its reducer, and the one panel that words it. It also asserts that session control, execution protection, pairing, interventions, attempt dispatch, isolation, promotion and the broker cannot see it. A broker test gives the transcript a descriptor whose controls are all `assessed`, then checks that steer and stop are still not offered and that requests for them are refused. The panel says, *A description, not a permission.*

Transcript v3 replaces v2 in the co-served UI/broker bundle. v3 has not shipped outside this draft, so its activity kinds and descriptor change in place, not as a v4: reload/restart both together. There are no persisted transcript records to migrate. Unknown shapes fail closed; message and reasoning semantics, status, pairing, intervention and canonical evidence schemas are unchanged.

For Codex, first capture consented, disposable native traces and establish which session, turn and item references are stable. Then write an adapter-side projector, map Codex `fileChange` items to `file-change` rows, never to tool calls, and keep them distinct from requests, and replay the traces through the same gate and renderer. Do not enable any control or permission mode from this descriptor. The Codex-, Claude- and ACP-inspired examples under `tests/fixtures/private-activity.ts` are labelled synthetic: none is a connection, a captured native trace or a compatibility claim.
