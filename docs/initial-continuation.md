# Governed same-session initial continuation (source tree)

`cli/initial-continuation.ts` provides one narrowly bounded two-turn attempt. It derives a new runtime from one currently verified prepared child, launches one fresh Pi session, and keeps that owned session alive between turns. It does not reopen a historical process or grant authority from the branch preparation. The existing `endo.initial-child-execution.v0` API and receipt remain unchanged.

A trusted local caller first verifies a sibling preparation and selects a child. Replace the example paths and explicit loopback endpoint with the caller's private evidence and separately authorized test endpoint. This example prompts for each approval and sends no request if the operator declines:

```ts
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";
import { readEndoDigestKeyV0 } from "./storage/digest-key.ts";
import { readVerifiedInitialBranchSetV0 } from "./cli/initial-branch-set.ts";
import {
  preflightInitialContinuationV0, approveInitialContinuationV0,
  approveContinuationTurnV0, executeInitialContinuationV0,
  verifyInitialContinuationEvidenceV0,
} from "./cli/initial-continuation.ts";

const key = readEndoDigestKeyV0("/private/domain-key.json");
const options = {
  source: "/private/source", replay: "/private/replay",
  outputParent: "/private/attempts", preparation: "endo-initial-branches-...",
  childRole: "baseline" as const, piExecutable: "/private/pi/bin/pi",
  upstream: "http://127.0.0.1:12345", provider: "local", model: "explicit-model",
  prompt: "First approved prompt", continuationPrompt: "Second approved prompt",
  wallTimeoutMs: 60000, maxApprovalIdleMs: 20000, maxTransferredBytes: 1048576,
};
const child = readVerifiedInitialBranchSetV0(options.source, options.replay, key,
  options.outputParent, options.preparation);
if (child.status !== "verified-pristine") throw new Error("prepared children are not pristine");
const preflight = await preflightInitialContinuationV0(options, key);
if (preflight.status !== "ready") throw new Error(preflight.reason);
const input = createInterface({ input: stdin, output: stdout });
try {
  stdout.write(`${JSON.stringify(preflight.plan, null, 2)}\n`); // private plan and commitments
  if ((await input.question("Approve the first turn? Type yes: ")) !== "yes") throw new Error("not approved");
  const first = approveInitialContinuationV0(preflight.plan, preflight.plan.commitment, "approve first tool-free turn");
  const result = await executeInitialContinuationV0(preflight.plan, first, options.prompt,
    options.continuationPrompt, key, async (boundary) => {
      stdout.write(`${JSON.stringify(boundary, null, 2)}\n`); // provisional, session is still open
      if ((await input.question("Approve the continuation? Type yes: ")) !== "yes") return null;
      return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
    });
  stdout.write(`${JSON.stringify(result)}\n`);
  if ("area" in result) {
    const evidence = await verifyInitialContinuationEvidenceV0(options.source, options.replay, key,
      join(result.area, "receipt.json"));
    stdout.write(`${JSON.stringify(evidence)}\n`);
  }
} finally { input.close(); }
```

Preflight sends no model request. It rechecks the parent candidate, capture/replay generations, sibling preparation and child, the supported condition and source archive, the local Pi binary/version and required launch flags. The plan commits to these, the explicit loopback origin and provider/model, both prompts, one unique attempt, a single overall wall deadline, transfer cap, 2 MiB RPC-output cap and approval idle limit. The first approval is an explicit local confirmation of that plan and expires after five minutes. During runtime derivation the actual adapted archive and fresh session ID are bound into the first durable dispatch marker before the first prompt. A marker is an at-most-one-local-dispatch record, not a promise that an upstream service executes or charges exactly once.

The first turn must settle with one complete captured model exchange, the approved prompt and model, no tool definitions or calls, and a complete Pi trajectory. At the provisional boundary the process must still be live, report the same session, model and two messages, be idle with no queued messages, and retain the verified runtime. The boundary commits the first request and response, trajectory and prefixes of both open evidence logs; it is **not** a sealed final receipt. It also states the remaining transfer and RPC-output budgets, overall deadline and shorter approval deadline. The callback has no session handle. The distinct second approval binds that exact boundary and intended prompt; stale, reused, absent or changed approval cannot authorize a second request. The program rechecks session identity, evidence, parent, child and Pi binary before writing the second dispatch marker. An opt-in proxy admission gate buffers and checks each complete request before forwarding it, and consumes one local permit per dispatch. It accepts fixed-length HTTP requests and rejects ambiguous framing, extra requests, a changed model, tools, or altered conversation. It also buffers and validates the complete bounded OpenAI streaming response before delivering any bytes to Pi. Only text deltas ending in `stop` and `[DONE]` are supported; malformed responses, tool calls and other response shapes are refused. This profile does not preserve upstream streaming timing. A failed request is never retried.

The second request must contain the same first request context, the captured first response and the separately committed second user prompt. The single Pi RPC connection and process remain owned throughout. A changed session, exited process, unsolicited exchange, output breach, timeout, cancellation or failed evidence check stops the attempt. The process is not restarted. The approval callback is bounded by `maxApprovalIdleMs` and the overall deadline; if approval is unavailable, the process is closed and first-turn evidence is retained when it can be verified. A cancellation or disconnect after either dispatch may leave the external outcome unknown.

The canonical private `endo.initial-continuation.v0` receipt, two exclusive dispatch files, keyed blobs, source/adapted/boundary/post-runtime archive commitments and capture/trajectory evidence live in a new attempt directory. The receipt distinguishes waiting for approval, second approval recorded but not dispatched, dispatch, successful settlement, completed-but-unverifiable evidence, cancellation and an unknown outcome. A valid second approval is retained even if a later check refuses dispatch. No raw prompt or transcript is copied into the receipt. The independent reader rechecks the current parent and children, plan and approval commitments, markers, archive transformations and current runtime, Pi binary, complete captured exchanges and response bytes, request ordering and context, session attachment, control events and trajectory. It returns `verified`, `first-turn-verified` for a closed first-only attempt, or `unverified` with the recorded outcome. An interrupted or partially published receipt never establishes completion. The first boundary is independently checked as a committed prefix of the final closed logs.

These checks establish observed same-session continuity and that the second captured request contains the first response. They cannot independently inspect Pi's private memory or prove the implementation of its internal conversation state. The PID check is a live local observation, not a portable process attestation. The comparison-domain key is an integrity commitment, not a signature or remote identity credential. Logs and blobs can contain sensitive prompts and responses and must remain private.

The profile uses a fresh HOME, separate Pi and Endophasia stores, loopback upstream only, a fixed no-tools/no-extensions/no-MCP/no-skills/no-context-files launch and owned-process-group cleanup. It is for trusted local callers; it is not an operating-system filesystem or network-effect sandbox. Same-UID hostile mutation remains outside the guarantee. The tests use synthetic Pi and a fake OpenAI-compatible endpoint. A real-provider acceptance run requires separate authorization; no production endpoint is a default.

Unavailable: historical Pi process or KV-cache restoration, general tool-capable continuation, external-effect isolation, arbitrary checkpoint resume, cassette-then-live switching, general multi-agent branching, automatic baseline/alternative execution and autonomous EVOLVE promotion. This source-tree slice is not full checkpoint/fork capability and is absent from previously published npm alpha artifacts.
