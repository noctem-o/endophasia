import { ENDO_ATTACHMENT_STORE_FORMAT_V0 } from "../protocol/store-format.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { detectEndoStoreFormatV0, type EndoStoreFormatV0 } from "../storage/store-format.ts";
import {
	endoStoreCreatedLineV0,
	initEndoEventStoreV0,
	migrateEndoEventStoreV0,
} from "../storage/store-format-write.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";
import { resolveEndoStoreRootV0 } from "./store-root.ts";

export const STORE_FORMAT_USAGE_V0 = "usage: endo store <status|migrate|init> [--root dir] ...";
const PRECONDITIONS =
	"Back up the root and the installation key separately; stop every process using this root and retire pre-E4 writers. The #182 lock floors only lock-taking writers; older unlocked ingest and DSH imports are not fenced. Never remove the sentinel. See docs/designs/event-store-concurrent.md.";

function printable(state: EndoStoreFormatV0) {
	if (!("raw" in state)) return state;
	const { raw: _raw, ...report } = state;
	return report;
}

function status(argv: readonly string[]): void {
	const args = takeEndoRootV0(argv, 0);
	if (args.rest.length !== 0) throw new TypeError(STORE_FORMAT_USAGE_V0);
	announceEndoRootV0(args);
	const state = detectEndoStoreFormatV0(args.root);
	console.log(canonicalEndoJsonV0(printable(state)));
	if (state.state === "format-barrier-broken") process.exitCode = 2;
}

function target(argv: readonly string[], flag: "--format" | "--to"): { root: string; commit: boolean } {
	let root: string | undefined;
	let format: string | undefined;
	let commit = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--root" && root === undefined) {
			root = argv[++index];
			if (!root || root.startsWith("--")) throw new TypeError(STORE_FORMAT_USAGE_V0);
		} else if (arg === flag && format === undefined) {
			format = argv[++index];
			if (!format) throw new TypeError(STORE_FORMAT_USAGE_V0);
		} else if (arg === "--commit" && flag === "--to" && !commit) commit = true;
		else throw new TypeError(STORE_FORMAT_USAGE_V0);
	}
	if (root === undefined || format !== ENDO_ATTACHMENT_STORE_FORMAT_V0)
		throw new TypeError(`an explicit --root and ${flag} ${ENDO_ATTACHMENT_STORE_FORMAT_V0} are required`);
	return { root: resolveEndoStoreRootV0(root).path, commit };
}

function init(argv: readonly string[]): void {
	const { root } = target(argv, "--format");
	initEndoEventStoreV0(root);
	console.log(endoStoreCreatedLineV0(root));
}

function migrate(argv: readonly string[]): void {
	const { root, commit } = target(argv, "--to");
	const result = migrateEndoEventStoreV0(root, commit);
	console.log(
		canonicalEndoJsonV0({
			root,
			...printable(result.state),
			dryRun: !commit,
			...(result.proposedSeal === undefined ? {} : { proposedSeal: result.proposedSeal }),
			preconditions: PRECONDITIONS,
		}),
	);
}

export const STORE_FORMAT_COMMANDS_V0 = { status, init, migrate };
