# OBSERVE and VERIFY: what is measured, and what the evidence justifies

Status: **design, apart from harness-level observation.** What Endophasia records about a harness today (lifecycle, context,
tools, usage, evidence, trajectories) is implemented and is described in [status.md](status.md). **Nothing below it exists in
this repository as code**: there is no model-internal observation provider, no TransformerLens, vLLM-Lens or NNsight integration,
no typed Observe scene and no WebGPU renderer. This page is the architecture those would follow; the first Studio page
([studio.md](studio.md)) shows none of it.

The text was moved here from the README's "Observe and Verify" section unchanged, except that one sentence now says "a browser
view could render" these scenes, not "the planned browser cockpit can", because the first Studio page exists and renders none of this.

OBSERVE and VERIFY cut across DEVELOP and EVOLVE: they describe what is measured and what the evidence justifies, not
another adaptation stage.

**OBSERVE** is the measurement surface. It shows what Endophasia actually recorded and what can be derived reproducibly
from those records.

At the harness level this includes lifecycle, context, tools, usage, evidence and trajectories. Where a local-model
provider exposes model internals, OBSERVE may also record model-level signals such as residual-stream activations,
logits, probes and layer/token traces. Model-internal observation is capability-gated: a provider that does not expose
a signal remains `UNAVAILABLE`.

Model-internal capabilities are backend-specific. Endophasia records what the serving implementation actually exposes
rather than normalising unavailable signals into fictitious equivalence. The preferred reference architecture, where
the model family is supported, is [TransformerLens 4.0](https://transformerlensorg.github.io/TransformerLens/content/news/release-4.0.html):
one `TransformerBridge` hook vocabulary over different Drivers, with each backend declaring its
`supported_hook_points` and `non_fireable_hook_points`. Its compiled vLLM Driver keeps `torch.compile` and CUDA
graphs for high-throughput capture and declarative steering; its Hugging Face `transformers` Driver provides the
full hook tree, gradients and explicit attention patterns for deeper inspection.

[vLLM-Lens](https://github.com/UKGovernmentBEIS/vllm-lens) remains a specialist provider rather than the default common
surface: it is useful when an experiment specifically needs Q/K capture and attention reconstruction, Jacobian/R-lens
readout, persistent hooks, arbitrary Python hooks, or its broader distributed execution paths. Those are additional
capabilities, not grounds to erase backend differences. For a recorded run, the backend that actually executed it is
the primary observation; a reference backend supplies comparison evidence.

Model internals stay separate from the cognition graph. An activation is not a thought, an activation region is not a
hypothesis, and a geometric projection is not evidence merely because it is visually coherent.

~~~text
recorded model state
        ↓
declared analysis
PCA · MFA · SAE · lens · probe
        ↓
typed Observe scene
        ↓
browser renderer
~~~

Every model-internal artifact must identify enough execution provenance to say what was actually measured: model
family and checkpoint or weight digest; weight dtype or quantisation; quantiser and revision where applicable; serving
backend and version; execution driver; relevant compute or attention kernel; compute dtype; capture point and layer;
analysis method and revision; and the evidence or artifact from which it was produced. Quantised and full-precision
variants are therefore distinct experimental subjects, not silently interchangeable representations of one model.

Weight-processing semantics are part of that identity. A raw Hugging Face bridge and a
[TransformerLens compatibility-mode](https://transformerlensorg.github.io/TransformerLens/content/compatibility_mode.html)
bridge may generate equivalent outputs while exposing different residual norms, logit-lens values and processed
weights. Record whether the bridge used raw HF weights or compatibility mode and, when enabled, the exact processing
flags such as LayerNorm folding and weight centring. Compatibility-mode processing is one-shot and mutates the bridge
in place, so a raw-vs-processed comparison must use separately identified executions.

Tensor shape is provenance too. Under grouped-query attention, TransformerLens 4.0 keeps Q at the query-head count but
K/V at the native key/value-head count rather than expanding them to one copy per query head. OBSERVE therefore records
both query-head and KV-head counts plus the tensor's head semantics; a renderer or reconstruction must never infer
per-query-head K/V that the backend did not expose. See the
[TransformerBridge model-structure contract](https://transformerlensorg.github.io/TransformerLens/content/model_structure.html).

The same recorded observation can be re-projected without changing the underlying evidence. Deeper inspection may also
**reference-replay** the exact recorded token sequence through another backend, for example teacher-forcing a live vLLM
run through a Hugging Face backend with fuller hooks:

~~~text
live serving observation
        ↓
recorded token sequence
        ↓
reference replay
        ↓
comparison
~~~

Replay is separately identified comparison evidence. It does not overwrite the serving-backend observation or claim
that replay activations produced the original answer.

Recorded and derived model signals remain distinct as well. TransformerLens's vLLM Driver does not expose attention
patterns or scores because that path is fused in the serving kernel; the capability remains `UNAVAILABLE` there.
An eager Hugging Face reference execution can record an explicit attention pattern for that replay backend. A
vLLM-Lens run can instead record Q/K tensors and reconstruct the pattern afterward; in Endophasia the Q/K tensors are
recorded evidence and the reconstructed pattern is `DERIVED`. Both can be useful; neither is relabelled as the other.

Arbitrary executable hooks are a separate high-trust capability. vLLM-Lens documents that Python hook functions sent
over HTTP are serialized with `cloudpickle`, which is arbitrary code execution on the serving process. Endophasia
should therefore leave generic remote Python hooks `UNAVAILABLE` by default and admit them only in an explicitly
trusted-local research configuration. Declarative TransformerLens vLLM interventions (`suppress`, `scale`, `add`,
`set`) are the preferred default mutation surface when they are sufficient.

A browser view could render these scenes through
[WebGPU](https://www.w3.org/TR/webgpu/). Rendering remains downstream of the evidence: positions, trajectories,
regions, connections and quantitative visual encodings must correspond to recorded values or declared deterministic
transforms of them. Presentation effects such as lighting, bloom and camera motion may improve readability, but never
manufacture structure.

DREAM and OBSERVE can share a rendering engine without sharing semantics:

~~~text
cognition graph ───── → Dream scene ────┐
                                        ├── → WebGPU
model observations ─ → Observe scene ───┘
~~~

DREAM presents a coherent projection of recorded cognition state. OBSERVE exposes the measurements and declared
analyses underneath it.

**VERIFY** asks a different question: what do those observations justify? Replay, fixed-condition repetition,
perturbation invariance, causal interventions and comparison remain evidence procedures rather than properties of the
rendered scene.
