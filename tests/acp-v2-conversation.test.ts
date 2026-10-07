// The reconstruction and the replay-equivalence rule (adapters/acp/conversation-v2.ts), without any process.
import { describe, expect, it } from "vitest";
import { ACP_V2_CONVERSATION_LIMITS_V0, AcpV2ConversationV0, compareAcpV2ReplayV0 } from "../adapters/acp/v2.ts";

const text = (value: string) => ({ type: "text", text: value });
const chunk = (messageId: string, value: string, kind = "agent_message_chunk") => ({
	sessionUpdate: kind,
	messageId,
	content: text(value),
});
const upsert = (messageId: string, content?: unknown, kind = "agent_message") => ({
	sessionUpdate: kind,
	messageId,
	...(content === undefined ? {} : { content }),
});
const build = (...updates: Array<Record<string, unknown>>) => {
	const state = new AcpV2ConversationV0();
	for (const update of updates) state.apply(update);
	return state.digest();
};
const contentOf = (digest: ReturnType<typeof build>, id: string) =>
	digest.messages.find((m) => m.id === id)?.contentSha256;

describe("conversation reconstruction", () => {
	it("reconstructs the same message from chunks, a replacement, and an empty start followed by chunks", () => {
		const chunks = build(chunk("m", "a"), chunk("m", "b"));
		const whole = build(upsert("m", [text("a"), text("b")]));
		const emptyFirst = build(upsert("m", []), chunk("m", "a"), chunk("m", "b"));
		expect(contentOf(whole, "m")).toBe(contentOf(chunks, "m"));
		expect(contentOf(emptyFirst, "m")).toBe(contentOf(chunks, "m"));
	});

	it("lets a content array replace everything accumulated, chunks included, and later chunks append", () => {
		const replaced = build(chunk("m", "stale"), upsert("m", [text("a")]));
		expect(contentOf(replaced, "m")).toBe(contentOf(build(upsert("m", [text("a")])), "m"));
		const appended = build(chunk("m", "stale"), upsert("m", [text("a")]), chunk("m", "b"));
		expect(contentOf(appended, "m")).toBe(contentOf(build(upsert("m", [text("a"), text("b")])), "m"));
	});

	it("clears on null and on [], and leaves content alone when it is omitted", () => {
		const empty = contentOf(build(upsert("m", [])), "m");
		expect(contentOf(build(chunk("m", "a"), upsert("m", null)), "m")).toBe(empty);
		expect(contentOf(build(chunk("m", "a"), upsert("m", [])), "m")).toBe(empty);
		expect(contentOf(build(chunk("m", "a"), upsert("m")), "m")).toBe(contentOf(build(chunk("m", "a")), "m"));
	});

	it("treats a repeated upsert as idempotent", () => {
		const once = build(upsert("m", [text("a")]));
		const twice = build(upsert("m", [text("a")]), upsert("m", [text("a")]));
		expect(twice).toEqual(once);
	});

	it("keeps one message per id, in first-appearance order, with its kind", () => {
		const digest = build(
			upsert("u", [text("q")], "user_message"),
			chunk("t", "x", "agent_thought_chunk"),
			chunk("a", "y"),
			chunk("u", "more", "user_message_chunk"),
		);
		expect(digest.messages.map((m) => [m.id, m.kind])).toEqual([
			["u", "user"],
			["t", "thought"],
			["a", "agent"],
		]);
	});

	it("records a contradiction when an id changes kind, and does not apply it", () => {
		const state = new AcpV2ConversationV0();
		state.apply(chunk("m", "a"));
		const result = state.apply(upsert("m", [text("b")], "user_message"));
		expect(result.applied).toBe(false);
		const digest = state.digest();
		expect(digest.conflicts).toHaveLength(1);
		expect(digest.messages[0]?.kind).toBe("agent");
	});

	it("patches tool calls: omitted unchanged, null and [] clear, chunks append", () => {
		const call = (fields: Record<string, unknown>) => ({
			sessionUpdate: "tool_call_update",
			toolCallId: "t",
			...fields,
		});
		const merged = build(call({ name: "read", status: "in_progress" }), call({ status: "completed" }));
		const direct = build(call({ name: "read", status: "completed" }));
		expect(merged.toolCalls).toEqual(direct.toolCalls);
		const cleared = build(
			call({ name: "read", content: [{ type: "content", content: text("x") }] }),
			call({ content: [] }),
		);
		expect(cleared.toolCalls).toEqual(build(call({ name: "read" })).toolCalls);
		expect(build(call({ name: "read", title: "T" }), call({ title: null })).toolCalls).toEqual(
			build(call({ name: "read" })).toolCalls,
		);
		const streamed = build(call({ name: "read" }), {
			sessionUpdate: "tool_call_content_chunk",
			toolCallId: "t",
			content: { type: "content", content: text("x") },
		});
		expect(streamed.toolCalls).toEqual(
			build(call({ name: "read", content: [{ type: "content", content: text("x") }] })).toolCalls,
		);
	});

	it("stops applying at its bounds and claims nothing past them", () => {
		const state = new AcpV2ConversationV0();
		for (let i = 0; i < ACP_V2_CONVERSATION_LIMITS_V0.messages + 3; i += 1) state.apply(chunk(`m${i}`, "x"));
		const digest = state.digest();
		expect(digest.messages).toHaveLength(ACP_V2_CONVERSATION_LIMITS_V0.messages);
		expect(digest.truncated).toBe(true);
		expect(compareAcpV2ReplayV0(digest, digest).equivalent).toBe(false);
	});

	it("consumes message and tool-call variants and nothing else", () => {
		for (const variant of [
			"user_message",
			"agent_message_chunk",
			"agent_thought",
			"tool_call_update",
			"tool_call_content_chunk",
		])
			expect(AcpV2ConversationV0.consumes(variant), variant).toBe(true);
		for (const variant of ["state_update", "plan_update", "usage_update", "terminal_update"])
			expect(AcpV2ConversationV0.consumes(variant), variant).toBe(false);
	});
});

describe("replay equivalence", () => {
	const live = build(
		upsert("u1", [text("q")], "user_message"),
		chunk("t1", "think", "agent_thought_chunk"),
		chunk("a1", "he"),
		chunk("a1", "llo"),
		upsert("lo", [text("local")]),
		{ sessionUpdate: "tool_call_update", toolCallId: "c1", name: "read", status: "completed" },
	);
	const replayOf = (...updates: Array<Record<string, unknown>>) => build(...updates);

	it("accepts a replay in a different shape that reconstructs the same state, with live-only messages absent", () => {
		const replay = replayOf(
			upsert("u1", [], "user_message"),
			chunk("u1", "q", "user_message_chunk"),
			upsert("t1", [text("think")], "agent_thought"),
			upsert("a1", [text("he"), text("llo")]),
			{ sessionUpdate: "tool_call_update", toolCallId: "c1", name: "read", status: "completed" },
		);
		const result = compareAcpV2ReplayV0(live, replay);
		expect(result.reasons).toEqual([]);
		expect(result.equivalent).toBe(true);
		expect(result.liveOnly.messages).toEqual(["lo"]);
	});

	it("accepts an empty replay: retaining nothing is permitted", () => {
		const result = compareAcpV2ReplayV0(live, replayOf());
		expect(result.equivalent).toBe(true);
		expect(result.liveOnly.messages).toHaveLength(4);
	});

	it("rejects changed content, a changed kind, an invented message or tool call, and reordering", () => {
		const reasons = (replay: ReturnType<typeof build>) => compareAcpV2ReplayV0(live, replay).reasons.join("|");
		expect(reasons(replayOf(upsert("a1", [text("different")])))).toMatch(/changed content/);
		expect(reasons(replayOf(upsert("a1", [text("he"), text("llo")], "user_message")))).toMatch(/changed kind/);
		expect(reasons(replayOf(upsert("new", [text("x")])))).toMatch(/never in the live session/);
		expect(reasons(replayOf({ sessionUpdate: "tool_call_update", toolCallId: "ghost", name: "x" }))).toMatch(
			/tool call .* never in the live/,
		);
		expect(
			reasons(replayOf({ sessionUpdate: "tool_call_update", toolCallId: "c1", name: "read", status: "failed" })),
		).toMatch(/differs from the live record/);
		expect(
			reasons(replayOf(upsert("a1", [text("he"), text("llo")]), upsert("u1", [text("q")], "user_message"))),
		).toMatch(/out of the live order/);
	});

	it("refuses to certify when either side saw a contradiction", () => {
		const state = new AcpV2ConversationV0();
		state.apply(chunk("a1", "x"));
		state.apply(upsert("a1", [text("x")], "user_message"));
		expect(compareAcpV2ReplayV0(live, state.digest()).reasons.join("|")).toMatch(
			/replay reconstruction recorded a contradiction/,
		);
		expect(compareAcpV2ReplayV0(state.digest(), live).reasons.join("|")).toMatch(
			/live reconstruction recorded a contradiction/,
		);
	});
});
