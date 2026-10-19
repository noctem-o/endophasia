# The cockpit page: design reference

One screen, served by the local cockpit server, built from the observation bridge's projections. It answers four questions: what
runtime is attached, what has been recorded, what capabilities are recorded and with what limits, and what can actually be verified
from the observations. The page is a **projection of records, not an observation system**: it reads `GET /<cap>/api/v0/snapshot`
and shows what comes back. It invents no capability, status, confidence, activity or internal state.

```text
endo studio [<root>]                   # the installed command (docs/studio.md): serves the page packaged in dist/cockpit-ui/
npm run cockpit -- <store-root>        # from a checkout: builds the page, starts the server, prints the access URL once
node scripts/seed-cockpit-demo.ts <empty-directory>   # a demo store from the committed Pi recordings (3 sessions, the 1.0.0 specimen)
```

![The installed Studio page over the demo store: runtime and capabilities on the left, the timeline in the middle, sources and the inspector on the right](images/studio.png)

_The real page at 1440 x 900 in headless Chromium with the GPU off, over a store seeded by `scripts/seed-cockpit-demo.ts` (event 14 selected). Nothing on it is a mock-up._

The printed address ends in `/`; it is the access capability for that launch, so it is shown once and never logged.

## Layout

A top bar and three columns of panels that scroll on their own (one column below 1000 px). The references (DEVELOP and WORK above all)
gave the structure: runtime and capabilities on the left, the trajectory in the middle, evidence and provenance on the right.

```text
+------------------------------------------------------------------------------------------------+
| (oo) ENDOPHASIA | Cockpit Observation | READ-ONLY | INDEPENDENT SOURCES   read 07:46 browser  [Refresh] |
+--------------------+-----------------------------------------------+---------------------------+
| RUNTIME            | TIMELINE  storage order        [readable] Rows | SOURCES & PROVENANCE      |
|  attachment select |  filter  [category chips]  flagged only        |  independent-sources note |
|  runtime family    |  positions 1-100 of 4,210 read . more follow   |  Event log   [readable]   |
|  current fingerprint| POSITION RECORDED CATEGORY KIND PRODUCER USAGE|  Registry pi [readable]   |
|  last change       |  1  17:34:47Z  HARNESS  harness.attached ...   +---------------------------+
|  notification      |  2  ...                                        | INSPECTOR                 |
+--------------------+  ...                                           |  event / capability detail|
| CAPABILITIES       |  [First][Previous][Next][Latest]               |  or the legend            |
|  current . 7 admitted 6 partial 3 unavailable                       |                           |
|  session.identity  EXACT ...                                        |                           |
+--------------------+-----------------------------------------------+---------------------------+
```

- **Runtime** (left): the selected attachment's registry as projected: runtime family, current fingerprint (id, observation time,
  reported version, identity digest and confidence, entrypoint, package), what was recorded and withheld, the last change and
  notification, and notes. Choosing another attachment is local and needs no request.
- **Capabilities** (left): the latest recorded state, whether it is `current`, `stale` or `unknown` for the latest fingerprint, a count of
  records per recorded status, and one row per capability: status (shape and word), classification (or "unclassified"), and how many
  limits apply. Selecting a row opens it in the inspector.
- **Timeline** (centre): the event log's window in **storage order**. Columns: position, recorded time (the producer's clock; the
  date is shown once above the rows it covers), category, kind, producer, and usage and flags. Filters (text, category chips, flagged
  only, session) act on the loaded window only and say "k of n in this window". Pagination is First, Previous, Next, Latest and rows
  per page (50, 100, 200, 500); each is one read.
- **Sources & provenance** (right, pinned): the event log and every registry, each with its own condition and position, and a fixed
  statement that they are independent. A card explains its condition in words only when it is not simply readable or empty.
- **Inspector** (right): one selected event or capability with its provenance on demand: every envelope field, the presented payload
  fields each with a basis, usage, derived-from, flags, how many payload keys were withheld, and the projection JSON of that one entry.
  With nothing selected it is the legend for every mark on the page.

Deviations from the references, and why: no mode navigation (DEVELOP, WORK, DREAM, OBSERVE are not separate applications yet); no
LIVE badge, meters, radar, scores, sparkline-like bars or "thinking" views, because none has a measurement behind it; controls only where
the page can really do the thing (Refresh, paging, filtering, selection); provenance is on demand in an inspector, not a persistent chain
diagram; and the references' decorative glow is replaced by hairlines, spacing and type.

## What the page will not claim

| Rule | How the page keeps it |
| :--- | :--- |
| A missing value is not zero | A null cost or reasoning count reads "not recorded"; a recorded zero reads `0`; a null classification reads "unclassified"; a source without a position reads "no position", never length 0 |
| An unavailable claim is not an inactive one | Every claim shows its basis or the **N/A** mark with the record's own reason; statuses `unavailable` and `unverified` have different shapes and words |
| Order is storage order | The position column is the order. The producer clock is labelled as the producer's, its dates are dividers (which may go back; that is recorded), and a producer sequence is shown only in the inspector, "within this producer only" |
| Independent sources stay independent | The snapshot's `independent-sources` is stated on the page; every source has its own state and watermark; nothing is summed or joined; there is no aggregate health indicator |
| Usage is per event | Shown per event and in the inspector, never totalled ("one call can be recorded by more than one event"); a cost has no currency |
| A browser time is not a recorded time | "Read 07:46:23 by this browser's clock" is separate from every `recorded` value, and the page is never labelled LIVE |
| A projection is not evidence | The sources panel says so; a "limit" is shown as a reason a status cannot be taken at face value; "no limit applies" is not a verification |
| Withheld is withheld | The policy's withheld text and generated `withheld-<hex>` aliases render as dashed **withheld** and **alias** marks, never as ordinary text or a real id |
| An unknown value is shown as what it is | A note, limit or state code this build does not know is shown as its raw code; a contract version it does not read is named and nothing from it is shown |

Marks never rely on colour alone. Source conditions: readable a solid disc, empty a ring, absent a dashed ring, degraded a triangle,
unopenable a crossed box. Capability status: admitted a disc, admitted-partial a half disc, unavailable a slashed ring, mismatch a diamond,
unverified a dotted ring. Basis: **OBS**, **REP**, **DER**, **N/A**, each with its meaning on hover and in the legend.

## Reading, refreshing and failing

One snapshot request per user action (`?afterSequence=&limit=`), at most one in flight. The page reads once when it opens; after that it
reads only when asked. There is no polling and no timer: a read validates the whole history (PR B measured about 1.3 s at 50,000 events),
so the page does not offer "latest on open" (that would be two reads) but a **Latest** button that uses the watermark's length.

| Reply | The page |
| :--- | :--- |
| 200, a snapshot of a version it reads | shows it, with the browser time and how long it took |
| 429 | "The server is pacing reads", the time from `Retry-After` (the server sends at most 3,600 s, so the figure is always a plain number a timer can hold), controls off until then (one timeout, set from the same `performance.now()` deadline the lock reads, so a wall clock set back or forward during the wait changes neither), the last read stays on screen marked not current, no retry |
| network failure, timeout (60 s) | says the server did not answer or the read was abandoned; the last read stays, marked not current |
| 404, 421, 403 | says the address or the request was refused (404: the access address changes on every launch) |
| 5xx | says the server reported an internal error |
| 200 of an unknown schema, projection or consistency | names the record that declared it (snapshot, timeline, runtime identity or capability state), the declared version as text, and the version this build reads for that record; shows nothing from it |
| 200 that is not JSON or not the expected shape | says so and shows nothing from it |
| 200 the classifier passes but a view cannot be drawn | before a snapshot replaces anything, every view the operator can reach from it without a further read is drawn once into detached containers: the timeline (under the current filters and under none), the sources, every event's detail, and for every attachment its runtime panel, capability list and every capability's detail. If any of that throws it is a failed read (the previous read stays, marked not current), so a malformed event field or evidence record cannot wait behind a click. A value a record should hold and does not (a missing field) is such a failure too: `h()` refuses an `undefined` child and `grouped()` a non-number, so it is never drawn as a blank or as the word "undefined". This costs about 40 to 50 ms on a 500-row read, measured in headless Chromium with the GPU off, and only happens on a read the operator asked for |

## Tokens

All in `cockpit-ui/cockpit.css`, once, in `:root`.

| Token | Value | Use |
| :--- | :--- | :--- |
| `--bg` `--surface` `--surface-2` `--surface-3` | `#090c0e` `#0f1418` `#141a1f` `#1a2229` | page, panel, header and field, raised |
| `--line` `--line-strong` | `#202b33` `#2d3b46` | hairlines, control borders |
| `--text` `--text-dim` `--text-faint` | `#dce6eb` `#9bacb6` `#7b8d98` | all at least 4.5:1 on `--surface` |
| `--accent` `--accent-strong` | `#4fd6c5` `#86eadd` | readable, observed, selection, the one primary action |
| `--info` `--violet` | `#7db4ff` `#b19cff` | reported, derived |
| `--warn` `--bad` | `#e6ae45` `#f07268` | degraded, limits, stale; unopenable, mismatch, errors |
| `--font-ui` `--font-mono` | system UI stack, system monospace | no remote font; identifiers, digests and times are monospace with tabular numerals |
| `--fs-0` to `--fs-3` | 11, 12, 13, 15 px | labels, body, headings |
| `--s-1` to `--s-5` | 4, 8, 12, 16, 24 px | spacing |
| `--r-1` `--r-2` | 3, 6 px | controls, panels |

Motion: hover and selection transitions of 100 to 120 ms, and one indeterminate bar under the top bar while a read is in flight.
`prefers-reduced-motion` removes all of it; at rest nothing animates (`document.getAnimations()` is empty, and a test says so).

## Code boundaries

```text
reply.ts        pure: classify a response (status, Retry-After, type, body) into a Reply; versions checked, nested included
api.ts          the only fetch: relative URL, no credentials, no referrer, no redirect, no cache, 60 s timeout; never throws
labels.ts       the wording of every closed vocabulary (Records over the protocol's unions) and the versions the page reads
model.ts        pure view models: presentText, usageView, pagerView, filterEntries, capabilityRows, sourceViews, noteViews ...
state.ts        the state and the Actions interface renderers call
dom.ts          h() and svg(): text nodes and a short attribute list only; no HTML sink
icons.ts widgets.ts render-*.ts    the panels, built with h(); each reads state, calls Actions, returns nothing
main.ts         wiring: the one-at-a-time read, the 429 timeout, focus kept across a re-render
```

Data (`reply.ts`, `api.ts`), view models (`model.ts`, `labels.ts`) and rendering (`render-*.ts`, `widgets.ts`, `icons.ts`) do not reach into one
another's concerns, which is the seam a later spatial renderer (WebGPU or otherwise) would use: it consumes `model.ts`'s output and replaces
`render-*.ts`; the contract types come from `protocol/` by `import type` only, so nothing of the protocol or the bridge runs in the
browser, and a protocol change breaks the typecheck (the label tables are `Record`s over the protocol's unions) and
`tests/endo-cockpit-ui-model.test.ts` (which pins the versions and the withheld text against the protocol's exports).

The build (`npm run build:cockpit-ui`, run by `npm run cockpit`) compiles `cockpit-ui/src` with `tsc` to ordinary ES modules in
`cockpit-ui/dist/` (ignored). Nothing is bundled and no dependency was added. The launcher reads that directory once and hands the server a
map of name to content; the server serves exactly those names from memory. `npm run build` builds the same page into `dist/cockpit-ui/`
with the same builder, after it has emptied `dist/`, and the installed `endo studio` reads it from there ([studio.md](studio.md)).

## Tests

`tests/endo-cockpit-ui-model.test.ts` (classifier, view models, vocabulary pins), `tests/endo-cockpit-ui-source.test.ts` (what the source
may not contain: HTML sinks, dynamic code, storage, the page's own address, polling, absolute URLs, inline script or style),
`tests/endo-cockpit-http-ui.test.ts` (the page routes, headers, guards, budget, the unchanged JSON API) and
`tests/endo-cockpit-ui-browser.test.ts`: the real page in headless Chromium with the GPU off (Trusted Types enforced, no console or
policy violation, populated, empty, absent, degraded and unopenable sources, paging, filtering, single-flight refresh, a real 429, a pause
under a wall clock set back, a stopped server, replies a server never sends, among them snapshots holding a view that cannot be drawn
until it is opened: an event's fields, a capability's evidence, a second attachment, a row a filter hides). The browser is found on PATH or by `CHROME_BIN`; without one those tests skip, saying so.

## Intentionally deferred

DEVELOP, EVOLVE, WORK, DREAM, OBSERVE and VERIFY as separate applications; any push or live view (SSE, watcher, incremental index);
steering, queueing or stopping a run; attachment management; evidence promotion; spatial renderings (the DREAM reference); and any
interpretability view (the OBSERVE reference), which needs a real measurement source and a contract for it first. A freshness check
(`checkEndoCockpitSourceFreshnessV0`) and an evidence-inspection endpoint are PR B's deferred items and are not needed by one screen.
The installed command is `endo studio` ([studio.md](studio.md)); the page's visible name is Studio (title and heading), while the
directories keep the names `cockpit-ui` and `cockpit-http`.
