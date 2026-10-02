// Neutral v0 primitives shared by the Endophasia protocol schemas. Each redefines, with an identical wire shape, a
// small vocabulary that a concrete runtime also reports, so the protocol never imports a concrete runtime.

/** A lane's in-flight operation status; identical literals to Pi's `OperationStatus`. */
export type OperationStatusV0 = "running" | "open" | "aborting";

/** A lane's configured thinking level; identical literals to Pi's `ThinkingLevel`. */
export type ThinkingLevelV0 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A lane's configured model identity; identical shape to Pi's `ModelIdentity`. */
export interface ModelIdentityV0 {
	provider: string;
	modelId: string;
}

/** The message roles a Session entry can carry; identical literals to Pi's message vocabulary. */
export type MessageRoleV0 = "system" | "user" | "assistant" | "toolResult";
