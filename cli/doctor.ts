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

import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fingerprintPiRuntimeV0, PiFingerprintErrorV0, resolvePiExecutableV0 } from "../adapters/pi/identity.ts";
import { piVersionStandingV0 } from "../adapters/pi/version.ts";
import type { EndoCapabilityStateEntryV0 } from "../protocol/harness.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import { endoDigestKeyPathV0 } from "../storage/digest-key.ts";
import { endoHarnessRegistryDirectoryV0, openEndoHarnessRegistryV0 } from "../storage/harness-registry.ts";
import { endoVersionV0 } from "./help.ts";
import { resolveEndoStoreRootV0 } from "./store-root.ts";

export const ENDO_NODE_REQUIRED_V0 = { major: 22, minor: 19, text: ">=22.19.0" } as const;

type Env = Readonly<Record<string, string | undefined>>;

type Presence = "present" | "absent" | "not-accessible";

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
		versionStanding: string | null;
		identityDigest: string | null;
		reason: string | null;
	};
	store: { root: string | null; source: string | null; presence: Presence | null; reason: string | null };
	digestKey: { path: string | null; presence: Presence | null; note: string; reason: string | null };
	evidence: {
		status: "none-recorded" | "recorded" | "unreadable" | "not-checked";
		attachment: string;
		recordedFingerprintAt: string | null;
		recordedVersion: string | null;
		/** Whether the Pi found now has the identity that was recorded; null when either is missing. */
		currentMatchesRecorded: boolean | null;
		capabilities: EndoCapabilityStateEntryV0[];
		reason: string | null;
	};
	nextSteps: string[];
	/** Failures of the doctor itself, kept apart from missing prerequisites. */
	diagnosticErrors: string[];
}

function presence(path: string): Presence {
	try {
		lstatSync(path);
		accessSync(path, constants.R_OK);
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "not-accessible";
	}
}

function nodeCompatible(version: string): boolean {
	const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
	return (
		major > ENDO_NODE_REQUIRED_V0.major ||
		(major === ENDO_NODE_REQUIRED_V0.major && minor >= ENDO_NODE_REQUIRED_V0.minor)
	);
}

export async function endoDoctorV0(
	input: { root?: string; pi?: string; attachment?: string },
	env: Env = process.env,
): Promise<EndoDoctorReportV0> {
	const attachment = input.attachment ?? "pi.default";
	const errors: string[] = [];
	const steps: string[] = [];
	const nodeVersion = process.version;
	const compatible = nodeCompatible(nodeVersion);
	if (!compatible) steps.push(`Install Node ${ENDO_NODE_REQUIRED_V0.text} (running ${nodeVersion}).`);

	// Pi: resolve, then (only if found) take the existing fingerprint, which runs `<pi> --version` once.
	const pi: EndoDoctorReportV0["pi"] = {
		status: "not-found",
		requested: null,
		method: null,
		path: null,
		reportedVersion: null,
		versionStanding: null,
		identityDigest: null,
		reason: null,
	};
	try {
		const resolution = await resolvePiExecutableV0({
			...(input.pi === undefined ? {} : { executable: input.pi }),
			...(env.PATH === undefined ? {} : { path: env.PATH }),
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
					...(input.pi === undefined ? {} : { executable: input.pi }),
					...(env.PATH === undefined ? {} : { path: env.PATH }),
				});
				pi.status = "found";
				pi.reportedVersion = fingerprint.reported.version;
				pi.versionStanding = piVersionStandingV0(fingerprint.reported.version);
				pi.identityDigest = fingerprint.identity.digest;
				if (fingerprint.reported.version === null)
					pi.reason = "Pi did not report a version that parses; its identity rests on the file alone";
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
		store.presence = presence(resolved.path);
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
		digestKey.presence = presence(digestKey.path);
	} catch (error) {
		digestKey.reason = error instanceof Error ? error.message : String(error);
	}

	// Recorded evidence: copied from the registry opened read-only; the capability evaluator is not run.
	const evidence: EndoDoctorReportV0["evidence"] = {
		status: "not-checked",
		attachment,
		recordedFingerprintAt: null,
		recordedVersion: null,
		currentMatchesRecorded: null,
		capabilities: [],
		reason: null,
	};
	if (rootPath !== null) {
		if (!existsSync(join(endoHarnessRegistryDirectoryV0(rootPath, attachment), "records.log"))) {
			evidence.status = "none-recorded";
			evidence.reason = "no identity or capability evidence is recorded for this attachment in this store";
		} else {
			try {
				const registry = openEndoHarnessRegistryV0(rootPath, attachment, { readOnly: true });
				const fingerprint = registry.list("fingerprint").at(-1) ?? null;
				const state = registry.last("state");
				evidence.status = "recorded";
				evidence.recordedFingerprintAt = fingerprint?.observedAt ?? null;
				evidence.recordedVersion = fingerprint?.reported.version ?? null;
				if (fingerprint !== null && pi.identityDigest !== null)
					evidence.currentMatchesRecorded = fingerprint.identity.digest === pi.identityDigest;
				evidence.capabilities = state?.capabilities ?? [];
				if (state === null) evidence.reason = "no capability state is recorded yet";
			} catch (error) {
				evidence.status = "unreadable";
				evidence.reason = error instanceof Error ? error.message : String(error);
			}
		}
	}
	if (pi.status === "found") {
		if (evidence.status === "none-recorded" || evidence.capabilities.length === 0)
			steps.push(
				"Record local checks (no model call): endo harness check <root>. Until then no capability is admitted.",
			);
		else if (evidence.currentMatchesRecorded === false)
			steps.push(
				"The installed Pi differs from the one the evidence describes: run endo harness check <root> again.",
			);
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
	if (pi.status === "found" && pi.reason !== null) lines.push(`          note: ${pi.reason}`);
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
	if (report.evidence.recordedFingerprintAt !== null)
		lines.push(
			`  last identity ${report.evidence.recordedFingerprintAt}, Pi ${report.evidence.recordedVersion ?? "version not reported"}${
				report.evidence.currentMatchesRecorded === null
					? ""
					: report.evidence.currentMatchesRecorded
						? "; the installed Pi has that identity"
						: "; the installed Pi has a DIFFERENT identity"
			}`,
		);
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
		if (value === undefined) throw new TypeError(`the flag ${flag} needs a value`);
		if (input[key] !== undefined) throw new TypeError(`the flag ${flag} was given twice`);
		input[key] = value;
	}
	const report = await endoDoctorV0(input);
	if (json) process.stdout.write(`${canonicalEndoJsonV0(JSON.parse(JSON.stringify(report)))}\n`);
	else process.stdout.write(renderEndoDoctorV0(report));
	if (report.diagnosticErrors.length > 0) process.exitCode = 1;
}
