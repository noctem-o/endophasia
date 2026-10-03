<a id="endophasia"></a>

<div align="center">

<p><sub>DEVELOP / EVOLVE &nbsp; · &nbsp; WORK / DREAM &nbsp; · &nbsp; OBSERVE / VERIFY</sub></p>

<h1>endophasia</h1>

<p><strong>Instrumented cognition for coding agents.</strong></p>

<p>
Observe agent runtimes, steer current work, compare experiments,<br>
and keep evidence separate from permission.
</p>

<p>
  <a href="#current-state"><img src="https://img.shields.io/badge/status-experimental-637d69?style=flat-square" alt="Status: experimental"></a>
  <a href="https://github.com/earendil-works/pi"><img src="https://img.shields.io/badge/reference%20runtime-Pi-536c85?style=flat-square" alt="Reference runtime: Pi"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-94765e?style=flat-square" alt="License: MIT"></a>
</p>

<p>
  <a href="#why-endophasia">Why</a> &nbsp; · &nbsp;
  <a href="#how-it-attaches">Attach</a> &nbsp; · &nbsp;
  <a href="#develop-and-evolve">Develop / Evolve</a> &nbsp; · &nbsp;
  <a href="#work-and-dream">Work / Dream</a> &nbsp; · &nbsp;
  <a href="#evidence-and-authority">Evidence</a> &nbsp; · &nbsp;
  <a href="#current-state">Status</a> &nbsp; · &nbsp;
  <a href="#roadmap">Roadmap</a>
</p>

</div>

---

Coding agents do more than send a prompt to a model. They select context, compact history, call tools, branch, retry, verify work, spend tokens, accept steering, and sometimes propose actions with real effects.

Endophasia gives those parts explicit contracts and one place to inspect them.

It does not expose private chain of thought. It does not treat every runtime feature as equivalent. It does not turn a benchmark score into truth, or a model's proposal into permission.

> [!IMPORTANT]
> Endophasia is experimental. This repository is the standalone home of the project; the earlier Pi-fork version, which demonstrated the v0 cockpit and observation contracts, lives at [endophasia-pi-legacy-deprecated](https://github.com/noctem-o/endophasia-pi-legacy-deprecated). See [Current state](#current-state) for exactly what runs today.

## Why Endophasia

The project keeps these distinctions explicit:

~~~text
observation  != inference
acceptance   != execution
evidence     != standing
proposal     != permission
history      != active context
configured   != in-flight
simulation   != real execution
evaluation   != promotion
~~~

An observed event is shown as an observation. A derived value says how it was derived. A capability stays unavailable when a runtime cannot meet the contract — Endophasia reports `UNAVAILABLE` rather than filling the gap.

Related projects have separate jobs, and none grants another authority:

| Project | Job |
| :--- | :--- |
| **Endophasia** | Observes, steers, and compares agent runs |
| [Magpie](https://github.com/noctem-o/magpie) | Records claims and evidence; derives standing under explicit policy |
| [Deadbolt](https://github.com/noctem-o/deadbolt) | Decides whether a consequential action is authorised |
| [Cogitator](https://github.com/noctem-o/cogitator) | Seals run records with verifiable witness roots |
| [Buzz](https://github.com/noctem-o/buzz-prime) | Shared workspace where humans and agents coordinate around runs |

## How it attaches

Endophasia is a substrate, not a runtime. It attaches to agent harnesses you already run, through explicit adapters.

~~~mermaid
flowchart TB
    R["Harness you install<br/>Pi · Codex · Prime"] --> A["Endophasia adapter"]
    A --> S["Endophasia services<br/>events · evidence · graph"]
    S --> C["Cockpit"]
~~~

Harnesses are installed and updated the usual way, outside Endophasia. Endophasia records each harness's version on attach. When the installed version changes, it marks that adapter's capabilities unverified and re-runs its conformance checks before trusting them again:

~~~text
Pi updated 0.9.7 → 0.9.8
  41 EXACT · 2 PARTIAL · 1 MISMATCH (steering)
  steering disabled until reviewed
~~~

Every recorded run carries the harness version that produced it, so results from before and after an update are never silently treated as comparable.

Runtime admission is evidence-based, and always in this order:

~~~text
transport  →  conformance study  →  recorded evidence  →  capability admission
~~~

| Runtime | Role |
| :--- | :--- |
| Pi | Reference runtime |
| Prime | Research subject. The sealed 0.9.7 study admitted no exact capability. |
| Codex | Future candidate, pending its own pinned study |

"Nothing matched exactly" is a valid research result.

## Develop and Evolve

DEVELOP and EVOLVE describe what the user is doing, not which software runs.

**DEVELOP** is the current session: what the agent is doing now, what the runtime actually reported, what context was used, and whether to intervene. Steering is explicit:

~~~text
STEER  change the active trajectory
QUEUE  deliver work at the next follow-up boundary
STOP   request an abort of the observed run
~~~

A receipt records that the runtime accepted the request. It does not claim the effect happened.

**EVOLVE** is repeated experiments over candidate prompts, harnesses, policies, tools, or models. It follows a visible sequence:

~~~text
observe → propose → isolate → evaluate → compare → admit → promote
~~~

Promotion is deliberately last. A candidate can win an evaluation and still lack permission to replace anything. Adaptation methods such as [REEF](https://github.com/Human-Agent-Society/reef) or [RRSI](https://github.com/google-research/rrsi) plug in as optional providers behind the same experiment and evidence contracts; they are not bundled.

A stored result identifies everything needed to understand it: candidate revision, runtime and model identity, cognition policy, environment revision, evaluator and grader identity, seeds and trial count, usage, and a digest of the result bundle. A simulated result says it was simulated.

## Work and Dream

WORK and DREAM are planned cognition policies, separate from DEVELOP and EVOLVE.

**WORK** keeps one main trajectory, bounds exploration, and runs deterministic checks early.

**DREAM** allows broader search, more retained hypotheses, counterfactual branches, and stronger falsification.

~~~text
more cognition != more authority
more branches  != more truth
more agreement != more permission
~~~

Visualisations of either mode are projections of recorded state. If a model does not expose a signal, the view says so; it never invents cognition to make the scene look interesting.

## Evidence and authority

These are four different statements, and Endophasia keeps them as four different records:

~~~text
candidate c17 passed 43 of 50 trials          evaluation result
candidate c17's result bundle has digest X    mechanically checkable
candidate c17 is supported under policy P     epistemic conclusion  (Magpie)
candidate c17 may replace the current version authority decision    (Deadbolt)
~~~

Plans are not effects:

~~~mermaid
flowchart TB
    I["Model intent"] --> P["Structured proposal"]
    P --> R["Review and policy"]
    R --> A["Authority check"]
    A --> E["Real effect"]
    E --> C["Receipt"]
~~~

A valid proposal does not widen the model's permission.

## Current state

**Demonstrated in the legacy Pi fork:** a browser cockpit, Mission Trace, Continuity Inspector, steering controls, usage and runtime accounting, operation outcomes, runtime-neutral observation contracts, Runtime Profile v0, Prime RPC ingress, and the Conformance Lab with the sealed Prime 0.9.7 study.

**In review here:** the migration of that work into this repository, and a runtime-neutral protocol layer — versioned `endo.*` events and identities, an evidence store with replay, a typed cognition graph, evaluation and conformance records, evolution and promotion records, and trust-record mappings for Cogitator, Magpie, and Deadbolt.

**Not yet built:** attaching to an independently installed harness, harness version tracking, an end-to-end run through the new protocol layer into the cockpit, live provider integrations, and WORK / DREAM policy compilation.

Endophasia is ready for architecture experiments. It is not a stable multi-runtime product.

## Roadmap

1. **Attach model.** Map every Pi internal the current runtime depends on into: available over Pi's protocol, needs a plugin hook, or needs an upstream change. Replace the vendored fork with an adapter to a user-installed Pi.
2. **First end-to-end slice.** A real Pi session emits `endo.*` events into the durable store, builds the cognition graph, and appears in the cockpit.
3. **Harness version tracking.** Record harness fingerprints, detect changes, and re-run conformance automatically.
4. **Codex conformance study.**
5. **Optional EVOLVE providers**, then Magpie and Deadbolt integrations.

Later layers wait until earlier contracts have survived a real integration.

> Do not report more certainty, compatibility, evidence, or authority than the recorded inputs support.

## License

MIT. Upstream components such as Pi remain under their own licenses.
