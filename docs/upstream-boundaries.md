# Upstream boundaries: what Endophasia owns, and what it leaves to the harness

Endophasia attaches around agent harnesses. It does not replace them. As harnesses improve, Endophasia should gain from
the improvement rather than compete with it. This page states the ownership line and a rule for deciding where a new
feature belongs. [vision.md](vision.md) gives the purpose. [attachment.md](attachment.md) gives the mechanism.

## Ownership

**Endophasia owns:**

- **Canonical evidence.** The `endo.*` event and evidence records, their digests and provenance. No harness's own logs,
  session files or traces are Endophasia's evidence, though they may be observed or imported into it.
- **Experimental reproducibility.** Experiment design, recorded conditions, comparison and what a result may claim.
- **Cross-harness semantics.** The neutral vocabulary (lifecycle, capabilities, trajectories, loss accounting) that
  lets runs from different harnesses be read and compared, with explicit loss where they differ.
- **Operator governance.** Which requests reach a harness, approval in the controlling terminal, and the capability
  evidence that decides which controls are offered at all.

**The harness owns** its agent loop, model and provider integration, native tools, context management (compaction,
memory), retries and recovery, extension behaviour, and its own persistence. Endophasia observes these through the
harness's documented interface and records what it observes. It does not re-implement them.

| Upstream | What it is to Endophasia |
| :-- | :-- |
| Pi | The attached runtime. Agent loop, codemode, compaction, providers and session files are Pi's. Endophasia speaks `pi --mode rpc` and records. |
| Pi Durable | Not used. A separate persistence package; its format changes do not reach the RPC interface. Importing it is refused by a boundary test. |
| ACP agents | Attached at the protocol level (`adapters/acp`); no capability admitted yet. |
| Strands Agents (SDK, preconfigured harness) | A possible future attachment. Its 0.x harness versions may change defaults, prompts and tools, so each version would be its own identity. |
| Strands' native evaluation | An optional scoring implementation. A score it produces would be an observed input to an Endophasia experiment, never the experiment's evidence. |
| Strands Shell | A restricted in-process tool environment. It is not an operating-system security boundary, and Endophasia would not treat it as one. |
| Strands Box | A candidate for external sandboxing or governance, subject to the platforms it actually supports. Delegation would be an explicit decision, not an assumption. |
| External evaluators in general | Optional scorers. They do not own Endophasia's experiment records. |

None of the Strands entries is integrated. They are listed so that a later integration starts from a stated boundary.

## Security boundaries

- Terminal approval controls **dispatch**. It does not sandbox what the harness's tools do. A harness's own tool
  restrictions are its own claims, recorded as such. They are not Endophasia guarantees.
- An admitted capability means current evidence supports it. It grants nothing. Authorisation stays with the
  operator's approval chain (and, where used, Deadbolt).
- Credentials stay with the harness. Endophasia never reads them into a record. The configuration digest excludes
  credential files and secret-like environment variables.

## The decision rule

Before implementing, inside Endophasia, a feature an external framework already provides, decide which of these it is,
in this order:

1. **Reuse**: call the upstream feature through its documented interface, and record that it was used.
2. **Adapt**: map the upstream output into Endophasia's neutral records, with explicit loss accounting.
3. **Observe**: record what the upstream does (events, outcomes) without depending on it.
4. **Compare**: run it beside an alternative under recorded conditions, and keep the comparison as evidence.
5. **Delegate**: let the upstream own the concern outright (sandboxing, scoring), with the boundary written down here.
6. **Implement locally**: only for what Endophasia owns (above), or when no upstream offers it with the guarantees an
   experiment needs. Say which guarantee was missing.

When upstream changes, the adapter is the only place that should need to change. Version handling, probes,
configuration collection and schema interpretation stay in the adapter. The shared contracts (`protocol/harness.ts`,
`runtime/contracts/harness-assessment.ts`) know no harness's events, packages or paths. Upgrades are assessed from
evidence, not from version numbers ([harness-upgrades.md](harness-upgrades.md)).
