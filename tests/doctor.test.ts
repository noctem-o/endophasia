// `endo doctor` and the default store root: read-only, honest about absence, never a capability claim. Uses the fake
// Pi installation and a scratch HOME/XDG; no real Pi, provider or network.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { endoDoctorV0, renderEndoDoctorV0 } from "../cli/doctor.ts";
import { resolveEndoStoreRootV0 } from "../cli/store-root.ts";
import { endoDigestKeyPathV0 } from "../storage/digest-key.ts";
import { type FakePiInstall, fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const CLI = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "endo-doctor-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
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
		const report = await endoDoctorV0({ root, pi: install.bin }, { HOME: scratch() });
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

		const same = await endoDoctorV0({ root, pi: install.bin }, { HOME: scratch() });
		expect(same.evidence.status).toBe("recorded");
		expect(same.evidence.currentMatchesRecorded).toBe(true);
		expect(same.evidence.capabilities).toEqual(recorded?.capabilities);
		// Statuses are shown as recorded, including the ones that are not admitted.
		const text = renderEndoDoctorV0(same);
		for (const entry of recorded?.capabilities ?? [])
			expect(text).toContain(`${entry.status.toUpperCase().padEnd(16)} ${entry.capability}`);

		install.rebuild("changed");
		const changed = await endoDoctorV0({ root, pi: install.bin }, { HOME: scratch() });
		expect(changed.evidence.currentMatchesRecorded).toBe(false);
		expect(changed.nextSteps.join(" ")).toMatch(/differs/);
		expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
	});
	it("reports a bad --pi as unavailable, a bad flag as misuse, and a conflicting repeat as an error", async () => {
		const missing = await endoDoctorV0({ pi: "/no/such/pi" }, { HOME: scratch() });
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
});
