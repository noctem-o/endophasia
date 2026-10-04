/**
 * The intervention desk (protocol/intervention.ts) for one recorded Pi session: STEER, QUEUE and STOP as explicit,
 * authorized and verified interventions, through the session attachment's gated controls (Pi's documented `steer`,
 * `follow_up` and `abort`) only.
 *
 *   propose()    records a proposal; the message text goes to a keyed blob store beside the session store
 *                (`<root>/interventions/`), referenced by its keyed digest, never into canonical evidence
 *   authorize()  records an authority's decision on the proposal's exact digest, session and attachment
 *   apply()      runs the gate (runtime/contracts/intervention.ts); a refusal is recorded with its reason and nothing
 *                is sent; otherwise records the request, sends it, and records Pi's acceptance or refusal. Applying a
 *                proposal that was already sent returns the recorded request and records nothing (idempotent)
 *   finish()     for every request: records consumption if, and only if, the session store's proxy capture
 *                (`<root>/capture/`) shows the message in a later model request; then the consequence (acceptance,
 *                consumption, effect) once
 *   status()     every chain, as recorded
 *
 * The desk's state is rebuilt from the store on construction, so a reattached session continues the same chains.
 */

import { join } from "node:path";
import type { EndoEventV0 } from "../../protocol/event.ts";
import {
	ENDO_INTERVENTION_SCHEMA_V0,
	type EndoInterventionAuthorizationV0,
	type EndoInterventionConsequenceV0,
	type EndoInterventionConsumptionV0,
	type EndoInterventionOperationV0,
	type EndoInterventionOriginV0,
	type EndoInterventionPointV0,
	type EndoInterventionProposalV0,
	type EndoInterventionRefusalReasonV0,
} from "../../protocol/intervention.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	type EndoInterventionAuthorityProviderV0,
	type EndoInterventionCaptureSourceV0,
	endoFindConsumptionV0,
	endoInterventionAuthorizationV0,
	endoInterventionGateV0,
	endoInterventionMessageRefV0,
	endoInterventionProposalV0,
	PI_INTERVENTION_CAPABILITIES_V0,
} from "../../runtime/contracts/intervention.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../runtime/contracts/keyed-digest.ts";
import { createEndoBlobStoreV0, type EndoBlobStoreV0 } from "../../storage/blob-store.ts";
import type { PiSessionAttachmentV0 } from "./attachment.ts";
import { piEndoSessionIdV0 } from "./mapping.ts";
import { PiRpcRefusalV0 } from "./rpc.ts";

export type PiInterventionApplyResultV0 =
	| { status: "accepted"; requestId: string; disposition: string | null }
	| { status: "refused"; requestId: string | null; reason: EndoInterventionRefusalReasonV0; detail: string }
	| { status: "duplicate"; requestId: string; outcome: "accepted" | "refused" | "pending" };

interface RequestStateV0 {
	request: {
		requestId: string;
		proposalId: string;
		operation: EndoInterventionOperationV0;
		at: EndoInterventionPointV0 | null;
	};
	eventId: string;
	sequence: number;
	/** When the request was recorded (ISO-8601), to place it among captured requests when no proxy point is known. */
	recordedAt: string;
	outcome: { status: "accepted"; disposition: string | null } | { status: "refused"; reason: string } | null;
	/** The ids of the acceptance and consumption records, so the consequence can derive from them. */
	acceptedEventId: string | null;
	consumedEventId: string | null;
	consumedEvent: string | null;
	consumedExchange: number | null;
	consequence: boolean;
}

const record = (value: unknown) => value as Record<string, JsonValueV0>;

export class PiInterventionDeskV0 {
	readonly session: PiSessionAttachmentV0;
	readonly key: EndoDigestKeyV0;
	readonly #root: string;
	readonly #messages: EndoBlobStoreV0;
	readonly #proposals = new Map<string, { proposal: EndoInterventionProposalV0; eventId: string }>();
	readonly #authorizations = new Map<string, { authorization: EndoInterventionAuthorizationV0; eventId: string }>();
	readonly #requests = new Map<string, RequestStateV0>();
	/** Applies in flight, by proposal: a concurrent duplicate waits for the first instead of sending twice. */
	readonly #inFlight = new Map<string, Promise<PiInterventionApplyResultV0>>();

	readonly #capture: EndoInterventionCaptureSourceV0 | null;

	/** `capture`: where the recording proxy's captured requests are read from; without it consumption is never observed. */
	constructor(
		session: PiSessionAttachmentV0,
		key: EndoDigestKeyV0,
		capture: EndoInterventionCaptureSourceV0 | null = null,
	) {
		this.session = session;
		this.#capture = capture;
		this.key = key;
		this.#root = session.owner.options.root;
		this.#messages = createEndoBlobStoreV0(join(this.#root, "interventions"), key);
		let after = 0;
		for (;;) {
			const page = session.store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			for (const event of page.events) this.#index(event);
			after = page.nextAfterSequence;
		}
	}

	#index(event: EndoEventV0): void {
		if (!event.kind.startsWith("intervention.")) return;
		const p = event.payload as Record<string, unknown>;
		switch (event.kind) {
			case "intervention.proposal":
				this.#proposals.set(p.proposalId as string, {
					proposal: p as unknown as EndoInterventionProposalV0,
					eventId: event.id,
				});
				break;
			case "intervention.authorization":
				this.#authorizations.set(p.authorizationId as string, {
					authorization: p as unknown as EndoInterventionAuthorizationV0,
					eventId: event.id,
				});
				break;
			case "intervention.request":
				this.#requests.set(p.proposalId as string, {
					request: p as unknown as RequestStateV0["request"],
					eventId: event.id,
					sequence: event.sequence,
					recordedAt: event.at,
					outcome: null,
					acceptedEventId: null,
					consumedEventId: null,
					consumedEvent: null,
					consumedExchange: null,
					consequence: false,
				});
				break;
			case "intervention.accepted":
			case "intervention.consumed":
			case "intervention.consequence": {
				const state = [...this.#requests.values()].find((entry) => entry.request.requestId === p.requestId);
				if (state === undefined) break;
				if (event.kind === "intervention.accepted") {
					state.outcome = { status: "accepted", disposition: (p.disposition as string | null) ?? null };
					state.acceptedEventId = event.id;
				} else if (event.kind === "intervention.consumed") {
					state.consumedEventId = event.id;
					state.consumedEvent = p.captureEvent as string;
					state.consumedExchange = p.exchange as number;
				} else state.consequence = true;
				break;
			}
			case "intervention.refused": {
				const state = this.#requests.get(p.proposalId as string);
				if (state !== undefined && p.requestId === state.request.requestId)
					state.outcome = { status: "refused", reason: p.reason as string };
				break;
			}
		}
	}

	#record(
		kind: Parameters<PiSessionAttachmentV0["recordIntervention"]>[0],
		payload: unknown,
		from: string[],
	): EndoEventV0 {
		const event = this.session.recordIntervention(kind, record(payload), from);
		this.#index(event);
		return event;
	}

	/** The endo session coordinate of the current Pi session. */
	get currentSession(): string {
		const id = this.session.piSessionId;
		if (id === null) throw new TypeError("the session has no Pi session id yet");
		return piEndoSessionIdV0(id);
	}

	/** Record a proposal. The message is required for steer and queue, and absent for stop. */
	propose(input: {
		operation: EndoInterventionOperationV0;
		message?: string;
		origin?: EndoInterventionOriginV0;
		basis?: { observationId: string | null; interpretationId: string | null };
		nonce?: string;
	}): EndoInterventionProposalV0 {
		if (input.operation === "stop" ? input.message !== undefined : input.message === undefined)
			throw new TypeError(
				input.operation === "stop" ? "stop carries no message" : `${input.operation} needs a message`,
			);
		let message: EndoInterventionProposalV0["message"] = null;
		if (input.message !== undefined) {
			message = endoInterventionMessageRefV0(this.key, input.message);
			this.#messages.put(Buffer.from(input.message, "utf8"));
		}
		const proposal = endoInterventionProposalV0({
			schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
			origin: input.origin ?? "operator-cli",
			operation: input.operation,
			message,
			session: this.currentSession,
			attachment: this.session.owner.attachment,
			basis: input.basis ?? { observationId: null, interpretationId: null },
			nonce: input.nonce ?? sha256HexV0(`${Date.now()}-${Math.random()}`).slice(0, 16),
		});
		const existing = this.#proposals.get(proposal.proposalId);
		if (existing !== undefined) return existing.proposal;
		const from = [proposal.basis.interpretationId, proposal.basis.observationId].filter(
			(id): id is string => id !== null,
		);
		this.#record("intervention.proposal", proposal, this.#eventIdsFor(from));
		return proposal;
	}

	#eventIdsFor(recordIds: string[]): string[] {
		const ids: string[] = [];
		let after = 0;
		if (recordIds.length === 0) return ids;
		for (;;) {
			const page = this.session.store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			for (const event of page.events) {
				const p = event.payload as Record<string, unknown>;
				if (recordIds.includes(p?.observationId as string) && event.kind === "intervention.observation")
					ids.push(event.id);
				if (recordIds.includes(p?.interpretationId as string) && event.kind === "intervention.interpretation")
					ids.push(event.id);
			}
			after = page.nextAfterSequence;
		}
		return ids;
	}

	proposal(proposalId: string): EndoInterventionProposalV0 | null {
		return this.#proposals.get(proposalId)?.proposal ?? null;
	}

	/** Record an authority's decision on a recorded proposal. */
	authorize(proposalId: string, provider: EndoInterventionAuthorityProviderV0): EndoInterventionAuthorizationV0 {
		const found = this.#proposals.get(proposalId);
		if (found === undefined) throw new TypeError(`no proposal ${proposalId} is recorded in this session`);
		const authorization = endoInterventionAuthorizationV0(
			found.proposal,
			provider,
			sha256HexV0(`${Date.now()}-${Math.random()}`).slice(0, 16),
		);
		this.#record("intervention.authorization", authorization, [found.eventId]);
		return authorization;
	}

	#messageText(proposal: EndoInterventionProposalV0): { text: string | null; verified: boolean | null } {
		if (proposal.message === null) return { text: null, verified: null };
		try {
			const bytes = this.#messages.get(proposal.message.digest as EndoKeyedDigestV0);
			return { text: Buffer.from(bytes).toString("utf8"), verified: bytes.length === proposal.message.bytes };
		} catch {
			return { text: null, verified: false };
		}
	}

	/**
	 * Apply an authorized proposal: the gate, then the request, then Pi's reply. `at` is the recording proxy's delivery
	 * point at the moment of sending, when one is attached.
	 */
	apply(
		proposalId: string,
		authorizationId: string,
		at: EndoInterventionPointV0 | null = null,
	): Promise<PiInterventionApplyResultV0> {
		const pending = this.#inFlight.get(proposalId);
		if (pending !== undefined)
			return pending.then((result) => ({
				status: "duplicate" as const,
				requestId: result.status === "refused" ? (result.requestId ?? "") : result.requestId,
				outcome:
					result.status === "accepted" ? "accepted" : result.status === "refused" ? "refused" : result.outcome,
			}));
		const run = this.#apply(proposalId, authorizationId, at).finally(() => this.#inFlight.delete(proposalId));
		this.#inFlight.set(proposalId, run);
		return run;
	}

	async #apply(
		proposalId: string,
		authorizationId: string,
		at: EndoInterventionPointV0 | null,
	): Promise<PiInterventionApplyResultV0> {
		const sent = this.#requests.get(proposalId);
		if (sent !== undefined)
			return { status: "duplicate", requestId: sent.request.requestId, outcome: sent.outcome?.status ?? "pending" };
		const found = this.#proposals.get(proposalId);
		if (found === undefined) throw new TypeError(`no proposal ${proposalId} is recorded in this session`);
		const { proposal } = found;
		const authorization = this.#authorizations.get(authorizationId) ?? null;
		const message = this.#messageText(proposal);
		const capability = PI_INTERVENTION_CAPABILITIES_V0[proposal.operation];
		let currentSession: string;
		try {
			currentSession = this.currentSession;
		} catch {
			currentSession = "endo.session.none";
		}
		const gate = endoInterventionGateV0({
			proposal,
			authorization: authorization?.authorization ?? null,
			messageVerified: message.verified,
			currentSession,
			currentAttachment: this.session.owner.attachment,
			capability: this.session.admission(capability),
			sessionLive: this.session.live,
			runActive: this.session.runActive,
		});
		const from = [found.eventId, ...(authorization === null ? [] : [authorization.eventId])];
		if (!gate.ok) {
			this.#record(
				"intervention.refused",
				{
					schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
					proposalId,
					requestId: null,
					reason: gate.reason,
					detail: gate.detail,
				},
				from,
			);
			return { status: "refused", requestId: null, reason: gate.reason, detail: gate.detail };
		}
		const request = {
			schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
			requestId: `endo.evidence.intervention.request.${sha256HexV0(canonicalEndoJsonV0({ proposalId, authorizationId }))}`,
			proposalId,
			authorizationId,
			operation: proposal.operation,
			capability,
			at,
		};
		const requestEvent = this.#record("intervention.request", request, [authorization!.eventId]);
		try {
			const reply =
				proposal.operation === "steer"
					? await this.session.steer(message.text!)
					: proposal.operation === "queue"
						? await this.session.followUp(message.text!)
						: await this.session.stop();
			const disposition = typeof reply === "string" ? reply : null;
			this.#record(
				"intervention.accepted",
				{ schemaVersion: ENDO_INTERVENTION_SCHEMA_V0, requestId: request.requestId, disposition },
				[requestEvent.id],
			);
			return { status: "accepted", requestId: request.requestId, disposition };
		} catch (error) {
			const reason = error instanceof PiRpcRefusalV0 ? "runtime-refused" : "runtime-failed";
			const detail = String((error as Error).message ?? error).slice(0, 500);
			this.#record(
				"intervention.refused",
				{ schemaVersion: ENDO_INTERVENTION_SCHEMA_V0, proposalId, requestId: request.requestId, reason, detail },
				[requestEvent.id],
			);
			return { status: "refused", requestId: request.requestId, reason, detail };
		}
	}

	#consumption(state: RequestStateV0): EndoInterventionConsumptionV0 {
		const proposal = this.#proposals.get(state.request.proposalId)!.proposal;
		if (proposal.message === null) return { status: "not-applicable", reason: "stop carries no message to consume" };
		if (state.outcome?.status !== "accepted")
			return { status: "not-applicable", reason: "the request was not accepted" };
		if (state.consumedEvent !== null && state.consumedExchange !== null)
			return { status: "observed", exchange: state.consumedExchange, captureEvent: state.consumedEvent };
		const requests = this.#capture?.requests() ?? null;
		if (requests === null) return { status: "not-observed", reason: "this session store holds no proxy capture" };
		// With the proxy's delivery point, the message can first appear in the next exchange; without one, in the first
		// exchange captured after the request was recorded.
		const from =
			state.request.at !== null
				? state.request.at.exchange + 1
				: (requests.find((request) => request.at >= state.recordedAt)?.exchange ?? Number.POSITIVE_INFINITY);
		const found = endoFindConsumptionV0(requests, proposal.message, this.key, from);
		if (found === null)
			return {
				status: "not-observed",
				reason: `no captured request from exchange ${from} on carries the message (${requests.length} captured)`,
			};
		this.#record(
			"intervention.consumed",
			{
				schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
				requestId: state.request.requestId,
				exchange: found.exchange,
				captureEvent: found.captureEvent,
				message: proposal.message,
			},
			[state.eventId],
		);
		return { status: "observed", exchange: found.exchange, captureEvent: found.captureEvent };
	}

	/** What the store shows after a request: runs that ended and how, turns, and tool calls. */
	#effect(state: RequestStateV0): EndoInterventionConsequenceV0["effect"] {
		let runsEndedAfter = 0;
		let lastRunEnding: string | null = null;
		let turnsAfter = 0;
		let toolCallsAfter = 0;
		let after = state.sequence;
		for (;;) {
			const page = this.session.store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			for (const event of page.events) {
				if (
					[
						"lifecycle.run-completed",
						"lifecycle.run-aborted",
						"lifecycle.run-failed",
						"lifecycle.run-unclassified",
					].includes(event.kind)
				) {
					runsEndedAfter += 1;
					lastRunEnding = event.kind.slice("lifecycle.run-".length);
				} else if (event.kind === "lifecycle.turn-completed") turnsAfter += 1;
				else if (event.kind === "tool.started") toolCallsAfter += 1;
			}
			after = page.nextAfterSequence;
		}
		return { runsEndedAfter, lastRunEnding, turnsAfter, toolCallsAfter };
	}

	/**
	 * For every request: consumption (recorded only when the capture shows it), then the consequence, once. Call when
	 * the session's work has settled and the recording proxy has flushed, before the session closes.
	 */
	finish(): void {
		for (const state of this.#requests.values()) {
			if (state.consequence) continue;
			const consumption = this.#consumption(state);
			const consequence: EndoInterventionConsequenceV0 = {
				schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
				requestId: state.request.requestId,
				acceptance:
					state.outcome?.status === "accepted"
						? { status: "accepted", disposition: state.outcome.disposition }
						: {
								status: "refused",
								reason: state.outcome?.status === "refused" ? state.outcome.reason : "no reply recorded",
							},
				consumption,
				effect: this.#effect(state),
			};
			// The consequence weighs acceptance against consumption, so it derives from the request and from both.
			this.#record(
				"intervention.consequence",
				consequence,
				[state.eventId, state.acceptedEventId, state.consumedEventId].filter((id): id is string => id !== null),
			);
		}
	}

	/** Every chain as recorded: proposals, their authorizations, requests and outcomes. */
	status(): JsonValueV0 {
		// What is offered: an operation only if Pi's capability for it is admitted by conformance evidence; otherwise it is
		// UNAVAILABLE, with the reason. The gate refuses it again at apply, whatever a client does.
		const operations = Object.fromEntries(
			(Object.keys(PI_INTERVENTION_CAPABILITIES_V0) as EndoInterventionOperationV0[]).map((operation) => {
				const capability = PI_INTERVENTION_CAPABILITIES_V0[operation];
				const admission = this.session.admission(capability);
				return [
					operation,
					admission.admitted
						? { capability, status: "admitted" }
						: { capability, status: "UNAVAILABLE", reason: admission.reason },
				];
			}),
		);
		return record({
			session: this.session.piSessionId === null ? null : this.currentSession,
			live: this.session.live,
			runActive: this.session.runActive,
			operations,
			proposals: [...this.#proposals.values()].map(({ proposal }) => {
				const state = this.#requests.get(proposal.proposalId);
				return {
					proposalId: proposal.proposalId,
					proposalDigest: proposal.proposalDigest,
					operation: proposal.operation,
					origin: proposal.origin,
					authorizations: [...this.#authorizations.values()]
						.filter(({ authorization }) => authorization.proposalId === proposal.proposalId)
						.map(({ authorization }) => ({
							authorizationId: authorization.authorizationId,
							decision: authorization.decision,
							authority: authorization.authority,
						})),
					request:
						state === undefined
							? null
							: {
									requestId: state.request.requestId,
									at: state.request.at,
									outcome: state.outcome,
									consumed: state.consumedExchange === null ? null : { exchange: state.consumedExchange },
									consequenceRecorded: state.consequence,
								},
				};
			}),
		});
	}
}
