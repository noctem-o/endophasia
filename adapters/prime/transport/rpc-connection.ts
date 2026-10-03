// Prime RPC Runtime Ingress v0: one `prime-agent --mode rpc` child process over the runtime-neutral JSONL RPC
// connection (adapters/rpc-jsonl/rpc-connection.ts). Only what is Prime-specific lives here: how a Prime installation
// is started, and the "Prime" label its errors carry. Prime's vocabulary stays raw, for the Prime semantic adapter.
import {
	type RpcConnectionOptionsV0,
	RpcConnectionV0,
	RpcErrorV0,
	RpcExitErrorV0,
} from "../../rpc-jsonl/rpc-connection.ts";
import type { PrimeInstallationV0 } from "./runtime-identity.ts";

export type {
	RpcDiagnosticV0 as PrimeRpcDiagnosticV0,
	RpcEventV0 as PrimeRpcEventV0,
	RpcExitV0 as PrimeRpcExitV0,
	RpcListenerErrorNameV0 as PrimeRpcListenerErrorNameV0,
	RpcProtocolFaultV0 as PrimeRpcProtocolFaultV0,
	RpcResponseV0 as PrimeRpcResponseV0,
	RpcSentCommandV0 as PrimeRpcSentCommandV0,
	RpcTerminationV0 as PrimeRpcTerminationV0,
} from "../../rpc-jsonl/rpc-connection.ts";

/** The same error classes: a Prime connection's failures are instances of these. */
export const PrimeRpcErrorV0 = RpcErrorV0;
export type PrimeRpcErrorV0 = RpcErrorV0;
export const PrimeRpcExitErrorV0 = RpcExitErrorV0;
export type PrimeRpcExitErrorV0 = RpcExitErrorV0;

export interface PrimeRpcConnectionOptionsV0
	extends Omit<RpcConnectionOptionsV0, "launch" | "label" | "stderr" | "maxStderrBytes"> {
	readonly installation: PrimeInstallationV0;
}

/** One Prime RPC process. Prime's stderr is never read: it may quote payloads. */
export class PrimeRpcConnectionV0 extends RpcConnectionV0 {
	constructor(options: PrimeRpcConnectionOptionsV0) {
		const { installation, ...rest } = options;
		// A source checkout starts through prime-agent.sh, which needs a POSIX shell: Windows cannot spawn it directly.
		if (installation.mode === "source-checkout" && process.platform === "win32") {
			throw new RpcErrorV0("A Prime source checkout cannot be started on Windows; use PRIME_AGENT_BIN");
		}
		super({
			...rest,
			launch: { command: installation.command, leadingArgs: installation.leadingArgs },
			label: "Prime",
			stderr: "ignore",
		});
	}
}
