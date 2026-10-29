// A controllable stand-in for the attached session, and helpers for driving the workbench broker. No Pi, no model, no network.
import type { WorkbenchApprovalRequestV0, WorkbenchApproverV0, WorkbenchSessionV0 } from "../adapters/pi/workbench.ts";
import type { RpcEventV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { type EndoWorkbenchKindV0, endoWorkbenchPayloadProblemV0 } from "../protocol/workbench.ts";

export interface Recorded {
	id: string;
	kind: EndoWorkbenchKindV0;
	payload: Record<string, JsonValueV0>;
	derivedFrom: readonly string[];
}

export class FakeSession implements WorkbenchSessionV0 {
	piSessionId: string | null = "fake-session-1";
	live = true;
	runActive = false;
	records: Recorded[] = [];
	promptCalls: string[] = [];
	promptResult: () => Promise<string> = async () => "started";
	failRecording = false;
	onLiveEvent: ((event: RpcEventV0) => void) | null = null;
	async prompt(message: string): Promise<string> {
		this.promptCalls.push(message);
		return this.promptResult();
	}
	recordWorkbench(
		kind: EndoWorkbenchKindV0,
		payload: Record<string, JsonValueV0>,
		derivedFrom: readonly string[] = [],
	): EndoEventV0 {
		if (this.failRecording) throw new TypeError("the session attachment is not recording");
		const problem = endoWorkbenchPayloadProblemV0(kind, payload);
		if (problem !== null) throw new TypeError(problem);
		const record = { id: `endo.event.fake.${this.records.length + 1}`, kind, payload, derivedFrom };
		this.records.push(record);
		return record as unknown as EndoEventV0;
	}
	live_(event: RpcEventV0): void {
		this.onLiveEvent?.(event);
	}
}

/** An approver the test resolves by hand. */
export class Approval {
	requests: WorkbenchApprovalRequestV0[] = [];
	#resolve: ((answer: "allow" | "deny" | null) => void) | null = null;
	readonly approver: WorkbenchApproverV0 = (request, signal) =>
		new Promise((resolve) => {
			this.requests.push(request);
			this.#resolve = resolve;
			signal.addEventListener("abort", () => resolve(null), { once: true });
		});
	answer(value: "allow" | "deny" | null): void {
		this.#resolve?.(value);
	}
	async waitForRequest(): Promise<WorkbenchApprovalRequestV0> {
		for (let i = 0; i < 200 && this.requests.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
		const request = this.requests.at(-1);
		if (request === undefined) throw new Error("no approval was asked for");
		return request;
	}
}

export const settle = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const textMessage = (role: string, text: string): RpcEventV0 => ({
	type: "message_end",
	record: { message: { role, content: [{ type: "text", text }] } },
});
