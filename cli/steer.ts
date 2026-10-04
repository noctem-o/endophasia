/**
 * The `endo steer` commands: talk to the intervention desk of a session `endo harness attach --control` keeps open
 * (cli/control.ts). Each prints the desk's JSON reply; a refusal exits 1 with its reason. Nothing here writes to the
 * store directly: the attached process records every step.
 *
 *   endo steer propose   <root> --steer text | --queue text | --stop [--observation id] [--interpretation id]
 *   endo steer authorize <root> <proposalId> --confirm <proposal digest>
 *   endo steer apply     <root> <proposalId> --authorization <authorizationId>
 *   endo steer status    <root>
 *   endo steer close     <root>
 *
 * Authorization is the local operator confirming the proposal's exact digest (printed by `propose`). Without
 * `--confirm`, or with any other value, the decision recorded is a deny. v0 proposals come only from the operator.
 */

import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoControlRequestV0 } from "./control.ts";

function take(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (value === undefined || value.startsWith("--")) throw new TypeError(`the flag ${flag} needs a value`);
	args.splice(index, 2);
	return value;
}

async function send(root: string, message: Record<string, unknown>): Promise<void> {
	const reply = await endoControlRequestV0(root, message);
	console.log(canonicalEndoJsonV0(JSON.parse(JSON.stringify(reply))));
	const result = reply.result as { status?: string } | undefined;
	if (!reply.ok || result?.status === "refused") process.exitCode = 1;
}

export const STEER_COMMANDS_V0: Readonly<Record<string, (argv: readonly string[]) => Promise<void>>> = {
	async propose(argv) {
		const args = [...argv];
		const root = args.shift();
		if (root === undefined)
			throw new TypeError("usage: endo steer propose <root> --steer text | --queue text | --stop");
		const steer = take(args, "--steer");
		const queue = take(args, "--queue");
		const stop = args.includes("--stop");
		if (stop) args.splice(args.indexOf("--stop"), 1);
		const observationId = take(args, "--observation");
		const interpretationId = take(args, "--interpretation");
		if (args.length > 0) throw new TypeError(`unknown arguments ${args.join(" ")}`);
		if ([steer !== undefined, queue !== undefined, stop].filter(Boolean).length !== 1)
			throw new TypeError("give exactly one of --steer text, --queue text, --stop");
		await send(root, {
			type: "propose",
			operation: stop ? "stop" : steer !== undefined ? "steer" : "queue",
			...(steer !== undefined ? { message: steer } : queue !== undefined ? { message: queue } : {}),
			...(observationId === undefined ? {} : { observationId }),
			...(interpretationId === undefined ? {} : { interpretationId }),
		});
	},
	async authorize(argv) {
		const args = [...argv];
		const [root, proposalId] = [args.shift(), args.shift()];
		if (root === undefined || proposalId === undefined)
			throw new TypeError("usage: endo steer authorize <root> <proposalId> --confirm <proposal digest>");
		const confirmDigest = take(args, "--confirm");
		await send(root, { type: "authorize", proposalId, ...(confirmDigest === undefined ? {} : { confirmDigest }) });
	},
	async apply(argv) {
		const args = [...argv];
		const [root, proposalId] = [args.shift(), args.shift()];
		const authorizationId = take(args, "--authorization");
		if (root === undefined || proposalId === undefined || authorizationId === undefined)
			throw new TypeError("usage: endo steer apply <root> <proposalId> --authorization <authorizationId>");
		await send(root, { type: "apply", proposalId, authorizationId });
	},
	async status(argv) {
		if (argv[0] === undefined) throw new TypeError("usage: endo steer status <root>");
		await send(argv[0], { type: "status" });
	},
	async close(argv) {
		if (argv[0] === undefined) throw new TypeError("usage: endo steer close <root>");
		await send(argv[0], { type: "close" });
	},
};
