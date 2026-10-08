// `endo doctor` and the default store root: read-only, honest about absence, never a capability claim. Uses the fake
// Pi installation and a scratch HOME/XDG; no real Pi, provider or network.

import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { endoDoctorV0, renderEndoDoctorV0 } from "../cli/doctor.ts";
import { resolveEndoStoreRootV0 } from "../cli/store-root.ts";
import { endoDigestKeyPathV0 } from "../storage/digest-key.ts";
import { endoHarnessRegistryDirectoryV0 } from "../storage/harness-registry.ts";
import { type FakePiInstall, fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const cleanup: (() => void)[] = [];
const cleanupLater = (step: () => void) => void cleanup.unshift(step);
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-doctor-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
/** A scratch HOME with the host PATH (the fake Pi's launcher is `#!/usr/bin/env node`). */
function hostEnv(): Record<string, string | undefined> {
	return { HOME: scratch(), PATH: process.env.PATH };
}
function fakePi(version = "1.0.0"): FakePiInstall {
	const install = installFakePi(version);
	cleanup.push(() => install.remove());
	return install;
}

describe("resolveEndoStoreRootV0", () => {
	it("follows one precedence: explicit, ENDO_STORE_ROOT, XDG_DATA_HOME, HOME", () => {
		const env = { ENDO_STORE_ROOT: "/e/store", XDG_DATA_HOME: "/x", HOME: "/h" };
		expect(resolveEndoStoreRootV0("/given", env)).toEqual({ path: "/given", source: "explicit" });
		expect(resolveEndoStoreRootV0(undefined, env)).toEqual({ path: "/e/store", source: "ENDO_STORE_ROOT" });
		expect(resolveEndoStoreRootV0(undefined, { XDG_DATA_HOME: "/x", HOME: "/h" })).toEqual({
			path: "/x/endophasia/store",
			source: "XDG_DATA_HOME",
		});
		expect(resolveEndoStoreRootV0(undefined, { HOME: "/h" })).toEqual({
			path: "/h/.local/share/endophasia/store",
			source: "HOME",
		});
	});
	it("never defaults to the working directory, and refuses ambiguity instead of guessing", () => {
		expect(() => resolveEndoStoreRootV0(undefined, {}, "/cwd")).toThrow(/no store location/);
		expect(() => resolveEndoStoreRootV0("", {})).toThrow(/empty/);
		expect(() => resolveEndoStoreRootV0(undefined, { ENDO_STORE_ROOT: "rel/store" })).toThrow(/absolute/);
		expect(resolveEndoStoreRootV0("rel", {}, "/cwd").path).toBe("/cwd/rel");
		expect(() => resolveEndoStoreRootV0(undefined, { XDG_DATA_HOME: "rel" })).toThrow(
			/XDG_DATA_HOME must be absolute|absolute/,
		);
		expect(() => resolveEndoStoreRootV0(undefined, { HOME: "rel" })).toThrow(/absolute/);
	});
	it("keeps the store apart from the installation key", () => {
		const env = { XDG_DATA_HOME: "/x" };
		expect(endoDigestKeyPathV0(env)).toBe("/x/endophasia/digest-key");
		expect(resolveEndoStoreRootV0(undefined, env).path).toBe("/x/endophasia/store");
		// ENDO_STORE_ROOT moves the store only; ENDO_DIGEST_KEY_FILE moves the key only.
		expect(endoDigestKeyPathV0({ ...env, ENDO_STORE_ROOT: "/e" })).toBe("/x/endophasia/digest-key");
		expect(resolveEndoStoreRootV0(undefined, { ...env, ENDO_DIGEST_KEY_FILE: "/k" }).path).toBe(
			"/x/endophasia/store",
		);
	});
});

describe("endo doctor", () => {
	it("on an empty home with no Pi: a useful report, nothing created, exit 0", () => {
		const home = scratch();
		const bare = scratch();
		const run = (args: string[]) =>
			spawnSync(process.execPath, [CLI, "doctor", ...args], {
				cwd: bare,
				encoding: "utf8",
				env: { PATH: bare, HOME: home },
			});
		const human = run([]);
		expect(human.status).toBe(0);
		expect(human.stdout).toMatch(/Pi\s+NOT-FOUND/);
		expect(human.stdout).toMatch(/Install Pi separately/);
		expect(human.stdout).toMatch(/Recorded evidence for pi.default: NONE-RECORDED/);
		const json = run(["--json"]);
		const report = JSON.parse(json.stdout);
		expect(report.schemaVersion).toBe("endo.doctor.v0");
		expect(report.pi.status).toBe("not-found");
		expect(report.store).toMatchObject({ source: "HOME", presence: "absent" });
		expect(report.digestKey.presence).toBe("absent");
		expect(report.diagnosticErrors).toEqual([]);
		expect(readdirSync(home)).toEqual([]);
		expect(readdirSync(bare)).toEqual([]);
	});
	it("with a Pi but no evidence: the executable is found and no capability is claimed", async () => {
		const install = fakePi();
		const root = join(scratch(), "store");
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.pi).toMatchObject({
			status: "found",
			reportedVersion: "1.0.0",
			versionStanding: "verified-baseline",
		});
		expect(report.evidence.status).toBe("none-recorded");
		expect(report.evidence.capabilities).toEqual([]);
		expect(report.nextSteps.join(" ")).toMatch(/harness check/);
		expect(existsSync(root)).toBe(false);
	});
	it("shows recorded capability evidence as recorded, and flags a Pi that changed since", async () => {
		const install = fakePi();
		const cwd = scratch();
		const root = join(scratch(), "store");
		mkdirSync(root, { recursive: true });
		const pi = new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await pi.checkLocal();
		const recorded = pi.state();
		expect(recorded?.capabilities.length).toBeGreaterThan(0);
		const before = readdirSync(root, { recursive: true }).sort();

		const same = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(same.evidence.status).toBe("recorded");
		expect(same.evidence.currentMatchesRecorded).toBe(true);
		expect(same.evidence.capabilities).toEqual(recorded?.capabilities);
		// Statuses are shown as recorded, including the ones that are not admitted.
		const text = renderEndoDoctorV0(same);
		for (const entry of recorded?.capabilities ?? [])
			expect(text).toContain(`${entry.status.toUpperCase().padEnd(16)} ${entry.capability}`);

		install.rebuild("changed");
		const changed = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(changed.evidence.currentMatchesRecorded).toBe(false);
		expect(changed.nextSteps.join(" ")).toMatch(/do not describe the installed Pi/);
		expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
	});
	it("reports a bad --pi as unavailable, a bad flag as misuse, and a conflicting repeat as an error", async () => {
		const missing = await endoDoctorV0({ pi: "/no/such/pi" }, hostEnv());
		expect(missing.pi).toMatchObject({ status: "not-found", method: "explicit-path" });
		expect(missing.diagnosticErrors).toEqual([]);
		const run = (args: string[]) =>
			spawnSync(process.execPath, [CLI, "doctor", ...args], {
				encoding: "utf8",
				env: { PATH: "", HOME: scratch() },
			});
		expect(run(["--bogus"]).status).toBe(1);
		expect(run(["--root", "/a", "--root", "/b"]).stderr).toMatch(/given twice/);
	});

	async function recordedStore() {
		const install = fakePi();
		const root = join(scratch(), "store");
		mkdirSync(root, { recursive: true });
		const pi = new PiAttachmentV0({
			root,
			cwd: scratch(),
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await pi.checkLocal();
		return { install, root, pi };
	}

	it("does not present capabilities as current when a newer identity was recorded without a state", async () => {
		const { install, root } = await recordedStore();
		install.rebuild("newer build");
		const again = new PiAttachmentV0({
			root,
			cwd: scratch(),
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await again.identify(); // records the new fingerprint; no state follows
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.currentMatchesRecorded).toBe(true);
		expect(report.evidence.capabilitiesStale).toBe(true);
		expect(report.evidence.reason).toMatch(/not current/);
		expect(renderEndoDoctorV0(report)).toMatch(/STALE/);
		expect(report.nextSteps.join(" ")).toMatch(/do not describe the installed Pi/);
	});

	it("reports a damaged registry log instead of a clean recorded state", async () => {
		const { install, root } = await recordedStore();
		appendFileSync(join(endoHarnessRegistryDirectoryV0(root, "pi.default"), "records.log"), Buffer.from([1, 2, 3]));
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.status).toBe("damaged");
		expect(report.evidence.logDamage).toMatch(/torn tail|failed verification/);
		expect(renderEndoDoctorV0(report)).toMatch(/DAMAGED LOG/);
		expect(report.nextSteps.join(" ")).toMatch(/damaged/);
	});

	it("a store path that is a regular file is invalid, not an empty healthy store", async () => {
		const install = fakePi();
		const file = join(scratch(), "not-a-dir");
		writeFileSync(file, "x");
		const report = await endoDoctorV0({ root: file, pi: install.bin }, hostEnv());
		expect(report.store.presence).toBe("invalid");
		expect(report.evidence.status).toBe("not-checked");
		expect(report.nextSteps.join(" ")).toMatch(/Fix the store path/);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("says what the version probe did when it did not yield a version", async () => {
		const install = fakePi();
		install.setScenario("version-garbage");
		const garbage = await endoDoctorV0({ pi: install.bin }, hostEnv());
		expect(garbage.pi.status).toBe("found");
		expect(garbage.pi.versionText).toBe("pi build from source (dirty)");
		expect(renderEndoDoctorV0(garbage)).toContain("pi build from source (dirty)");
		install.setScenario("version-fail");
		const failed = await endoDoctorV0({ pi: install.bin }, hostEnv());
		expect(failed.pi.reportedVersion).toBeNull();
		expect(failed.pi.versionGap).toMatch(/\S/);
		expect(failed.pi.reason).toContain(failed.pi.versionGap!);
	});

	it("the recommended check repeats the selected Pi, attachment and root", async () => {
		const install = fakePi();
		const root = join(scratch(), "my store");
		const report = await endoDoctorV0({ root, pi: install.bin, attachment: "pi.lab" }, hostEnv());
		expect(report.nextSteps.join(" ")).toContain(
			`endo harness check '${root}' --pi ${install.bin} --attachment pi.lab`,
		);
	});

	it("rejects an option followed by another flag, and empty values, as misuse", () => {
		const run = (args: string[]) =>
			spawnSync(process.execPath, [CLI, "doctor", ...args], {
				encoding: "utf8",
				env: { PATH: "", HOME: scratch() },
			});
		for (const args of [["--root", "--json"], ["--pi", ""], ["--attachment", "--root", "/x"], ["--root"]]) {
			const result = run(args);
			expect(result.status, args.join(" ")).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/needs a value/);
		}
	});

	it("does not recommend a re-check a sealed registry would refuse", async () => {
		const { install, root } = await recordedStore();
		const log = join(endoHarnessRegistryDirectoryV0(root, "pi.default"), "records.log");
		const bytes = readFileSync(log);
		bytes[Math.floor(bytes.length / 2)] ^= 0xff; // a complete frame that no longer verifies
		writeFileSync(log, bytes);
		install.rebuild("changed after sealing");
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.status).toBe("damaged");
		expect(report.nextSteps.join(" ")).toMatch(/sealed registry accepts no appends/);
		expect(report.nextSteps.join(" ")).not.toMatch(/run endo harness check/);
	});

	it("recommends the resolved Pi path, not a relative spelling that depends on the working directory", async () => {
		const install = fakePi();
		const root = join(scratch(), "store");
		const report = await endoDoctorV0({ root, pi: relative(process.cwd(), install.bin) }, hostEnv());
		expect(report.pi.path).toBe(install.bin);
		expect(report.nextSteps.join(" ")).toContain(`--pi ${install.bin}`);
	});

	it("an unusable registry path is not 'nothing recorded'", async () => {
		const install = fakePi();
		const root = scratch();
		writeFileSync(join(root, "harness"), "a file where the registry directory belongs");
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.status).toBe("unreadable");
		expect(report.evidence.reason).toMatch(/ENOTDIR/);
		expect(report.nextSteps.join(" ")).toMatch(/Fix the registry path/);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("does not call equal reduced-confidence identities a match", async () => {
		const install = fakePi();
		install.setScenario("version-fail");
		const root = join(scratch(), "store");
		mkdirSync(root, { recursive: true });
		const pi = new PiAttachmentV0({
			root,
			cwd: scratch(),
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await pi.identify();
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.pi.identityConfidence).toBe("reduced");
		expect(report.pi.gaps.some((gap) => gap.fact === "version")).toBe(true);
		expect(report.evidence.recordedIdentityConfidence).toBe("reduced");
		expect(report.evidence.currentMatchesRecorded).toBeNull();
		const text = renderEndoDoctorV0(report);
		expect(text).toMatch(/REDUCED confidence/);
		expect(text).toMatch(/could not be established/);
		expect(text).not.toMatch(/has that identity/);
	});

	it("a registry log that is a directory is unreadable, not an empty recorded state", async () => {
		const install = fakePi();
		const root = scratch();
		mkdirSync(join(endoHarnessRegistryDirectoryV0(root, "pi.default"), "records.log"), { recursive: true });
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.status).toBe("unreadable");
		expect(report.evidence.reason).toMatch(/not a regular file/);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("an identify-only state still asks for the local checks, but a finished check does not", async () => {
		const install = fakePi();
		const root = join(scratch(), "store");
		mkdirSync(root, { recursive: true });
		const pi = new PiAttachmentV0({
			root,
			cwd: scratch(),
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await pi.identify();
		pi.state(); // what `endo harness identify` records: a state whose capabilities are all unverified
		const identified = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(identified.evidence.capabilities.length).toBeGreaterThan(0);
		expect(identified.nextSteps.join(" ")).toMatch(/Record local checks/);
		await pi.checkLocal();
		const checked = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(checked.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("a dangling symlink store is invalid, not an absent path a check could create", async () => {
		const install = fakePi();
		const link = join(scratch(), "store");
		symlinkSync(join(scratch(), "nowhere"), link);
		const report = await endoDoctorV0({ root: link, pi: install.bin }, hostEnv());
		expect(report.store.presence).toBe("invalid");
		expect(report.evidence.status).toBe("not-checked");
		expect(report.nextSteps.join(" ")).toMatch(/Fix the store path/);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("does not keep recommending a check that cannot establish an unreviewed release's static surface", async () => {
		const install = fakePi("1.0.1"); // not a reviewed release: static-surface capabilities stay unverified by design
		const root = join(scratch(), "store");
		mkdirSync(root, { recursive: true });
		const pi = new PiAttachmentV0({
			root,
			cwd: scratch(),
			executable: install.bin,
			env: fakePiEnv({}),
			requestTimeoutMs: 10_000,
		});
		await pi.checkLocal();
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(
			report.evidence.capabilities.some(
				(entry) => entry.status === "unverified" && entry.requires === "static-surface",
			),
		).toBe(true);
		expect(report.evidence.capabilities.some((entry) => entry.status === "admitted")).toBe(true);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("runs the version probe under the supplied environment, not the host's", async () => {
		const install = fakePi();
		// The launcher is `#!/usr/bin/env node`: with an empty PATH it cannot start, whatever the host PATH holds.
		const isolated = await endoDoctorV0({ pi: install.bin }, { HOME: scratch(), PATH: "" });
		expect(isolated.pi.reportedVersion).toBeNull();
		expect(isolated.pi.versionGap).toMatch(/\S/);
		const hosted = await endoDoctorV0({ pi: install.bin }, { HOME: scratch(), PATH: process.env.PATH });
		expect(hosted.pi.reportedVersion).toBe("1.0.0");
	});

	it("a dangling symlink inside the registry path is unusable, not an empty store", async () => {
		const install = fakePi();
		const root = scratch();
		symlinkSync(join(scratch(), "nowhere"), join(root, "harness"));
		const report = await endoDoctorV0({ root, pi: install.bin }, hostEnv());
		expect(report.evidence.status).toBe("unreadable");
		expect(report.evidence.reason).toMatch(/dangling symlink/);
		expect(report.nextSteps.join(" ")).not.toMatch(/Record local checks/);
	});

	it("a malformed attachment is misuse even when no store or Pi is available", async () => {
		await expect(endoDoctorV0({ attachment: "Not Valid!" }, { PATH: "" })).rejects.toThrow(TypeError);
		const result = spawnSync(process.execPath, [CLI, "doctor", "--attachment", "Not Valid!"], {
			encoding: "utf8",
			env: { PATH: "" },
		});
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
	});

	it("documents that doctor's default output is not JSON", () => {
		const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout;
		expect(help).toMatch(/except "doctor", which prints a human report unless given --json/);
	});

	it("a dangling symlink as the log itself is unusable, and an empty log recorded nothing", async () => {
		const install = fakePi();
		const dangling = scratch();
		const directory = endoHarnessRegistryDirectoryV0(dangling, "pi.default");
		mkdirSync(directory, { recursive: true });
		symlinkSync(join(scratch(), "nowhere", "records.log"), join(directory, "records.log"));
		const broken = await endoDoctorV0({ root: dangling, pi: install.bin }, hostEnv());
		expect(broken.evidence.status).toBe("unreadable");
		expect(broken.evidence.reason).toMatch(/dangling symlink/);
		expect(broken.nextSteps.join(" ")).not.toMatch(/Record local checks/);

		const empty = scratch();
		mkdirSync(endoHarnessRegistryDirectoryV0(empty, "pi.default"), { recursive: true });
		writeFileSync(join(endoHarnessRegistryDirectoryV0(empty, "pi.default"), "records.log"), "");
		const none = await endoDoctorV0({ root: empty, pi: install.bin }, hostEnv());
		expect(none.evidence.status).toBe("none-recorded");
		expect(none.evidence.capabilities).toEqual([]);
		expect(none.nextSteps.join(" ")).toMatch(/Record local checks/);
	});

	it.skipIf(process.getuid?.() === 0)("does not offer a write that the store's permissions would refuse", async () => {
		const install = fakePi();
		const readOnlyStore = scratch();
		chmodSync(readOnlyStore, 0o555);
		cleanupLater(() => chmodSync(readOnlyStore, 0o755));
		const present = await endoDoctorV0({ root: readOnlyStore, pi: install.bin }, hostEnv());
		expect(present.evidence.status).toBe("none-recorded");
		expect(present.nextSteps.join(" ")).toMatch(/harness check would fail: .* not writable/);
		expect(present.nextSteps.join(" ")).not.toMatch(/Record local checks/);
		// An absent store beneath an unwritable parent is the same case.
		const beneath = await endoDoctorV0({ root: join(readOnlyStore, "new", "store"), pi: install.bin }, hostEnv());
		expect(beneath.store.presence).toBe("absent");
		expect(beneath.nextSteps.join(" ")).toMatch(/harness check would fail/);
		// A writable location still gets the recommendation.
		const fine = await endoDoctorV0({ root: join(scratch(), "store"), pi: install.bin }, hostEnv());
		expect(fine.nextSteps.join(" ")).toMatch(/Record local checks/);
	});
});
