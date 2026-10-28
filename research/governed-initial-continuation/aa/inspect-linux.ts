// Read-only research inspection. This partial implementation never authorizes inference.
import { closeSync, constants, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { inspectLinuxHostV0 } from "./linux-host-inspection.ts";
import { publishPrivateInspectionV0, validatePrivateDirectoryV0 } from "./private-inspection-output.ts";

async function main(): Promise<void> {
	const names = [
		"--pid",
		"--endpoint",
		"--executable",
		"--executable-sha256",
		"--model",
		"--model-sha256",
		"--output",
		"--timeout-ms",
	];
	const args = process.argv.slice(2);
	if (args.length !== names.length * 2 || names.some((name, i) => args[i * 2] !== name))
		throw new Error("unsupported arguments");
	const values = args.filter((_, i) => i % 2 === 1);
	const [pid, endpoint, executablePath, executableSha256, modelPath, modelSha256, output, timeout] = values as [
		string,
		string,
		string,
		string,
		string,
		string,
		string,
		string,
	];
	const timeoutMs = Number(timeout);
	if (!isAbsolute(output) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
		throw new Error("unsupported arguments");
	const parent = openSync(dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	const controller = new AbortController();
	const deadline = performance.now() + timeoutMs;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const cancel = () => controller.abort();
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	try {
		validatePrivateDirectoryV0(parent);
		const observation = await inspectLinuxHostV0(
			{ pid: Number(pid), endpoint, executablePath, executableSha256, modelPath, modelSha256 },
			controller.signal,
			timeoutMs,
		);
		if (controller.signal.aborted || performance.now() >= deadline)
			throw new Error("inspection cancelled or expired");
		publishPrivateInspectionV0(parent, output, observation);
		process.stdout.write(
			"CRITICAL_UNAVAILABLE: partial host facts retained; no server parity or execution authority established.\n",
		);
		process.exitCode = 2;
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		closeSync(parent);
	}
}
main().catch(() => {
	process.stderr.write("CRITICAL_UNAVAILABLE: inspection refused or could not verify the selected host facts.\n");
	process.exitCode = 2;
});
