# Private activity reports

`protocol/private-activity.ts` defines the value an adapter may present, not a command an adapter may execute. Develop reads it through the closed Studio wire gate in `model/private-activity-wire.ts`. The common categories describe the kind of report; they do not identify a particular tool implementation. For example a reported file change need not be an invocation of Pi's edit tool. The display title is the validated native name (or a fixed placeholder) with an optional admitted path or command.

## Identity and ordering

Join the transcript to the existing status on **launchId**, not on a display name. Status supplies the attachment instance and presented Endophasia session (possibly an alias). Pi's native session ID stays in the attachment, used to derive the existing Endophasia session identity and to guard the private transcript. Do not expose an unaliased native session ID behind an existing alias. The source is the existing `pi-live` integration. A turn is a launch-local ordinal assigned on a native turn start; absence means unknown. It is neither a Pi turn ID nor a durable work attempt. No activity is attributed to an attempt by timing.

Every accepted native boundary gets a new transcript **seq** before pagination; **occurrence** names its first correlated observation, also scoped to this launch. The native **callId** is an optional reference, not either of those identifiers. For start/end/start/end all named c1 the sequence is 1/2/3/4 and occurrences are 1/1/3/3. Previously only the first row survived. The page still advances by the last *delivered sequence*, never the folded row number.

Pi emits starts before preparation and ends with the same tool name and call ID, including in its parallel path. Match only a sole outstanding start within the same turn/lifecycle segment. A second simultaneous start for the same key makes that key ambiguous for the rest of the segment. Missing IDs, invalid names, unmatched ends and additional end reports remain separate rows. Re-delivery of the same transcript sequence is not another observation. If a start has scrolled out, its end still carries the assigned occurrence; the page shows the end without inventing the missing fields. At 400 distinct outstanding keys, the next key disables matching until the next boundary, rather than evicting just enough information to make an ambiguous match look unique.

This is correlation of an ordered Pi stream, not an exactly-once protocol. A delayed duplicate end arriving *after* an identical ID and name have been reused and started again is indistinguishable from a legitimate end. Without a stronger native reference, no adapter can distinguish those histories. Counts of displayed rows in malformed streams count observations, not verified executions.

## Disclosure, authentication and evidence

1. Pi reports native events. They can be wrong: even a truncated assistant request can produce a start and an error without executing the requested tool.
2. The adapter constructs bounded private fields before the broker answers. A missing field is unavailable; a present but unadmitted value (including ordinary `cargo test`) is withheld by policy. No secret detector runs. An edit count is calculated from a provider list, not from filesystem writes. Truncation follows validation of the complete candidate. Allowed names, IDs and numeric values remain provider assertions, not a defense against a malicious covert channel.
3. Canonical records continue to use their existing mappings and keyed digests. No new store, log, evidence schema or cross-session join is introduced. Observe and Compare do not receive private text to reconstruct their durable views.
4. Independent verifier and OS observations remain on their separate evidence paths. No lifecycle value or private field in this contract establishes execution, exit code, task correctness or enforcement.

The transcript route still requires the current page pairing. The browser removes rendered rows and its reducer's transcript on known pairing loss, disconnect, launch or session change, and on pairing again. Requests that predate a known boundary cannot apply a late grant, status or page. A lower watermark cannot roll back the conversation. An observed native session change permanently clears that broker's transcript. Reconnecting a process does not reopen it. A newly authorised page may of course read the same session's retained broker history. Giving up **session control** does not unpair a reader.

A hidden, offline or non-following page does not instantly learn of remote revocation. An already delivered byte cannot be recalled. These changes do not erase browser heap snapshots, screenshots, clipboard contents, Pi session files or an independently configured recording proxy.

## Capabilities and compatibility

The private page carries all twelve capability keys, including explicit unavailable and unverified values. Stable session identity, native interruption, steering and tool boundaries may reflect the existing attachment assessment; a partial or missing assessment does not become support. Receiving starts and ends or an admitted argument/result preview can demonstrate that observation path on this connection. Stable native call IDs and resume are unverified; per-tool cancellation, interactive approvals, structured file-change observations and subagent observation have no path in this adapter. Pi write/edit *reports* are not structured filesystem observations. These descriptors are never consulted by control admission.

Transcript v3 replaces v2 in the co-served UI/broker bundle: reload/restart both together. There are no persisted transcript records to migrate. Unknown shapes fail closed; message and reasoning semantics, status, pairing, intervention and canonical evidence schemas are unchanged.

For Codex, first capture consented, disposable native traces and establish which session, turn and item references are stable. Then write an adapter-side projector, keep file-change observations distinct from requests, and replay the traces through the same gate and renderer. Do not enable any control or permission mode from this descriptor. The Codex-, Claude- and ACP-inspired examples under `tests/fixtures/private-activity.ts` are labelled synthetic: none is a connection, a captured native trace or a compatibility claim.
