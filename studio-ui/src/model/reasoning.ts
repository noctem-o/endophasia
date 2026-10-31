// How model-provided reasoning is shown in the live conversation. Pure: no DOM, no clock.
//
// Reasoning is text a model emitted as reasoning and the runtime relayed in structured form (for Pi, its `thinking` blocks). It is shown
// as that, labelled as that, and never summarised, inferred or invented: a turn the runtime gave no reasoning for shows none. It may help
// diagnose a run; it is not a faithful account of how the model computed its answer, and the page never says it is.
//
// Display, not configuration: the operator's choice to fold or show reasoning changes what this page draws. It never touches the model's
// thinking setting, and it is held in page memory only (a reload is the default again).
import type { MessagePart, OpenMessage, ReasoningPart, ReasoningRelay, TranscriptItem } from "./workbench-wire.ts";

/** Folded: each trace is a one-line disclosure. Shown: each trace is open as it arrives. Either way a trace can be opened or folded alone. */
export type ReasoningMode = "folded" | "shown";
/** One trace's own state: folded, open (a long trace is clamped), or open in full. */
export type Disclosure = "folded" | "open" | "full";

/** Characters of a trace shown while it is open but not in full. Longer traces end with a control that shows the rest. */
export const CLAMP_CHARS = 2400;
const PREVIEW_CHARS = 140;

/**
 * The key of the n-th reasoning part of a message. A completed message that replaced an in-progress snapshot keeps the snapshot's key,
 * so a trace the operator opened while it was being written stays open when the completed message replaces it.
 */
export const reasoningKey = (
	owner: { seq: number; from: number | null } | { open: number },
	ordinal: number,
): string =>
	"open" in owner
		? `o${owner.open}:r${ordinal}`
		: owner.from === null
			? `s${owner.seq}:r${ordinal}`
			: `o${owner.from}:r${ordinal}`;

export const disclosureOf = (
	mode: ReasoningMode,
	overrides: ReadonlyMap<string, Disclosure>,
	key: string,
): Disclosure => overrides.get(key) ?? (mode === "shown" ? "open" : "folded");

/** A size as a reader thinks of text: words, and a byte count only where a cut is reported. */
export const wordCount = (text: string): number => text.match(/\S+/g)?.length ?? 0;

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const formatCount = (n: number): string => n.toLocaleString("en-US");

/** The first words of a trace, on one line, for a folded disclosure. Cut at a word where it can be. */
export function preview(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (line.length <= PREVIEW_CHARS) return line;
	const cutAt = line.lastIndexOf(" ", PREVIEW_CHARS);
	return `${line.slice(0, cutAt > PREVIEW_CHARS * 0.6 ? cutAt : PREVIEW_CHARS)}…`;
}

/** Whether an open trace is clamped (and so shows a control for the rest). */
export const isLong = (text: string): boolean => text.length > CLAMP_CHARS;

/** The visible part of an open trace: clamped at a line or word near CLAMP_CHARS unless shown in full. */
export function visibleText(text: string, disclosure: Disclosure): string {
	if (disclosure === "full" || !isLong(text)) return text;
	const head = text.slice(0, CLAMP_CHARS);
	const line = head.lastIndexOf("\n");
	if (line > CLAMP_CHARS * 0.7) return head.slice(0, line);
	const word = head.lastIndexOf(" ");
	return word > CLAMP_CHARS * 0.7 ? head.slice(0, word) : head;
}

/** The reasoning parts of a message, with their ordinal among reasoning parts (the key's index). */
export function reasoningParts(
	parts: readonly MessagePart[],
): { part: ReasoningPart; ordinal: number; index: number }[] {
	const out: { part: ReasoningPart; ordinal: number; index: number }[] = [];
	parts.forEach((part, index) => {
		if (part.kind === "reasoning") out.push({ part, ordinal: out.length, index });
	});
	return out;
}

/** How many messages carry any reasoning part. Only a count: never a measure of the reasoning itself. */
export const messagesWithReasoning = (items: readonly TranscriptItem[]): number =>
	items.filter((i) => i.kind === "message" && i.parts.some((p) => p.kind === "reasoning")).length;

/**
 * One sentence for a conversation that shows no reasoning, so its absence is explained rather than looking broken; null when there is
 * nothing to say (the source relays reasoning and some has arrived, or nothing has been said yet). It never guesses why a model gave none.
 */
export function reasoningNotice(
	relay: ReasoningRelay | null,
	items: readonly TranscriptItem[],
	open: OpenMessage | null,
): string | null {
	if (relay === null) return null;
	if (relay.relay === "withheld")
		return relay.reason ?? "This source withholds model-provided reasoning: none is shown here.";
	if (relay.relay === "unsupported")
		return relay.reason ?? "This source does not provide model-provided reasoning: none is shown here.";
	const assistant = items.some((i) => i.kind === "message" && i.role === "assistant");
	const anyOpen = open?.parts.some((p) => p.kind === "reasoning") ?? false;
	if (!assistant || messagesWithReasoning(items) > 0 || anyOpen) return null;
	return "No model-provided reasoning in this conversation so far. It is shown only when the model supplies it as structured reasoning; reasoning written inside an answer (in <think> tags, for example) is part of the answer's text.";
}

/** One clause for a trace's head: its place among the message's traces, its size, and what is not shown. */
export function traceMeta(part: ReasoningPart, ordinal: number, count: number): string {
	const place = count > 1 ? `${ordinal + 1} of ${count} · ` : "";
	if (part.state === "withheld") return `${place}withheld by the provider`;
	if (part.state === "empty") return `${place}an empty block: no text was supplied`;
	const words = wordCount(part.text);
	return `${place}${formatCount(words)} ${words === 1 ? "word" : "words"}${part.truncated ? ` · cut at ${formatBytes(utf8Length(part.text))} of ${formatBytes(part.bytes)}` : ""}`;
}

/** UTF-8 length without the DOM or Node: a code point is 1-4 bytes. */
export function utf8Length(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i += 1) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff) {
			n += 4;
			i += 1;
		} else n += 3;
	}
	return n;
}
