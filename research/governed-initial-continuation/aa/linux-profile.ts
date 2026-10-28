// A deliberately narrow explicit CLI profile for the previously observed llama.cpp build.
// Validation of arguments is not evidence of the binary's effective runtime settings.
export const ACCEPTED_SERVER_SHA256_V0 = "2c4c7139b339fbe1c10d02f5d8e5464e2cecf91658b2c335b29ddd648d18af68";
export interface ExplicitServerProfileV0 {
	endpoint: string;
	modelPath: string;
	modelAlias: string;
	gpuLayers: string;
}

/** Unknown flags, aliases, duplicates, router settings and environment-derived configuration are refused. */
export function validateExplicitServerArgsV0(
	argv: string[],
	envNames: string[],
	profile: ExplicitServerProfileV0,
): void {
	const allowedEnvironment = new Set([
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"LANG",
		"LC_ALL",
		"TZ",
		"TERM",
		"TMPDIR",
		"XDG_RUNTIME_DIR",
	]);
	if (argv.length > 128 || envNames.length > 4096 || envNames.some((name) => !allowedEnvironment.has(name)))
		throw new Error("environment-derived configuration unavailable");
	const endpoint = new URL(profile.endpoint);
	if (
		endpoint.origin !== profile.endpoint ||
		endpoint.protocol !== "http:" ||
		endpoint.hostname !== "127.0.0.1" ||
		!endpoint.port ||
		endpoint.pathname !== "/" ||
		endpoint.search ||
		endpoint.hash ||
		endpoint.username ||
		endpoint.password
	)
		throw new Error("unsupported endpoint");
	if (
		!/^\/(?!.*\0).+\.gguf$/i.test(profile.modelPath) ||
		!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(profile.modelAlias) ||
		!/^(0|[1-9][0-9]{0,2})$/.test(profile.gpuLayers)
	)
		throw new Error("unsupported profile");
	const values: Record<string, string> = {
		"--host": "127.0.0.1",
		"--port": endpoint.port,
		"--model": profile.modelPath,
		"--alias": profile.modelAlias,
		"--ctx-size": "65536",
		"--parallel": "1",
		"--batch-size": "512",
		"--ubatch-size": "128",
		"--cache-type-k": "q4_0",
		"--cache-type-v": "q4_0",
		"--flash-attn": "on",
		"--n-gpu-layers": profile.gpuLayers,
		"--fit": "off",
		"--cache-ram": "0",
		"--ctx-checkpoints": "0",
		"--reasoning-format": "deepseek",
	};
	const switches = new Set(["--jinja", "--no-context-shift", "--no-cache-idle-slots"]);
	const seen = new Set<string>();
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index]!;
		if (seen.has(flag)) throw new Error("duplicate configuration argument");
		seen.add(flag);
		if (switches.has(flag)) continue;
		if (!Object.hasOwn(values, flag) || argv[++index] !== values[flag])
			throw new Error("unsupported configuration argument");
	}
	if ([...Object.keys(values), ...switches].some((flag) => !seen.has(flag)))
		throw new Error("missing explicit configuration argument");
}
