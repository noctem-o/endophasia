# The Endophasia-native cockpit (next-stage target)

Status: planned. The fork-era browser cockpit was removed with the vendored Pi fork: it was a client of Pi's private
Session-worker services over a fork-only listener and cannot run against a user-installed Pi
([pi-attach-inventory.md](pi-attach-inventory.md) §5). Its replacement is not a port. It is a cockpit over
Endophasia's own records, for any attached harness.

## What it is

A read-mostly operator view served by Endophasia, whose only sources are Endophasia's durable records:

| Panel | Source |
| :--- | :--- |
| Runtime identity and changes | harness registry: current and previous fingerprint, last change, notification |
| Capability state | latest `endo.capability-state.v0`, each capability with its classification, limits and the evidence it rests on |
| Session timeline | `endo.event.v0` stream: lifecycle, tool activity, queue counts, compaction, process exits and reconnects |
| Durable entries | `session.entry-observed` with opaque source references; leaf moves |
| Usage and metrics | per-entry usage and session totals, as reported |
| Evidence | evidence records and their content-addressed transcripts |

## Rules it must keep

- **A projection, never an authority.** It renders recorded state. It holds no runtime connection and no truth of its
  own; reloading it from the store must give the same view.
- **Gaps stay visible.** A capability that is unverified, partial or unavailable is shown as such with its reason; a
  live-event gap between process instances is shown as a gap.
- **Controls only through the attachment.** Steer, follow-up, stop and configuration controls are offered only for
  capabilities the current state admits, and they go through the same attachment service the CLI uses. The cockpit
  shows acceptance and, separately, whatever effects later records show.
- **No harness management.** It never offers to install or update a harness. A runtime change appears as the same
  neutral notice the CLI prints.
- **The live study stays explicit.** Starting one is a deliberate, confirmed action that says it may cost money.
- **Local by default.** Loopback only, an unguessable per-launch URL, a strict content-security policy (the
  properties the removed cockpit host had, which are worth keeping).

## First slice (acceptance)

1. `endo cockpit <root>` serves a static page and a read-only JSON API over the store and registry.
2. The page shows identity, the last change notice, capability state with reasons, and a session timeline that updates
   as events are appended.
3. A test replays a recorded store (`research/pi-conformance/1.0.0` can seed one) and checks that the API output equals
   a projection computed directly from the records.
4. No import of any harness package; the boundary guards cover the new directory.

Controls and multi-attachment views come after the read-only slice has survived real use.
