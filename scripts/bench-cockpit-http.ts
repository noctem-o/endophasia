// A repeatable benchmark of the cockpit HTTP transport against growing event histories (Linux: it reads /proc).
//
//   node scripts/bench-cockpit-http.ts --work <scratch-dir> [--sizes 1000,10000,50000] [--repeat 10] [--json <file>]
//
// For each history size it seeds a real store (events plus one harness registry) under <work>, starts the launcher in a CHILD
// process (so the server's own CPU and memory are measured apart from the client's), and measures, per route: the first
// request after start (cold), repeated requests (warm), the server's CPU time per request, the bytes returned against the bytes of
// event log the read had to validate (amplification), whether a cheap request made during a read waits for it (the event-loop
// blocking of the synchronous bridge read), and the server's idle CPU before and after the workload. It measures NOTHING about
// inference: it reports CPU-seconds per request, which is the input to a throughput budget, not a result for one.
// Keep <work> outside the repository and outside /tmp; nothing here is committed except a summary of the results.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEndoDurableEventStoreV0 } from "../storage/event-store.ts";
import { event, seedRegistry } from "../tests/cockpit-fixtures.ts";

function option(name: string): string | undefined {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? undefined : process.argv[at + 1];
}

const work = option("work");
if (work === undefined)
	throw new TypeError(
		"usage: node scripts/bench-cockpit-http.ts --work <scratch-dir> [--sizes a,b,c] [--repeat n] [--json file]",
	);
const sizes = (option("sizes") ?? "1000,10000,50000").split(",").map(Number);
const repeat = Number(option("repeat") ?? 10);
const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"]).toString());

const cpuMs = (pid: number): number => {
	const fields = readFileSync(`/proc/${pid}/stat`, "utf8")
		.replace(/^.*\) /, "")
		.split(" ");
	return ((Number(fields[11]) + Number(fields[12])) / ticksPerSecond) * 1000; // utime + stime
};
const status = (pid: number, name: string): number =>
	Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) / 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function request(url: string): Promise<{ ms: number; bytes: number; status: number }> {
	const start = performance.now();
	const response = await fetch(url);
	const bytes = (await response.arrayBuffer()).byteLength;
	return { ms: performance.now() - start, bytes, status: response.status };
}

function seed(dir: string, events: number): number {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const store = createEndoDurableEventStoreV0(dir);
	for (let index = 0; index < events; index += 1)
		store.ingest(
			event(
				index % 3 === 0 ? "tool.started" : "agent.prompt-accepted",
				{ index },
				{ session: `endo.session.bench.${index % 20}` },
			),
		);
	store.close();
	seedRegistry(dir);
	return statSync(join(dir, "events", "events.log")).size;
}

async function launch(store: string, keyFile: string): Promise<{ child: ChildProcess; base: string }> {
	// The server runs in a child with the production transport and a benchmark-only read budget that never throttles: the default
	// budget (a quarter of the wall time) would answer 429 to back-to-back reads of a long history, and this measures their cost.
	const program = `import { startEndoCockpitServerV0 } from ${JSON.stringify(new URL("../cockpit-http/server.ts", import.meta.url).href)};
import { loadOrCreateEndoDigestKeyV0 } from ${JSON.stringify(new URL("../storage/digest-key.ts", import.meta.url).href)};
const server = await startEndoCockpitServerV0({ root: process.argv[1], digestKey: loadOrCreateEndoDigestKeyV0(process.argv[2]), readBudget: { duty: 1, burstMs: 1e12 } });
console.log(server.baseUrl + "/api/v0/snapshot");`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", program, store, keyFile], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const base = await new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.stdout!.once("data", (chunk: Buffer) =>
			resolve(/(http:\/\/\S+?)\/api\/v0\/snapshot/.exec(chunk.toString())![1]!),
		);
	});
	process.once("exit", () => child.kill("SIGKILL")); // never leave a server behind if the benchmark is interrupted
	return { child, base };
}

const results: unknown[] = [];
for (const size of sizes) {
	const store = join(work, `store-${size}`);
	const seedStart = performance.now();
	const logBytes = seed(store, size);
	console.error(
		`seeded ${size} events (${(logBytes / 1e6).toFixed(1)} MB) in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`,
	);
	const row: Record<string, unknown> = { events: size, logMB: +(logBytes / 1e6).toFixed(2) };
	let peakRss = 0;
	// Each route is measured on a FRESH server process, so its cold request is the first this process has served. (The operating
	// system's page cache is warm: the store was just written. That is the state of a cockpit opened beside a recent session.)
	for (const [name, route] of [
		["snapshot", "/api/v0/snapshot"],
		["timeline100", "/api/v0/timeline?limit=100"],
	] as const) {
		const { child, base } = await launch(store, join(work, "key"));
		const pid = child.pid!;
		await sleep(500);
		const idleStart = cpuMs(pid);
		await sleep(3000);
		row[`${name}IdleCpuMsPerSecBefore`] = +((cpuMs(pid) - idleStart) / 3).toFixed(2);
		row[`${name}RssIdleMB`] = +status(pid, "VmRSS").toFixed(1);
		const cold = await request(`${base}${route}`);
		if (cold.status !== 200) throw new Error(`${route} answered ${cold.status} (cold)`);
		const cpuBefore = cpuMs(pid);
		const times: number[] = [];
		let bytes = 0;
		for (let index = 0; index < repeat; index += 1) {
			const one = await request(`${base}${route}`);
			if (one.status !== 200) throw new Error(`${route} answered ${one.status}`);
			times.push(one.ms);
			bytes = one.bytes;
		}
		const cpuPer = (cpuMs(pid) - cpuBefore) / repeat;
		// A cheap request made 20 ms after a read starts: its latency is the rest of the time the synchronous read held the server.
		const heavy = request(`${base}${route}`);
		await sleep(20);
		const cheap = await request(`${base}/not-the-capability`);
		await heavy;
		const afterStart = cpuMs(pid);
		await sleep(3000);
		row[name] = {
			coldMs: +cold.ms.toFixed(1),
			warmMedianMs: +median(times).toFixed(1),
			warmMaxMs: +Math.max(...times).toFixed(1),
			cpuMsPerRequest: +cpuPer.toFixed(1),
			responseKB: +(bytes / 1024).toFixed(1),
			amplification: +(logBytes / bytes).toFixed(1),
			cheapWaitedMs: +cheap.ms.toFixed(1),
			idleCpuMsPerSecAfter: +((cpuMs(pid) - afterStart) / 3).toFixed(2),
			rssAfterMB: +status(pid, "VmRSS").toFixed(1),
		};
		peakRss = Math.max(peakRss, status(pid, "VmHWM"));
		child.kill("SIGINT");
		await new Promise((resolve) => child.once("exit", resolve));
	}
	row.peakRssMB = +peakRss.toFixed(1);
	results.push(row);
	console.log(JSON.stringify(row));
}
const out = option("json");
if (out !== undefined) writeFileSync(out, `${JSON.stringify(results, null, "\t")}\n`);
