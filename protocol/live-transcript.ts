// Harness-neutral live transcript schema constants and reasoning-relay contract (`endo.workbench-transcript.v3`).
// Shared by Pi and Codex memory-only live transcript projections without coupling one adapter to another.

export const LIVE_TRANSCRIPT_SCHEMA_V3 = "endo.workbench-transcript.v3";
export const LIVE_TRANSCRIPT_MAX_ITEMS_V0 = 400;
export const LIVE_TRANSCRIPT_MAX_BYTES_V0 = 2 * 1024 * 1024;
export const LIVE_TRANSCRIPT_MAX_MESSAGE_BYTES_V0 = 32 * 1024;
export const LIVE_TRANSCRIPT_MAX_REASONING_BLOCK_BYTES_V1 = 64 * 1024;
export const LIVE_TRANSCRIPT_MAX_REASONING_MESSAGE_BYTES_V1 = 96 * 1024;
export const LIVE_TRANSCRIPT_MAX_PARTS_V1 = 32;
export const LIVE_TRANSCRIPT_PAGE_V0 = 200;
export const LIVE_TRANSCRIPT_PAGE_BYTES_V1 = 512 * 1024;

/**
 * What a live transcript source relays of model-provided reasoning, harness-neutrally.
 * `relayed`: reasoning the runtime supplies in structured form is shown (a turn without any had none supplied).
 * `withheld`: the source has it and does not pass it on.
 * `unsupported`: the source does not provide it.
 */
export interface LiveTranscriptReasoningV1 {
	relay: "relayed" | "withheld" | "unsupported";
	reason: string | null;
}
