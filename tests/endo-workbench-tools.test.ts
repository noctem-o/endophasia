import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveTranscriptV0 } from "../adapters/pi/live-transcript.ts";
import { readWorkbenchTranscript } from "../studio-ui/src/model/workbench-wire.ts";
import { claimingDescriptor, syntheticActivities, unknownDescriptor } from "./fixtures/private-activity.ts";

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
	it("admits synthetic Codex, Claude and ACP presentations as their own observation types, not adapters", () => {
		const page = {
			...wire(new LiveTranscriptV0()),
			items: syntheticActivities,
			watermark: 7,
			descriptor: unknownDescriptor,
		};
		const read = readWorkbenchTranscript(page);
		expect(read?.items).toEqual(syntheticActivities);
		expect(read?.items.map((i) => i.kind)).toEqual([
			"file-change",
			"file-change",
			"tool",
			"tool",
			"tool",
			"activity",
			"file-change",
		]);
		expect(readWorkbenchTranscript({ ...page, descriptor: claimingDescriptor })).not.toBeNull();
	});
	it("refuses a descriptor that mixes control into observation, is flat, or claims more than its closed vocabulary", () => {
		const page = { ...wire(new LiveTranscriptV0()), descriptor: unknownDescriptor };
		const { observation, providerControls } = unknownDescriptor;
		for (const descriptor of [
			{},
			{ ...observation, ...providerControls },
			{ observation: { ...observation, interrupt: "unknown" }, providerControls },
			{ observation, providerControls: { ...providerControls, fileChanges: "unknown" } },
			{ observation, providerControls: { ...providerControls, interrupt: "supported" } },
			{ observation, providerControls: { ...providerControls, interrupt: true } },
			{ observation, providerControls, authority: "granted" },
			{ observation, providerControls: { ...providerControls, protectedExecution: "assessed" } },
		])
			expect(readWorkbenchTranscript({ ...page, descriptor }), JSON.stringify(descriptor)).toBeNull();
	});
	it("refuses malformed activities: invented tool ids, missing lifecycle discipline, fields a kind cannot carry", () => {
		const page = { ...wire(new LiveTranscriptV0()), watermark: 7, descriptor: unknownDescriptor };
		const [change, , tool, , , other] = syntheticActivities as [any, any, any, any, any, any];
		const bad: [string, unknown][] = [
			["a file change with a tool-call id", { ...change, callId: "c1" }],
			["a file change named as a tool", { ...change, name: "edit" }],
			["a file change with a tool lifecycle state", { ...change, status: "running" }],
			[
				"a file change carrying an exit code",
				{ ...change, status: "completed", seq: 2, fields: [{ label: "Exit code", state: "reported", text: "0" }] },
			],
			["a file change carrying output", { ...change, fields: [{ label: "Output", state: "withheld" }] }],
			["a file change carrying a command", { ...change, fields: [{ label: "Command", state: "withheld" }] }],
			["a tool with a provider item ref", { ...tool, nativeRef: "x" }],
			["a tool with no lifecycle", { ...tool, status: "reported" }],
			["an activity with a tool-call id", { ...other, callId: "c1" }],
			["a lone report that names an earlier occurrence", { ...other, occurrence: 1 }],
			["an in-progress report that is not first", { ...change, seq: 2, occurrence: 1 }],
			["an unknown kind", { ...change, kind: "edit" }],
			["an unbounded source", { ...change, source: "unbounded text" }],
			["a hidden payload", { ...change, raw: secret }],
			["a verified status", { ...change, status: "verified" }],
		];
		for (const [why, item] of bad) expect(readWorkbenchTranscript({ ...page, items: [item] }), why).toBeNull();
	});
	it("keeps every Pi bash, read, edit and write event a Pi-reported tool activity with its native tool-call reference", () => {
		const t = new LiveTranscriptV0();
		for (const [name, args] of [
			["bash", { command: "pwd" }],
			["read", { path: "README.md" }],
			["edit", { path: "README.md", edits: [] }],
			["write", { path: "README.md", content: secret }],
		] as const) {
			push(t, "start", name, { args, toolCallId: name });
			push(t, "end", name, { isError: false, toolCallId: name });
		}
		const items = t.view().items;
		expect(items.every((i) => i.kind === "tool" && i.source === "pi-live")).toBe(true);
		expect(items.map((i) => i.kind === "tool" && [i.name, i.callId, i.category, i.occurrence])).toEqual([
			["bash", "bash", "command", 1],
			["bash", "bash", "command", 1],
			["read", "read", "file-read", 3],
			["read", "read", "file-read", 3],
			["edit", "edit", "file-change", 5],
			["edit", "edit", "file-change", 5],
			["write", "write", "file-change", 7],
			["write", "write", "file-change", 7],
		]);
		// A Pi edit drawn under the file-change category is still a tool invocation: Pi gives no structured file-change feed.
		expect(t.view().descriptor.observation.fileChanges).toBe("unavailable");
		expect(JSON.stringify(t.view())).not.toContain(secret);
	});
	it("describes Pi from what it has: assessed only through the existing assessment, observed only on this connection", () => {
		const assessed = new LiveTranscriptV0((id) => (id === "steering.stop" ? "assessed" : "unknown"));
		expect(assessed.view().descriptor).toEqual({
			observation: {
				nativeSessionIdentity: "unknown",
				stableCallIdentity: "unknown",
				toolBoundaries: "unknown",
				argumentPreview: "unknown",
				resultPreview: "unknown",
				fileChanges: "unavailable",
				subagents: "unavailable",
			},
			providerControls: {
				interrupt: "assessed",
				steer: "unknown",
				approvals: "unavailable",
				toolCancellation: "unavailable",
				resume: "unknown",
			},
		});
		push(assessed, "start", "bash", { args: { command: "pwd" } });
		push(assessed, "end", "bash", { isError: false });
		expect(assessed.view().descriptor.observation).toMatchObject({
			toolBoundaries: "observed",
			argumentPreview: "observed",
			resultPreview: "unknown",
			stableCallIdentity: "unknown",
		});
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

describe("the activity descriptor is presentation, never authority", () => {
	it("is read only by the transcript producer, the page's wire gate, its reducer and its words", () => {
		const roots = [
			"adapters",
			"cli",
			"cockpit",
			"cockpit-http",
			"runtime",
			"protocol",
			"storage",
			"studio-ui/src",
			"trust",
		];
		const files = roots.flatMap((root) =>
			readdirSync(root, { recursive: true, withFileTypes: true })
				.filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
				.map((e) => relative(".", join(e.parentPath, e.name))),
		);
		const readers = files.filter((file) =>
			/private-activity|ActivityDescriptor|activityDescriptor|providerControls|\.descriptor\b/.test(
				readFileSync(file, "utf8"),
			),
		);
		expect(readers.sort()).toEqual([
			"adapters/codex/live-transcript.ts",
			"adapters/pi/live-tool-fields.ts",
			"adapters/pi/live-transcript.ts",
			"protocol/private-activity.ts",
			"studio-ui/src/develop/Live.tsx",
			"studio-ui/src/model/private-activity-wire.ts",
			"studio-ui/src/model/workbench-wire.ts",
			"studio-ui/src/model/workbench.ts",
		]);
		// Every authority path: session control, execution protection, pairing, the broker's offers and dispatch, interventions, the
		// attempt dispatcher, isolation and promotion. None of them can see it.
		for (const file of files.filter((f) =>
			/session-control|execution-protection|protected|workbench-pairing|workbench-interventions|attempt-dispatch|isolat|promot|adapters\/pi\/workbench\.ts/.test(
				f,
			),
		))
			expect(readFileSync(file, "utf8"), file).not.toMatch(
				/private-activity|providerControls|activityDescriptor|\.descriptor\b/,
			);
		// In the page, only the descriptor panel reads it: the composer, the offers and the stop control do not.
		const live = readFileSync("studio-ui/src/develop/Live.tsx", "utf8");
		expect(live.match(/activityDescriptor/g)).toHaveLength(1);
		expect(live).toMatch(/<ActivityDescriptorView descriptor=\{wb\.state\.activityDescriptor\} \/>/);
		expect(readFileSync("studio-ui/src/use-workbench.ts", "utf8")).not.toMatch(/descriptor|providerControls/);
	});
});
