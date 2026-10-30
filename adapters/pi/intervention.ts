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
	ENDO_INTERVENTION_AUTHORIZATION_MAX_AGE_MS_V0,
	type EndoCaptureSnapshotV0,
	type EndoConsumptionScanV0,
	type EndoConsumptionSliceLimitsV0,
	type EndoInterventionAuthorityProviderV0,
	type EndoInterventionCaptureSourceV0,
	endoInterventionAuthorizationV0,
	endoInterventionGateV0,
	endoInterventionMessageRefV0,
	endoInterventionProposalV0,
	endoNewConsumptionScanV0,
	endoSliceConsumptionV0,
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

/** What one slice of an explicit consumption check says. Only `observed` is recorded; nothing else is ever a finding. */
export type PiConsumptionStepV0 =
	| EndoInterventionConsumptionV0
	| { status: "scanning"; scanned: { requests: number; bytes: number }; total: number }
	| { status: "incomplete"; reason: string; scanned: { requests: number; bytes: number }; total: number };

export class PiInterventionDeskV0 {
	readonly session: PiSessionAttachmentV0;
	readonly key: EndoDigestKeyV0;
	readonly #root: string;
	readonly #messages: EndoBlobStoreV0;
	readonly #proposals = new Map<string, { proposal: EndoInterventionProposalV0; eventId: string }>();
	readonly #authorizations = new Map<
		string,
		{ authorization: EndoInterventionAuthorizationV0; eventId: string; recordedAt: string }
	>();
	readonly #requests = new Map<string, RequestStateV0>();
	/** Where an explicit consumption check has got to, by proposal. Plain data and, between slices, no snapshot; dropped once observed. */
	readonly #scans = new Map<string, { scan: EndoConsumptionScanV0; snapshot: EndoCaptureSnapshotV0 | null }>();
	/** Applies in flight, by proposal: a concurrent duplicate waits for the first instead of sending twice. */
	readonly #inFlight = new Map<string, Promise<PiInterventionApplyResultV0>>();

	readonly #capture: EndoInterventionCaptureSourceV0 | null;
	/** Called, in order, when a FINAL `finish` begins, before it waits for anything: a host that takes proposals stops taking them here. */
	readonly #finishing: (() => void)[] = [];
	readonly #now: () => number;
	readonly #authorizationMaxAgeMs: number;

	/**
	 * `capture`: where the recording proxy's captured requests are read from; without it consumption is never observed.
	 * `options.authorizationMaxAgeMs`: the oldest authorization (by its recording time) the desk will act on, 15 minutes
	 * by default; `options.now` is the clock it ages them by (injectable for tests).
	 */
	constructor(
		session: PiSessionAttachmentV0,
		key: EndoDigestKeyV0,
		capture: EndoInterventionCaptureSourceV0 | null = null,
		options: { authorizationMaxAgeMs?: number; now?: () => number } = {},
	) {
		this.session = session;
		this.#capture = capture;
		this.#now = options.now ?? Date.now;
		this.#authorizationMaxAgeMs = options.authorizationMaxAgeMs ?? ENDO_INTERVENTION_AUTHORIZATION_MAX_AGE_MS_V0;
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
					recordedAt: event.at,
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
			...(authorization === null
				? {}
				: {
						authorizationAgeMs: this.#now() - Date.parse(authorization.recordedAt),
						authorizationMaxAgeMs: this.#authorizationMaxAgeMs,
					}),
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

	/** Run `listener` when a final `finish` (`{ final: true }`: the session is closing) begins, before the desk waits for applies in flight. */
	onFinishing(listener: () => void): void {
		this.#finishing.push(listener);
	}

	/** Whether current evidence admits the runtime capability an operation needs, and if not, why. */
	admissionFor(operation: EndoInterventionOperationV0): { admitted: true } | { admitted: false; reason: string } {
		return this.session.admission(PI_INTERVENTION_CAPABILITIES_V0[operation]);
	}

	/**
	 * Record that a proposal will not be sent, for a reason the gate does not see (the host's own approval window, a withdrawn or
	 * unanswered approval, a revoked grant). Nothing was sent: the refusal carries no request. A proposal that was already sent keeps its
	 * request and outcome, and this records nothing for it.
	 */
	refuse(proposalId: string, reason: EndoInterventionRefusalReasonV0, detail: string): void {
		if (!this.#proposals.has(proposalId) || this.#requests.has(proposalId)) return;
		const found = this.#proposals.get(proposalId)!;
		const authorized = [...this.#authorizations.values()].filter(
			({ authorization }) => authorization.proposalId === proposalId,
		);
		this.#record(
			"intervention.refused",
			{
				schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
				proposalId,
				requestId: null,
				reason,
				detail: detail.slice(0, 500),
			},
			[found.eventId, ...authorized.map(({ eventId }) => eventId)],
		);
	}

	/** What the desk holds of a proposal's request, from memory: null before the request was recorded (the gate has not passed yet). */
	requestOf(proposalId: string): { requestId: string; outcome: RequestStateV0["outcome"] } | null {
		const state = this.#requests.get(proposalId);
		return state === undefined ? null : { requestId: state.request.requestId, outcome: state.outcome };
	}

	/**
	 * Whether the message of an accepted STEER or QUEUE appears in a later request the recording proxy captured, now. This READS the
	 * capture, so a caller asks for it on purpose, never per poll. Observing it records `intervention.consumed` once (as `finish` would).
	 */
	consumption(proposalId: string): EndoInterventionConsumptionV0 {
		const state = this.#requests.get(proposalId);
		if (state === undefined) return { status: "not-applicable", reason: "the request was never sent" };
		return this.#consumption(state);
	}

	/**
	 * One BOUNDED slice of the consumption check, for a caller that yields between slices (the workbench). The rule is `endoFindConsumptionV0`'s,
	 * run over an index with the bodies read on demand; a scan keeps its place per request, so a stopped check is resumed, not restarted.
	 * `scanning`: more to read, nothing established. `incomplete`: the inspection could not finish (a body unreadable or over its limit, the
	 * capture not indexable, the store closed): it establishes nothing, least of all that the message was not used. `observed` records
	 * `intervention.consumed` once, here, and only when the capture shows the increase.
	 */
	consumptionStep(
		proposalId: string,
		limits: EndoConsumptionSliceLimitsV0,
		options: { fresh?: boolean } = {},
	): PiConsumptionStepV0 {
		const state = this.#requests.get(proposalId);
		if (state === undefined) return { status: "not-applicable", reason: "the request was never sent" };
		return this.#step(state, limits, options.fresh === true);
	}

	/** The capture's index now, or null when there is none. A source with no bounded reader is adapted from its whole-capture read. */
	#snapshot(unbounded: boolean): EndoCaptureSnapshotV0 | null {
		const source = this.#capture;
		if (source === null) return null;
		if (source.open !== undefined) return source.open(unbounded ? { maxIndexBytes: Number.POSITIVE_INFINITY } : {});
		const requests = source.requests();
		if (requests === null) return null;
		const byExchange = new Map(requests.map((request) => [request.exchange, request]));
		return {
			entries: requests.map((r) => ({ exchange: r.exchange, captureEvent: r.captureEvent, at: r.at, bodyBytes: 0 })),
			body: (entry) => byExchange.get(entry.exchange)!.body,
		};
	}

	#step(
		state: RequestStateV0,
		limits: EndoConsumptionSliceLimitsV0,
		fresh: boolean,
		unbounded = false,
	): PiConsumptionStepV0 {
		const id = state.request.proposalId;
		const proposal = this.#proposals.get(id)!.proposal;
		if (proposal.message === null) return { status: "not-applicable", reason: "stop carries no message to consume" };
		if (state.outcome?.status !== "accepted")
			return { status: "not-applicable", reason: "the request was not accepted" };
		// Every path that records consumption passes here first, so a check and `finish` cannot both record it.
		if (state.consumedEvent !== null && state.consumedExchange !== null) {
			this.#scans.delete(id);
			return { status: "observed", exchange: state.consumedExchange, captureEvent: state.consumedEvent };
		}
		let held = this.#scans.get(id);
		// A scan that lost bodies is started again when a NEW check begins (not between its slices), so a body that has become readable
		// is not skipped for good.
		if (
			held !== undefined &&
			(fresh || held.snapshot === null) &&
			(held.scan.unreadable.length > 0 || held.scan.tooLarge.length > 0)
		)
			held = { scan: endoNewConsumptionScanV0(), snapshot: null };
		if (held === undefined) held = { scan: endoNewConsumptionScanV0(), snapshot: null };
		if (held.snapshot === null || fresh) {
			let snapshot: EndoCaptureSnapshotV0 | null;
			try {
				snapshot = this.#snapshot(unbounded);
			} catch {
				this.#scans.set(id, { scan: held.scan, snapshot: null });
				return {
					status: "incomplete",
					reason: "the capture could not be indexed within the bounded reader's limit, so it was not inspected",
					scanned: { ...held.scan.scanned },
					total: 0,
				};
			}
			if (snapshot === null) return { status: "not-observed", reason: "this session store holds no proxy capture" };
			held = { scan: held.scan, snapshot };
			this.#scans.set(id, held);
		}
		const entries = held.snapshot!.entries;
		// With the proxy's delivery point, the message can first appear in the next exchange; without one, in the first
		// exchange captured after the request was recorded.
		const from =
			state.request.at !== null
				? state.request.at.exchange + 1
				: (entries.find((entry) => entry.at >= state.recordedAt)?.exchange ?? null);
		const slice = endoSliceConsumptionV0(held.scan, held.snapshot!, from, proposal.message, this.key, limits);
		const scanned = { ...held.scan.scanned };
		if (slice.kind === "more") return { status: "scanning", scanned, total: entries.length };
		this.#scans.set(id, { scan: held.scan, snapshot: null });
		if (slice.kind === "found") {
			try {
				this.#record(
					"intervention.consumed",
					{
						schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
						requestId: state.request.requestId,
						exchange: slice.exchange,
						captureEvent: slice.captureEvent,
						message: proposal.message,
					},
					[state.eventId],
				);
			} catch {
				// The store closed under it: what was seen is not recorded, and a check that cannot record says so.
				return {
					status: "incomplete",
					reason: "the session store was closed before the finding could be recorded",
					scanned,
					total: entries.length,
				};
			}
			this.#scans.delete(id);
			return { status: "observed", exchange: slice.exchange, captureEvent: slice.captureEvent };
		}
		const lost = held.scan.unreadable.length + held.scan.tooLarge.length;
		if (lost > 0)
			return {
				status: "incomplete",
				reason: `${lost} captured request${lost === 1 ? "" : "s"} could not be inspected (unreadable, or over the per-request limit); the message was not found in the others`,
				scanned,
				total: entries.length,
			};
		if (slice.startedAt === null)
			return {
				status: "not-observed",
				reason: `no request was captured after this one was recorded (${slice.requests} captured)`,
			};
		return {
			status: "not-observed",
			reason: `no captured request from exchange ${slice.startedAt} on carries the message (${slice.requests} captured)`,
		};
	}

	/** The whole check in one synchronous run, with no budget: what closing the session records. A scan that could not finish is `not-observed`, saying why. */
	#consumption(state: RequestStateV0): EndoInterventionConsumptionV0 {
		const everything = {
			maxBytes: Number.POSITIVE_INFINITY,
			maxRequests: Number.POSITIVE_INFINITY,
			maxBodyBytes: Number.POSITIVE_INFINITY,
		};
		const result = this.#step(state, everything, true, true);
		if (result.status === "incomplete")
			return { status: "not-observed", reason: `not established: ${result.reason}` };
		if (result.status === "scanning")
			return { status: "not-observed", reason: "not established: the inspection did not finish" };
		return result;
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
	 * Wait for the applies still waiting for Pi (an abort is answered only once the run is idle), for at most `waitMs`
	 * (default 30 s). A late reply is still recorded when it comes, after the consequence, which then says `pending`.
	 */
	async settled(waitMs = 30_000): Promise<void> {
		const flying = [...this.#inFlight.values()].map((apply) => apply.catch(() => {}));
		if (flying.length === 0) return;
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				Promise.all(flying),
				new Promise<void>((done) => {
					timer = setTimeout(done, waitMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * For every request: consumption (recorded only when the capture shows it), then the consequence, once. Waits first
	 * for applies still waiting for Pi (`settled`), so a reply that is on its way is recorded before the consequence and
	 * the consequence does not claim "no reply" for it. Call when the session's work has settled and the recording proxy
	 * has flushed, before the session closes.
	 */
	async finish(options: { waitMs?: number; final?: boolean } = {}): Promise<void> {
		// A mid-session finish (the control socket's `finish`) records what it can and leaves the session working; only the closing one
		// tells the host to stop taking requests.
		for (const listener of options.final === true ? this.#finishing : []) {
			try {
				listener();
			} catch {
				// a listener never stops the consequences from being recorded
			}
		}
		await this.settled(options.waitMs);
		for (const state of this.#requests.values()) {
			if (state.consequence) continue;
			const consumption = this.#consumption(state);
			const consequence: EndoInterventionConsequenceV0 = {
				schemaVersion: ENDO_INTERVENTION_SCHEMA_V0,
				requestId: state.request.requestId,
				acceptance:
					state.outcome?.status === "accepted"
						? { status: "accepted", disposition: state.outcome.disposition }
						: state.outcome?.status === "refused"
							? { status: "refused", reason: state.outcome.reason }
							: { status: "pending", reason: "Pi had not replied when the consequence was recorded" },
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
