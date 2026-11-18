import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitWorkspaceV0 } from "../adapters/sandbox/workspace-admission.ts";
import { inspectWorkspaceGitV0 } from "../adapters/sandbox/workspace-git.ts";

const cleanup: string[] = [];
afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const directory = mkdtempSync("/tmp/endo-workspace-fixture-");
	cleanup.push(directory);
	const root = join(directory, "work");
	const evidenceRoot = join(directory, "evidence");
	const internalRoots = [join(directory, "internal")];
	for (const path of [root, evidenceRoot, ...internalRoots]) mkdirSync(path);
	const git = (...args: string[]) =>
		execFileSync("/usr/bin/git", args, {
			cwd: root,
			env: { HOME: directory, PATH: "/usr/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
			stdio: "pipe",
		});
	git("init", "-q");
	writeFileSync(join(root, "tracked"), "before\n");
	git("add", "--", "tracked");
	const config = join(root, ".git/config");
	return { directory, root, evidenceRoot, internalRoots, config, git, input: { root, evidenceRoot, internalRoots } };
}

describe.runIf(process.platform === "linux")("workspace admission", () => {
	it("projects info/exclude without admitting other info files", () => {
		const f = fixture();
		writeFileSync(join(f.root, ".git/info/exclude"), "private-build\n");
		writeFileSync(join(f.root, ".git/info/attributes"), "tracked filter=fixture\n");
		writeFileSync(join(f.root, "private-build"), "synthetic");
		writeFileSync(join(f.root, "visible"), "control");
		const admitted = admitWorkspaceV0(f.input);
		if (!admitted.ok) throw new Error(admitted.detail);
		try {
			const status = (dir: string) => f.git("-C", dir, "status", "--porcelain").toString();
			expect(status(f.root)).toContain("?? visible");
			expect(status(f.root)).not.toContain("private-build");
			expect(status(admitted.snapshot)).toBe(status(f.root));
			expect(existsSync(join(admitted.snapshot, ".git/info/attributes"))).toBe(false);
		} finally {
			admitted.dispose();
		}
	});

	it("refuses a workspace symlink or a symlinked ancestor", () => {
		const f = fixture();
		const alias = join(f.directory, "alias");
		symlinkSync(f.root, alias);
		mkdirSync(join(f.root, "child"));
		for (const root of [alias, join(alias, "child")])
			expect(admitWorkspaceV0({ ...f.input, root })).toMatchObject({ ok: false, reason: "path" });
	});

	it("refuses a linked Git directory or a gitfile before following either", () => {
		const f = fixture();
		rmSync(join(f.root, ".git"), { recursive: true });
		const target = join(f.directory, "outside-admin");
		mkdirSync(target);
		symlinkSync(target, join(f.root, ".git"));
		expect(admitWorkspaceV0(f.input)).toMatchObject({ ok: false, reason: "git-metadata" });
		rmSync(join(f.root, ".git"));
		writeFileSync(join(f.root, ".git"), `gitdir: ${target}\n`);
		expect(admitWorkspaceV0(f.input)).toMatchObject({ ok: false, reason: "git-metadata" });
	});

	it("refuses protected roots in either direction, including configured aliases", () => {
		const f = fixture();
		const alias = join(f.directory, "evidence-alias");
		symlinkSync(f.evidenceRoot, alias);
		for (const root of [f.evidenceRoot, f.internalRoots[0]!, f.directory])
			expect(admitWorkspaceV0({ ...f.input, root, evidenceRoot: alias })).toMatchObject({
				ok: false,
				reason: "protected-root",
			});
	});

	it("refuses symlink and hardlink sources in the copied tree", () => {
		const f = fixture();
		const outside = join(f.evidenceRoot, "fixture");
		writeFileSync(outside, "synthetic\n");
		const path = join(f.root, "alias");
		symlinkSync(outside, path);
		expect(admitWorkspaceV0(f.input)).toMatchObject({ ok: false, reason: "alias" });
		rmSync(path);
		linkSync(outside, path);
		expect(admitWorkspaceV0(f.input)).toMatchObject({ ok: false, reason: "alias" });
	});

	it.each([
		["core", "fsmonitor", "core.fsmonitor"],
		["core", "hooksPath", "core.hookspath"],
		["core", "pager", "core.pager"],
		["core", "sshCommand", "core.sshcommand"],
		['diff "fixture"', "textconv", "diff.textconv"],
		["diff", "external", "diff.external"],
		['filter "fixture"', "clean", "filter.clean"],
		['filter "fixture"', "smudge", "filter.smudge"],
		['filter "fixture"', "process", "filter.process"],
		["uploadpack", "packObjectsHook", "uploadpack.packobjectshook"],
		['protocol "ext"', "allow", "protocol.allow"],
		["include", "path", "include.path"],
		['includeIf "gitdir:fixture/"', "path", "includeif.path"],
		["gpg", "program", "gpg.program"],
		["credential", "helper", "credential.helper"],
	])("refuses %s.%s before inspecting the workspace", async (section, directive, detail) => {
		const f = fixture();
		const canary = join(f.directory, "canary");
		const executable = join(f.root, "fixture-command");
		writeFileSync(executable, `#!/bin/sh\nprintf called > '${canary}'\n`);
		chmodSync(executable, 0o700);
		writeFileSync(join(f.root, ".gitattributes"), "tracked filter=fixture diff=fixture\n");
		const value = section.startsWith("protocol") ? "always" : executable;
		writeFileSync(f.config, `${readFileSync(f.config, "utf8")}\n[${section}]\n\t${directive} = ${value}\n`);
		expect(await inspectWorkspaceGitV0(f.input)).toEqual({ ok: false, reason: "git-config", detail });
		expect(existsSync(canary)).toBe(false);
	});

	it("seals configuration and working bytes in a separate snapshot", () => {
		const f = fixture();
		chmodSync(join(f.root, "tracked"), 0o755);
		const otherOnly = join(f.root, "other-exec");
		writeFileSync(otherOnly, "fixture\n");
		chmodSync(otherOnly, 0o655);
		chmodSync(f.config, 0o700);
		const admitted = admitWorkspaceV0(f.input);
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) return;
		try {
			writeFileSync(f.config, "[core]\n\tfsmonitor = synthetic\n");
			writeFileSync(join(f.root, "tracked"), "after\n");
			expect(readFileSync(join(admitted.snapshot, ".git/config"), "utf8")).toBe(
				"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
			);
			expect(readFileSync(join(admitted.snapshot, "tracked"), "utf8")).toBe("before\n");
			expect(statSync(join(admitted.snapshot, "tracked")).mode & 0o777).toBe(0o700);
			expect(statSync(join(admitted.snapshot, "other-exec")).mode & 0o777).toBe(0o600);
			expect(statSync(join(admitted.snapshot, ".git/config")).mode & 0o777).toBe(0o600);
			expect(existsSync(join(admitted.snapshot, ".git/hooks"))).toBe(false);
		} finally {
			admitted.dispose();
		}
	});

	it.runIf(process.env.ENDO_ISOLATE_HOST === "1")(
		"reads status and diff in two real read-only scopes",
		async () => {
			const f = fixture();
			writeFileSync(join(f.root, "tracked"), "after\n");
			const result = await inspectWorkspaceGitV0(f.input);
			expect(result).toMatchObject({ ok: true, workspaceRoot: f.root });
			if (!result.ok) return;
			expect(result.status.toString()).toContain(" tracked\0");
			expect(result.diff.toString()).toContain("+after");
		},
		30_000,
	);

	it.runIf(process.env.ENDO_ISOLATE_HOST === "1")(
		"reports a tracked script becoming executable in both status and diff",
		async () => {
			const f = fixture();
			const script = join(f.root, "run.sh");
			writeFileSync(script, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
			f.git("add", "--", "run.sh");
			chmodSync(script, 0o755);
			const result = await inspectWorkspaceGitV0(f.input);
			expect(result).toMatchObject({ ok: true, workspaceRoot: f.root });
			if (!result.ok) return;
			const status = result.status
				.toString()
				.split("\0")
				.find((entry) => entry.endsWith(" run.sh"));
			expect(status).toMatch(/^1 AM N\.\.\. 000000 100644 100755 /);
			expect(result.diff.toString()).toBe("diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n");
		},
		30_000,
	);
});
