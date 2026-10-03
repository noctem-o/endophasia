/**
 * The Pi attachment end to end against the fake Pi (tests/fixtures/fake-pi): a real child process speaking Pi's
 * documented RPC records over JSONL. These tests exercise the same code paths a real Pi attachment uses: identity,
 * change records, notifications, local checks, the authorization-gated live study, evidence-gated controls, durable
 * ingestion with opaque cursors, reconnect, deduplication and replay. They do NOT prove compatibility with any real
 * Pi release; tests/pi-real-runtime.test.ts does that, opt-in, against an installed Pi.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0, PiCapabilityNotAdmittedErrorV0 } from "../adapters/pi/attachment.ts";
import { PI_NOT_MANAGED_LINE } from "../adapters/pi/evidence.ts";
import { piEntryEventIdV0 } from "../adapters/pi/mapping.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { validateEndoCapabilityStateV0, validateEndoSourceEntryRefV0 } from "../protocol/harness.ts";
import { replayEndoEventRecordV0 } from "../runtime/contracts/event-replay.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { type FakePiInstall, fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

function setup(version = "1.0.0", scenario = "") {
	const install = installFakePi(version);
	if (scenario !== "") install.setScenario(scenario);
	const root = mkdtempSync(join(tmpdir(), "endo-pi-attach-"));
	const cwd = mkdtempSync(join(tmpdir(), "endo-pi-cwd-"));
	cleanup.push(() => {
		install.remove();
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	return { install, root, cwd };
}

function attachment(install: FakePiInstall, root: string, cwd: string, extra: Record<string, unknown> = {}) {
	return new PiAttachmentV0({
		root,
		cwd,
		executable: install.bin,
		env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
		requestTimeoutMs: 10_000,
		...extra,
	});
}

function allEvents(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root);
	const events = store.page({ limit: 10_000 }).events;
	store.close();
	return events;
}

function hashTree(directory: string): string {
	const hash = createHash("sha256");
	const walk = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(path, entry.name);
			hash.update(full);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) hash.update(readFileSync(full));
		}
	};
	walk(directory);
	return hash.digest("hex");
}

describe("identify, check, state", () => {
	it("first attachment: records the fingerprint, a first-observation change and a neutral notice", async () => {
		const { install, root, cwd } = setup();
		const pi = attachment(install, root, cwd);
		const { fingerprint, change, notification } = await pi.identify();
		expect(fingerprint?.reported.version).toBe("1.0.0");
		expect(fingerprint?.identity.confidence).toBe("strong");
		expect(fingerprint?.local.package?.name).toBe("@earendil-works/pi-coding-agent");
		expect(change.kind).toBe("first-observation");
		expect(notification?.kind).toBe("runtime-first-observed");
		expect(notification?.lines.at(-1)).toBe(PI_NOT_MANAGED_LINE);
		const state = pi.state();
		expect(state.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
	});

	it("local checks run automatically, admit only what they establish, and leave live capabilities unverified", async () => {
		const { install, root, cwd } = setup();
		const pi = attachment(install, root, cwd);
		const { ran, state } = await pi.checkLocal();
		expect(ran).toBe(true);
		expect(validateEndoCapabilityStateV0(state)).not.toBeNull();
		const status = Object.fromEntries(state.capabilities.map((entry) => [entry.capability, entry.status]));
		expect(status).toMatchObject({
			"session.identity": "admitted",
			"session.entries-cursor": "admitted",
			"continuity.active-path": "admitted",
			"session.overview": "admitted-partial",
			"runtime.metrics": "admitted-partial",
			"control.model": "admitted",
			"control.thinking": "admitted",
			"control.active-tools": "unavailable",
			"run.identity": "unavailable",
			"operation.outcome": "unavailable",
			"lifecycle.trace": "unverified",
			"steering.steer": "unverified",
			"steering.stop": "unverified",
			"tool.activity": "unverified",
		});
		const classification = Object.fromEntries(
			state.capabilities.map((entry) => [entry.capability, entry.classification]),
		);
		expect(classification["session.identity"]).toBe("QUALIFIED");
		expect(classification["session.entries-cursor"]).toBe("EXACT");
		// Every evidence record cites a stored transcript.
		for (const evidence of pi.registry.list("evidence")) expect(evidence.evidence[0]).toMatch(/^[0-9a-f]{64}$/);
	});

	it("reuses valid evidence on a later attachment of the same runtime instead of re-running checks", async () => {
		const { install, root, cwd } = setup();
		await attachment(install, root, cwd).checkLocal();
		const again = attachment(install, root, cwd);
		const { change } = await again.identify();
		expect(change.kind).toBe("unchanged");
		const result = await again.checkLocal();
		expect(result.ran).toBe(false);
		expect(result.state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe("admitted");
	});

	it("a changed runtime invalidates evidence, notifies neutrally, and re-checks before admitting again", async () => {
		const { install, root, cwd } = setup();
		await attachment(install, root, cwd).checkLocal();
		install.setVersion("1.0.1");
		const pi = attachment(install, root, cwd);
		const { change, notification } = await pi.identify();
		expect(change.kind).toBe("changed");
		expect(change.differences).toEqual(["package", "version"]);
		expect(change.versionOrder).toBe("higher");
		expect(notification?.title).toBe("Pi runtime changed");
		expect(notification?.lines[0]).toMatch(/^Previously observed: 1\.0\.0 \/ fingerprint [0-9a-f]{12}/);
		expect(notification?.lines[1]).toMatch(/^Currently detected: 1\.0\.1 \/ fingerprint [0-9a-f]{12}/);
		expect(notification?.lines).toContain(
			"Previous conformance evidence may no longer apply. Capabilities dependent on that evidence are now unverified.",
		);
		const text = notification?.lines.join("\n") ?? "";
		expect(text).not.toMatch(/update (is )?available|please (update|upgrade)|run .*install/i);
		// Nothing admitted between the change and new evidence.
		const stale = pi.state();
		expect(stale.capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		expect(stale.capabilities.find((entry) => entry.capability === "control.model")?.reason).toMatch(
			/different runtime fingerprint/,
		);
		const { ran, state } = await pi.checkLocal();
		expect(ran).toBe(true);
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe("admitted");
		// 1.0.1 is untested: the static-surface classification is not applied to it.
		expect(state.capabilities.find((entry) => entry.capability === "operation.outcome")?.status).toBe("unverified");
	});

	it("detects a downgrade, a rebuild with the same version, and a different executable as changes", async () => {
		const { install, root, cwd } = setup("1.0.0");
		const first = await attachment(install, root, cwd).identify();
		install.setVersion("0.99.2");
		const down = await attachment(install, root, cwd).identify();
		expect(down.change.kind).toBe("changed");
		expect(down.change.versionOrder).toBe("lower");
		expect(down.notification?.title).toBe("Pi runtime changed");
		install.rebuild("local build");
		const rebuilt = await attachment(install, root, cwd).identify();
		expect(rebuilt.change.kind).toBe("changed");
		expect(rebuilt.change.differences).toEqual(["entrypoint"]);
		expect(rebuilt.change.versionOrder).toBe("equal");
		const other = installFakePi("0.99.2");
		other.rebuild("local build");
		cleanup.push(() => other.remove());
		const moved = await attachment(other, root, cwd).identify();
		expect(moved.change.kind).toBe("changed");
		expect(moved.change.differences).toEqual(["realPath"]);
		expect(first.change.kind).toBe("first-observation");
	});

	it("an unparseable version reduces identity confidence and never carries evidence across observations", async () => {
		const { install, root, cwd } = setup("1.0.0", "version-garbage");
		const pi = attachment(install, root, cwd);
		const { fingerprint } = await pi.identify();
		expect(fingerprint?.reported.versionText).toBe("pi build from source (dirty)");
		expect(fingerprint?.reported.version).toBeNull();
		expect(fingerprint?.identity.confidence).toBe("reduced");
		expect(fingerprint?.gaps.map((gap) => gap.fact)).toEqual(["version"]);
		const checked = await pi.checkLocal();
		expect(checked.state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe("admitted");
		const later = attachment(install, root, cwd);
		await later.identify();
		const state = later.state();
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.status).toBe("unverified");
		expect(state.capabilities.find((entry) => entry.capability === "control.model")?.reason).toMatch(
			/reduced-confidence/,
		);
	});

	it("a failing version command is a gap, not a fabricated version", async () => {
		const { install, root, cwd } = setup("1.0.0", "version-fail");
		const { fingerprint } = await attachment(install, root, cwd).identify();
		expect(fingerprint?.reported).toEqual({ versionText: null, version: null });
		expect(fingerprint?.gaps).toEqual([{ fact: "version", reason: "--version failed (exit 3)" }]);
	});

	it("a missing executable is a collection failure: surfaced, nothing admitted, no session opened", async () => {
		const { install, root, cwd } = setup();
		await attachment(install, root, cwd).checkLocal();
		const pi = attachment(install, root, cwd, { executable: join(root, "no-such-pi") });
		const { fingerprint, change, notification } = await pi.identify();
		expect(fingerprint).toBeNull();
		expect(change.kind).toBe("collection-failed");
		expect(change.failure).toMatch(/not an executable file/);
		expect(notification?.kind).toBe("runtime-unidentified");
		expect(pi.state().capabilities.every((entry) => entry.status === "unverified")).toBe(true);
		await expect(pi.openSession()).rejects.toThrow(/could not be identified/);
	});

	it("never modifies the installation it observes", async () => {
		const { install, root, cwd } = setup();
		const before = hashTree(install.prefix);
		const pi = attachment(install, root, cwd);
		await pi.checkLocal();
		await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		const session = await pi.openSession();
		await session.close();
		expect(hashTree(install.prefix)).toBe(before);
	});
});

describe("evidence classification of surface differences", () => {
	it("a cursor that does not mean strictly-after is a MISMATCH, not admitted", async () => {
		const { install, root, cwd } = setup("1.0.0", "entries-lie");
		const { state } = await attachment(install, root, cwd).checkLocal();
		const cursor = state.capabilities.find((entry) => entry.capability === "session.entries-cursor");
		expect(cursor?.status).toBe("mismatch");
		expect(cursor?.classification).toBe("MISMATCH");
	});

	it("an unexpected active-tools command is reported as a mismatch needing review, not silently used", async () => {
		const { install, root, cwd } = setup("1.0.0", "active-tools");
		const { state } = await attachment(install, root, cwd).checkLocal();
		expect(state.capabilities.find((entry) => entry.capability === "control.active-tools")?.status).toBe("mismatch");
	});
});

describe("live study", () => {
	it("refuses without explicit authorization", async () => {
		const { install, root, cwd } = setup();
		const pi = attachment(install, root, cwd);
		await expect(pi.studyLive({ authorized: false } as unknown as { authorized: true })).rejects.toThrow(
			/authorization/,
		);
		expect(pi.registry.list("evidence")).toHaveLength(0);
	});

	it("records evidence for what it observed and leaves inconclusive steps unverified", async () => {
		const { install, root, cwd } = setup("1.0.0", "no-tool-call");
		const pi = attachment(install, root, cwd);
		await pi.checkLocal();
		const { state, inconclusive } = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		const status = Object.fromEntries(state.capabilities.map((entry) => [entry.capability, entry.status]));
		expect(status).toMatchObject({
			"lifecycle.trace": "admitted-partial",
			"usage.entries": "admitted",
			"steering.steer": "admitted-partial",
			"steering.follow-up": "admitted-partial",
			"steering.stop": "admitted-partial",
			"session.identity": "admitted",
			"tool.activity": "unverified",
		});
		expect(state.capabilities.find((entry) => entry.capability === "session.identity")?.classification).toBe("EXACT");
		expect(inconclusive.some((line) => line.startsWith("tool.activity"))).toBe(true);
	});

	it("observes correlated tool activity when the model calls a tool", async () => {
		const { install, root, cwd } = setup();
		const pi = attachment(install, root, cwd);
		const { state } = await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		expect(state.capabilities.find((entry) => entry.capability === "tool.activity")?.classification).toBe("EXACT");
	});

	it("live evidence depends on provider and model: changing them leaves live capabilities unverified", async () => {
		const { install, root, cwd } = setup();
		await attachment(install, root, cwd).studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		const other = attachment(install, root, cwd, { provider: "fake", model: "fake-2" });
		await other.identify();
		const state = other.state();
		expect(state.capabilities.find((entry) => entry.capability === "lifecycle.trace")?.status).toBe("unverified");
		expect(state.capabilities.find((entry) => entry.capability === "lifecycle.trace")?.reason).toMatch(
			/configuration changed/,
		);
	});
});

describe("session attachment", () => {
	async function ready(scenario = "") {
		const { install, root, cwd } = setup("1.0.0", scenario);
		const pi = attachment(install, root, cwd);
		await pi.checkLocal();
		await pi.studyLive({ authorized: true, stepTimeoutMs: 20_000 });
		return { install, root, cwd, pi };
	}

	it("records a prompted run: lifecycle events, entries with opaque source refs, and no payload text", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		expect(await session.prompt("hello there")).toBe("started");
		expect(await session.waitForSettled(10_000)).toBe(true);
		const piSessionId = session.piSessionId!;
		await session.close();
		const events = allEvents(root);
		const kinds = events.map((event) => event.kind);
		expect(kinds).toContain("harness.attached");
		for (const kind of [
			"agent.run-started",
			"agent.turn-started",
			"message.completed",
			"agent.run-ended",
			"agent.settled",
		])
			expect(kinds).toContain(kind);
		const entries = events.filter((event) => event.kind === "session.entry-observed");
		expect(entries.length).toBeGreaterThanOrEqual(3);
		for (const event of entries) {
			const source = (event.payload as { source: unknown }).source;
			expect(validateEndoSourceEntryRefV0(source)).not.toBeNull();
			const { entryId } = source as { entryId: string };
			expect(event.id).toBe(piEntryEventIdV0(piSessionId, entryId));
			expect(event.coordinates).toEqual({ sessionId: `endo.session.pi.${piSessionId}` });
		}
		// Endophasia's sequence is its own: monotonic per producer, unrelated to Pi's entry ids.
		const sequences = events
			.filter((event) => event.producer === "pi-rpc-adapter:pi.default")
			.map((event) => event.sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(sequences.length);
		// No message text, prompt text or tool output is stored anywhere.
		const serialized = JSON.stringify(events);
		expect(serialized).not.toContain("hello there");
		expect(serialized).not.toContain("fake reply");
		// No run id is invented.
		expect(events.every((event) => event.coordinates.runId === undefined)).toBe(true);
	});

	it("recovers from a crashed Pi: records the exit, reconnects, catches up from the opaque cursor without duplicates", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		await session.prompt("first");
		await session.waitForSettled(10_000);
		const before = allEvents(root).filter((event) => event.kind === "session.entry-observed").length;
		const pid = session.pid;
		if (pid === undefined) throw new Error("Pi is not running");
		process.kill(pid, "SIGKILL");
		const exit = await session.exited();
		expect(exit?.signal).toBe("SIGKILL");
		await session.reconnect();
		await session.prompt("second");
		await session.waitForSettled(10_000);
		await session.close();
		const events = allEvents(root);
		const exitEvent = events.find((event) => event.kind === "harness.process-exited");
		expect(exitEvent?.payload).toMatchObject({ signal: "SIGKILL", expected: false });
		const entryEvents = events.filter((event) => event.kind === "session.entry-observed");
		expect(new Set(entryEvents.map((event) => event.id)).size).toBe(entryEvents.length);
		expect(entryEvents.length).toBeGreaterThan(before);
		expect(events.filter((event) => event.kind === "harness.attached")).toHaveLength(2);
		expect(session.counters.reconnects).toBe(1);
	});

	it("falls back to a full, deduplicated read when Pi no longer knows the recorded cursor", async () => {
		const { install, root, pi } = await ready();
		const session = await pi.openSession();
		await session.prompt("first");
		await session.waitForSettled(10_000);
		await session.close();
		install.setScenario("lose-session");
		// The installation changed (scenario file is not the entrypoint, so the fingerprint is unchanged): reattach.
		const again = await pi.openSession();
		await again.close();
		const catchUps = allEvents(root).filter((event) => event.kind === "harness.catch-up");
		expect(catchUps.at(-1)?.payload).toMatchObject({ mode: "full-after-refusal" });
		const entries = allEvents(root).filter((event) => event.kind === "session.entry-observed");
		expect(new Set(entries.map((event) => event.id)).size).toBe(entries.length);
	});

	it("records malformed records and unknown events as faults, never as observations", async () => {
		const { root, pi } = await ready("garbage,fragment");
		const session = await pi.openSession();
		await session.close();
		const events = allEvents(root);
		const faults = events.filter((event) => event.kind === "harness.protocol-fault").map((event) => event.payload);
		expect(faults).toEqual(
			expect.arrayContaining([
				{ fault: "malformed-json" },
				{ fault: "response-without-id" },
				{ fault: "unknown-response-id" },
			]),
		);
		expect(events.some((event) => event.kind === "runtime.unrecognized-event")).toBe(true);
		expect(session.piSessionId).not.toBeNull();
	});

	it("offers controls only for admitted capabilities, records acceptance separately from effects", async () => {
		const { install, root, cwd } = setup();
		const unverified = attachment(install, root, cwd);
		await unverified.checkLocal();
		const session = await unverified.openSession();
		await expect(session.steer("x")).rejects.toBeInstanceOf(PiCapabilityNotAdmittedErrorV0);
		await expect(session.stop()).rejects.toBeInstanceOf(PiCapabilityNotAdmittedErrorV0);
		await session.setThinkingLevel("low");
		await session.close();
		const events = allEvents(root);
		const accepted = events.find((event) => event.kind === "control.accepted");
		expect(accepted?.payload).toMatchObject({ capability: "control.thinking", action: "set_thinking_level" });
		// Steering was never sent to Pi.
		expect(events.some((event) => (event.payload as { capability?: unknown }).capability === "steering.steer")).toBe(
			false,
		);
	});

	it("replays the recorded stream deterministically", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		await session.prompt("hello");
		await session.waitForSettled(10_000);
		await session.close();
		const store = createEndoDurableEventStoreV0(root);
		const record = store.record("endo.evidence.pi-session-record");
		store.close();
		const reopened = createEndoDurableEventStoreV0(root);
		const again = reopened.record("endo.evidence.pi-session-record");
		reopened.close();
		expect(again.digest).toBe(record.digest);
		const replay = replayEndoEventRecordV0(record);
		expect(replay.events).toBe("exact");
		expect(replay.derived).toBe("exact");
	});

	it("never creates runtime admission, promotion or authority records", async () => {
		const { root, pi } = await ready();
		const session = await pi.openSession();
		await session.close();
		const kinds = new Set(pi.registry.list("evidence").map((record) => record.schemaVersion));
		expect([...kinds]).toEqual(["endo.capability-evidence.v0"]);
		// Runtime facts, plus lifecycle interpretations each derived from exactly one recorded fact; nothing else.
		const events = allEvents(root);
		const facts = new Set(events.filter((event) => event.source === "runtime-fact").map((event) => event.id));
		for (const event of events.filter((candidate) => candidate.source !== "runtime-fact")) {
			expect(event.source).toBe("interpretation");
			expect(event.kind.startsWith("lifecycle.")).toBe(true);
			expect(event.derivedFrom).toHaveLength(1);
			expect(facts.has(event.derivedFrom[0]!)).toBe(true);
		}
		expect(readdirSync(root).sort()).toEqual(["artifacts", "events", "harness", "pi-sessions"]);
	});
});
