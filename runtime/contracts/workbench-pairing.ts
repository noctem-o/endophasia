// The pairing of a browser page with a host that serves `api/v0/workbench/*`, as one small object shared by every such host: the Pi
// workbench (adapters/pi/workbench.ts) and the workspace host (cockpit-http/workspace-host.ts). It holds no session and authorises nothing
// by itself: a host asks it whether a request's grant holds, and decides what that grant may do.
//
// The rules (unchanged from the workbench, where they were first written and tested):
// - A pairing CODE is shown only to the operator, on the host's own terminal. It is single use, expires (10 minutes by default), and is
//   discarded after five wrong tries. Every refusal is the same answer: nothing says whether a code existed, expired or was used up.
// - A GRANT is a random 256-bit token returned once, to the page that typed the code. There is one at a time: a new pairing replaces it,
//   so whatever held the old one can no longer ask. It expires (1 hour by default). `revoke` drops it at once.
// - Comparisons are constant-time. The host's own `closed` predicate (a session that ended, a host that is stopping) refuses everything.

import { randomBytes, timingSafeEqual } from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const MAX_PAIR_ATTEMPTS = 5;

const equal = (a: string, b: string): boolean => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

export interface EndoPairingOptionsV0 {
	now: () => number;
	/** How long a pairing code lives. */
	pairingWindowMs: number;
	/** How long a grant lives. */
	grantMs: number;
	/** The host can no longer be paired with or asked anything (its session ended, it is stopping). */
	closed: () => boolean;
}

export const ENDO_GRANT_SCHEMA_V0 = "endo.workbench-grant.v0";

export class EndoPairingV0 {
	readonly #o: EndoPairingOptionsV0;
	#code: { value: string; expiresAtMs: number; attempts: number } | null = null;
	#grant: { token: string; expiresAtMs: number } | null = null;

	constructor(options: EndoPairingOptionsV0) {
		this.#o = options;
	}

	/** A new one-time pairing code, replacing any earlier one. For the host's own terminal only. */
	issue(): { code: string; expiresAtMs: number } {
		const bytes = randomBytes(8);
		const letters = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
		const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
		const expiresAtMs = this.#o.now() + this.#o.pairingWindowMs;
		this.#code = { value: code, expiresAtMs, attempts: 0 };
		return { code, expiresAtMs };
	}

	/** Exchange a code for the grant: the HTTP answer `POST pair` gives. */
	pair(code: unknown): { status: number; body: unknown } {
		const held = this.#code;
		const refused = { status: 401, body: { error: "pairing-refused" } };
		if (held === null || this.#o.closed() || this.#o.now() >= held.expiresAtMs) return refused;
		if (typeof code !== "string" || code.length > 16) {
			held.attempts += 1;
		} else if (equal(code.toUpperCase(), held.value)) {
			this.#code = null; // single use
			const token = randomBytes(32).toString("base64url");
			// A new pairing replaces the grant: whatever held the old one can no longer ask.
			this.#grant = { token, expiresAtMs: this.#o.now() + this.#o.grantMs };
			return {
				status: 200,
				body: { schemaVersion: ENDO_GRANT_SCHEMA_V0, grant: token, expiresAtMs: this.#grant.expiresAtMs },
			};
		} else held.attempts += 1;
		if (held.attempts >= MAX_PAIR_ATTEMPTS) this.#code = null;
		return refused;
	}

	/** Whether `grant` is the one grant held now, unexpired, on a host that is not closed. */
	granted(grant: string | null): boolean {
		const held = this.#grant;
		return (
			!this.#o.closed() &&
			held !== null &&
			grant !== null &&
			this.#o.now() < held.expiresAtMs &&
			equal(grant, held.token)
		);
	}

	/** Whether a page holds a grant now (said to the page in its status, never the token). */
	paired(): boolean {
		return this.#grant !== null && this.#o.now() < this.#grant.expiresAtMs;
	}

	/** Drop the grant now: the page that held it can no longer read or ask anything. The code (if any) stays. */
	revoke(): void {
		this.#grant = null;
	}

	/** Drop the grant and the code: nothing can be paired with or asked any more until a new code is issued. */
	clear(): void {
		this.#grant = null;
		this.#code = null;
	}
}
