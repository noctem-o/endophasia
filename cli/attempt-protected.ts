/**
 * "endo attempt protected-run": execute ONE prepared DEVELOP attempt through the existing protected runner, after the operator approves the
 * exact operation on this process's controlling terminal (docs/designs/protected-attempt-execution.md).
 *
 *   endo attempt protected-run [<root> | --root dir] --attempt <id> --template <spec.json> --out <new dir>
 *
 * The terminal is the authority, as in the workbench: stdin and stderr must both be this process's controlling terminal, or nothing is read
 * or written. There is no flag that approves, no default that approves, and no other way to answer: a script, a pipe, a page or an agent
 * message cannot run an attempt here. The runner is always cli/experiment-protected.ts runProtectedExperimentV0 with the CLI's own fixed
 * options; it refuses rather than running anything unprotected.
 */

import { createInterface } from "node:readline";
import { launchProtectedAttemptV0 } from "../adapters/develop/protected-attempt.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { flagsOf } from "./develop-tasks.ts";
import { runProtectedExperimentV0 } from "./experiment-protected.ts";
import { requireWorkbenchTerminalV0 } from "./workbench.ts";

export const ATTEMPT_PROTECTED_RUN_USAGE_V0 =
	"usage: endo attempt protected-run [<root> | --root dir] --attempt <id> --template <spec.json> --out <new dir>";

/** One line from the controlling terminal, or null when it closes first. */
function readOneLine(prompt: string): Promise<string | null> {
	return new Promise((resolveLine) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
		let answered = false;
		rl.once("close", () => {
			if (!answered) resolveLine(null);
		});
		rl.question(prompt, (line) => {
			answered = true;
			rl.close();
			resolveLine(line);
		});
	});
}

export async function attemptProtectedRunCommandV0(argv: readonly string[]): Promise<void> {
	const { root, flags } = flagsOf(argv, ["--attempt", "--template", "--out"], ATTEMPT_PROTECTED_RUN_USAGE_V0);
	const attemptId = flags.get("--attempt");
	const templatePath = flags.get("--template");
	const out = flags.get("--out");
	if (attemptId === undefined || templatePath === undefined || out === undefined)
		throw new TypeError(ATTEMPT_PROTECTED_RUN_USAGE_V0);
	try {
		requireWorkbenchTerminalV0();
	} catch (error) {
		throw new TypeError(
			"attempt protected-run is approved only on this process's controlling terminal (stdin and stderr), never from a pipe, a file or a script: " +
				(error instanceof Error ? error.message : String(error)),
		);
	}
	const result = await launchProtectedAttemptV0({
		root,
		attemptId,
		templatePath,
		out,
		approve: async (plan) => {
			process.stderr.write(plan.text);
			return readOneLine(`Type ${plan.phrase} to run exactly this once; anything else declines:\n> `);
		},
		runner: (spec, directory) => runProtectedExperimentV0({ spec, dir: directory }),
	});
	process.stdout.write(`${canonicalEndoJsonV0({ protectedAttempt: result } as never)}\n`);
	process.stderr.write(
		"attempt protected-run: " +
			result.status +
			(result.association === null ? "" : ` (association: ${result.association})`) +
			" — " +
			result.detail +
			"\n" +
			(result.evaluation === null
				? ""
				: "protected evaluation (experimental, non-authoritative; not acceptance, not a PASS): " +
					result.evaluation.status +
					(result.evaluation.cases === null
						? ""
						: ` ${result.evaluation.cases.passed}/${result.evaluation.cases.total}`) +
					"\n") +
			"Nothing was applied to any checkout and no task status changed. Read it with: endo attempt bridge --attempt " +
			attemptId +
			"\n",
	);
	if (result.status !== "bound") process.exitCode = 1;
}
