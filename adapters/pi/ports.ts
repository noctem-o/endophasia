// The Pi-backed lane ports. Each factory closes over the Pi lane (or harness) reads it needs and delegates to the
// Pi projection module of the same name; nothing here adds to or changes the v0 semantics.
import type { AgentHarness, AgentLane } from "@earendil-works/pi-agent-core";
import type {
	ContinuityCaptureSourceV0,
	ControlDeckSourceV0,
	SessionOverviewCaptureSourceV0,
	SteeringSourceV0,
} from "../../runtime/ports.ts";
import { captureContinuityV0 } from "./continuity.ts";
import {
	captureControlStateV0,
	configureActiveToolsV0,
	configureModelV0,
	configureThinkingLevelV0,
} from "./control-deck.ts";
import { captureSessionOverviewV0 } from "./session-overview.ts";
import { captureSteeringStateV0, queueFollowUpV0, steerV0, stopV0 } from "./steering.ts";

/** Bind Continuity v0 capture to one Pi lane's watch and findEntries reads. */
export function createPiContinuityCaptureV0(lane: Pick<AgentLane, "watch" | "findEntries">): ContinuityCaptureSourceV0 {
	return {
		capture: (context) => captureContinuityV0(lane, context),
	};
}

/** Bind Session Overview v0 capture to one Pi harness's lane inventory. */
export function createPiSessionOverviewCaptureV0(harness: Pick<AgentHarness, "lanes">): SessionOverviewCaptureSourceV0 {
	return {
		capture: (context) => captureSessionOverviewV0(harness, context),
	};
}

/** Bind Steering v0 actions and state to one Pi lane's queues, execution inspection and abort. */
export function createPiSteeringSourceV0(
	lane: Pick<AgentLane, "name" | "steer" | "followUp" | "inspectExecution" | "requestAbort" | "watch">,
): SteeringSourceV0 {
	return {
		steer: (text, context) => steerV0(lane, text, context),
		queueFollowUp: (text, context) => queueFollowUpV0(lane, text, context),
		stop: (context) => stopV0(lane, context),
		state: (context) => captureSteeringStateV0(lane, context),
	};
}

/** Bind Control Deck v0 capture and configuration to one Pi lane's snapshot and setters. */
export function createPiControlDeckSourceV0(
	lane: Pick<AgentLane, "watch" | "setModel" | "setThinkingLevel" | "setActiveTools">,
): ControlDeckSourceV0 {
	return {
		state: (context) => captureControlStateV0(lane, context),
		configureModel: (model, context) => configureModelV0(lane, model, context),
		configureThinkingLevel: (level, context) => configureThinkingLevelV0(lane, level, context),
		configureActiveTools: (names, context) => configureActiveToolsV0(lane, names, context),
	};
}
