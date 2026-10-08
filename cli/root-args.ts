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
 * command's own. When the default is used, one line on stderr says which store and why; stdout stays the document.
 */

import { resolveEndoStoreRootV0 } from "./store-root.ts";

export interface EndoRootArgsV0 {
	readonly root: string;
	/** The arguments with the root removed: the command's own positionals, then its flags. */
	readonly rest: string[];
}

export function takeEndoRootV0(
	argv: readonly string[],
	positionals: number,
	env: Readonly<Record<string, string | undefined>> = process.env,
	note: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): EndoRootArgsV0 {
	const args = [...argv];
	let named: string | undefined;
	let firstFlag = args.findIndex((arg) => arg.startsWith("--"));
	if (firstFlag === -1) firstFlag = args.length;
	const index = args.indexOf("--root");
	if (index !== -1) {
		if (args.indexOf("--root", index + 1) !== -1) throw new TypeError("--root was given more than once");
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) throw new TypeError("the flag --root needs a value");
		named = value;
		args.splice(index, 2);
		if (index < firstFlag) firstFlag = args.findIndex((arg) => arg.startsWith("--"));
		if (firstFlag === -1) firstFlag = args.length;
	}
	const hasPositionalRoot = firstFlag > positionals;
	if (named !== undefined && hasPositionalRoot)
		throw new TypeError(`the store root was given twice: "${args[0]}" and --root ${named}`);
	if (named !== undefined) return { root: named, rest: args };
	if (hasPositionalRoot) return { root: args[0]!, rest: args.slice(1) };
	const resolved = resolveEndoStoreRootV0(undefined, env);
	note(`using the default store ${resolved.path} (${resolved.source})`);
	return { root: resolved.path, rest: args };
}
