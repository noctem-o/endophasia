// Run `endo studio` as a child process and talk to it, for the tests of the command (tests/endo-studio-cli.test.ts) and for the package
// smoke test (scripts/package-smoke.mjs), which runs the INSTALLED binary. It imports nothing from this repository, so what it measures
// is what the child serves and not what a checkout would. Every wait is bounded and a child that outlives its test is killed: a
// failed launch must not hang CI.
//
// The access address is a secret of the launch it came from. This helper keeps it out of every message it produces: a failure names
// what went wrong with the address replaced by `<capability>`, and tests should use `redact` when they print a child's output.
import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

export interface StudioReply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

export interface StudioExit {
	code: number | null;
	signal: string | null;
}

export interface StudioChild {
	readonly port: number;
	/** `http://127.0.0.1:<port>`, with no capability. */
	readonly origin: string;
	/** The secret path segment of this launch. */
	readonly capability: string;
	/** The full access address as the child printed it, trailing slash included. A secret: never print it. */
	readonly address: string;
	stdout(): string;
	stderr(): string;
	/** Replace the capability (and the address it is part of) in a piece of text. */
	redact(text: string): string;
	/** One GET under the capability (`route` begins with a slash, or is empty for the page), with optional extra headers. */
	get(route: string, headers?: Record<string, string>): Promise<StudioReply>;
	/** One request with an explicit target, outside the capability and with any Host header (fetch cannot send one). */
	send(target: string, options?: { method?: string; headers?: Record<string, string> }): Promise<StudioReply>;
	/** Send a signal and do not wait. */
	signal(name: "SIGINT" | "SIGTERM"): void;
	/** Send a signal and wait (bounded) for the child to exit on its own; a child that does not is killed and the wait rejects. */
	stop(signal?: "SIGINT" | "SIGTERM"): Promise<StudioExit>;
	/** The exit, whenever it comes. */
	readonly exited: Promise<StudioExit>;
	kill(): void;
}

const ADDRESS =
	/^Endophasia Studio \(read-only, loopback only\): (http:\/\/127\.0\.0\.1:([0-9]+)\/([A-Za-z0-9_-]{43})\/)$/m;

function exchange(
	port: number,
	target: string,
	options: { method?: string; headers?: Record<string, string> } = {},
): Promise<StudioReply> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: target,
				headers: { Host: `127.0.0.1:${port}`, ...options.headers },
				agent: false,
				timeout: 15_000,
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("timeout", () => req.destroy(new Error("the request timed out")));
		req.on("error", reject);
		req.end();
	});
}

/** Whether something accepts connections on this loopback port. */
export function listening(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/**
 * Start `node <argv...>` (the first element is normally the CLI entry, after any Node flags) in `cwd` under `env`, and wait until
 * it prints its access address. Rejects, having killed the child, if it exits first or does not print within `startupMs`.
 */
export function startStudio(
	argv: readonly string[],
	options: { cwd: string; env: Record<string, string | undefined>; startupMs?: number; stopMs?: number },
): Promise<StudioChild> {
	const startupMs = options.startupMs ?? 20_000;
	const stopMs = options.stopMs ?? 10_000;
	const child: ChildProcess = spawn(process.execPath, [...argv], {
		cwd: options.cwd,
		env: options.env as NodeJS.ProcessEnv,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	let err = "";
	child.stdout!.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr!.on("data", (chunk: Buffer) => {
		err += chunk.toString();
	});
	// "close", not "exit": it fires once the child's output has been read to the end, so what a test then reads is all it printed.
	const exited = new Promise<StudioExit>((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	let secret = "";
	const redact = (text: string): string => (secret === "" ? text : text.split(secret).join("<capability>"));
	const kill = (): void => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			kill();
			reject(new Error(`Studio printed no address within ${startupMs} ms; stderr: ${redact(err).slice(0, 400)}`));
		}, startupMs);
		const poll = setInterval(() => {
			const match = ADDRESS.exec(out);
			if (match === null) return;
			clearInterval(poll);
			clearTimeout(timer);
			const [, address, port, capability] = match;
			secret = capability!;
			const number = Number(port);
			resolve({
				port: number,
				origin: `http://127.0.0.1:${number}`,
				capability: capability!,
				address: address!,
				stdout: () => out,
				stderr: () => err,
				redact,
				get: (route, headers) =>
					exchange(number, `/${capability}${route}`, headers === undefined ? {} : { headers }),
				send: (target, sendOptions) => exchange(number, target, sendOptions),
				signal: (name) => {
					child.kill(name);
				},
				stop: async (signal = "SIGINT") => {
					child.kill(signal);
					const bound = new Promise<never>((_, fail) => {
						setTimeout(() => {
							kill();
							fail(new Error(`Studio did not exit within ${stopMs} ms of ${signal}`));
						}, stopMs).unref();
					});
					return Promise.race([exited, bound]);
				},
				exited,
				kill,
			});
		}, 25);
		void exited.then(({ code, signal }) => {
			if (secret !== "" || out.match(ADDRESS) !== null) return; // it printed its address: a later exit is the caller's to observe
			clearInterval(poll);
			clearTimeout(timer);
			reject(
				new Error(
					`Studio exited (code ${code}, signal ${signal}) before printing an address; stderr: ${redact(err).slice(0, 400)}`,
				),
			);
		});
	});
}
