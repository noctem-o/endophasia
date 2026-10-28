# AA-LIVE-001: pre-registration, executable decision and live go/no-go (Phase A, read-only)

Written 2026-10-28, before any real execution, on `main` at `bc7de095b` (PR #96). **No server was started, no model request was sent and `--run` was never invoked.** The checks below are read-only observations of one machine (Arch Linux, RTX 4090). The comparison key, private prompts and evidence contents are not published. Hardware and software identifiers (digests, versions) are published on purpose: they are the experiment's declared environment. Paths are shown relative to `~`.

**Status: HISTORICAL BUILD RECOVERED / LOAD QUALIFICATION GATED.** The pinned executable was recovered and the operator approved it (§5). Loadability on this GPU (§3) is not yet qualified, and the live run needs its own instruction.

**Revision 2 (this amendment).** Revision 1 of this document said the pinned build was unavailable and that build 11429 was the only server. That was wrong: my searches truncated their output and missed a local build. The exact historical executable exists (§2, §5). Everything about the Arch build is retained only as a superseded fallback.

## 1. Pre-registered design

**Binding rule.** The executable decision is recorded in §5, so this document is binding from the commit that adds this amendment (named in the PR description and required to precede the run). Every field below is fixed and may not change after any real execution; any later change needs a new dated amendment, committed before the run. The git history is the tamper-evident record.

Purpose: harness validation. It establishes operational repeatability and capture integrity of the governed matched A/A protocol. It is not a statistical study and says nothing about general capability.

| Item | Value |
| --- | --- |
| Protocol | existing matched tool-free two-turn A/A: 4 fresh Pi sessions × 2 turns, at most 8 model requests, no tools, no retries after dispatch |
| Seed / order | `20261028` (the date; chosen now, not after any result). Even seed: **ABBA** = baseline, alternative, alternative, baseline |
| Conditions | verified-pristine sibling pair from the retained qualified checkpoint, `declared-noop`, both `thinkingLevel: off` |
| Model | Nanbeige4.3-33B Q4_K_M, 20,051,495,680 bytes, SHA-256 `9216fa91…ff8cc1` (equals the historical reference), alias `nanbeige4.3-33b`, Pi provider `endolocal` |
| Pi | 1.0.4, identity digest `09fc0452…cda23` (equals the historical reference) |
| First prompt | `Compute 4 plus 5. Return only the decimal result.` Expected answer `9`, exact match after trimming |
| Continuation | `Repeat only the token in your immediately preceding answer.` Correct when the second answer is one non-space token equal to the first |
| Budgets | per slot: 120 s wall, 60 s continuation-approval idle, 10 MiB transfer; server start 180 s; model-ready wait 120 s; typed approvals expire after 300 s |
| Endpoint | loopback `127.0.0.1:18181`, task-owned, unused, separate from any user server |
| Server profile | `llama.cpp-11518-explicit-fit-off-v0`: ctx 65536, 1 slot, batch 512, ubatch 128, q4_0 K/V, flash attention, `--fit off`, `--n-gpu-layers 46`, `--cache-ram 0`, `--ctx-checkpoints 0`, `--reasoning-format deepseek`, `--jinja`, `--no-context-shift`, `--no-cache-idle-slots` |

**Executable: decided (§5).** The recovered historical local build, `~/llama-cpp/llama.cpp/build/bin/llama-server`, SHA-256 `2c4c7139b339fbe1c10d02f5d8e5464e2cecf91658b2c335b29ddd648d18af68`, build 11518, commit `1f8fa52318b594b373e7447a3c2bb36cdba9515f`. Its binary digest equals the pinned constant, so `supportedBinary` is expected to read `MATCH` (file identity only, not build provenance).

### Result categories (never one boolean)

Applied mechanically to the printed outcome, in this precedence (first match wins):

| Category | Applies when | Printed as |
| --- | --- | --- |
| CLEANUP UNCONFIRMED | the owned process or listener was not proven gone | verdict `cleanup-unconfirmed` |
| UNKNOWN | any slot status is `outcome-unknown` (dispatch or response outcome not established) | verdict `partial`, slot status `outcome-unknown` |
| PASS | four verified sessions, eight independently authorised and captured requests, valid admissions, consistent process evidence, intact siblings, confirmed cleanup | verdict `complete-under-declared-assumptions` |
| REFUSED | a prerequisite, approval, admission or identity check rejected execution and no model request was sent | verdict `refused`, or verdict `partial` where every started slot ended `no-request-*` (a declined or rejected turn approval spends its slot) |
| PARTIAL | some work completed but the committed study did not | verdict `partial` with at least one slot that sent a request |

PASS is qualified by two printed facts. If the server binary is not the pinned digest, the result is reported as **PASS (UNSUPPORTED BINARY)** and is never described as a pinned-build result. PASS also does not include a verified readiness record: readiness is an operator-side note of a server-reported observation (see §4).

A correct answer is a separate dimension from admission: a PASS may have wrong answers, and correct answers do not make a study PASS. The printed headline and a detail line state the server-binary status. Receipts never establish sole socket ownership, full runtime parity, GPU-resident weights or deterministic reasoning. Analysis is descriptive: per-trial exact-answer scores, request-body digest equality and response agreement as the readers report them; no significance tests, and no stopping or seed change after seeing results.

## 2. Qualification results

| # | Prerequisite | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Repository and CI | **VERIFIED** | `main` = PR #96 merge `bc7de095b`; PR checks and the post-merge `main` run all succeeded; no open PRs |
| 2 | Pinned llama.cpp build 11518 | **VERIFIED** (recovered) | Executable at the path above: ELF build ID `ae939bd24b8f80fa08145c0768c04bb335051097`, 15,976 bytes, SHA-256 equal to the pinned digest; `--version` reports `0.6.0-dev (build 11518, commit 1f8fa5231)`, GCC 16.2.1; source checkout clean at the exact commit. It is the same file the Oct 27 runtime record (E4e-R) identified. That the Oct 28 acceptance launched this file is inferred from its documented digest, which only this file carries |
| 3 | Recovered build: enforced flags | **VERIFIED** | `--help` of the recovered binary advertises all 19 enforced flags |
| 4 | Recovered build: dependencies | **VERIFIED, file identity only** | Under the launcher's `PATH=/usr/bin:/bin` all 29 libraries resolve, 0 missing; the build's own libraries resolve through its RUNPATH; CUDA 13.4.92 / cuBLAS 13.8.0.4 come from pacman's `/opt/cuda`, the driver from `nvidia-utils` 615.78.08. All 35 regular mapped files recorded on Oct 27 still hash identically. Full table in §5 |
| 5 | Model file | **VERIFIED** | exact size and SHA-256 equal the historical reference; readable, owner-only parent |
| 6 | Pi | **VERIFIED** | `/usr/bin/pi` is 1.0.1 and is **not** used. `~/pi-acceptance-*/node_modules/.bin/pi` reports 1.0.4 and its Endophasia identity digest equals the historical `09fc0452…` |
| 7 | Checkpoint and siblings | **VERIFIED** | checkpoint `qualified`; sibling pair `verified-pristine`; manifest `declared-noop`, conditions otherwise equal (checked with the repo's own readers) |
| 8 | Comparison key | **VERIFIED** | installation-domain key present, mode 0600, loads; contents never printed |
| 9 | Evidence location | **VERIFIED** | `0700` directory, 2.3 TB free, study path unused, `.pi` scratch from earlier preflights already present |
| 10 | Running servers and listeners | **VERIFIED** | no llama.cpp or other model server running; nothing on 8080; 18181 free. Unattributed listeners on other ports were not touched |
| 11 | GPU | **VERIFIED** | 23,028 MiB total, 1,507 MiB used by the desktop and a VPN app, no competing compute; llama.cpp reports 20,732 MiB free (CUDA backend loads under the launcher's minimal `PATH=/usr/bin:/bin`) |
| 12 | `--fit off` loadability | **LIVE-UNVERIFIED** | see §3 |
| 13 | Deadlines plausible | **REQUIRES LIVE ACCEPTANCE** | the earlier run loaded in about 23 s (cold) and 5 s (warm cache); its log shows 420 tokens/s prompt evaluation and about 9.4 tokens/s generation, so two short turns took about 24 s including review. A 120 s slot budget leaves wide margin; a long reasoning trace is only observable live |
| 14 | Configuration | **VERIFIED** | private `0600` config outside Git, pointing at the recovered executable; `--inspect` exited 0, wrote nothing, planned launch `a50e6cf7…`, order ABBA. A manifest of the 29 dependency hashes sits beside it for a `sha256sum -c` recheck |
| 15 | Readiness route | **REQUIRES LIVE ACCEPTANCE** | the server library contains the health handler; actual `GET /health` behaviour is observable only live. The gate fails closed if the route is absent |

Redacted configuration summary: executable the recovered build above (digest `2c4c7139…18af68`); model as above; alias `nanbeige4.3-33b`; `gpuLayers` 46; port 18181; seed 20261028; provider/model `endolocal` / `nanbeige4.3-33b`; limits as in §1; study file in the existing evidence directory (unused); server working directory `~/endo-aa-live-20261028/server-work` (`0700`). Key path, prompts and evidence paths are not reproduced. The earlier Arch-build configuration is kept privately as superseded.

## 3. The `--fit off` profile

The earlier two-turn acceptance ran with llama.cpp's **default** `--fit on` (target 1024 MiB), which adjusts unset arguments such as the GPU layer count to fit. The operator enforces `--fit off`, which does not adjust anything. These are different profiles and this document does not blend them.

From the GGUF tensor table (architecture `llama`, 52 layers, 8 KV heads, K/V head size 128): each repeating layer is 317–358 MiB of weights (mean 337 MiB), `output.weight` is 936 MiB, `token_embd` 642 MiB stays on the CPU, and q4_0 K/V at 65,536 tokens costs 72 MiB per offloaded layer (3,744 MiB for all 52).

| `--n-gpu-layers` | weights + KV on GPU | vs 20,732 MiB free (before compute buffers) |
| --- | --- | --- |
| 53 or 99 (full) | 22,221 MiB | **does not fit** (−1,489) |
| 52 | 21,285 MiB | does not fit (−553) |
| 50 | 20,426 MiB | +306: too tight |
| 48 | 19,566 MiB | +1,166 |
| **46 (configured)** | **18,707 MiB** | **+2,025** |
| 44 | 17,929 MiB | +2,803 |

So full offload cannot load with `--fit off` on this GPU; a partial offload is required and 46 leaves roughly 1.3–1.7 GiB after compute buffers. This is an estimate from file metadata, **not** a load test. **Loadability of the profile with these settings is LIVE-UNVERIFIED** (not PASS, not FAIL). Known unresolvable risks: allocation failure at load (the server would exit and the run would be REFUSED with confirmed cleanup), desktop VRAM growth between now and the run, and behaviour differences between build 11429 and the pinned 11518. The profile was not changed to resemble the earlier acceptance; `gpuLayers` is a declared parameter of the profile.

### Difference from the earlier acceptance launch (recorded deviation)

The same binary is used, but not the same launch. The Oct 27 service ran `--fit on --fit-target 1024 --temp 1.0 --top-p 0.95 --metrics` (plus the shared model, alias, ctx 65536, 1 slot, batch 512, ubatch 128, q4_0 K/V, flash attention, `--jinja`). The profile here replaces `--fit on --fit-target 1024` with `--fit off --n-gpu-layers 46`, adds `--cache-ram 0 --ctx-checkpoints 0 --reasoning-format deepseek --no-context-shift --no-cache-idle-slots`, and sets no `--temp`, `--top-p` or `--metrics`, so server defaults apply unless Pi sends values. The GPU layer count that `--fit on` chose is recorded as unknown. **This study therefore tests the pinned binary under a different, explicit profile and makes no claim of parity with the earlier acceptance.**

## 4. Evidence-integrity findings

- **Readiness record (`*.readiness.json`) not read by the fresh-process reader: not material to the PASS conditions, and stated as a limitation of PASS (§1).** None of the PASS conditions depends on it. Each request is independently bound to a keyed admission that re-observes the process and listener, receipts and captures are verified by the unchanged readers, and a server that was not actually serving would fail those requests. The record is an operator-side note of a server-reported observation. No code change was made; extending the reader to check it is optional hardening, not a blocker.
- **Fixed in this PR (reproducible): the printed outcome hid an unpinned binary.** A non-pinned executable is recorded as `supportedBinary: UNSUPPORTED` but the study still runs, and the outcome did not mention it, so a study with an unpinned server printed `COMPLETE-UNDER-DECLARED-ASSUMPTIONS` with no hint. The headline now carries the binary status, a detail line names only binary-related blocking reasons, and tests cover the matching, unsupported and unavailable renderings. Verdict rules are unchanged, so programmatic consumers must read `independentRead.report.hostFacts.supportedBinary` as well as the verdict.
- `--inspect` does not itself check that the pair is a matched `declared-noop` pair (`createStudyPlan` does, after launch). A review raised this as a late-failure risk; it is **not reproducible**: the pre-launch Pi preflight already refuses every pair the preparer can build whose conditions differ (a test now pins this: refusal in preparation, no launch prompt). The real pair was also checked directly. Not changed.
- Preflight (inside `--run`) runs Pi's `--help` with `HOME` set to the evidence directory, which writes `.pi/agent/*` there. This predates the operator and was true of the earlier acceptance.

## 5. Executable decision and go / no-go

**Decision (operator-approved, 2026-10-28): Option 1, the recovered original executable.** Options considered: (1) the recovered original; (2) an isolated rebuild of commit `1f8fa5231`, not needed and not byte-identical, so it would read `UNSUPPORTED`; (3) the Arch build 11429, a different environment whose executable digest does not identify the libraries that run. Option 1 gives the strongest repeatability at no extra complexity. The pre-registration and the original historical references (`2c4c7139…`, build 11518, commit `1f8fa5231`, model `9216fa91…`, Pi `09fc0452…`) are unchanged.

Identity recorded for the run (file identity, not build provenance; the source-to-binary correspondence remains unproven, as the E4e record states):

| Component | SHA-256 |
| --- | --- |
| `llama-server` (build 11518, ELF build ID `ae939bd2…`) | `2c4c7139b339fbe1c10d02f5d8e5464e2cecf91658b2c335b29ddd648d18af68` |
| `libllama-server-impl.so` | `885cb4c9ee973c4bfd2331e7187492919170a071bcd70835e96fc03098c240f7` |
| `libllama.so.0.6.0` | `ef1ee850c47bf726021814800043f354dc98ef22c27ff2801616725d913f43d7` |
| `libllama-common.so.0.6.0` | `e22108a032a49b8b83c6729bc87d9887b09a5e2070ab90f8e97b08308e89056e` |
| `libmtmd.so.0.6.0` | `3552aa3c5aa1f8350e641de0f42da7acdd21aed8b49cdfa9548ba4c39e855543` |
| `libggml.so.0.26.0` | `6e60dd81a207fb610379ad81ddabd03342b2dea21dedf0294a2df2c802eff2f8` |
| `libggml-base.so.0.26.0` | `e4f7c469d3eb94fadbd8ea63ee763826c5e7ed961b861b41db2afaa4dbe8d0e9` |
| `libggml-cpu.so.0.26.0` | `d1aa93cad3726252ceb6955f9a1957d8bf6bbcb616e98f51be7f988a85755029` |
| `libggml-cuda.so.0.26.0` (CUDA arch 89, Release) | `91bdb431e75e5e6c96343381e79dc6cddf1f6bde7410d4c16a5819a8485f3277` |
| `libcudart.so.13.4.92` | `7fb00519a24512bf677b59e87921e5c05aac8246ceb6a57435c0d9dfeef364f6` |
| `libcublas.so.13.8.0.4` | `c0c5a5f16b29c42f1b55b4d081f2ae685e602e3fcf37b7407049d7247036d023` |
| `libcublasLt.so.13.8.0.4` | `d3b51f2253ba58f0a7f299b883bc6b4f3a27f81701c9ab15accb3bd770a91669` |
| `libcuda.so.615.78.08` (NVIDIA driver) | `f73320931be3c4eabc120a1a7fea25f34f324c0f93e35891f98e81a722b5dfc3` |
| `libnccl.so.2.32.3` | `1573c76455f1b1b99ba402635c3c920a71be9f8249d7d9fa54cba4b8d2cf22b7` |

Toolchain recorded in the build cache: CMake 4.4.4, GCC 16.2.1, nvcc 13.4.92, `CMAKE_BUILD_TYPE=Release`, `GGML_CUDA=ON`, CUDA architecture 89, `GGML_NATIVE=ON`, shared libraries. Sixteen further system libraries (libc, libstdc++, OpenSSL and similar) are covered by the private `sha256sum -c` manifest. The build libraries live in the user's home directory and CUDA comes from pacman, so any package upgrade or rebuild invalidates this record: recheck all hashes immediately before the run and stop if any differ.

The operator and readers report the selected executable by what it is: `supportedBinary` is derived from the digest, so it reads `MATCH` here and would read `UNSUPPORTED` for any other build; a `MATCH` states file identity only.

**Go / no-go: NO-GO until** (a) the PR carrying this amendment is reviewed with passing CI, and (b) a server-only loading check (§3, LIVE-UNVERIFIED) is separately authorised and shows the profile loads, or the operator knowingly accepts that risk. Then a new explicit instruction starts the live run.

## 6. Phase B procedure (only after a new explicit instruction from the operator)

1. Recheck immediately before: `nvidia-smi` shows at least about 20 GiB free and no model server; port 18181 free; `git` at the reviewed head; `sha256sum -c ~/endo-aa-live-20261028/recovered-deps.sha256` reports every file OK; repeat the digests of the executable and model; `node research/governed-initial-continuation/aa/operate.ts --inspect ~/endo-aa-live-20261028/config.json` exits 0.
2. Confirm the amendment commit of this document precedes the run.
3. In your own terminal (it must be the controlling terminal; not piped, not a script): `node research/governed-initial-continuation/aa/operate.ts --run ~/endo-aa-live-20261028/config.json`.
4. Read the plan. Type the server phrase exactly to start the owned server; anything else declines and starts nothing. Wait for model-ready.
5. For each of the eight turns read the slot, arm, attempt and request number and type that turn's exact phrase. Keep the continuation phrase ready: the continuation window is 60 s and the whole slot is 120 s. Anything else declines; the study then stops and the slot stays spent.
6. Do not retry or start a substitute study. If something fails, stop and keep the evidence.
7. Read the outcome. Cleanup must read `confirmed`; fresh-process readers have already run. Preserve the evidence directory privately; publish only a redacted summary.
