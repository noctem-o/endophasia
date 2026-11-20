# OBSERVE-GEOMETRY-001: Representation Explorer Architecture Note

Status: **implemented vertical slice (read-only, offline capture + deterministic 2D PCA scene + Studio Observe UI)**.

This note documents the first evidence-backed representation visualisation capability in Endophasia’s Observe workspace and outlines the next step toward real local-model capture, including the concrete limitations of the GGUF / `llama.cpp` workflow.

---

## 1. Vertical slice implemented

```text
isolated offline capture (Python / TransformerLens 4.x TransformerBridge)
        │  writes validated JSON (optional; Studio never requires Python/GPU)
        ▼
endo.observe-representation-capture.v0  (protocol/observe-representation.ts)
        │  read-only, bounded, symlink-refusing scan; keyed opaque selectors
        ▼
deterministic 2D PCA projection         (cockpit/projections/representation-scene.ts)
        │  mean-centered Jacobi eigendecomposition + max-abs-positive sign canonicalization
        ▼
endo.observe-representation-scene.v0    (served via GET /<cap>/api/v0/observe/representation/<sel>)
        │  browser wire-gated (studio-ui/src/model/representation-wire.ts)
        ▼
Representation Explorer (2D SVG)        (studio-ui/src/observe/RepresentationExplorer.tsx)
```

### Key guarantees

- **Epistemic separation**: Every record and inspector section preserves explicit `OBSERVED` (captured vector statistics, tokens, observed top next-token logit/probability), `DERIVED` (2D PCA coordinates, explained variance ratios, full-space distance from slice centroid, fraction of displacement orthogonal to the 2D plane), `INTERPRETED` (strictly isolated and empty by default; never generated from clusters or geometry), and `UNAVAILABLE` (explicit signal/dimension gaps with reasons).
- **Execution-subject provenance**: Captures and scenes record `executionRole` (`primary-observation`, `reference-replay`, or `test-fixture`), model family/id/revision/weight SHA-256/dtype/quantization, backend framework/version/driver/compute dtype/device/attention kernel, weight processing (`raw-hf` vs `tl-compatibility-mode` flags), capture hook point, tensor shape, and GQA head semantics (`queryHeads` vs `kvHeads` without expanding K/V).
- **Capability-gated dimensions**: Layer selection and token filtering appear in the UI only when `dimensions.layers.supported` or `dimensions.tokens.supported` is true; unsupported dimensions render explicit `UNAVAILABLE` notices and are refused by the server (`400`) if queried.
- **Read-only security boundary**: Served behind the existing cockpit HTTP guards (loopback `127.0.0.1`, 256-bit capability token, Host/Origin/Fetch Metadata checks, GET-only, read budget, strict CSP + Trusted Types, zero external requests). Opening Observe Timeline makes no extra request; Representation Explorer reads only when explicitly opened.
- **No runtime ML dependency**: Starting `endo studio` requires no Python, PyTorch, GPU, or model weights.

---

## 2. TransformerLens 4.x `TransformerBridge` investigation findings

Inspection of `transformer-lens` `4.4.0` (`transformer_lens.model_bridge.driver_protocol`) confirmed the contract referenced in [observe.md](../observe.md):

1. **Legacy `HookedTransformer` is replaced by `TransformerBridge`**: Models load via `TransformerBridge.boot_transformers(...)` (raw Hugging Face weights by default) rather than legacy implicit weight processing.
2. **Explicit Driver capability contract (`Driver` protocol)**:
   - `supported_hook_points: frozenset[str]` and `non_fireable_hook_points: frozenset[str]` are mandatory, disjoint sets enforced by `validate_driver()`.
   - `provides_sequence_logits: bool` explicitly distinguishes full-sequence logit drivers from final-position-only drivers.
   - `supports(feature)` queries the closed `KNOWN_FEATURES` set (`gradients`, `parameters`, `state_dict`, `weight_access`, `intervention_callbacks`).
3. **Weight-processing provenance**: Calling `bridge.enable_compatibility_mode(fold_ln=..., center_writing_weights=..., center_unembed=..., fold_value_biases=...)` mutates weights in place. Endophasia therefore records `weightProcessing.mode` (`raw-hf` vs `tl-compatibility-mode`) and each flag on every artifact.
4. **GQA head semantics**: Verified directly on `HuggingFaceTB/SmolLM2-135M-Instruct` (`n_layers=30`, `d_model=576`, `n_heads=9`, `n_key_value_heads=3`), where the isolated capture script (`research/observe-geometry/capture_activations.py`) records `9Q / 3KV` verbatim and marks expanded per-query-head K/V as `UNAVAILABLE`.

---

## 3. Next step toward real local-model capture (and GGUF / `llama.cpp` limitations)

Endophasia’s day-to-day local model workflow uses quantized GGUF weights served through `llama.cpp` (`llama-server` / OpenAI-compatible HTTP endpoints, as documented in [protected-model-access.md](../protected-model-access.md) and [evolve.md](../evolve.md)). Moving from offline single-prompt examples to real local-model capture faces four hard technical boundaries that Endophasia must preserve honestly rather than smooth over:

1. **Stock `llama-server` does not expose internal activations**:
   - The HTTP server exposes completions, tokenisation, and optional top-k logprobs, not residual-stream tensors, MLP activations, or attention weights.
   - Under stock `llama-server`, internal activation capture remains `UNAVAILABLE`.
2. **Quantised GGUF weights are a distinct experimental subject**:
   - A `Q4_K_M` or `Q8_0` GGUF model running on `llama.cpp` CUDA/CPU kernels is numerically different from an `f16`/`f32` Hugging Face safetensors checkpoint running in PyTorch.
   - Any downstream comparison must record weight file digest, quantisation scheme, runtime build revision, and kernel backend separately—never claiming activation equivalence across quantised and full-precision subjects.
3. **Native `llama.cpp` callback capture is intrusive and non-canonical**:
   - `ggml_backend_sched_eval_callback` (explored for scalar numerical diagnostics in `research/numerical-execution-probe/`) can intercept intermediate GGML graph nodes in-process, but requires a custom C++ bridge, incurs host-copy synchronisation cost, cannot run transparently against an external `llama-server` process, and emits GGML graph tensor names rather than canonical TransformerLens hook points.
4. **Reference replay is comparison evidence, not original inference**:
   - Teacher-forcing a recorded `llama.cpp` token sequence through a Hugging Face `TransformerBridge` yields rich multi-layer hooks and full sequence logits, but those activations were produced by the reference backend and checkpoint—not by the live `llama.cpp` execution.

### Recommended two-path next step

1. **Path A — Explicit Reference-Replay Bridge (lowest friction for GGUF users)**:
   - Add a standalone offline CLI helper that extracts a recorded prompt + completion token sequence from an Endophasia store/relay capture, runs teacher-forced capture through `research/observe-geometry/capture_activations.py --execution-role reference-replay --replay-of <primary-id>`, records top-token logit agreement/divergence against the primary logprobs where available, and writes the artifact into `<store>/representations/`.
   - Studio already renders `reference-replay` artifacts with a distinct shape, colour, and explicit comparison-evidence banner.
2. **Path B — Primary Serving-Time Capture (for live research runs)**:
   - Integrate TransformerLens 4.x’s compiled vLLM Driver for live OpenAI-compatible serving with declarative hook capture (carrying `supported_hook_points` and `non_fireable_hook_points` directly from the driver so fused attention patterns remain `UNAVAILABLE`), and optionally a bounded native `llama.cpp` eval-callback recorder explicitly marked `weightProcessing.mode: "native-quantized"` for in-process GGUF studies.
