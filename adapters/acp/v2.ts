// The ACP v2 (Draft, baseline) study surface. Experimental and version-pinned: nothing here is part of the stable adapter
// (index.ts is v1 only), and importing it is an explicit choice. See docs/acp-v2-study.md.
export * from "./client-v2.ts";
export * from "./conversation-v2.ts";
// The verdict vocabulary and entry shape are shared with v1 on purpose: one language for loss, separate tables.
export { ACP_LOSS_VERDICTS_V0, type AcpAvailabilityV0, type AcpLossEntryV0, type AcpLossVerdictV0 } from "./loss.ts";
export * from "./loss-v2.ts";
export * from "./negotiate.ts";
export * from "./schema-v2.ts";
export * from "./translate-v2.ts";
