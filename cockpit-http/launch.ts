// The development launcher: a thin entry over cockpit-http/host.ts, for a checkout.
//
//   npm run cockpit -- <store-root> [--key-file <path>] [--port <n>]
//
// It builds nothing itself (`npm run cockpit` builds the page first) and reads the built page from cockpit-ui/dist/. The installed
// command is `endo studio` (cli/studio.ts), which serves the page packaged in dist/cockpit-ui/. Both start the same server through
// the same host module, and the key is the same dedicated cockpit key. The URL printed is the per-launch access capability: it is
// written to stdout once and never logged or stored.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchEndoCockpitV0, serveUntilSignalV0 } from "./host.ts";

const USAGE = "usage: npm run cockpit -- <store-root> [--key-file <path>] [--port <n>]";

function parse(argv: readonly string[]): { root: string; keyFile: string | undefined; port: number } {
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
	return { root, keyFile, port };
}

try {
	const { root, keyFile, port } = parse(process.argv.slice(2));
	const { server } = await launchEndoCockpitV0({
		root,
		port,
		...(keyFile === undefined ? {} : { keyFile }),
		uiDirectory: join(fileURLToPath(new URL("../cockpit-ui/", import.meta.url)), "dist"),
		onError: () => process.stderr.write("cockpit: an internal error occurred (the request was refused)\n"),
	});
	const stopped = serveUntilSignalV0(server);
	process.stdout.write(`cockpit (read-only, loopback only): ${server.baseUrl}/\n`);
	process.stderr.write("the URL above is the access capability for this launch; Ctrl-C stops the server\n");
	await stopped;
} catch (error) {
	process.stderr.write(`${error instanceof TypeError ? error.message : "the cockpit server did not start"}\n`);
	process.exitCode = 1;
}
