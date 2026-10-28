#!/usr/bin/env python3
"""E4e-G controller and independent float32 analysis. No third-party modules."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import struct
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

REVISION = "1f8fa52318b594b373e7447a3c2bb36cdba9515f"
VERSION = "e4eg.v1"
DEFAULT_ORDER = ("A1", "B1", "B2", "A2")
RELATIVE_FLOOR = 1e-12
# Additional time to close pipes and reap after an execution deadline or interruption.
CLEANUP_GRACE_SECONDS = 0.5


def numerical_environment(environ: dict) -> dict:
    """Default-deny environment capture; accept only a bounded thread count."""
    value = environ.get("OMP_NUM_THREADS")
    if isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,3}", value) and int(value) <= 1024:
        return {"OMP_NUM_THREADS": value}
    return {}


def enable_child_subreaper() -> None:
    """Adopt orphaned native descendants so the owning controller can reap them."""
    if sys.platform != "linux" or ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("cannot enable Linux child subreaper")


def reap_owned_group(pgid: int, deadline: float) -> None:
    while True:
        if time.monotonic() >= deadline:
            raise RuntimeError("owned native process group could not be reaped")
        try:
            pid, _status = os.waitpid(-pgid, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            time.sleep(min(0.01, max(0, deadline - time.monotonic())))


def no_adopted_children() -> bool:
    """After enabling the subreaper, no remaining children means no surviving descendants.

    This deliberately does not reap or signal children outside the native group. A
    concurrently created unrelated child makes the result uncertain, not successful.
    """
    try:
        os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    except ChildProcessError:
        return True
    return False


def cleanup_native(p: subprocess.Popen) -> dict:
    """Bound cleanup; only signal the group while its leader remains unreaped."""
    deadline = time.monotonic() + CLEANUP_GRACE_SECONDS
    group_signalled = False
    cleanup_fault = False
    if p.returncode is None:
        try:
            # Do not target a numeric group ID after the child ceased to be
            # waitable (for example, if another waiter reaped it).
            os.waitid(os.P_PID, p.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            os.killpg(p.pid, signal.SIGKILL)
            group_signalled = True
        except ProcessLookupError:
            pass
        except BaseException:
            cleanup_fault = True  # Do not expose cleanup or runtime details.
    # communicate() cannot be used here: an escaped descendant may retain a pipe.
    for stream in (p.stdout, p.stderr):
        if stream is not None:
            try:
                stream.close()
            except BaseException:
                cleanup_fault = True
    pipes_closed = all(stream is None or stream.closed for stream in (p.stdout, p.stderr))
    try:
        p.wait(timeout=max(0, deadline - time.monotonic()))
    except BaseException:
        cleanup_fault = True
    group_reaped = False
    if p.returncode is not None:
        try:
            reap_owned_group(p.pid, deadline)
            group_reaped = True
        except BaseException:
            cleanup_fault = True
    try:
        contained = not cleanup_fault and pipes_closed and group_reaped and no_adopted_children()
    except BaseException:
        contained = False
    return {"direct_child_reaped": p.returncode is not None,
            "parent_pipes_closed": pipes_closed,
            "owned_group_signalled": group_signalled,
            "descendant_containment": "established" if contained else "uncertain"}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def token_bytes(tokens: tuple[int, ...]) -> bytes:
    if not 2 <= len(tokens) <= 512 or any(type(t) is not int or t < 0 or t > 2147483647 for t in tokens):
        raise ValueError("tokens must be 2..512 non-negative int32 IDs")
    return struct.pack(f"<{len(tokens)}i", *tokens)


def vector_values(data: bytes) -> tuple[float, ...]:
    if not data or len(data) % 4 or len(data) < 8:
        raise ValueError("vector must contain at least two complete float32 values")
    result = struct.unpack(f"<{len(data) // 4}f", data)
    if not all(math.isfinite(x) for x in result):
        raise ValueError("NaN and infinity are invalid logits")
    return result


def compare(left: bytes, right: bytes) -> dict:
    a, b = vector_values(left), vector_values(right)
    if len(a) != len(b):
        raise ValueError("vector dimensions differ")
    n = len(a)
    differences = [abs(x - y) for x, y in zip(a, b)]
    bit_unequal = sum(left[4*i:4*i+4] != right[4*i:4*i+4] for i in range(n))
    numeric_unequal = sum(x != y for x, y in zip(a, b))
    # Stable lower-ID tie break; this is a descriptive ordering, not sampling.
    order_a = sorted(range(n), key=lambda i: (-a[i], i))
    order_b = sorted(range(n), key=lambda i: (-b[i], i))
    top_a, top_b = order_a[:2], order_b[:2]
    margin_a = a[top_a[0]] - a[top_a[1]]
    margin_b = b[top_b[0]] - b[top_b[1]]
    return {
        "elements": n, "exact_bitwise_equal": bit_unequal == 0,
        "bitwise_unequal_count": bit_unequal, "bitwise_unequal_proportion": bit_unequal / n,
        "numerically_unequal_count": numeric_unequal, "numerically_unequal_proportion": numeric_unequal / n,
        "max_absolute_difference": max(differences),
        "mean_absolute_difference": math.fsum(differences) / n,
        "rms_difference": math.sqrt(math.fsum(d*d for d in differences) / n),
        "max_relative_difference": max(d / max(abs(x), abs(y), RELATIVE_FLOOR) for x, y, d in zip(a, b, differences)),
        "relative_denominator_floor": RELATIVE_FLOOR,
        "argmax_left": top_a[0], "argmax_right": top_b[0], "argmax_changed": top_a[0] != top_b[0],
        "top_two_left": top_a, "top_two_right": top_b, "top_two_order_changed": top_a != top_b,
        "candidate_order_changed": order_a != order_b,
        "top1_top2_margin_left": margin_a, "top1_top2_margin_right": margin_b,
        "margin_changed": margin_a != margin_b,
    }


def expected_schedule(path: str, n: int) -> list[dict]:
    if path == "A":
        return [{"start": 0, "count": n, "sequence_id": 0, "output_index": n - 1}]
    if path == "B":
        return [{"start": 0, "count": n - 1, "sequence_id": 0, "output_index": -1},
                {"start": n - 1, "count": 1, "sequence_id": 0, "output_index": 0}]
    raise ValueError("invalid path")


def validate_config(tokens: tuple[int, ...], config: dict, order: tuple[str, ...]) -> None:
    token_bytes(tokens)
    if len(order) != 4 or set(order) != set(DEFAULT_ORDER):
        raise ValueError("order must contain A1, A2, B1, B2 exactly once")
    ctx, batch, ubatch, threads = (config[k] for k in ("context", "batch", "ubatch", "threads"))
    if any(type(v) is not int for v in (ctx, batch, ubatch, threads)) or not (
        256 <= ctx <= 65536 and ctx % 256 == 0 and len(tokens) <= ctx and len(tokens) <= ubatch <= batch <= min(ctx, 512) and 1 <= threads <= 16
    ):
        raise ValueError("unsupported context, batch or thread settings")


def save_manifest(directory: Path, manifest: dict, checkpoint=None) -> None:
    temp = directory / "manifest.json.tmp"
    temp.write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temp, directory / "manifest.json")
    if checkpoint is not None:
        checkpoint(directory)


def analyse_run(directory: Path, manifest: dict) -> dict:
    if manifest.get("schema") != VERSION or manifest.get("llama_cpp_revision") != REVISION:
        raise ValueError("unsupported evidence schema or dependency revision")
    if manifest.get("status") != "complete":
        raise ValueError("evidence is not complete")
    tokens = tuple(manifest["token_ids"])
    if sha(token_bytes(tokens)) != manifest["token_sha256"]:
        raise ValueError("token commitment mismatch")
    validate_config(tokens, manifest["configuration"], tuple(manifest["order"]))
    if manifest.get("compared_position") != len(tokens) - 1:
        raise ValueError("compared position mismatch")
    provenance = manifest["backend"]
    if provenance.get("kind") == "llama.cpp":
        for key in ("model_sha256", "native_binary_sha256"):
            if not isinstance(provenance.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", provenance[key]):
                raise ValueError("missing real-backend commitment")
    records = manifest["runs"]
    if set(records) != set(DEFAULT_ORDER):
        raise ValueError("four completed repetitions are required")
    values = {}
    vocabulary = None
    for label in DEFAULT_ORDER:
        rec = records[label]
        if (rec["status"] != "complete" or rec.get("path") != label[0] or rec.get("repetition") != int(label[1]) or
            rec.get("initial_state") != "fresh-empty" or rec["schedule"] != expected_schedule(label[0], len(tokens))):
            raise ValueError(f"invalid run or schedule: {label}")
        # Never follow paths supplied by a manifest outside its evidence directory.
        if rec["vector_file"] != f"{label}.f32le":
            raise ValueError("invalid vector filename")
        if type(rec["vocab_size"]) is not int or rec["vocab_size"] < 2 or (vocabulary is not None and rec["vocab_size"] != vocabulary):
            raise ValueError("invalid or changing vocabulary size")
        vocabulary = rec["vocab_size"]
        raw = (directory / rec["vector_file"]).read_bytes()
        if rec.get("vector_bytes") != len(raw) or sha(raw) != rec["vector_sha256"] or len(raw) != 4 * rec["vocab_size"]:
            raise ValueError(f"vector commitment or dimension mismatch: {label}")
        vector_values(raw)
        values[label] = raw
    pairs = [("A1", "A2"), ("B1", "B2"), ("A1", "B1"), ("A1", "B2"), ("A2", "B1"), ("A2", "B2")]
    comparisons = {f"{a}_vs_{b}": compare(values[a], values[b]) for a, b in pairs}
    return {
        "comparisons_in_order": [f"{a}_vs_{b}" for a, b in pairs],
        "comparisons": comparisons,
        "same_path_bitwise_variability": not (comparisons["A1_vs_A2"]["exact_bitwise_equal"] and comparisons["B1_vs_B2"]["exact_bitwise_equal"]),
        "interpretation": "Descriptive only; inspect same-path variability before cross-path differences. No mechanism is identified.",
    }


class NativeBackend:
    def __init__(self, executable: Path, model: Path, timeout: int, deadline=None):
        self.executable, self.model, self.timeout = executable.resolve(strict=True), model.resolve(strict=True), timeout
        self.deadline = deadline
        self.last_observation = None
        self.model_sha = sha_file(self.model)
        self.binary_sha = sha_file(self.executable)

    def provenance(self) -> dict:
        return {"kind": "llama.cpp", "model_sha256": self.model_sha, "native_binary_sha256": self.binary_sha,
                "timeout_seconds_per_repetition": self.timeout}

    def evaluate(self, label: str, tokens: tuple[int, ...], config: dict, output: Path) -> dict:
        self.last_observation = None
        if sha_file(self.model) != self.model_sha or sha_file(self.executable) != self.binary_sha:
            raise ValueError("model or executable changed before repetition")
        command = [str(self.executable), "--execute-real-model", "--model", str(self.model), "--path", label[0],
                   "--tokens", ",".join(map(str, tokens)), "--output", str(output),
                   "--ctx", str(config["context"]), "--batch", str(config["batch"]),
                   "--ubatch", str(config["ubatch"]), "--threads", str(config["threads"])]
        start = time.monotonic()
        execution_deadline = start + self.timeout
        if self.deadline is not None:
            execution_deadline = min(execution_deadline, self.deadline)
        if execution_deadline <= start:
            raise RuntimeError("total experiment deadline reached before repetition")
        # A private cgroup is the stronger launcher boundary. For the direct
        # command, Linux subreaping lets us fail closed if any child remains,
        # including one which left the native process group.
        enable_child_subreaper()
        # The process owns a new group, so cleanup never targets an unrelated job.
        # Do not expose credentials, paths or unrecorded runtime settings to it.
        env = {"LC_ALL": "C", **numerical_environment(os.environ)}
        p = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env=env, start_new_session=True)
        try:
            stdout, _stderr = p.communicate(timeout=max(0, execution_deadline - time.monotonic()))
        except BaseException as exc:
            cleanup = cleanup_native(p)
            self.last_observation = {"elapsed_seconds": time.monotonic() - start,
                                     "termination": "timeout" if isinstance(exc, subprocess.TimeoutExpired) else "interrupted",
                                     "returncode": p.returncode, **cleanup}
            if isinstance(exc, subprocess.TimeoutExpired):
                raise RuntimeError("native repetition timed out or total deadline reached") from exc
            raise
        # Never signal a group after its leader has been reaped: its ID may be
        # reused. A remaining child makes the repetition fail closed instead.
        contained = no_adopted_children()
        self.last_observation = {"elapsed_seconds": time.monotonic() - start,
                                 "termination": "exited", "returncode": p.returncode,
                                 "direct_child_reaped": True,
                                 "descendant_containment": "established" if contained else "uncertain"}
        if not contained:
            raise RuntimeError("native repetition descendant containment uncertain")
        if p.returncode != 0:
            # Runtime stderr can contain private paths or arbitrary environment data.
            raise RuntimeError(f"native repetition failed (exit status {p.returncode})")
        if sha_file(self.model) != self.model_sha or sha_file(self.executable) != self.binary_sha:
            raise ValueError("model or executable changed during repetition")
        return json.loads(stdout)


def run_experiment(directory: Path, tokens: tuple[int, ...], config: dict, order: tuple[str, ...], backend,
                   checkpoint=None, resource_limits=None) -> dict:
    tokens, order = tuple(tokens), tuple(order)  # freeze caller-owned inputs
    validate_config(tokens, config, order)
    directory.mkdir(mode=0o700)  # fail if any prior evidence exists
    manifest = {
        "schema": VERSION, "run_id": str(uuid.uuid4()), "created_utc": datetime.now(timezone.utc).isoformat(),
        "status": "running", "errors": [], "llama_cpp_revision": REVISION,
        "backend": backend.provenance(), "configuration": dict(config),
        "execution": {"backend": "CPU", "gpu_layers": 0, "flash_attention": "disabled", "kv_type": "f32",
                      "attention": "causal", "sequence_id": 0, "sampling": False, "restore": False,
                      "state": "new process and fresh empty context per repetition",
                      "other_context_and_model_parameters": "pinned llama.cpp defaults; RoPE from model metadata",
                      "physical_microbatches": "not observed; ubatch is a limit"},
        "host": {"platform": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
                 "cpu_affinity": sorted(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else None,
                 "relevant_environment": numerical_environment(os.environ)},
        "token_ids": list(tokens), "token_sha256": sha(token_bytes(tokens)),
        "compared_position": len(tokens) - 1, "order": list(order), "runs": {}, "analysis": None,
    }
    if resource_limits is not None:
        manifest["resource_limits"] = resource_limits
    save_manifest(directory, manifest, checkpoint)
    try:
        build_info = None
        vocab_size = None
        for label in order:
            vector_file = f"{label}.f32le"
            rec = {"path": label[0], "repetition": int(label[1]), "status": "running", "vector_file": vector_file}
            manifest["runs"][label] = rec
            save_manifest(directory, manifest, checkpoint)
            info = backend.evaluate(label, tokens, config, directory / vector_file)
            if getattr(backend, "last_observation", None) is not None:
                rec["runtime"] = backend.last_observation
            expected = expected_schedule(label[0], len(tokens))
            if (info.get("revision") != REVISION or info.get("initial_state") != "fresh-empty" or
                info.get("schedule") != expected or info.get("architecture") != "llama" or
                any(info.get(k) != config[k] for k in ("context", "batch", "ubatch", "threads"))):
                raise ValueError(f"backend provenance or schedule mismatch: {label}")
            current_build = {k: info[k] for k in ("compiler_c", "compiler_cxx", "c_flags", "cxx_flags", "cpu_build_options")}
            if build_info is not None and current_build != build_info:
                raise ValueError("build provenance changed between repetitions")
            build_info = current_build
            current_vocab = info.get("vocab_size")
            if type(current_vocab) is not int or current_vocab < 2 or (vocab_size is not None and current_vocab != vocab_size):
                raise ValueError("invalid or changing vocabulary size")
            vocab_size = current_vocab
            raw = (directory / vector_file).read_bytes()
            rec.update({"schedule": info["schedule"], "initial_state": info["initial_state"],
                        "vocab_size": vocab_size, "vector_sha256": sha(raw), "vector_bytes": len(raw)})
            if len(raw) != vocab_size * 4:
                raise ValueError("unavailable or incorrectly sized output")
            vector_values(raw)  # reject invalid numbers; retain the vector and its commitment
            rec["status"] = "complete"
            manifest["build"] = build_info
            save_manifest(directory, manifest, checkpoint)
        manifest["status"] = "complete"
        manifest["analysis"] = analyse_run(directory, manifest)
    except BaseException as exc:
        manifest["status"] = "failed"
        manifest["errors"].append(f"{type(exc).__name__}: {exc}")
        if "rec" in locals() and rec["status"] == "running":
            rec["status"] = "failed"
            if getattr(backend, "last_observation", None) is not None:
                rec["runtime"] = backend.last_observation
        save_manifest(directory, manifest, checkpoint)
        raise
    save_manifest(directory, manifest, checkpoint)
    return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command")
    run = sub.add_parser("run", help="explicit, separately authorized real-model experiment")
    run.add_argument("--execute-real-model", action="store_true", required=True)
    run.add_argument("--model", type=Path, required=True)
    run.add_argument("--native", type=Path, required=True)
    run.add_argument("--tokens", required=True, help="comma-separated fixed token IDs; no tokenizer runs")
    run.add_argument("--output-dir", type=Path, required=True, help="new directory")
    run.add_argument("--context", type=int, required=True)
    run.add_argument("--batch", type=int, required=True)
    run.add_argument("--ubatch", type=int, required=True)
    run.add_argument("--threads", type=int, required=True)
    run.add_argument("--timeout-seconds", type=int, required=True)
    run.add_argument("--order", default=",".join(DEFAULT_ORDER))
    analysis = sub.add_parser("analyze", help="compare two existing raw float32 little-endian vectors")
    analysis.add_argument("left", type=Path); analysis.add_argument("right", type=Path)
    rerun = sub.add_parser("analyze-run", help="verify commitments and recompute a saved run's comparisons")
    rerun.add_argument("directory", type=Path)
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help(); return 0
    try:
        if args.command == "analyze":
            result = compare(args.left.read_bytes(), args.right.read_bytes())
        elif args.command == "analyze-run":
            manifest = json.loads((args.directory / "manifest.json").read_text(encoding="utf-8"))
            result = analyse_run(args.directory, manifest)
        else:
            if not re.fullmatch(r"[0-9]+(?:,[0-9]+)+", args.tokens):
                raise ValueError("tokens must be comma-separated non-negative integers")
            tokens = tuple(int(t) for t in args.tokens.split(","))
            config = {"context": args.context, "batch": args.batch, "ubatch": args.ubatch, "threads": args.threads}
            order = tuple(args.order.split(","))
            validate_config(tokens, config, order)
            if not 1 <= args.timeout_seconds <= 3600:
                raise ValueError("timeout must be 1..3600 seconds per repetition")
            backend = NativeBackend(args.native, args.model, args.timeout_seconds)
            result = run_experiment(args.output_dir, tokens, config, order, backend)
        print(json.dumps(result, indent=2, allow_nan=False)); return 0
    except (ValueError, OSError, KeyError, TypeError, OverflowError, RuntimeError, struct.error) as exc:
        print(f"e4eg: {exc}", file=sys.stderr); return 1

if __name__ == "__main__":
    raise SystemExit(main())
