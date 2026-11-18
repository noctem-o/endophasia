import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { WorkbenchBrokerV0 } from "../adapters/pi/workbench.ts";
import { processStartTimeV0 } from "../adapters/sandbox/bubblewrap.ts";
import { admitWorkspaceV0 } from "../adapters/sandbox/workspace-admission.ts";
import { type PiLaunchAttestationV0, startAttestedPiV0 } from "../cli/attested-pi.ts";
import { attestedExecutionProtectionV0, PI_WORKSPACE_PROTECTION_V0 } from "../cli/execution-protection.ts";
import { endoProtectionHoldsV0 } from "../runtime/contracts/execution-protection.ts";

const subject = { session: "endo.session.pi.fixture", workspaceRoot: "/work" };
const good = Object.freeze({ ...subject, check: () => true });

it.each([
	["deleted", null, "not-enforced", "No live execution attestation is available for this launch."],
	[
		"wrong session",
		{ ...good, session: "endo.session.pi.stale" },
		"not-enforced",
		"The execution attestation is for a different session or workspace.",
	],
	[
		"wrong workspace",
		{ ...good, workspaceRoot: "/other" },
		"not-enforced",
		"The execution attestation is for a different session or workspace.",
	],
	["corrupted", { ...good, session: "" }, "unknown", "The live execution attestation is inconsistent."],
	["contradictory copy", { ...good }, "unknown", "The live execution attestation is inconsistent."],
] as const)(
	"latches loss when the controller test seam substitutes a %s record",
	(_name, replacement, state, limitation) => {
		let record: PiLaunchAttestationV0 | null = good;
		const provider = attestedExecutionProtectionV0(
			() => record,
			() => subject,
		);
		expect(provider.observe()).toMatchObject({
			state: "enforced",
			level: "workspace",
			mechanism: PI_WORKSPACE_PROTECTION_V0,
			...subject,
		});
		expect(endoProtectionHoldsV0(provider.observe(), "restricted", subject)).toBe(false);
		record = replacement;
		expect(provider.observe()).toEqual({
			state,
			level: "none",
			mechanism: null,
			session: null,
			workspaceRoot: null,
			limitations: [limitation],
		});
		record = good;
		expect(provider.observe().state).toBe(state);
	},
);

it("ignores a purported attestation written by a workspace even with the exact subject", () => {
	const base = mkdtempSync("/tmp/endo-forgery-");
	try {
		const work = { ...subject, workspaceRoot: base };
		writeFileSync(
			join(base, "attestation.json"),
			JSON.stringify({ ...work, state: "enforced", level: "restricted" }),
		);
		const provider = attestedExecutionProtectionV0(
			() => null,
			() => work,
		);
		expect(provider.observe()).toMatchObject({
			state: "not-enforced",
			level: "none",
			session: null,
			workspaceRoot: null,
		});
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

it
	.runIf(process.platform === "linux" && process.env.ENDO_ATTESTED_PI_HOST === "1")
	.each([
		"owned Pi exits by signal",
		"workspace evidence becomes unreadable",
		"startup cancelled at handoff",
	] as const)(
	"records the isolated session outcome when %s, without an upstream call",
	async (scenario) => {
		const base = mkdtempSync("/tmp/endo-everyday-loss-");
		const parent = join(base, "parent");
		const work = join(parent, "work");
		const home = join(base, "home");
		const root = join(base, "store");
		for (const directory of [parent, work, home, root]) mkdirSync(directory, { mode: 0o700 });
		const env = {
			PATH: "/usr/bin",
			HOME: home,
			PI_CODING_AGENT_DIR: home,
			PI_OFFLINE: "1",
			GIT_CONFIG_NOSYSTEM: "1",
		};
		let piPid: number | undefined;
		let proof: PiLaunchAttestationV0 | null = null;
		const abort = new AbortController();
		let session: Awaited<ReturnType<PiAttachmentV0["openSession"]>> | undefined;
		let broker: WorkbenchBrokerV0 | undefined;
		let dispose: (() => void) | undefined;
		try {
			execFileSync("/usr/bin/git", ["-C", work, "init", "-q"], { env, stdio: "pipe" });
			const admitted = admitWorkspaceV0({ root: work, evidenceRoot: root, internalRoots: [home] });
			if (!admitted.ok) throw new Error(admitted.detail);
			dispose = admitted.dispose;
			const owner = new PiAttachmentV0({
				root,
				cwd: home,
				env,
				executable: "/usr/bin/pi",
				tools: "none",
				governedToolFree: true,
				async isolatedSession(onDiagnostic) {
					const launched = await startAttestedPiV0(admitted, {
						onDiagnostic,
						onClosed: async () => admitted.dispose(),
					});
					proof = launched.attestation;
					piPid = launched.client.connection.pid;
					if (scenario === "startup cancelled at handoff") abort.abort();
					return launched;
				},
			});
			await owner.checkLocal();
			if (scenario === "startup cancelled at handoff") {
				await expect(owner.openSession(abort.signal)).rejects.toThrow("startup cancelled");
				expect(await owner.failedStartCleanup()).toMatchObject([{ boundary: "scope", result: "confirmed" }]);
				return;
			}
			session = await owner.openSession();
			const live = session;
			const protection = attestedExecutionProtectionV0(
				() => proof,
				() => ({ session: `endo.session.pi.${live.piSessionId}`, workspaceRoot: work }),
			);
			const ended: string[] = [];
			const authority = new WorkbenchBrokerV0({
				session,
				key: owner.digestKey(),
				attachment: owner.attachment,
				approver: async () => "deny",
				control: { mode: "everyday", workspaceRoot: work, protection },
				onSessionControl: (event) => {
					if (event.type === "ended") ended.push(event.reason);
				},
			});
			broker = authority;
			const revoked = session.exited().then(() => authority.endSession());
			const code = authority.issuePairingCode({ control: true });
			expect(code.control).not.toBeNull();
			const answer = await authority.handle({
				method: "POST",
				route: ["pair"],
				body: { code: code.code },
				grant: null,
				query: "",
			});
			expect(answer.status).toBe(200);
			const token = (answer.body as { grant: string }).grant;
			expect(authority.sessionControl().grant).not.toBeNull();
			if (piPid === undefined) throw new Error("no owned Pi process");
			const start = processStartTimeV0(piPid);
			expect(start).not.toBeNull();
			if (scenario === "owned Pi exits by signal") {
				process.kill(piPid, "SIGKILL");
				await revoked;
				expect(processStartTimeV0(piPid)).not.toBe(start);
				expect(protection.observe().state).toBe("not-enforced");
			} else {
				chmodSync(parent, 0);
				try {
					expect(authority.sessionControl().mode.effective).toBe("strict");
					expect(protection.observe()).toMatchObject({
						state: "unknown",
						limitations: ["The live execution evidence could not be read."],
					});
					expect(processStartTimeV0(piPid)).toBe(start);
				} finally {
					chmodSync(parent, 0o700);
				}
			}
			expect(ended).toEqual(["protection-lost"]);
			expect(authority.sessionControl().grant).toBeNull();
			const proposed = await authority.handle({
				method: "POST",
				route: ["prompt", "propose"],
				body: { message: "Do not send." },
				grant: token,
				query: "",
			});
			if (scenario === "owned Pi exits by signal") expect(proposed.status).toBe(401);
			else expect(proposed.body).toMatchObject({ authorizedBy: null });
		} finally {
			await broker?.dispose();
			await session?.close();
			if (session !== undefined)
				expect(await session.processCleanup()).toMatchObject([{ boundary: "scope", result: "confirmed" }]);
			dispose?.();
			rmSync(base, { recursive: true, force: true });
		}
	},
	30_000,
);
