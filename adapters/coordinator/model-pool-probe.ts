// probeLocalEndpointV0 (S0 Appendix A, M1-B): one bounded, zero-token health observation of a local Coordinator Model Pool member.
//
// It sends only GET requests, never a completion, never a credential, never a query string, and only requests the llama.cpp server
// answers without loading, unloading or waking a model and without counting as activity (llama.cpp tools/server, read at master):
//
//   GET /health      answered by the server itself; exempt from idle sleep. 200 healthy, 503 "Loading model" loading.
//   GET /props       without ?model=: the router's own properties, or a single server's (create_response(true): no wake; served from
//                    cache while asleep). Identifies a router, a single llama.cpp server (build_info and total_slots), or neither.
//   GET /models      single llama.cpp server only (create_response(true), cached while asleep): the exact model id must be listed.
//   GET /v1/models   only when /props is 404 (not llama.cpp): the exact id must be listed. A catalog entry is not residency evidence.
//                    Any router (role "router", with or without a recognised build) and any /props document that identifies
//                    neither a router nor a single llama.cpp server get no catalog request at all: on a router, /models and
//                    /v1/models are the same handler, which runs a pending reconciliation.
//
// Deliberately NOT sent, with the reason read in the source:
//   /slots     single server: create_response() without bypass calls wait_until_no_sleep(), so it WAKES a sleeping model and counts
//              as activity; router: proxied by proxy_get, which with the default autoload LOADS the model.
//   /metrics   single server: posts a metrics task with metrics_reset_bucket (changes what a Prometheus scraper sees); router: proxied.
//   /models on a router: get_all_meta() runs a pending load_models() reconciliation, which can UNLOAD a running model whose source
//              changed after a download (server-models.cpp need_reload).
// So no local llama.cpp observation in M1 confirms free capacity or saturation: a loaded, awake model is capacity-unknown, and a
// router member's model state is unobserved. "ready" and "saturated" remain in the readiness vocabulary for observers that have a
// passive capacity signal (S1, M2).
//
// Every request has the probe's one deadline (settled directly on expiry or cancellation), a bounded head and body, no redirect
// following (a 3xx or 101 is refused), no keep-alive, and a check that the connected peer is 127.0.0.1 on the member's port. The
// endpoint was already validated as the literal http://127.0.0.1:<port>; no name is resolved.

import { request as httpRequest } from "node:http";
import {
	type EndoCoordinatorModelPoolMemberV0,
	endoCoordinatorLoopbackOriginV0,
} from "../../protocol/coordinator-model-pool.ts";
import type {
	EndoCoordinatorBackendV0,
	EndoCoordinatorMemberObservationV0,
	EndoCoordinatorMemberReadinessV0,
	EndoCoordinatorProbeDetailV0,
} from "../../runtime/contracts/coordinator-model-pool.ts";

export const ENDO_COORDINATOR_PROBE_DEADLINE_MS_V0 = 3000;
export const ENDO_COORDINATOR_PROBE_BODY_MAX_V0 = 256 * 1024;
const HEADER_MAX = 8192;

type TransportFailure =
	| "connect-failed"
	| "timeout"
	| "cancelled"
	| "redirect"
	| "response-too-large"
	| "malformed-response"
	| "destination-mismatch";
type Got =
	| { readonly ok: true; readonly status: number; readonly body: Buffer }
	| { readonly ok: false; readonly detail: TransportFailure };

function get(port: number, path: string, deadline: AbortSignal, cancel: AbortSignal | undefined): Promise<Got> {
	const signal = cancel === undefined ? deadline : AbortSignal.any([deadline, cancel]);
	const aborted = (): TransportFailure => (cancel?.aborted ? "cancelled" : "timeout");
	if (signal.aborted) return Promise.resolve({ ok: false, detail: aborted() });
	return new Promise<Got>((resolve) => {
		let settled = false;
		const onAbort = () => settle({ ok: false, detail: aborted() });
		const settle = (value: Got) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			req.destroy();
			resolve(value);
		};
		const req = httpRequest({
			host: "127.0.0.1",
			family: 4,
			port,
			path,
			method: "GET",
			agent: false,
			headers: { accept: "application/json", connection: "close" },
			maxHeaderSize: HEADER_MAX,
			lookup: () => {
				throw new Error("the probe resolves no names");
			},
		});
		signal.addEventListener("abort", onAbort, { once: true });
		req.on("socket", (socket) => {
			socket.once("connect", () => {
				if (socket.remoteAddress !== "127.0.0.1" || socket.remotePort !== port)
					settle({ ok: false, detail: "destination-mismatch" });
			});
		});
		req.on("upgrade", (_response, socket) => {
			socket.destroy();
			settle({ ok: false, detail: "malformed-response" });
		});
		req.on("response", (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400) return settle({ ok: false, detail: "redirect" });
			const parts: Buffer[] = [];
			let length = 0;
			response.on("data", (chunk: Buffer) => {
				length += chunk.length;
				if (length > ENDO_COORDINATOR_PROBE_BODY_MAX_V0) return settle({ ok: false, detail: "response-too-large" });
				parts.push(chunk);
			});
			response.on("end", () => settle({ ok: true, status, body: Buffer.concat(parts) }));
			response.on("error", () => settle({ ok: false, detail: "connect-failed" }));
			response.on("close", () => settle({ ok: false, detail: "connect-failed" }));
		});
		req.on("error", (error: NodeJS.ErrnoException) =>
			settle({ ok: false, detail: error.code === "HPE_HEADER_OVERFLOW" ? "response-too-large" : "connect-failed" }),
		);
		req.on("close", () => settle({ ok: false, detail: "connect-failed" }));
		req.end();
	});
}

const json = (body: Buffer): unknown => {
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return undefined;
	}
};
const record = (value: unknown): Record<string, unknown> | null =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Observe one local member. Never throws for anything the server does: every outcome is a readiness. Throws only for a member that is
 * not a validated local member, which selection never passes.
 */
export async function probeLocalEndpointV0(
	member: EndoCoordinatorModelPoolMemberV0,
	options: { readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly now?: () => number } = {},
): Promise<EndoCoordinatorMemberObservationV0> {
	const origin = endoCoordinatorLoopbackOriginV0(member.endpoint);
	if (member.kind !== "local-openai-compat" || !origin.ok)
		throw new TypeError("only a local loopback member is probed");
	const deadlineMs = options.deadlineMs ?? ENDO_COORDINATOR_PROBE_DEADLINE_MS_V0;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000)
		throw new TypeError("probe deadline must be 1..30000 ms");
	const observedAtMs = (options.now ?? Date.now)();
	const started = performance.now();
	const deadline = AbortSignal.timeout(deadlineMs);
	const requests: { path: string; status: number | null }[] = [];
	let backend: EndoCoordinatorBackendV0 = "unknown";
	let build: string | null = null;
	const done = (readiness: EndoCoordinatorMemberReadinessV0, detail: EndoCoordinatorProbeDetailV0) =>
		Object.freeze({
			memberId: member.memberId,
			endpoint: member.endpoint,
			modelId: member.modelId,
			basis: "controller-observed" as const,
			observedAtMs,
			elapsedMs: Math.round(performance.now() - started),
			readiness,
			detail,
			backend,
			build,
			requests: Object.freeze(requests.map((r) => Object.freeze(r))),
			inferenceTokens: 0 as const,
		});
	const fetch = async (path: string): Promise<Got> => {
		const got = await get(origin.port, path, deadline, options.signal);
		requests.push({ path, status: got.ok ? got.status : null });
		return got;
	};
	const transport = (detail: TransportFailure) =>
		done(
			detail === "connect-failed" || detail === "timeout" || detail === "cancelled"
				? "unreachable"
				: "probe-refused",
			detail,
		);

	const health = await fetch("/health");
	if (!health.ok) return transport(health.detail);
	if (health.status === 503) {
		const error = record(record(json(health.body))?.error);
		return error?.message === "Loading model" ? done("loading", "server-loading") : done("unhealthy", "health-error");
	}
	if (health.status !== 200) return done("unhealthy", "health-error");

	const props = await fetch("/props");
	if (!props.ok) return transport(props.detail);
	let sleeping: boolean | undefined;
	if (props.status === 200) {
		const p = record(json(props.body));
		if (p === null) return done("probe-refused", "malformed-response");
		const llamaBuild =
			typeof p.build_info === "string" && /^b[0-9]+-[0-9a-f]{7,40}$/.test(p.build_info) ? p.build_info : null;
		build = llamaBuild;
		if (p.role === "router") backend = "llama.cpp-router";
		else if (llamaBuild !== null && Number.isSafeInteger(p.total_slots) && (p.total_slots as number) > 0)
			backend = "llama.cpp-single";
		else return done("model-unconfirmed", "backend-unidentified");
		if (typeof p.is_sleeping === "boolean") sleeping = p.is_sleeping;
	} else if (props.status === 404) backend = "openai-compatible";
	else return done("unhealthy", "health-error");

	if (backend === "llama.cpp-router") return done("model-unconfirmed", "router-model-state-not-observed");

	const listing = await fetch(backend === "llama.cpp-single" ? "/models" : "/v1/models");
	if (!listing.ok) return transport(listing.detail);
	if (listing.status === 404) return done("model-unconfirmed", "model-listing-unavailable");
	if (listing.status !== 200) return done("unhealthy", "health-error");
	const data = record(json(listing.body))?.data;
	if (!Array.isArray(data) || data.some((entry) => typeof record(entry)?.id !== "string"))
		return done("probe-refused", "malformed-response");
	const matches = data.filter((entry) => record(entry)?.id === member.modelId);
	if (matches.length > 1) return done("probe-refused", "malformed-response");
	if (matches.length === 0) return done("model-unavailable", "model-not-listed");
	if (backend === "openai-compatible") return done("model-unconfirmed", "model-listed-residency-unknown");
	if (sleeping === true) return done("model-unconfirmed", "model-sleeping");
	if (sleeping === false) return done("capacity-unknown", "slots-not-observable");
	return done("model-unconfirmed", "model-sleep-state-unknown");
}
