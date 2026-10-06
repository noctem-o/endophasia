/**
 * Real-runtime smoke, opt-in: ENDO_OMP_EXECUTABLE=/path/to/an/installed/omp  (npm run test:acp-omp-real).
 *
 * Launches OMP's built-in ACP server (`omp acp`, over stdio), negotiates ACP v1, opens a session in a scratch
 * directory, sends one non-destructive prompt, and checks that genuine session/update traffic arrived and that
 * closing the adapter leaves no process behind. It is a smoke test of one real path, not a conformance study.
 *
 * Environment boundary: the child receives exactly PATH and HOME (so OMP finds the operator's existing ~/.omp
 * configuration and credentials, which this test never reads or prints) plus any variables the operator names in
 * ENDO_OMP_ENV_PASSTHROUGH (comma-separated names, e.g. a provider key variable). Nothing else is inherited, and no
 * value is logged. This suite may therefore use the operator's configured model, which can cost money: that is the
 * reason it is opt-in. Permission requests fail closed (no handler is supplied).
 *
 * What counts as a skip, with the reason stated: `omp` not an executable file or without an `acp` command in --help, an explicit JSON-RPC refusal of session/new, or
 * a prompt that completed with no message, thought or tool-call update (OMP ends a failed model call with end_turn, so a missing
 * model/provider configuration looks exactly like that). A wrong protocol version, a hang, or a child that survives
 * close() fails.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ACP_LOSS_ACCOUNTING_V0,
	ACP_MAPPING_VERSION,
	ACP_SCHEMA_V0,
	AcpClientV0,
	AcpRefusedErrorV0,
	AcpTimeoutErrorV0,
} from "../adapters/acp/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";

const executable = process.env.ENDO_OMP_EXECUTABLE;

// Every sequential bound the test sets, so the test's own timeout cannot fire before them and mask what they report:
// two 30 s preflight commands, two 60 s attach requests (initialize, session/new), the 180 s prompt, and a close that
// may take two 2 s graces plus the release, with slack.
const PREFLIGHT_MS = 2 * 30_000;
const ATTACH_MS = 2 * 60_000;
const PROMPT_MS = 180_000;
// Optional-method exercise: list, a second attach (resume) and its close, each bounded by ATTACH_MS / 2.
const OPTIONAL_MS = ATTACH_MS / 2 + ATTACH_MS + 30_000;
const TEST_TIMEOUT_MS = PREFLIGHT_MS + ATTACH_MS + PROMPT_MS + OPTIONAL_MS + 60_000;

function launchEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of ["PATH", "HOME", ...(process.env.ENDO_OMP_ENV_PASSTHROUGH ?? "").split(",")]) {
		const key = name.trim();
		const value = key.length > 0 ? process.env[key] : undefined;
		if (value !== undefined) env[key] = value;
	}
	return env;
}

describe.runIf(executable !== undefined && executable.length > 0)("real OMP over ACP v1 (opt-in)", () => {
	it(
		"observes a real session through `omp acp`",
		async (ctx) => {
			const omp = executable as string;
			try {
				accessSync(omp, constants.X_OK);
			} catch {
				return ctx.skip(`ENDO_OMP_EXECUTABLE (${omp}) is not an executable file`);
			}
			const env = launchEnv();
			// A configured executable that crashes or hangs on --version/--help is a broken installation, not a skip.
			const version = execFileSync(omp, ["--version"], { env, encoding: "utf8", timeout: PREFLIGHT_MS / 2 }).trim();
			const help = execFileSync(omp, ["--help"], { env, encoding: "utf8", timeout: PREFLIGHT_MS / 2 });
			if (!/\bacp\b/.test(help)) return ctx.skip(`omp ${version} does not list an \`acp\` command in --help`);

			const scratch = realpathSync(mkdtempSync(join(tmpdir(), "endo-acp-omp-")));
			const events: EndoEventV0[] = [];
			let client: AcpClientV0 | undefined;
			try {
				try {
					client = await AcpClientV0.connect(
						{
							launch: { command: omp, args: ["acp"], cwd: scratch, env },
							attachment: "omp.default",
							onEvent: (event) => events.push(event),
							requestTimeoutMs: ATTACH_MS / 2,
							promptTimeoutMs: PROMPT_MS,
						},
						{ cwd: scratch },
					);
				} catch (error) {
					if (error instanceof AcpRefusedErrorV0) {
						return ctx.skip(`omp ${version} did not open an ACP session: ${error.message}`);
					}
					throw error;
				}

				// The handshake, as the agent reported it (its own claim, not a verified binary identity).
				expect(client.initialize.protocolVersion).toBe(1);
				console.info(
					"[acp-omp] omp --version:",
					version,
					"| agentInfo:",
					JSON.stringify(client.initialize.agentInfo),
					"| agentCapabilities:",
					JSON.stringify(client.initialize.agentCapabilities),
				);

				let result: Awaited<ReturnType<AcpClientV0["prompt"]>>;
				try {
					result = await client.prompt("Reply with the single word OK. Do not use any tools or modify any files.");
				} catch (error) {
					if (error instanceof AcpRefusedErrorV0) return ctx.skip(`omp refused session/prompt: ${error.message}`);
					if (error instanceof AcpTimeoutErrorV0) throw error;
					throw error;
				}
				console.info("[acp-omp] stopReason:", result.stopReason, "| updates:", JSON.stringify(result.updates));
				// Only what the prompt itself produces counts: OMP sends bootstrap updates (available commands, session info,
				// config options) shortly after session/new, whatever the model does.
				const promptOutput = ["agent_message_chunk", "agent_thought_chunk", "tool_call"].reduce(
					(sum, variant) => sum + (result.updates[variant] ?? 0),
					0,
				);
				if (promptOutput === 0) {
					return ctx.skip(
						`omp ${version} completed the prompt (${result.stopReason}) with no message, thought or tool update: its model/provider is probably not configured`,
					);
				}
				expect(result.stopReason).toBe("end_turn");
				expect(events.some((event) => event.kind === "lifecycle.run-completed")).toBe(true);
				expect(events.some((event) => event.kind === "lifecycle.session-started")).toBe(true);
				// Strict schema validation of everything OMP sent: nothing it sent was malformed or a protocol fault.
				expect(events.filter((event) => event.kind === "runtime.malformed-event")).toEqual([]);
				expect(events.filter((event) => event.kind === "harness.protocol-fault")).toEqual([]);

				// Optional v1 methods, exercised only if OMP advertised them. Not advertised is not a failure.
				const optional: Record<string, string> = {};
				if (client.sessionCapabilities.list) {
					const page = await client.listSessions({ cwd: scratch });
					optional.list = `ok (${page.sessions.length} session(s) on the first page)`;
				} else optional.list = "not advertised";
				if (client.sessionCapabilities.resume) {
					// A second process instance reattaches to the session the first one ran. OMP may legitimately refuse (for
					// example if it did not persist the session); that is reported, not failed.
					const second: EndoEventV0[] = [];
					try {
						const resumed = await AcpClientV0.connect(
							{
								launch: { command: omp, args: ["acp"], cwd: scratch, env },
								attachment: "omp.resumed",
								onEvent: (event) => second.push(event),
								requestTimeoutMs: ATTACH_MS / 2,
							},
							{ cwd: scratch, resume: { sessionId: client.sessionId } },
						);
						try {
							expect(second.find((event) => event.kind === "harness.attached")?.payload).toMatchObject({
								openedBy: "session/resume",
								historyReplay: "not-requested",
							});
							optional.resume = "ok";
							if (resumed.sessionCapabilities.close) {
								// Its own handling: a refused close says nothing about whether resume worked.
								try {
									await resumed.closeSession();
									optional.close = second.some((event) => event.kind === "session.close-accepted")
										? "ok (acceptance only)"
										: "no acceptance recorded";
								} catch (error) {
									if (!(error instanceof AcpRefusedErrorV0)) throw error;
									optional.close = `refused by omp (JSON-RPC error ${error.code})`;
								}
							} else optional.close = "not advertised";
						} finally {
							await resumed.close();
							expect(resumed.liveProcessMembers()).toBe(false);
						}
					} catch (error) {
						if (!(error instanceof AcpRefusedErrorV0)) throw error;
						optional.resume = `refused by omp (JSON-RPC error ${error.code})`;
						optional.close = "not exercised (no resumed session)";
					}
				} else {
					optional.resume = "not advertised";
					optional.close = client.sessionCapabilities.close
						? "advertised, not exercised without a resumed session"
						: "not advertised";
				}
				const verdicts = Object.fromEntries(
					ACP_LOSS_ACCOUNTING_V0.entries
						.filter((entry) => /^(session\.|usage\.|tool\.|config\.|prompt\.response)/.test(entry.id))
						.map((entry) => [entry.id, entry.verdict]),
				);
				console.info(
					"[acp-omp-report]",
					JSON.stringify({
						omp: version,
						mapping: ACP_MAPPING_VERSION,
						schemaSha256: ACP_SCHEMA_V0.sha256,
						negotiatedProtocolVersion: client.initialize.protocolVersion,
						agentCapabilities: client.initialize.agentCapabilities,
						optionalMethodsAdvertised: client.sessionCapabilities,
						optionalMethodsExercised: optional,
						updateVariantsObserved: Object.keys(client.updateCounts).sort(),
						eventKinds: [...new Set(events.map((event) => event.kind))].sort(),
						verdicts,
					}),
				);
			} finally {
				if (client !== undefined) {
					await client.close();
					expect(client.liveProcessMembers()).toBe(false);
				}
				rmSync(scratch, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
