import type { AgentLane, Context, OperationResultRecord, TerminalStatus } from "@earendil-works/pi-agent-core";

/**
 * Payload-minimal projection of Pi's immutable terminal result record for one operation ID.
 * It carries no lane: Pi's result lookup is keyed by operation ID only, so the lane handle used
 * for the read does not establish which lane ran the operation.
 */
export interface OperationOutcomeV0 {
	schemaVersion: "operation-outcome.v0";
	operationId: string;
	kind: OperationResultRecord["kind"];
	status: TerminalStatus;
	fromTipId: string | null;
	tipId: string | null;
	startedAt: number;
	endedAt: number;
	/** Pi's machine-readable error code only; message and details are never exposed. */
	errorCode?: string;
}

/**
 * Read Pi's durable terminal result for an operation ID.
 * `null` means only that getResult returned no record at this read: the ID may be unknown or not yet terminal.
 * Failures from getResult (closed or faulted harness) propagate.
 */
export async function captureOperationOutcomeV0(
	lane: Pick<AgentLane, "getResult">,
	operationId: string,
	context: Context,
): Promise<OperationOutcomeV0 | null> {
	const result = await lane.getResult(operationId, context);
	if (result === undefined) return null;
	return {
		schemaVersion: "operation-outcome.v0",
		operationId: result.operationId,
		kind: result.kind,
		status: result.status,
		fromTipId: result.fromTipId,
		tipId: result.tipId,
		startedAt: result.startedAt,
		endedAt: result.endedAt,
		...(result.error === undefined ? {} : { errorCode: result.error.code }),
	};
}
