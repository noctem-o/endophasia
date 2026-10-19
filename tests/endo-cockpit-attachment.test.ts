// The cockpit over a registry the REAL Pi attachment wrote (against the fake Pi child process, tests/fixtures/fake-pi): a
// registry with several observations of one unchanged runtime is the healthy case, and the projections must not call it
// suspect. The fake Pi establishes that the bridge agrees with what the attachment records, not anything about a real Pi.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiAttachmentV0 } from "../adapters/pi/attachment.ts";
import { readEndoCockpitRuntimeV0, readEndoCockpitSnapshotV0, validateEndoCockpitSnapshotV0 } from "./cockpit-keyed.ts";
import { fakePiEnv, installFakePi } from "./fixtures/fake-pi/install.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

function setup() {
	const install = installFakePi("1.0.0");
	const root = mkdtempSync(join(tmpdir(), "endo-cockpit-att-"));
	const cwd = mkdtempSync(join(tmpdir(), "endo-cockpit-cwd-"));
	cleanup.push(() => {
		install.remove();
		rmSync(root, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	const attach = () =>
		new PiAttachmentV0({
			root,
			cwd,
			executable: install.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
			requestTimeoutMs: 10_000,
		});
	return { install, root, attach };
}

describe("a registry written by the Pi attachment", () => {
	it("raises no limit or note for an unchanged runtime observed and checked more than once", async () => {
		const { root, attach } = setup();
		await attach().checkLocal();
		const again = attach();
		expect((await again.identify()).change.kind).toBe("unchanged");
		expect((await again.checkLocal()).ran).toBe(false);
		const third = attach();
		await third.identify();
		await third.checkLocal({ force: true });

		const { identity, capabilities } = readEndoCockpitRuntimeV0(root, "pi.default");
		expect(identity.source.watermark!.counts.fingerprint).toBeGreaterThanOrEqual(3);
		expect(identity.notes).toEqual([]);
		expect(identity.lastChange).toMatchObject({ kind: "unchanged" });
		expect(capabilities.notes).toEqual([]);
		expect(capabilities.state!.currency).toBe("current");
		const admitted = capabilities.capabilities.filter((c) => c.status !== "unverified");
		expect(admitted.length).toBeGreaterThan(0);
		for (const view of capabilities.capabilities) expect(view.limits, view.capability).toEqual([]);
	});

	it("shows a changed runtime with its change and notice, a state recorded for the old runtime as stale, and re-checked evidence as sound", async () => {
		const { install, root, attach } = setup();
		await attach().checkLocal();
		install.setVersion("1.0.1");
		const changed = attach();
		await changed.identify();

		let read = readEndoCockpitRuntimeV0(root, "pi.default");
		expect(read.identity.lastChange).toMatchObject({ kind: "changed", differences: ["package", "version"] });
		expect(read.identity.lastNotification).toMatchObject({ kind: "runtime-changed", linesWithheld: true });
		expect(read.identity.previousDifferent).not.toBeNull();
		expect(read.identity.current!.version).toMatchObject({ basis: "reported", value: "1.0.1" });
		expect(read.identity.notes).toEqual([]);
		// Identify records the new observation but not a new state: the recorded state still describes the old runtime, and
		// the cockpit says so rather than presenting its admissions as current.
		expect(read.capabilities.state).toMatchObject({ currency: "stale" });
		const admitted = read.capabilities.capabilities.filter((c) => c.status !== "unverified");
		expect(admitted.length).toBeGreaterThan(0);
		for (const view of admitted) expect(view.limits.map((l) => l.code)).toContain("state-not-for-latest-fingerprint");

		await changed.checkLocal();
		read = readEndoCockpitRuntimeV0(root, "pi.default");
		expect(read.capabilities.state).toMatchObject({ currency: "current" });
		for (const view of read.capabilities.capabilities) expect(view.limits, view.capability).toEqual([]);
		expect(read.capabilities.capabilities.some((c) => c.status === "admitted")).toBe(true);
	});

	it("validates as part of a snapshot", async () => {
		const { root, attach } = setup();
		await attach().checkLocal();
		const read = readEndoCockpitRuntimeV0(root, "pi.default");
		const timeline = (await import("./cockpit-keyed.ts")).readEndoCockpitTimelineV0(root);
		expect(
			validateEndoCockpitSnapshotV0({
				schemaVersion: "endo.cockpit-snapshot.v0",
				projectionVersion: "cockpit-snapshot.3",
				consistency: "independent-sources",
				timeline,
				runtimes: [read],
			}),
		).not.toBeNull();
	});

	it("publishes none of the commitments the attachment recorded (full values or their 12-character prefixes)", async () => {
		const { install, root, attach } = setup();
		await attach().checkLocal();
		// A changed runtime adds a second fingerprint, a change record and a notice.
		install.remove();
		const second = installFakePi("1.0.1");
		cleanup.push(second.remove);
		await new PiAttachmentV0({
			root,
			cwd: root,
			executable: second.bin,
			env: fakePiEnv({ FAKE_PI_STEP_MS: "15" }),
			requestTimeoutMs: 10_000,
		}).identify();

		const files = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
				entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
			);
		const raw = files(root)
			.map((file) => readFileSync(file, "utf8"))
			.join("\n");
		const commitments = new Set<string>();
		for (const match of raw.matchAll(/endo\.evidence\.[a-z0-9.-]*?\.([0-9a-f]{64})/g)) commitments.add(match[1]!);
		for (const match of raw.matchAll(/"(?:identityDigest|digest)":"([0-9a-f]{64})"/g)) commitments.add(match[1]!);
		expect(commitments.size).toBeGreaterThanOrEqual(4);

		const runtime = readEndoCockpitRuntimeV0(root, "pi.default");
		const snapshot = readEndoCockpitSnapshotV0(root, { attachments: ["pi.default"] });
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		const published = JSON.stringify({ runtime, snapshot });
		for (const value of commitments) {
			expect(published, value).not.toContain(value);
			expect(published, value.slice(0, 12)).not.toContain(value.slice(0, 12));
		}
	});
});
