# DEVELOP-ISOLATE-003: attested Everyday

## Where the record lives

The attestation is a frozen, in-memory record owned by the Endophasia controller, outside the sandbox. Only the trusted launch code can populate the private closure in `cli/everyday-pi.ts`. It does so after the controller has verified the shim's dedicated challenge, the same-PID exec into the pinned Pi runtime, and the first correlated `get_state` on that same connection. The record includes the fully qualified Endophasia session ID, the canonical selected workspace and a host recheck over captured kernel identities. It is never serialized to a file, inherited in a descriptor or read from an environment variable. Pi can send normal RPC responses but has no setter for the record or access to the controller's memory or host procfs; the guest loopback bridge does not inherit the RPC or challenge endpoints. This assumes a trusted host, controller and pinned runtime, not protection against another host process with the operator's authority.

## Launch and loss

The guarded workbench uses a read-only admitted snapshot rather than binding a live writable checkout. The host does not run the project Git inspector or fetch attempt provenance on this path. Pi uses a private home, an ephemeral session and no tools, extensions, MCP or project context. A trusted, separate bridge inside the same isolated network namespace reaches the existing governed local relay, whose origin is fixed at `127.0.0.1:8090` and whose model and one-exchange budget are fixed. No operator provider configuration, keys or real credentials reach Pi. The SDK's fixed local placeholder is not a credential and is not recorded as a value. The recorder's existing host loopback exposure is unchanged.

`observe()` uses a fixed set of local procfs and inode reads, with no manager or RPC calls, child waits or process enumeration. It compares the observed PID and birth time, boot ID, exact cgroup, namespace identities, workspace and executable/image identities, and the owned transport. A verified record returns `enforced / workspace`, mechanism `endo.pi-bubblewrap-workspace.v0`, and the exact session and canonical root. Its fixed limitations say there is no credential route, no restricted protection and no per-writer RPC attribution. The broker still requires exact subject matching at issuance and every use. Explicit Strict and Protected keep their old decisions: Strict needs terminal approval and Protected starts nothing.

`EndoSessionControlV0.runtimeLost(): void` is called by `WorkbenchBrokerV0.endSession()` on runtime loss. It disarms the pairing code and rechecks the **held** grant's subject, without reading a replacement session or authorizing anything. A matching attestation gives the existing `closing` reason; a missing, stale, contradictory or unreadable one gives `protection-lost`. The explicit shutdown path still uses `beginClose()` and records `closing`. Strict has no grant to revoke.

| Condition | Provider answer and fixed first limitation |
| --- | --- |
| No attestation machinery selected | `not-enforced`: No attested execution boundary is available for this launch. |
| No record, or a record removed after grant | `not-enforced`: No live execution attestation is available for this launch. |
| Different session or workspace in the record | `not-enforced`: The execution attestation is for a different session or workspace. |
| Dead process, replaced workspace, or changed identity | `not-enforced`: The attested process, scope, namespaces, or workspace no longer match. |
| Evidence cannot be read | `unknown`: The live execution evidence could not be read. |
| Malformed or contradictory record | `unknown`: The live execution attestation is inconsistent. |

All refusals return level `none` and null mechanism, session and workspace; a lost observation cannot revive the grant. The workspace-file forgery control wrote a plausible record naming the exact subject and demonstrated that the provider ignored it. Separate in-process tests replace or remove the controller-only record through a test seam to exercise loss; that seam is not exposed in the workbench.

## Measured on Arch

The opt-in real-terminal test launched stock Pi 1.5.2, redeemed the first control pairing code and saw `enforced / workspace` and an active Everyday grant. The prompt was accepted as authorized by that grant with no terminal approval; Pi returned `READY`, and the relay reported one admitted completion and one HTTP 200 response. While that workbench was live, replacing the source workspace inode switched authority to Strict, revoked the grant as `protection-lost`, and made the next prompt wait for terminal approval. An independent offline run killed only the attested Pi PID, observed `protection-lost` and a 401 on the old grant, and confirmed scope cleanup. Another offline run denied an unreadable workspace while its original Pi process was still alive. The Strict fallback and Protected refusal were checked from real terminal launches using disposable configuration; record substitution and corruption were simulations. Model spend was zero and the existing model listener was left running.

The workbench does not authenticate individual writers on stock RPC, and a successful relay exchange does not prove exclusive request lineage at the host-loopback recorder. Descendant namespace enforcement is a prerequisite of any tool-enabled route; observing Pi's own namespaces is not that proof. There is no credential or restricted route, no arbitrary runtime support, and no read-write live workspace. The snapshot does not make cross-file reads atomic.

Run the real terminal check only on an approved host with that local model available, using a synthetic HOME and the real XDG_RUNTIME_DIR. Set `ENDO_EVERYDAY_LOCAL_MODEL=1` for the real model test in `tests/develop-ux-002-cli.test.ts`. Set `ENDO_ATTESTED_PI_HOST=1` for the offline loss tests in `tests/develop-isolate-003-provider.test.ts`; those tests do not contact the model.
