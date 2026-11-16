// Bounded session authority for the DEVELOP workbench (research/develop-ux/DEVELOP-UX-002.md §4): ONE grant at a time under which the
// page that holds it may have a closed set of operations sent to ONE session without a terminal phrase for each. It is a separate object
// from the pairing grant (workbench-pairing.ts), which only lets a page read and ask. It holds no session and sends nothing: the broker
// asks it, per request, whether the grant covers the request, and takes the terminal path whenever the answer is no.
//
// The rules:
// - ISSUE. Only when a pairing code the TERMINAL armed is redeemed, and only while the execution protection
//   (execution-protection.ts) is observed as enforced for this session and workspace at the level the mode requires. Nothing a page
//   sends can arm, issue, extend or widen a grant; the mode is a constructor argument.
// - SCOPE. The broker's launch, the exact session and attachment connected at issue, the canonical workspace root, a set of
//   operations, a fixed expiry and a count of sends. Every one is checked at every use, against what is true THEN.
// - HOLDER. The pairing token of the page that redeemed the armed code, compared in constant time. A page that reloads has lost it.
// - END. Permanent, with one closed reason. A new pairing of any kind ends the grant; so do expiry, the budget, a revocation, a
//   changed session or workspace, and protection that is no longer observed. Nothing revives an ended grant: a new one needs a new
//   terminal act.
// - MEMORY ONLY. Neither the grant nor the holder token is written anywhere. The records the host writes (`onGranted`, `onEnded`)
//   carry the grant's public id and scope, never a token.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	type EndoExecutionProtectionStatusV0,
	type EndoExecutionProtectionV0,
	type EndoProtectionLevelV0,
	endoObserveProtectionV0,
	endoProtectionHoldsV0,
} from "./execution-protection.ts";

export const ENDO_WORKBENCH_MODES_V0 = ["everyday", "protected", "strict"] as const;
export type EndoWorkbenchModeV0 = (typeof ENDO_WORKBENCH_MODES_V0)[number];

export const ENDO_SESSION_CONTROL_OPERATIONS_V0 = ["prompt", "steer", "queue", "stop"] as const;
export type EndoSessionControlOperationV0 = (typeof ENDO_SESSION_CONTROL_OPERATIONS_V0)[number];

export const ENDO_SESSION_CONTROL_END_REASONS_V0 = [
	"expired",
	"budget-spent",
	"revoked-on-terminal",
	"revoked-by-page",
	"re-paired",
	"session-changed",
	"workspace-changed",
	"protection-lost",
	"closing",
] as const;
export type EndoSessionControlEndReasonV0 = (typeof ENDO_SESSION_CONTROL_END_REASONS_V0)[number];

/** The longest a grant may live, whatever the host asks for. */
export const ENDO_SESSION_CONTROL_MAX_LIFETIME_MS_V0 = 60 * 60_000;
export const ENDO_SESSION_CONTROL_DEFAULT_LIFETIME_MS_V0 = 30 * 60_000;
export const ENDO_SESSION_CONTROL_DEFAULT_SENDS_V0 = 200;

export const isEndoSessionGrantIdV0 = (value: unknown): value is string =>
	typeof value === "string" && /^endo\.evidence\.workbench-session-grant-[0-9a-f]{32}$/.test(value);

/** What is connected and served NOW, as the host knows it (never as a page says). */
export interface EndoSessionControlSubjectV0 {
	launchId: string;
	/** `endo.session.…` of the connected runtime, or null when none is connected. */
	session: string | null;
	attachment: string;
	/** The canonical (real) path of the directory the runtime was launched in. */
	workspaceRoot: string;
}

/** A grant's public description: what a record and a status may say of it. No token. */
export interface EndoSessionGrantV0 {
	grantId: string;
	mode: Exclude<EndoWorkbenchModeV0, "strict">;
	launchId: string;
	session: string;
	attachment: string;
	workspaceRoot: string;
	operations: readonly EndoSessionControlOperationV0[];
	issuedAtMs: number;
	expiresAtMs: number;
	maxSends: number;
	protection: { level: EndoProtectionLevelV0; mechanism: string };
}

export interface EndoSessionControlOptionsV0 {
	/** The mode the operator chose on the command line of the attached process. */
	mode: EndoWorkbenchModeV0;
	protection?: EndoExecutionProtectionV0;
	now: () => number;
	lifetimeMs?: number;
	maxSends?: number;
	operations?: readonly EndoSessionControlOperationV0[];
	subject: () => EndoSessionControlSubjectV0;
	/** The host is ending or stopping. */
	closed: () => boolean;
	/** Record the grant. Returning false (or throwing) means it could not be recorded, and it is then NOT issued. */
	onGranted: (grant: EndoSessionGrantV0) => boolean;
	/** Record the end. Best effort: the grant is ended whatever this does. */
	onEnded: (grant: EndoSessionGrantV0, reason: EndoSessionControlEndReasonV0, sends: number) => void;
}

export interface EndoSessionControlViewV0 {
	mode: { requested: EndoWorkbenchModeV0; effective: EndoWorkbenchModeV0; reason: string | null };
	protection: Pick<EndoExecutionProtectionStatusV0, "state" | "level" | "mechanism" | "limitations">;
	control: {
		state: "active" | "none";
		/** The request that asked holds the grant. Only the holder is told the scope. */
		holder: boolean;
		/** A pairing code that carries control is waiting to be typed into a page. */
		armed: boolean;
		grantId: string | null;
		operations: readonly EndoSessionControlOperationV0[];
		expiresAtMs: number | null;
		sendsLeft: number | null;
		workspaceRoot: string | null;
		/** Why the last grant of this launch ended, when there is none now. */
		ended: EndoSessionControlEndReasonV0 | null;
	};
}

interface Held extends EndoSessionGrantV0 {
	holder: Buffer;
	sends: number;
}

const REQUIRED: Readonly<Record<EndoWorkbenchModeV0, EndoProtectionLevelV0 | null>> = {
	everyday: "workspace",
	protected: "restricted",
	strict: null,
};

export class EndoSessionControlV0 {
	readonly #o: EndoSessionControlOptionsV0;
	readonly #lifetimeMs: number;
	readonly #maxSends: number;
	readonly #operations: readonly EndoSessionControlOperationV0[];
	#armed: { expiresAtMs: number } | null = null;
	#grant: Held | null = null;
	#ended: EndoSessionControlEndReasonV0 | null = null;

	constructor(options: EndoSessionControlOptionsV0) {
		if (!(ENDO_WORKBENCH_MODES_V0 as readonly unknown[]).includes(options.mode))
			throw new TypeError("unknown workbench mode");
		this.#o = options;
		const lifetime = options.lifetimeMs ?? ENDO_SESSION_CONTROL_DEFAULT_LIFETIME_MS_V0;
		if (!Number.isSafeInteger(lifetime) || lifetime < 1)
			throw new TypeError("a session grant's lifetime is a positive integer");
		this.#lifetimeMs = Math.min(lifetime, ENDO_SESSION_CONTROL_MAX_LIFETIME_MS_V0);
		const sends = options.maxSends ?? ENDO_SESSION_CONTROL_DEFAULT_SENDS_V0;
		if (!Number.isSafeInteger(sends) || sends < 1)
			throw new TypeError("a session grant's budget is a positive integer");
		this.#maxSends = sends;
		const operations = [...new Set(options.operations ?? ENDO_SESSION_CONTROL_OPERATIONS_V0)];
		if (
			operations.length === 0 ||
			!operations.every((op) => (ENDO_SESSION_CONTROL_OPERATIONS_V0 as readonly unknown[]).includes(op))
		)
			throw new TypeError("a session grant covers only prompt, steer, queue and stop");
		this.#operations = Object.freeze(ENDO_SESSION_CONTROL_OPERATIONS_V0.filter((op) => operations.includes(op)));
	}

	get requested(): EndoWorkbenchModeV0 {
		return this.#o.mode;
	}

	/**
	 * Whether a grant could be issued now, and if not, the one reason (a fixed sentence, or the protection's own first limitation).
	 * `protection` is what was observed for this answer.
	 */
	availability(): { available: boolean; reason: string | null; protection: EndoExecutionProtectionStatusV0 } {
		const protection = endoObserveProtectionV0(this.#o.protection);
		const no = (reason: string) => ({ available: false, reason, protection });
		const need = REQUIRED[this.#o.mode];
		if (need === null)
			return no("Strict mode was chosen for this launch: every request is approved in the terminal.");
		if (this.#o.closed()) return no("The session is closing or has ended.");
		const subject = this.#o.subject();
		if (subject.session === null) return no("No session is connected.");
		if (!endoProtectionHoldsV0(protection, need, { session: subject.session, workspaceRoot: subject.workspaceRoot }))
			return no(
				protection.state === "enforced"
					? "The execution boundary that is enforced is weaker than this mode requires, or is for another session or workspace."
					: (protection.limitations[0] ?? "No execution boundary is enforced for the agent."),
			);
		return { available: true, reason: null, protection };
	}

	/**
	 * THE TERMINAL ONLY. Mark the pairing code the host is about to show as carrying session control, until `expiresAtMs`. Refused, with
	 * the reason, when a grant could not be issued now. The scope returned is what the terminal tells the operator they are granting.
	 */
	arm(expiresAtMs: number):
		| {
				ok: true;
				scope: {
					operations: readonly EndoSessionControlOperationV0[];
					workspaceRoot: string;
					lifetimeMs: number;
					maxSends: number;
				};
		  }
		| { ok: false; reason: string } {
		this.#armed = null;
		const available = this.availability();
		if (!available.available) return { ok: false, reason: available.reason as string };
		this.#armed = { expiresAtMs };
		return {
			ok: true,
			scope: {
				operations: this.#operations,
				workspaceRoot: this.#o.subject().workspaceRoot,
				lifetimeMs: this.#lifetimeMs,
				maxSends: this.#maxSends,
			},
		};
	}

	/** The code that carried control was replaced by a plain one, or withdrawn. */
	disarm(): void {
		this.#armed = null;
	}

	/**
	 * A pairing just succeeded and produced `token`. Whatever page held the grant is no longer the paired page, so the grant ends. If the
	 * code that was redeemed is the one the terminal armed, and everything a grant needs still holds, a NEW grant is issued to this token.
	 */
	paired(token: string): EndoSessionGrantV0 | null {
		this.#end("re-paired");
		const armed = this.#armed;
		this.#armed = null; // the code is single use: so is what it carried
		if (armed === null || this.#o.now() >= armed.expiresAtMs) return null;
		const available = this.availability();
		if (!available.available) return null;
		const subject = this.#o.subject();
		const issuedAtMs = this.#o.now();
		const grant: Held = {
			grantId: `endo.evidence.workbench-session-grant-${randomBytes(16).toString("hex")}`,
			mode: this.#o.mode as Exclude<EndoWorkbenchModeV0, "strict">,
			launchId: subject.launchId,
			session: subject.session as string,
			attachment: subject.attachment,
			workspaceRoot: subject.workspaceRoot,
			operations: this.#operations,
			issuedAtMs,
			expiresAtMs: issuedAtMs + this.#lifetimeMs,
			maxSends: this.#maxSends,
			protection: { level: available.protection.level, mechanism: available.protection.mechanism as string },
			holder: Buffer.from(token),
			sends: 0,
		};
		let recorded = false;
		try {
			recorded = this.#o.onGranted(describe(grant)) === true;
		} catch {
			recorded = false;
		}
		if (!recorded) return null;
		this.#grant = grant;
		this.#ended = null;
		return describe(grant);
	}

	/** End the grant if anything it depends on no longer holds. Returns the grant when it still stands. */
	#standing(): Held | null {
		const grant = this.#grant;
		if (grant === null) return null;
		if (this.#o.closed()) return this.#end("closing");
		if (this.#o.now() >= grant.expiresAtMs) return this.#end("expired");
		const subject = this.#o.subject();
		if (
			subject.launchId !== grant.launchId ||
			subject.attachment !== grant.attachment ||
			subject.session !== grant.session
		)
			return this.#end("session-changed");
		if (subject.workspaceRoot !== grant.workspaceRoot) return this.#end("workspace-changed");
		const protection = endoObserveProtectionV0(this.#o.protection);
		if (
			!endoProtectionHoldsV0(protection, REQUIRED[grant.mode] as EndoProtectionLevelV0, {
				session: grant.session,
				workspaceRoot: grant.workspaceRoot,
			})
		)
			return this.#end("protection-lost");
		if (grant.sends >= grant.maxSends) return this.#end("budget-spent");
		return grant;
	}

	#end(reason: EndoSessionControlEndReasonV0): null {
		const grant = this.#grant;
		if (grant === null) return null;
		this.#grant = null;
		this.#ended = reason;
		try {
			this.#o.onEnded(describe(grant), reason, grant.sends);
		} catch {
			// the record is best effort; the grant is ended
		}
		return null;
	}

	#holds(grant: Held, token: string | null): boolean {
		if (token === null) return false;
		const given = Buffer.from(token);
		return given.length === grant.holder.length && timingSafeEqual(given, grant.holder);
	}

	/** Whether `token` holds a standing grant that covers `operation`. Uses nothing of the budget. */
	covers(token: string | null, operation: EndoSessionControlOperationV0): boolean {
		const grant = this.#standing();
		return grant !== null && this.#holds(grant, token) && grant.operations.includes(operation);
	}

	/**
	 * Authorise ONE send of `operation` for `token`, or decline (the request then takes the terminal path). Counts against the budget.
	 * The grant's id is what the authorisation record names.
	 */
	authorize(token: string | null, operation: EndoSessionControlOperationV0): { grantId: string } | null {
		const grant = this.#standing();
		if (grant === null || !this.#holds(grant, token) || !grant.operations.includes(operation)) return null;
		grant.sends += 1;
		return { grantId: grant.grantId };
	}

	/** End the grant now, from the terminal or because the host is closing. Also withdraws an armed code's control. */
	revoke(reason: "revoked-on-terminal" | "closing"): boolean {
		this.#armed = null;
		const had = this.#grant !== null;
		this.#end(reason);
		return had;
	}

	/** The page that holds the grant gives it up. Anything else holding a pairing token cannot end another's grant. */
	relinquish(token: string | null): boolean {
		const grant = this.#grant;
		if (grant === null || !this.#holds(grant, token)) return false;
		this.#end("revoked-by-page");
		return true;
	}

	/** For the terminal: the standing grant, or null. */
	current(): (EndoSessionGrantV0 & { sendsLeft: number }) | null {
		const grant = this.#standing();
		return grant === null ? null : { ...describe(grant), sendsLeft: grant.maxSends - grant.sends };
	}

	/** What a status says. `token` is the asking request's pairing token, already verified by the host, or null. */
	view(token: string | null): EndoSessionControlViewV0 {
		const grant = this.#standing();
		const available = this.availability();
		const holder = grant !== null && this.#holds(grant, token);
		return {
			mode: {
				requested: this.#o.mode,
				effective: available.available ? this.#o.mode : "strict",
				reason: this.#o.mode === "strict" ? null : available.reason,
			},
			protection: {
				state: available.protection.state,
				level: available.protection.level,
				mechanism: available.protection.mechanism,
				limitations: available.protection.limitations,
			},
			control: {
				state: grant === null ? "none" : "active",
				holder,
				armed: this.#armed !== null && this.#o.now() < this.#armed.expiresAtMs,
				grantId: holder ? grant.grantId : null,
				operations: holder ? grant.operations : [],
				expiresAtMs: grant === null ? null : grant.expiresAtMs,
				sendsLeft: holder ? grant.maxSends - grant.sends : null,
				workspaceRoot: holder ? grant.workspaceRoot : null,
				ended: grant === null ? this.#ended : null,
			},
		};
	}
}

function describe(grant: Held): EndoSessionGrantV0 {
	const { holder: _holder, sends: _sends, ...described } = grant;
	return described;
}
