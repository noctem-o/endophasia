/** Explicit cold imports only. No DSH home discovery, runtime control or mapping logic lives here. */
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
	type DshImportReportV0,
	findDshSessionFileV0,
	importDshSessionDirectoryV0,
} from "../adapters/dsh-native/import.ts";
import { DSH_NATIVE_LOSS_ACCOUNTING_V0 } from "../adapters/dsh-native/loss.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyPathV0, loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { createEndoDurableEventStoreV0, type EndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { announceEndoRootV0, takeEndoRootV0 } from "./root-args.ts";

const USAGE = "usage: endo dsh import [<root> | --root dir] <session-directory> (one root only)";

/** Resolve existing aliases and extend the nearest existing ancestor for a not-yet-created destination.
 * Use this canonical result for writes too, rather than traversing the original spelling during mkdir. */
function place(path: string): string {
	let at = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
	const suffix: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(at), ...suffix);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// A dangling symbolic link is not a missing path whose write destination we can establish.
			try {
				lstatSync(at);
				throw new Error("unresolved alias");
			} catch (missing) {
				if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
			}
			if (dirname(at) === at) throw error;
			suffix.unshift(basename(at));
			at = dirname(at);
		}
	}
}
const inside = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

/** The established report shape, with free-form diagnostics withheld: checker details can echo hostile event
 * types, tool names, malformed version/turn values or unaudited stored metadata. Codes/counts/tail states remain evidence. */
function printable(report: DshImportReportV0): DshImportReportV0 {
	return {
		...report,
		tail:
			report.tail.kind === "unreadable"
				? { kind: "unreadable", reason: "source bytes are unreadable" }
				: report.tail,
		findings: report.findings.map(({ code, severity, seq }) => ({
			code,
			severity,
			detail: "source detail withheld; see finding code",
			...(typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? { seq } : {}),
		})),
		refusals: report.refusals.map(({ code, dshSeqs }) => ({
			code,
			detail: "source detail withheld; see refusal code",
			...(dshSeqs === undefined ? {} : { dshSeqs }),
		})),
	};
}

export function dshImportCommand(argv: readonly string[]): void {
	let taken: ReturnType<typeof takeEndoRootV0>;
	try {
		taken = takeEndoRootV0(argv, 1);
		if (taken.root.startsWith("-") || taken.rest.length !== 1 || !taken.rest[0] || taken.rest[0].startsWith("-"))
			throw new TypeError(USAGE);
	} catch {
		throw new TypeError(USAGE);
	}
	let source: string, root: string, keyPath: string;
	try {
		source = realpathSync(taken.rest[0]!);
		if (!statSync(source).isDirectory()) throw new Error("not a directory");
		const file = findDshSessionFileV0(source);
		if (!lstatSync(file.path).isFile()) throw new Error("not a regular log");
		accessSync(file.path, constants.R_OK);
	} catch {
		throw new TypeError(
			"DSH source preflight failed: expected a readable session directory with one newest regular log",
		);
	}
	try {
		root = place(taken.root);
		keyPath = place(endoDigestKeyPathV0());
		const events = place(join(root, "events"));
		const log = place(join(root, "events", "events.log"));
		for (const target of [root, events, log, keyPath])
			if (inside(target, source) || inside(source, target)) throw new Error("source overlap");
		if ([root, events, log].some((target) => inside(keyPath, target))) throw new Error("key in store");
		try {
			if (statSync(log).nlink > 1) throw new Error("multiply linked destination");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	} catch {
		throw new TypeError(
			"DSH destination preflight failed: source, store and key must be separate, with resolvable paths and no multiply linked event log",
		);
	}

	let reader: EndoDurableEventStoreV0;
	try {
		reader = createEndoDurableEventStoreV0(root, { readOnly: true });
	} catch {
		throw new TypeError("DSH destination could not be opened read-only");
	}
	let writer: EndoDurableEventStoreV0 | undefined;
	try {
		if (reader.recovery().truncated || reader.recovery().sealed)
			throw new TypeError("DSH import requires a clean destination event log; no recovery was performed");
		let key: ReturnType<typeof loadOrCreateEndoDigestKeyV0>;
		try {
			key = loadOrCreateEndoDigestKeyV0(keyPath, () =>
				process.stderr.write("warning: installation digest-key permissions or ownership require attention\n"),
			);
		} catch {
			throw new TypeError("DSH import could not load the private installation digest key");
		}
		announceEndoRootV0(taken);
		let report: DshImportReportV0;
		try {
			report = importDshSessionDirectoryV0(
				source,
				{
					page: (query) => (writer ?? reader).page(query),
					ingest: (value) => {
						writer ??= createEndoDurableEventStoreV0(root);
						return writer.ingest(value);
					},
				},
				{ digestKey: key, now: () => new Date().toISOString() },
			);
		} catch {
			throw new TypeError(
				"DSH import failed; any partially appended evidence can be retried with the same source and key",
			);
		}
		process.stdout.write(canonicalEndoJsonV0(printable(report)));
		if (report.status === "refused") process.exitCode = 1;
	} finally {
		try {
			writer?.close();
		} finally {
			reader.close();
		}
	}
}

function lossAccounting(argv: readonly string[]): void {
	if (argv.length !== 0) throw new TypeError("usage: endo dsh loss-accounting");
	process.stdout.write(canonicalEndoJsonV0(DSH_NATIVE_LOSS_ACCOUNTING_V0));
}

export const DSH_COMMANDS_V0 = { import: dshImportCommand, "loss-accounting": lossAccounting };
