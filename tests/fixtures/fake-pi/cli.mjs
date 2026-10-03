#!/usr/bin/env node
// A fake Pi for the deterministic suite: a real child process speaking Pi 1.0.0's documented RPC records over JSONL
// on stdin/stdout (packages/coding-agent/docs/rpc.md, rpc-commands.md, json.md). It is NOT Pi and proves nothing about
// a real Pi release; it exists so the adapter's subprocess, framing, correlation, recovery and evidence paths run end
// to end without a provider or network.
//
// Its version is the "version" of the nearest package.json above this file, like an npm-installed Pi. Behaviour is
// steered by environment variables:
//   FAKE_PI_SCENARIO    comma-separated faults: fragment, batch, garbage, reorder, exit-on:<command>,
//                       hang-on:<command>, exit-immediately, version-fail, version-garbage, active-tools,
//                       entries-lie, no-usage, no-tool-call, lose-session, ignore-eof, dup-entries,
//                       mutate-on:<command> (rewrites its own package version: an external update mid-check),
//                       dialog-on-start (blocks every response until an extension dialog is answered),
//                       run-ids (adds an undocumented runId to lifecycle events)
//   FAKE_PI_STEP_MS     delay between streamed run steps (default 20)
//   FAKE_PI_LOG         a file that receives one line per command received (for assertions)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
function nearestPackageDirectory() {
	let directory = here;
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(directory, "package.json"))) return directory;
		directory = dirname(directory);
	}
	return undefined;
}
const packageDirectory = nearestPackageDirectory();
function nearestVersion() {
	return packageDirectory === undefined
		? "0.0.0"
		: JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).version;
}
// Faults come from FAKE_PI_SCENARIO and from a `scenario` file beside the package.json (an installation property,
// visible even to `--version`, which runs with a minimal environment).
const scenarioFile = packageDirectory === undefined ? undefined : join(packageDirectory, "scenario");
const scenario = new Set(
	[process.env.FAKE_PI_SCENARIO ?? "", scenarioFile !== undefined && existsSync(scenarioFile) ? readFileSync(scenarioFile, "utf8").trim() : ""]
		.join(",")
		.split(",")
		.filter(Boolean),
);
const has = (name) => scenario.has(name);
const option = (prefix) => [...scenario].find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
const stepMs = Number(process.env.FAKE_PI_STEP_MS ?? 20);

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
	if (has("version-fail")) process.exit(3);
	process.stdout.write(has("version-garbage") ? "pi build from source (dirty)\n" : `${nearestVersion()}\n`);
	process.exit(0);
}
if (argv[0] !== "--mode" || argv[1] !== "rpc") {
	process.stderr.write("fake pi supports only --version and --mode rpc\n");
	process.exit(2);
}
if (has("exit-immediately")) process.exit(7);
const flag = (name) => {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
};
const tools = argv.includes("--no-tools") ? [] : (flag("--tools")?.split(",") ?? ["read", "bash", "edit", "write"]);
const ephemeral = argv.includes("--no-session");
const sessionDir = flag("--session-dir");
const requestedId = flag("--session-id");
const sessionId = requestedId ?? `fake-${Math.random().toString(16).slice(2, 10)}`;
const sessionFile = !ephemeral && sessionDir !== undefined ? join(sessionDir, `${sessionId}.json`) : undefined;
const provider = flag("--provider") ?? "fake";
const modelId = flag("--model") ?? "fake-1";

let thinkingLevel = "off";
let model = { provider, id: modelId };
let entries = [];
let persisted = false;
if (sessionFile !== undefined && existsSync(sessionFile) && !has("lose-session")) {
	const saved = JSON.parse(readFileSync(sessionFile, "utf8"));
	entries = saved.entries;
	thinkingLevel = saved.thinkingLevel;
	persisted = true;
} else if (requestedId !== undefined) {
	process.stderr.write(`Warning: No project session found with id '${requestedId}'; creating a new session with that id.\n`);
}
const newId = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0");
const now = () => new Date().toISOString();
function append(entry) {
	const leaf = entries.at(-1)?.id ?? null;
	const full = { ...entry, id: newId(), parentId: leaf, timestamp: now() };
	entries.push(full);
	if (entry.type === "message") persisted = true;
	save();
	return full;
}
function save() {
	if (sessionFile === undefined || !persisted) return;
	mkdirSync(dirname(sessionFile), { recursive: true });
	writeFileSync(sessionFile, JSON.stringify({ entries, thinkingLevel }));
}
if (entries.length === 0) append({ type: "thinking_level_change", thinkingLevel });

// --- output ---
const pending = [];
let flushing = false;
function emit(record) {
	pending.push(`${JSON.stringify(record)}\n`);
	if (!flushing) {
		flushing = true;
		setImmediate(flush);
	}
}
function flush() {
	flushing = false;
	const text = pending.splice(0).join("");
	if (text.length === 0) return;
	if (has("fragment")) {
		// Split everywhere, including inside multi-byte characters and between CR and LF.
		const bytes = Buffer.from(text);
		for (let offset = 0; offset < bytes.length; offset += 3) process.stdout.write(bytes.subarray(offset, offset + 3));
	} else process.stdout.write(text);
}
const respond = (id, command, data) =>
	emit({ ...(id === undefined ? {} : { id }), type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
const refuse = (id, command, error) =>
	emit({ ...(id === undefined ? {} : { id }), type: "response", command, success: false, error });

// --- runs ---
let running = null;
const steering = [];
const followUps = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const usage = (input, output) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	reasoning: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
});
function queueUpdate() {
	emit({ type: "queue_update", steering: [...steering], followUp: [...followUps] });
}
async function turn(run, userText) {
	emit({ type: "turn_start" });
	if (userText !== undefined) {
		const user = { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() };
		emit({ type: "message_start", message: user });
		emit({ type: "message_end", message: user });
		append({ type: "message", message: user });
	}
	const long = /forty/.test(userText ?? "");
	const steps = long ? 40 : 2;
	const wantsTool = /read tool/.test(userText ?? "") && tools.includes("read") && !has("no-tool-call");
	emit({ type: "message_start", message: { role: "assistant", content: [], stopReason: "pending" } });
	for (let step = 0; step < steps; step += 1) {
		if (run.aborted) break;
		await sleep(stepMs);
		emit({ type: "message_update", usage: usage(0, step), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `${step} ` } });
	}
	const assistant = {
		role: "assistant",
		content: [{ type: "text", text: run.aborted ? "" : "fake reply" }],
		provider: model.provider,
		model: model.id,
		...(has("no-usage") ? {} : { usage: usage(11, steps) }),
		stopReason: run.aborted ? "aborted" : wantsTool ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
	emit({ type: "message_end", message: assistant });
	append({ type: "message", message: assistant });
	const toolResults = [];
	if (wantsTool && !run.aborted) {
		const toolCallId = `call_${newId()}`;
		emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: { path: "endophasia-study.txt" } });
		await sleep(stepMs);
		emit({ type: "tool_execution_end", toolCallId, toolName: "read", result: { content: [{ type: "text", text: "Endophasia" }] }, isError: false });
		const result = { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text: "Endophasia" }], isError: false, timestamp: Date.now() };
		append({ type: "message", message: result });
		toolResults.push(result);
	}
	emit({ type: "turn_end", message: assistant, toolResults });
	return wantsTool && !run.aborted;
}
async function startRun(text) {
	const run = { aborted: false, id: `run-${newId()}` };
	running = run;
	emit({ type: "agent_start", ...(has("run-ids") ? { runId: run.id } : {}) });
	let next = text;
	for (;;) {
		const again = await turn(run, next);
		next = undefined;
		if (run.aborted) break;
		if (steering.length > 0) {
			next = steering.shift();
			queueUpdate();
			continue;
		}
		if (again) {
			next = undefined;
			await turn(run, undefined);
		}
		break;
	}
	emit({ type: "agent_end", messages: [], willRetry: false, ...(has("run-ids") ? { runId: run.id } : {}) });
	running = null;
	if (!run.aborted && followUps.length > 0) {
		const follow = followUps.shift();
		queueUpdate();
		await startRun(follow);
		return;
	}
	emit({ type: "agent_settled" });
}

// --- commands ---
const log = (line) => {
	if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${line}\n`);
};
const held = [];
function state() {
	return {
		model: { ...model, name: model.id, api: "openai-completions", baseUrl: "http://127.0.0.1/fake", reasoning: false },
		thinkingLevel,
		isStreaming: running !== null,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		...(ephemeral ? {} : { sessionFile: sessionFile ?? "/tmp/fake.jsonl" }),
		sessionId,
		autoCompactionEnabled: true,
		messageCount: entries.filter((entry) => entry.type === "message").length,
		pendingMessageCount: steering.length + followUps.length,
	};
}
let dialogOpen = has("dialog-on-start");
const blocked = [];
async function handle(command) {
	const { id, type } = command;
	if (type === "extension_ui_response") {
		if (command.id === "dialog-1") {
			dialogOpen = false;
			for (const release of blocked.splice(0)) void handle(release);
		}
		return;
	}
	if (dialogOpen) {
		blocked.push(command);
		return;
	}
	log(type);
	if (option("exit-on:") === type) process.exit(9);
	if (option("mutate-on:") === type && packageDirectory !== undefined) {
		const manifest = join(packageDirectory, "package.json");
		writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "9.9.9" }));
	}
	if (option("hang-on:") === type) return;
	switch (type) {
		case "get_state":
			if (has("reorder") && id !== undefined) {
				held.push(() => respond(id, type, state()));
				return;
			}
			return respond(id, type, state());
		case "get_entries": {
			if (command.since !== undefined) {
				const index = entries.findIndex((entry) => entry.id === command.since);
				if (index === -1) return refuse(id, type, `Entry not found: ${command.since}`);
				const after = entries.slice(index + 1);
				return respond(id, type, { entries: has("entries-lie") ? entries : after, leafId: entries.at(-1)?.id ?? null });
			}
			if (has("dup-entries") && entries.length > 0)
				return respond(id, type, { entries: [...entries, entries[0]], leafId: entries.at(-1)?.id ?? null });
			return respond(id, type, { entries, leafId: entries.at(-1)?.id ?? null });
		}
		case "get_tree": {
			const nodes = new Map(entries.map((entry) => [entry.id, { entry, children: [] }]));
			const roots = [];
			for (const entry of entries) {
				const node = nodes.get(entry.id);
				if (entry.parentId !== null && nodes.has(entry.parentId)) nodes.get(entry.parentId).children.push(node);
				else roots.push(node);
			}
			return respond(id, type, { tree: roots, leafId: entries.at(-1)?.id ?? null });
		}
		case "get_session_stats": {
			const assistant = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			const sum = (key) => assistant.reduce((total, entry) => total + (entry.message.usage?.[key] ?? 0), 0);
			respond(id, type, {
				...(ephemeral ? {} : { sessionFile: sessionFile ?? "/tmp/fake.jsonl" }),
				sessionId,
				userMessages: entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length,
				assistantMessages: assistant.length,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: entries.filter((entry) => entry.type === "message").length,
				tokens: { input: sum("input"), output: sum("output"), cacheRead: 0, cacheWrite: 0, total: sum("totalTokens") },
				cost: assistant.length * 0.001,
			});
			for (const release of held.splice(0)) release();
			return;
		}
		case "get_available_models":
			return respond(id, type, { models: [{ ...model, name: model.id, api: "openai-completions" }] });
		case "set_model":
			if (command.provider !== model.provider || command.modelId !== model.id)
				return refuse(id, type, `Model not found: ${command.provider}/${command.modelId}`);
			append({ type: "model_change", provider: model.provider, modelId: model.id });
			return respond(id, type, { ...model, name: model.id, api: "openai-completions" });
		case "get_available_thinking_levels":
			return respond(id, type, { levels: ["off", "low", "high"] });
		case "set_thinking_level":
			if (!["off", "low", "high"].includes(command.level)) return refuse(id, type, "Unsupported thinking level");
			if (command.level !== thinkingLevel) {
				thinkingLevel = command.level;
				append({ type: "thinking_level_change", thinkingLevel });
				emit({ type: "thinking_level_changed", level: thinkingLevel });
			}
			return respond(id, type);
		case "set_session_name":
			append({ type: "session_info", name: command.name });
			emit({ type: "session_info_changed", name: command.name });
			return respond(id, type);
		case "get_active_tools":
			if (has("active-tools")) return respond(id, type, { tools });
			return refuse(id, type, `Unknown command: ${type}`);
		case "prompt":
			if (running !== null) {
				if (command.streamingBehavior === "steer") {
					steering.push(command.message);
					queueUpdate();
					return respond(id, type, { disposition: "queued" });
				}
				return refuse(id, type, "Agent is already processing");
			}
			respond(id, type, { disposition: "started" });
			void startRun(command.message);
			return;
		case "steer":
			steering.push(command.message);
			queueUpdate();
			return respond(id, type, { disposition: "queued" });
		case "follow_up":
			followUps.push(command.message);
			queueUpdate();
			return respond(id, type, { disposition: "queued" });
		case "abort":
			if (running !== null) running.aborted = true;
			while (running !== null) await sleep(5);
			return respond(id, type);
		case "clear_queue": {
			const cleared = { steering: steering.splice(0), followUp: followUps.splice(0) };
			queueUpdate();
			return respond(id, type, cleared);
		}
		default:
			return refuse(id, type, `Unknown command: ${type}`);
	}
}

if (has("dialog-on-start")) {
	emit({ type: "extension_ui_request", id: "dialog-1", method: "select", title: "Pick one", options: ["a", "b"] });
}

if (has("garbage")) {
	process.stdout.write("this is not json\n");
	emit({ type: "response", command: "get_state", success: true, data: {} });
	emit({ id: "endophasia-999", type: "response", command: "get_state", success: true, data: {} });
	emit({ type: "some_future_event", detail: "x" });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		let command;
		try {
			command = JSON.parse(line);
		} catch (error) {
			refuse(undefined, "parse", `Failed to parse command: ${error.message}`);
			continue;
		}
		void handle(command);
	}
});
process.stdin.on("end", async () => {
	if (has("ignore-eof")) {
		setInterval(() => {}, 1000);
		return;
	}
	while (running !== null) await sleep(5);
	setImmediate(() => process.exit(0));
});
