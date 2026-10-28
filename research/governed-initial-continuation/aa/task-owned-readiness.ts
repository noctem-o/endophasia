// Bounded, read-only model-readiness gate for the pinned direct single-model llama.cpp profile.
//
// It sends `GET /health` to the task-owned loopback listener and nothing else: no completion, no `/v1/models`, no POST,
// no reload, no router API, no redirect. 503 means the model is still loading; 200 with exactly {"status":"ok"} is
// reported ready; every other observation, or running out of time, refuses. A ready answer is a bounded observation the
// server reported about itself. It is not proof that a later completion will succeed, and not a statement about which
// weights are loaded.
import { request } from "node:http";
import { canonicalEndoJsonV0 } from "../../../runtime/contracts/canonical-json.ts";
import type { EndoDigestKeyV0, EndoKeyedDigestV0 } from "../../../runtime/contracts/keyed-digest.ts";

export const TASK_OWNED_READINESS_VERSION_V0 = "endo.research.aa.task-owned-readiness.0";
export const READINESS_MAX_BODY_BYTES_V0 = 4096;
export const READINESS_REQUEST_TIMEOUT_MS_V0 = 3000;
export const READINESS_POLL_INTERVAL_MS_V0 = 250;
export const READINESS_MAX_TIMEOUT_MS_V0 = 600000;

export type ReadinessRefusalV0 =
	| "deadline-exceeded"
	| "cancelled"
	| "unexpected-status"
	| "invalid-body"
	| "oversized-response"
	| "redirect"
	| "network-failure"
	| "identity-changed";
export type ReadinessOutcomeV0 =
	| { status: "ready"; polls: number; loadingResponses: number }
	| { status: "refused"; reason: ReadinessRefusalV0; polls: number; loadingResponses: number };

export interface ReadinessOptionsV0 {
	/** The whole wait, from the first request. Required and bounded: there is no unlimited wait. */
	timeoutMs: number;
	signal: AbortSignal;
	/** Thorough task-owned identity observation. False when the process or listener no longer matches the approved one. */
	verifyIdentity: () => Promise<boolean>;
	/** Cheap synchronous identity check between polls, so a crashed or replaced server ends the wait promptly. */
	recheckIdentity: () => boolean;
	pollIntervalMs?: number;
	requestTimeoutMs?: number;
}

type Probe =
	| { kind: "response"; status: number; body: Buffer }
	| { kind: "oversized" }
	| { kind: "failed" }
	| { kind: "cancelled" };

/** One GET /health. Redirects are never followed; the body and the time are bounded. */
function probeHealth(port: number, timeoutMs: number, signal: AbortSignal): Promise<Probe> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: Probe) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path: "/health",
				method: "GET",
				agent: false,
				headers: { accept: "application/json", connection: "close" },
				timeout: timeoutMs,
				signal,
			},
			(res) => {
				const declared = Number(res.headers["content-length"] ?? 0);
				if (Number.isFinite(declared) && declared > READINESS_MAX_BODY_BYTES_V0) {
					res.destroy();
					finish({ kind: "oversized" });
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > READINESS_MAX_BODY_BYTES_V0) {
						res.destroy();
						finish({ kind: "oversized" });
					} else chunks.push(chunk);
				});
				res.on("end", () => finish({ kind: "response", status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
				res.on("error", () => finish(signal.aborted ? { kind: "cancelled" } : { kind: "failed" }));
				res.on("close", () => finish({ kind: "failed" }));
			},
		);
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", () => finish(signal.aborted ? { kind: "cancelled" } : { kind: "failed" }));
		req.end();
	});
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

/** Exactly {"status":"ok"}: no extra fields, no other value. */
export function isHealthyBodyV0(body: Buffer): boolean {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
		return (
			typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			canonicalEndoJsonV0(value) === canonicalEndoJsonV0({ status: "ok" })
		);
	} catch {
		return false;
	}
}

/**
 * Polls `/health` of the approved endpoint (loopback only) until it reports ready or something refuses.
 * Identity is checked before the first request, between polls and again after a ready answer.
 */
export async function awaitTaskOwnedReadinessV0(
	endpoint: string,
	options: ReadinessOptionsV0,
): Promise<ReadinessOutcomeV0> {
	const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(endpoint);
	const port = match ? Number(match[1]) : 0;
	if (
		!match ||
		port > 65535 ||
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs < 1 ||
		options.timeoutMs > READINESS_MAX_TIMEOUT_MS_V0
	)
		throw new Error("unsupported readiness request");
	const deadline = performance.now() + options.timeoutMs;
	const interval = options.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS_V0;
	const perRequest = options.requestTimeoutMs ?? READINESS_REQUEST_TIMEOUT_MS_V0;
	let polls = 0;
	let loadingResponses = 0;
	const refuse = (reason: ReadinessRefusalV0): ReadinessOutcomeV0 => ({
		status: "refused",
		reason,
		polls,
		loadingResponses,
	});
	if (options.signal.aborted) return refuse("cancelled");
	if (!(await options.verifyIdentity())) return refuse("identity-changed");
	for (;;) {
		if (options.signal.aborted) return refuse("cancelled");
		const remaining = deadline - performance.now();
		if (remaining <= 0) return refuse("deadline-exceeded");
		const probe = await probeHealth(port, Math.min(perRequest, Math.ceil(remaining)), options.signal);
		polls++;
		if (probe.kind === "cancelled" || options.signal.aborted) return refuse("cancelled");
		if (probe.kind === "oversized") return refuse("oversized-response");
		if (probe.kind === "failed")
			return refuse(performance.now() >= deadline ? "deadline-exceeded" : "network-failure");
		if (probe.status >= 300 && probe.status < 400) return refuse("redirect");
		if (probe.status === 200) {
			if (!isHealthyBodyV0(probe.body)) return refuse("invalid-body");
			if (!(await options.verifyIdentity())) return refuse("identity-changed");
			return { status: "ready", polls, loadingResponses };
		}
		if (probe.status !== 503) return refuse("unexpected-status");
		loadingResponses++;
		if (!options.recheckIdentity()) return refuse("identity-changed");
		await sleep(Math.max(0, Math.min(interval, deadline - performance.now())), options.signal);
	}
}

export interface ReadinessRecordV0 {
	version: typeof TASK_OWNED_READINESS_VERSION_V0;
	provenanceCommitment: EndoKeyedDigestV0;
	endpoint: string;
	/** What the server reported about itself over one loopback route; see the header of this module. */
	basis: "server-reported-health";
	outcome: ReadinessOutcomeV0;
	timeoutMs: number;
	observedAt: string;
	commitment: EndoKeyedDigestV0;
}
export const readinessPathV0 = (studyFile: string) => `${studyFile}.readiness.json`;
export function sealReadinessV0(
	key: EndoDigestKeyV0,
	body: Omit<ReadinessRecordV0, "commitment" | "version" | "basis">,
): ReadinessRecordV0 {
	const full = {
		version: TASK_OWNED_READINESS_VERSION_V0 as typeof TASK_OWNED_READINESS_VERSION_V0,
		basis: "server-reported-health" as const,
		...body,
	};
	return { ...full, commitment: key.digest({ purpose: TASK_OWNED_READINESS_VERSION_V0, body: full }) };
}
