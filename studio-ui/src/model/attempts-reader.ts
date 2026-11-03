// The decisions behind the page's attempts read (studio-ui/src/use-attempts.ts), kept apart from React and from the network so they can be
// driven with deferred requests (tests/develop-attempts-reader.test.ts). One read at a time; a read asked for while one runs is queued and
// run once after it. A read belongs to the launch and the pairing it was made under: when either changes, the read in flight is aborted and
// becomes OBSOLETE, and its answer or failure changes nothing (it can mark nothing current, clear no newer `busy`, take no queued refresh).
// A refresh queued meanwhile is kept and runs with the inputs as they are then, never with the ones a closure captured. The request
// function is injected: in the page it is the api's one GET, with no body and no query; nothing here can prepare or record an attempt.
//
// The same reader serves the attention projection (use-attention.ts): `LaunchReader` is generic over the view it reads, and both reads
// follow the same rules.
import type { AttemptsReply, AttemptsView } from "./attempts-wire.ts";

export interface LaunchReadState<V> {
	/** The last good read, kept through failures and marked by `current`. Null until one arrived (or after a different launch). */
	view: V | null;
	current: boolean;
	busy: boolean;
	/** Why the last read did not replace the view. `absent`: this workbench does not serve it. */
	problem: "absent" | "unpaired" | "invalid" | "unreachable" | "refused" | null;
}
export type AttemptsState = LaunchReadState<AttemptsView>;

/** A reply: the record (any kind that carries one), or that the route is absent, or a failure. */
export type LaunchReply<V> =
	| { kind: string; record: V }
	| { kind: "absent" }
	| { kind: "failure"; status: number; code: string };

const INITIAL = { view: null, current: false, busy: false, problem: null } as const;
export const INITIAL_ATTEMPTS: AttemptsState = INITIAL;

/**
 * What the reader is told on every render. `trigger` changes on every good workspace read (its time); `ready` says the workspace is one this
 * page can show tasks of. Reads happen only while `active` (the DEVELOP workspace is shown) and a grant is held.
 */
export interface AttemptsContext {
	grant: string | null;
	launchId: string | null;
	active: boolean;
	ready: boolean;
	trigger: number | null;
}

const NONE: AttemptsContext = { grant: null, launchId: null, active: false, ready: false, trigger: null };

export type AttemptsFetch = (grant: string, signal: AbortSignal) => Promise<AttemptsReply>;
export type LaunchFetch<V> = (grant: string, signal: AbortSignal) => Promise<LaunchReply<V>>;

const UNREACHABLE = { kind: "failure", status: 0, code: "unreachable" } as const;

function answered<V>(s: LaunchReadState<V>, reply: LaunchReply<V>): LaunchReadState<V> {
	if ("record" in reply) return { view: reply.record, current: true, busy: false, problem: null };
	return {
		...s,
		busy: false,
		current: false,
		problem:
			reply.kind === "absent"
				? "absent"
				: (reply as { code: string }).code === "grant-required"
					? // The host refused THIS page's grant (revoked, expired, or replaced by another page's pairing).
						"unpaired"
					: (reply as { code: string }).code === "invalid"
						? "invalid"
						: (reply as { code: string }).code === "unreachable"
							? "unreachable"
							: "refused",
	};
}

export class LaunchReader<V> {
	readonly #get: LaunchFetch<V>;
	readonly #publish: (state: LaunchReadState<V>) => void;
	#state: LaunchReadState<V> = INITIAL;
	#context: AttemptsContext = NONE;
	/** The last launch seen (a launch is "changed" only from one known launch to another, as the workspace hook counts it). */
	#launch: string | null = null;
	/** The one read in flight, if any. Its identity is the test of whether its answer still counts. */
	#flight: { controller: AbortController } | null = null;
	/** A read was asked for while one was in flight. */
	#queued = false;

	constructor(get: LaunchFetch<V>, publish: (state: LaunchReadState<V>) => void) {
		this.#get = get;
		this.#publish = publish;
	}

	get state(): LaunchReadState<V> {
		return this.#state;
	}

	/** React's inputs, on every change. Invalidates on a new launch or pairing, then reads when an input that asks for a read changed. */
	sync(next: AttemptsContext): void {
		const before = this.#context;
		this.#context = next;
		const launchChanged = next.launchId !== null && this.#launch !== null && next.launchId !== this.#launch;
		if (next.launchId !== null) this.#launch = next.launchId;
		const grantChanged = next.grant !== before.grant;
		let wanted =
			grantChanged ||
			next.trigger !== before.trigger ||
			next.ready !== before.ready ||
			next.active !== before.active;
		if (launchChanged || grantChanged) {
			// A refresh asked for under the old context is not dropped with it: it is run now, with the new one.
			wanted = this.#abandon() || wanted;
			if (launchChanged) this.#set(() => INITIAL);
			else
				this.#set((s) =>
					s.view === null
						? { ...s, busy: false }
						: { ...s, busy: false, current: false, problem: next.grant === null ? "unpaired" : s.problem },
				);
		}
		if (wanted) this.#request();
	}

	/** The component is going away (or StrictMode is remounting it): abandon the read and forget the inputs, so a remount reads again. */
	dispose(): void {
		this.#abandon();
		this.#context = NONE;
	}

	/** Abort the read in flight and make it obsolete. Returns whether a refresh was queued (it is handed to the caller, not lost). */
	#abandon(): boolean {
		this.#flight?.controller.abort();
		this.#flight = null;
		const queued = this.#queued;
		this.#queued = false;
		return queued;
	}

	#canRead(): boolean {
		const c = this.#context;
		return c.active && c.ready && c.trigger !== null && c.grant !== null;
	}

	#set(change: (s: LaunchReadState<V>) => LaunchReadState<V>): void {
		this.#state = change(this.#state);
		this.#publish(this.#state);
	}

	#request(): void {
		if (!this.#canRead()) return;
		if (this.#flight !== null) {
			this.#queued = true;
			return;
		}
		// The grant is read now, from the latest inputs: never one an earlier render captured.
		const grant = this.#context.grant as string;
		const flight = { controller: new AbortController() };
		this.#flight = flight;
		this.#set((s) => ({ ...s, busy: true }));
		let reply: Promise<LaunchReply<V>>;
		try {
			reply = this.#get(grant, flight.controller.signal);
		} catch {
			reply = Promise.resolve(UNREACHABLE);
		}
		// Both outcomes settle here, so no rejection is left unhandled and `busy` is always cleared by the read that set it, or by its abandonment.
		reply.then(
			(r) => this.#settle(flight, r),
			() => this.#settle(flight, UNREACHABLE),
		);
	}

	#settle(flight: { controller: AbortController }, reply: LaunchReply<V>): void {
		// An obsolete read (its launch or pairing has gone, or the component has): nothing it says is shown, and nothing newer is touched.
		if (this.#flight !== flight) return;
		this.#flight = null;
		this.#set((s) => answered(s, reply));
		if (this.#queued) {
			this.#queued = false;
			this.#request();
		}
	}
}

/** The selected task's attempts (use-attempts.ts). */
export class AttemptsReader extends LaunchReader<AttemptsView> {}
