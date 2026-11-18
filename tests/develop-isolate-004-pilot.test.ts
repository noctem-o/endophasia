import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runProtectedExperimentV0 } from "../cli/experiment-protected.ts";
import { readEndoProtectedSpecV0 } from "../protocol/protected-experiment.ts";
import { codingFixtureSpec } from "../research/develop-isolate-004/pilot.ts";
import { readEndoProtectedTrialFileV0 } from "../runtime/contracts/protected-experiment.ts";

it("declares a fixed local fixture without a shell runtime or extra submission paths", () => {
	const spec = codingFixtureSpec("/synthetic/agent");
	expect(readEndoProtectedSpecV0(spec).ok).toBe(true);
	expect(spec.runtime).toEqual({ executables: ["/usr/bin/node"], aliases: [] });
	expect(spec.conditions[0]?.agent.argv).toEqual(["/usr/bin/node", "/agent/launch.mjs", "--read-edit-pilot"]);
	expect(spec.tasks[0]?.submission).toEqual(["src/interval.mjs"]);
	expect(spec.modelAccess).toMatchObject({ upstream: "http://127.0.0.1:8090", maxExchanges: 5 });
});

it.runIf(process.env.ENDO_ISOLATE_HOST === "1")(
	"rejects the unchanged bug in a separate protected evaluation",
	async () => {
		const base = mkdtempSync("/tmp/endo-coding-control-");
		try {
			const agent = join(base, "empty-agent");
			mkdirSync(agent);
			const pilot = codingFixtureSpec(agent);
			const { memoryMaxBytes: _memory, cpuQuotaPercent: _cpu, ...limits } = pilot.limits;
			const spec = readEndoProtectedSpecV0({
				schemaVersion: "endo.protected-experiment-spec.v0",
				id: pilot.id,
				description: pilot.description,
				seed: pilot.seed,
				trials: 1,
				tasks: pilot.tasks,
				limits,
				runtime: { executables: ["/usr/bin/node"] },
				conditions: [
					{
						id: "noop",
						description: "Leaves the defect unchanged.",
						agent: { directory: agent, argv: ["/usr/bin/node", "-e", "void 0"] },
					},
				],
			});
			if (!spec.ok) throw new Error(spec.message);
			const dir = join(base, "result");
			await runProtectedExperimentV0({ spec: spec.value, dir });
			const record = readEndoProtectedTrialFileV0(join(dir, "trials/merge-intervals/noop/0/attempt-1/record.json"));
			if (!record.ok) throw new Error(record.reason);
			expect(record.value.agent).toMatchObject({ exitCode: 0, termination: "confirmed" });
			expect(record.value.evaluation).toMatchObject({ status: "failed", cases: { passed: 6, total: 7 } });
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	},
);
