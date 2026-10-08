/**
 * `endo doctor [--root dir] [--pi path] [--attachment a] [--json]` — a read-only first-run diagnosis.
 *
 * It observes and reports; it installs nothing, starts no agent session, calls no model provider, runs no study,
 * creates no digest key and writes nothing to the store. The one process it runs is `<pi> --version`, directly and
 * bounded (the existing fingerprint code). Finding an executable is a fact about the machine, not a capability: the
 * capability view below is only what earlier recorded checks established, copied from the store, never re-derived.
 *
 * Exit status: 0 when the diagnosis ran, whatever it found (the report says what is missing); 1 only when the doctor
 * itself failed or was misused. Missing prerequisites are `unavailable`, never an internal failure.
 */

import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	fingerprintPiRuntimeV0,
	PiFingerprintErrorV0,
	piIdentityEnvironmentV0,
	resolvePiExecutableV0,
} from "../adapters/pi/identity.ts";
import { piVersionStandingV0 } from "../adapters/pi/version.ts";
import type { EndoCapabilityStateEntryV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyPathV0 } from "../storage/digest-key.ts";
import { endoHarnessRegistryDirectoryV0, openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { endoVersionV0 } from "./help.ts";
import { resolveEndoStoreRootV0 } from "./store-root.ts";

export const ENDO_NODE_REQUIRED_V0 = { major: 22, minor: 19, text: ">=22.19.0" } as const;

type Env = Readonly<Record<string, string | undefined>>;

type Presence = "present" | "absent" | "not-accessible" | "invalid";

export interface EndoDoctorReportV0 {
	schemaVersion: "endo.doctor.v0";
	endophasia: { version: string };
	node: { version: string; required: string; compatible: boolean };
	platform: { os: string; arch: string; note: string };
	pi: {
		status: "found" | "not-found" | "unidentifiable";
		requested: string | null;
		method: string | null;
		path: string | null;
		reportedVersion: string | null;
		/** What `--version` printed (bounded), when it printed anything. */
		versionText: string | null;
		/** Why no version was obtained, when the probe did not complete. */
		versionGap: string | null;
		versionStanding: string | null;
		identityDigest: string | null;
		/** "reduced" when the entrypoint or version could not be observed: equality of such identities proves little. */
		identityConfidence: string | null;
		/** Every fact the fingerprint could not obtain, with why. */
		gaps: { fact: string; reason: string }[];
		reason: string | null;
	};
	store: { root: string | null; source: string | null; presence: Presence | null; reason: string | null };
	digestKey: { path: string | null; presence: Presence | null; note: string; reason: string | null };
	evidence: {
		status: "none-recorded" | "recorded" | "damaged" | "unreadable" | "not-checked";
		attachment: string;
		recordedFingerprintAt: string | null;
		recordedVersion: string | null;
		/**
		 * Whether the Pi found now has the identity that was recorded: false when the digests differ; true only when they
		 * match and both identities are strong; null when either is missing or a reduced identity makes a match unproven.
		 */
		currentMatchesRecorded: boolean | null;
		/** The confidence of the latest recorded identity. */
		recordedIdentityConfidence: string | null;
		/** The fingerprint the recorded capability state was derived for, or null when none. */
		capabilitiesFingerprintId: string | null;
		/** True when the capabilities were derived for another identity than the latest recorded one: not current. */
		capabilitiesStale: boolean;
		/** How the read-only open classified the log (torn tail, failed frame), as recorded. */
		logDamage: string | null;
		capabilities: EndoCapabilityStateEntryV0[];
		reason: string | null;
	};
	nextSteps: string[];
	/** Failures of the doctor itself, kept apart from missing prerequisites. */
	diagnosticErrors: string[];
}

function presence(path: string, kind: "directory" | "file"): Presence {
	try {
		const info = statSync(path);
		if (kind === "directory" ? !info.isDirectory() : !info.isFile()) return "invalid";
		accessSync(path, kind === "directory" ? constants.R_OK | constants.X_OK : constants.R_OK);
		return "present";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "not-accessible";
		// A dangling symlink is not an absent path: nothing can be created through it.
		try {
			lstatSync(path);
			return "invalid";
		} catch {
			return "absent";
		}
	}
}

function nodeCompatible(version: string): boolean {
	const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
	return (
		major > ENDO_NODE_REQUIRED_V0.major ||
		(major === ENDO_NODE_REQUIRED_V0.major && minor >= ENDO_NODE_REQUIRED_V0.minor)
	);
}

/** A word safe to paste into a shell. */
function shellWord(text: string): string {
	return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export async function endoDoctorV0(
	input: { root?: string; pi?: string; attachment?: string },
	env: Env = process.env,
): Promise<EndoDoctorReportV0> {
	const attachment = input.attachment ?? "pi.default";
	// Malformed input is misuse whatever else is or is not available: throws TypeError for a malformed attachment name.
	endoHarnessRegistryDirectoryV0("", attachment);
	// The supplied environment, not the host's, decides both where Pi is searched for and what `--version` runs under.
	const searchPath = env.PATH ?? "";
	const probeEnv = { ...piIdentityEnvironmentV0(), PATH: searchPath, HOME: env.HOME ?? "" };
	const errors: string[] = [];
	const steps: string[] = [];
	const nodeVersion = process.version;
	const compatible = nodeCompatible(nodeVersion);
	if (!compatible) steps.push(`Install Node ${ENDO_NODE_REQUIRED_V0.text} (running ${nodeVersion}).`);

	// Pi: resolve, then (only if found) take the existing fingerprint, which runs `<pi> --version` once.
	let piRecord: { identity: { digest: string; confidence: string } } | null = null;
	const pi: EndoDoctorReportV0["pi"] = {
		status: "not-found",
		requested: null,
		method: null,
		path: null,
		reportedVersion: null,
		versionText: null,
		versionGap: null,
		versionStanding: null,
		identityDigest: null,
		identityConfidence: null,
		gaps: [],
		reason: null,
	};
	try {
		const resolution = await resolvePiExecutableV0({
			...(input.pi === undefined ? {} : { executable: input.pi }),
			path: searchPath,
		});
		pi.requested = resolution.requested;
		pi.method = resolution.method;
		if (resolution.resolvedPath === null) {
			pi.reason = resolution.reason ?? "not found";
			steps.push(
				input.pi === undefined
					? "Install Pi separately (Endophasia does not install it), or pass --pi /path/to/pi."
					: `Check the --pi path: ${pi.reason}.`,
			);
		} else {
			pi.path = resolution.resolvedPath;
			try {
				const fingerprint = await fingerprintPiRuntimeV0({
					attachment,
					env: probeEnv,
					...(input.pi === undefined ? {} : { executable: input.pi }),
					path: searchPath,
				});
				pi.status = "found";
				pi.reportedVersion = fingerprint.reported.version;
				pi.versionStanding = piVersionStandingV0(fingerprint.reported.version);
				pi.identityDigest = fingerprint.identity.digest;
				pi.identityConfidence = fingerprint.identity.confidence;
				pi.gaps = fingerprint.gaps.map((gap) => ({ fact: gap.fact, reason: gap.reason }));
				piRecord = fingerprint;
				pi.versionText = fingerprint.reported.versionText;
				pi.versionGap = fingerprint.gaps.find((gap) => gap.fact === "version")?.reason ?? null;
				if (fingerprint.reported.version === null)
					pi.reason = `no version was obtained (${pi.versionGap ?? `Pi printed ${JSON.stringify(pi.versionText)}, which is not a version`}); its identity rests on the file alone`;
			} catch (error) {
				if (error instanceof PiFingerprintErrorV0) {
					pi.status = "unidentifiable";
					pi.reason = error.message;
					steps.push("Pi was found but could not be identified; run it by hand with --version to see why.");
				} else throw error;
			}
		}
	} catch (error) {
		if (error instanceof PiFingerprintErrorV0) {
			pi.reason = error.message;
			steps.push(`Fix the Pi selection: ${error.message}.`);
		} else errors.push(`Pi discovery failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	// Store and key locations: stat only. Nothing is created and the key is never read.
	const store: EndoDoctorReportV0["store"] = { root: null, source: null, presence: null, reason: null };
	let rootPath: string | null = null;
	try {
		const resolved = resolveEndoStoreRootV0(input.root, env);
		rootPath = resolved.path;
		store.root = resolved.path;
		store.source = resolved.source;
		store.presence = presence(resolved.path, "directory");
		if (store.presence === "invalid")
			store.reason = "the store path is not a usable directory (a file, or a dangling symlink)";
		if (store.presence === "not-accessible") store.reason = "the store directory cannot be read and searched";
		if (store.reason !== null) steps.push(`Fix the store path: ${store.reason}.`);
	} catch (error) {
		store.reason = error instanceof Error ? error.message : String(error);
		steps.push(`Choose a store: ${store.reason}.`);
	}
	const digestKey: EndoDoctorReportV0["digestKey"] = {
		path: null,
		presence: null,
		note: "the installation key is created on first recording, never by doctor; it has its own location, separate from the store",
		reason: null,
	};
	try {
		digestKey.path = endoDigestKeyPathV0(env);
		digestKey.presence = presence(digestKey.path, "file");
		if (digestKey.presence === "invalid")
			digestKey.reason = "the key path is not a usable regular file (another file type, or a dangling symlink)";
	} catch (error) {
		digestKey.reason = error instanceof Error ? error.message : String(error);
	}

	// Recorded evidence: copied from the registry opened read-only; the capability evaluator is not run.
	let sealed = false;
	const evidence: EndoDoctorReportV0["evidence"] = {
		status: "not-checked",
		attachment,
		recordedFingerprintAt: null,
		recordedVersion: null,
		currentMatchesRecorded: null,
		recordedIdentityConfidence: null,
		capabilitiesFingerprintId: null,
		capabilitiesStale: false,
		logDamage: null,
		capabilities: [],
		reason: null,
	};
	if (rootPath !== null && (store.presence === "invalid" || store.presence === "not-accessible")) {
		evidence.reason = `not checked: ${store.reason}`;
	} else if (rootPath !== null) {
		const log = join(endoHarnessRegistryDirectoryV0(rootPath, attachment), "records.log");
		let logProbe: "present" | "absent" | string = "present";
		try {
			statSync(log);
			// It must be a readable regular file: the frame-log reader treats a read error as an empty log.
			const usable = presence(log, "file");
			if (usable !== "present")
				logProbe = `the registry log is ${usable === "invalid" ? "not a regular file" : "not readable"}`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Only a genuinely missing path is "nothing recorded"; ENOTDIR, EACCES and the rest mean the registry cannot be used.
			logProbe = code === "ENOENT" ? "absent" : `the registry path cannot be examined (${code ?? "unknown error"})`;
			// A missing log under a dangling symlink (harness/ or the attachment directory) cannot be created either.
			if (logProbe === "absent") {
				for (const ancestor of [join(rootPath, "harness"), endoHarnessRegistryDirectoryV0(rootPath, attachment)]) {
					try {
						statSync(ancestor);
					} catch {
						try {
							lstatSync(ancestor);
							logProbe = `the registry path cannot be used: ${ancestor} is a dangling symlink`;
						} catch {
							// genuinely absent: a check can create it
						}
						break;
					}
				}
			}
		}
		if (logProbe === "absent") {
			evidence.status = "none-recorded";
			evidence.reason = "no identity or capability evidence is recorded for this attachment in this store";
		} else if (logProbe !== "present") {
			evidence.status = "unreadable";
			evidence.reason = logProbe;
			steps.push(`Fix the registry path under the store: ${logProbe}.`);
		} else {
			try {
				const registry = openEndoHarnessRegistryV0(rootPath, attachment, { readOnly: true });
				const fingerprint = registry.list("fingerprint").at(-1) ?? null;
				const state = registry.last("state");
				evidence.status = "recorded";
				evidence.recordedFingerprintAt = fingerprint?.observedAt ?? null;
				evidence.recordedVersion = fingerprint?.reported.version ?? null;
				evidence.recordedIdentityConfidence = fingerprint?.identity.confidence ?? null;
				if (fingerprint !== null && piRecord !== null) {
					const sameDigest = fingerprint.identity.digest === piRecord.identity.digest;
					// A reduced identity (no entrypoint digest or no version) may not change when the runtime does.
					evidence.currentMatchesRecorded = !sameDigest
						? false
						: fingerprint.identity.confidence === "strong" && piRecord.identity.confidence === "strong"
							? true
							: null;
				}
				evidence.capabilities = state?.capabilities ?? [];
				evidence.capabilitiesFingerprintId = state?.fingerprintId ?? null;
				// The state is current only for the identity it was derived for. A newer fingerprint recorded without a
				// following state (identify, then the process stopped) leaves older capabilities describing another Pi.
				evidence.capabilitiesStale =
					state !== null && fingerprint !== null && state.fingerprintId !== fingerprint.id;
				if (state === null) evidence.reason = "no capability state is recorded yet";
				else if (evidence.capabilitiesStale)
					evidence.reason =
						"the capabilities below were derived for an earlier identity than the latest recorded one: they are not current";
				const recovery = registry.recovery();
				sealed = recovery.sealed;
				if (recovery.truncated || recovery.sealed || recovery.corruptAt !== null || recovery.discarded !== null) {
					evidence.status = "damaged";
					evidence.logDamage = recovery.sealed
						? `a recorded frame failed verification (frame ${recovery.corruptAt}); only the valid prefix is shown and the registry is sealed`
						: "the log ends in a torn tail; only the complete records before it are shown";
				}
			} catch (error) {
				evidence.status = "unreadable";
				evidence.reason = error instanceof Error ? error.message : String(error);
			}
		}
	}
	if (evidence.status === "damaged")
		steps.push(
			"The registry log is damaged: do not repair it by hand; inspect it read-only with endo harness status.",
		);
	if (pi.status === "found") {
		const check = [
			"endo harness check",
			shellWord(rootPath ?? "<root>"),
			...(input.pi === undefined ? [] : ["--pi", shellWord(pi.path ?? input.pi)]),
			...(input.attachment === undefined ? [] : ["--attachment", shellWord(input.attachment)]),
		].join(" ");
		// Only local-protocol capabilities are something `harness check` can newly establish. static-surface entries stay
		// unverified for a release whose RPC surface has not been reviewed, and live-study entries need authorisation.
		const unchecked = evidence.capabilities.filter(
			(entry) => entry.status === "unverified" && entry.requires === "local-protocol",
		);
		if (sealed)
			steps.push(
				"harness check would be refused: a sealed registry accepts no appends. Keep this store for inspection and use a different store root for new checks.",
			);
		else if (
			evidence.status === "none-recorded" ||
			(evidence.status === "recorded" && (evidence.capabilities.length === 0 || unchecked.length > 0))
		)
			steps.push(
				`Record local checks (no model call): ${check}.${
					evidence.capabilities.some((entry) => entry.status === "admitted" || entry.status === "admitted-partial")
						? ""
						: " Until then no capability is admitted."
				}`,
			);
		else if (evidence.currentMatchesRecorded === false || evidence.capabilitiesStale)
			steps.push(`The recorded capabilities do not describe the installed Pi: run ${check} again.`);
	}

	return {
		schemaVersion: "endo.doctor.v0",
		endophasia: { version: endoVersionV0() },
		node: { version: nodeVersion, required: ENDO_NODE_REQUIRED_V0.text, compatible },
		platform: {
			os: process.platform,
			arch: process.arch,
			note: "only Linux with Node 22 is exercised by the acceptance suite; other platforms are unverified",
		},
		pi,
		store,
		digestKey,
		evidence,
		nextSteps: steps,
		diagnosticErrors: errors,
	};
}

/** The human rendering of a report: facts first, then the evidence as recorded, then what to do. */
export function renderEndoDoctorV0(report: EndoDoctorReportV0): string {
	const lines: string[] = [];
	lines.push(`endo ${report.endophasia.version} — doctor (read-only; nothing was installed, started or written)`, "");
	lines.push(
		`Node      ${report.node.version} ${report.node.compatible ? `ok (${report.node.required})` : `NOT COMPATIBLE (needs ${report.node.required})`}`,
	);
	lines.push(`Platform  ${report.platform.os}/${report.platform.arch} — ${report.platform.note}`);
	const pi = report.pi;
	lines.push(
		pi.status === "found"
			? `Pi        found at ${pi.path}, reports ${pi.reportedVersion ?? "no parsable version"} (${pi.versionStanding}); a found executable is not an admitted capability`
			: `Pi        ${pi.status.toUpperCase()}${pi.reason === null ? "" : ` — ${pi.reason}`}`,
	);
	if (pi.status === "found" && pi.identityConfidence === "reduced")
		lines.push(
			`          identity is REDUCED confidence: ${pi.gaps.map((g) => `${g.fact} (${g.reason})`).join("; ")}`,
		);
	if (pi.status === "found" && pi.reason !== null) lines.push(`          note: ${pi.reason}`);
	if (pi.status === "found" && pi.reportedVersion === null && pi.versionText !== null)
		lines.push(`          \`--version\` printed: ${JSON.stringify(pi.versionText)}`);
	lines.push(
		report.store.root === null
			? `Store     UNAVAILABLE — ${report.store.reason}`
			: `Store     ${report.store.root} (from ${report.store.source}; ${report.store.presence})`,
	);
	lines.push(
		report.digestKey.path === null
			? `Key       UNAVAILABLE — ${report.digestKey.reason}`
			: `Key       ${report.digestKey.path} (${report.digestKey.presence}); ${report.digestKey.note}`,
	);
	lines.push("", `Recorded evidence for ${report.evidence.attachment}: ${report.evidence.status.toUpperCase()}`);
	if (report.evidence.reason !== null) lines.push(`  ${report.evidence.reason}`);
	if (report.evidence.logDamage !== null) lines.push(`  DAMAGED LOG: ${report.evidence.logDamage}`);
	if (report.evidence.recordedFingerprintAt !== null)
		lines.push(
			`  last identity ${report.evidence.recordedFingerprintAt}, Pi ${report.evidence.recordedVersion ?? "version not reported"}${
				report.evidence.currentMatchesRecorded === null
					? ""
					: report.evidence.currentMatchesRecorded
						? "; the installed Pi has that identity"
						: "; the installed Pi has a DIFFERENT identity"
			}${report.evidence.currentMatchesRecorded === null && report.evidence.recordedFingerprintAt !== null && report.pi.identityDigest !== null ? "; whether the installed Pi is the same could not be established (a reduced-confidence identity does not prove it)" : ""}`,
		);
	if (report.evidence.capabilitiesStale)
		lines.push("  capabilities below are STALE (recorded for an earlier identity):");
	for (const entry of report.evidence.capabilities)
		lines.push(
			`  ${entry.status.toUpperCase().padEnd(16)} ${entry.capability.padEnd(28)} ${entry.classification ?? "-"}  ${entry.reason}${entry.status === "unverified" && entry.requires === "live-study" ? " (needs an authorised live study)" : ""}`,
		);
	if (report.nextSteps.length > 0) lines.push("", "Next:", ...report.nextSteps.map((step) => `  - ${step}`));
	if (report.diagnosticErrors.length > 0)
		lines.push("", "Doctor errors (not missing prerequisites):", ...report.diagnosticErrors.map((e) => `  ! ${e}`));
	return `${lines.join("\n")}\n`;
}

export async function doctorCommand(argv: readonly string[]): Promise<void> {
	const usage = "usage: endo doctor [--root dir] [--pi path] [--attachment a] [--json]";
	const input: { root?: string; pi?: string; attachment?: string } = {};
	let json = false;
	const args = [...argv];
	while (args.length > 0) {
		const flag = args.shift()!;
		if (flag === "--json") {
			json = true;
			continue;
		}
		const key = flag === "--root" ? "root" : flag === "--pi" ? "pi" : flag === "--attachment" ? "attachment" : null;
		if (key === null) throw new TypeError(`unknown argument ${flag}\n${usage}`);
		const value = args.shift();
		if (value === undefined || value.length === 0 || value.startsWith("--"))
			throw new TypeError(
				`the flag ${flag} needs a value${value === undefined ? "" : ` (got ${JSON.stringify(value)})`}`,
			);
		if (input[key] !== undefined) throw new TypeError(`the flag ${flag} was given twice`);
		input[key] = value;
	}
	const report = await endoDoctorV0(input);
	if (json) process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify(report)))}\n`);
	else process.stdout.write(renderEndoDoctorV0(report));
	if (report.diagnosticErrors.length > 0) process.exitCode = 1;
}
