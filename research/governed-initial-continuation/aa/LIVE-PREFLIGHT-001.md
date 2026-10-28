# AA-LIVE-001: pre-registration and live go/no-go (Phase A, read-only)

Written 2026-10-28, before any real execution, on `main` at `bc7de095b` (PR #96). **No server was started, no model request was sent and `--run` was never invoked.** The checks below are read-only observations of one machine (Arch Linux, RTX 4090). The comparison key, private prompts and evidence contents are not published. Hardware and software identifiers (digests, versions) are published on purpose: they are the experiment's declared environment. Paths are shown relative to `~`.

**Status: PREFLIGHT BLOCKED / NO REAL EXECUTION.** One prerequisite is unavailable (the pinned llama.cpp build) and one needs an operator decision. Everything else that can be checked without running the server is verified.

## 1. Pre-registered design

**Binding rule.** This is a DRAFT until the executable decision in §5 is recorded by an amendment commit. The live run must name that commit, which must be earlier than the run; the git history is the tamper-evident record of when each choice was made. Every other field below is fixed now and may not change after any real execution.

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

**Executable: the one open field (see §5).** Either the pinned build (SHA-256 `2c4c7139…18af68`) is restored, or the local build below is accepted as a declared deviation. The choice must be recorded by amending this document before execution; the configuration's `serverDeclaration` already states the deviation.

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
| 2 | Pinned llama.cpp build 11518 | **UNAVAILABLE** | No file with digest `2c4c7139…` exists on this machine. The only server is `/usr/bin/llama-server` from Arch `llama-cpp 0.6.0-1` (installed 2026-10-09; pacman log shows no other build). It reports **build 11429, commit d812350493**, digest `0f401589…77d85`. Provenance would record `supportedBinary: UNSUPPORTED` / `UNSUPPORTED_BINARY` |
| 3 | Local build: all enforced flags | **VERIFIED** | `--help` of build 11429 advertises all 19 enforced flags. For the pinned build this cannot be checked (binary absent) |
| 4 | Local build: identity strength | **LIMITED** | `/usr/bin/llama-server` is a 14 KB shim; the server code is in shared libraries, so its digest does not identify what runs. Operator-side record (outside provenance): `libllama-server-impl.so` `1efd5921…`, `libllama.so.0.6.0` `2a2d85e0…`, `libllama-common.so.0.6.0` `5c92fbcd…`, `libggml-base.so.0.26.0` `2c55a2e0…`, `libggml.so.0.26.0` `12336613…`, `libmtmd.so.0.6.0` `69318734…`, `ggml/libggml-cuda.so` `4f7ed13a…`; packages `ggml 0.26.0-1`, `ggml-cuda 0.26.0-1`, `cuda 13.4.3-1`, NVIDIA driver 615.78.08 |
| 5 | Model file | **VERIFIED** | exact size and SHA-256 equal the historical reference; readable, owner-only parent |
| 6 | Pi | **VERIFIED** | `/usr/bin/pi` is 1.0.1 and is **not** used. `~/pi-acceptance-*/node_modules/.bin/pi` reports 1.0.4 and its Endophasia identity digest equals the historical `09fc0452…` |
| 7 | Checkpoint and siblings | **VERIFIED** | checkpoint `qualified`; sibling pair `verified-pristine`; manifest `declared-noop`, conditions otherwise equal (checked with the repo's own readers) |
| 8 | Comparison key | **VERIFIED** | installation-domain key present, mode 0600, loads; contents never printed |
| 9 | Evidence location | **VERIFIED** | `0700` directory, 2.3 TB free, study path unused, `.pi` scratch from earlier preflights already present |
| 10 | Running servers and listeners | **VERIFIED** | no llama.cpp or other model server running; nothing on 8080; 18181 free. Unattributed listeners on other ports were not touched |
| 11 | GPU | **VERIFIED** | 23,028 MiB total, 1,507 MiB used by the desktop and a VPN app, no competing compute; llama.cpp reports 20,732 MiB free (CUDA backend loads under the launcher's minimal `PATH=/usr/bin:/bin`) |
| 12 | `--fit off` loadability | **LIVE-UNVERIFIED** | see §3 |
| 13 | Deadlines plausible | **REQUIRES LIVE ACCEPTANCE** | the earlier run loaded in about 23 s and finished two turns in about 24 s; six CPU layers will slow generation somewhat. A 120 s slot budget leaves wide margin, but a long reasoning trace is only observable live |
| 14 | Configuration | **VERIFIED** | `~/endo-aa-live-20261028/config.json` (mode 0600, outside Git); `--inspect` exited 0, wrote nothing, planned launch `bcbca976…`, order ABBA |
| 15 | Readiness route | **REQUIRES LIVE ACCEPTANCE** | the server library contains the health handler; actual `GET /health` behaviour is observable only live. The gate fails closed if the route is absent |

Redacted configuration summary: executable `/usr/bin/llama-server` (digest above); model as above; alias `nanbeige4.3-33b`; `gpuLayers` 46; port 18181; seed 20261028; provider/model `endolocal` / `nanbeige4.3-33b`; limits as in §1; study file in the existing evidence directory (unused); server working directory `~/endo-aa-live-20261028/server-work` (`0700`). Key path, prompts and evidence paths are not reproduced.

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

## 4. Evidence-integrity findings

- **Readiness record (`*.readiness.json`) not read by the fresh-process reader: not material to the PASS conditions, and stated as a limitation of PASS (§1).** None of the PASS conditions depends on it. Each request is independently bound to a keyed admission that re-observes the process and listener, receipts and captures are verified by the unchanged readers, and a server that was not actually serving would fail those requests. The record is an operator-side note of a server-reported observation. No code change was made; extending the reader to check it is optional hardening, not a blocker.
- **Fixed in this PR (reproducible): the printed outcome hid an unpinned binary.** A non-pinned executable is recorded as `supportedBinary: UNSUPPORTED` but the study still runs, and the outcome did not mention it, so a study with an unpinned server printed `COMPLETE-UNDER-DECLARED-ASSUMPTIONS` with no hint. The headline now carries the binary status, a detail line names only binary-related blocking reasons, and tests cover the matching, unsupported and unavailable renderings. Verdict rules are unchanged, so programmatic consumers must read `independentRead.report.hostFacts.supportedBinary` as well as the verdict.
- `--inspect` does not itself check that the pair is a matched `declared-noop` pair (`createStudyPlan` does, after launch). A review raised this as a late-failure risk; it is **not reproducible**: the pre-launch Pi preflight already refuses every pair the preparer can build whose conditions differ (a test now pins this: refusal in preparation, no launch prompt). The real pair was also checked directly. Not changed.
- Preflight (inside `--run`) runs Pi's `--help` with `HOME` set to the evidence directory, which writes `.pi/agent/*` there. This predates the operator and was true of the earlier acceptance.

## 5. Go / no-go

**NO-GO today**, for one reason: the pinned build is unavailable. It is resolved by either:

1. restoring or rebuilding llama.cpp b11518 (commit `1f8fa5231`) at a known path and updating the configuration's executable path and digest (rebuilding needs separate permission), or
2. the operator explicitly accepting build 11429 as a declared deviation, amending §1, and understanding the study then reports `UNSUPPORTED_BINARY` and does not test the pinned build.

Either way, review of the PR carrying this document and the outcome fix should land before the live run.

## 6. Phase B procedure (only after a new explicit instruction from the operator)

1. Recheck immediately before: `nvidia-smi` shows at least about 20 GiB free and no model server; port 18181 free; `git` at the reviewed head; repeat the digests of the executable and model; `node research/governed-initial-continuation/aa/operate.ts --inspect ~/endo-aa-live-20261028/config.json` exits 0.
2. Record the executable decision (§5) in this document and the configuration.
3. In your own terminal (it must be the controlling terminal; not piped, not a script): `node research/governed-initial-continuation/aa/operate.ts --run ~/endo-aa-live-20261028/config.json`.
4. Read the plan. Type the server phrase exactly to start the owned server; anything else declines and starts nothing. Wait for model-ready.
5. For each of the eight turns read the slot, arm, attempt and request number and type that turn's exact phrase. Keep the continuation phrase ready: the continuation window is 60 s and the whole slot is 120 s. Anything else declines; the study then stops and the slot stays spent.
6. Do not retry or start a substitute study. If something fails, stop and keep the evidence.
7. Read the outcome. Cleanup must read `confirmed`; fresh-process readers have already run. Preserve the evidence directory privately; publish only a redacted summary.
