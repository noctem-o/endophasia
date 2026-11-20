# Observe Geometry (`OBSERVE-GEOMETRY-001`)

Isolated Python tooling and offline example artifacts for Endophasia’s **Representation Explorer** (`docs/designs/observe-representation-explorer.md`).

This directory is intentionally decoupled from Endophasia’s Node/TypeScript package: `endo studio` never requires Python, PyTorch, TransformerLens, GPU drivers, or model weights to build or run.

## Included offline example

- `examples/smollm2-135m-resid-post.json`: real observed residual-stream activations (`blocks.{layer}.hook_resid_post`) captured from `HuggingFaceTB/SmolLM2-135M-Instruct` (`float32`, CPU, `raw-hf` weights, GQA `9Q / 3KV`, 4 layers `[0, 9, 19, 29]` × 17 tokens × `d_model=576`) using TransformerLens `4.4.0` `TransformerBridge.boot_transformers`.

## Inspecting in Endophasia Studio (no Python required)

```sh
npm run build:studio-ui
node cli/index.ts studio ./demo-store --representations ./research/observe-geometry/examples
```

Open the printed capability URL, then select **Representation Explorer** inside the **Observe** workspace.

## Reproducing the offline capture (optional, requires `uv`)

```sh
uv run research/observe-geometry/capture_activations.py \
  --model HuggingFaceTB/SmolLM2-135M-Instruct \
  --layers 0,9,19,29 \
  --device cpu \
  --dtype float32 \
  --out research/observe-geometry/examples/smollm2-135m-resid-post.json
```

Pass `--compatibility-mode` to record a separate TransformerLens compatibility-mode execution (recorded explicitly in `subject.weightProcessing`), or `--execution-role reference-replay --replay-of <artifact-id>` when teacher-forcing a token sequence from another serving backend as comparison evidence.
