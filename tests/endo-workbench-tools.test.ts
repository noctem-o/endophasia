import { describe, expect, it } from "vitest";
import { LiveTranscriptV0 } from "../adapters/pi/live-transcript.ts";
import { readWorkbenchTranscript } from "../studio-ui/src/model/workbench-wire.ts";
import { syntheticActivities, unverified } from "./fixtures/private-activity.ts";

const secret = "PRIVATE-canary-a81";
const launchId = "adef111122223333";
const push = (t: LiveTranscriptV0, phase: "start" | "end", name: string, record: Record<string, unknown>) =>
	t.push({ type: `tool_execution_${phase}`, record: { toolName: name, toolCallId: "example", ...record } });
const result = (text: string) => ({ content: [{ type: "text", text }] });
const wire = (t: LiveTranscriptV0) => ({ schemaVersion: "endo.workbench-transcript.v3", launchId, ...t.view() });

describe("the private tool projection", () => {
	it("allocates occurrences before pagination and preserves ambiguous or malformed observations separately", () => {
		const t = new LiveTranscriptV0();
		for (const phase of ["start", "end", "start", "end", "end", "start", "start", "end", "end"] as const)
			push(t, phase, "read", {});
		push(t, "start", "read", { toolCallId: null });
		push(t, "end", "read", { toolCallId: null });
		t.push({ type: "turn_start", record: {} });
		push(t, "start", "read", {});
		push(t, "end", "read", {});
		expect(t.view().items.map((i) => i.kind === "tool" && i.occurrence)).toEqual([
			1, 1, 3, 3, 5, 6, 7, 8, 9, 10, 11, 12, 12,
		]);
		expect(t.view(12).items).toMatchObject([{ seq: 13, occurrence: 12, turn: 1 }]);
	});
	it("does not lose an open correlation when its start is evicted", () => {
		const t = new LiveTranscriptV0();
		push(t, "start", "bash", {});
		for (let i = 0; i < 410; i++) push(t, "end", "read", {});
		push(t, "end", "bash", {});
		expect(t.view(411)).toMatchObject({ evicted: 12, items: [{ seq: 412, occurrence: 1 }] });
	});
	it("withholds ordinary unadmitted syntax without calling it sensitive", () => {
		const t = new LiveTranscriptV0();
		push(t, "start", "bash", { args: { command: "cargo test" } });
		expect(t.view().items[0]).toMatchObject({
			fields: [{ state: "withheld" }, { state: "unavailable" }, { state: "unavailable" }],
		});
	});
	it("admits synthetic Codex, Claude and ACP presentations, not adapters or executable capabilities", () => {
		const page = {
			...wire(new LiveTranscriptV0()),
			items: syntheticActivities,
			watermark: 4,
			capabilities: unverified,
		};
		expect(readWorkbenchTranscript(page)?.items).toEqual(syntheticActivities);
		for (const capabilities of [{}, { ...unverified, approvals: true }, { ...unverified, protected: true }])
			expect(readWorkbenchTranscript({ ...page, capabilities })).toBeNull();
		for (const bad of [
			{ source: "unbounded text" },
			{ occurrence: 99 },
			{ turn: -1 },
			{ raw: secret },
			{ status: "verified" },
		])
			expect(readWorkbenchTranscript({ ...page, items: [{ ...syntheticActivities[0], ...bad }] })).toBeNull();
	});
	it("admits only known paths and meaningful scalar arguments; bodies and edit text stay out", () => {
		const t = new LiveTranscriptV0();
		push(t, "start", "read", { args: { path: "README.md", offset: 10, limit: 5 } });
		push(t, "start", "edit", { args: { path: "src/index.ts", edits: [{ oldText: secret, newText: secret }] } });
		push(t, "start", "write", { args: { path: "package.json", content: secret } });
		const view = wire(t);
		expect(readWorkbenchTranscript(view)).not.toBeNull();
		expect(view.items).toMatchObject([
			{ fields: [{ text: "README.md" }, { label: "Offset", text: "10" }, { label: "Limit", text: "5" }] },
			{ fields: [{ text: "src/index.ts" }, { label: "Edits", state: "counted", text: "1" }] },
			{ fields: [{ text: "package.json" }, { label: "Content", state: "withheld" }] },
		]);
		expect(JSON.stringify(view)).not.toContain(secret);
	});
	it("withholds long, multiline, compound and credential-bearing input, including secrets beyond an excerpt", () => {
		const t = new LiveTranscriptV0();
		for (const command of [
			`git status --short\n${secret}`,
			`curl -u user:${secret}`,
			`ls ${"x".repeat(100000)}${secret}`,
			["pwd"],
			`cat ~/.ssh/${secret}`,
		])
			push(t, "start", "bash", { args: { command, cwd: `/home/${secret}` } });
		push(t, "end", "bash", { result: result(" M README.md\n".repeat(90) + secret) });
		push(t, "start", "custom", { args: { key: secret } });
		const view = wire(t);
		expect(JSON.stringify(view)).not.toContain(secret);
		expect(
			view.items.every(
				(i) =>
					i.kind === "tool" && i.fields.some((f) => f.state === "withheld") && !i.fields.some((f) => "text" in f),
			),
		).toBe(true);
	});
	it("distinguishes an end report from its outcome and accepts only an explicit numeric exit code", () => {
		const t = new LiveTranscriptV0();
		push(t, "end", "bash", { isError: "false", toolCallId: null });
		push(t, "end", "bash", { isError: false, result: { details: { exitCode: "0" } } });
		push(t, "end", "bash", {
			isError: true,
			result: { ...result("Command exited with code 17"), details: { exitCode: 17 } },
		});
		expect(t.view().items).toMatchObject([
			{ callId: null, status: "unknown", fields: [{ state: "unavailable" }, { state: "unavailable" }] },
			{ status: "completed", fields: [{ state: "withheld" }, { state: "unavailable" }] },
			{ status: "failed", fields: [{ state: "reported", text: "17" }, { state: "withheld" }] },
		]);
	});
	it("validates before clipping, accounts for tool bytes and drops everything at session end", () => {
		const t = new LiveTranscriptV0();
		push(t, "end", "bash", { result: result(" M README.md\n".repeat(100)) });
		const first = t.view().items[0];
		expect(first).toMatchObject({
			fields: [{ state: "unavailable" }, { state: "truncated", text: expect.any(String) }],
		});
		expect(first?.kind === "tool" && first.fields.some((f) => "text" in f && Buffer.byteLength(f.text) === 512)).toBe(
			true,
		);
		expect(t.size.bytes).toBeGreaterThan(512);
		expect(t.recount()).toBe(t.size.bytes);
		t.clear();
		push(t, "start", "bash", { args: { command: "pwd" } });
		expect(t.view().items).toEqual([]);
	});
	it("refuses extra keys, hidden payloads, duplicate labels, oversized arrays and multibyte fields", () => {
		const t = new LiveTranscriptV0();
		push(t, "start", "bash", { args: { command: "git status --short" } });
		const page = wire(t);
		const reported = { label: "Command", state: "reported", text: "pwd" };
		for (const fields of [
			[{ ...reported, raw: secret }],
			[{ ...reported, state: "withheld" }],
			[reported, reported],
			[{ ...reported, text: "漢".repeat(200) }],
			Array(4).fill(reported),
		]) {
			expect(readWorkbenchTranscript({ ...page, items: [{ ...page.items[0], fields }] })).toBeNull();
		}
	});
});
