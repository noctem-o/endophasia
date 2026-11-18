import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	openSync,
	readFileSync,
	readlinkSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

const O_PATH = 0o10000000;
const PATH_FLAGS = O_PATH | constants.O_NOFOLLOW;
const CONFIG = "[core]\n\trepositoryformatversion = 0\n\tfilemode = false\n\tbare = false\n";
const MAX_FILES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;

type Refusal = {
	ok: false;
	reason: "path" | "protected-root" | "git-metadata" | "git-config" | "alias" | "limit" | "changed" | "unreadable";
	detail: string;
};

class Refused extends Error {
	readonly refusal: Refusal;
	constructor(refusal: Refusal) {
		super(refusal.detail);
		this.refusal = refusal;
	}
}

function refuse(reason: Refusal["reason"], detail: string): never {
	throw new Refused({ ok: false, reason, detail });
}

const fdPath = (fd: number) => `/proc/self/fd/${fd}`;
const identity = (s: { dev: bigint; ino: bigint }) => `${s.dev}:${s.ino}`;
const below = (root: string, path: string) => {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};

function configuredRoot(path: string): string {
	if (!isAbsolute(path) || normalize(path) !== path || path === "/")
		refuse("path", "protected roots must be absolute and normalized");
	try {
		return realpathSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		return parent === "/" ? path : join(configuredRoot(parent), path.slice(parent.length + 1));
	}
}

function openCanonicalDirectory(path: string, protectedIds: ReadonlySet<string>): number {
	let entry = openSync("/", PATH_FLAGS);
	try {
		for (const name of path.slice(1).split("/")) {
			const next = openSync(join(fdPath(entry), name), PATH_FLAGS);
			closeSync(entry);
			entry = next;
			const stat = fstatSync(entry, { bigint: true });
			if (!stat.isDirectory()) refuse("path", "workspace path is not a plain directory");
			if (protectedIds.has(identity(stat)))
				refuse("protected-root", "workspace enters an evidence or internal root");
		}
		if (readlinkSync(fdPath(entry)) !== path) refuse("changed", "workspace root changed during admission");
		return entry;
	} catch (error) {
		closeSync(entry);
		throw error;
	}
}

function mountId(fd: number): string {
	const id = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
	if (id === undefined) refuse("unreadable", "mount identity unavailable");
	return id;
}

function readFileAt(fd: number, expected: BigIntStats, maxBytes: number): Buffer {
	if (expected.size > BigInt(maxBytes)) refuse("limit", "workspace snapshot is too large");
	const source = openSync(fdPath(fd), constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const bytes = Buffer.alloc(Number(expected.size) + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const read = readSync(source, bytes, offset, bytes.length - offset, offset);
			if (read === 0) break;
			offset += read;
		}
		const after = fstatSync(source, { bigint: true });
		if (
			BigInt(offset) !== expected.size ||
			identity(after) !== identity(expected) ||
			after.ctimeNs !== expected.ctimeNs ||
			after.mtimeNs !== expected.mtimeNs ||
			after.nlink !== 1n
		)
			refuse("changed", "a source file changed while it was copied");
		return bytes.subarray(0, offset);
	} finally {
		closeSync(source);
	}
}

function admitConfiguration(bytes: Buffer): void {
	let section = "";
	for (const source of bytes.toString("utf8").split(/\r?\n/)) {
		const line = source.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		if (!/^[\x20-\x7e\t]+$/.test(line) || line.endsWith("\\"))
			refuse("git-config", "unsupported configuration syntax");
		const header = /^\[([a-z]{1,64})(?: "[^"\\]+")?\]$/i.exec(line);
		if (header) {
			section = (header[1] ?? "").toLowerCase();
			continue;
		}
		const match = /^([a-z][a-z0-9-]{0,63})\s*=\s*(.*)$/i.exec(line);
		const name = match?.[1]?.toLowerCase();
		if (!name) refuse("git-config", "unsupported configuration syntax");
		const value = match?.[2]?.trim();
		if (section === "core" && name === "repositoryformatversion" && value === "0") continue;
		if (section === "core" && name === "bare" && value === "false") continue;
		if (
			section === "core" &&
			["filemode", "logallrefupdates", "ignorecase", "symlinks"].includes(name) &&
			(value === "true" || value === "false")
		)
			continue;
		if (section === "remote" && ["url", "fetch"].includes(name)) continue;
		if (section === "branch" && ["remote", "merge"].includes(name)) continue;
		refuse("git-config", `${section}.${name}`);
	}
}

function gitProjection(path: string): boolean {
	return /^\.git\/(?:HEAD|index|packed-refs|config|refs(?:\/[^/]+)*|objects|objects\/[0-9a-f]{2}(?:\/[0-9a-f]{38})?|objects\/pack(?:\/pack-[0-9a-f]{40}\.(?:pack|idx))?)$/.test(
		path,
	);
}

export interface WorkspaceAdmissionInputV0 {
	root: string;
	evidenceRoot: string;
	internalRoots: readonly string[];
}

export interface AdmittedWorkspaceV0 {
	ok: true;
	workspaceRoot: string;
	workspaceIdentity: string;
	snapshot: string;
	dispose(): void;
}

export function admitWorkspaceV0(input: WorkspaceAdmissionInputV0): AdmittedWorkspaceV0 | Refusal {
	let root: number | undefined;
	let scratch: string | undefined;
	let handedOff = false;
	try {
		if (
			process.platform !== "linux" ||
			!isAbsolute(input.root) ||
			input.root === "/" ||
			input.root.endsWith("/") ||
			normalize(input.root) !== input.root ||
			input.internalRoots.length === 0
		)
			refuse("path", "a normalized absolute workspace and protected roots are required");
		const source = input.root;
		if (below(source, "/tmp")) refuse("path", "workspace cannot contain the snapshot staging root");
		const protectedIds = new Set<string>();
		for (const path of [input.evidenceRoot, ...input.internalRoots]) {
			const guarded = configuredRoot(path);
			if (below(path, source) || below(source, path) || below(guarded, source) || below(source, guarded))
				refuse("protected-root", "workspace overlaps an evidence or internal root");
			const stat = statSync(guarded, { bigint: true, throwIfNoEntry: false });
			if (stat !== undefined) protectedIds.add(identity(stat));
		}
		root = openCanonicalDirectory(source, protectedIds);
		const rootIdentity = identity(fstatSync(root, { bigint: true }));
		const mount = mountId(root);
		const mountRoot = readFileSync("/proc/self/mountinfo", "utf8")
			.split("\n")
			.find((line) => line.startsWith(`${mount} `))
			?.split(" ")[3];
		if (mountRoot === undefined) refuse("unreadable", "workspace mount is absent from mountinfo");
		if (mountRoot !== "/") refuse("alias", "workspace is on a mounted filesystem subtree");
		const parent = openSync(`${fdPath(root)}/..`, PATH_FLAGS);
		try {
			if (mountId(parent) !== mount) refuse("alias", "workspace root is a mount point");
		} finally {
			closeSync(parent);
		}
		const temporary = lstatSync("/tmp");
		if (!temporary.isDirectory() || temporary.uid !== 0 || (temporary.mode & 0o1000) === 0)
			refuse("unreadable", "a root-owned sticky /tmp is required for private staging");
		scratch = mkdtempSync("/tmp/endo-admitted-");
		const snapshot = join(scratch, "workspace");
		mkdirSync(snapshot, { mode: 0o700 });
		let remainingBytes = MAX_BYTES;
		let remainingFiles = MAX_FILES;
		let git = false;
		let configuration = false;
		const copy = (dir: number, prefix: string, depth: number) => {
			if (depth > 32) refuse("limit", "workspace nesting is too deep");
			const before = fstatSync(dir, { bigint: true });
			const entries = opendirSync(fdPath(dir));
			try {
				for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
					const name = entry.name;
					if (name.includes("\ufffd")) refuse("path", "workspace contains a noncanonical filename");
					if (--remainingFiles < 0) refuse("limit", "workspace contains too many entries");
					const path = prefix === "" ? name : `${prefix}/${name}`;
					if (name === ".git" && prefix !== "") refuse("git-metadata", "nested Git metadata is not admitted");
					if (path.startsWith(".git/") && !gitProjection(path)) continue;
					const child = openSync(join(fdPath(dir), name), PATH_FLAGS);
					try {
						const stat = fstatSync(child, { bigint: true });
						if (protectedIds.has(identity(stat)))
							refuse("protected-root", "workspace contains an evidence or internal root");
						if (path === ".git" && !stat.isDirectory())
							refuse("git-metadata", ".git must be a plain directory; links and gitfiles are not admitted");
						if (mountId(child) !== mount || stat.isSymbolicLink() || (!stat.isDirectory() && stat.nlink !== 1n))
							refuse("alias", "workspace contains a link or a separate mount");
						if (stat.isDirectory()) {
							if (path === ".git") git = true;
							mkdirSync(join(snapshot, path), { mode: 0o700 });
							copy(child, path, depth + 1);
						} else if (stat.isFile()) {
							const bytes = readFileAt(
								child,
								stat,
								path === ".git/config" ? Math.min(remainingBytes, 65536) : remainingBytes,
							);
							remainingBytes -= bytes.length;
							if (path === ".git/config") {
								admitConfiguration(bytes);
								configuration = true;
							}
							writeFileSync(join(snapshot, path), path === ".git/config" ? CONFIG : bytes, {
								flag: "wx",
								mode: 0o600,
							});
						} else refuse("path", "workspace contains a special file");
					} finally {
						closeSync(child);
					}
				}
			} finally {
				entries.closeSync();
			}
			const after = fstatSync(dir, { bigint: true });
			if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs)
				refuse("changed", "a directory changed while it was copied");
		};
		copy(root, "", 0);
		if (!git || !configuration) refuse("git-metadata", "no standalone Git directory and configuration");
		if (readlinkSync(fdPath(root)) !== source) refuse("changed", "workspace root changed during admission");
		const result = {
			ok: true as const,
			workspaceRoot: source,
			workspaceIdentity: rootIdentity,
			snapshot,
			dispose: () => rmSync(dirname(snapshot), { recursive: true, force: true }),
		};
		handedOff = true;
		return result;
	} catch (error) {
		if (error instanceof Refused) return error.refusal;
		return { ok: false, reason: "unreadable", detail: "workspace or protected roots could not be read safely" };
	} finally {
		if (root !== undefined) closeSync(root);
		if (scratch !== undefined && !handedOff) rmSync(scratch, { recursive: true, force: true });
	}
}
