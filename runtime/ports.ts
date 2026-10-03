// Lane ports v0: the narrow capabilities through which Endophasia operates a runtime lane and harness directly,
// outside the runtime observation boundary. Each is defined in Endophasia's own v0 semantics, never a runtime's
// native vocabulary, and each is a lane- or harness-bound closure: the capability already knows its own lane, so a
// call takes only a request context. A runtime-specific adapter (adapters/pi/ports.ts) supplies the capabilities; a
// consumer receives the capability alone, never a lane or harness.
import type { Context } from "@earendil-works/chord";
import type { ContinuitySnapshotV0 } from "../protocol/continuity.ts";
import type { ControlReceiptV0, ControlStateV0 } from "../protocol/control.ts";
import type { ModelIdentityV0, ThinkingLevelV0 } from "../protocol/primitives.ts";
import type { SessionOverviewV0 } from "../protocol/session-overview.ts";
import type { SteeringActionResultV0, SteeringReceiptV0, SteeringStateV0 } from "../protocol/steering.ts";

/** A Continuity v0 capture bound to one lane. */
export interface ContinuityCaptureSourceV0 {
	/**
	 * A fresh, payload-minimal, read-only capture of the lane's continuity at one durable tip. A failed capture fails
	 * the call; it is never replaced by an empty snapshot.
	 */
	capture(context: Context): Promise<ContinuitySnapshotV0>;
}

/** A Session Overview v0 capture bound to one harness. */
export interface SessionOverviewCaptureSourceV0 {
	/** A fresh, payload-minimal, read-only inventory of the harness's current lanes. Not a session-wide atomic snapshot. */
	capture(context: Context): Promise<SessionOverviewV0>;
}

/** The Steering v0 actions and state of one lane. */
export interface SteeringSourceV0 {
	/** Submit text to the lane's durable steer queue. Acceptance says nothing about later consumption. */
	steer(
		text: string,
		context: Context,
	): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "steer.accepted" }>>>;
	/** Submit text to the lane's durable follow-up queue. Acceptance says nothing about later execution. */
	queueFollowUp(
		text: string,
		context: Context,
	): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "queue.accepted" }>>>;
	/**
	 * Request cancellation of, only, the run observed by the lane's execution inspection. It never retargets a newer
	 * operation.
	 */
	stop(context: Context): Promise<SteeringActionResultV0<Extract<SteeringReceiptV0, { kind: "stop.requested" }>>>;
	/** Read the accepted conversational queue identities from one atomic lane snapshot. */
	state(context: Context): Promise<SteeringStateV0>;
}

/** The Control Deck v0 capture and configuration of one lane. */
export interface ControlDeckSourceV0 {
	/** Capture the lane's configured controls from one short-lived snapshot. A read failure propagates unchanged. */
	state(context: Context): Promise<ControlStateV0>;
	/** Configure the lane model for future generation snapshots. The setter's errors propagate unchanged. */
	configureModel(
		model: ModelIdentityV0,
		context: Context,
	): Promise<Extract<ControlReceiptV0, { kind: "model.configured" }>>;
	/** Configure the lane thinking level for future generation snapshots. The setter's errors propagate unchanged. */
	configureThinkingLevel(
		level: ThinkingLevelV0,
		context: Context,
	): Promise<Extract<ControlReceiptV0, { kind: "thinking.configured" }>>;
	/** Configure the lane's active tool names, in the given order, for future generation snapshots. */
	configureActiveTools(
		names: string[],
		context: Context,
	): Promise<Extract<ControlReceiptV0, { kind: "tools.configured" }>>;
}
