import { buildSandboxProfileV0, detectBubblewrapV0, resolveRuntimeV0, runSandboxV0 } from "./bubblewrap.ts";
import { detectContainmentV0 } from "./containment.ts";
import { admitWorkspaceV0, type WorkspaceAdmissionInputV0 } from "./workspace-admission.ts";

const GIT = "/usr/bin/git";
const PREFIX = [
	GIT,
	"--git-dir=/work/.git",
	"--work-tree=/work",
	"--no-pager",
	"--no-optional-locks",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"protocol.allow=never",
] as const;

export async function inspectWorkspaceGitV0(input: WorkspaceAdmissionInputV0) {
	const admitted = admitWorkspaceV0(input);
	if (!admitted.ok) return admitted;
	const unavailable = (detail: string) => ({ ok: false as const, reason: "isolation-unavailable" as const, detail });
	try {
		const bubblewrap = detectBubblewrapV0();
		if (!bubblewrap.ok) return unavailable(bubblewrap.detail);
		const containment = await detectContainmentV0();
		if (!containment.ok) return unavailable(containment.detail);
		const runtime = resolveRuntimeV0([GIT]);
		if (!runtime.ok) return unavailable(runtime.detail);
		const profile = buildSandboxProfileV0({
			runtime: runtime.files,
			mounts: [{ source: admitted.snapshot, target: "/work", kind: "ro-dir", role: "admitted-workspace" }],
			cwd: "/work",
			tmpfsBytes: 16 * 1024 * 1024,
			env: {
				HOME: "/home/agent",
				PATH: "/nonexistent",
				LC_ALL: "C",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_SYSTEM: "/dev/null",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_ATTR_NOSYSTEM: "1",
				GIT_EXEC_PATH: "/nonexistent",
				GIT_NO_LAZY_FETCH: "1",
				GIT_NO_REPLACE_OBJECTS: "1",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ALLOW_PROTOCOL: "",
				GIT_PROTOCOL_FROM_USER: "0",
			},
		});
		const results: Buffer[] = [];
		for (const args of [
			["status", "--porcelain=v2", "-z", "--no-ahead-behind", "--ignore-submodules=all"],
			["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--"],
		]) {
			const run = await runSandboxV0(bubblewrap.bwrap, profile, [...PREFIX, ...args], {
				containment: containment.containment,
				timeoutMs: 10_000,
				outputBytes: 256 * 1024,
			});
			if (
				!run.started ||
				run.exitCode !== 0 ||
				run.timedOut ||
				run.termination !== "confirmed" ||
				run.initGone !== true ||
				run.truncated.stdout !== 0 ||
				run.truncated.stderr !== 0
			)
				return { ok: false as const, reason: "git-unavailable" as const, detail: "confined Git did not complete" };
			results.push(run.stdout);
		}
		return {
			ok: true as const,
			workspaceRoot: admitted.workspaceRoot,
			workspaceIdentity: admitted.workspaceIdentity,
			status: results[0] ?? Buffer.alloc(0),
			diff: results[1] ?? Buffer.alloc(0),
		};
	} catch {
		return unavailable("the confined inspector could not be established");
	} finally {
		admitted.dispose();
	}
}
