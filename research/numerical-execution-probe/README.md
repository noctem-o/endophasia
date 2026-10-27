# E4e-G: numerical execution probe

Status: **implementation and synthetic validation only**. No GGUF was loaded and no real-model result exists. This is a standalone research fixture; it does not change E4e-A or communicate with an inference server. The [first experiment proposal](FIRST-EXPERIMENT.md) is a separate decision, not permission to execute it.

## Question and design

For frozen token IDs `t[0..N-1]`, Path A submits one batch covering positions `0..N-1`. Path B submits `0..N-2`, then `N-1` as a one-token batch. Every token has sequence ID 0 and an explicit absolute position; causal attention is enabled. In each path **only** position `N-1` requests output. The prefix submission in B has no output flags. The logits are those predicted *after evaluating the same final input token*, not logits for choosing that token. No tokenizer, BOS/EOS insertion, sampling, continuation, adapter, external cache, or state restoration is involved.

Each repetition loads the same committed model file in a new process and creates a new context. It rejects nonempty sequence-0 memory on entry and checks the position range after every decode. The model file and native binary are SHA-256 checked before and after every repetition. This assumes the files and machine are not concurrently modified; these checks are not a proof against a transient mutation restored between checks. Actual model and binary digests are saved. The same initial context *configuration* and empty logical memory are required, not an assertion that all allocator bytes, process state, or CPU scheduling are identical.

The default order is A1, B1, B2, A2. The report computes A1/A2 and B1/B2 first, followed by all four A/B comparisons. A same-path difference is a baseline repeatability finding. Compare its size and pattern with cross-path differences; where they cannot be distinguished, a clean schedule effect is inconclusive. Two repetitions per path characterize only the observed variability, not its distribution. No statistical threshold is applied, and CPU execution is not presumed bitwise deterministic.

A difference establishes numerical inequality for the tested configurations under observed conditions; an argmax flip is a distinct observation. Equality establishes equality only for these outputs and conditions. Generated text is a poor primary measurement: sampling and later feedback can magnify or hide differences in the full vector. A/B changes the application submission schedule, graph shapes and potentially how prefix KV is produced. `n_ubatch` is a *limit*, not a trace of actual physical microbatches. Neither an effect nor equality identifies a particular operation, kernel, reduction order, memory layout or cache checkpoint. This CPU fixture says nothing specific about a production CUDA server.

## Pinned dependency and safe build

Source: [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp), commit `1f8fa52318b594b373e7447a3c2bb36cdba9515f`. Configuration requires exactly that clean Git checkout and never downloads anything. To acquire the dependency separately, clone that repository, check out the exact commit in a new isolated directory, and verify `git rev-parse HEAD` and `git status --porcelain`; do not modify an existing production installation. The source inspected locally was clean at that commit. The build requires CMake, a C/C++ compiler, Git and Python 3; no model or Python packages are required.

```sh
cmake -S research/numerical-execution-probe -B /tmp/e4eg-build \
  -DCMAKE_BUILD_TYPE=Release -DLLAMA_SOURCE=/path/to/clean/llama.cpp
cmake --build /tmp/e4eg-build --target e4eg-native e4eg-core-test -j 2
ctest --test-dir /tmp/e4eg-build --output-on-failure
E4EG_NATIVE=/tmp/e4eg-build/e4eg-native python3 -m unittest discover \
  -s research/numerical-execution-probe/tests -p 'test_*.py' -v
```

The local offline build used CMake 4.4.4 and GCC/G++ 16.2.1, Release (`-O3 -DNDEBUG`), static libraries, CPU backend, `GGML_NATIVE=OFF`, no OpenMP/BLAS or GPU/RPC backend; on this x86-64 build llama.cpp selected SSE4.2, F16C, FMA, BMI2, AVX and AVX2. The executable embeds compiler versions, configured C/C++ flags and selected CPU build options, and the manifest commits its bytes. Record the actual build information for a future run: these settings do not promise identical results on another host.

The selected API is the pinned revision's traditional `llama_batch` and `llama_decode`, followed by `llama_get_logits_ith` with the batch index of the explicitly flagged final token. `llama_vocab_n_tokens` supplies the full output width; the copied vector outlives the context buffer. `llama_init_from_model`, the context getters and `llama_get_memory`/`llama_memory_seq_pos_min`/`max` establish and check the declared state. No partial rollback is used. All decode return codes other than zero, missing outputs, changed actual context settings, invalid IDs and unsupported memory semantics fail the repetition. The allowlist is deliberately limited to `general.architecture=llama`, decoder-only, nonrecurrent, nonhybrid, non-diffusion, single-file models with no sliding-window attention; the code also checks for usable memory. It does not claim every model matching metadata has been qualified.

The bare Python and native commands print usage and do not initialize a backend or open a model. Real execution requires the Python `run` subcommand, `--execute-real-model`, explicit model and native paths, frozen IDs, settings and timeout; the native executable independently requires the same unmistakable flag and all options. There is no automatic download, server, or default real-model command. For a future approved run consult `python3 research/numerical-execution-probe/probe.py run --help` and the proposed protocol. `analyze` and `analyze-run` are model-free:

```sh
python3 research/numerical-execution-probe/probe.py analyze left.f32le right.f32le
python3 research/numerical-execution-probe/probe.py analyze-run /path/to/evidence
```

## Evidence and calculations: `e4eg.v1`

The controller creates a **new**, owner-only output directory. `manifest.json` records a UUID, UTC time, status and errors; model and native binary SHA-256; pinned dependency revision and build metadata; host, affinity and relevant environment; backend and configuration including context, logical/physical batch limits and threads; full token IDs and the SHA-256 of their concatenated little-endian signed int32 encoding; compared position; order; and, per repetition, path, repetition, declared fresh state, actual submitted schedule, vocabulary width, filename, byte count and SHA-256. It atomically updates the manifest as work progresses. Failed or timed-out repetitions are marked failed, retain available evidence, and stop the run; there is no automatic retry. Abrupt termination can leave `running` evidence, which is not complete. Manifest contents, token IDs, environment values and vectors may be sensitive and should be handled accordingly.

`A1.f32le`, `A2.f32le`, `B1.f32le`, and `B2.f32le` contain exactly one IEEE-754 binary32 little-endian value per vocabulary token ID, in token-ID order, with no header or rounding. Their digests commit the raw bytes. `analyze-run` verifies schema, token and vector commitments, dimensions, sequence/schedule and completion before recomputing all comparisons without the model; it does not authenticate who created the manifest. NaN, infinity, missing files, fewer than two elements, malformed byte lengths and dimension mismatches are errors, never normalized. An invalid returned vector is retained with its commitment when available, but is not reported as a completed repetition.

For finite vectors, analysis uses Python binary64 arithmetic: exact per-element bitwise equality and counts/proportions, numerical inequality counts/proportions, max and mean absolute difference, RMS difference, and maximum symmetric relative difference `|a-b| / max(|a|, |b|, 1e-12)`. The explicit denominator floor prevents division by zero and makes near-zero ratios scale-dependent. Signed zeros are numerically equal but bitwise unequal. Argmax and top-two margins are reported, as are changes in the ordered top-two candidates and in the entire candidate ordering; ties use the lower token ID first. These are descriptive quantities, not significance tests or causal attribution.

The upstream [single-versus-block discussion](https://github.com/ggml-org/llama.cpp/discussions/28042) and [batch-size discussion](https://github.com/ggml-org/llama.cpp/discussions/9837) are methodological context, not dependencies or evidence about this fixture. No `llama-compare-single-and-block` executable is assumed.
