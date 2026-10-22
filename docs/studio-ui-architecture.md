# Studio frontend foundation: architecture and security decision record

Status: **foundation only (Studio PR A).** A minimal React/TypeScript application is built, packaged, installed and served through
the production server at its real capability address. It is an integration proof: it reads no store and shows no recorded fact.
`endo studio` still serves the existing page (`cockpit-ui/`, [cockpit-ui.md](cockpit-ui.md)) and is unchanged. The new frontend is
reachable only through the host's `uiFormat: "studio"` option, which the tests and the package smoke test use. There is no CLI flag
and no route for it.

Its purpose is to settle packaging, routing, the page policy, asset loading and the observation trust boundary once, so that the
next change can port the design system and a real Observe workspace without reopening them.

Principle: **Studio must become a better instrument without becoming a second source of truth.** The frontend is a projection
surface over recorded evidence. It does not manufacture evidence and it does not grant standing.

## 1. What the audit found

| Constraint | Where it lives | Consequence for a React frontend |
| :--- | :--- | :--- |
| Node floor `>=22.19.0` (`engines`, the `package-floor` CI job) | `package.json`, `.github/workflows/ci.yml` | The build toolchain must run on 22.19.0 and produce the same files there as on newer Node. The concept declares `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; that field is the concept's own and is not inherited (section 6). |
| Self-contained package: no runtime dependency, `files: ["dist/"]` | `package.json`, `scripts/package-smoke.mjs` | React and everything else must be bundled at build time. The published tarball carries output only; the smoke test asserts the install has no React and no bundler. |
| Flat in-memory asset loader | `cockpit-http/host.ts`, `cockpit-http/server.ts` | The server serves `index.html` at `/<cap>/` and every other file at `/<cap>/assets/<name>`. Names are `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no directories, at most 4 MiB each. The build must emit a flat directory. |
| Allowed file types: `html`, `js`, `css`, `svg` | `UI_TYPES` in `server.ts` | A font needs one added type (`woff2`) and one policy directive (section 5). |
| Capability-prefixed routing: `/<per-launch-token>/` | `server.ts` | The page lives at an unpredictable path. Every reference must be relative (`./assets/<name>`); a Vite default of `base: "/"` would request `/assets/...` and be refused with 404. |
| CSP and Trusted Types: no inline script or style, no `unsafe-*`, `trusted-types 'none'` | `PAGE_CSP` in `server.ts` | A bundle must not inject a `<style>` or `<script>`, must not use `innerHTML`, and must not create a Trusted Types policy. |
| Existing acceptance | `tests/endo-cockpit-ui-browser.test.ts`, `tests/endo-studio-*.test.ts`, `scripts/package-smoke.mjs` | They pin the existing page, its file list and its policy string. They keep passing; the one pinned policy string gains `font-src 'self'`. |
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
- A dynamic `import()` is supported and exercised on every run: the proof shell lazily loads one small module, which becomes a
  separate file under the same assets path.
- The build is a pure function of the sources and the pinned dependencies. Two builds are compared byte for byte in the tests, and
  the output from Node 26 and Node 22.19.0 was compared and is identical.

### What the host checks (fail closed, before listening)

`loadEndoStudioUiFilesV0` (`cockpit-http/studio-ui.ts`) refuses the directory unless:

- `studio-ui.manifest.json` exists, is small, has exactly the keys `format`, `entry`, `files`, and a known format;
- every listed name is a plain name of an admitted type (`html js css svg woff2`), unique, with a bounded size and a sha256;
- the directory holds **exactly** the listed files and the manifest: a missing, extra, unlisted, linked or non-regular file is
  refused (the existing page's loader silently skips unknown names; this one does not);
- every file's size and sha256 match (files are read once into memory and served from memory, so what was verified is what is served);
- `index.html` refers only to `./assets/<name>`, a style sheet only to `./<name>` by `url()` (no `@import`, no `data:`, no remote, no
  parent path), and a script only imports `./<name>` modules, each of them listed.

It is called from `launchEndoCockpitV0` (option `uiFormat: "studio"`) *before* the digest key is loaded or created and before the
server listens, so a damaged install leaves no key, no store and no listener. The installed-package smoke test checks this too.

Inline script, inline style, `on*` handlers, `javascript:` and remote URLs in the page are not parsed out of the JavaScript; they
are the browser's to refuse under the page policy, and the browser acceptance asserts that nothing was requested outside the
server and nothing was blocked. (Scanning minified React for `https://` is pointless: it contains documentation URLs.)

### Why not the alternatives

| Alternative | Verdict |
| :--- | :--- |
| **Vite unchanged** (the concept's toolchain) | Rejected, on verified grounds, not on a Node-floor claim: Vite 7's own engine range (`^20.19.0 \|\| >=22.12.0`) accepts 22.19.0. The reasons are fit and size. Vite's default is an absolute `base: "/"`; its HTML transform, `modulepreload` polyfill and CSS-code-splitting preload helper are generated code this repository would have to audit against Trusted Types; its default output puts hashed files in `assets/` and the entry beside them, which would need a small loader change or `assetFileNames`/`entryFileNames` overrides to become the flat set this loader reads; and it brings rollup, a plugin tree and a dev server, none of which production uses. |
| **Vite configured** (`base: "./"`, flat `assetFileNames`, `modulePreload: false`, no CSS code split) | Feasible, and the right choice if a later change needs Vite-only features (HMR for development, a plugin ecosystem). Here it is more moving parts to defeat than to use. It can be adopted later without changing anything else in this design, because the contract between build and host is the flat directory plus the manifest, not the bundler. |
| **`tsc` only, no bundler** (what `cockpit-ui/` does) | Not possible for React: its packages are CommonJS and are not importable by a browser without a bundler or an import map pointing at files that would have to be served. Rejected by the task's own rule against import maps outside the package. |
| **Rewrite the server as a static file router** | Rejected. The in-memory, closed, flat loader is the security property. Nothing about React needs a filesystem router. |
| **A development-server proxy** | Rejected as a production path. A developer who wants hot reload can run the concept's own Vite server against recorded JSON; that is not part of this repository. |
| **Keep the page with no framework** | Valid, and the existing page stays. The concept's component structure (four workspaces, SVG and WebGL2 visualisations) is what React is for. |

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
| `@fontsource/ibm-plex-sans` | 5.3.0 | one latin 400 `woff2` of the concept's sans typeface, SIL OFL 1.1; the licence is packed |

From the concept, deliberately **not** taken:

| Concept dependency | Decision |
| :--- | :--- |
| `@supabase/supabase-js` | **Excluded.** A hosted backend client has no place in a local, read-only instrument. A source test asserts none is imported or declared. |
| `lucide-react` | Excluded for now. Icons are needed only when real workspaces are ported; they can be inlined SVG components with no dependency. |
| `tailwindcss`, `postcss`, `autoprefixer` | Deferred. Their output is a style sheet, which this build already handles; choosing between Tailwind and plain CSS with tokens is a PR B design decision, not a foundation one. If adopted, they run at build time only. |
| `vite`, `@vitejs/plugin-react` | Not needed (above). |
| `@playwright/test`, `jsdom`, `@testing-library/*`, `vitest@5` | Excluded. Browser behaviour is tested with the existing Chromium/CDP driver; production uses `vitest@4`. Component unit tests in PR B can use the existing runner without a DOM, against pure view-model functions. |
| `@fontsource/ibm-plex-serif`, `-mono` | Deferred until used; each added face is a file in the manifest and a line in the licence notices. |
| `eslint`, `typescript-eslint`, and plugins | Excluded. Production lints with Biome, which now covers `studio-ui/**/*.{ts,tsx}`. |

The concept's repository carries no `LICENSE` file. This change copies **no code** from it, only a small colour-token subset and the
choice of typeface; both are the repository owner's own. Before PR B copies components, the concept repository should state its
licence so that attribution is unambiguous.

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

**Tests that hold this** (all run in CI):

- `tests/endo-studio-ui-browser.test.ts` and, from the installed package, `scripts/package-smoke.mjs`: both call
  `tests/studio-ui-acceptance.ts`, which opens the real address in headless Chromium **with the GPU off** and asserts: the shell and
  the lazy module render; the style sheet and a style set through React's style object apply; the SVG decodes; the font face reaches
  `loaded` (a declared but unused font is never fetched, so the page uses it); every resource answered 200 under
  `/<cap>/assets/`; every request went to the serving origin; no console message, exception, CSP or Trusted Types violation; a
  string assigned to `innerHTML` still throws; a Trusted Types policy cannot be created.
- Negative: a page that declares a `data:` font and a remote font is blocked by the policy, the remote host sees no request, and the
  violation is reported.
- `tests/endo-studio-ui.test.ts`: the repeatable, closed build; the loader's refusals (missing, extra, tampered, resized, linked
  and non-file entries; manifest of another shape; paths, other types, bad sizes and digests; remote, data:, protocol-relative,
  absolute, parent-path and missing references in the page, style sheet and modules); a damaged build leaves no key and no
  listener; the server's guards over the new files (traversal and encoded forms, the manifest itself, unlisted names, queries,
  wrong capability, wrong Host, foreign Origin, cross-site fetch, POST, HEAD, a body); the API still answers beside the frontend;
  the sources make no request, parse no markup and import no hosted client.
- `tests/endo-cockpit-http-lifecycle.test.ts`: the new loader reads one directory and nothing else (no environment, no key, no
  write, no network); `host.ts`'s own imports stay the short list it pinned.
- Existing suites are unchanged except the one pinned policy string (`font-src 'self'`) and the list of `host.ts` imports in the lifecycle test (it gains `./studio-ui.ts`). The package smoke test keeps every existing check; its inventory check now excludes `dist/studio-ui` and `dist/licenses`, which have checks of their own.

**Known limits of the checks:** the JavaScript reference scan is textual on the minified output of this build; it can refuse a
legitimate future bundle that happens to contain a quoted `from "…"` string, and it fails closed when it does. It cannot, and does
not try to, prove the absence of network code; the page policy and the browser acceptance do that.

## 6. The data boundary (how the frontend will consume Endophasia data)

Production records and validators stay authoritative. The browser receives projections the server has already validated: every
API body is a record read under the version it declares (`readEndoCockpitRecordV0`) before it is sent.

### Rules for the React application

The frontend must not import the concept's synthetic sessions as data; must not reinterpret missing evidence as observed facts; must
not invent provenance or capability state; must not compute an authoritative trajectory verdict from the fields a browser can see;
must not infer permission from a recorded proposal or acceptance; and must not render a simulation as an execution.

### A pure view-model adapter

Between the validated projections and the components, one pure, typed module (planned location `studio-ui/src/model/`, no DOM, no
fetch, no clock):

```ts
// input: what protocol/cockpit.ts defines (imported as types), already validated by the server
// output: what a component may render; every distinction below is a distinct type, not a flag
function toObserveViewModel(snapshot: EndoCockpitSnapshotV0): ObserveViewModel;
```

Properties it must have, each testable as a pure function:

- **Version-gated.** An unknown `schemaVersion` or `projectionVersion` yields an explicit *unsupported* model, never a best guess.
- **Total over absence.** A claim is a discriminated union (`{ basis, value } | { basis: "unavailable", reason }`), as in the
  protocol. There is no `number | undefined` that a component can coerce to `0`.
- **Fetched relatively.** Requests are `./api/v0/...` relative to `document.baseURI`, as `cockpit-ui/src/api.ts` does, so the
  capability stays in the address bar and never in code, a query string or a log.
- **Tested against the real fixtures** (`tests/cockpit-fixtures.ts`), not against synthetic sessions.

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

## 7. Explicit non-goals

The Observe, Compare, Capabilities and Evolve workspaces; the full design system; WebGL2/SVG visualisation components; any new
data projection or HTTP route; any steering or mutation endpoint; authentication, hosted backends, analytics or telemetry; changing
the default of `endo studio`; any release, tag or version change (`0.1.0-alpha.2` is published and untouched); a second HTTP
security implementation; a development-server proxy.

## 8. Risks and limits

- **A new build dependency.** `esbuild` ships a platform binary through optional dependencies. It is pinned exactly and locked with
  integrity hashes, runs at build time only, and its output is verified by the manifest and the smoke test. The package itself still
  has no dependency.
- **Lockfile churn.** The lockfile was updated with npm 10.9.3 (the version the CI floor job uses). It also removes `"peer": true`
  flags (27) and one `optional` flag that a newer npm had written on unrelated entries; no resolved version or integrity of an existing package changed.
- **The policy change applies to the existing page** (`font-src 'self'`). It admits only same-origin fonts, and that page has none.
- **The reference scan is textual** (above). It fails closed.
- **Per-file limit 4 MiB, 64 files.** React 18 plus the proof shell is about 135 KiB. A large visualisation bundle would need
  splitting or a conscious raise of the limits in both the loader and the server.
- **React 18, not 19.** Chosen to match the concept; moving later is an isolated change.
- **What was run locally, and what was not.** Run: typecheck, lint, the full test suite, the build, the package smoke test with a real
  browser on Node 26.12 and again on Node 22.19.0 with npm 10.9.3, and the real-Pi clean-install lane (`npm run test:acceptance`, Pi
  1.0.0 installed into a scratch prefix as the CI job installs it). Not run: the GitHub-hosted jobs themselves; CI is their gate.

## 9. Handoff to PR B

1. **Port the design system into `studio-ui/`.** Tokens from `src/design/tokens.json` as CSS custom properties in the style sheet; add
   the remaining faces one at a time (each is a manifest entry and a notice). Decide Tailwind versus plain CSS; both fit the build.
   Resolve the concept's licence statement before copying components.
2. **Add the adapter.** `studio-ui/src/model/` with `toObserveViewModel`, tested against `tests/cockpit-fixtures.ts`, including the
   unavailable, absent, degraded and unopenable cases and an unknown projection version.
3. **Fetch relatively** from `./api/v0/snapshot` (and `timeline`, `runtime/<attachment>`), as the existing page does, honouring the 429
   `Retry-After` and the read budget; no polling.
4. **Build the Observe workspace** over real evidence, reusing the existing page's lessons (`cockpit-ui/src/model.ts`, `labels.ts`):
   storage order only, the producer's clock labelled, usage three-valued, payloads withheld.
5. **Switch the default** of `endo studio` to the new frontend only when it replaces the existing page's function: change
   `endoStudioUiDirectoryV0` and the `uiFormat` in `cli/studio.ts`, update the package-smoke expectations, and retire `cockpit-ui/`
   in the same change, with its tests moved, not deleted.
6. **Keep the gate.** Extend `tests/studio-ui-acceptance.ts` rather than adding a second browser harness; keep
   `ENDO_REQUIRE_BROWSER=1` in CI.
7. **Projections for Compare, Capabilities (declared versus observed) and Evolve** are separate changes in `cockpit/` with their own
   protocol versions, validators and tests, each before its workspace.
