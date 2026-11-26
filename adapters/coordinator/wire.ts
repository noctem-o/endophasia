import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0 } from "../../runtime/contracts/canonical-json.ts";
import {
	coordinatorToolRefusalV0,
	ENDO_COORDINATOR_TOOL_DEFINITION_V0,
	ENDO_COORDINATOR_TOOL_V0,
	type EndoCoordinatorBriefRefusalV0,
} from "../../runtime/contracts/coordinator-brief.ts";
import { Http1ParserV0, http1HeaderValuesV0 } from "../openai-proxy/http1.ts";

export const COORDINATOR_INFERENCE_V0 = Object.freeze({
	temperature: 0,
	top_k: 1,
	top_p: 1,
	min_p: 0,
	seed: 101,
	max_tokens: 2048,
});

const TOOL_SET_V0 = canonicalEndoJsonV0([{ type: "function", function: ENDO_COORDINATOR_TOOL_DEFINITION_V0 }]);

const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export function coordinatorWireV0(
	projectId: string,
	toolText: string,
	bearer: string,
	onRefused?: () => void,
	options: {
		/** The exact inference parameters admitted; M0's by default. */
		readonly inference?: Readonly<Record<keyof typeof COORDINATOR_INFERENCE_V0, number>>;
		/** When set, a response chunk naming another model is refused as `model-identity-mismatch`. */
		readonly model?: string;
	} = {},
) {
	const inference = options.inference ?? COORDINATOR_INFERENCE_V0;
	const trace = {
		toolDefinitions: [] as JsonValueV0[],
		statusDelivered: false,
		statusMessage: null as JsonValueV0,
		inference: [] as Record<string, JsonValueV0>[],
		responses: [] as { finish: string | null; usage: JsonValueV0; text: string; toolCalled: boolean }[],
		refusal: null as EndoCoordinatorBriefRefusalV0 | null,
	};
	let id: string | null = null;
	let requests = 0;
	const refuse = (reason: EndoCoordinatorBriefRefusalV0) => {
		if (trace.refusal === null) {
			trace.refusal = reason;
			onRefused?.();
		}
		return false;
	};

	return {
		trace,
		request({ body, headers }: { body: Uint8Array; headers: readonly [string, string][] }) {
			const auth = headers.filter(([name]) => name.toLowerCase() === "authorization");
			if (auth.length !== 1 || auth[0]?.[1] !== `Bearer ${bearer}`) return false;
			if (trace.refusal !== null) return false;
			const sent = record(JSON.parse(Buffer.from(body).toString("utf8")));
			if (sent === null) return refuse("model-unavailable");
			const tools = Array.isArray(sent.tools) ? (sent.tools as JsonValueV0[]) : [];
			trace.toolDefinitions.push(tools);
			trace.inference.push(
				Object.fromEntries(Object.keys(inference).map((field) => [field, (sent[field] ?? null) as JsonValueV0])),
			);
			if (canonicalEndoJsonV0(tools) !== TOOL_SET_V0 || "functions" in sent || "function_call" in sent)
				return refuse("tool-surface-mismatch");
			if (
				Object.entries(inference).some(([key, expected]) => sent[key] !== expected) ||
				sent.stream !== true ||
				"n_predict" in sent ||
				"max_completion_tokens" in sent
			)
				return refuse("model-unavailable");
			if (!Array.isArray(sent.messages)) return refuse("model-unavailable");
			const toolMessages = sent.messages.map(record).filter((m) => m?.role === "tool");
			if (requests === 0) {
				if (toolMessages.length !== 0) return refuse("ungrounded");
			} else {
				const message = toolMessages[0];
				trace.statusMessage = (message ?? null) as JsonValueV0;
				if (
					requests !== 1 ||
					id === null ||
					toolMessages.length !== 1 ||
					(message?.tool_call_id !== id &&
						message?.tool_call_id !== id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 40)) ||
					message.content !== toolText
				)
					return refuse("ungrounded");
				trace.statusDelivered = true;
			}
			requests += 1;
			return true;
		},
		response({ status, wire }: { status: number; wire: Uint8Array }) {
			if (trace.refusal !== null) return false;
			if (status !== 200) return refuse("model-unavailable");
			try {
				const parts: Buffer[] = [];
				let sse = false;
				const parser = new Http1ParserV0(
					"response",
					{
						head: (head) => {
							const types = http1HeaderValuesV0(head.headers, "content-type");
							sse = types.length === 1 && /^text\/event-stream(?:;|$)/i.test(types[0]!);
						},
						body: (bytes) => parts.push(bytes),
						end: () => {},
					},
					{ strictChunks: true },
				);
				parser.push(Buffer.from(wire));
				if (!parser.close() || !sse) return refuse("model-unavailable");
				let done = false;
				let responseId = "";
				let name = "";
				let args = "";
				let finish: string | null = null;
				let text = "";
				let usage: JsonValueV0 = null;
				let toolCalled = false;
				for (const line of Buffer.concat(parts).toString("utf8").split(/\r?\n/)) {
					if (line === "" || line.startsWith(":")) continue;
					if (!line.startsWith("data:") || done) return refuse("model-unavailable");
					const data = line.slice(5).trim();
					if (data === "[DONE]") {
						done = true;
						continue;
					}
					const item = record(JSON.parse(data));
					if (item === null || !Array.isArray(item.choices) || item.choices.length > 1)
						return refuse("model-unavailable");
					if (options.model !== undefined && item.model !== undefined && item.model !== options.model)
						return refuse("model-identity-mismatch");
					if (record(item.usage)) usage = item.usage as JsonValueV0;
					for (const choice of item.choices) {
						const c = record(choice);
						const d = record(c?.delta);
						if (c?.index !== 0 || d === null) return refuse("model-unavailable");
						if (typeof c.finish_reason === "string") finish = c.finish_reason;
						if (typeof d.content === "string") text += d.content;
						if (d.function_call !== undefined && d.function_call !== null) return refuse("tool-not-permitted");
						if (d.tool_calls === undefined || d.tool_calls === null) continue;
						if (!Array.isArray(d.tool_calls)) return refuse("tool-not-permitted");
						for (const entry of d.tool_calls) {
							toolCalled = true;
							const call = record(entry);
							const f = record(call?.function);
							if (call?.index !== 0 || (call.type !== undefined && call.type !== "function") || f === null)
								return refuse("tool-not-permitted");
							if (typeof call.id === "string") responseId += call.id;
							if (typeof f.name === "string") name += f.name;
							if (typeof f.arguments === "string") args += f.arguments;
						}
					}
				}
				trace.responses.push({ finish, usage, text, toolCalled });
				if (!done || finish === null) return refuse("model-unavailable");
				if (toolCalled) {
					if (
						requests !== 1 ||
						id !== null ||
						!/^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_-]{1,80}$/.test(responseId) ||
						finish !== "tool_calls" ||
						name !== ENDO_COORDINATOR_TOOL_V0
					)
						return refuse("tool-not-permitted");
					let params: unknown;
					try {
						params = JSON.parse(args);
					} catch {
						return refuse("malformed-selector");
					}
					const failure = coordinatorToolRefusalV0(projectId, name, params);
					if (failure !== null) return refuse(failure);
					id = responseId;
				} else if (finish === "tool_calls") return refuse("tool-not-permitted");
				return true;
			} catch {
				return refuse("model-unavailable");
			}
		},
	};
}
