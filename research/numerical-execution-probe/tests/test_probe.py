import importlib.util
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("probe", ROOT / "probe.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def f32(*values):
    return struct.pack(f"<{len(values)}f", *values)


class AnalysisTests(unittest.TestCase):
    def test_identical_positive_negative_and_signed_zero(self):
        raw = f32(2, -3, 0)
        result = p.compare(raw, raw)
        self.assertTrue(result["exact_bitwise_equal"])
        self.assertEqual(result["max_absolute_difference"], 0)
        self.assertEqual(result["argmax_left"], 0)
        zeros = p.compare(f32(0., 1.), f32(-0., 1.))
        self.assertFalse(zeros["exact_bitwise_equal"])
        self.assertEqual(zeros["bitwise_unequal_count"], 1)
        self.assertEqual(zeros["numerically_unequal_count"], 0)

    def test_one_element_difference_metrics(self):
        result = p.compare(f32(-2, 1, 4), f32(-2, 3, 4))
        self.assertEqual(result["bitwise_unequal_count"], 1)
        self.assertEqual(result["numerically_unequal_proportion"], 1/3)
        self.assertEqual(result["max_absolute_difference"], 2)
        self.assertAlmostEqual(result["mean_absolute_difference"], 2/3)
        self.assertAlmostEqual(result["rms_difference"], math.sqrt(4/3))
        self.assertAlmostEqual(result["max_relative_difference"], 2/3)
        self.assertFalse(result["argmax_changed"])
        self.assertTrue(result["margin_changed"])

    def test_tiny_and_near_zero(self):
        tiny = struct.unpack("<f", struct.pack("<I", 1))[0]
        result = p.compare(f32(0, 1), f32(tiny, 1))
        self.assertFalse(result["exact_bitwise_equal"])
        self.assertEqual(result["max_absolute_difference"], tiny)
        self.assertAlmostEqual(result["max_relative_difference"], tiny / p.RELATIVE_FLOOR)
        self.assertTrue(math.isfinite(result["max_relative_difference"]))

    def test_argmax_and_candidate_order(self):
        result = p.compare(f32(1, 2, 0), f32(3, 2, 0))
        self.assertTrue(result["argmax_changed"])
        self.assertTrue(result["top_two_order_changed"])
        result = p.compare(f32(3, 2, 1), f32(3, 1, 2))
        self.assertFalse(result["argmax_changed"])
        self.assertTrue(result["top_two_order_changed"])
        result = p.compare(f32(4, 3, 2, 1), f32(4, 3, 1, 2))
        self.assertFalse(result["top_two_order_changed"])
        self.assertTrue(result["candidate_order_changed"])
        tie = p.compare(f32(1, 1, 0), f32(1, 1, 0))
        self.assertEqual(tie["top_two_left"], [0, 1])

    def test_invalid_vectors(self):
        for a, b in [(b"", b""), (b"x", b"x"), (f32(1), f32(1)),
                     (f32(1, 2), f32(1, 2, 3)), (f32(float("nan"), 2), f32(1, 2)),
                     (f32(1, 2), f32(float("inf"), 2)), (f32(-float("inf"), 2), f32(1, 2))]:
            with self.subTest(a=a, b=b), self.assertRaises(ValueError): p.compare(a, b)

    def test_round_trip_little_endian(self):
        original = f32(-8.25, 1e-12, 4.5)
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "v.f32le"
            path.write_bytes(original)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(f32(*p.vector_values(path.read_bytes())), original)
            self.assertTrue(p.compare(original, path.read_bytes())["exact_bitwise_equal"])


class FakeBackend:
    def __init__(self, mode="valid"):
        self.calls = []
        self.mode = mode
    def provenance(self):
        return {"kind": "synthetic-fake", "model_sha256": None, "native_binary_sha256": None}
    def evaluate(self, label, tokens, config, output):
        self.calls.append((label, tuple(tokens), p.expected_schedule(label[0], len(tokens)), "fresh-empty"))
        info = {"revision": p.REVISION, "initial_state": "fresh-empty", "architecture": "llama",
                "schedule": p.expected_schedule(label[0], len(tokens)), "vocab_size": 3,
                "compiler_c": "fake", "compiler_cxx": "fake", "c_flags": "", "cxx_flags": "", "cpu_build_options": "fake", **config}
        if self.mode == "bad_schedule": info["schedule"][0]["sequence_id"] = 1
        if self.mode == "bad_state": info["initial_state"] = "reused"
        if self.mode == "bad_revision": info["revision"] = "wrong"
        if self.mode == "bad_arch": info["architecture"] = "recurrent"
        if self.mode == "unavailable": return info
        if self.mode == "short": output.write_bytes(f32(1, 2))
        elif self.mode == "nonfinite": output.write_bytes(f32(1, float("nan"), 2))
        else: output.write_bytes(f32(1, 2, 2.875 if self.mode == "variation" and label == "A2" else (3 if label[0] == "A" else 3.25)))
        return info


class OrchestrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.tokens = (5, 6, 7, 8)
        self.config = {"context": 512, "batch": 32, "ubatch": 32, "threads": 1}

    def test_frozen_ids_schedules_state_and_commitments(self):
        backend = FakeBackend()
        output = self.root / "run"
        manifest = p.run_experiment(output, self.tokens, self.config, p.DEFAULT_ORDER, backend)
        self.assertEqual(manifest["status"], "complete")
        self.assertEqual([c[0] for c in backend.calls], list(p.DEFAULT_ORDER))
        self.assertTrue(all(c[1] == self.tokens and c[3] == "fresh-empty" for c in backend.calls))
        self.assertEqual(backend.calls[0][2], p.expected_schedule("A", 4))
        self.assertEqual(backend.calls[1][2], p.expected_schedule("B", 4))
        self.assertEqual(manifest["token_sha256"], p.sha(p.token_bytes(self.tokens)))
        self.assertEqual(manifest["compared_position"], 3)
        for label in p.DEFAULT_ORDER:
            rec = manifest["runs"][label]
            self.assertEqual(rec["vector_sha256"], p.sha((output / rec["vector_file"]).read_bytes()))
        self.assertEqual(p.analyse_run(output, json.loads((output / "manifest.json").read_text())), manifest["analysis"])
        self.assertFalse(manifest["analysis"]["same_path_bitwise_variability"])
        self.assertFalse(manifest["analysis"]["comparisons"]["A1_vs_B1"]["exact_bitwise_equal"])
        (output / "A1.f32le").write_bytes(f32(0, 0, 0))
        with self.assertRaisesRegex(ValueError, "commitment"): p.analyse_run(output, manifest)

    def test_same_path_variability_and_tampered_provenance(self):
        output = self.root / "variation"
        manifest = p.run_experiment(output, self.tokens, self.config, p.DEFAULT_ORDER, FakeBackend("variation"))
        self.assertTrue(manifest["analysis"]["same_path_bitwise_variability"])
        manifest["compared_position"] = 0
        with self.assertRaisesRegex(ValueError, "position"): p.analyse_run(output, manifest)
        manifest["compared_position"] = 3
        manifest["token_ids"][0] = 99
        with self.assertRaisesRegex(ValueError, "token commitment"): p.analyse_run(output, manifest)

    def test_invalid_output_and_backend_metadata_fail_closed(self):
        for mode in ("bad_schedule", "bad_state", "bad_revision", "bad_arch", "unavailable", "short", "nonfinite"):
            with self.subTest(mode=mode):
                output = self.root / mode
                with self.assertRaises((ValueError, OSError)):
                    p.run_experiment(output, self.tokens, self.config, p.DEFAULT_ORDER, FakeBackend(mode))
                evidence = json.loads((output / "manifest.json").read_text())
                self.assertEqual(evidence["status"], "failed")
                self.assertEqual(evidence["runs"]["A1"]["status"], "failed")
                self.assertTrue(evidence["errors"])

    def test_rejects_invalid_configs_before_evaluation(self):
        for tokens, config, order in [((1,), self.config, p.DEFAULT_ORDER),
            (self.tokens, {**self.config, "ubatch": 2}, p.DEFAULT_ORDER),
            (self.tokens, {**self.config, "threads": 0}, p.DEFAULT_ORDER),
            (self.tokens, self.config, ("A1", "B1", "A1", "B2"))]:
            with self.subTest(tokens=tokens, config=config, order=order), self.assertRaises(ValueError):
                p.run_experiment(self.root / "must-not-exist", tokens, config, order, FakeBackend())
        self.assertFalse((self.root / "must-not-exist").exists())

    def test_gate_and_default_do_not_touch_model(self):
        missing = self.root / "no-model.gguf"
        output = self.root / "out"
        result = subprocess.run([sys.executable, str(ROOT / "probe.py"), "run", "--model", str(missing),
                                 "--native", "missing", "--tokens", "1,2", "--output-dir", str(output),
                                 "--context", "512", "--batch", "32", "--ubatch", "32", "--threads", "1",
                                 "--timeout-seconds", "20"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--execute-real-model", result.stderr)
        self.assertFalse(output.exists())
        native = os.environ.get("E4EG_NATIVE")
        if native:
            result = subprocess.run([native, "--model", str(missing), "--path", "A", "--tokens", "1,2",
                                     "--output", str(output), "--ctx", "512", "--batch", "32", "--ubatch", "32",
                                     "--threads", "1"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("execution requires", result.stderr)
            self.assertFalse(missing.exists())
            self.assertFalse(output.exists())


class EnvironmentCaptureTests(unittest.TestCase):
    def test_allowlist_validates_type_length_and_range(self):
        for value in (None, "", "0", "1025", "0001", "1 " , "1,2", "1" * 10000, 1):
            with self.subTest(value=value):
                self.assertEqual(p.numerical_environment({"OMP_NUM_THREADS": value}), {})
        for value in ("1", "1024"):
            self.assertEqual(p.numerical_environment({"OMP_NUM_THREADS": value}), {"OMP_NUM_THREADS": value})

    def test_secret_and_unknown_prefixes_never_reach_evidence_or_errors(self):
        sentinel = "E4EH_TEST_SECRET_DO_NOT_LEAK"
        injected = {"LLAMA_API_KEY": sentinel, "GGML_UNKNOWN": sentinel,
                    "OMP_UNKNOWN": sentinel, "OMP_NUM_THREADS": "1"}
        with tempfile.TemporaryDirectory() as d, patch.dict(os.environ, injected):
            root = Path(d)
            output = root / "complete"
            manifest = p.run_experiment(output, (5, 6),
                                        {"context": 512, "batch": 32, "ubatch": 32, "threads": 1},
                                        p.DEFAULT_ORDER, FakeBackend())
            self.assertEqual(manifest["host"]["relevant_environment"], {"OMP_NUM_THREADS": "1"})
            report = subprocess.run([sys.executable, str(ROOT / "probe.py"), "analyze-run", str(output)],
                                    capture_output=True, check=True)
            self.assertNotIn(sentinel.encode(), report.stdout + report.stderr)

            # A fake native process dumps its entire environment and exits with
            # an error. Neither inherited secrets nor raw stderr may be retained.
            native = root / "fake-native"
            native.write_text("#!/usr/bin/python3\nimport os, sys\nprint(dict(os.environ), file=sys.stderr)\n"
                              "print('E4EH_TEST_SECRET_' + 'DO_NOT_LEAK', file=sys.stderr)\nsys.exit(7)\n")
            native.chmod(0o700)
            model = root / "model"
            model.write_bytes(b"not a model")
            backend = p.NativeBackend(native, model, 5)
            with self.assertRaises(RuntimeError) as error:
                p.run_experiment(root / "failed", (5, 6),
                                 {"context": 512, "batch": 32, "ubatch": 32, "threads": 1},
                                 p.DEFAULT_ORDER, backend)
            self.assertNotIn(sentinel, str(error.exception))
            for path in root.rglob("*"):
                if path.is_file():
                    self.assertNotIn(sentinel.encode(), path.read_bytes(), str(path))


if __name__ == "__main__":
    unittest.main()
