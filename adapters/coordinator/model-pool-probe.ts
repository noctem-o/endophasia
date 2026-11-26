// probeLocalEndpointV0 (S0 Appendix A, M1-B): one bounded, zero-token health observation of a local Coordinator Model Pool member.
//
// It sends only GET requests, never a completion, never a credential, and never a request the llama.cpp server documents as able to
// load, unload or wake a model (tools/server/README.md, "Sleeping on Idle" and "Using multiple models"; server-models.cpp proxy_get):
//
//   GET /health                          answered by the server itself; exempt from idle reload. 200 healthy, 503 loading.
//   GET /props                           without `?model=`: the router's own properties (role, build), or a single server's; exempt.
//   GET /models (llama.cpp) or GET /v1/models (other servers)
//                                        the listing, never `?reload=1`; the router's answer is computed without loading anything.
//   GET /slots?fail_on_no_slot=1         ONLY for a single-model llama.cpp server that reports `is_sleeping: false`. In router mode
//                                        `/slots` is proxied to the model's instance and, with the default autoload, LOADS the model
//                                        (proxy_get calls ensure_model_ready), and `?autoload=false` cannot be confirmed on every
//                                        router build, so a router member's slot capacity is reported unknown instead. `/slots` is not
//                                        exempt from idle reload, so a single server that does not say it is awake is not asked.
//
// Every request has the probe's one deadline, a bounded head and body, no redirect following (a 3xx is refused), no keep-alive, and a
// check that the connected peer is 127.0.0.1 on the member's port. The member's endpoint was already validated as the literal
// `http://127.0.0.1:<port>`; no name is resolved.

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
	| "destination-mismatch";
type Got =
	| { readonly ok: true; readonly status: number; readonly body: Buffer }
	| { readonly ok: false; readonly detail: TransportFailure };

function get(port: number, path: string, deadline: AbortSignal, cancel: AbortSignal | undefined): Promise<Got> {
	const signal = cancel === undefined ? deadline : AbortSignal.any([deadline, cancel]);
	return new Promise<Got>((resolve) => {
		let settled = false;
		let wrongPeer = false;
		const settle = (value: Got) => {
			if (settled) return;
			settled = true;
			req.destroy();
			resolve(value);
		};
		const aborted = (): TransportFailure => (cancel?.aborted ? "cancelled" : "timeout");
		if (signal.aborted) {
			resolve({ ok: false, detail: aborted() });
			return;
		}
		const req = httpRequest({
			host: "127.0.0.1",
			family: 4,
			port,
			path,
			method: "GET",
			agent: false,
			headers: { accept: "application/json", connection: "close" },
			maxHeaderSize: HEADER_MAX,
			signal,
			lookup: () => {
				throw new Error("the probe resolves no names");
			},
		});
		req.on("socket", (socket) => {
			socket.once("connect", () => {
				if (socket.remoteAddress !== "127.0.0.1" || socket.remotePort !== port) {
					wrongPeer = true;
					settle({ ok: false, detail: "destination-mismatch" });
				}
			});
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
			response.on("error", () => settle({ ok: false, detail: signal.aborted ? aborted() : "connect-failed" }));
			response.on("aborted", () => settle({ ok: false, detail: signal.aborted ? aborted() : "connect-failed" }));
		});
		req.on("error", (error: NodeJS.ErrnoException) => {
			if (wrongPeer) return settle({ ok: false, detail: "destination-mismatch" });
			if (signal.aborted) return settle({ ok: false, detail: aborted() });
			if (error.code === "HPE_HEADER_OVERFLOW") return settle({ ok: false, detail: "response-too-large" });
			settle({ ok: false, detail: "connect-failed" });
		});
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
		backend = p.role === "router" ? "llama.cpp-router" : "llama.cpp-single";
		if (typeof p.build_info === "string" && /^b[0-9]+-[0-9a-f]{7,40}$/.test(p.build_info)) build = p.build_info;
		if (typeof p.is_sleeping === "boolean") sleeping = p.is_sleeping;
	} else if (props.status === 404) backend = "openai-compatible";
	else return done("unhealthy", "health-error");

	const listing = await fetch(backend === "openai-compatible" ? "/v1/models" : "/models");
	if (!listing.ok) return transport(listing.detail);
	if (listing.status === 404) return done("model-unconfirmed", "model-listing-unavailable");
	if (listing.status !== 200) return done("unhealthy", "health-error");
	const data = record(json(listing.body))?.data;
	if (!Array.isArray(data) || data.some((entry) => typeof record(entry)?.id !== "string"))
		return done("probe-refused", "malformed-response");
	const matches = data.map(record).filter((entry) => entry?.id === member.modelId);
	if (matches.length > 1) return done("probe-refused", "malformed-response");
	const entry = matches[0];
	if (entry === undefined || entry === null) return done("model-unavailable", "model-not-listed");

	if (backend === "llama.cpp-router") {
		const status = record(entry.status);
		switch (status?.value) {
			case "loaded":
				return done("capacity-unknown", "slots-not-probed-router");
			case "loading":
				return done("loading", "model-loading");
			case "sleeping":
				return done("model-unconfirmed", "model-sleeping");
			case "unloaded":
				return status.failed === true
					? done("model-unavailable", "model-failed")
					: done("model-unconfirmed", "model-unloaded");
			case "downloading":
			case "incomplete":
				return done("model-unavailable", "model-incomplete");
			default:
				return done("probe-refused", "malformed-response");
		}
	}
	if (backend === "openai-compatible") return done("capacity-unknown", "slots-not-observable");
	if (sleeping === true) return done("model-unconfirmed", "model-sleeping");
	if (sleeping !== false) return done("capacity-unknown", "slots-not-probed-sleeping-unknown");

	const slots = await fetch("/slots?fail_on_no_slot=1");
	if (!slots.ok) return transport(slots.detail);
	if (slots.status === 200) return done("ready", "slot-idle");
	if (slots.status === 503) return done("saturated", "no-idle-slot");
	return done("capacity-unknown", "slots-not-observable");
}
