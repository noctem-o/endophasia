# First numerical execution result: CPU application submission schedules

**Completed:** A1, B1, B2, A2 on 27 October 2026. Each repetition loaded the same model in a fresh process and context. Path A submitted all 16 tokens in one `llama_decode` call; Path B submitted the first 15 and then the final token. Both evaluated the same token IDs at the same positions, with output requested after token 16 (zero-based position 15). The sequence was `[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]`; no tokenizer, sampling, warmup, generation, or restoration was used.

The model was [SmolLM2-135M-Instruct-f16.gguf](https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF/tree/09816acd5d99df7be770d85ea30822623dab342c) at repository revision `09816acd5d99df7be770d85ea30822623dab342c`, size 270,885,952 bytes and SHA-256 `f535f83ec568d040f88ddc04a199fa6da90923bbb41d4dcaed02caa924d6ef57`. Inspection of the downloaded GGUF showed architecture `llama`, training context 8,192, 49,152 vocabulary entries and Apache-2.0 metadata; the [original model card](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct) describes a decoder and the same licence. All input IDs were in range. The native harness also checked decoder-only, nonrecurrent, nonhybrid, non-diffusion, no sliding-window attention, single-file and fresh-memory conditions before decoding.

The native executable was built from llama.cpp commit `1f8fa52318b594b373e7447a3c2bb36cdba9515f` using the CPU-only configuration in this directory, and its SHA-256 was `b043bdfbfe1648a9c0a6162c6f3e97f244d8db550c6ecd0c6824d0e695c96ec9`. Its recorded build used CMake 4.4.4, GCC/G++ 16.2.1, Release `-O3 -DNDEBUG`, static llama.cpp libraries, no GPU, RPC, BLAS or OpenMP backend, and `GGML_NATIVE=OFF`; the selected x86 CPU options included SSE4.2, F16C, FMA, BMI2, AVX and AVX2. The host CPU was an AMD Ryzen 7 5800X3D; affinity was restricted to logical CPU 0. CPU execution used zero GPU layers, Flash Attention disabled, F32 K and V, context 512, logical and physical batch limits 32, one thread for each kind of work, one sequence and causal attention.

The run used an owner-only evidence directory, a systemd user cgroup `MemoryMax` of 4 GiB and zero swap, one-CPU affinity, a 1 GiB private tmpfs for working files, a 120-second per-repetition timeout and a 600-second total service limit. The cgroup limits charged memory, with kernel rules for shared pages; affinity did not reserve the CPU. There were no automatic retries. Each native process exited successfully: A1 0.151 s, B1 0.156 s, B2 0.156 s and A2 0.147 s, measured from process launch through exit.

## Full-vocabulary comparisons

The independent `analyze-run` mode verified the completed `e4eg.v1` manifest, token and vector commitments, dimensions and schedules, then recomputed the comparisons without model execution. A separate NumPy calculation independently checked the counts, differences, argmaxes and ordering. Each vector contains 49,152 finite float32 logits.

| Comparison | Bitwise equal | Numerically unequal logits | Mean absolute difference | Maximum absolute difference | RMS difference |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 vs A2 | yes | 0 | 0 | 0 | 0 |
| B1 vs B2 | yes | 0 | 0 | 0 | 0 |
| A1 vs B1 | no | 49,152 | 0.004299034187473201 | 0.00986623764038086 | 0.004483156034787166 |
| A1 vs B2 | no | 49,152 | 0.004299034187473201 | 0.00986623764038086 | 0.004483156034787166 |
| A2 vs B1 | no | 49,152 | 0.004299034187473201 | 0.00986623764038086 | 0.004483156034787166 |
| A2 vs B2 | no | 49,152 | 0.004299034187473201 | 0.00986623764038086 | 0.004483156034787166 |

All vectors had argmax ID **111** and top-two IDs **[111, 138]**, in that order. The top-one minus top-two margin was `0.0784454345703125` for both A repetitions and `0.07681465148925781` for both B repetitions. The complete candidate ordering changed across paths, but neither the argmax nor the top-two ordering changed. Same-path repetitions were bitwise stable in this small sample, so observed same-path variation does not complicate these cross-path comparisons.

The token sequence SHA-256, over little-endian signed int32 IDs, is `8463133ff3fba889f216961d8289d8a669dff3d367e7a89984223b468f47fa6e`. The raw float32 vector SHA-256 is `e3cb468b0bea75de776a3698789706b36e6fe3d300525acbb9d5f8a2162724ce` for both A1 and A2, and `9c7eaa7d7ad8d4b92df72ee981b53ad8184103a8d54167313d6e523fbd54431c` for both B1 and B2. The full vectors and host-specific manifest remain private.

These observations establish numerical non-equivalence of the two **application-level submission schedules** at the tested position under the recorded conditions. The two same-path repetitions provide a limited repeatability control, not a distribution of variability. The experiment did not trace physical microbatches, kernels, or individual operations, so it does not identify the mechanism of the difference. It does not measure prompt-cache restoration, establish behavior at other positions or configurations, or explain E4e's production CUDA behavior. An argmax flip would be a distinct observation and did not occur here.

The most informative follow-up would be a separately authorized, bounded comparison of intermediate activations and physical execution traces for these same tokens and schedules, to locate where their computations first diverge. That would still require care to distinguish the observed divergence from its cause.
