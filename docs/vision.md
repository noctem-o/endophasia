# Vision: what Endophasia is for, and the distinctions it keeps

Status: **concepts and intent.** This page holds the framing behind the [README](../README.md): the vocabulary, the
distinctions the project refuses to blur, the related projects, and the two ways of working (DEVELOP / EVOLVE and
WORK / DREAM). It describes direction and vocabulary, not what is implemented. What runs today is in
[status.md](status.md); the detail behind each mode is in [attachment.md](attachment.md), [observe.md](observe.md),
[evolve.md](evolve.md) and [roadmap.md](roadmap.md).

The text of each section was moved here from the README unchanged.

## What Endophasia is for

Coding agents do more than send a prompt to a model. They select context, compact history, call tools, branch, retry, verify work, spend tokens, accept steering, and sometimes propose actions with real effects.

Endophasia gives those parts explicit contracts and one place to inspect them.

It does not expose private chain of thought or relabel model activations as thoughts. It does not treat every runtime
feature as equivalent. It does not turn a benchmark score into truth, or a model's proposal into permission.

## The distinctions

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

For any adaptation loop, the chain is longer and every link is its own record:

~~~text
grader evidence != reward
reward          != selection
selection       != promotion
promotion       != authority
~~~

An observed event is shown as an observation. A derived value says how it was derived. A capability stays unavailable when a runtime cannot meet the contract — Endophasia reports `UNAVAILABLE` rather than filling the gap.

## Related projects

Related projects have separate jobs, and none grants another authority:

| Project | Job |
| :--- | :--- |
| **Endophasia** | Observes, steers, and compares agent runs |
| [Magpie](https://github.com/noctem-o/magpie) | Records claims and evidence; derives standing under explicit policy |
| [Deadbolt](https://github.com/noctem-o/deadbolt) | Decides whether a consequential action is authorised |
| [Cogitator](https://github.com/noctem-o/cogitator) | Seals run records with verifiable witness roots |
| [Buzz](https://github.com/noctem-o/buzz-prime) | Shared workspace where humans and agents coordinate around runs |

Independent architectural context for this direction: [*Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents*](https://arxiv.org/abs/2609.00006) (arXiv 2609.00006, a source-code study of eleven systems) separates a harness from a meta-harness, describes the shift from harness-as-tool to harness-as-platform, identifies minimal-core / extension-host designs (Pi among them), and treats memory, verification, extension surfaces and harness evolution as first-class concerns. It also notes ACP increasingly serving as a harness-hosting and interoperability boundary. It does not evaluate Endophasia; it is cited as context for the design, which attaches around a harness's own execution loop instead of replacing it.

## Develop and Evolve

DEVELOP and EVOLVE describe what the user is doing, not which software runs.

**DEVELOP** is the current session: what the agent is doing now, what the runtime actually reported, what context was used, and whether to intervene. Steering is explicit:

~~~text
STEER  change the active trajectory
QUEUE  deliver work at the next follow-up boundary
STOP   request an abort of the observed run
~~~

A receipt records that the runtime accepted the request. It does not claim the effect happened.

**EVOLVE** is the system-level improvement loop. It treats prompts, cognition policies, harness components, tools, memory, models, environments, and execution strategies as explicit candidate changes rather than hidden self-modification.

It follows a visible sequence:

~~~text
observe → propose → isolate → evaluate → compare → admit → promote
~~~

Promotion is deliberately last. A candidate can win an evaluation and still lack permission to replace anything.

EVOLVE is intentionally broader than reinforcement learning. RL can be one adaptation mechanism; RSI is a broader research direction covering repeated improvement of the model, harness, cognition policy, tools, memory, scaffolding, or execution strategy. Endophasia provides the substrate around these mechanisms: trajectories become evidence, evidence becomes evaluation input, and promotion remains gated.

The intended loop is:

~~~text
cognitive state
      ↓
what is uncertain?
      ↓
what evidence is missing?
      ↓
what experiment is useful?
      ↓
what should we spend?
      ↓
trajectory / experience
      ↓
evidence
      ↓
evaluation
      ↓
adaptation
      ↓
new cognition
      └───────────────────────↺
~~~

## Work and Dream

WORK and DREAM are planned cognition policies, separate from DEVELOP and EVOLVE.

**WORK** keeps one main trajectory, bounds exploration, and runs deterministic checks early.

**DREAM** allows broader search, more retained hypotheses, counterfactual branches, and stronger falsification.

~~~text
more cognition != more authority
more branches  != more truth
more agreement != more permission
~~~

Visualisations of either mode are projections of recorded cognition state. They remain separate from the OBSERVE
measurement surface above: if a signal is unavailable, the view says so rather than inventing cognition to make the
scene look interesting.

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
