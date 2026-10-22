# Studio frontend foundation: architecture and security decision record

Status: **the production Studio frontend (Studio PR A, the foundation, and Studio PR B, the Observe workspace).** A React/TypeScript
application is built with esbuild, packaged flat with an exact manifest, installed, and served through the production server at its
real capability address. Its Observe workspace reads the one snapshot the server offers and shows what the recorded evidence
establishes, and where it stops. **`endo studio` serves it**: the page it replaces (`cockpit-ui/`) was retired in the same change as
the default switched, with its tests moved, not dropped (section 10). There is no CLI flag and no route for it; the server, its
guards and its page policy are the ones PR A hardened.

Compare, Capabilities and Evolve are named in the shell as not yet available, say what they would need, and show nothing. They are
not built, and nothing in them is synthetic.

## 1. What the audit found

| Constraint | Where it lives | Consequence for a React frontend |
| :--- | :--- | :--- |
| Node floor `>=22.19.0` (`engines`, the `package-floor` CI job) | `package.json`, `.github/workflows/ci.yml` | The build toolchain must run on 22.19.0 and produce the same files there as on newer Node. The concept declares `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; that field is the concept's own and is not inherited (section 6). |
| Self-contained package: no runtime dependency, `files: ["dist/"]` | `package.json`, `scripts/package-smoke.mjs` | React and everything else must be bundled at build time. The published tarball carries output only; the smoke test asserts the install has no React and no bundler. |
| Flat in-memory asset loader | `cockpit-http/host.ts`, `cockpit-http/server.ts` | The server serves `index.html` at `/<cap>/` and every other file at `/<cap>/assets/<name>`. Names are `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no directories, at most 4 MiB each. The build must emit a flat directory. |
| Allowed file types: `html`, `js`, `css`, `svg` | `UI_TYPES` in `server.ts` | A font needs one added type (`woff2`) and one policy directive (section 5). |
| Capability-prefixed routing: `/<per-launch-token>/` | `server.ts` | The page lives at an unpredictable path. Every reference must be relative (`./assets/<name>`); a Vite default of `base: "/"` would request `/assets/...` and be refused with 404. |
| CSP and Trusted Types: no inline script or style, no `unsafe-*`, `trusted-types 'none'` | `PAGE_CSP` in `server.ts` | A bundle must not inject a `<style>` or `<script>`, must not use `innerHTML`, and must not create a Trusted Types policy. |
| Existing acceptance | the earlier page's browser, source and model tests, `tests/endo-studio-*.test.ts`, `scripts/package-smoke.mjs` | They pinned the earlier page, its file list and its policy string. PR A kept them passing (the policy string gained `font-src 'self'`); PR B moved every one of them onto this frontend (section 10). |
| Headless Chromium driver | `tests/cockpit-browser.ts` (CDP over Node's WebSocket) | Reused as is. No Playwright, no second browser harness. |

## 2. Decision

**Bundle with esbuild, validate with a closed manifest, serve with the existing server.**

```text
studio-ui/src/*.tsx, studio.css          sources (never packed)
   | scripts/build-studio-ui.mjs  (esbuild, one pinned devDependency)
   v
dist/studio-ui/                          flat, content-hashed, no source maps
   index.html  main-<hash>.js  main-<hash>.css  chunk-<hash>.js  LazyProof-<hash>.js
   ibm-plex-sans-latin-400-normal-<hash>.woff2  icon.svg
   studio-ui.manifest.json               every file: name, bytes, sha256
dist/licenses/studio-ui-third-party.txt  licence notices of what was bundled (outside the served directory)
   | cockpit-http/studio-ui.ts: loadEndoStudioUiFilesV0  (before the key is made or anything listens)
   v
cockpit-http/server.ts                   unchanged guards, routes, budget, headers
```

### What the build does

- `esbuild` with `bundle`, `splitting`, `format: "esm"`, `minify`, no source map, `legalComments: "none"` (the notices are carried
  separately), `define: { "process.env.NODE_ENV": "\"production\"" }`, and `[name]-[hash]` names for entries, chunks and assets.
- All outputs go into one flat directory. esbuild writes the font reference in the CSS as `url("./<name>.woff2")` and the chunk
  imports as `"./<name>.js"`; the page, written by the build from `studio-ui/index.html`, references `./assets/<name>`. Relative
  references resolve under `/<cap>/assets/`, so nothing depends on the capability and nothing is absolute. This was checked in a
  real browser, not assumed.
- A dynamic `import()` is supported and exercised on every run: the shell loads the placeholder workspaces on demand, and the
  module becomes a separate file under the same assets path.
- The build is a pure function of the sources and the pinned dependencies. Two builds are compared byte for byte in the tests, and
  the output from Node 26 and Node 22.19.0 was compared and is identical.

### What the host checks (fail closed, before listening)

`loadEndoStudioUiFilesV0` (`cockpit-http/studio-ui.ts`) refuses the directory unless:

- `studio-ui.manifest.json` exists, is small, has exactly the keys `format`, `entry`, `files`, and a known format;
- every listed name is a plain name of an admitted type (`html js css svg woff2`), unique, with a bounded size and a sha256;
- the directory holds **exactly** the listed files and the manifest: a missing, extra, unlisted, linked or non-regular file is
  refused (the loader of the earlier page silently skipped unknown names; this one does not);
- a name is at most 64 characters **in all**, as the server admits (the loader and the server agree, so a name the server would
  refuse is refused before a key is made); a manifest or file larger than its limit is refused from its size, before it is read;
- every file's size and sha256 match (files are read once into memory and served from memory, so what was verified is what is served);
- `index.html` refers only to `./assets/<name>`, a style sheet only to `./<name>` by `url()` (no `@import`, no `data:`, no remote, no
  parent path), and a script only imports `./<name>` modules, each of them listed. A script is read with a small lexer
  (`moduleSpecifiers`), not a pattern: the specifier after `import`, in `import(...)` and after `from` is read where it is code, never
  from a string, a comment, a template literal or a regular expression. (A first version of this check was a pattern, and a label
  such as "derived from" in the real bundle was read as an import. The lexer fixed that, and its negative tests keep every way of
  naming something that is not a file beside the page refused.)

It is called from `launchEndoCockpitV0` *before* the digest key is loaded or created and before the server listens, so a damaged
install leaves no key, no store and no listener. The installed-package smoke test checks this too. The host has one loader and no
format option: a directory that is not exactly its manifest is not served.

Inline script, inline style, `on*` handlers, `javascript:` and remote URLs in the page are not parsed out of the JavaScript; they
are the browser's to refuse under the page policy, and the browser acceptance asserts that nothing was requested outside the
server and nothing was blocked. (Scanning minified React for `https://` is pointless: it contains documentation URLs.)

### Why not the alternatives

| Alternative | Verdict |
| :--- | :--- |
| **Vite unchanged** (the concept's toolchain) | Rejected, on verified grounds, not on a Node-floor claim: Vite 7's own engine range (`^20.19.0 \|\| >=22.12.0`) accepts 22.19.0. The reasons are fit and size. Vite's default is an absolute `base: "/"`; its HTML transform, `modulepreload` polyfill and CSS-code-splitting preload helper are generated code this repository would have to audit against Trusted Types; its default output puts hashed files in `assets/` and the entry beside them, which would need a small loader change or `assetFileNames`/`entryFileNames` overrides to become the flat set this loader reads; and it brings rollup, a plugin tree and a dev server, none of which production uses. |
| **Vite configured** (`base: "./"`, flat `assetFileNames`, `modulePreload: false`, no CSS code split) | Feasible, and the right choice if a later change needs Vite-only features (HMR for development, a plugin ecosystem). Here it is more moving parts to defeat than to use. It can be adopted later without changing anything else in this design, because the contract between build and host is the flat directory plus the manifest, not the bundler. |
| **`tsc` only, no bundler** (what the earlier page did) | Not possible for React: its packages are CommonJS and are not importable by a browser without a bundler or an import map pointing at files that would have to be served. Rejected by the task's own rule against import maps outside the package. |
| **Rewrite the server as a static file router** | Rejected. The in-memory, closed, flat loader is the security property. Nothing about React needs a filesystem router. |
| **A development-server proxy** | Rejected as a production path. A developer who wants hot reload can run the concept's own Vite server against recorded JSON; that is not part of this repository. |
| **Keep the page with no framework** | Was valid, and was kept for PR A. Retired in PR B, once the new frontend held everything the page was held to (section 10). Keeping both would have been a permanent second UI architecture. |

### Why esbuild specifically

One dependency (with a platform binary as an optional dependency), a documented API, flat output, a metafile, no HTML transform, no
absolute base, no generated preload code, and CSS extracted as a file rather than injected by script. It runs on Node 18 and later.
It is a pinned `devDependency`; the published package has no dependency at all.

## 3. Dependencies

Added, all as exact-pinned `devDependencies` (nothing is a runtime dependency; React is bundled):

| Package | Version | Why |
| :--- | :--- | :--- |
| `esbuild` | 0.28.2 | the bundler |
| `react`, `react-dom` | 18.3.1 | the concept's React major, so its components port without behavioural change. React 19 is a separate decision. |
| `@types/react`, `@types/react-dom` | 18.3.31, 18.3.7 | types for the checked build |
| `@fontsource/ibm-plex-sans` | 5.3.0 | latin 400 and 600 `woff2` of the concept's sans typeface, SIL OFL 1.1; the licence is packed |
| `@fontsource/ibm-plex-mono` | 5.3.0 | latin 400 `woff2`, for identifiers and recorded values; SIL OFL 1.1; the licence is packed (PR B) |

From the concept, deliberately **not** taken:

| Concept dependency | Decision |
| :--- | :--- |
| `@supabase/supabase-js` | **Excluded.** A hosted backend client has no place in a local, read-only instrument. A source test asserts none is imported or declared. |
| `lucide-react` | Excluded for now. Icons are needed only when real workspaces are ported; they can be inlined SVG components with no dependency. |
| `tailwindcss`, `postcss`, `autoprefixer` | Deferred. Their output is a style sheet, which this build already handles; choosing between Tailwind and plain CSS with tokens is a PR B design decision, not a foundation one. If adopted, they run at build time only. |
| `vite`, `@vitejs/plugin-react` | Not needed (above). |
| `@playwright/test`, `jsdom`, `@testing-library/*`, `vitest@5` | Excluded. Browser behaviour is tested with the existing Chromium/CDP driver; production uses `vitest@4`. Component unit tests in PR B can use the existing runner without a DOM, against pure view-model functions. |
| `@fontsource/ibm-plex-serif` | Not taken: the concept uses a serif voice sparingly (the wordmark and titles). Observe has no title that needs it. Each added face is a file in the manifest and a line in the licence notices. |
| `eslint`, `typescript-eslint`, and plugins | Excluded. Production lints with Biome, which now covers `studio-ui/**/*.{ts,tsx}`. |

The concept's repository carries no `LICENSE` file. This change copies **no code** from it, only a small colour-token subset and the
choice of typeface; both are the repository owner's own. PR B again copies **no component code**: the marks, the overview and the
states are written for this repository's records (the concept's marks and states are a design reference). The concept repository
should still state its licence before anything is copied from it.

## 4. The Node floor

The concept's `engines` field is not carried over, and production's is not raised. `package.json` still says `>=22.19.0`.

Verified, not assumed: `npm ci`, `npm run build` and `ENDO_REQUIRE_BROWSER=1 npm run test:package` were run under **Node 22.19.0 with
npm 10.9.3** (the pair the CI floor job uses), and `dist/studio-ui` from that run is byte-identical to the one built on Node 26.12.
CI's `package-floor` job repeats this on every pull request; it now includes the frontend because it runs the same build and the same
smoke test.

## 5. Security: what stayed, what changed, how each is tested

**Unchanged:** loopback-only binding; the 256-bit capability, compared in constant time; Host, Origin and Fetch Metadata checks;
GET only, no body; no CORS; read-only store access and the read budget; connection, header and time bounds; fixed refusal bodies;
the page policy's `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `img-src 'self'`,
`base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `require-trusted-types-for 'script'`, `trusted-types 'none'`.
The server has no new route and no new endpoint.

**Changed, narrowly, with the reason:**

1. `font-src 'self'` is added to the page policy. With `default-src 'none'` a bundled font cannot load, so the next change could not
   use a typeface at all. The directive admits only the server's own origin; it admits no `data:` font and no remote one. It also
   applies to the existing page, which has no font and is unaffected.
2. `woff2` (`font/woff2`) is added to the server's closed list of servable types. No other font or data type is: `woff`, `ttf`,
   `otf`, `map`, `json` and `wasm` are each refused by the server's own check.

**Tests that hold this** (all run in CI, and every browser test below fails, rather than skips, when `ENDO_REQUIRE_BROWSER=1` finds no
Chromium):

- `tests/endo-studio-ui-browser.test.ts` and, from the installed package through the real `endo studio`, `scripts/package-smoke.mjs`:
  both call `tests/studio-ui-acceptance.ts`, which opens the real address in headless Chromium **with the GPU off** and asserts, for a
  populated store, an absent store and a store whose log has a torn tail: the shell, the four workspaces, the overview, the table
  (the event count, the first kind), the runtime and capability panels, the source cards; that selecting an event opens its record
  and the overview marks the same event; that the log-extent bracket, set from script through the CSS object model, is drawn; that
  an unbuilt workspace loads on demand and draws no record; that both bundled font faces reach `loaded`; that every resource answered
  200 under `/<cap>/assets/`; that **one** snapshot read was made and none for selecting or switching workspace; that every request
  went to the serving origin; that no console message, exception, CSP or Trusted Types violation occurred; that a string assigned
  to `innerHTML` still throws and a Trusted Types policy cannot be created; and, at 420 px, that the inspector is a modal dialog
  carrying the degraded-source warning, Escape closes it and focus returns to the row.
- `tests/endo-studio-observe-browser.test.ts`: 53 tests on real stores. Forty-four are the earlier page's browser tests carried over,
  with the same questions asked of the same stores (absent, empty, torn tail, unopenable log, unopenable registry, no capability
  state, withheld and aliased text, paging with Latest from the watermark, a 429 that is shown, kept as not current and never
  retried, focus kept across a read and across a pause, replies of the wrong version, shape or content refused as a failed read,
  a snapshot the page cannot show whole refused). Nine are new: the narrow dialog, the keyboard, the overview and table kept in step,
  a hover that reads nothing, what the overview says it covers, the empty overview, the workspaces not built, no request but to the
  server. The existing width test was extended to 420 and 360 px after the narrow-width acceptance found a real defect (visually hidden
  text in a horizontally scrolling table made the page scroll sideways at 420 px).
- `tests/endo-studio-observe-model.test.ts`: the adapter and the reducer as pure functions over real snapshots read from real stores
  (and, where a rule needs it, a copy with one field changed). `tests/endo-studio-ui-contract.test.ts`: the classifier, the
  vocabulary pins against the protocol, the pure view functions.
- `tests/endo-studio-ui-source.test.ts`: what the source may contain, recursively over `studio-ui/src` (below).
- `tests/endo-studio-ui.test.ts`: the repeatable, closed build; the loader's refusals (missing, extra, tampered, resized, linked
  and non-file entries; manifest of another shape; paths, other types, names over the server's total limit, bad sizes and digests;
  an oversized manifest or file refused from its size; remote, data:, protocol-relative, absolute, parent-path, computed and missing
  references in the page, style sheet and modules; and the lexer's cases, positive and negative); a damaged build leaves no key and no
  listener; the server's guards over the new files; the API still answers beside the frontend.
- `tests/endo-cockpit-http-ui.test.ts`: the HTTP transport over the frontend: explicit routes only, every guard in front of them,
  the page policy on the page and on each asset, no capability or absolute address in anything served (but the six names React holds, each listed).
- `tests/endo-cockpit-http-lifecycle.test.ts`: the loader reads one directory and nothing else (no environment, no key, no write, no
  network); `host.ts`'s own imports stay the short list it pinned.

**What the source may contain** (`tests/endo-studio-ui-source.test.ts`, carried over from the earlier page's rules and extended): no HTML
sink (`dangerouslySetInnerHTML`, `innerHTML`, ...), no dynamic code, no request channel but `fetch`, no storage, no navigation, no
logging, no absolute address, no telemetry or hosted service; `fetch` in exactly one module, to the one relative endpoint, with no
credentials, no referrer and no redirect; one `setTimeout` (the pause) and no interval, animation frame or idle callback; only the
hook starts a read; the protocol is imported as types only; `model/` has no DOM, clock or randomness; one dynamic import; one file
(the overview) sets a style prop, in two places (the tooltip and the log-extent bracket), through the CSS object model; the style sheet's only `url()` are the three bundled fonts and ivory is
never a provenance or status colour.

**Known limits of the checks:** the JavaScript reference scan reads the minified output of this build with a lexer, not a parser; a
script it cannot make sense of yields what it could, and the digest in the manifest, not the scan, vouches for the bytes. It cannot, and does
not try to, prove the absence of network code; the page policy and the browser acceptance do that.

## 6. The data boundary (how the frontend consumes Endophasia data)

Production records and validators stay authoritative. The browser receives projections the server has already validated: every
API body is a record read under the version it declares (`readEndoCockpitRecordV0`) before it is sent.

### Rules for the React application

The frontend must not import the concept's synthetic sessions as data; must not reinterpret missing evidence as observed facts; must
not invent provenance or capability state; must not compute an authoritative trajectory verdict from the fields a browser can see;
must not infer permission from a recorded proposal or acceptance; and must not render a simulation as an execution.

### One read, one adapter, one state

**One endpoint.** The frontend reads `./api/v0/snapshot?afterSequence=&limit=` and nothing else. The snapshot already carries the timeline
window and every attachment's runtime and capability state; reading `timeline` and each `runtime/<attachment>` separately would be
several full reads of the history for what one read returns, and each read re-reads the whole log. The requests are relative to
`document.baseURI`, so the capability stays in the address bar and never in code, a query string or a log. `studio-ui/src/api.ts` is
the only module that calls `fetch`.

**The adapter** (`studio-ui/src/model/`) is pure: no DOM, no network, no clock, no mutation of its input. It is the one place a
validated projection becomes what the workspace draws:

```ts
toObserveViewModel({ snapshot, attachment, selection, filters, limit }): ObserveViewModel
// { runtime, capabilities, sources, timeline: { rows, pager, overview, ... }, inspector, attention, attachment }
```

- **Version-gated before it is called.** `reply.ts` classifies what the server answered: a snapshot, or one of pacing, refusal, server
  error, *unsupported* (which record, which version it declared, which this build reads), malformed, or unreachable. Schema and
  projection versions of the snapshot and of each nested record are checked against this build's; an unknown one yields an
  explicit unsupported reply and nothing from it is shown. A response is never trusted by its status alone.
- **Total over absence.** A claim is a discriminated union as in the protocol. A value a record should hold and does not is not a
  blank and not the word "undefined": it refuses the read (`str()` and the cell constructors throw), so the page keeps the last
  good read, marked not current.
- **Built whole, before a read is accepted.** The view models of every event, every attachment and every capability, under the
  filters now set and under none, are built when a snapshot arrives. A snapshot that any of them cannot build is a failed read now,
  not a broken panel later. The components format nothing: what is built is what is drawn. (A per-panel error boundary is the last
  line, not the first, and it tries again whenever what the panel draws changes, so a panel that failed once is not left saying so
  after a good read.)
- **Independent of the old page's code, but not duplicating it.** The vocabulary wording, the classifier and the pure view
  functions (usage that is never summed, filters that never reach beyond the window, a pager read off the watermark) moved with the
  tests that pin them (`labels.ts`, `reply.ts`, `views.ts`).
- **Tested against the real fixtures** (`tests/cockpit-fixtures.ts`), not against synthetic sessions.

**The state** (`model/state.ts`, one reducer; `use-observe.ts`, the one hook) has a single owner for everything that can change:
what was read, whether a read is running, the last attempt that failed, the attachment, the open selection, the filters, the page
size. There is no session store and no second place a selection lives (the concept's prototype had two and a dual write that had to
agree). Consequences, each tested:

- A selection is **one thing**: an event named by its storage position *and* its event id together, or a capability. It is kept
  across a read only where the same record is still in the window, and is closed, with a sentence, where it is not ("not in the
  window now loaded ... it is still in the log"). A different record at the same position is not the same selection.
- A filter that hides the open event does not close it; the inspector says the filters hide it and that it is still in the window.
- A "session" is only a filter on the sessions *seen in this window* (position range and entry count). The projection records no
  outcome, scenario, task or duration for a session, so none is shown; a session's events outside the window are not counted.
- The modal inspector at narrow widths is **derived**: open when the viewport is narrow and a selection exists. Closing it is the
  one action that clears the selection. There is no open flag to disagree with it.
- Reads: one at open and one per explicit action (Refresh, a page of the timeline, another page size), never two at once (a ref guard,
  so two clicks in one frame see the first as running), never by timer or hover, never retried. A 429 is shown as the server pacing
  reads; the controls come back at the time it named, decided on the monotonic clock by one timeout; the reducer is a pure function of
  the clocks it is passed. A failed read leaves the last snapshot on screen, marked not current, and the page size it was asking for.
  Focus returns to the control that started a read when it ends, or when a pause ends, in a layout effect (a frame later raced the
  test that observes it).

### Distinctions preserved, and how

| Distinction | Where the protocol keeps it | Rule for the adapter and components |
| :--- | :--- | :--- |
| Observation vs inference | `EndoCockpitBasisV0`: `observed`, `reported`, `derived`; `inferred` is reserved and produced by no v0 projection | Four distinct types. `inferred` is never produced client-side. A component shows the basis beside the value. |
| Evidence vs standing | a capability's recorded `status` is verbatim; `limits` list reasons it cannot be taken at face value; `currency` is `current`/`stale`/`unknown` | Never recompute or strengthen `status`. Show `limits` and `currency` with it. |
| Proposal vs permission | intervention records are separate events with their own source classes (proposal: policy conclusion; authorization: authority decision, bound to the proposal's id and digest; request, acceptance: runtime fact) ([steering.md](steering.md)). The cockpit recognises the `intervention.*` kinds but gives them category `other` and presents their envelope only (no field table lists them at this version) | Show each record as its own event. Never display "permitted" because a proposal exists, nor "allowed" because an acceptance does; standing comes from an authorization record that binds, and only the server-side validation says whether it does. |
| Acceptance vs execution | `intervention.accepted` is a runtime reply; `intervention.consumed` is a separate, later observation | Two events, two labels. No combined "applied" state. |
| Simulation vs recorded execution | event `source` class is carried verbatim on every timeline entry; `protocol/evaluation.ts` requires an evaluation's environment profile to state `simulated` explicitly and the result to carry it forward. The cockpit presents no evaluation record yet, so how a simulated one will reach the browser is **to be confirmed with the projection in PR B or later** | A simulated or replayed record gets a different mark and is excluded from every aggregate the same way the concept already does. |
| Evaluation vs promotion | `protocol/evolution.ts`: selection and promotion are recorded decisions, not gates, and "a promotion decision is a record about a request and confers no authority" | Separate gates; "no record" is not "failed" and not "unavailable". |
| Unavailable vs zero or false | `usage: null` (the kind never carries usage) vs `usage: { basis: "unavailable" }` vs a reported value; source `state` is `absent`/`empty`/`readable`/`degraded`/`unopenable` | Three usage cases, five source states, rendered differently. `absent` is not `empty`; `unopenable` is not `empty`. |

### Concept interfaces against production contracts

| Concept (`endophasia-studio-concept/src/domain/types.ts`) | Production equivalent | Status |
| :--- | :--- | :--- |
| `EvidenceKind` `OBS`/`REP`/`DER`/`NA` | `EndoCockpitBasisV0` + `unavailable` claims | **Direct.** `OBS=observed`, `REP=reported`, `DER=derived`, `NA=unavailable` with its `reason`. |
| `SourceCondition` | `EndoCockpitSourceStateV0` | **Direct**, same five states. `Source.note` is the bounded `error.message`; `Source.records` is `watermark.length` or counts. |
| `Source` (id, name, kind) | `source.domain` (`event-log` or `harness-registry`) and `attachment` | **Direct**, ids and names derived from those, not authored. |
| `RuntimeIdentity` | `EndoCockpitRuntimeIdentityV0` | **Partial.** Runtime family, fingerprint (identity digest, confidence), reported version, entrypoint sha and size, package, last change and notification exist. Concept `agent`, `harness` and `config[]` have **no production source**: they need a projection or must be dropped. Local paths are withheld by design. |
| `Capability` and `CapabilityStatus` | `EndoCockpitCapabilityViewV0`, `EndoCapabilityStatusV0` | **Partial, with a renaming trap.** Statuses differ in spelling (`partially-admitted` = `admitted-partial`, `mismatched` = `mismatch`); map by an explicit, tested table. The concept's free-text `declared` and `observed` do not exist in the record: production has the recorded status, classification, reason, required check kind, the cited evidence and its limitations, and derived limit codes. A declared-versus-observed matrix needs a **new projection**, not a string guess. |
| `TrajectoryEvent` | `EndoCockpitTimelineEntryV0` | **Partial.** `seq` = `storageSequence` (the only ordering). `at` = `recordedAt`, the producer's clock, which may run backwards: never an order, and `offsetMs`/duration derived from it must be labelled as the producer's clock. `fields` map to allowlisted fields each with a basis. `refs` map only to `derivedFrom` (no relation label exists). `title`, `summary`, `status` (`ok`/`error`/`partial`) and `structured` have **no equivalent**: payloads are withheld (`withheldFields` is a count) and an error is not derived from a kind name. |
| `EventCategory` (6 values) | `EndoCockpitCategoryV0` (11 values: lifecycle, agent, message, tool, session, queue, compaction, retry, harness, control, other) | **Not mappable.** Adopt the production vocabulary. |
| `UsagePresence` | `usage` (`reported` / `unavailable` / `null`) | **Direct plus one case.** The concept lacks `null` (the kind never carries usage). |
| `Session`, `SessionState`, `outcome`, `scenario`, `taskId` | `EndoCockpitSessionSummaryV0` (`sessionId`, first and last storage sequence, entry count) | **No equivalent.** A state or outcome is a verdict. Verdicts exist as `endo.trajectory.v1` (`endo trajectory show/diff`), computed by validated code over the store; the browser must not derive one from timeline fields. Needs a read-only projection that wraps the existing trajectory projection. |
| `Intervention`, `InterventionStage` | intervention events, kinds `intervention.*` (`protocol/intervention.ts`); in the timeline they are recognised, category `other`, envelope only | **Needs projection work.** The timeline presents only allowlisted fields, and none are listed for these kinds. Assembling a lifecycle (proposed, authorised, accepted, consumed) needs a projection that states which kind maps to which stage and which `derivedFrom` chain binds them. Until then, show the records as separate events and compose nothing. |
| Compare (`src/analysis/compare.ts`: exact, proposed, unmatched) | `endo trajectory diff` (a pure function over two recorded sessions; lifecycle, tool calls, results, outcome) | **Different semantics.** The concept's client-side alignment is a heuristic; the production comparison is validated and server-side. Port the *presentation*; source the alignment from a projection, or relabel the heuristic as a hypothesis of the viewer. |
| Evolve (`src/domain/evolve.ts`: lineage, experiments, candidates, checkpoints) | `evolution/`, `lab/` protocols and stores; no cockpit projection and no HTTP route | **Future projection work.** Arithmetic on recorded counts (an interval over passes and a printed denominator) is acceptable only from validated records; comparability, forkability and gate state must be computed server-side. Simulated branches stay out of every aggregate. |
| Fixtures (`src/data/fixtures`, scenes, `heatmapPoc`) | none | **Excluded.** Synthetic; used only to develop components, never bundled into the package. |

### How Observe represents evidence

| Thing | Representation | What it does not claim |
| :--- | :--- | :--- |
| Order | Storage position, always. The overview places a mark by its position within the window, so a gap in the positions (a repeat that was not presented) stays a gap. | Producer clocks are never an order, never an axis, never a duration. They are shown as written under the name *producer clock*, with the date repeated where it goes back. There is no time axis. |
| How an event's fields are known | The distinct bases among its presented fields: observed disc, reported half disc, derived diamond, unavailable dashed ring, **mixed** (several), **envelope only** (hollow square: no field is approved for presentation for the kind). Shape first, hue second; the table repeats it as `OBS`/`REP`/`DER`/`N/A` text. | It is a summary of the *fields*, not a grade of the event. An event with no presented field is not "unavailable": nothing about its content is shown, and the legend says so. A basis this build does not know is drawn as unknown and given no meaning. |
| Flags | Anomaly (solid red ring), interruption (dashed amber), discontinuity (dotted amber), unrecognized (dash-dot neutral), each with its word in the table, so no flag depends on a hue. | A flag is the projection's recorded reading of the *kind* ("its kind records..."), as the inspector quotes it. A kind name is never turned into success or failure, a title or a summary. |
| What the overview covers | Said in words, always: the whole log as read; the whole readable prefix of a **degraded** log (what follows the last verified event is not readable and not drawn); positions *a–b* only of *N* read; or, when nothing was read, why there is nothing to draw (absent, empty, unopenable, an empty window) in place of the lanes. A strip shows where the window lies in the log, or that the log's position is unknown. | A filtered view never makes a record disappear from the source: hidden events stay on the overview, dimmed. A window is never presented as a completed trajectory. |
| Usage | Per event: never carried, not recorded (with the reason), or recorded. A missing cost or reasoning count is "not recorded", never `0`. Nothing is summed. | One call can be recorded by more than one event. |
| Sources | Each on its own, with its own condition, position and notes; a source that is not readable or empty is repeated in a strip at every width and again **inside** the narrow inspector dialog (which makes the page behind it inert). No health figure. | A degraded warning cannot disappear because an inspector is open. A source with no position is not a log of length zero. |
| Text | A record's string is a React text child: the browser takes it as text, never markup. The policy's withheld sentinel and generated aliases are marked as such wherever shown; free text that contains an alias token is shown whole. | Withheld payloads, local paths, secrets and unpresentable raw text are not in the page. |
| Intervention records | They are timeline entries of category `other`, envelope only, as the cockpit presents them. | Nothing here composes authorisation, acceptance and execution from loosely related events. |

## 7. Design parity with the concept

The concept (`endophasia-studio-concept`, branch `bolt-observe-handoff`) is a North Star, not a specification. Where its visual
fidelity and an evidentiary claim conflicted, the claim won and the presentation was adapted.

| Concept | Production | Why it differs |
| :--- | :--- | :--- |
| Warm graphite surfaces, ivory type, IBM Plex, mono for identifiers | Same tokens (`--surface-*`, `--fg-*`, the provenance hues, attention, fault, ivory for selection), as CSS custom properties in one style sheet; Plex Sans (400, 600) and Plex Mono (400), bundled | No Tailwind: a few hundred lines of plain CSS over the tokens fit the build; adding a styling toolchain for a small token system was not worth it. No serif face: Observe has no title that needs one. |
| Provenance marks OBS ● REP ◐ DER ◆ N/A ◌; squares for source and capability status | Same grammar; adds *mixed* and *envelope only*; *inferred* and *unknown basis* have marks (no v0 projection produces the first) | Production claims are per field and an event can carry several bases; "envelope only" is a real state the concept's synthetic data never had. |
| Swimlane trajectory overview | Lanes are the eleven production categories in the contract's order; marks by storage position; mark shape = field basis; rings = flags; ivory selection; dense windows draw thin bars | The concept's time axis, offsets and durations are gone: the producer's clock is not an order. The concept's six categories do not map to production's eleven. |
| Session brief (scenario, outcome, duration, statuses, deviations) | Sessions seen in this window (position range, entry count), as a filter | The projection records none of the concept's outcome, scenario, task or duration; a verdict must come from validated server-side code (`endo trajectory`), not be derived in a browser. |
| Event table, inspector with evidence first | Same: position, producer clock, category, kind and producer, basis, usage and flags; the inspector shows identity, flags, presented fields each with its basis, usage, and the record's own JSON | `title`, `summary` and `status` do not exist in the record and are not made up. |
| Six presentation states | Loading, healthy-empty, absent, degraded, unopenable, withheld, unsupported (named by record and version), request failure, pacing (with `Retry-After`), partial window: each says a different thing and none draws a placeholder | Production has more distinct conditions than the concept; every one has its own sentence and its own test. |
| Modal inspector under 1024 px | A native `<dialog>`: focus moves in, the page behind is inert, Escape and a Close button close it and clear the one selection, focus returns to the opener. Carries the source warnings with it. | The concept's handoff admitted its degraded callout disappears below `lg`. |
| WebGL/WebGPU scenes | Not taken. A restrained SVG overview, no GPU needed | Clarity, accessibility and determinism; the core UI runs with the GPU off, and the tests prove it. |
| Compare, Capabilities, Evolve | Named in the shell, loaded on demand, say what each needs, show nothing | The projections they need do not exist (section 6, concept interfaces against production contracts). |

## 8. Explicit non-goals (still)

The Compare, Capabilities and Evolve workspaces; the full declared-versus-observed capability matrix; any new data projection or HTTP
route; any steering or mutation endpoint; trajectory verdicts in the browser; authentication, hosted backends, analytics or
telemetry; WebGL or WebGPU; automatic monitoring or polling; any release, tag or version change (`0.1.0-alpha.2` is published and
untouched); a second HTTP security implementation; a development-server proxy.

## 9. Risks and limits

- **A new build dependency.** `esbuild` ships a platform binary through optional dependencies. It is pinned exactly and locked with
  integrity hashes, runs at build time only, and its output is verified by the manifest and the smoke test. The package itself still
  has no dependency.
- **Lockfile churn.** The lockfile is updated with npm 10.9.3 (the version the CI floor job uses).
- **The policy change** (`font-src 'self'`) admits only same-origin fonts.
- **The reference scan is a lexer, not a parser** (above). It fails closed on what it reads as a reference to something else, and the
  manifest's digest vouches for the bytes.
- **Per-file limit 4 MiB, 64 files, 64-character names.** The bundle is about 215 KiB of script, 16 KiB of style and three fonts. A large
  visualisation bundle would need splitting or a conscious raise of the limits in both the loader and the server.
- **Rendering cost.** Each page is one read of the whole log, and up to 500 rows are drawn; the table is not virtualised. The overview
  draws thin bars from 140 events up. Larger pages are a later change, with the read budget.
- **React 18, not 19.** Chosen to match the concept; moving later is an isolated change.
- **The marks summarise field bases**, which is what the record holds per event. If a later projection records a per-event basis, the
  mark changes with it.
- **The concept repository has no licence.** No code was copied from it.
- **What was run locally and what was not** is in the pull request's report.

## 10. The default of `endo studio`

**Decision: switched, and the earlier page retired in the same change.** The condition PR A set was that the new frontend replace the
earlier page's function, with its security and behavioural coverage carried across, not dropped. It does, and each part of that is a
test that was run, not a claim:

| What the earlier page was held to | Where it is held now |
| :--- | :--- |
| 44 browser tests on real stores (sources, paging, 429, focus, reply handling, aliases, ...) | the same 44, ported, in `tests/endo-studio-observe-browser.test.ts` (adapted, never weakened: the setup builds and loads the new frontend; events are dispatched so that React sees them (bubbling, and the native value setter for a text box); the kind column's selector gained `.kind` because the producer now shares the cell; wording follows the new labels ("Recorded" is "Producer clock", the unread-state sentence, the session options); and **one test is rewritten**, the hostile-text test, because the React frontend has no `widgets.js` to import: it now sends hostile strings through the real page from a stand-in API and asserts the same things) |
| Source rules (no HTML sink, one `fetch`, one timer, pure modules) | `tests/endo-studio-ui-source.test.ts`, recursively, plus the new React-specific rules |
| Model and classifier tests (31) | `tests/endo-studio-ui-contract.test.ts`, with the modules they test |
| HTTP transport over the page (guards, policy, no capability in what is served) | `tests/endo-cockpit-http-ui.test.ts`, over the new build |
| The loader's completeness check | `tests/endo-studio-host.test.ts` and `tests/endo-studio-ui.test.ts`, for the stricter loader that replaced it |
| `endo studio` from a clean installation: key creation, one address, refusals, SIGINT, taken port | `scripts/package-smoke.mjs`, unchanged in what it asserts of the command, now also driving a real browser over a populated, an absent and a torn-tail store |
| The real-Pi clean-install lane | `npm run test:acceptance`, which reads the recorded store through the installed command |

What was removed: `cockpit-ui/`, `scripts/build-cockpit-ui.mjs`, `loadEndoCockpitUiFilesV0`, the host's `uiFormat` option, the
`build:cockpit-ui` script, `dist/cockpit-ui/` from the package, and the earlier page's three browser/source/model test files (moved or
replaced as above). `npm run cockpit` (the development launcher) now builds and serves the same frontend from `studio-ui/dist`.
A package published before this change (`0.1.0-alpha.2`) still carries the earlier page in `dist/cockpit-ui/`; the package smoke test holds a
named older artifact to that layout and holds a build from the checkout to the new one.

**Not changed:** the CLI's arguments and help, the address line, the exit codes, the key handling, the server, and the page policy.

## 11. Handoff to the next change

1. **Projections before workspaces.** Compare (a pairing of two sessions with the method stated), Capabilities (declared surface beside
   observed evidence) and Evolve (lineage, experiments, candidates) each need a read-only projection in `cockpit/` with its own protocol
   version, validator and tests, *before* its workspace. The recommended next change is the Capabilities projection: Observe already
   shows each capability's recorded status and the limits on it, and a declared-versus-observed matrix is the smallest honest step.
2. **A per-event basis.** If the cockpit projection recorded a basis for the event itself (not only for its fields), the overview's mark
   could be exact instead of a summary of fields.
3. **Larger windows.** Virtualise the table and let the overview cover more than a page, together with a decision about the read budget.
4. **The concept's licence.** State it before any component code is copied.
5. **Keep the gate.** Extend `tests/studio-ui-acceptance.ts` rather than adding a second browser harness; keep `ENDO_REQUIRE_BROWSER=1`
   in CI.
