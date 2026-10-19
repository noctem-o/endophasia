// Helpers for the cockpit HTTP tests: a real server on an ephemeral loopback port over a real temporary store, and clients
// that can say what `fetch` will not (an arbitrary Host header, an unresolved target, a malformed request line).
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import {
	type EndoCockpitServerOptionsV0,
	type EndoCockpitServerV0,
	startEndoCockpitServerV0,
} from "../cockpit-http/server.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

export interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const running: EndoCockpitServerV0[] = [];

/** Start a server over `root` under a private test key; `stopServers` closes every one a test started. */
export async function serve(
	root: string,
	options: Partial<EndoCockpitServerOptionsV0> = {},
): Promise<EndoCockpitServerV0> {
	const server = await startEndoCockpitServerV0({ root, digestKey: OTHER_KEY, ...options });
	running.push(server);
	return server;
}

export async function stopServers(): Promise<void> {
	await Promise.all(running.splice(0).map((server) => server.close()));
}

/** The path after the origin: `<capability>/api/...` with the leading slash. */
export const capabilityOf = (server: EndoCockpitServerV0): string => server.baseUrl.slice(server.origin.length);

/** One request with an explicit target and headers (Host defaults to the server's own). */
export function send(
	server: Pick<EndoCockpitServerV0, "port">,
	target: string,
	options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port: server.port,
				method: options.method ?? "GET",
				path: target,
				headers: { Host: `127.0.0.1:${server.port}`, ...options.headers },
				agent: false,
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
		request.on("error", reject);
		request.end(options.body);
	});
}

export const get = (server: EndoCockpitServerV0, route: string, headers: Record<string, string> = {}): Promise<Reply> =>
	send(server, `${capabilityOf(server)}${route}`, { headers });

/** Raw bytes to the port and everything the server sends back until it closes the connection. */
export function raw(server: Pick<EndoCockpitServerV0, "port">, text: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port: server.port });
		let received = "";
		socket.setTimeout(3000, () => socket.destroy());
		socket.on("data", (chunk) => {
			received += chunk.toString("utf8");
		});
		socket.on("close", () => resolve(received));
		socket.on("error", reject);
		socket.write(text);
	});
}
