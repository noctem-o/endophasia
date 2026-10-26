# Governed single-child initial execution (source tree)

`cli/initial-child-execution.ts` exposes a narrow programmatic sequence:

```ts
const checked = await preflightInitialChildExecutionV0(options, digestKey);
if (checked.status !== "ready") throw new Error(checked.reason);
// Show checked.plan, including its exact commitment, to the local operator.
const approval = approveInitialChildExecutionV0(
  checked.plan, checked.plan.commitment, "approve one tool-free turn"
);
const result = await executeInitialChildV0(checked.plan, approval, options.prompt, digestKey, abortSignal);
if (result.status === "completed") {
  const evidence = verifyInitialChildExecutionEvidenceV0(
    options.source, options.replay, digestKey, `${result.area}/receipt.json`
  );
}
```

`options` identifies the source and replay stores, the private output parent and relative sibling-preparation name, exactly one `baseline` or `alternative` child, an absolute Pi executable, a loopback upstream origin, provider and model, one prompt, a wall timeout of 1–120 seconds and a transfer cap of 1 KiB–16 MiB. The prompt is committed under the comparison-domain key; the receipt does not copy its text. This API has no automatic selection, second-child launch, retry, planner or CLI command. A separate `recordInitialChildPreflightRefusalV0` can retain a no-inference refusal in a safe private output parent. An unsafe output parent is not written to.

Preflight independently re-reads the checkpoint candidate and sibling lineage, requires both children pristine, checks the selected condition, source archive, path and endpoint, fingerprints the selected local Pi and checks its `--help` output for every required launch flag. It invokes local `--version` and `--help`, but creates no Pi RPC session, recording proxy or completion request and does not probe `/v1/models`. Help output shows that a flag is advertised; the captured request and trajectory provide the later behavioural check. An unsupported or unadvertised flag refuses before an agent turn.

The approval binds the whole plan commitment, including exact parent and branch commitments, child ID and condition commitment, archive, Pi identity/version, upstream, provider/model, prompt commitment, no-tools policy, bounds and a unique attempt ID. It expires after five minutes. Approval is an explicit call by a trusted local operator or local caller; it does **not** authenticate a remote person. The branch-set's `continuationAuthority: "none"` is never used as a credential. The attempt directory is exclusive; any reuse or ambiguous interruption retains it and refuses a second dispatch. The plan is checked again just before execution. This is an at-most-one-dispatch attempt marker, not an exactly-once guarantee for an external model request.

## Supported source and runtime transformation

The original prepared child and sibling are only read. The source archive must be at most 16 MiB and contain only `home/`, `agent/`, `work/`, one minimal `agent/models.json` with the selected provider/model and a prior loopback proxy URL, an optional `agent/settings.json` with `thinkingLevel: "off"`, and ordinary non-executable workspace files. Symlinks, executable entries, other agent files, nested `.pi`, `.codex`, `.agents`, `AGENTS.md`, `.env`, `.mcp.json`, `package.json` and unsupported historical model settings refuse. No archive-wide string replacement occurs. The only supported condition is no manipulation or `settings: { thinkingLevel: "off" }`; model-entry changes, extensions, environment changes, interventions and other settings refuse. A declared alternative is not silently applied.

A new private attempt area contains `runtime/` and `evidence/`. The source archive is restored to `runtime/` and rearchived byte-for-byte before any adaptation. Only `runtime/agent/models.json` is rebound to this attempt's fresh recording proxy, plus the supported condition setting if declared. The proxy binds to the exact approved loopback upstream. The adapted pre-execution archive is keyed and retained under `evidence/`. Pi's HOME, `PI_CODING_AGENT_DIR`, session directory, Endophasia store and working directory are all under this attempt; no operator HOME or Pi session is reused. The generated Pi session ID is fixed before launch; a different reported ID refuses. The prepared archive retains its original proxy URL and path bytes unchanged. After the turn, a separate keyed post-execution archive is retained and checked. These are three different states: verified source, adapted pre-execution runtime and post-execution runtime.

Pi is launched with `--no-tools`, `--no-extensions`, `--no-mcp`, `--no-skills`, `--no-context-files`, `--no-prompt-templates`, `--no-approve`, `--offline` and explicit provider/model. The live startup state must report the requested model, zero messages and thinking off. One prompt is sent. The existing RPC process group owns the child and its descendants; cancellation and timeout close only this group's process. The proxy limits aggregate transferred bytes, Pi stdout is bounded, request records are bounded, and source/adapted/post archives have explicit caps. Capture failures, extra exchanges, tool definitions/calls, wrong model or incomplete finalisation cannot yield a completed result.

The launch flags remove Pi's agent tools and startup resources within this tested profile. They do **not** confine the operating-system process's filesystem or network capabilities. This first slice is for trusted local operators and non-effectful experimental prompts. Same-UID malicious mutation and hostile filesystems are outside the filesystem reader's guarantees.

## Receipt and independent reader

The private canonical `endo.initial-child-execution.v0` receipt is written under `<output-parent>/<attempt-id>/receipt.json`. It transitions through `approved-not-dispatched`, optionally with staged runtime data, then durable `dispatched` **before** the prompt write. It ends `completed`, `failed`, `cancelled` or `outcome-unknown`; a separate no-inference refusal receipt uses `preflight-refused`. A crash after dispatch leaves `dispatched`, which must be treated as unknown. A disconnected or interrupted external request is never retried automatically. Receipt commitments use separate keyed plan and receipt purposes, not signatures.

The public completed reader accepts only the durable file path. It revalidates the current parent and both siblings; plan/approval/receipt commitments and attempt path; source, adapted and post-run archives; the exact proxy/upstream; complete capture and Pi logs; one captured request and complete response; the request-body keyed digest; one matching user prompt; the model and zero tools in the effective harness surface; the actual Pi identity, version, flags and configuration digests; and one completed trajectory with no tool events. It rejects missing or stale evidence, wrong digest domains and mismatches. The request surface retains observed parameters and instruction/tool digests by reference, while the receipt avoids copying raw prompts or transcripts. `/v1/models` metadata, GPU use, model weights, server defaults, seeds and external-world equality remain unavailable unless separately measured.

A verified checkpoint establishes a recorded pre-execution filesystem archive. A prepared child establishes a currently pristine copy and declared condition. Runtime derivation reconstructs that archive in another area and explicitly changes the supported configuration. Approval authorises one fresh invocation. The captured model request and Pi trajectory establish what was observed, and the receipt binds that evidence to this parent and child. None of these steps restores Pi process memory, model KV cache, a historical session or the original external environment. This is fresh execution derived from verified initial state, not continuation of an existing process.

CI exercises this path with synthetic fake Pi and a fake OpenAI-compatible server. Real Pi with the operator's local Nanbeige server is optional and requires fresh separate approval; it is never part of default CI. Source-tree work here is absent from previously published npm alpha packages.
