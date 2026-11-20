#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = [
#   "transformer-lens>=4.0,<5.0",
#   "torch",
#   "transformers",
#   "numpy",
# ]
# ///
"""Isolated offline activation capture for Endophasia Observe (OBSERVE-GEOMETRY-001).

Uses TransformerLens 4.x `TransformerBridge.boot_transformers` to record real
residual-stream activations and exact backend capability / provenance metadata
into an `endo.observe-representation-capture.v0` JSON artifact.

This script is strictly isolated from Endophasia's Node/TypeScript runtime:
Studio never requires Python, PyTorch, or model weights to build or start.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.metadata
import json
from pathlib import Path
from typing import Any

import torch
import transformers
from transformer_lens.model_bridge import TransformerBridge
from transformer_lens.model_bridge.driver_protocol import KNOWN_FEATURES


def sha256_weight_files(model_id: str, revision: str | None) -> tuple[str | None, str | None]:
    """Compute a deterministic SHA-256 over cached safetensors/bin weight files and resolve commit revision."""
    try:
        from huggingface_hub import snapshot_download
    except Exception:
        return None, revision

    try:
        snap_dir = Path(
            snapshot_download(
                repo_id=model_id,
                revision=revision,
                local_files_only=True,
            )
        )
    except Exception:
        return None, revision

    resolved_revision = revision or snap_dir.name
    weight_files = sorted(
        list(snap_dir.glob("*.safetensors")) + list(snap_dir.glob("pytorch_model*.bin"))
    )
    if not weight_files:
        return None, resolved_revision

    digest = hashlib.sha256()
    for wf in weight_files:
        digest.update(wf.name.encode("utf-8"))
        digest.update(b"\x00")
        with wf.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest(), resolved_revision


def round_floats(values: list[float], digits: int = 6) -> list[float]:
    return [round(float(v), digits) for v in values]


def parse_layers(raw: str, n_layers: int) -> list[int]:
    if raw == "auto":
        if n_layers <= 4:
            return list(range(n_layers))
        pts = sorted({0, n_layers // 3, (2 * n_layers) // 3, n_layers - 1})
        return pts
    layers = sorted({int(part.strip()) for part in raw.split(",") if part.strip()})
    for layer in layers:
        if layer < 0 or layer >= n_layers:
            raise ValueError(f"Layer {layer} out of range for model with {n_layers} layers")
    if not layers:
        raise ValueError("At least one layer must be selected")
    return layers


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture TransformerBridge activations for Endophasia Observe.")
    parser.add_argument("--model", default="HuggingFaceTB/SmolLM2-135M-Instruct", help="Hugging Face model id")
    parser.add_argument(
        "--prompt",
        default="In Endophasia, observed measurements stay distinct from derived projections and semantic interpretations.",
        help="Prompt text to run through a single deterministic forward pass",
    )
    parser.add_argument("--prompt-id", default="epistemic-boundary-v0", help="Safe identifier for this prompt")
    parser.add_argument("--artifact-id", default="smollm2-135m-resid-post-v0", help="Safe identifier for the artifact")
    parser.add_argument("--layers", default="auto", help="Comma-separated layer indices or 'auto'")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"], help="Execution device")
    parser.add_argument("--dtype", default="float32", choices=["float32", "bfloat16", "float16"], help="Compute dtype")
    parser.add_argument(
        "--compatibility-mode",
        action="store_true",
        help="Enable TransformerLens compatibility-mode weight processing (mutates bridge weights in place)",
    )
    parser.add_argument(
        "--execution-role",
        default="primary-observation",
        choices=["primary-observation", "reference-replay"],
        help="Execution provenance role",
    )
    parser.add_argument("--replay-of", default=None, help="Primary artifact id when --execution-role=reference-replay")
    parser.add_argument("--replay-note", default=None, help="Explicit comparison note for reference-replay")
    parser.add_argument("--out", required=True, help="Output JSON path")
    args = parser.parse_args()

    dtype_map = {
        "float32": torch.float32,
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
    }
    torch_dtype = dtype_map[args.dtype]

    bridge = TransformerBridge.boot_transformers(
        args.model,
        device=args.device,
        dtype=torch_dtype,
    )

    if args.compatibility_mode:
        bridge.enable_compatibility_mode(
            disable_warnings=True,
            fold_ln=True,
            center_writing_weights=True,
            center_unembed=True,
            fold_value_biases=True,
        )
        weight_processing = {
            "mode": "tl-compatibility-mode",
            "foldLn": True,
            "centerWritingWeights": True,
            "centerUnembed": True,
            "foldValueBiases": True,
        }
    else:
        weight_processing = {
            "mode": "raw-hf",
            "foldLn": False,
            "centerWritingWeights": False,
            "centerUnembed": False,
            "foldValueBiases": False,
        }

    cfg = bridge.cfg
    n_layers = int(cfg.n_layers)
    d_model = int(cfg.d_model)
    query_heads = int(cfg.n_heads) if getattr(cfg, "n_heads", None) is not None else None
    kv_heads_raw = getattr(cfg, "n_key_value_heads", None)
    kv_heads = int(kv_heads_raw) if kv_heads_raw is not None else query_heads
    selected_layers = parse_layers(args.layers, n_layers)

    driver = getattr(bridge, "_driver", None)
    if driver is not None:
        supported_hooks_all = sorted(str(h) for h in getattr(driver, "supported_hook_points", frozenset()))
        non_fireable_all = sorted(str(h) for h in getattr(driver, "non_fireable_hook_points", frozenset()))
        provides_seq_logits = bool(getattr(driver, "provides_sequence_logits", True))
        supported_features = sorted(f for f in KNOWN_FEATURES if driver.supports(f))
        driver_name = type(driver).__name__
    else:
        supported_hooks_all = sorted(str(h) for h in bridge.hook_dict.keys())
        non_fireable_all = []
        provides_seq_logits = True
        supported_features = []
        driver_name = "TransformersBridge"

    # Keep hook lists bounded to protocol limits while preserving exact total counts.
    max_list = 64
    requested_hook_names = [f"blocks.{layer}.hook_out" for layer in selected_layers]
    # Check canonical TransformerLens 4.x residual post hook name (blocks.{i}.hook_out vs blocks.{i}.hook_resid_post alias)
    resolved_hook_template = "blocks.{layer}.hook_resid_post"
    hook_dict_keys = set(bridge.hook_dict.keys())
    if f"blocks.{selected_layers[0]}.hook_resid_post" in hook_dict_keys:
        resolved_hook_template = "blocks.{layer}.hook_resid_post"
    elif f"blocks.{selected_layers[0]}.hook_out" in hook_dict_keys:
        resolved_hook_template = "blocks.{layer}.hook_out"
    else:
        raise RuntimeError(f"Neither hook_resid_post nor hook_out found in bridge.hook_dict for layer {selected_layers[0]}")

    capture_hook_names = [resolved_hook_template.format(layer=layer) for layer in selected_layers]
    # Ensure captured hooks appear in the bounded supportedHookPoints sample when present.
    prioritized_supported = [h for h in capture_hook_names if h in supported_hooks_all]
    remaining_supported = [h for h in supported_hooks_all if h not in prioritized_supported]
    supported_sample = (prioritized_supported + remaining_supported)[:max_list]
    non_fireable_sample = non_fireable_all[:max_list]

    tokens = bridge.to_tokens(args.prompt, prepend_bos=True)
    str_tokens = bridge.to_str_tokens(tokens[0])
    token_ids = [int(t) for t in tokens[0].tolist()]
    seq_len = len(token_ids)

    with torch.no_grad():
        logits, cache = bridge.run_with_cache(
            tokens,
            names_filter=lambda name: name in capture_hook_names,
            return_type="logits",
        )

    logits_f32 = logits[0].detach().to(device="cpu", dtype=torch.float32) if logits is not None else None
    probs_f32 = torch.softmax(logits_f32, dim=-1) if logits_f32 is not None else None

    first_tensor = cache[capture_hook_names[0]].detach().to(device="cpu", dtype=torch.float32)
    tensor_shape = [int(dim) for dim in first_tensor.shape]

    points: list[dict[str, Any]] = []
    source_index = 0
    for layer, hook_name in zip(selected_layers, capture_hook_names):
        act = cache[hook_name].detach().to(device="cpu", dtype=torch.float32)
        if act.ndim != 3 or act.shape[0] != 1:
            raise RuntimeError(f"Expected activation tensor shape [1, seq, d_model], got {list(act.shape)}")
        for tok_idx in range(seq_len):
            vec = act[0, tok_idx].tolist()
            top_next: dict[str, Any] | None = None
            if logits_f32 is not None and probs_f32 is not None and provides_seq_logits:
                top_val, top_id_t = torch.max(logits_f32[tok_idx], dim=-1)
                top_id = int(top_id_t.item())
                top_prob = float(probs_f32[tok_idx, top_id].item())
                top_tok_str = bridge.to_single_str_token(top_id)
                top_next = {
                    "token": top_tok_str[:128],
                    "tokenId": top_id,
                    "logit": round(float(top_val.item()), 6),
                    "probability": round(top_prob, 6),
                    "basis": "OBSERVED",
                }
            points.append(
                {
                    "pointId": f"L{layer}.T{tok_idx}",
                    "sourceIndex": source_index,
                    "layer": layer,
                    "tokenIndex": tok_idx,
                    "tokenId": token_ids[tok_idx],
                    "tokenText": str(str_tokens[tok_idx])[:128],
                    "eventRef": None,
                    "hookPoint": hook_name,
                    "vector": round_floats(vec, 6),
                    "topNextToken": top_next,
                }
            )
            source_index += 1

    weight_digest, resolved_revision = sha256_weight_files(args.model, None)
    hf_config = getattr(bridge.original_model, "config", None)
    model_family = str(getattr(hf_config, "model_type", getattr(cfg, "architecture", "transformer")))
    attn_impl = getattr(hf_config, "_attn_implementation", None)
    tl_version = importlib.metadata.version("transformer-lens")
    torch_version = torch.__version__

    unavailable_signals = [
        {
            "signal": "gradients",
            "basis": "UNAVAILABLE",
            "reason": "Forward pass ran under torch.no_grad(); backward gradients were not recorded.",
        },
        {
            "signal": "attention_patterns",
            "basis": "UNAVAILABLE",
            "reason": f"Only residual-stream hook `{resolved_hook_template}` was cached for this bounded artifact.",
        },
    ]
    if kv_heads is not None and query_heads is not None and kv_heads != query_heads:
        unavailable_signals.append(
            {
                "signal": "expanded_per_query_head_kv",
                "basis": "UNAVAILABLE",
                "reason": (
                    f"Model uses grouped-query attention ({query_heads} query heads, {kv_heads} KV heads); "
                    "native K/V heads are not expanded to query-head count."
                ),
            }
        )

    replay_of = None
    if args.execution_role == "reference-replay":
        replay_of = {
            "primaryArtifactId": args.replay_of,
            "note": args.replay_note
            or "Teacher-forced reference replay through Hugging Face TransformersDriver; comparison evidence only, not original inference.",
        }

    artifact_doc = {
        "schemaVersion": "endo.observe-representation-capture.v0",
        "artifact": {
            "artifactId": args.artifact_id,
            "capturedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "promptId": args.prompt_id,
            "sequenceLength": seq_len,
        },
        "subject": {
            "executionRole": args.execution_role,
            "replayOf": replay_of,
            "fixtureNotice": None,
            "model": {
                "family": model_family,
                "modelId": args.model,
                "revision": resolved_revision,
                "weightDigestSha256": weight_digest,
                "weightDtype": args.dtype,
                "quantization": None,
            },
            "backend": {
                "framework": "transformer-lens",
                "frameworkVersion": tl_version,
                "driver": f"{driver_name}/torch-{torch_version}/transformers-{transformers.__version__}",
                "computeDtype": args.dtype,
                "device": args.device,
                "attentionKernel": str(attn_impl) if attn_impl is not None else None,
            },
            "weightProcessing": weight_processing,
            "captureLocation": {
                "hookPoint": resolved_hook_template,
                "tensorShape": tensor_shape,
                "dModel": d_model,
                "headSemantics": {
                    "queryHeads": query_heads,
                    "kvHeads": kv_heads,
                    "layout": "residual-stream",
                },
            },
        },
        "backendCapabilities": {
            "supportedHookPoints": supported_sample,
            "supportedHookPointsCount": len(supported_hooks_all),
            "nonFireableHookPoints": non_fireable_sample,
            "nonFireableHookPointsCount": len(non_fireable_all),
            "providesSequenceLogits": provides_seq_logits,
            "supportedFeatures": supported_features,
            "unavailableSignals": unavailable_signals,
        },
        "dimensions": {
            "layers": {
                "supported": True,
                "availableLayers": selected_layers,
                "defaultLayer": selected_layers[-1],
            },
            "tokens": {
                "supported": True,
                "tokenCount": seq_len,
            },
        },
        "points": points,
        "interpretations": [],
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(artifact_doc, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        f"Captured {len(points)} points ({len(selected_layers)} layers x {seq_len} tokens, d_model={d_model}) "
        f"from {args.model} via TransformerBridge {tl_version} -> {out_path}"
    )


if __name__ == "__main__":
    main()
