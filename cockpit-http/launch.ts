// The development launcher: the one place that loads a key and prints the access URL.
//
//   npm run cockpit -- <store-root> [--key-file <path>] [--port <n>]
//
// The key is a dedicated, persistent cockpit key (storage/digest-key.ts: created on first use, mode 0600) beside the installation
// key, so a refresh never needs a new one and the installation key is not reused. `--key-file` selects another file. The URL it
// prints is the per-launch access capability: it is written to stdout once and never logged or stored.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { endoDigestKeyPathV0, loadOrCreateEndoDigestKeyV0 } from "../storage/digest-key.ts";
import { startEndoCockpitServerV0 } from "./server.ts";

/** The built page (npm run cockpit builds it): every regular file the server accepts, read once into memory. */
function loadUi(): Record<string, string> {
	const directory = fileURLToPath(new URL("../cockpit-ui/dist/", import.meta.url));
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		throw new TypeError(
			"the browser page is not built: run it with `npm run cockpit -- <store-root>`, which builds it first",
		);
	}
	return Object.fromEntries(
		names
			.filter((name) => /\.(html|js|css|svg)$/.test(name))
			.map((name) => [name, readFileSync(join(directory, name), "utf8")]),
	);
}

const USAGE = "usage: npm run cockpit -- <store-root> [--key-file <path>] [--port <n>]";

function parse(argv: readonly string[]): { root: string; keyFile: string; port: number } {
	let root: string | undefined;
	let keyFile: string | undefined;
	let port = 0;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--key-file" || arg === "--port") {
			index += 1;
			const value = argv[index];
			if (value === undefined) throw new TypeError(USAGE);
			if (arg === "--key-file") keyFile = value;
			else if (/^[0-9]{1,5}$/.test(value)) port = Number(value);
			else throw new TypeError(USAGE);
		} else if (root === undefined && !arg.startsWith("--")) root = arg;
		else throw new TypeError(USAGE);
	}
	if (root === undefined) throw new TypeError(USAGE);
	return { root, keyFile: keyFile ?? join(dirname(endoDigestKeyPathV0()), "cockpit-digest-key"), port };
}

try {
	const { root, keyFile, port } = parse(process.argv.slice(2));
	const server = await startEndoCockpitServerV0({
		root,
		digestKey: loadOrCreateEndoDigestKeyV0(keyFile),
		ui: loadUi(),
		port,
		onError: () => process.stderr.write("cockpit: an internal error occurred (the request was refused)\n"),
	});
	process.stdout.write(`cockpit (read-only, loopback only): ${server.baseUrl}/\n`);
	process.stderr.write("the URL above is the access capability for this launch; Ctrl-C stops the server\n");
	const stop = (): void => {
		void server.close().then(() => process.exit(0));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
} catch (error) {
	process.stderr.write(`${error instanceof TypeError ? error.message : "the cockpit server did not start"}\n`);
	process.exitCode = 1;
}
