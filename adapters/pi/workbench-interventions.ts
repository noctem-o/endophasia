// STEER, QUEUE and STOP through the workbench broker (adapters/pi/workbench.ts), onto the EXISTING intervention chain
// (protocol/intervention.ts, adapters/pi/intervention.ts): proposal → authorization → request → acceptance | refusal → consumption →
// consequence. This module adds no competing control path. It is the broker's way of driving the desk, and nothing else:
//
//   propose    the page REQUESTS an operation. The desk records the proposal; nothing is sent.
//   approve    the operator types the exact phrase on the attached process's CONTROLLING TERMINAL (the broker's `approver`). A page cannot.
//   authorize  the desk records the decision, bound to the proposal's digest, the session and the attachment (local operator authority).
//   apply      the desk's gate runs (session, attachment, expiry, admitted capability, live, an open run) and only then sends.
//
// A new prompt is NOT an intervention and keeps its own chain in the broker. The two never share a record.
//
// Facts the view keeps apart, and never merges:
//   requested ≠ approved ≠ sent ≠ runtime-accepted ≠ observed-consumed ≠ any effect.
//   Acceptance is Pi's reply. Consumption is proxy evidence that a later model request carried the message ONE MORE TIME, and it is
//   checked only when the operator asks (it reads the capture) or when the session closes (`desk.finish`). The run's end is what Pi
//   reported, and it is never attributed to a STOP.
//
// Concurrency. The terminal is one readline: ONE approval waits at a time across the prompt and the interventions. A second STEER or
// QUEUE is refused while one waits (the operator can withdraw the first on the page, or press Enter in the terminal to decline it).
// A STOP is different, because it is time-sensitive: requested while a STEER or QUEUE still awaits its approval, it SUPERSEDES that
// request. The order is fixed and every step is a precondition of the next: the STOP's proposal is recorded first (if that fails,
// nothing is disturbed); then the pending request is marked superseded and its terminal question is aborted; the STOP asks its question
// only after the superseded request has fully settled, so there is never a second question on the terminal; and whatever the operator
// typed for the superseded request, even in the same instant, is discarded, never recorded as an approval. The STOP then needs its OWN
// approval, the exact phrase for STOP, like any other. Only a request still awaiting approval can be superseded: one that was approved
// and is waiting for Pi is left alone. A request that was approved and is waiting for Pi does not hold the slot, so an `abort` Pi
// answers only once idle never blocks a status read or a withdrawal. At most one STOP is in flight, and a duplicate STOP returns it.
// A pending PROMPT approval is not superseded (a prompt needs an idle session; STOP needs an open run), and still holds the terminal. The broker calls the desk directly, beside the control
// socket: `propose` and `authorize` are synchronous, and `apply` is guarded by the desk's own in-flight map, so the two callers cannot
// interleave inside a step.
//
// Evidence checks. `check` starts a bounded, cooperative scan of the recording proxy's capture and returns at once; the page polls the
// request's view. The scan runs in slices (a fixed number of requests and body bytes each) through the desk's resumable scan, yielding
// to the event loop between slices, so a status read, a withdrawal or a STOP is served while a long capture is read. Work is bounded
// per check (bytes, requests, wall time), per proposal (one check at a time, and a cooldown after it), and overall (a few checks at once).
// A check that stops for any reason other than finding or exhausting the capture is INCOMPLETE: it establishes nothing, and in
// particular it never says the model did not receive the message. Only the desk records `intervention.consumed`, only when the capture
// shows the increase, and only once.
//
// Privacy. The message of a STEER or QUEUE is written to the desk's keyed blob store (`<root>/interventions/`) before it is approved,
// exactly as `endo steer` does, because the gate re-verifies it at the moment of sending. It is therefore retained even if the
// operator declines it. It never enters canonical evidence, and the view carries its length and digest prefix, never its text.

import type {
	EndoInterventionAuthorizationV0,
	EndoInterventionConsumptionV0,
	EndoInterventionOperationV0,
	EndoInterventionProposalV0,
	EndoInterventionRefusalReasonV0,
} from "../../protocol/intervention.ts";
import { type EndoConsumptionSliceLimitsV0, localOperatorAuthorityV0 } from "../../runtime/contracts/intervention.ts";
import type { RpcEventV0 } from "../rpc-jsonl/rpc-connection.ts";
import type { PiConsumptionStepV0, PiInterventionApplyResultV0 } from "./intervention.ts";
import type { WorkbenchApproverV0, WorkbenchSessionV0 } from "./workbench.ts";

/** What the broker needs of the intervention desk (PiInterventionDeskV0 satisfies it). */
export interface WorkbenchDeskV0 {
	propose(input: {
		operation: EndoInterventionOperationV0;
		message?: string;
		origin?: "operator-workbench";
		nonce?: string;
	}): EndoInterventionProposalV0;
	authorize(
		proposalId: string,
		provider: ReturnType<typeof localOperatorAuthorityV0>,
	): EndoInterventionAuthorizationV0;
	apply(proposalId: string, authorizationId: string): Promise<PiInterventionApplyResultV0>;
	refuse(proposalId: string, reason: EndoInterventionRefusalReasonV0, detail: string): void;
	requestOf(proposalId: string): { requestId: string; outcome: { status: string } | null } | null;
	/** One bounded slice of the evidence check (the desk keeps the scan's place per proposal). */
	consumptionStep(
		proposalId: string,
		limits: EndoConsumptionSliceLimitsV0,
		options?: { fresh?: boolean },
	): PiConsumptionStepV0;
	admissionFor(operation: EndoInterventionOperationV0): { admitted: true } | { admitted: false; reason: string };
	onFinishing(listener: () => void): void;
}

/** Why the page was told a request is not sent, beyond the gate's own reasons. */
export type WorkbenchInterventionReasonV0 =
	| EndoInterventionRefusalReasonV0
	| "approval-timed-out"
	| "withdrawn"
	/** A STOP was requested while this still awaited its approval, so it was cancelled unapproved (recorded as not authorized, with that detail). */
	| "superseded-by-stop";

/**
 * The work an explicit evidence check may do. All numbers are upper bounds the tests hold the broker to; none is a claim about
 * how fast a given machine reads. A slice is the most the event loop is held for, apart from one body (at most `maxBodyBytes`).
 */
export const WORKBENCH_EVIDENCE_BUDGET_V0 = {
	sliceBytes: 1024 * 1024,
	sliceRequests: 64,
	maxBodyBytes: 32 * 1024 * 1024,
	checkBytes: 256 * 1024 * 1024,
	checkRequests: 20_000,
	checkMs: 10_000,
	cooldownMs: 5_000,
	concurrent: 2,
} as const;
export type WorkbenchEvidenceBudgetV0 = { -readonly [K in keyof typeof WORKBENCH_EVIDENCE_BUDGET_V0]: number };

/** What the page is told of an evidence check. `checking` and `incomplete` establish nothing about the message. */
export type WorkbenchConsumptionV0 =
	| EndoInterventionConsumptionV0
	| { status: "checking"; scanned: { requests: number; bytes: number }; total: number }
	| {
			status: "incomplete";
			reason: string;
			scanned: { requests: number; bytes: number };
			total: number;
			/** The earliest time another check will do new work (the broker's clock); until then it returns this answer. */
			retryAtMs: number;
	  };

/**
 * `awaiting-approval` → `dispatching` (approved, the gate and the send) → `sent` (the request was written; Pi has not replied) →
 * `accepted`, or `refused` (nothing was sent, or Pi refused), or `unknown` (written, and the reply was lost or odd: it may have taken effect).
 */
export type WorkbenchInterventionStateV0 =
	| "awaiting-approval"
	| "dispatching"
	| "sent"
	| "accepted"
	| "refused"
	| "unknown";

/** How a run ended, as the runtime reported it (its last assistant message's stop reason at `agent_settled`). */
export type WorkbenchRunEndingV0 = "completed" | "aborted" | "failed" | "unclassified";

export interface WorkbenchInterventionViewV0 {
	proposalId: string;
	operation: EndoInterventionOperationV0;
	state: WorkbenchInterventionStateV0;
	/** Whether the operator typed the approval on the terminal. */
	approved: boolean;
	reason: WorkbenchInterventionReasonV0 | null;
	/** The runtime's disposition, when it accepted (STOP has none). Acceptance is not consumption and not an effect. */
	disposition: string | null;
	/** The message's length, or null for STOP. Never its text. */
	bytes: number | null;
	/** The first 16 hex characters of the digest the operator's phrase carries. */
	digestPrefix: string;
	expiresAtMs: number;
	/** The transcript position when it was requested, so the page can place it in the conversation. */
	afterSeq: number;
	/** The run the request was made in ended, and how the runtime reported it. Not a claim that this request caused it. */
	runEnded: WorkbenchRunEndingV0 | null;
	/** Null until the operator asked for the check; the session's close checks it too. */
	consumption: WorkbenchConsumptionV0 | null;
}

interface Command {
	view: WorkbenchInterventionViewV0;
	proposal: EndoInterventionProposalV0;
	message: string | null;
	grant: string;
	session: string;
	/** The run (by the broker's own count) the request was made in. */
	run: number;
	abort: AbortController;
	done: Promise<void>;
	/** Set when a STOP supersedes this request while it awaits approval: whatever the terminal answers is then discarded. */
	superseded: boolean;
	/** The request this STOP superseded, or null. The STOP asks its question only after that one has settled. */
	supersedes: Command | null;
	/** The evidence check in flight for this request, and the earliest time another does new work. */
	check: { abort: AbortController; done: Promise<void> } | null;
	cooldownUntilMs: number;
	/** What the desk's scan had read at the end of the last check, to count the next one's own work. */
	lastScanned: { requests: number; bytes: number };
}

/** What the manager needs of the broker. */
export interface InterventionHostV0 {
	session: WorkbenchSessionV0;
	desk: WorkbenchDeskV0;
	approver: WorkbenchApproverV0;
	launchId: string;
	now(): number;
	approvalWindowMs: number;
	/** The grant is current (not revoked, expired or replaced) and the broker is serving. */
	granted(grant: string | null): boolean;
	/** The broker has ended, been disposed or is closing: nothing more is taken or sent. */
	closed(): boolean;
	/** The text of the safe-prompt rule: the operator reads it on a terminal. */
	unsafe(message: string): boolean;
	/** The transcript's current watermark. */
	watermark(): number;
	/** A prompt is waiting for the terminal. */
	promptAwaitingApproval(): boolean;
	maxMessageBytes: number;
	/** Where an evidence check gives the event loop back between slices. Default: the next turn of the loop (`setImmediate`). */
	yieldToLoop?(): Promise<void>;
	evidenceBudget?: Partial<WorkbenchEvidenceBudgetV0>;
}

/** The reason a superseded request's question is aborted with, so the terminal can say why it was cancelled. */
export const SUPERSEDED = "superseded-by-stop";
const OPERATIONS: readonly EndoInterventionOperationV0[] = ["steer", "queue", "stop"];
const KEEP = 40;
const OPEN: readonly WorkbenchInterventionStateV0[] = ["awaiting-approval", "dispatching", "sent"];
const reply = (status: number, body: unknown) => ({ status, body });
const refuse = (status: number, error: string) => reply(status, { error });

export class WorkbenchInterventionsV0 {
	readonly #h: InterventionHostV0;
	readonly #commands = new Map<string, Command>();
	#counter = 0;
	#closing = false;
	#checksRunning = 0;
	readonly #budget: WorkbenchEvidenceBudgetV0;
	/** The broker's own count of runs, from the live events it sees (a start with none open), and what the open one has reported. */
	#runCount = 0;
	#runOpen = false;
	#lastStopReason: string | null = null;
	/** The retry loop gave up in the open run (`auto_retry_end` with `success: false`): a failure whatever the last message said. */
	#retryExhausted = false;

	constructor(host: InterventionHostV0) {
		this.#h = host;
		this.#budget = { ...WORKBENCH_EVIDENCE_BUDGET_V0, ...host.evidenceBudget };
		host.desk.onFinishing(() => this.beginClose());
	}

	// --- lifecycle -----------------------------------------------------------------------------------------------------------

	/** Refuse anything new and withdraw what waits for the terminal. Idempotent. Applies already sent are left to finish. */
	beginClose(): void {
		this.#closing = true;
		for (const c of this.#commands.values()) {
			if (c.view.state === "awaiting-approval") c.abort.abort();
			// An evidence check stops at its next slice; the desk's own close-time check then records what the capture shows.
			c.check?.abort.abort();
		}
	}

	/** Wait, bounded, for the commands still in flight; a STOP Pi has not answered must not hold the process. */
	async settle(ms: number): Promise<void> {
		const flying = [...this.#commands.values()].flatMap((c) => [
			c.done.catch(() => {}),
			(c.check?.done ?? Promise.resolve()).catch(() => {}),
		]);
		if (flying.length === 0) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.all(flying),
				new Promise<void>((done) => {
					timer = setTimeout(done, ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** Every live runtime event, after the transcript has it: it is how a run's end is seen without reading the store. */
	observe(event: RpcEventV0): void {
		if (event.type === "agent_start") {
			if (!this.#runOpen) {
				this.#runCount += 1;
				this.#runOpen = true;
				this.#lastStopReason = null;
				this.#retryExhausted = false;
			}
			return;
		}
		if (event.type === "message_end") {
			const message = event.record.message as { role?: unknown; stopReason?: unknown } | undefined;
			if (message?.role === "assistant" && typeof message.stopReason === "string")
				this.#lastStopReason = message.stopReason.slice(0, 32);
			return;
		}
		if (event.type === "auto_retry_end") {
			if (event.record.success === false) this.#retryExhausted = true;
			return;
		}
		if (event.type !== "agent_settled" || !this.#runOpen) return;
		// The same precedence as the recorded lifecycle (adapters/pi/lifecycle.ts): retry exhausted or an error is a failure, then an abort,
		// then no stop reason at all is unclassified, and only a reported other stop reason is a completion.
		const ending: WorkbenchRunEndingV0 =
			this.#retryExhausted || this.#lastStopReason === "error"
				? "failed"
				: this.#lastStopReason === "aborted"
					? "aborted"
					: this.#lastStopReason === null
						? "unclassified"
						: "completed";
		for (const c of this.#commands.values())
			if (c.run === this.#runCount && c.view.runEnded === null && c.view.approved && c.view.state !== "refused")
				c.view = { ...c.view, runEnded: ending };
		this.#runOpen = false;
		this.#lastStopReason = null;
		this.#retryExhausted = false;
	}

	// --- what is offered ------------------------------------------------------------------------------------------------------

	/** Whether the operator can be asked about a new request now: the terminal has one question at a time. */
	approvalBusy(): boolean {
		return (
			this.#h.promptAwaitingApproval() ||
			[...this.#commands.values()].some((c) => c.view.state === "awaiting-approval")
		);
	}

	/** The steer or queue still awaiting its approval, or null. There is at most one: the terminal has one question at a time. */
	#awaitingIntervention(): Command | null {
		return (
			[...this.#commands.values()].find(
				(c) => c.view.state === "awaiting-approval" && !c.superseded && c.view.operation !== "stop",
			) ?? null
		);
	}

	#stopInFlight(): Command | null {
		return (
			[...this.#commands.values()].find((c) => c.view.operation === "stop" && OPEN.includes(c.view.state)) ?? null
		);
	}

	/** Whether an operation can be requested now, and if not, why (fixed sentences; the runtime's own reason is bounded). */
	offer(operation: EndoInterventionOperationV0): { offered: boolean; reason: string | null } {
		const no = (reason: string) => ({ offered: false, reason });
		const session = this.#h.session;
		if (this.#closing || this.#h.closed()) return no("The session is closing or has ended.");
		if (!session.live || session.piSessionId === null) return no("The session has no admitted connection now.");
		if (!session.runActive)
			return no(
				"No run is open. Steer, queue and stop act on a run that is open; a new prompt starts one. A recording's last known state is never a live run.",
			);
		const admission = this.#h.desk.admissionFor(operation);
		if (!admission.admitted)
			return no(`Not admitted for this runtime by its conformance evidence: ${admission.reason.slice(0, 200)}`);
		const stop = this.#stopInFlight();
		if (stop !== null)
			return no(
				operation === "stop"
					? "A stop is already pending: Pi answers it once the run is idle."
					: "A stop is pending, so steer and queue are withheld until it is answered.",
			);
		if (this.#h.promptAwaitingApproval())
			return no(
				"A prompt is waiting for approval in the terminal. Press Enter there to decline it, or withdraw it on this page.",
			);
		// A STOP does not wait behind an unapproved steer or queue: it supersedes it (see the header).
		if (operation !== "stop" && this.#awaitingIntervention() !== null)
			return no(
				"Another request is waiting for approval in the terminal. Press Enter there to decline it, or withdraw it on this page.",
			);
		return { offered: true, reason: null };
	}

	/** Whether a prompt must wait because an intervention holds the terminal. */
	awaitingApproval(): boolean {
		return [...this.#commands.values()].some((c) => c.view.state === "awaiting-approval");
	}

	// --- views ----------------------------------------------------------------------------------------------------------------

	#view(c: Command): WorkbenchInterventionViewV0 {
		// `sent` is read from the desk: the request is recorded just before it is written, and Pi's reply has not come back.
		if (c.view.state === "dispatching" && this.#h.desk.requestOf(c.view.proposalId) !== null)
			return { ...c.view, state: "sent" };
		return c.view;
	}

	views(): WorkbenchInterventionViewV0[] {
		return [...this.#commands.values()].slice(-KEEP).map((c) => this.#view(c));
	}

	viewOf(proposalId: unknown): WorkbenchInterventionViewV0 | null {
		const c = typeof proposalId === "string" ? this.#commands.get(proposalId) : undefined;
		return c === undefined ? null : this.#view(c);
	}

	// --- requests -------------------------------------------------------------------------------------------------------------

	propose(grant: string, body: Record<string, unknown> | null): { status: number; body: unknown } {
		const keys = body === null ? "" : Object.keys(body).sort().join();
		if (
			body === null ||
			(keys !== "operation" && keys !== "message,operation") ||
			!OPERATIONS.includes(body.operation as EndoInterventionOperationV0)
		)
			return refuse(400, "bad-request");
		const operation = body.operation as EndoInterventionOperationV0;
		let message: string | null = null;
		if (operation === "stop") {
			if (keys !== "operation") return refuse(400, "bad-request");
		} else {
			if (typeof body.message !== "string") return refuse(400, "bad-request");
			message = body.message;
			if (
				message.trim().length === 0 ||
				Buffer.byteLength(message, "utf8") > this.#h.maxMessageBytes ||
				this.#h.unsafe(message)
			)
				return refuse(400, "bad-request");
		}
		// A duplicate STOP is the one already in flight, not another: the operator's second click changes nothing.
		const stop = operation === "stop" ? this.#stopInFlight() : null;
		if (stop !== null) return reply(200, this.#view(stop));
		// Everything that can be refused is refused BEFORE the desk records anything or keeps the text.
		if (!this.offer(operation).offered) return refuse(409, "not-offered");
		let proposal: EndoInterventionProposalV0;
		try {
			this.#counter += 1;
			proposal = this.#h.desk.propose({
				operation,
				...(message === null ? {} : { message }),
				origin: "operator-workbench",
				// The launch is part of what the digest covers: a proposal from another launch has another digest.
				nonce: `wb-${this.#h.launchId}-${this.#counter}`,
			});
		} catch {
			return refuse(503, "not-recording");
		}
		if (!this.#runOpen) {
			// The run began before this broker saw its start: count it, so its end is seen.
			this.#runCount += 1;
			this.#runOpen = true;
			this.#lastStopReason = null;
			this.#retryExhausted = false;
		}
		const abort = new AbortController();
		const command: Command = {
			view: {
				proposalId: proposal.proposalId,
				operation,
				state: "awaiting-approval",
				approved: false,
				reason: null,
				disposition: null,
				bytes: proposal.message === null ? null : proposal.message.bytes,
				digestPrefix: proposal.proposalDigest.slice(0, 16),
				expiresAtMs: this.#h.now() + this.#h.approvalWindowMs,
				afterSeq: this.#h.watermark(),
				runEnded: null,
				consumption: null,
			},
			proposal,
			message,
			grant,
			session: proposal.session,
			run: this.#runCount,
			abort,
			done: Promise.resolve(),
			superseded: false,
			supersedes: null,
			check: null,
			cooldownUntilMs: 0,
			lastScanned: { requests: 0, bytes: 0 },
		};
		// A STOP supersedes the steer or queue still awaiting approval. Its proposal is already recorded (above), so a failure to
		// record it left that request untouched. From here: mark it, abort its question, and make the STOP wait for it to settle.
		const victim = operation === "stop" ? this.#awaitingIntervention() : null;
		if (victim !== null) {
			victim.superseded = true;
			victim.abort.abort(SUPERSEDED);
			command.supersedes = victim;
		}
		this.#commands.set(proposal.proposalId, command);
		this.#trim();
		command.done = this.#drive(command);
		return reply(202, command.view);
	}

	discard(proposalId: unknown): { status: number; body: unknown } {
		const c = typeof proposalId === "string" ? this.#commands.get(proposalId) : undefined;
		if (c === undefined) return refuse(404, "not-found");
		if (c.view.state !== "awaiting-approval") return refuse(409, "not-withdrawable");
		c.abort.abort();
		return reply(200, this.#view(c));
	}

	/**
	 * Start (or report) a bounded evidence check for an accepted STEER or QUEUE: does the capture show the message once more? Returns at once.
	 * The answer is already known when it was observed (it is final and cached); within the cooldown after a check it is that check's answer
	 * again, and no work is done; while one runs it is the progress; and at the broker's limit of concurrent checks it is refused.
	 */
	check(proposalId: unknown): { status: number; body: unknown } {
		const c = typeof proposalId === "string" ? this.#commands.get(proposalId) : undefined;
		if (c === undefined) return refuse(404, "not-found");
		if (c.view.operation === "stop" || c.view.state !== "accepted") return refuse(409, "not-checkable");
		if (c.view.consumption?.status === "observed" || c.check !== null) return reply(200, this.#view(c));
		if (this.#closing || this.#h.closed()) return refuse(409, "closing");
		if (this.#h.now() < c.cooldownUntilMs && c.view.consumption !== null) return reply(200, this.#view(c));
		if (this.#checksRunning >= this.#budget.concurrent) return refuse(409, "check-busy");
		const abort = new AbortController();
		this.#checksRunning += 1;
		c.view = {
			...c.view,
			consumption: { status: "checking", scanned: { ...c.lastScanned }, total: 0 },
		};
		const check = { abort, done: Promise.resolve() };
		c.check = check;
		// The slot is returned however the check ends, so a fault can never leave the broker permanently "busy".
		check.done = this.#runCheck(c, abort).finally(() => {
			this.#checksRunning -= 1;
			if (c.check === check) c.check = null;
		});
		return reply(202, this.#view(c));
	}

	async #runCheck(c: Command, abort: AbortController): Promise<void> {
		const { desk } = this.#h;
		const budget = this.#budget;
		const limits: EndoConsumptionSliceLimitsV0 = {
			maxBytes: budget.sliceBytes,
			maxRequests: budget.sliceRequests,
			maxBodyBytes: budget.maxBodyBytes,
		};
		const yieldToLoop = this.#h.yieldToLoop ?? (() => new Promise<void>((done) => setImmediate(done)));
		const startedAt = this.#h.now();
		const incomplete = (
			reason: string,
			scanned: { requests: number; bytes: number },
			total: number,
		): WorkbenchConsumptionV0 => ({
			status: "incomplete",
			reason,
			scanned,
			total,
			retryAtMs: this.#h.now() + budget.cooldownMs,
		});
		let before = c.lastScanned;
		let usedBytes = 0;
		let usedRequests = 0;
		let fresh = true;
		let result: WorkbenchConsumptionV0;
		try {
			// The request that started the check is answered first: not even the first slice runs inside its handler.
			await yieldToLoop();
			for (;;) {
				if (abort.signal.aborted || this.#closing || this.#h.closed()) {
					result = incomplete(
						"the session was closing, so the check stopped; closing the session checks the capture once more",
						{ ...c.lastScanned },
						0,
					);
					break;
				}
				const step = desk.consumptionStep(c.view.proposalId, limits, { fresh });
				fresh = false;
				if (step.status !== "scanning") {
					if (step.status === "incomplete") {
						c.lastScanned = step.scanned;
						result = incomplete(step.reason, step.scanned, step.total);
					} else result = step;
					break;
				}
				// The scan's counts are cumulative over resumed checks; this check's own work is the difference. A restart resets them.
				if (step.scanned.requests < before.requests) before = { requests: 0, bytes: 0 };
				usedRequests += step.scanned.requests - before.requests;
				usedBytes += step.scanned.bytes - before.bytes;
				before = step.scanned;
				c.lastScanned = step.scanned;
				if (
					usedBytes > budget.checkBytes ||
					usedRequests > budget.checkRequests ||
					this.#h.now() - startedAt >= budget.checkMs
				) {
					result = incomplete(
						`the check's work limit was reached after ${step.scanned.requests} of ${step.total} captured requests; a later check resumes from there`,
						step.scanned,
						step.total,
					);
					break;
				}
				c.view = { ...c.view, consumption: { status: "checking", scanned: step.scanned, total: step.total } };
				await yieldToLoop();
			}
		} catch {
			result = incomplete("the evidence could not be read just now", { ...c.lastScanned }, 0);
		}
		c.view = { ...c.view, consumption: result };
		c.cooldownUntilMs = this.#h.now() + budget.cooldownMs;
		c.check = null;
	}

	#trim(): void {
		if (this.#commands.size <= KEEP * 2) return;
		for (const [id, c] of this.#commands) {
			if (this.#commands.size <= KEEP) break;
			if (!OPEN.includes(c.view.state)) this.#commands.delete(id);
		}
	}

	// --- one request, from approval to the runtime's reply ------------------------------------------------------------------

	async #drive(c: Command): Promise<void> {
		const { desk } = this.#h;
		const id = c.view.proposalId;
		const op = c.view.operation;
		const settle = (
			reason: WorkbenchInterventionReasonV0,
			detail: string,
			record: EndoInterventionRefusalReasonV0,
		): void => {
			c.message = null;
			c.view = { ...c.view, state: "refused", reason };
			try {
				desk.refuse(id, record, detail);
			} catch {
				// the store is closed: the view still says it was not sent
			}
		};
		const phrase = `APPROVE ${op.toUpperCase()} ${c.proposal.proposalDigest.slice(0, 16)}`;
		let answer: "allow" | "deny" | null = null;
		// The terminal has one question at a time: a STOP that superseded a request waits until that request has fully settled (its
		// question is aborted and released, and its refusal is recorded) before it asks its own.
		if (c.supersedes !== null) await c.supersedes.done.catch(() => {});
		const askable = !c.abort.signal.aborted && !this.#closing && !this.#h.closed();
		try {
			if (askable)
				answer = await this.#h.approver(
					{
						operation: op,
						proposalId: id,
						phrase,
						session: c.session,
						attachment: c.proposal.attachment,
						bytes: c.view.bytes ?? 0,
						message: c.message,
						expiresAtMs: c.view.expiresAtMs,
						supersedes: c.supersedes === null ? null : (c.supersedes.view.operation as "steer" | "queue"),
					},
					c.abort.signal,
				);
		} catch {
			answer = null;
		}
		c.message = null;
		// Whatever the terminal answered, a superseded request is cancelled: an approval typed in the same instant is discarded and is
		// not recorded as one, so a cancelled request is never accepted through late input.
		if (c.superseded)
			return settle(
				"superseded-by-stop",
				"superseded by a stop request before its approval was acted on",
				"not-authorized",
			);
		if (this.#h.closed() || this.#closing)
			return settle("session-ended", "the session was closing or had ended", "session-ended");
		if (answer === null) {
			return c.abort.signal.aborted
				? settle("withdrawn", "withdrawn before it was approved", "not-authorized")
				: settle("approval-timed-out", "no approval was typed in time", "not-authorized");
		}
		let authorization: EndoInterventionAuthorizationV0;
		try {
			authorization = desk.authorize(
				id,
				localOperatorAuthorityV0(answer === "allow" ? c.proposal.proposalDigest : null, "terminal-phrase"),
			);
		} catch {
			return settle("session-ended", "the decision could not be recorded", "session-ended");
		}
		if (answer === "deny")
			return settle("authorization-denied", "the operator declined it in the terminal", "authorization-denied");
		c.view = { ...c.view, approved: true };
		// What was true when it was proposed may not be now. The desk's gate checks the session, the attachment, the age of the decision,
		// the capability, the live process and the open run; the broker checks what only it knows.
		if (this.#h.now() >= c.view.expiresAtMs)
			return settle(
				"authorization-expired",
				"the approval window had passed when it was typed",
				"authorization-expired",
			);
		if (!this.#h.granted(c.grant)) return settle("not-authorized", "the page was no longer paired", "not-authorized");
		c.view = { ...c.view, state: "dispatching" };
		let result: PiInterventionApplyResultV0 | null = null;
		try {
			result = await desk.apply(id, authorization.authorizationId);
		} catch {
			result = null;
		}
		if (result === null) {
			// The desk could not finish. If the request had been written, Pi may have it: that is unknown, not "not sent".
			const sent = desk.requestOf(id) !== null;
			c.view = sent ? { ...c.view, state: "unknown" } : { ...c.view, state: "refused", reason: "session-ended" };
			return;
		}
		if (result.status === "accepted") {
			c.view = { ...c.view, state: "accepted", disposition: result.disposition };
		} else if (result.status === "refused") {
			// Refused with no request: the gate stopped it, nothing was sent. With a request: only Pi's own refusal is a refusal; a timeout,
			// a lost connection or a fault rejected a request that was already written, so its outcome is unknown.
			if (result.requestId === null || result.reason === "runtime-refused")
				c.view = { ...c.view, state: "refused", reason: result.reason };
			else c.view = { ...c.view, state: "unknown" };
		} else {
			const known = desk.requestOf(id);
			c.view = {
				...c.view,
				state:
					known?.outcome?.status === "accepted"
						? "accepted"
						: known?.outcome?.status === "refused"
							? "refused"
							: "unknown",
			};
		}
	}
}
