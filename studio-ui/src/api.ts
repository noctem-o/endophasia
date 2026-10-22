// Fetching. Nothing here touches the page, and nothing here reads or prints the address the page was loaded from: the request is
// relative to it (`./api/v0/snapshot`), so the access capability in its path is carried by the browser and never appears in code,
// query strings, logs or messages. What comes back is classified by reply.ts; a failure of any kind is a `Reply`, never a throw.
//
// This is the only `fetch` in the frontend, and the only endpoint it reads: the snapshot, which already holds the timeline window and
// every attachment's runtime in one read. (Reading the timeline and each runtime separately would be several full reads of the history
// for what one read returns.)
import { classifyReply, type Reply } from "./model/contract.ts";
import type { ReadRequest } from "./model/state.ts";

export interface Fetched {
	reply: Reply;
	/** How long the request took, by the browser's monotonic clock. */
	durationMs: number;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Request one snapshot, relative to the page's own address. Never throws: a failure is a `Reply`. */
export async function fetchSnapshot(request: ReadRequest): Promise<Fetched> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	try {
		const url = new URL(
			`./api/v0/snapshot?afterSequence=${request.afterSequence}&limit=${request.limit}`,
			document.baseURI,
		);
		const response = await fetch(url, {
			method: "GET",
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: timeout,
		});
		const body = await response.text();
		return {
			reply: classifyReply(
				response.status,
				response.headers.get("retry-after"),
				response.headers.get("content-type"),
				body,
			),
			durationMs: performance.now() - started,
		};
	} catch {
		return {
			reply: { kind: "unreachable", reason: timeout.aborted ? "timeout" : "network" },
			durationMs: performance.now() - started,
		};
	}
}
