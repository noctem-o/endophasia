// `endo harness attach --control` and `endo steer propose|authorize|apply|status|close` as real processes, against the
// fake Pi: the attached process owns the session and serves the intervention desk on an owner-only Unix socket, and each
// `endo steer` invocation is a separate process that talks to it. Exit codes are part of the contract: a refused step
// exits 1. Every step is in the store the attached process wrote.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0).reverse()) await done();
});
const temp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

const steer = (args: string[]) => {
	const run = spawnSync(process.execPath, [CLI, "steer", ...args], { encoding: "utf8" });
	let reply: { ok?: boolean; result?: Record<string, unknown>; error?: string } | null = null;
	try {
		reply = JSON.parse(run.stdout);
	} catch {
		reply = null;
	}
	return { status: run.status, reply, stderr: run.stderr };
};

function events(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	const all: EndoEventV0[] = [];
	for (let after = 0; ; ) {
		const page = store.page({ afterSequence: after, limit: 10_000 });
		if (page.events.length === 0) break;
		all.push(...page.events);
		after = page.nextAfterSequence;
	}
	store.close();
	return all;
}

describe("endo harness attach --control and endo steer, as processes (fake Pi)", () => {
	it("propose, authorize, apply, status and close; a refused apply exits 1; the attached process ends cleanly", async () => {
		const install = installFakePi("1.0.0");
		cleanup.push(() => install.remove());
		const root = temp("endo-sc-");
		const cwd = temp("endo-sc-cwd-");
		// The controls are offered only for admitted capabilities: record the live study first, in the same root.
		const studier = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
			requestTimeoutMs: 10_000,
		});
		await studier.checkLocal();
		await studier.studyLive({ authorized: true, stepTimeoutMs: 20_000 });

		let output = "";
		const child: ChildProcess = spawn(
			process.execPath,
			[CLI, "harness", "attach", root, "--pi", install.bin, "--cwd", cwd, "--control", "--prompt", "Count to forty"],
			{ env: { ...process.env, ...fakePiEnv({ FAKE_PI_STEP_MS: "120" }) }, stdio: ["ignore", "pipe", "pipe"] },
		);
		cleanup.push(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		});
		child.stdout!.on("data", (chunk) => {
			output += chunk;
		});
		const exited = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));

		const socket = join(root, "control", "endpoint.sock");
		const deadline = Date.now() + 30_000;
		while (!existsSync(socket) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
		expect(existsSync(socket)).toBe(true);

		// status offers the operations, each admitted or UNAVAILABLE with a reason.
		const first = steer(["status", root]);
		expect(first.status).toBe(0);
		expect((first.reply!.result as { operations: Record<string, { status: string }> }).operations).toMatchObject({
			steer: { status: "admitted" },
			queue: { status: "admitted" },
			stop: { status: "admitted" },
		});

		const proposed = steer(["propose", root, "--steer", "Endophasia steer: also say hello"]);
		expect(proposed.status).toBe(0);
		const proposal = proposed.reply!.result as { proposalId: string; proposalDigest: string; origin: string };
		expect(proposal.origin).toBe("operator-cli");

		// Without the exact digest the decision is a deny; applying under it is refused, and exits 1.
		const denied = steer(["authorize", root, proposal.proposalId, "--confirm", "0".repeat(64)]);
		expect(denied.reply!.result).toMatchObject({ decision: "deny" });
		const deniedAuthorization = (denied.reply!.result as { authorizationId: string }).authorizationId;
		const refused = steer(["apply", root, proposal.proposalId, "--authorization", deniedAuthorization]);
		expect(refused.status).toBe(1);
		expect(refused.reply!.result).toMatchObject({ status: "refused", reason: "authorization-denied" });
		const missing = steer([
			"apply",
			root,
			proposal.proposalId,
			"--authorization",
			"endo.evidence.intervention.authorization.none",
		]);
		expect(missing.status).toBe(1);
		expect(missing.reply!.result).toMatchObject({ status: "refused", reason: "not-authorized" });

		const authorized = steer(["authorize", root, proposal.proposalId, "--confirm", proposal.proposalDigest]);
		expect(authorized.reply!.result).toMatchObject({ decision: "allow", authority: { kind: "local-operator" } });
		const applied = steer([
			"apply",
			root,
			proposal.proposalId,
			"--authorization",
			(authorized.reply!.result as { authorizationId: string }).authorizationId,
		]);
		expect(applied.status).toBe(0);
		expect(applied.reply!.result).toMatchObject({ status: "accepted", disposition: "queued" });
		const again = steer([
			"apply",
			root,
			proposal.proposalId,
			"--authorization",
			(authorized.reply!.result as { authorizationId: string }).authorizationId,
		]);
		expect(again.reply!.result).toMatchObject({ status: "duplicate", outcome: "accepted" });

		// An unknown subcommand is refused by the client; an unknown message type by the server (see tests/intervention.test.ts).
		expect(steer(["explode", root]).status).toBe(1);
		// An endpoint open to others is refused by the client.
		chmodSync(join(root, "control"), 0o755);
		const open = steer(["status", root]);
		expect(open.status).toBe(1);
		expect(open.stderr).toMatch(/open to others/);
		chmodSync(join(root, "control"), 0o700);

		expect(steer(["close", root]).status).toBe(0);
		const code = await Promise.race([
			exited,
			new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 60_000)),
		]);
		expect(code).toBe(0);
		expect(existsSync(socket)).toBe(false);

		const printed = JSON.parse(output.slice(output.indexOf("{"))) as { interventions: { proposals: unknown[] } };
		expect(printed.interventions.proposals).toHaveLength(1);
		const kinds = events(root)
			.map((event) => event.kind)
			.filter((kind) => kind.startsWith("intervention."));
		expect(kinds.filter((kind) => kind === "intervention.proposal")).toHaveLength(1);
		expect(kinds.filter((kind) => kind === "intervention.authorization")).toHaveLength(2);
		expect(kinds.filter((kind) => kind === "intervention.refused")).toHaveLength(2);
		expect(kinds.filter((kind) => kind === "intervention.request")).toHaveLength(1);
		expect(kinds.filter((kind) => kind === "intervention.accepted")).toHaveLength(1);
		expect(kinds.filter((kind) => kind === "intervention.consequence")).toHaveLength(1);
	}, 180_000);

	it("with no attached session, endo steer refuses and says why", () => {
		const root = temp("endo-sc-none-");
		const result = steer(["status", root]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/does not exist/);
	});
});
