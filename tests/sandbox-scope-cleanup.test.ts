import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { processStartTimeV0, resetAbandonedSandboxScopesV0, scopeArgsV0 } from "../adapters/sandbox/containment.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn(),
}));

const containment = {
	mechanism: "systemd-user-scope",
	systemdRun: "/fake/systemd-run",
	systemctl: "/fake/systemctl",
	version: "262",
	systemdRunSha256: "0".repeat(64),
	env: {},
	tasksMax: 512,
} as const;
const sandbox = (letter: string) => `endo-sandbox-${letter.repeat(24)}`;

it.runIf(process.platform === "linux")(
	"marks retained scopes with their controller identity without collecting their result early",
	() => {
		const unit = sandbox("a");
		const command = ["/usr/bin/true"];
		expect(scopeArgsV0(containment, unit, 20, command)).toContain("--collect");
		const args = scopeArgsV0(containment, unit, 20, command, { cpuQuotaPercent: 100 });
		expect(args).not.toContain("--collect");
		expect(args).toContain(
			`--description=Endophasia sandbox (owner pid ${process.pid} start ${processStartTimeV0(process.pid)})`,
		);
	},
);

it("resets only abandoned, empty Endophasia sandbox scopes in failed or inactive state", () => {
	const ours = "Endophasia sandbox (owner pid 2147483647 start 1)";
	const states = [
		[sandbox("a"), "failed", "yes", ours, ""],
		[sandbox("b"), "inactive", "yes", ours, ""],
		[sandbox("c"), "active", "yes", ours, ""],
		[sandbox("d"), "failed", "no", ours, ""],
		[sandbox("e"), "failed", "yes", "[systemd-run] /usr/bin/bwrap", ""],
		[
			sandbox("f"),
			"failed",
			"yes",
			`Endophasia sandbox (owner pid ${process.pid} start ${processStartTimeV0(process.pid)})`,
			"",
		],
		[sandbox("1"), "failed", "yes", ours, "/unknown-cgroup"],
		[`endo-live-${"a".repeat(24)}`, "failed", "yes", ours, ""],
		["endo-sandbox-unrelated", "failed", "yes", ours, ""],
	];
	const mocked = vi.mocked(spawnSync);
	mocked.mockImplementation((_command, args) => {
		let stdout = "";
		if (args?.[1] === "list-units") {
			stdout = states.map(([unit]) => `${unit}.scope loaded failed failed fixture`).join("\n");
		} else if (args?.[1] === "show") {
			const row = states.find(([unit]) => args[2] === `${unit}.scope`);
			if (row === undefined) throw new Error("unexpected scope");
			const [, state, transient, description, group] = row;
			stdout = `ActiveState=${state}\nTransient=${transient}\nDescription=${description}\nControlGroup=${group}\n`;
		}
		return { pid: 1, output: [], stdout, stderr: "", status: 0, signal: null };
	});
	try {
		resetAbandonedSandboxScopesV0(containment);
		expect(mocked.mock.calls.map(([, args]) => args).filter((args) => args?.[1] === "reset-failed")).toEqual([
			["--user", "reset-failed", `${sandbox("a")}.scope`],
			["--user", "reset-failed", `${sandbox("b")}.scope`],
		]);
	} finally {
		mocked.mockReset();
	}
});
