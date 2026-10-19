// Fetching. Nothing here touches the page, and nothing here reads or prints the address the page was loaded from: requests are
// relative to it (`./api/...`), so the access capability in its path is carried by the browser and never appears in code, query
// strings, logs or messages. What comes back is classified by reply.ts; a failure of any kind is a `Reply`, never a throw.
import { classifyReply, type Reply } from "./reply.ts";

export interface SnapshotRequest {
	afterSequence: number;
	limit: number;
}

export interface Fetched {
	reply: Reply;
	/** How long the request took, by the browser's monotonic clock. */
	durationMs: number;
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Request one snapshot, relative to the page's own address. Never throws: a failure is a `Reply`. */
export async function fetchSnapshot(request: SnapshotRequest, signal?: AbortSignal): Promise<Fetched> {
	const started = performance.now();
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const both = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
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
			signal: both,
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
