// The cockpit HTTP transport's boundary, tested over real loopback sockets: who may ask (capability, Host, Origin), what may be
// asked (method, body, path, query), how often, and what a refusal may say. A refused request must read nothing, change nothing
// and reveal nothing.
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	answerEndoCockpitClientErrorV0,
	type EndoCockpitServerV0,
	endoCockpitAllowedAuthoritiesV0,
} from "../cockpit-http/server.ts";
import { ATTACHMENT, event, ingestAll, removeTempRoots, seedRegistry, tempRoot, treeHash } from "./cockpit-fixtures.ts";
import { capabilityOf, get, raw, send, serve, stopServers } from "./cockpit-http-fixtures.ts";
import { OTHER_KEY } from "./cockpit-keyed.ts";

afterEach(stopServers);
afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

let root = "";
beforeAll(() => {
	root = tempRoot();
	ingestAll(root, [event("agent.prompt-accepted"), event("agent.prompt-accepted")]);
	seedRegistry(root);
});

const CODES = new Set([
	"bad-request",
	"forbidden",
	"not-found",
	"method-not-allowed",
	"misdirected-request",
	"too-many-requests",
	"internal-error",
]);

/** A refusal is exactly `{"error":"<code>"}` from the closed set, with the transport's security headers and no CORS header. */
function expectRefusal(
	reply: { status: number; headers: Record<string, unknown>; body: string },
	status: number,
): string {
	expect(reply.status).toBe(status);
	const parsed = JSON.parse(reply.body) as { error: string };
	expect(Object.keys(parsed)).toEqual(["error"]);
	expect(CODES.has(parsed.error)).toBe(true);
	expect(reply.body).toBe(`{"error":"${parsed.error}"}\n`);
	expectHeaders(reply.headers);
	return parsed.error;
}

function expectHeaders(headers: Record<string, unknown>): void {
	expect(headers["cache-control"]).toBe("no-store");
	expect(headers["x-content-type-options"]).toBe("nosniff");
	expect(headers["referrer-policy"]).toBe("no-referrer");
	expect(headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
	expect(headers["content-type"]).toBe("application/json; charset=utf-8");
	for (const name of Object.keys(headers)) {
		expect(name.startsWith("access-control-"), name).toBe(false);
		expect(["set-cookie", "server", "x-powered-by"].includes(name), name).toBe(false);
	}
}

async function started(
	options: Parameters<typeof serve>[1] = {},
): Promise<{ server: EndoCockpitServerV0; before: string }> {
	return { server: await serve(root, options), before: treeHash(root) };
}

describe("the access capability", () => {
	it("every route answers 404 without it or with a wrong one, identically to an unknown path", async () => {
		const { server, before } = await started();
		const cap = capabilityOf(server);
		const wrong = `/${"A".repeat(cap.length - 1)}`;
		const flipped = `${cap.slice(0, -1)}${cap.endsWith("A") ? "B" : "A"}`;
		const unknown = await send(server, "/nothing/here");
		for (const target of [
			"/api/v0/snapshot",
			"/api/v0/timeline",
			`/api/v0/runtime/${ATTACHMENT}`,
			`${wrong}/api/v0/snapshot`,
			`${flipped}/api/v0/snapshot`,
			`${cap.slice(0, -1)}/api/v0/snapshot`,
			`${cap}x/api/v0/snapshot`,
			`/${cap.slice(1).toLowerCase()}/api/v0/snapshot`,
			`/%41${cap.slice(2)}/api/v0/snapshot`,
			"/",
			"",
		]) {
			const reply = await send(server, target === "" ? "/" : target);
			expect(expectRefusal(reply, 404), target).toBe("not-found");
			expect(reply.body).toBe(unknown.body);
		}
		expect(treeHash(root)).toBe(before);
	});

	it("is random per launch, 256 bits of URL-safe text, and not derived from the key", async () => {
		const seen = new Set<string>();
		for (let i = 0; i < 5; i += 1) {
			const server = await serve(root);
			const token = capabilityOf(server).slice(1);
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			seen.add(token);
			expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}/${token}`);
			expect(token.includes(OTHER_KEY.fingerprint)).toBe(false);
		}
		expect(seen.size).toBe(5);
	});

	it("never appears in a response, a header or a refusal", async () => {
		const { server } = await started();
		const token = capabilityOf(server).slice(1);
		for (const target of [
			`${capabilityOf(server)}/api/v0/snapshot`,
			`${capabilityOf(server)}/api/v0/nope`,
			"/zzz",
			`${capabilityOf(server)}/api/v0/snapshot?x=1`,
		]) {
			const reply = await send(server, target);
			expect(JSON.stringify(reply.headers).includes(token)).toBe(false);
			if (reply.status !== 200) expect(reply.body.includes(token)).toBe(false);
		}
	});
});

describe("DNS rebinding: the Host header", () => {
	const hostile = (port: number) => [
		"evil.example",
		`evil.example:${port}`,
		`rebind.attacker.example:${port}`,
		`127.0.0.1.evil.example:${port}`,
		`localhost.evil.example:${port}`,
		"127.0.0.1",
		"localhost",
		`127.0.0.1:${port + 1}`,
		`localhost:${port + 1}`,
		`[::1]:${port}`,
		`0.0.0.0:${port}`,
		`127.0.0.2:${port}`,
		`127.0.0.1:${port}.evil.example`,
		`127.0.0.1:${port}, evil.example`,
	];

	it("anything but this server's loopback name and bound port is refused before the capability is looked at", async () => {
		const { server, before } = await started();
		const good = await send(server, `${capabilityOf(server)}/api/v0/snapshot`);
		expect(good.status).toBe(200);
		for (const host of hostile(server.port)) {
			for (const target of [`${capabilityOf(server)}/api/v0/snapshot`, "/api/v0/snapshot"]) {
				const reply = await send(server, target, { headers: { Host: host } });
				expect(expectRefusal(reply, 421), `Host: ${JSON.stringify(host)}`).toBe("misdirected-request");
			}
		}
		expect(treeHash(root)).toBe(before);
	});

	it("accepts both loopback names, in any case, and nothing else", async () => {
		const { server } = await started();
		for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `LOCALHOST:${server.port}`]) {
			const reply = await send(server, `${capabilityOf(server)}/api/v0/timeline`, { headers: { Host: host } });
			expect(reply.status, host).toBe(200);
		}
	});

	it("a missing, empty or repeated Host header is refused", async () => {
		const { server } = await started();
		const target = `${capabilityOf(server)}/api/v0/snapshot`;
		const empty = await raw(server, `GET ${target} HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n`);
		expect(empty).toMatch(/^HTTP\/1\.1 (400|421) /);
		expect(empty).not.toContain('"entries"');
		const none = await raw(server, `GET ${target} HTTP/1.0\r\n\r\n`);
		expect(none).toMatch(/^HTTP\/1\.[01] (400|421) /);
		expect(none).not.toContain('"entries"');
		const twice = await raw(
			server,
			`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
		);
		expect(twice).toMatch(/^HTTP\/1\.1 (400|421) /);
		expect(twice).not.toContain('"entries"');
	});
});

describe("cross-origin and cross-site requests", () => {
	it("a foreign, null or malformed Origin is refused, as is a repeated one", async () => {
		const { server, before } = await started();
		const target = `${capabilityOf(server)}/api/v0/snapshot`;
		for (const origin of [
			"http://evil.example",
			"https://evil.example",
			"null",
			`http://127.0.0.1:${server.port + 1}`,
			`https://127.0.0.1:${server.port}`,
			`http://127.0.0.1.evil.example:${server.port}`,
			"http://localhost",
			"*",
			"",
		])
			expect(expectRefusal(await send(server, target, { headers: { Origin: origin } }), 403), origin).toBe(
				"forbidden",
			);
		const twice = await raw(
			server,
			`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: http://127.0.0.1:${server.port}\r\nOrigin: http://127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
		);
		expect(twice).toMatch(/^HTTP\/1\.1 4\d\d /);
		expect(treeHash(root)).toBe(before);
	});

	it("this server's own origin is accepted, and the fetch metadata of a cross-site request is not", async () => {
		const { server } = await started();
		const target = `${capabilityOf(server)}/api/v0/timeline`;
		for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`])
			expect((await send(server, target, { headers: { Origin: origin } })).status).toBe(200);
		for (const site of ["same-origin", "none"])
			expect((await send(server, target, { headers: { "Sec-Fetch-Site": site } })).status).toBe(200);
		for (const site of ["cross-site", "same-site", "", "weird"])
			expect(expectRefusal(await send(server, target, { headers: { "Sec-Fetch-Site": site } }), 403)).toBe(
				"forbidden",
			);
	});

	it("a preflight and every cross-origin answer carry no CORS permission", async () => {
		const { server } = await started();
		const target = `${capabilityOf(server)}/api/v0/snapshot`;
		const preflight = await send(server, target, {
			method: "OPTIONS",
			headers: { Origin: "http://evil.example", "Access-Control-Request-Method": "GET" },
		});
		expectRefusal(preflight, 403);
		const plain = await send(server, target, { method: "OPTIONS" });
		expect(expectRefusal(plain, 405)).toBe("method-not-allowed");
		expect(plain.headers.allow).toBe("GET");
	});
});

describe("methods and bodies", () => {
	it("only GET is served: everything else is 405 with Allow: GET and runs no read", async () => {
		const { server, before } = await started();
		const target = `${capabilityOf(server)}/api/v0/snapshot`;
		for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "PROPFIND"]) {
			const reply = await send(server, target, { method });
			expect(reply.status, method).toBe(405);
			expect(reply.headers.allow).toBe("GET");
			if (method !== "HEAD") expectRefusal(reply, 405);
		}
		expect(treeHash(root)).toBe(before);
	});

	it("CONNECT and an upgrade request get no tunnel and no protocol switch", async () => {
		const { server } = await started();
		const connect = await raw(
			server,
			`CONNECT 127.0.0.1:${server.port} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n\r\n`,
		);
		expect(connect).not.toMatch(/^HTTP\/1\.1 (101|200) /);
		const upgrade = await raw(
			server,
			`GET ${capabilityOf(server)}/api/v0/snapshot HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
		);
		expect(upgrade).not.toMatch(/^HTTP\/1\.1 101 /);
	});

	it("a GET with a body is refused, however it is framed, and the connection is closed", async () => {
		const { server } = await started();
		const target = `${capabilityOf(server)}/api/v0/snapshot`;
		const withLength = await send(server, target, { body: "{}", headers: { "Content-Length": "2" } });
		expect(expectRefusal(withLength, 400)).toBe("bad-request");
		expect(withLength.headers.connection).toBe("close");
		const chunked = await raw(
			server,
			`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n`,
		);
		expect(chunked).toMatch(/^HTTP\/1\.1 400 /);
		expect(chunked).not.toContain('"entries"');
		const empty = await send(server, target, { headers: { "Content-Length": "0" } });
		expect(empty.status).toBe(200);
	});
});

describe("paths: no encoded separators, traversal or odd characters ever reach a route", () => {
	const targets = (cap: string): string[] => [
		`${cap}/api/v0/runtime/..%2f..%2f..%2fetc%2fpasswd`,
		`${cap}/api/v0/runtime/%2e%2e`,
		`${cap}/api/v0/runtime/%2E%2E%2F`,
		`${cap}/api/v0/runtime/..`,
		`${cap}/api/v0/runtime/../snapshot`,
		`${cap}/api/v0/runtime/./pi.default`,
		`${cap}/api/v0/runtime/pi.default/..`,
		`${cap}/api/v0/runtime/pi%2edefault`,
		`${cap}/api/v0/runtime/pi.default%00`,
		`${cap}/api/v0/runtime/pi.default%0d%0aX-Injected: 1`,
		`${cap}/api/v0/runtime/pi.default/`,
		`${cap}/api/v0/runtime/pi.default/extra`,
		`${cap}/api/v0/runtime/`,
		`${cap}/api/v0/runtime`,
		`${cap}/api/v0/snapshot/`,
		`${cap}/api/v0/snapshot/pi.default`,
		`${cap}/api/v0/timeline/1`,
		`${cap}//api/v0/snapshot`,
		`${cap}/api//v0/snapshot`,
		`${cap}/api/v0//snapshot`,
		`${cap}/api/v0/runtime//pi.default`,
		`${cap}/api/v0/runtime/pi.default\\..\\x`,
		`${cap}/api/v0/runtime/PI.DEFAULT`,
		`${cap}/api/v0/runtime/pi_default`,
		`${cap}/api/v0/runtime/pi.default;x=1`,
		`${cap}/api/v0/runtime/withheld-0123456789abcdef0123456789abcdef`,
		`${cap}/api/v0/runtime/pi.withheld-0123456789abcdef0123456789abcdef`,
		`${cap}/api/v0/runtime/${"a".repeat(129)}`,
		`${cap}/api/v0/runtime/${"a.".repeat(300)}a`,
		`${cap}/api/v0/runtime/${"a".repeat(3000)}`,
		`${cap}/api/v1/snapshot`,
		`${cap}/api/v00/snapshot`,
		`${cap}/api/v0.1/snapshot`,
		`${cap}/api/v10/snapshot`,
		`${cap}/api/snapshot`,
		`${cap}/API/v0/snapshot`,
		`${cap}/api/v0/Snapshot`,
		`${cap}/api/v0/evidence`,
		`${cap}/api/v0/freshness`,
		`${cap}/api/v0/snapshot%00`,
		`${cap}/api/v0/snapshot%2f`,
		`${cap}/api/v0/snapshot#fragment`,
		`${cap}/%2e%2e/%2e%2e/etc/passwd`,
		`${cap}/./api/v0/snapshot`,
		`${cap}/../${cap.slice(1)}/api/v0/snapshot`,
		`http://127.0.0.1/${cap.slice(1)}/api/v0/snapshot`,
		`*`,
	];

	it("each is refused as not found, with no file read and no source named", async () => {
		const { server, before } = await started();
		for (const target of targets(capabilityOf(server))) {
			const reply = await send(server, target).catch(() => null);
			if (reply === null) continue; // the client itself refused to send it
			expect(reply.status, target.slice(0, 80)).toBeGreaterThanOrEqual(400);
			expect(reply.status, target.slice(0, 80)).toBeLessThan(500);
			expect(reply.body.includes("root:"), target.slice(0, 80)).toBe(false);
			expect(reply.body).toMatch(/^\{"error":"[a-z-]+"\}\n$/);
		}
		expect(treeHash(root)).toBe(before);
	});

	it("characters no route contains are refused when sent raw: non-ASCII, control, space and an over-long target", async () => {
		const { server } = await started();
		const cap = capabilityOf(server);
		for (const target of [
			`${cap}/api/v0/runtime/pi.defaulté`,
			`${cap}/api/v0/runtime/․`,
			`${cap}/api/v0/runtime/pi․default`,
			`${cap}/api/v0/runtime/．．`,
			`${cap}/api/v0/snapshot\u0000`,
			`${cap}/api/v0/snapshot x`,
			`${cap}/api/v0/snapshot\t`,
			`${cap}/${"a".repeat(70_000)}`,
		]) {
			const reply = await raw(
				server,
				`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
			);
			expect(reply, target.slice(0, 60)).not.toMatch(/^HTTP\/1\.1 200 /);
			expect(reply).not.toContain('"entries"');
		}
	});

	it("an attachment name the reader accepts is served, so the server refuses exactly what the reader would throw on", async () => {
		const { server } = await started();
		for (const name of ["pi.default", "a", "omp.default-2", "x".repeat(128)])
			expect((await get(server, `/api/v0/runtime/${name}`)).status, name).toBe(200);
	});
});

describe("queries are exact, bounded integers", () => {
	const bad = [
		"limit=0",
		"limit=10001",
		"limit=99999999999999999999",
		"limit=-1",
		"limit=1.5",
		"limit=1e3",
		"limit=0x10",
		"limit=01",
		"limit=+1",
		"limit=%31",
		"limit=",
		"limit",
		"limit=1&limit=2",
		"limit=1&limit=1",
		"afterSequence=-1",
		"afterSequence=1.0",
		"afterSequence=9007199254740993",
		"afterSequence=1,2",
		"afterSequence=%20",
		"after=1",
		"Limit=1",
		"limit=1&unknown=1",
		"unknown=1",
		"limit=1&&afterSequence=1",
		"&",
		"=1",
		"limit==1",
		"limit=1=2",
		`limit=${"1".repeat(200)}`,
		`x=${"1".repeat(500)}`,
	];

	it("anything else is a 400 and closes the connection, on the routes that take parameters", async () => {
		const { server, before } = await started();
		for (const query of bad)
			for (const route of ["snapshot", "timeline"]) {
				const reply = await send(server, `${capabilityOf(server)}/api/v0/${route}?${query}`);
				expect(expectRefusal(reply, 400), `${route}?${query.slice(0, 40)}`).toBe("bad-request");
				expect(reply.headers.connection).toBe("close");
			}
		expect(treeHash(root)).toBe(before);
	});

	it("the runtime route takes no parameters at all", async () => {
		const { server } = await started();
		for (const query of ["limit=1", "afterSequence=0", "x=1", "&"])
			expectRefusal(await send(server, `${capabilityOf(server)}/api/v0/runtime/${ATTACHMENT}?${query}`), 400);
		expect((await send(server, `${capabilityOf(server)}/api/v0/runtime/${ATTACHMENT}?`)).status).toBe(200);
	});

	it("the bounds themselves, and the empty query, are served", async () => {
		const { server } = await started();
		for (const query of [
			"",
			"limit=1",
			"limit=10000",
			"afterSequence=0",
			"afterSequence=9007199254740991&limit=1",
			"limit=2&afterSequence=1",
		])
			expect((await get(server, `/api/v0/timeline${query === "" ? "" : `?${query}`}`)).status, query).toBe(200);
	});
});

describe("request cost: reads are charged the time they take", () => {
	it("a read beyond the budget is a 429 with Retry-After, however slowly the requests arrive, and the budget refills", async () => {
		// duty 0.5, burst 1 ms: the first snapshot read (tens of milliseconds) accrues half its own duration and is charged all of
		// it, so the balance is negative afterwards, a request made at once is refused, and the balance recovers with wall time.
		const server = await serve(root, { readBudget: { duty: 0.5, burstMs: 1 } });
		expect((await get(server, "/api/v0/snapshot")).status).toBe(200);
		const limited = await get(server, "/api/v0/snapshot");
		expect(expectRefusal(limited, 429)).toBe("too-many-requests");
		expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
		let admitted = false;
		for (let attempt = 0; attempt < 50 && !admitted; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			admitted = (await get(server, "/api/v0/snapshot")).status === 200;
		}
		expect(admitted).toBe(true);
	});

	it("is charged per unit of read time, not per request: a tiny read budget refuses the second read of any route", async () => {
		for (const route of ["/api/v0/timeline", `/api/v0/runtime/${ATTACHMENT}`]) {
			const server = await serve(root, { readBudget: { duty: 0.0001, burstMs: 0.01 } });
			expect((await get(server, route)).status, route).toBe(200);
			expect((await get(server, route)).status, route).toBe(429);
		}
	});

	it("the default budget lets an operator refresh a small store promptly, many times in a row", async () => {
		const server = await serve(root);
		for (let i = 0; i < 8; i += 1) expect((await get(server, "/api/v0/snapshot")).status).toBe(200);
	});

	it("unauthenticated and malformed traffic spends none of the budget", async () => {
		const server = await serve(root, { readBudget: { duty: 0.0001, burstMs: 1 } });
		const cap = capabilityOf(server);
		for (let i = 0; i < 60; i += 1) {
			await send(server, `/wrong${i}/api/v0/snapshot`);
			await send(server, `${cap}/api/v0/snapshot?limit=0`);
			await send(server, `${cap}/api/v0/snapshot`, { headers: { Host: "evil.example" } });
			await send(server, `${cap}/api/v0/snapshot`, { method: "POST" });
			await send(server, `${cap}/api/v0/runtime/..%2f`);
		}
		expect((await get(server, "/api/v0/snapshot")).status).toBe(200);
		expect((await get(server, "/api/v0/snapshot")).status).toBe(429);
	});
});

describe("the parser's own refusals and the default port", () => {
	it("a refusal is written and the socket closed, and a peer that does not read cannot hold the connection", () => {
		const log: string[] = [];
		const socket = (queued: number, writable = true) => ({
			writable,
			writableLength: queued,
			end: (data: string) => log.push(`end:${data.split("\r\n")[0]}`),
			destroy: () => log.push("destroy"),
			setTimeout: (milliseconds: number, onTimeout: () => void) => {
				log.push(`deadline:${milliseconds}`);
				onTimeout();
			},
		});
		answerEndoCockpitClientErrorV0(socket(0));
		expect(log).toEqual(["end:HTTP/1.1 400 Bad Request", "deadline:2000", "destroy"]);
		log.length = 0;
		answerEndoCockpitClientErrorV0(socket(65536)); // output still queued behind a peer that is not reading
		expect(log).toEqual(["end:HTTP/1.1 400 Bad Request", "destroy"]);
		log.length = 0;
		answerEndoCockpitClientErrorV0(socket(0, false));
		expect(log).toEqual(["destroy"]);
	});

	it("an unread pipeline of refusals does not keep the connection limit occupied", async () => {
		const { server } = await started();
		const sockets = Array.from({ length: 40 }, () => connect({ host: "127.0.0.1", port: server.port }));
		for (const socket of sockets) {
			socket.on("error", () => undefined);
			socket.pause(); // never read
			socket.write(`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Bad\x00: 1\r\n\r\n`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2600)); // past the refusal deadline
		expect((await get(server, "/api/v0/timeline?limit=1")).status).toBe(200);
		for (const socket of sockets) socket.destroy();
	});

	it("accepts the loopback names with the bound port, and bare names only on port 80, where clients omit the port", () => {
		expect(endoCockpitAllowedAuthoritiesV0(43210)).toEqual(["127.0.0.1:43210", "localhost:43210"]);
		expect(endoCockpitAllowedAuthoritiesV0(80)).toEqual(["127.0.0.1:80", "127.0.0.1", "localhost:80", "localhost"]);
		expect(endoCockpitAllowedAuthoritiesV0(8080)).not.toContain("127.0.0.1");
	});
});

describe("Expect headers take the guarded path (P2 on PR #58)", () => {
	it("every Expect value gets the same guards, fixed bodies and headers, and never an interim 100 or a bare 417", async () => {
		const { server, before } = await started();
		const target = `${capabilityOf(server)}/api/v0/timeline?limit=1`;
		for (const expect_ of ["100-continue", "unsupported-thing", "100-CONTINUE"]) {
			const own = `Host: 127.0.0.1:${server.port}`;
			const served = await raw(
				server,
				`GET ${target} HTTP/1.1\r\n${own}\r\nExpect: ${expect_}\r\nConnection: close\r\n\r\n`,
			);
			expect(served, expect_).not.toContain("100 Continue");
			expect(served, expect_).not.toContain("417");
			expect(served, expect_).toMatch(/^HTTP\/1\.1 200 /);
			for (const header of ["Cache-Control: no-store", "Referrer-Policy: no-referrer", "Content-Security-Policy:"])
				expect(served, expect_).toContain(header);
			const rebinding = await raw(
				server,
				`GET ${target} HTTP/1.1\r\nHost: evil.example\r\nExpect: ${expect_}\r\nConnection: close\r\n\r\n`,
			);
			expect(rebinding, expect_).toMatch(/^HTTP\/1\.1 421 /);
			expect(rebinding).toContain('{"error":"misdirected-request"}');
			expect(rebinding).toContain("Content-Security-Policy:");
			const post = await raw(
				server,
				`POST ${target} HTTP/1.1\r\n${own}\r\nExpect: ${expect_}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`,
			);
			expect(post, expect_).toMatch(/^HTTP\/1\.1 405 /);
			expect(post).not.toContain("100 Continue");
		}
		expect(treeHash(root)).toBe(before);
	});
});

describe("what a failure may say", () => {
	it("an internal failure is a generic 500 that reveals neither the error nor the path, and goes only to the host's hook", async () => {
		const errors: unknown[] = [];
		const leaky = {
			...OTHER_KEY,
			digest: () => {
				throw new Error(`SECRET-STACK ${root} /home/someone/.local/share/endophasia/digest-key`);
			},
		};
		const server = await serve(root, { digestKey: leaky as never, onError: (error) => errors.push(error) });
		const reply = await get(server, "/api/v0/snapshot");
		expect(expectRefusal(reply, 500)).toBe("internal-error");
		expect(reply.headers.connection).toBe("close");
		for (const secret of ["SECRET-STACK", root, "/home/", "digest-key", " at ", "Error"])
			expect(reply.body.includes(secret)).toBe(false);
		expect(errors.length).toBe(1);
		expect(String((errors[0] as Error).message)).toContain("SECRET-STACK");
	});

	it("a throwing diagnostics hook changes nothing the client sees, and the server keeps serving", async () => {
		const leaky = {
			...OTHER_KEY,
			digest: () => {
				throw new Error("x");
			},
		};
		const server = await serve(root, {
			digestKey: leaky as never,
			onError: () => {
				throw new Error("hook failed");
			},
		});
		expectRefusal(await get(server, "/api/v0/snapshot"), 500);
		expect((await send(server, "/nothing")).status).toBe(404);
	});

	it("malformed HTTP gets a fixed 400 with the security headers and no echo of what was sent", async () => {
		const { server } = await started();
		for (const garbage of [
			"\x00\x01\x02garbage\r\n\r\n",
			"GET\r\n\r\n",
			"GET /x HTTP/9.9\r\n\r\n",
			`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nBad Header\r\n\r\n`,
			`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`,
		]) {
			const reply = await raw(server, garbage);
			expect(reply).not.toMatch(/^HTTP\/1\.1 200 /);
			expect(reply).not.toContain("garbage\r\n\r\nGET");
			if (reply.startsWith("HTTP/1.1 400")) {
				for (const header of [
					"Cache-Control: no-store",
					"X-Content-Type-Options: nosniff",
					"Referrer-Policy: no-referrer",
					"Content-Security-Policy: default-src 'none'; frame-ancestors 'none'",
					"Content-Type: application/json; charset=utf-8",
				])
					expect(reply).toContain(header);
				expect(reply.endsWith('{"error":"bad-request"}\n')).toBe(true);
			}
		}
		expect((await get(server, "/api/v0/timeline")).status).toBe(200);
	});

	it("a refused request never produces a stack trace, a module path or the store path", async () => {
		const { server } = await started();
		const replies = await Promise.all(
			["/x", `${capabilityOf(server)}/api/v0/snapshot?limit=0`, `${capabilityOf(server)}/api/v0/runtime/..`].map(
				(t) => send(server, t),
			),
		);
		for (const { body } of replies)
			for (const text of ["at ", "node_modules", "cockpit-http", root, ".ts"])
				expect(body.includes(text)).toBe(false);
	});
});
