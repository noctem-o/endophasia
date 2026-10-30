// The Field appearance's two pure adapters (studio-ui/src/model/field.ts, model/ledger.ts): what the field may show for each state the
// page can hold, and what the ledger says. The rules pinned here are the honesty rules of docs/develop-field.md: a report is shown as
// current only while it is being re-read, a recording never moves, unreachable is not disconnected, the approval is the terminal's, and
// reading stills the field.
import { describe, expect, it } from "vitest";
import { type FieldInput, fieldSignal } from "../studio-ui/src/model/field.ts";
import { type LedgerInput, ledger } from "../studio-ui/src/model/ledger.ts";
import type { Project } from "../studio-ui/src/model/project-wire.ts";
import type { WorkbenchStatus } from "../studio-ui/src/model/workbench-wire.ts";

const input = (over: Partial<FieldInput> = {}): FieldInput => ({
	surface: "conversation",
	workbench: "available",
	connection: "connected",
	run: "idle",
	unreachable: false,
	following: false,
	awaiting: null,
	stopping: false,
	received: 4,
	paused: false,
	...over,
});

describe("the field signal", () => {
	it("flows only for a run Pi reports open AND the page is re-reading; otherwise the report is still, as last read", () => {
		const followed = fieldSignal(input({ run: "active", following: true }));
		expect(followed.motion).toBe("current");
		expect(followed.words).toContain("re-read every few seconds");
		expect(followed.words).toContain("not the model's work");
		const stale = fieldSignal(input({ run: "active", following: false }));
		expect(stale.motion).toBe("still");
		expect(stale.words).toContain("at the last read");
		expect(stale.words).toContain("Follow");
	});

	it("never moves for a recording, whatever its last recorded state, and says nothing recorded is live", () => {
		for (const run of ["active", "idle", "unknown", null] as const)
			for (const workbench of ["absent", "available", "unknown"] as const) {
				const s = fieldSignal(input({ surface: "recording", run, workbench, following: true }));
				expect(s.motion).toBe("still");
				expect(s.tempo).toBe(0);
				expect(s.words).toContain("Nothing recorded is live");
			}
	});

	it("draws an unreachable broker broken (dashed) and still, and a disconnected one still and solid: they are different", () => {
		const unreachable = fieldSignal(input({ unreachable: true, run: "active", following: true, surface: "arrival" }));
		expect(unreachable).toMatchObject({ motion: "still", texture: "dashed", responsive: false });
		expect(unreachable.words).toContain("unreachable is not ended");
		const gone = fieldSignal(input({ connection: "disconnected", surface: "arrival" }));
		expect(gone).toMatchObject({ motion: "still", texture: "solid", responsive: false });
		expect(gone.words).toContain("no admitted connection");
		expect(gone.words).not.toContain("ended");
	});

	it("holds while something waits for the terminal, tints for attention, and says the page cannot approve", () => {
		for (const op of ["prompt", "steer", "queue", "stop"] as const) {
			const s = fieldSignal(input({ awaiting: op, run: "active", following: true, surface: "arrival" }));
			// Held means held: it does not bend under the pointer either.
			expect(s.responsive).toBe(false);
			expect(s).toMatchObject({ motion: "held", attention: true, tempo: 0 });
			expect(s.words).toContain(`a ${op} waits for your approval in the attached terminal`);
			expect(s.words).toContain("This page cannot approve it");
		}
		// Only a live workbench can have something waiting: on a read-only server nothing is ever held for approval.
		expect(fieldSignal(input({ workbench: "absent", awaiting: "steer", surface: "arrival" })).attention).toBe(false);
	});

	it("is still, and pushed back, while changes are read", () => {
		const s = fieldSignal(input({ surface: "changes", run: "active", following: true }));
		expect(s.motion).toBe("still");
		expect(s.presence).toBeLessThan(0.25);
		expect(s.responsive).toBe(false);
	});

	it("drifts as atmosphere where nothing live is claimed, and says so", () => {
		const readOnly = fieldSignal(input({ workbench: "absent", surface: "arrival", connection: null, run: null }));
		expect(readOnly.motion).toBe("drift");
		expect(readOnly.words).toContain("shows no activity");
		expect(readOnly.responsive).toBe(true);
		const idle = fieldSignal(input({ run: "idle" }));
		expect(idle.motion).toBe("drift");
		expect(idle.words).toContain("not activity");
	});

	it("stops when paused, and says it was paused rather than describing motion it does not show", () => {
		const s = fieldSignal(input({ run: "active", following: true, paused: true }));
		expect(s.motion).toBe("still");
		expect(s.words).toMatch(/^Paused by you\. Pi reports a run open/);
		expect(s.words).not.toContain("Flowing");
		expect(fieldSignal(input({ paused: true, surface: "arrival" })).responsive).toBe(false);
	});

	it("carries only a count of received items as its pulse, never what they say", () => {
		const s = fieldSignal(input({ received: 17 }));
		expect(s.pulse).toBe(17);
		expect(Object.keys(s).sort()).toEqual(
			["attention", "motion", "presence", "pulse", "responsive", "tempo", "texture", "words"].sort(),
		);
	});

	it("holds while a stop is on its way to Pi", () => {
		const s = fieldSignal(input({ stopping: true, run: "active", following: true }));
		expect(s.motion).toBe("held");
		expect(s.words).toContain("Pi answers once the run is idle");
	});
});

const status = (over: Partial<WorkbenchStatus> = {}): WorkbenchStatus => ({
	schemaVersion: "endo.workbench-status.v0",
	launchId: "0123456789abcdef",
	harness: "pi",
	connection: "connected",
	run: "idle",
	session: "endo.session.pi.alpha",
	attachment: "pi.default",
	offers: {
		prompt: { offered: true, reason: null },
		steer: { offered: false, reason: "No run is open." },
		queue: { offered: false, reason: "No run is open." },
		stop: { offered: false, reason: "No run is open." },
	},
	paired: true,
	command: null,
	interventions: [],
	transcript: { watermark: 0, firstSeq: 1 },
	...over,
});
const base = (over: Partial<LedgerInput> = {}): LedgerInput => ({
	workbench: "available",
	status: status(),
	statusAt: "10:00:00",
	unreachable: false,
	following: true,
	paired: true,
	awaiting: null,
	project: { kind: "unread" },
	recordings: { condition: "readable", loaded: 3, total: 3, states: { detached: 3 } },
	...over,
});
const text = (lines: readonly { text: string }[]) => lines.map((l) => l.text).join("\n");

describe("the ledger", () => {
	it("on a read-only server: nothing attached, recordings known, no input offered, the way to attach named", () => {
		const l = ledger(base({ workbench: "absent", status: null, statusAt: null, paired: false }));
		expect(l.statement.before).toBe("Nothing is attached here.");
		expect(text(l.known)).toContain("3 recorded sessions in this store");
		expect(l.known.every((line) => line.basis === "recorded")).toBe(true);
		expect(text(l.possible)).not.toMatch(/Prompt|Steer|Queue|Stop|Pair/);
		expect(text(l.yours)).toContain("--control --workbench");
	});

	it("keeps observed (the connection) apart from reported (the run state), each with its basis", () => {
		const l = ledger(base({ status: status({ run: "active" }) }));
		expect(l.statement).toEqual({ before: "", mono: "pi.alpha", after: " is connected, with a run open." });
		expect(l.known[0]).toEqual({
			basis: "observed",
			text: "Connected: admitted by this broker as pi.alpha (read at 10:00:00, browser clock).",
		});
		expect(l.known[1]).toEqual({
			basis: "reported",
			text: "Pi reported a run open (read at 10:00:00, browser clock).",
		});
	});

	it("puts a status that is not being re-read in the past, with the page's read time, never as Pi's time", () => {
		const l = ledger(base({ status: status({ run: "active" }), following: false }));
		expect(l.statement).toEqual({
			before: "",
			mono: "pi.alpha",
			after: " was connected, with a run open, at the last read.",
		});
		expect(l.source).toContain("Not re-read since");
		expect(l.source).toContain("Follow");
		const all = [l.source, ...l.known.map((line) => line.text)].join("\n");
		expect(all).not.toMatch(/Pi reports|is connected/);
		expect(all).toContain("read at 10:00:00, browser clock");
		const gone = ledger(base({ status: status({ connection: "disconnected" }), following: false }));
		expect(gone.statement.after).toBe(" was disconnected at the last read.");
	});

	it("keeps an absent store, an unopenable one, an empty one and a degraded one apart", () => {
		const of = (condition: NonNullable<LedgerInput["recordings"]>["condition"], total = 0) =>
			ledger(
				base({ workbench: "absent", status: null, recordings: { condition, loaded: total, total, states: {} } }),
			);
		const absent = of("absent");
		expect(text(absent.unknown)).toContain("there is no event store here (absent, which is not empty)");
		expect(text(absent.known)).not.toMatch(/holds no|empty/);
		const unopenable = of("unopenable");
		expect(text(unopenable.unknown)).toContain("could not be opened, so what it holds is not known");
		expect(text(unopenable.known)).toBe("");
		expect(text(of("empty").known)).toContain("The event store is empty: it holds no recording.");
		expect(text(of("readable").known)).toContain("This store holds no Pi or DSH recording.");
		expect(text(of("degraded", 4).known)).toContain(
			"4 recorded sessions in this store, listed from the readable part of a degraded log",
		);
		for (const condition of ["absent", "unopenable", "empty"] as const)
			expect(text(of(condition).possible)).not.toContain("Read a recording");
	});

	it("lists what the broker offers, and why not, from its offers alone; an unpaired page is only told to pair", () => {
		const l = ledger(base());
		expect(l.possible.find((p) => p.text.startsWith("Prompt"))?.basis).toBe("reported");
		expect(text(l.possible)).toContain("Steer: no run is open.");
		const unpaired = ledger(base({ paired: false }));
		expect(text(unpaired.possible)).toContain("Pair this page");
		expect(text(unpaired.possible)).not.toMatch(/^(Prompt|Steer|Queue|Stop):/m);
	});

	it("puts every approval in the terminal, and names what waits there", () => {
		const l = ledger(base({ awaiting: { operation: "steer", digest: "abcdef0123456789", expires: "10:15:00" } }));
		expect(l.statement.before).toBe("Waiting for you in the terminal.");
		expect(text(l.yours)).toContain("A steer (digest abcdef0123456789) waits for you in the attached terminal");
		expect(text(l.yours)).toContain("This page can only request.");
		expect(text(l.yours)).toContain("not proof of identity");
	});

	it("says an unreachable broker is not an ending and claims nothing of the last status as known", () => {
		const l = ledger(base({ unreachable: true }));
		expect(l.statement.before).toBe("The broker did not answer.");
		expect(l.source).toContain("Unreachable is not ended.");
		expect(text(l.unknown)).toContain("Whether the session still runs");
		expect(l.known.some((line) => line.basis === "observed" || line.basis === "reported")).toBe(false);
		expect(l.possible.some((line) => /^(Prompt|Steer|Queue|Stop)/.test(line.text))).toBe(false);
	});

	it("names the worktree as read with Git, never as the agent's work, and says Git does not say who changed it", () => {
		const project = {
			repository: { label: "demo", root: "/r/demo", worktreeLabel: "demo", cwdRelative: "" },
			head: { kind: "branch", branch: "main", oid: "0".repeat(40) },
			changes: {
				state: "ready",
				counts: { staged: 2, unstaged: 1, untracked: 0, conflicted: 0, exact: true },
			},
		} as unknown as Project;
		const l = ledger(base({ project: { kind: "ready", project } }));
		expect(text(l.known)).toContain("Worktree demo on main, read with Git: 2 staged · 1 unstaged.");
		expect(text(l.unknown)).toContain("Who changed the files in the worktree: Git does not say.");
		expect(text(l.known)).not.toMatch(/agent (changed|made|wrote)/i);
	});

	it("says a recording last recorded running is not a process", () => {
		const l = ledger(
			base({ recordings: { condition: "readable", loaded: 2, total: 5, states: { running: 1, detached: 1 } } }),
		);
		expect(text(l.known)).toContain("5 recorded sessions in this store (2 listed so far).");
		expect(text(l.unknown)).toContain("A recording is not a process.");
	});
});
