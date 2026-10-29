// A controllable stand-in for the attached session, and helpers for driving the workbench broker. No Pi, no model, no network.
import type { PiInterventionApplyResultV0 } from "../adapters/pi/intervention.ts";
import type { WorkbenchApprovalRequestV0, WorkbenchApproverV0, WorkbenchSessionV0 } from "../adapters/pi/workbench.ts";
import type { WorkbenchDeskV0 } from "../adapters/pi/workbench-interventions.ts";
import type { RpcEventV0 } from "../adapters/rpc-jsonl/rpc-connection.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type {
	EndoInterventionAuthorizationV0,
	EndoInterventionConsumptionV0,
	EndoInterventionOperationV0,
	EndoInterventionProposalV0,
	EndoInterventionRefusalReasonV0,
} from "../protocol/intervention.ts";
import type { JsonValueV0 } from "../protocol/primitives.ts";
import { type EndoWorkbenchKindV0, endoWorkbenchPayloadProblemV0 } from "../protocol/workbench.ts";
import {
	endoInterventionAuthorizationV0,
	endoInterventionMessageRefV0,
	endoInterventionProposalV0,
} from "../runtime/contracts/intervention.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

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

/**
 * A stand-in for the intervention desk, with the desk's own shape (WorkbenchDeskV0): proposals and authorizations are really built and
 * digested, and `apply` is controlled by the test, so a reply can be held back, as Pi holds an `abort` until the run is idle. The real
 * desk is exercised against a fake Pi in the integration test.
 */
export class FakeDesk implements WorkbenchDeskV0 {
	proposals = new Map<string, { proposal: EndoInterventionProposalV0; message: string | null }>();
	authorizations: EndoInterventionAuthorizationV0[] = [];
	refusals: { proposalId: string; reason: EndoInterventionRefusalReasonV0; detail: string }[] = [];
	applyCalls: string[] = [];
	requests = new Map<string, { requestId: string; outcome: { status: string } | null }>();
	admitted: Partial<Record<EndoInterventionOperationV0, string>> = {};
	finishing: (() => void)[] = [];
	consumptionResult: EndoInterventionConsumptionV0 = {
		status: "not-observed",
		reason: "this session store holds no proxy capture",
	};
	consumptionChecks = 0;
	/** Held replies, by proposal: the test releases them. */
	held = new Map<string, (result: PiInterventionApplyResultV0) => void>();
	hold = true;
	readonly session: FakeSession;
	constructor(session: FakeSession) {
		this.session = session;
	}

	propose(input: {
		operation: EndoInterventionOperationV0;
		message?: string;
		origin?: "operator-workbench";
		nonce?: string;
	}) {
		const proposal = endoInterventionProposalV0({
			schemaVersion: "endo.intervention.v0",
			origin: input.origin ?? "operator-workbench",
			operation: input.operation,
			message: input.message === undefined ? null : endoInterventionMessageRefV0(OTHER_KEY, input.message),
			session: `endo.session.pi.${this.session.piSessionId}`,
			attachment: "pi.default",
			basis: { observationId: null, interpretationId: null },
			nonce: input.nonce ?? "n",
		});
		this.proposals.set(proposal.proposalId, { proposal, message: input.message ?? null });
		return proposal;
	}
	authorize(proposalId: string, provider: Parameters<WorkbenchDeskV0["authorize"]>[1]) {
		const found = this.proposals.get(proposalId);
		if (found === undefined) throw new TypeError("no proposal");
		const authorization = endoInterventionAuthorizationV0(found.proposal, provider, `a${this.authorizations.length}`);
		this.authorizations.push(authorization);
		return authorization;
	}
	apply(proposalId: string, _authorizationId: string): Promise<PiInterventionApplyResultV0> {
		this.applyCalls.push(proposalId);
		const requestId = `endo.evidence.intervention.request.${proposalId.slice(-16)}`;
		this.requests.set(proposalId, { requestId, outcome: null });
		const finish = (result: PiInterventionApplyResultV0) => {
			if (result.status === "accepted") this.requests.get(proposalId)!.outcome = { status: "accepted" };
			else if (result.status === "refused") this.requests.get(proposalId)!.outcome = { status: "refused" };
			return result;
		};
		if (!this.hold) return Promise.resolve(finish({ status: "accepted", requestId, disposition: "queued" }));
		return new Promise((resolve) => this.held.set(proposalId, (result) => resolve(finish(result))));
	}
	release(proposalId: string, result?: PiInterventionApplyResultV0): void {
		const requestId = this.requests.get(proposalId)!.requestId;
		this.held.get(proposalId)!(result ?? { status: "accepted", requestId, disposition: "queued" });
	}
	refuse(proposalId: string, reason: EndoInterventionRefusalReasonV0, detail: string): void {
		this.refusals.push({ proposalId, reason, detail });
	}
	requestOf(proposalId: string) {
		return this.requests.get(proposalId) ?? null;
	}
	consumption(): EndoInterventionConsumptionV0 {
		this.consumptionChecks += 1;
		return this.consumptionResult;
	}
	admissionFor(operation: EndoInterventionOperationV0) {
		const why = this.admitted[operation];
		return why === undefined ? ({ admitted: true } as const) : ({ admitted: false, reason: why } as const);
	}
	onFinishing(listener: () => void): void {
		this.finishing.push(listener);
	}
	finish(): void {
		for (const listener of this.finishing) listener();
	}
}
