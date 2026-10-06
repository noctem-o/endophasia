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
 * What counts as a skip, with the reason stated: `omp` missing or without an `acp` command, a refused session/new, or
 * a prompt that completed without any session/update (OMP ends a failed model call with end_turn, so a missing
 * model/provider configuration looks exactly like that). A wrong protocol version, a hang, or a child that survives
 * close() fails.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpClientV0, AcpProcessExitedErrorV0, AcpRefusedErrorV0, AcpTimeoutErrorV0 } from "../adapters/acp/index.ts";
import type { EndoEventV0 } from "../protocol/event.ts";

const executable = process.env.ENDO_OMP_EXECUTABLE;

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
	it("observes a real session through `omp acp`", async (ctx) => {
		const omp = executable as string;
		try {
			accessSync(omp, constants.X_OK);
		} catch {
			return ctx.skip(`ENDO_OMP_EXECUTABLE (${omp}) is not an executable file`);
		}
		const env = launchEnv();
		let version: string;
		try {
			version = execFileSync(omp, ["--version"], { env, encoding: "utf8", timeout: 30_000 }).trim();
			const help = execFileSync(omp, ["--help"], { env, encoding: "utf8", timeout: 30_000 });
			if (!/\bacp\b/.test(help)) return ctx.skip(`omp ${version} does not list an \`acp\` command in --help`);
		} catch (error) {
			return ctx.skip(`omp could not report its version/help: ${(error as Error).message.split("\n")[0]}`);
		}

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
						requestTimeoutMs: 60_000,
						promptTimeoutMs: 180_000,
					},
					{ cwd: scratch },
				);
			} catch (error) {
				if (error instanceof AcpRefusedErrorV0 || error instanceof AcpProcessExitedErrorV0) {
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
			const updateCount = Object.values(result.updates).reduce((sum, count) => sum + count, 0);
			if (updateCount === 0) {
				return ctx.skip(
					`omp ${version} completed the prompt (${result.stopReason}) with no session/update: its model/provider is probably not configured`,
				);
			}
			expect(result.stopReason).toBe("end_turn");
			expect(events.some((event) => event.kind === "lifecycle.run-completed")).toBe(true);
			expect(events.some((event) => event.kind === "lifecycle.session-started")).toBe(true);
		} finally {
			if (client !== undefined) {
				await client.close();
				expect(client.liveProcessMembers()).toBe(false);
			}
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 300_000);
});
