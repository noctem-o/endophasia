/**
 * The `endo trajectory` commands: project recorded sessions into trajectories (protocol/trajectory.ts) and compare
 * them. Both open their stores read-only, start nothing and write nothing; each prints one canonical-JSON document.
 *
 *   endo trajectory show <store> <session> [--attachment a]
 *   endo trajectory diff <storeA> <sessionA> <storeB> <sessionB> [--attachment-a a] [--attachment-b b]
 *
 * <session> is an endo session coordinate (endo.session.pi.…) or the Pi session id. The store is recorded in the
 * trajectory as given on the command line.
 */

import { piTrajectoryAttachmentsV0, piTrajectorySessionV0, projectPiTrajectoryV0 } from "../adapters/pi/trajectory.ts";
import type { EndoEventV0 } from "../protocol/event.ts";
import type { EndoTrajectoryV0 } from "../protocol/trajectory.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { compareEndoTrajectoriesV0 } from "../runtime/contracts/trajectory.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { takeEndoRootV0 } from "./root-args.ts";

/** Every event of the store at `root`, in store order, read through a read-only open. */
export function readEndoStoreEventsV0(root: string): EndoEventV0[] {
	const store = createEndoDurableEventStoreV0(root, { readOnly: true });
	try {
		const events: EndoEventV0[] = [];
		let after = 0;
		for (;;) {
			const page = store.page({ afterSequence: after, limit: 10_000 });
			if (page.events.length === 0) break;
			events.push(...page.events);
			after = page.nextAfterSequence;
		}
		return events;
	} finally {
		store.close();
	}
}

/** The trajectory of one session of the store at `root`. `label` is what `source.store` records (default: root). */
export function trajectoryFromStoreV0(
	root: string,
	session: string,
	options: { attachment?: string; label?: string } = {},
): EndoTrajectoryV0 {
	const events = readEndoStoreEventsV0(root);
	const coordinate = piTrajectorySessionV0(session);
	if (piTrajectoryAttachmentsV0(events, coordinate).length === 0) {
		const known = [...new Set(events.flatMap((event) => event.coordinates.sessionId ?? []))].sort();
		throw new TypeError(
			`no Pi attachment recorded ${coordinate} in ${root}; recorded sessions: ${known.length === 0 ? "none" : known.join(", ")}`,
		);
	}
	return projectPiTrajectoryV0(events, {
		store: options.label ?? root,
		session,
		...(options.attachment === undefined ? {} : { attachment: options.attachment }),
	});
}

function flagsOf(args: string[], allowed: readonly string[]): Map<string, string> {
	const flags = new Map<string, string>();
	for (let index = 0; index < args.length; ) {
		const flag = args[index]!;
		if (!flag.startsWith("--")) {
			index += 1;
			continue;
		}
		if (!allowed.includes(flag)) throw new TypeError(`unknown flag ${flag}`);
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new TypeError(`the flag ${flag} needs a value`);
		flags.set(flag, value);
		args.splice(index, 2);
	}
	return flags;
}

function print(value: unknown): void {
	process.stdout.write(canonicalEndoJsonV0(value));
}

/** `trajectory show <store> <session> [--attachment a]` */
export function trajectoryShowCommand(argv: readonly string[]): void {
	const { root, rest } = takeEndoRootV0(argv, 1);
	const flags = flagsOf(rest, ["--attachment"]);
	if (rest.length !== 1)
		throw new TypeError("usage: endo trajectory show [<store> | --root dir] <session> [--attachment a]");
	const attachment = flags.get("--attachment");
	print(trajectoryFromStoreV0(root, rest[0]!, attachment === undefined ? {} : { attachment }));
}

/** `trajectory diff <storeA> <sessionA> <storeB> <sessionB> [--attachment-a a] [--attachment-b b]` */
export function trajectoryDiffCommand(argv: readonly string[]): void {
	const args = [...argv];
	const flags = flagsOf(args, ["--attachment-a", "--attachment-b"]);
	if (args.length !== 4)
		throw new TypeError(
			"usage: endo trajectory diff <storeA> <sessionA> <storeB> <sessionB> [--attachment-a a] [--attachment-b b]",
		);
	const a = flags.get("--attachment-a");
	const b = flags.get("--attachment-b");
	print(
		compareEndoTrajectoriesV0(
			trajectoryFromStoreV0(args[0]!, args[1]!, a === undefined ? {} : { attachment: a }),
			trajectoryFromStoreV0(args[2]!, args[3]!, b === undefined ? {} : { attachment: b }),
		),
	);
}

export const TRAJECTORY_COMMANDS_V0: Record<string, (argv: readonly string[]) => void> = {
	show: trajectoryShowCommand,
	diff: trajectoryDiffCommand,
};
