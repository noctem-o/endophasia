// The page's attempts reader (studio-ui/src/model/attempts-reader.ts, used by use-attempts.ts) against controlled, deferred requests: a read belongs to its launch and its
// pairing, an obsolete read can never mark anything current or swallow a newer refresh, refreshes asked for during a read coalesce into one
// that uses the latest grant, and failures (rejected, thrown, aborted) always clear `busy` and leave no unhandled rejection. No timers: each
// request is a promise the test settles by hand, and `flush` only lets already-settled promises run their handlers.
import { describe, expect, it } from "vitest";
import { type AttemptsContext, AttemptsReader, type AttemptsState } from "../studio-ui/src/model/attempts-reader.ts";
import type { AttemptsReply, AttemptsView } from "../studio-ui/src/model/attempts-wire.ts";

interface Call {
	grant: string;
	signal: AbortSignal;
	resolve(reply: AttemptsReply): void;
	reject(error: unknown): void;
}

const view = (taskId: string): AttemptsView => ({
	schemaVersion: "endo.develop-attempts-view.v4",
	state: "ready",
	taskId,
	attempts: [],
	problems: 0,
	head: null,
});
const ok = (taskId: string): AttemptsReply => ({ kind: "attempts", record: view(taskId) });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness() {
	const calls: Call[] = [];
	const published: AttemptsState[] = [];
	const reader = new AttemptsReader(
		(grant, signal) =>
			new Promise<AttemptsReply>((resolve, reject) => {
				calls.push({ grant, signal, resolve, reject });
			}),
		(state) => published.push(state),
	);
	let context: AttemptsContext = { grant: null, launchId: null, active: true, ready: false, trigger: null };
	const set = (change: Partial<AttemptsContext>) => {
		context = { ...context, ...change };
		reader.sync(context);
	};
	return { reader, calls, published, set };
}

/** A launch whose workspace has been read once: the page is paired, ready, and has asked for its first attempts read. */
function launched(launchId = "launch-a", grant = "grant-a") {
	const h = harness();
	h.set({ launchId, grant });
	h.set({ ready: true, trigger: 1 });
	return h;
}

describe("a read belongs to its launch", () => {
	for (const outcome of ["resolves", "rejects"] as const)
		it(`launch A's read, held open across a switch to B, ${outcome} later and never shows; B gets a fresh read`, async () => {
			const h = launched("launch-a", "grant-a");
			expect(h.calls).toHaveLength(1);
			// The switch: the workspace resets (not ready), then B is paired and its workspace read arrives.
			h.set({ launchId: "launch-b", ready: false, trigger: null });
			expect(h.calls[0]!.signal.aborted).toBe(true);
			expect(h.reader.state).toEqual({ view: null, current: false, busy: false, problem: null });
			h.set({ grant: "grant-b" });
			h.set({ ready: true, trigger: 2 });
			expect(h.calls.map((c) => c.grant)).toEqual(["grant-a", "grant-b"]);
			if (outcome === "resolves") h.calls[0]!.resolve(ok("task-of-a"));
			else h.calls[0]!.reject(new DOMException("aborted", "AbortError"));
			await flush();
			expect(h.reader.state.view).toBeNull();
			expect(h.reader.state.busy).toBe(true);
			h.calls[1]!.resolve(ok("task-of-b"));
			await flush();
			expect(h.reader.state).toEqual({ view: view("task-of-b"), current: true, busy: false, problem: null });
			expect(h.published.some((s) => s.view?.taskId === "task-of-a")).toBe(false);
		});

	it("a refresh queued behind launch A's read is not lost when A is abandoned: it runs at once, for B, with B's grant", async () => {
		const h = launched("launch-a", "grant-a");
		h.set({ trigger: 2 }); // queued behind the read in flight
		expect(h.calls).toHaveLength(1);
		// Launch B, already paired, with its workspace ready (the new grant arrives in the same render as the new launch).
		h.set({ launchId: "launch-b", grant: "grant-b", trigger: 3 });
		expect(h.calls.map((c) => c.grant)).toEqual(["grant-a", "grant-b"]);
		h.calls[0]!.resolve(ok("task-of-a"));
		await flush();
		// A's settling neither shows A nor starts another read.
		expect(h.calls).toHaveLength(2);
		h.calls[1]!.resolve(ok("task-of-b"));
		await flush();
		expect(h.reader.state.view?.taskId).toBe("task-of-b");
		expect(h.calls).toHaveLength(2);
	});
});

describe("a refresh is never lost to an obsolete read", () => {
	it("a refresh queued behind a read that a launch change abandons runs at once, even when nothing else changed", async () => {
		const h = launched("launch-a", "grant-a");
		h.set({ trigger: 2 }); // queued behind the read in flight
		h.set({ launchId: "launch-b" }); // only the launch: no new grant or trigger in this render
		expect(h.calls).toHaveLength(2);
		expect(h.calls[0]!.signal.aborted).toBe(true);
		expect(h.calls[1]!.signal.aborted).toBe(false);
		h.calls[0]!.reject(new DOMException("aborted", "AbortError"));
		await flush();
		h.calls[1]!.resolve(ok("task-of-b"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("task-of-b"), current: true, busy: false, problem: null });
	});
});

describe("a read belongs to its pairing", () => {
	it("a read whose grant is revoked while it is in flight is never marked current", async () => {
		const h = launched();
		h.calls[0]!.resolve(ok("first"));
		await flush();
		expect(h.reader.state.current).toBe(true);
		h.set({ trigger: 2 });
		expect(h.calls).toHaveLength(2);
		h.set({ grant: null });
		expect(h.calls[1]!.signal.aborted).toBe(true);
		expect(h.reader.state).toEqual({ view: view("first"), current: false, busy: false, problem: "unpaired" });
		h.calls[1]!.resolve(ok("late"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("first"), current: false, busy: false, problem: "unpaired" });
		expect(h.calls).toHaveLength(2);
	});

	it("a read whose grant is replaced is abandoned; the next read uses the new grant, and only its answer is current", async () => {
		const h = launched("launch-a", "grant-1");
		h.set({ grant: "grant-2" });
		expect(h.calls.map((c) => c.grant)).toEqual(["grant-1", "grant-2"]);
		expect(h.calls[0]!.signal.aborted).toBe(true);
		h.calls[0]!.resolve(ok("under-grant-1"));
		await flush();
		expect(h.reader.state.current).toBe(false);
		expect(h.reader.state.view).toBeNull();
		h.calls[1]!.resolve(ok("under-grant-2"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("under-grant-2"), current: true, busy: false, problem: null });
	});
});

describe("one read at a time, nothing lost", () => {
	it("refreshes asked for during a read coalesce into one, which uses the grant held when it starts", async () => {
		const h = launched("launch-a", "grant-a");
		h.set({ trigger: 2 });
		h.set({ trigger: 3 });
		h.set({ trigger: 4 });
		expect(h.calls).toHaveLength(1);
		h.calls[0]!.resolve(ok("one"));
		await flush();
		expect(h.calls.map((c) => c.grant)).toEqual(["grant-a", "grant-a"]);
		h.calls[1]!.resolve(ok("two"));
		await flush();
		expect(h.calls).toHaveLength(2);
		expect(h.reader.state).toEqual({ view: view("two"), current: true, busy: false, problem: null });
	});

	it("a refresh queued before the pairing is replaced runs once, with the new grant, and the old answer is dropped", async () => {
		const h = launched("launch-a", "grant-1");
		h.set({ trigger: 2 });
		h.set({ grant: "grant-2" });
		expect(h.calls.map((c) => c.grant)).toEqual(["grant-1", "grant-2"]);
		h.calls[0]!.resolve(ok("old"));
		h.calls[1]!.resolve(ok("new"));
		await flush();
		expect(h.calls).toHaveLength(2);
		expect(h.reader.state.view?.taskId).toBe("new");
	});
});

describe("failures, unpairing and pairing again", () => {
	it("a rejected request, a thrown one and a refused one all clear busy, mark nothing current, and leave the next read working", async () => {
		const h = launched();
		h.calls[0]!.reject(new TypeError("network"));
		await flush();
		expect(h.reader.state).toEqual({ view: null, current: false, busy: false, problem: "unreachable" });
		h.set({ trigger: 2 });
		// The host refused this page's grant: said as unpaired (the shell then ends the page's pairing), not as a generic refusal.
		h.calls[1]!.resolve({ kind: "failure", status: 401, code: "grant-required" });
		await flush();
		expect(h.reader.state).toMatchObject({ current: false, busy: false, problem: "unpaired" });
		// Any other refusal (a busy or failing host) is a refusal, and says nothing about the pairing.
		h.set({ trigger: 3 });
		h.calls[2]!.resolve({ kind: "failure", status: 503, code: "other" });
		await flush();
		expect(h.reader.state).toMatchObject({ current: false, busy: false, problem: "refused" });
		h.set({ trigger: 4 });
		h.calls[3]!.resolve(ok("back"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("back"), current: true, busy: false, problem: null });
		// A request function that throws before returning a promise is a failure like any other.
		const thrown = new AttemptsReader(
			() => {
				throw new Error("synchronous");
			},
			() => {},
		);
		thrown.sync({ grant: "g", launchId: "l", active: true, ready: true, trigger: 1 });
		await flush();
		expect(thrown.state).toEqual({ view: null, current: false, busy: false, problem: "unreachable" });
	});

	it("unpaired, it does not read; paired again, it reads with the new grant and is current again", async () => {
		const h = launched("launch-a", "grant-1");
		h.calls[0]!.resolve(ok("first"));
		await flush();
		h.set({ grant: null });
		h.set({ trigger: 2 });
		expect(h.calls).toHaveLength(1);
		expect(h.reader.state).toMatchObject({ current: false, problem: "unpaired", view: view("first") });
		h.set({ grant: "grant-2" });
		expect(h.calls.map((c) => c.grant)).toEqual(["grant-1", "grant-2"]);
		h.calls[1]!.resolve(ok("second"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("second"), current: true, busy: false, problem: null });
	});

	it("reads nothing while DEVELOP is hidden or the workspace is not ready, and nothing without a trigger", () => {
		const h = harness();
		h.set({ launchId: "l", grant: "g" });
		h.set({ ready: true });
		expect(h.calls).toHaveLength(0);
		h.set({ active: false, trigger: 1 });
		expect(h.calls).toHaveLength(0);
		h.set({ active: true });
		expect(h.calls).toHaveLength(1);
	});

	it("disposed (or remounted under StrictMode), it abandons its read and reads again when synced", async () => {
		const h = launched();
		h.reader.dispose();
		expect(h.calls[0]!.signal.aborted).toBe(true);
		h.reader.sync({ grant: "grant-a", launchId: "launch-a", active: true, ready: true, trigger: 1 });
		expect(h.calls).toHaveLength(2);
		h.calls[0]!.resolve(ok("abandoned"));
		h.calls[1]!.resolve(ok("remounted"));
		await flush();
		expect(h.reader.state).toEqual({ view: view("remounted"), current: true, busy: false, problem: null });
	});
});
