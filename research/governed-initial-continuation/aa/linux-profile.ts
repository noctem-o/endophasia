// A deliberately narrow explicit CLI profile for the previously observed llama.cpp build.
// Validation of arguments is not evidence of the binary's effective runtime settings.
export const ACCEPTED_SERVER_SHA256_V0 = "2c4c7139b339fbe1c10d02f5d8e5464e2cecf91658b2c335b29ddd648d18af68";
export const EXPLICIT_FIT_OFF_PROFILE_V0 = "llama.cpp-11518-explicit-fit-off-v0";
export class LinuxProfileErrorV0 extends Error {
	readonly classification: "MISMATCH" | "UNSUPPORTED";
	constructor(classification: "MISMATCH" | "UNSUPPORTED", message: string) {
		super(message);
		this.classification = classification;
	}
}
export interface ExplicitServerProfileV0 {
	endpoint: string;
	modelPath: string;
	modelAlias: string;
	gpuLayers: string;
}

function explicitEndpointV0(profile: ExplicitServerProfileV0): URL {
	let endpoint: URL;
	try {
		endpoint = new URL(profile.endpoint);
	} catch {
		throw new LinuxProfileErrorV0("UNSUPPORTED", "unsupported endpoint");
	}
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
		throw new LinuxProfileErrorV0("UNSUPPORTED", "unsupported endpoint");
	return endpoint;
}
/** The one definition of the accepted flags: the task-owned launcher builds from it and the inspector validates against it. */
export function explicitServerFlagsV0(profile: ExplicitServerProfileV0): {
	values: Record<string, string>;
	switches: Set<string>;
} {
	const endpoint = explicitEndpointV0(profile);
	if (
		!/^\/(?!.*\0).+\.gguf$/i.test(profile.modelPath) ||
		!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(profile.modelAlias) ||
		!/^(0|[1-9][0-9]{0,2})$/.test(profile.gpuLayers)
	)
		throw new LinuxProfileErrorV0("UNSUPPORTED", "unsupported profile");
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
	return { values, switches: new Set(["--jinja", "--no-context-shift", "--no-cache-idle-slots"]) };
}
/** Arguments after argv[0], in a fixed order. */
export function buildExplicitServerArgsV0(profile: ExplicitServerProfileV0): string[] {
	const { values, switches } = explicitServerFlagsV0(profile);
	return [...Object.entries(values).flat(), ...switches];
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
		throw new LinuxProfileErrorV0("UNSUPPORTED", "environment override or unsupported environment name");
	const { values, switches } = explicitServerFlagsV0(profile);
	const seen = new Set<string>();
	for (let index = 1; index < argv.length; index++) {
		const flag = argv[index]!;
		if (seen.has(flag)) throw new LinuxProfileErrorV0("MISMATCH", "duplicate configuration argument");
		seen.add(flag);
		if (switches.has(flag)) continue;
		if (!Object.hasOwn(values, flag)) throw new LinuxProfileErrorV0("UNSUPPORTED", "unknown or router argument");
		if (argv[++index] !== values[flag]) throw new LinuxProfileErrorV0("MISMATCH", "configuration value mismatch");
	}
	if ([...Object.keys(values), ...switches].some((flag) => !seen.has(flag)))
		throw new LinuxProfileErrorV0("MISMATCH", "missing explicit configuration argument");
}
