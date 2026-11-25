/**
 * Milestone D5 — Fail-closed native approval parsing and schema-accurate response encoding for Codex App Server.
 *
 * Grounded directly in `codex-cli 0.171.0` generated `ServerRequest` & response schemas:
 * - `item/commandExecution/requestApproval` -> `{ decision: "accept" | "decline" | "cancel" }`
 *   (NEVER `acceptForSession`, `acceptWithExecpolicyAmendment`, or `applyNetworkPolicyAmendment`)
 * - `item/fileChange/requestApproval`       -> `{ decision: "accept" | "decline" | "cancel" }`
 *   (NEVER `acceptForSession`)
 * - `item/permissions/requestApproval`      -> fail-closed `{ permissions: {}, scope: "turn" }` (zero extra permissions;
 *   NEVER `"session"` scope or scope broadening)
 * - `item/tool/requestUserInput`            -> fail-closed `{ answers: {} }` (no automated answers)
 * - `mcpServer/elicitation/request`         -> fail-closed `{ action: "decline" | "cancel", content: null, _meta: null }`
 * - Legacy `applyPatchApproval` / `execCommandApproval` -> fail-closed `{ decision: { denied: { rejection: ... } } }`
 * - `item/tool/call`                        -> fail-closed `{ contentItems: [], success: false }`
 * - `account/chatgptAuthTokens/refresh`, `attestation/generate`, and any unknown method -> JSON-RPC error `-32601`
 */

import type {
	EndoAdapterNativeApprovalKindV0,
	EndoAdapterNativeApprovalScopeV0,
	EndoDevelopNativeApprovalOutcomeV0,
	EndoDevelopNativeApprovalRequestV0,
} from "../../protocol/develop-adapter.ts";
import type { CodexJsonRpcIdV0, CodexServerRequestV0 } from "./app-server-client.ts";

/** Known native approval kinds that `CodexDevelopAdapterV0` recognizes (only command-execution & file-change allow one-time accept in v0). */
export const CODEX_INTERACTIVE_APPROVAL_KINDS_V0 = [
	"command-execution",
	"file-change",
] as const satisfies readonly Exclude<EndoAdapterNativeApprovalKindV0, "unknown">[];

export const CODEX_KNOWN_APPROVAL_KINDS_V0 = [
	"command-execution",
	"file-change",
	"permissions",
	"user-input",
	"mcp-elicitation",
] as const satisfies readonly Exclude<EndoAdapterNativeApprovalKindV0, "unknown">[];

export interface ParsedCodexServerRequestV0 {
	readonly rpcId: CodexJsonRpcIdV0;
	readonly requestId: string;
	readonly threadId: string | null;
	readonly turnId: string | null;
	readonly itemId: string | null;
	readonly nativeMethod: string;
	readonly approvalKind: EndoAdapterNativeApprovalKindV0;
	/** Whether an explicit one-time operator accept is supported for this method in v0. */
	readonly interactiveAcceptSupported: boolean;
	/** Whether the server proposed broadening beyond one-time execution (e.g. policy amendment, grantRoot, permissions). */
	readonly proposesBroadening: boolean;
	readonly normalized: EndoDevelopNativeApprovalRequestV0;
}

export type CodexServerRequestReplyV0 =
	| { readonly kind: "result"; readonly result: Record<string, unknown> }
	| { readonly kind: "error"; readonly code: number; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const UNSAFE_TERMINAL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const sanitize = (value: string, max: number): string => value.replace(UNSAFE_TERMINAL_CHARS, " ").trim().slice(0, max);

const optStr = (value: unknown, max = 256): string | null => {
	if (typeof value !== "string") return null;
	const cleaned = sanitize(value, max);
	return cleaned.length > 0 ? cleaned : null;
};

export function codexServerRequestIdStringV0(id: CodexJsonRpcIdV0): string {
	return `codex-req:${typeof id}:${String(id)}`;
}

/**
 * Parse an inbound Codex `ServerRequest` into an `EndoDevelopNativeApprovalRequestV0`.
 * Never trusts untrusted params without validation; unknown methods map to `approvalKind: "unknown"` and fail closed.
 */
export function parseCodexServerRequestV0(args: {
	readonly request: CodexServerRequestV0;
	readonly source: string;
	readonly sessionKey: string;
}): ParsedCodexServerRequestV0 {
	const { request, source, sessionKey } = args;
	const params = isRecord(request.params) ? request.params : {};
	const requestId = codexServerRequestIdStringV0(request.id);
	const threadId = optStr(params.threadId, 256) ?? optStr(params.conversationId, 256);
	const turnId = optStr(params.turnId, 256);
	const itemId = optStr(params.itemId, 256) ?? optStr(params.callId, 256);

	let approvalKind: EndoAdapterNativeApprovalKindV0 = "unknown";
	let requestedScope: EndoAdapterNativeApprovalScopeV0 = "once";
	let interactiveAcceptSupported = false;
	let proposesBroadening = false;
	let summary = `Codex server request: ${sanitize(request.method, 128)}`;

	switch (request.method) {
		case "item/commandExecution/requestApproval": {
			approvalKind = "command-execution";
			interactiveAcceptSupported = true;
			const cmd = optStr(params.command, 200);
			const cwd = optStr(params.cwd, 120);
			const reason = optStr(params.reason, 120);
			const hasExecAmend =
				params.proposedExecpolicyAmendment !== undefined && params.proposedExecpolicyAmendment !== null;
			const hasNetAmend =
				Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length > 0;
			proposesBroadening = hasExecAmend || hasNetAmend;
			// Even if Codex attaches a proposed policy amendment, Endophasia NEVER asks for policy-amendment scope;
			// operator can only accept once, decline, or cancel.
			requestedScope = "once";
			const parts = [
				"Command execution approval",
				cmd ? `cmd=${cmd}` : null,
				cwd ? `cwd=${cwd}` : null,
				reason ? `reason=${reason}` : null,
				proposesBroadening ? "(proposed policy amendment withheld; one-time decision only)" : null,
			].filter(Boolean);
			summary = sanitize(parts.join(" | "), 380);
			break;
		}
		case "item/fileChange/requestApproval": {
			approvalKind = "file-change";
			interactiveAcceptSupported = true;
			const reason = optStr(params.reason, 160);
			const grantRoot = optStr(params.grantRoot, 160);
			proposesBroadening = grantRoot !== null;
			requestedScope = "once";
			const parts = [
				"File change approval",
				reason ? `reason=${reason}` : null,
				grantRoot ? `(requested grantRoot=${grantRoot} withheld; one-time decision only)` : null,
			].filter(Boolean);
			summary = sanitize(parts.join(" | "), 380);
			break;
		}
		case "item/permissions/requestApproval": {
			approvalKind = "permissions";
			interactiveAcceptSupported = false;
			proposesBroadening = true;
			requestedScope = "policy-amendment";
			const reason = optStr(params.reason, 160);
			summary = sanitize(
				`Additional permission request (declined fail-closed in v0)${reason ? `: ${reason}` : ""}`,
				380,
			);
			break;
		}
		case "item/tool/requestUserInput": {
			approvalKind = "user-input";
			interactiveAcceptSupported = false;
			requestedScope = "once";
			summary = "Tool user-input request (declined fail-closed in v0)";
			break;
		}
		case "mcpServer/elicitation/request": {
			approvalKind = "mcp-elicitation";
			interactiveAcceptSupported = false;
			requestedScope = "once";
			const server = optStr(params.serverName, 80);
			summary = sanitize(
				`MCP elicitation request${server ? ` from ${server}` : ""} (declined fail-closed in v0)`,
				380,
			);
			break;
		}
		default: {
			approvalKind = "unknown";
			interactiveAcceptSupported = false;
			requestedScope = "unknown";
			summary = sanitize(`Unknown/unsupported Codex server request (${request.method}) — fail-closed`, 380);
			break;
		}
	}

	return {
		rpcId: request.id,
		requestId,
		threadId,
		turnId,
		itemId,
		nativeMethod: sanitize(request.method, 128),
		approvalKind,
		interactiveAcceptSupported,
		proposesBroadening,
		normalized: {
			requestId,
			source,
			sessionKey,
			instanceId: request.instanceId,
			turnId,
			itemId,
			approvalKind,
			nativeMethod: sanitize(request.method, 128),
			requestedScope,
			summary,
		},
	};
}

/**
 * Encode the schema-accurate Codex App Server JSON-RPC reply for a resolved `ServerRequest`.
 * NEVER emits `acceptForSession`, `acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`,
 * `approved_for_session`, or non-empty `GrantedPermissionProfile` in v0.
 */
export function encodeCodexNativeApprovalReplyV0(
	parsed: ParsedCodexServerRequestV0,
	outcome: EndoDevelopNativeApprovalOutcomeV0,
): CodexServerRequestReplyV0 {
	switch (parsed.nativeMethod) {
		case "item/commandExecution/requestApproval": {
			if (outcome.resolution === "accepted" && outcome.scope === "once") {
				return { kind: "result", result: { decision: "accept" } };
			}
			return {
				kind: "result",
				result: { decision: outcome.resolution === "cancelled" ? "cancel" : "decline" },
			};
		}
		case "item/fileChange/requestApproval": {
			if (outcome.resolution === "accepted" && outcome.scope === "once") {
				return { kind: "result", result: { decision: "accept" } };
			}
			return {
				kind: "result",
				result: { decision: outcome.resolution === "cancelled" ? "cancel" : "decline" },
			};
		}
		case "item/permissions/requestApproval": {
			// Empty GrantedPermissionProfile with "turn" scope grants ZERO additional permissions.
			return { kind: "result", result: { permissions: {}, scope: "turn" } };
		}
		case "item/tool/requestUserInput": {
			return { kind: "result", result: { answers: {} } };
		}
		case "mcpServer/elicitation/request": {
			return {
				kind: "result",
				result: {
					action: outcome.resolution === "cancelled" ? "cancel" : "decline",
					content: null,
					_meta: null,
				},
			};
		}
		case "applyPatchApproval":
		case "execCommandApproval": {
			return {
				kind: "result",
				result: {
					decision: {
						denied: { rejection: "Endophasia v0 declines legacy approval RPCs fail-closed." },
					},
				},
			};
		}
		case "item/tool/call": {
			return {
				kind: "result",
				result: { contentItems: [], success: false },
			};
		}
		default: {
			return {
				kind: "error",
				code: -32601,
				message: `Unsupported Codex server request method (${parsed.nativeMethod}) — declined fail-closed by Endophasia.`,
			};
		}
	}
}
