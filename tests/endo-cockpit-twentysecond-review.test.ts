// PR #57 review round 22: discovery does not turn "could not look" into "is not there". A name the harness directory lists
// whose metadata cannot be read (a dangling or looping link, a directory that cannot be searched) is kept, so the registry
// reader reports what it finds when it reads it; only a name proven not to be a directory, or one the source-admission
// policy refuses, is left out. Everything runs on a real filesystem: symlinks are made by the tests, never by the reader.

import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ENDO_COCKPIT_SOURCE_ERRORS_V0 } from "../protocol/cockpit.ts";
import { canonicalEndoJsonV0 } from "../runtime/contracts/canonical-json.ts";
import {
	ATTACHMENT,
	CANARY,
	ingestAll,
	lifecycleEvents,
	removeTempRoots,
	seedRegistry,
	tempRoot,
	treeHash,
} from "./cockpit-fixtures.ts";
import {
	listEndoCockpitAttachmentsV0,
	readEndoCockpitRegistryV0,
	readEndoCockpitSnapshotV0,
	validateEndoCockpitSnapshotV0,
} from "./cockpit-keyed.ts";

afterAll(() => removeTempRoots((dir) => rmSync(dir, { recursive: true, force: true })));

const HEX = "0123456789abcdef0123456789abcdef";
/** Well-formed dotted kinds the source-admission policy refuses: a reserved alias segment, and credential-shaped text. */
const REFUSED = [
	`withheld-${HEX}`,
	`pi.withheld-${HEX}.default`,
	"sk-abcdefghijklmnopqrstuvwxyz0123456789",
	"pi.sk-abcdefghijklmnopqrstuvwxyz0123456789",
];
/** Names that are not dotted kinds at all. */
const MALFORMED = ["Not-Valid", "Not..Valid", ".leading", "trailing.", "has space", "UPPER", "a_b"];

const DANGLING = { state: "unopenable", error: "path-dangling-symlink" } as const;
const UNREADABLE = { state: "unopenable", error: "path-unreadable" } as const;

/** A root whose harness directory exists and is empty. */
function world(): { root: string; harness: string } {
	const root = tempRoot();
	const harness = join(root, "harness");
	mkdirSync(harness, { recursive: true });
	return { root, harness };
}

/** The whole tree under `root`, links included, WITHOUT following any (treeHash would throw on a dangling link). */
function linkTree(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stats = lstatSync(path);
			const at = relative(root, path);
			if (stats.isSymbolicLink()) lines.push(`l ${at} -> ${readlinkSync(path)}`);
			else if (stats.isDirectory()) {
				lines.push(`d ${at} ${(stats.mode & 0o777).toString(8)}`);
				walk(path);
			} else lines.push(`f ${at} ${stats.size} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return lines.join("\n");
}

/** Per attachment, the source condition its runtime reports: `state/error kind`. */
function shown(snapshot: ReturnType<typeof readEndoCockpitSnapshotV0>): Record<string, string> {
	return Object.fromEntries(
		snapshot.runtimes.map((runtime) => {
			const source = runtime.identity.source;
			return [source.attachment, `${source.condition.state}/${source.condition.error?.kind ?? "-"}`];
		}),
	);
}
const cond = (kind: { state: string; error: string }) => `${kind.state}/${kind.error}`;

describe("a listed attachment whose metadata cannot be read stays visible (P2)", () => {
	it("keeps a dangling symlink in discovery, and the default snapshot reports its runtime unopenable, not omitted", () => {
		const { root, harness } = world();
		seedRegistry(root);
		symlinkSync(join(root, "no-such-target"), join(harness, "gone.default"));
		// The enumeration sees the entry...
		expect(readdirSync(harness).sort()).toEqual(["gone.default", "pi.default"]);
		// ...discovery keeps it...
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(["gone.default", "pi.default"]);
		// ...so the default snapshot has its runtime, in code-unit order, with the condition the registry reader's probe finds.
		const snapshot = readEndoCockpitSnapshotV0(root);
		expect(snapshot.runtimes.map((runtime) => runtime.identity.source.attachment)).toEqual([
			"gone.default",
			"pi.default",
		]);
		const gone = snapshot.runtimes[0]!;
		const condition = {
			state: "unopenable",
			tornTail: null,
			sealedAt: null,
			error: { kind: "path-dangling-symlink", message: ENDO_COCKPIT_SOURCE_ERRORS_V0["path-dangling-symlink"] },
		};
		for (const view of [gone.identity, gone.capabilities]) {
			expect(view.source.condition).toEqual(condition);
			expect(view.source.watermark).toBeNull();
			expect(view.notes.map((note) => note.code)).toEqual(["source-not-projectable"]);
		}
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
		// The explicit-name read says the same thing: discovery added no classification of its own.
		expect(readEndoCockpitRegistryV0(root, "gone.default")).toEqual({ source: gone.identity.source, records: null });
		expect(shown(snapshot)).toEqual({ "gone.default": cond(DANGLING), "pi.default": "readable/-" });
	});

	it("keeps every kind of unclassifiable entry: dangling (also through a chain or a missing directory) and looping links", () => {
		const { root, harness } = world();
		symlinkSync(join(root, "missing"), join(harness, "dangling.one"));
		symlinkSync(join(root, "missing-dir", "deeper"), join(harness, "dangling.deep"));
		symlinkSync(join(harness, "chain.b"), join(harness, "chain.a"));
		symlinkSync(join(root, "still-missing"), join(harness, "chain.b"));
		symlinkSync(join(harness, "loop.b"), join(harness, "loop.a"));
		symlinkSync(join(harness, "loop.a"), join(harness, "loop.b"));
		symlinkSync(join(harness, "self"), join(harness, "self"));
		const names = ["chain.a", "chain.b", "dangling.deep", "dangling.one", "loop.a", "loop.b", "self"];
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(names);
		const snapshot = readEndoCockpitSnapshotV0(root);
		expect(shown(snapshot)).toEqual({
			"chain.a": cond(DANGLING),
			"chain.b": cond(DANGLING),
			"dangling.deep": cond(DANGLING),
			"dangling.one": cond(DANGLING),
			// A looping link is not dangling (nothing resolves to "missing"): the probe reports it unreadable.
			"loop.a": cond(UNREADABLE),
			"loop.b": cond(UNREADABLE),
			self: cond(UNREADABLE),
		});
		expect(validateEndoCockpitSnapshotV0(snapshot)).not.toBeNull();
	});

	// Real permission failures need an unprivileged process: root searches any directory.
	it.skipIf(typeof process.getuid !== "function" || process.getuid() === 0)(
		"keeps the admitted names of a harness directory that can be listed but not searched",
		() => {
			const { root, harness } = world();
			seedRegistry(root);
			mkdirSync(join(harness, "zeta.default"));
			const before = linkTree(root);
			chmodSync(harness, 0o444);
			try {
				// Every child's metadata fails (EACCES) while the listing works: nothing can be proven about any of them.
				expect(readdirSync(harness).sort()).toEqual(["pi.default", "zeta.default"]);
				expect(listEndoCockpitAttachmentsV0(root)).toEqual(["pi.default", "zeta.default"]);
				expect(shown(readEndoCockpitSnapshotV0(root))).toEqual({
					"pi.default": cond(UNREADABLE),
					"zeta.default": cond(UNREADABLE),
				});
			} finally {
				chmodSync(harness, 0o755);
			}
			expect(linkTree(root)).toBe(before);
		},
	);
});

describe("only what is proven not to be an attachment directory is excluded", () => {
	it("lists real directories and links to directories; excludes files and links to files", () => {
		const { root, harness } = world();
		mkdirSync(join(harness, "real.dir"));
		mkdirSync(join(harness, "target.dir"));
		symlinkSync(join(harness, "target.dir"), join(harness, "link.to.dir"));
		writeFileSync(join(harness, "plain.file"), "x");
		symlinkSync(join(harness, "plain.file"), join(harness, "link.to.file"));
		writeFileSync(join(harness, "empty.file"), "");
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(["link.to.dir", "real.dir", "target.dir"]);
		// An explicitly named file is still reported by the reader (selection is unchanged); discovery just does not list it.
		expect(
			shown(readEndoCockpitSnapshotV0(root, { attachments: ["plain.file", "link.to.file", "real.dir"] })),
		).toEqual({
			"link.to.file": cond(UNREADABLE),
			"plain.file": cond(UNREADABLE),
			"real.dir": "absent/-",
		});
	});

	it("leaves out a refused or malformed name whether it is a directory or an unreadable link", () => {
		const asDirectories = world();
		const asDanglingLinks = world();
		const asLoops = world();
		for (const name of [...REFUSED, ...MALFORMED]) {
			mkdirSync(join(asDirectories.harness, name));
			symlinkSync(join(asDanglingLinks.root, "missing"), join(asDanglingLinks.harness, name));
			symlinkSync(join(asLoops.harness, name), join(asLoops.harness, name));
		}
		// Name admission comes first: an unreadable entry with an inadmissible name is not kept by the new rule.
		for (const { root, harness } of [asDirectories, asDanglingLinks, asLoops]) {
			expect(readdirSync(harness)).toHaveLength(REFUSED.length + MALFORMED.length);
			expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
			expect(readEndoCockpitSnapshotV0(root).runtimes).toEqual([]);
		}
	});

	it("keeps an admitted unreadable name beside refused ones", () => {
		const { root, harness } = world();
		for (const name of REFUSED) symlinkSync(join(root, "missing"), join(harness, name));
		symlinkSync(join(root, "missing"), join(harness, "pi.xwithheld-abc"));
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(["pi.xwithheld-abc"]);
	});

	it("keeps the existing behaviour of an absent harness directory and of an absent root", () => {
		const root = tempRoot();
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
		expect(listEndoCockpitAttachmentsV0(join(root, "nowhere"))).toEqual([]);
		expect(readEndoCockpitSnapshotV0(join(root, "nowhere")).runtimes).toEqual([]);
		mkdirSync(join(root, "harness"));
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
	});

	it("documents the limit: a harness directory that is itself a dangling link is not found, so no name is listed", () => {
		const root = tempRoot();
		symlinkSync(join(root, "missing"), join(root, "harness"));
		// The operating system reports the same ENOENT as for an absent directory, and there is no attachment to carry a condition.
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
		expect(readEndoCockpitSnapshotV0(root).runtimes).toEqual([]);
	});

	it("does not turn another enumeration failure into an empty list", () => {
		const root = tempRoot();
		mkdirSync(join(root, "harness"), { recursive: true });
		rmSync(join(root, "harness"), { recursive: true });
		writeFileSync(join(root, "harness"), "not a directory");
		expect(() => listEndoCockpitAttachmentsV0(root)).toThrow();
	});
});

describe("discovery and reading are two observations", () => {
	// A listed name is not a promise: the registry reader looks again, and what it finds then is what the runtime reports.
	const changes: { change: string; apply: (root: string, path: string) => void; finds: string }[] = [
		{ change: "removed", apply: (_root, path) => unlinkSync(path), finds: "absent/-" },
		{
			change: "replaced by an empty directory",
			apply: (_root, path) => {
				unlinkSync(path);
				mkdirSync(path);
			},
			finds: "absent/-",
		},
		{
			change: "replaced by a registry",
			apply: (root, path) => {
				unlinkSync(path);
				seedRegistry(root);
			},
			finds: "readable/-",
		},
		{
			change: "replaced by a file",
			apply: (_root, path) => {
				unlinkSync(path);
				writeFileSync(path, "x");
			},
			finds: cond(UNREADABLE),
		},
		{ change: "left dangling", apply: () => {}, finds: cond(DANGLING) },
	];

	for (const { change, apply, finds } of changes) {
		it(`a dangling link listed and then ${change} is reported as the reader then finds it`, () => {
			const { root, harness } = world();
			const path = join(harness, ATTACHMENT);
			symlinkSync(join(root, "missing"), path);
			const listed = listEndoCockpitAttachmentsV0(root);
			expect(listed).toEqual([ATTACHMENT]);
			apply(root, path);
			// The listing made earlier is not replayed as a condition: the read decides.
			expect(shown(readEndoCockpitSnapshotV0(root, { attachments: listed }))).toEqual({ [ATTACHMENT]: finds });
		});
	}

	it("discovery looks again each time: a link that is gone is no longer listed, a directory in its place is", () => {
		const { root, harness } = world();
		const path = join(harness, ATTACHMENT);
		symlinkSync(join(root, "missing"), path);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([ATTACHMENT]);
		unlinkSync(path);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
		mkdirSync(path);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([ATTACHMENT]);
		rmSync(path, { recursive: true });
		writeFileSync(path, "x");
		expect(listEndoCockpitAttachmentsV0(root)).toEqual([]);
	});
});

describe("the default snapshot, read-only, deterministic and unchanged where the filesystem is healthy", () => {
	function mixed() {
		const { root, harness } = world();
		ingestAll(root, lifecycleEvents("killed-and-resumed"));
		seedRegistry(root);
		mkdirSync(join(harness, "empty.default"));
		symlinkSync(join(root, "missing"), join(harness, "a-dangling"));
		symlinkSync(join(harness, "a0"), join(harness, "a0"));
		writeFileSync(join(harness, "plain.file"), "x");
		return { root, harness };
	}

	it("is the same as reading the listed names explicitly, in code-unit order", () => {
		const { root } = mixed();
		const listed = listEndoCockpitAttachmentsV0(root);
		// '-' < '.' < '0' in code units, whatever the entry's kind.
		expect(listed).toEqual(["a-dangling", "a0", "empty.default", "pi.default"]);
		expect(listEndoCockpitAttachmentsV0(root)).toEqual(listed);
		expect(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root))).toBe(
			canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root, { attachments: listed })),
		);
		expect(canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root))).toBe(
			canonicalEndoJsonV0(readEndoCockpitSnapshotV0(root)),
		);
	});

	it("leaves a healthy runtime and the timeline exactly as they are without the unreadable neighbours", () => {
		const clean = tempRoot();
		ingestAll(clean, lifecycleEvents("killed-and-resumed"));
		seedRegistry(clean);
		const { root } = mixed();
		const alone = readEndoCockpitSnapshotV0(clean);
		const among = readEndoCockpitSnapshotV0(root);
		expect(alone.runtimes.map((r) => r.identity.source.attachment)).toEqual(["pi.default"]);
		expect(among.timeline).toEqual(alone.timeline);
		expect(among.runtimes.find((r) => r.identity.source.attachment === "pi.default")).toEqual(alone.runtimes[0]);
		expect(shown(among)).toEqual({
			"a-dangling": cond(DANGLING),
			a0: cond(UNREADABLE),
			"empty.default": "absent/-",
			"pi.default": "readable/-",
		});
		expect(validateEndoCockpitSnapshotV0(among)).not.toBeNull();
	});

	it("changes nothing: no file, directory or link is created, repaired, followed into or removed", () => {
		const { root, harness } = mixed();
		const before = linkTree(root);
		const target = readlinkSync(join(harness, "a-dangling"));
		listEndoCockpitAttachmentsV0(root);
		readEndoCockpitSnapshotV0(root);
		readEndoCockpitRegistryV0(root, "a-dangling");
		expect(linkTree(root)).toBe(before);
		expect(readlinkSync(join(harness, "a-dangling"))).toBe(target);
		expect(lstatSync(join(harness, "a-dangling")).isSymbolicLink()).toBe(true);
		expect(() => lstatSync(target)).toThrow(); // the link's target was never created
		// A tree without links is hashed by the repository's own helper too, and is likewise untouched.
		const healthy = tempRoot();
		seedRegistry(healthy);
		const healthyBefore = treeHash(healthy);
		readEndoCockpitSnapshotV0(healthy);
		expect(treeHash(healthy)).toBe(healthyBefore);
	});

	it("discloses no path, link target or system error text", () => {
		const { root, harness } = world();
		const target = join(root, CANARY, "deeper");
		symlinkSync(target, join(harness, "gone.default"));
		symlinkSync(join(harness, "loop.b"), join(harness, "loop.a"));
		symlinkSync(join(harness, "loop.a"), join(harness, "loop.b"));
		const text = JSON.stringify(readEndoCockpitSnapshotV0(root));
		for (const secret of [root, CANARY, target, "ENOENT", "ELOOP", "EACCES", "no such file", "errno", "syscall"])
			expect(text, secret).not.toContain(secret);
		expect(text).toContain(ENDO_COCKPIT_SOURCE_ERRORS_V0["path-dangling-symlink"]);
		expect(text).toContain(ENDO_COCKPIT_SOURCE_ERRORS_V0["path-unreadable"]);
	});
});
