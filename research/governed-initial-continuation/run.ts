// Explicitly opt-in local operator harness. It never supplies an approval on its own.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
	approveContinuationTurnV0,
	approveInitialContinuationV0,
	executeInitialContinuationV0,
	type InitialContinuationOptionsV0,
	preflightInitialContinuationV0,
	verifyInitialContinuationEvidenceV0,
} from "../../cli/initial-continuation.ts";
import { readEndoDigestKeyV0 } from "../../storage/digest-key.ts";

type Config = InitialContinuationOptionsV0 & { keyFile: string };
const fields = [
	"keyFile",
	"source",
	"replay",
	"outputParent",
	"preparation",
	"childRole",
	"piExecutable",
	"upstream",
	"provider",
	"model",
	"prompt",
	"continuationPrompt",
	"wallTimeoutMs",
	"maxApprovalIdleMs",
	"maxTransferredBytes",
] as const;

function readConfig(path: string): Config {
	if (!isAbsolute(path)) throw new Error("the private configuration path must be absolute");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			throw new Error("configuration must be a private owner-only regular file of at most 16 KiB");
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd)));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid configuration");
		const v = value as Record<string, unknown>;
		if (Object.keys(v).length !== fields.length || fields.some((field) => !Object.hasOwn(v, field)))
			throw new Error("configuration must contain exactly the documented fields");
		for (const field of ["keyFile", "source", "replay", "outputParent", "piExecutable"] as const)
			if (typeof v[field] !== "string" || !isAbsolute(v[field]))
				throw new Error(`${field} must be an absolute path`);
		for (const field of ["preparation", "upstream", "provider", "model", "prompt", "continuationPrompt"] as const)
			if (typeof v[field] !== "string" || v[field].length === 0) throw new Error(`${field} must be explicit`);
		if (v.childRole !== "baseline" && v.childRole !== "alternative") throw new Error("invalid childRole");
		for (const field of ["wallTimeoutMs", "maxApprovalIdleMs", "maxTransferredBytes"] as const)
			if (!Number.isSafeInteger(v[field])) throw new Error(`${field} must be an integer`);
		return v as unknown as Config;
	} finally {
		closeSync(fd);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const preflightOnly = args[0] === "--preflight-only";
	const path = args[preflightOnly ? 1 : 0];
	if (!path || args.length !== (preflightOnly ? 2 : 1))
		throw new Error(
			"usage: node research/governed-initial-continuation/run.ts [--preflight-only] /absolute/private-config.json",
		);
	const { keyFile, ...options } = readConfig(path);
	const key = readEndoDigestKeyV0(keyFile, (message) => {
		throw new Error(message);
	});
	const preflight = await preflightInitialContinuationV0(options, key);
	if (preflight.status !== "ready") throw new Error(`preflight refused: ${preflight.reason}`);
	stdout.write(
		`${JSON.stringify(
			{
				status: "ready-no-request-sent",
				keyFile,
				options,
				plan: preflight.plan,
				limits: {
					requestWireBytes: 1024 * 1024,
					// Every response is part of the aggregate count and cannot exceed it.
					responseWireBytesAtMost: options.maxTransferredBytes,
					aggregateTransferredBytes: options.maxTransferredBytes,
					rpcOutputBytes: preflight.plan.maxRpcOutputBytes,
					wallTimeoutMs: options.wallTimeoutMs,
					secondApprovalIdleMs: options.maxApprovalIdleMs,
				},
				acceptance:
					"Two separately approved turns, one owned Pi process and session, two complete captured exchanges, matching retained context, no tools or extra requests, and a verified final receipt. A timeout, disconnect or failed verification is not success and is never retried.",
			},
			null,
			2,
		)}\n`,
	);
	if (preflightOnly) return;
	if (!stdin.isTTY || !stdout.isTTY)
		throw new Error("both stdin and stdout must be a terminal for explicit approvals");
	const input = createInterface({ input: stdin, output: stdout });
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	input.once("close", cancel);
	const ask = async (prompt: string, timeoutMs: number): Promise<string | null> => {
		try {
			return await input.question(prompt, {
				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
			});
		} catch {
			return null;
		}
	};
	try {
		const firstPhrase = `APPROVE FIRST ${preflight.plan.initial.attemptId}`;
		if (
			(await ask(`Type ${firstPhrase} to approve only the first turn; anything else declines: `, 300000)) !==
			firstPhrase
		) {
			stdout.write("First turn declined or approval expired; no attempt was started.\n");
			return;
		}
		const first = approveInitialContinuationV0(
			preflight.plan,
			preflight.plan.commitment,
			"approve first tool-free turn",
		);
		const result = await executeInitialContinuationV0(
			preflight.plan,
			first,
			options.prompt,
			options.continuationPrompt,
			key,
			async (boundary) => {
				stdout.write(
					`${JSON.stringify({ provisionalBoundary: boundary, continuationPrompt: options.continuationPrompt }, null, 2)}\n`,
				);
				const phrase = `APPROVE CONTINUATION ${boundary.attemptId}`;
				const answer = await ask(
					`Type ${phrase} to approve the second turn against this boundary; anything else declines: `,
					Date.parse(boundary.approvalDeadlineAt) - Date.now(),
				);
				if (answer !== phrase || controller.signal.aborted) return null;
				try {
					return approveContinuationTurnV0(boundary, boundary.commitment, "approve continuation turn");
				} catch {
					return null;
				}
			},
			controller.signal,
		);
		const verification =
			"area" in result
				? await verifyInitialContinuationEvidenceV0(
						options.source,
						options.replay,
						key,
						join(result.area, "receipt.json"),
					)
				: null;
		stdout.write(`${JSON.stringify({ result, verification }, null, 2)}\n`);
		if (result.status !== "completed" || verification?.status !== "verified") process.exitCode = 1;
	} finally {
		input.removeListener("close", cancel);
		input.close();
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`Acceptance runner stopped: ${error instanceof Error ? error.message : "unknown error"}\n`);
	process.exitCode = 1;
});
