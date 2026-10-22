// Deterministic sanitiser for DSH session logs and `--json` streams captured in the study. The raw captures stay in the research-data
// directory (research/DATA.md) and are never committed; what is committed is the output of this file, so the output must carry
// nothing private and nothing that can only be reproduced by luck:
//
// - the system prompt and every injected (non-prompt) user or developer message are replaced by their length only (a digest of text that embeds the working directory would let anyone holding the
//   template confirm a guess at the user's name or path): they are
//   the product's text and the user's environment, not evidence about the log's structure;
// - absolute paths are rewritten to /fixture/..., the user's name never appears;
// - random identifiers (session, message, call, response, retry, attempt ids) become stable ordinals by first appearance;
// - timestamps keep their differences and lose their date: every epoch-millisecond field is shifted so the header's `createdAt`
//   is FIXTURE_EPOCH.
//
// Model output (reasoning, text) and the study's own prompt and tool output are kept: they are the benign result of a task this
// study chose. `findLeaks` is the check that nothing slipped through; the tests run it over every committed fixture.

export const FIXTURE_EPOCH = 1_700_000_000_000;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface SanitiseOptions {
	/** Absolute path prefixes that name the scratch workspace or home, longest first; each becomes `/fixture/<label>`. */
	paths: { prefix: string; label: string }[];
	/** User prompt texts the study itself chose; every other user/developer text is withheld. */
	keepUserTexts: readonly string[];
	/** Strings that must not survive (the user's name, the machine's home): `findLeaks` input, also used to fail fast. */
	canaries: readonly string[];
}

/** Which keys carry which kind of random identifier. */
const ID_KEYS: Readonly<Record<string, string>> = {
	callId: "call",
	toolCallId: "call",
	responseId: "resp",
	retryId: "retry",
	attemptId: "attempt",
	sessionId: "session",
	parentSession: "session",
	messageId: "msg",
};

const EPOCH_KEYS = new Set(["time", "time0", "createdAt", "at"]);

export class Sanitiser {
	private readonly ids = new Map<string, string>();
	private readonly counters = new Map<string, number>();
	private shift = 0;
	private readonly options: SanitiseOptions;
	constructor(options: SanitiseOptions) {
		this.options = options;
	}

	/** Fix the time shift from the header, once per log. */
	private anchor(header: { createdAt?: unknown }): void {
		this.shift = typeof header.createdAt === "number" ? FIXTURE_EPOCH - header.createdAt : 0;
	}

	private ordinal(kind: string, value: string): string {
		const key = `${kind}\u0000${value}`;
		let id = this.ids.get(key);
		if (id === undefined) {
			const next = (this.counters.get(kind) ?? 0) + 1;
			this.counters.set(kind, next);
			id = `${kind}-${next}`;
			this.ids.set(key, id);
		}
		return id;
	}

	private path(text: string): string {
		let out = text;
		for (const { prefix, label } of this.options.paths) out = out.split(prefix).join(`/fixture/${label}`);
		return out;
	}

	private withheld(text: string): string {
		return `[withheld: ${text.length} chars]`;
	}

	private value(key: string | null, value: Json): Json {
		if (Array.isArray(value)) return value.map((item) => this.value(key, item));
		if (value !== null && typeof value === "object") {
			const out: { [key: string]: Json } = {};
			// A tool-call content part names its call by `id`; the event's own `callId` must map to the same ordinal.
			const isToolCall =
				(value.type === "tool-call" || value.type === "tool-call-chunks") && typeof value.id === "string";
			for (const [k, v] of Object.entries(value))
				out[k] = isToolCall && k === "id" ? this.ordinal("call", v as string) : this.value(k, v);
			return out;
		}
		if (typeof value === "number")
			return key !== null && EPOCH_KEYS.has(key) && value > 1e11 ? value + this.shift : value;
		if (typeof value !== "string") return value;
		if (key !== null && Object.hasOwn(ID_KEYS, key)) return this.ordinal(ID_KEYS[key]!, value);
		// A message's own `id` (uuid) and the header's `id`.
		if (key === "id" && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(value)) return this.ordinal("msg", value);
		if (key === "id" && /^session-/.test(value)) return this.ordinal("session", value);
		return this.path(value);
	}

	/** Whether an object is a user message as DSH shapes it (content parts and a `source`), wherever it is nested. */
	private userMessage(value: { [key: string]: Json }): boolean {
		const source = value.source;
		return (
			Array.isArray(value.content) &&
			source !== null &&
			typeof source === "object" &&
			!Array.isArray(source) &&
			typeof source.kind === "string" &&
			value.role === "user"
		);
	}

	/** Withhold the text of a message's content parts, keeping their shape. */
	private content(message: { [key: string]: Json }, keep: boolean): void {
		const parts = message.content;
		if (!Array.isArray(parts)) return;
		for (const part of parts) {
			if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
			const text = (part as { [key: string]: Json }).text;
			if (typeof text === "string" && !(keep && this.options.keepUserTexts.includes(text)))
				(part as { [key: string]: Json }).text = this.withheld(text);
		}
	}

	/** Withhold a user message's text (except the study's own prompts) and the section texts its `source` restates. */
	private scrubUser(message: { [key: string]: Json }): void {
		this.content(message, true);
		const source = message.source;
		if (source !== null && typeof source === "object" && !Array.isArray(source) && Array.isArray(source.sections))
			for (const section of source.sections)
				if (
					section !== null &&
					typeof section === "object" &&
					!Array.isArray(section) &&
					typeof section.text === "string"
				)
					section.text = this.withheld(section.text);
	}

	private visitUserMessages(value: Json): void {
		if (Array.isArray(value)) {
			for (const item of value) this.visitUserMessages(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		if (this.userMessage(value)) {
			this.scrubUser(value);
			return;
		}
		for (const item of Object.values(value)) this.visitUserMessages(item);
	}

	sanitiseLog(header: unknown, events: readonly unknown[]): { header: unknown; events: unknown[] } {
		this.anchor(header as { createdAt?: unknown });
		const cleanHeader = this.value(null, header as Json);
		const cleanEvents = events.map((event) => {
			const row = event as { type?: string; data?: { [key: string]: Json } };
			const copy = JSON.parse(JSON.stringify(event)) as { [key: string]: Json };
			const data = copy.data as { [key: string]: Json } | undefined;
			// Every user message wherever it sits (the inbox splice restates the prompt, as `inserted[]`); a user/message EVENT is one
			// whatever its fields say.
			if (row.type === "user/message" && data !== undefined) this.scrubUser(data);
			this.visitUserMessages(copy);
			// A derived title is DSH's rewording of the first prompt: kept only when that prompt was kept.
			if (row.type === "session/title" && data !== undefined && typeof data.title === "string") {
				const title = data.title;
				if (!this.options.keepUserTexts.some((text) => text.startsWith(title) || title.startsWith(text)))
					data.title = this.withheld(title);
			}
			const message = data?.message;
			if (data !== undefined && message !== null && typeof message === "object" && !Array.isArray(message)) {
				if (row.type === "system/message" || row.type === "developer/message")
					this.content(message as { [key: string]: Json }, false);
			}
			return this.value(null, copy);
		});
		return { header: cleanHeader, events: cleanEvents };
	}

	/** A `--json` stream line: ids and paths only (its text is model output or the study's own task). */
	sanitiseStreamLine(line: unknown): unknown {
		return this.value(null, line as Json);
	}
}

/** Strings that survive in `text` and must not. Returns each leak with a short context. */
export function findLeaks(text: string, canaries: readonly string[]): string[] {
	const leaks: string[] = [];
	for (const canary of canaries) {
		const at = text.indexOf(canary);
		if (at >= 0) leaks.push(`${JSON.stringify(canary)} at ${at}`);
	}
	// A real absolute home path of any user, a uuid-shaped id that was not mapped, and a provider response id.
	for (const [name, pattern] of [
		["home path", /\/home\/[A-Za-z0-9._-]+\//],
		["uuid", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/],
		["provider response id", /chatcmpl-[A-Za-z0-9]+/],
	] as const) {
		const match = pattern.exec(text);
		if (match !== null) leaks.push(`${name}: ${match[0]}`);
	}
	return leaks;
}
