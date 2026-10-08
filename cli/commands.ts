/**
 * Phase 12 — the thin CLI commands (README "## Phase 12 — Operational substrate &
 * integration", work item: "cli/"). Each command takes its raw argv tail, operates on one
 * root directory through the storage/ host layer, and prints exactly one canonical-JSON
 * document to stdout. Nothing above the host layer is imported: the commands see only
 * `node:fs` (sync), the canonical-JSON contract, and the durable stores.
 *
 * Misuse — a missing argument, a flag with no value, a non-integer number, a missing or
 * non-JSON file, a sealed or dead store, a record that fails its validator — throws
 * TypeError with an operator-readable message; cli/index.ts turns any throw into a one-line
 * stderr error and exit code 1. The commands never repair: what a store refuses is
 * reported, not fixed. The reporting commands (`status`, `events`, `ledger`, `artifacts`) open
 * every store read-only: they create no directory and cut no torn tail, so running one beside
 * a live writer cannot change what that writer is appending to.
 */
import { existsSync, readFileSync } from "node:fs";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { createEndoArtifactStoreV0 } from "../storage/artifacts.ts";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { createEndoDurableEvidenceLedgerV0 } from "../storage/ledger.ts";
import { takeEndoRootV0 } from "./root-args.ts";

/** The open mode of every reporting command. */
const READ_ONLY = { readOnly: true } as const;

/** Read one value from a UTF-8 file; the file must contain parseable JSON. */
function readJsonValueV0(file: string): unknown {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		throw new TypeError(`cannot read ${file}`);
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new TypeError(`${file} does not contain JSON`);
	}
}

/** Parse one integer flag value: a non-negative integer, or a TypeError. */
function intFlagV0(flag: string, value: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0) throw new TypeError(`${flag} must be a non-negative integer`);
	return parsed;
}

/** `status <root>` — the event log, the ledger layer (when a ledger exists), and artifact digests. */
export function statusCommand(argv: readonly string[]): void {
	const { root, rest } = takeEndoRootV0(argv, 0);
	if (rest.length > 0) throw new TypeError("usage: endo status [<root> | --root dir]");
	const events = createEndoDurableEventStoreV0(root, READ_ONLY);
	const eventLength = events.length;
	const recovery = events.recovery();
	events.close();

	const metaFile = `${root}/ledger/ledger.meta.json`;
	let ledger: Record<string, unknown> | null = null;
	if (existsSync(metaFile)) {
		const meta = readJsonValueV0(metaFile) as { id?: unknown; experiment?: unknown };
		const opened = createEndoDurableEvidenceLedgerV0(root, meta.id, meta.experiment, READ_ONLY);
		ledger = { ...opened.replay(), recovery: opened.recovery() };
		opened.close();
	}

	const artifacts = createEndoArtifactStoreV0(root, READ_ONLY).list();
	console.log(
		canonicalEndoJsonV0({
			events: { length: eventLength, recovery },
			...(ledger === null ? {} : { ledger }),
			artifacts,
		}),
	);
}

/** `events <root> [--limit n] [--after sequence]` — a forward page of the durable event log. */
export function eventsCommand(argv: readonly string[]): void {
	const { root, rest: args } = takeEndoRootV0(argv, 0);
	let limit: number | undefined;
	let afterSequence: number | undefined;
	while (args.length > 0) {
		const flag = args.shift()!;
		const value = args.shift();
		if (value === undefined) throw new TypeError(`the flag ${flag} needs a value`);
		if (flag === "--limit") limit = intFlagV0(flag, value);
		else if (flag === "--after") afterSequence = intFlagV0(flag, value);
		else throw new TypeError(`unknown flag ${flag}`);
	}
	const store = createEndoDurableEventStoreV0(root, READ_ONLY);
	const page = store.page({
		...(limit === undefined ? {} : { limit }),
		...(afterSequence === undefined ? {} : { afterSequence }),
	});
	store.close();
	console.log(canonicalEndoJsonV0(page));
}

/** `ingest <root> <file>` — ingest one endo.event.v0 from a JSON file; prints the stored event. */
export function ingestCommand(argv: readonly string[]): void {
	const { root, rest } = takeEndoRootV0(argv, 1);
	const [file] = rest;
	if (typeof file !== "string" || rest.length !== 1)
		throw new TypeError("usage: endo ingest [<root> | --root dir] <file>");
	const store = createEndoDurableEventStoreV0(root);
	const event = store.ingest(readJsonValueV0(file));
	store.close();
	console.log(canonicalEndoJsonV0(event));
}

/** `ledger <root>` — the ledger's replay classification and its full record list. */
export function ledgerCommand(argv: readonly string[]): void {
	const { root, rest } = takeEndoRootV0(argv, 0);
	if (rest.length > 0) throw new TypeError("usage: endo ledger [<root> | --root dir]");
	const metaFile = `${root}/ledger/ledger.meta.json`;
	if (!existsSync(metaFile)) throw new TypeError(`no durable ledger under ${root}`);
	const meta = readJsonValueV0(metaFile) as { id?: unknown; experiment?: unknown };
	const opened = createEndoDurableEvidenceLedgerV0(root, meta.id, meta.experiment, READ_ONLY);
	const replay = opened.replay();
	const recovery = opened.recovery();
	const ledger = opened.ledger();
	opened.close();
	console.log(canonicalEndoJsonV0({ replay, recovery, ledger }));
}

/** `artifacts <root>` — the stored artifact digests, ascending. */
export function artifactsCommand(argv: readonly string[]): void {
	const { root, rest } = takeEndoRootV0(argv, 0);
	if (rest.length > 0) throw new TypeError("usage: endo artifacts [<root> | --root dir]");
	console.log(canonicalEndoJsonV0(createEndoArtifactStoreV0(root, READ_ONLY).list()));
}
