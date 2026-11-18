import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EndoCaptureLogV0 } from "../adapters/openai-proxy/capture-log.ts";
import { loadEndoCassetteV0 } from "../adapters/openai-proxy/cassette.ts";
import type { PiAttachmentOptionsV0 } from "../adapters/pi/attachment.ts";
import { ENDO_PI_MODEL_ROUTES_V0, modelRelayMountsV0, startModelRelayV0 } from "../adapters/sandbox/model-relay.ts";
import { ENV, trustedPiInstallation } from "../adapters/sandbox/pi-runtime.ts";
import { admitWorkspaceV0 } from "../adapters/sandbox/workspace-admission.ts";
import { sha256HexV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyV0 } from "../runtime/contracts/keyed-digest.ts";
import { endoDigestKeyPathV0 } from "../storage/digest-key.ts";
import { type PiLaunchAttestationV0, startAttestedPiV0 } from "./attested-pi.ts";
import { attestedExecutionProtectionV0 } from "./execution-protection.ts";

const MODEL = "Ornith-1.5-9B-Q8_0";
const UPSTREAM = "http://127.0.0.1:8090";
const LOCAL_FILESYSTEMS = [0xef53, 0x58465342, 0x9123683e, 0x01021994];

export function prepareEverydayPiV0(options: PiAttachmentOptionsV0) {
	if (
		process.platform !== "linux" ||
		!process.getuid?.() ||
		options.provider !== "relay" ||
		options.model !== MODEL ||
		(options.tools !== undefined && options.tools !== "none") ||
		(options.executable !== undefined && options.executable !== "/usr/bin/pi") ||
		!existsSync("/usr/bin/bwrap")
	)
		return null;
	const root = resolve(options.cwd ?? process.cwd());
	const protectedPaths = ["/usr", "/etc", "/run", "/proc", "/sys", "/dev", "/var", "/root"];
	const hostHome = process.env.HOME;
	if (hostHome !== undefined) {
		for (const name of [".pi", ".ssh", ".gnupg", ".config", ".local/share", ".aws", ".kube"])
			protectedPaths.push(resolve(hostHome, name));
	}
	try {
		if (!LOCAL_FILESYSTEMS.includes(statfsSync(root).type >>> 0) || !trustedPiInstallation()) return null;
		protectedPaths.push(resolve(endoDigestKeyPathV0()));
	} catch {
		return null;
	}
	const admitted = admitWorkspaceV0({
		root,
		evidenceRoot: resolve(options.root),
		internalRoots: protectedPaths,
	});
	if (!admitted.ok) return null;
	const scratch = mkdtempSync("/tmp/endo-everyday-");
	const home = join(scratch, "home");
	mkdirSync(home, { mode: 0o700 });
	let proof: PiLaunchAttestationV0 | null = null;
	let begun = false;
	let disposal: Promise<void> | undefined;
	let relay: Awaited<ReturnType<typeof startModelRelayV0>> | undefined;
	const store = join(scratch, "capture");
	const key = endoDigestKeyV0(randomBytes(32), "installation");
	const dispose = () => {
		disposal ??= (async () => {
			try {
				if (relay !== undefined) {
					await relay.close();
					const entries = loadEndoCassetteV0(store, key).exchanges;
					const ok = entries.filter((entry) => entry.response?.status === 200).length;
					process.stderr.write(
						`workbench: local relay admitted ${relay.admitted()} exchange(s), HTTP 200 responses: ${ok}.\n`,
					);
				}
			} finally {
				admitted.dispose();
				rmSync(scratch, { recursive: true, force: true });
			}
		})();
		return disposal;
	};
	const launch: NonNullable<PiAttachmentOptionsV0["isolatedSession"]> = async (onDiagnostic) => {
		if (begun) throw new Error("This guarded workbench cannot replace its attested Pi process.");
		begun = true;
		try {
			const log = new EndoCaptureLogV0(store, key, "record", { async: true });
			relay = await startModelRelayV0({
				runtimeDirectory: scratch,
				upstream: UPSTREAM,
				log,
				policy: {
					routes: ENDO_PI_MODEL_ROUTES_V0,
					model: MODEL,
					maxRequestBytes: 32 * 1024,
					maxTransferredBytes: 1024 * 1024,
					maxConnections: 2,
					maxTotalConnections: 12,
					maxExchanges: 1,
					maxCompletionTokens: 128,
				},
			});
			const models = JSON.stringify({
				providers: {
					relay: {
						baseUrl: "http://127.0.0.1:18080/v1",
						api: "openai-completions",
						apiKey: "local",
						models: [
							{
								id: MODEL,
								reasoning: false,
								contextWindow: 32768,
								maxTokens: 128,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			});
			const source = join(scratch, "models.json");
			writeFileSync(source, models, { flag: "wx", mode: 0o400 });
			const opened = await startAttestedPiV0(admitted, {
				onDiagnostic,
				onClosed: dispose,
				model: {
					name: MODEL,
					mounts: [
						...modelRelayMountsV0(relay, scratch),
						{
							kind: "ro-file",
							source,
							target: "/home/agent/models.json",
							role: "fixed-local-model",
							sha256: sha256HexV0(models),
						},
					],
				},
			});
			proof = opened.attestation;
			return opened;
		} catch (error) {
			await dispose();
			throw error;
		}
	};
	return {
		root: admitted.workspaceRoot,
		options: {
			...options,
			executable: "/usr/bin/pi",
			cwd: home,
			env: { ...ENV, HOME: home, PI_CODING_AGENT_DIR: home },
			tools: "none",
			governedToolFree: true,
			isolatedSession: launch,
		} satisfies PiAttachmentOptionsV0,
		protection: (piSessionId: () => string | null) =>
			attestedExecutionProtectionV0(
				() => proof,
				() => {
					const id = piSessionId();
					return { session: id === null ? null : `endo.session.pi.${id}`, workspaceRoot: root };
				},
			),
		dispose,
	};
}
