/**
 * The store root of a store-taking command. Three spellings, one rule:
 *
 *   endo status <root>            the positional root, as before
 *   endo status --root <root>     the named root
 *   endo status                   the default root (cli/store-root.ts: ENDO_STORE_ROOT, XDG_DATA_HOME, HOME)
 *
 * Naming the root twice (positionally and with --root) is a usage error, never a silent choice. A command with
 * `positionals` required arguments of its own (a file, a proposal id) has a positional root exactly when one more
 * leading, non-flag argument is present. Only leading arguments count: everything from the first `--flag` on is the
 * command's own. `valueFlags` are the command's options that take a value: that value is never read as `--root`, so a
 * prompt or model named "--root" stays usable. When the default is used, `announceEndoRootV0` puts one line on stderr
 * saying which store and why, after the command has validated its arguments; stdout stays the document.
 */

import { resolveEndoStoreRootV0 } from "./store-root.ts";

export interface EndoRootArgsV0 {
	readonly root: string;
	/** Set when the default store was chosen; print it with `announceEndoRootV0` once the command's arguments are valid. */
	readonly defaultNote: string | null;
	/** The arguments with the root removed: the command's own positionals, then its flags. */
	readonly rest: string[];
}

export function takeEndoRootV0(
	argv: readonly string[],
	positionals: number,
	valueFlags: ReadonlySet<string> = new Set(),
	env: Readonly<Record<string, string | undefined>> = process.env,
): EndoRootArgsV0 {
	const args = [...argv];
	let named: string | undefined;
	let firstFlag = args.findIndex((arg) => arg.startsWith("--"));
	if (firstFlag === -1) firstFlag = args.length;
	const positions: number[] = [];
	for (let i = 0; i < args.length; i += 1) {
		if (args[i] === "--root") positions.push(i);
		else if (valueFlags.has(args[i]!)) i += 1;
	}
	const index = positions[0] ?? -1;
	if (index !== -1) {
		if (positions.length > 1) throw new TypeError("--root was given more than once");
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new TypeError("the flag --root needs a value");
		if (value.length === 0) throw new TypeError("the store root is empty");
		named = value;
		args.splice(index, 2);
		if (index < firstFlag) firstFlag = args.findIndex((arg) => arg.startsWith("--"));
		if (firstFlag === -1) firstFlag = args.length;
	}
	const hasPositionalRoot = firstFlag > positionals;
	if (named !== undefined && hasPositionalRoot)
		throw new TypeError(`the store root was given twice: "${args[0]}" and --root ${named}`);
	if (named !== undefined) return { root: named, defaultNote: null, rest: args };
	if (hasPositionalRoot) {
		if (args[0]!.length === 0) throw new TypeError("the store root is empty");
		return { root: args[0]!, defaultNote: null, rest: args.slice(1) };
	}
	const resolved = resolveEndoStoreRootV0(undefined, env);
	return {
		root: resolved.path,
		defaultNote: `using the default store ${resolved.path} (${resolved.source})`,
		rest: args,
	};
}

export function announceEndoRootV0(taken: EndoRootArgsV0): void {
	if (taken.defaultNote !== null) process.stderr.write(`${taken.defaultNote}\n`);
}
