// The Pi attachment service: attach Endophasia to a Pi the user installed and manages.
//
//   identify()     resolve and fingerprint the selected Pi; compare with the last observation of this attachment;
//                  record the fingerprint, the change and (when something changed) a neutral notification.
//   checkLocal()   the automatic local protocol checks and, for a tested version, the static-surface
//                  classification; skipped when current evidence already covers them (evidence.ts rules).
//   studyLive()    the live study; refuses without explicit authorization.
//   state()        the capability state current evidence supports; recorded on every derivation.
//   openSession()  run Pi in RPC mode on a persistent session and record what it does into the event store:
//                  durable entries by catch-up from the last recorded opaque cursor (deduplicated by entry id), live
//                  events as observations of one process, process exits and reconnects explicitly. Controls are
//                  offered only for capabilities the current evidence admits.
//
// It never installs, updates, downgrades, patches or rebuilds Pi, and never edits Pi's configuration.

import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EndoEventV0 } from "../../protocol/event.ts";
import type {
	EndoCapabilityEvidenceV0,
	EndoCapabilityStateV0,
	EndoHarnessChangeV0,
	EndoHarnessFingerprintV0,
	EndoHarnessNotificationV0,
} from "../../protocol/harness.ts";
import type { JsonValueV0 } from "../../protocol/primitives.ts";
import { canonicalEndoJsonV0, sha256HexV0 } from "../../runtime/contracts/canonical-json.ts";
import { createEndoArtifactStoreV0 } from "../../storage/artifacts.ts";
import { createEndoDurableEventStoreV0, type EndoDurableEventStoreV0 } from "../../storage/event-store.ts";
import { type EndoHarnessRegistryV0, openEndoHarnessRegistryV0 } from "../../storage/harness-registry.ts";
import type { RpcDiagnosticV0, RpcEventV0, RpcExitV0 } from "../rpc-jsonl/rpc-connection.ts";
import { piCapabilityV0 } from "./capabilities.ts";
import {
	PI_CHECK_DEFINITIONS_V0,
	PI_SURFACE_REVIEWED_VERSIONS,
	type PiCheckRunV0,
	piStaticSurfaceV0,
	runPiLiveStudyV0,
	runPiLocalChecksV0,
} from "./checks.ts";
import { piProjectConfigurationDigestV0, piUserConfigurationDigestV0 } from "./configuration.ts";
import {
	derivePiCapabilityStateV0,
	piChangeV0,
	piConfigurationDigestV0,
	piDependenciesV0,
	piEvidenceV0,
	piNotificationV0,
} from "./evidence.ts";
import { fingerprintPiRuntimeV0, PiFingerprintErrorV0, piIdentityEnvironmentV0 } from "./identity.ts";
import {
	mapAttachmentEventV0,
	mapPiEntryV0,
	mapPiLiveEventV0,
	type PiMappingContextV0,
	piEntryEventIdV0,
} from "./mapping.ts";
import { PiRpcClientV0, PiRpcProtocolErrorV0, PiRpcRefusalV0, type PiSessionEntryV0 } from "./rpc.ts";

export interface PiAttachmentOptionsV0 {
	/** The Endophasia store root (event store, artifacts, harness registry). */
	readonly root: string;
	/** The configured attachment identity. Default `pi.default`. */
	readonly attachment?: string;
	/** An explicit Pi executable; otherwise `command` (default "pi") is searched on `path` (default PATH). */
	readonly executable?: string;
	readonly command?: string;
	readonly path?: string;
	/** Where Pi runs for the operator's session, and where a relative executable resolves. Default: process.cwd(). */
	readonly cwd?: string;
	/** Pi's environment for the operator's session and the live study. Default: a copy of this process's environment. */
	readonly env?: Readonly<Record<string, string>>;
	readonly provider?: string;
	readonly model?: string;
	readonly tools?: "default" | "none" | readonly string[];
	/** Where the attachment's persistent Pi session is stored. Default: `<root>/pi-sessions/<attachment>`. */
	readonly sessionDir?: string;
	readonly now?: () => Date;
	readonly requestTimeoutMs?: number;
}

export interface PiIdentificationV0 {
	readonly fingerprint: EndoHarnessFingerprintV0 | null;
	readonly change: EndoHarnessChangeV0;
	readonly notification: EndoHarnessNotificationV0 | null;
}

/** The copy of this process's environment Pi gets by default: string values only. */
export function piSessionEnvironmentV0(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	return env;
}

/** Thrown when a control is requested for a capability the current evidence does not admit. */
export class PiCapabilityNotAdmittedErrorV0 extends Error {
	readonly capability: string;
	constructor(capability: string, reason: string) {
		super(`${capability} is not admitted: ${reason}`);
		this.name = "PiCapabilityNotAdmittedErrorV0";
		this.capability = capability;
	}
}

export class PiAttachmentV0 {
	readonly options: PiAttachmentOptionsV0;
	readonly attachment: string;
	readonly registry: EndoHarnessRegistryV0;
	#fingerprint: EndoHarnessFingerprintV0 | null = null;
	#identified = false;

	constructor(options: PiAttachmentOptionsV0) {
		this.options = options;
		this.attachment = options.attachment ?? "pi.default";
		this.registry = openEndoHarnessRegistryV0(options.root, this.attachment);
	}

	#now(): string {
		return (this.options.now ?? (() => new Date()))().toISOString();
	}

	#env(): Readonly<Record<string, string>> {
		return this.options.env ?? piSessionEnvironmentV0();
	}

	/** The fingerprint taken by identify() in this process, or null (not yet identified, or collection failed). */
	get fingerprint(): EndoHarnessFingerprintV0 | null {
		return this.#fingerprint;
	}

	/** Take one fingerprint of the selected Pi without recording it. Throws when nothing identifies the runtime. */
	#takeFingerprint(): Promise<EndoHarnessFingerprintV0> {
		return fingerprintPiRuntimeV0({
			attachment: this.attachment,
			...(this.options.executable === undefined ? {} : { executable: this.options.executable }),
			...(this.options.command === undefined ? {} : { command: this.options.command }),
			...(this.options.path === undefined ? {} : { path: this.options.path }),
			...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
			env: { ...piIdentityEnvironmentV0(), PATH: this.#env().PATH ?? process.env.PATH ?? "" },
			...(this.options.now === undefined ? {} : { now: this.options.now }),
		});
	}

	/** Fingerprint the selected Pi, compare with the last observation, and record the result. Never throws on failure. */
	async identify(): Promise<PiIdentificationV0> {
		const previous = this.registry.last("fingerprint");
		let current: EndoHarnessFingerprintV0 | null = null;
		let failure: string | undefined;
		try {
			current = await this.#takeFingerprint();
		} catch (error) {
			failure =
				error instanceof PiFingerprintErrorV0 ? error.message : `fingerprint collection failed: ${String(error)}`;
		}
		const change = piChangeV0({
			attachment: this.attachment,
			previous,
			current,
			...(failure === undefined ? {} : { failure }),
			at: current?.observedAt ?? this.#now(),
		});
		// Every observation is its own fingerprint record, unchanged or not: evidence recorded under a reduced identity
		// applies only to the observation it was recorded against, so observations must stay distinguishable.
		if (current !== null && !this.registry.has(current.id)) this.registry.append("fingerprint", current);
		if (!this.registry.has(change.id)) this.registry.append("change", change);
		const notification = piNotificationV0(change);
		if (notification !== null && !this.registry.has(notification.id))
			this.registry.append("notification", notification);
		this.#fingerprint = current;
		this.#identified = true;
		return { fingerprint: current, change, notification };
	}

	/**
	 * The current configuration digest per check kind. Every kind includes Pi's behaviour-relevant user configuration
	 * under the environment Pi runs with; the live study adds provider and model and the fixed tool set it uses.
	 */
	#configurationDigest = (kind: "static-surface" | "local-protocol" | "live-study"): string =>
		piConfigurationDigestV0(kind, {
			piConfiguration: piUserConfigurationDigestV0(this.#env()),
			...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
			...(this.options.model === undefined ? {} : { model: this.options.model }),
			tools: ["read"],
		});

	/** The path Pi is launched by: the real path the fingerprint hashed when it is executable, else the resolved path. */
	launchPath(fingerprint: EndoHarnessFingerprintV0): string {
		const real = fingerprint.local.realPath;
		if (real !== null) {
			try {
				accessSync(real, constants.X_OK);
				return real;
			} catch {
				// A non-executable real path (e.g. a script run through its symlinked launcher) falls back below.
			}
		}
		return fingerprint.local.resolvedPath ?? fingerprint.local.requested;
	}

	/**
	 * Re-fingerprint after a check and compare with the fingerprint the check ran against. When the runtime changed
	 * while the check ran, the check's results describe an unknown mix of two runtimes: nothing is recorded, and the
	 * change itself is identified and recorded instead. Returns whether the runtime is still the one checked.
	 */
	async #stillSame(fingerprint: EndoHarnessFingerprintV0): Promise<boolean> {
		let after: EndoHarnessFingerprintV0 | null = null;
		try {
			after = await this.#takeFingerprint();
		} catch {
			after = null;
		}
		if (after !== null && after.identity.digest === fingerprint.identity.digest) return true;
		await this.identify();
		return false;
	}

	/** The capability state current evidence supports. Recorded in the registry. */
	state(): EndoCapabilityStateV0 {
		if (!this.#identified) throw new TypeError("identify() must run before the capability state is derived");
		const state = derivePiCapabilityStateV0({
			attachment: this.attachment,
			at: this.#now(),
			fingerprint: this.#fingerprint,
			evidence: this.registry.list("evidence"),
			definitions: PI_CHECK_DEFINITIONS_V0,
			configurationDigest: this.#configurationDigest,
		});
		this.registry.append("state", state);
		return state;
	}

	#record(run: PiCheckRunV0, fingerprint: EndoHarnessFingerprintV0): EndoCapabilityEvidenceV0[] {
		const artifacts = createEndoArtifactStoreV0(this.options.root);
		const bytes = new TextEncoder().encode(
			// One compact record per line (JSON Lines); keys in canonical order, so equal transcripts hash equally.
			`${run.transcript.map((record) => JSON.stringify(JSON.parse(canonicalEndoJsonV0(JSON.parse(JSON.stringify(record)))))).join("\n")}\n`,
		);
		const digest = sha256HexV0(bytes);
		artifacts.put(digest, bytes);
		const recorded: EndoCapabilityEvidenceV0[] = [];
		for (const result of run.results) {
			if (result.classification === "inconclusive") continue;
			const evidence = piEvidenceV0({
				attachment: this.attachment,
				capability: result.capability,
				definition: run.definition,
				dependencies: piDependenciesV0(fingerprint, this.#configurationDigest(run.definition.kind)),
				inputs: run.inputs,
				expected: result.expected,
				observed: result.observed,
				classification: result.classification,
				evidence: [digest],
				limitations: [...result.limitations],
				at: this.#now(),
			});
			if (!this.registry.has(evidence.id)) this.registry.append("evidence", evidence);
			recorded.push(evidence);
		}
		return recorded;
	}

	/**
	 * Run the automatic checks that current evidence does not already cover: the static-surface classification (only
	 * for a tested version) and the local protocol checks. Returns the recorded evidence and the resulting state.
	 */
	async checkLocal(options: { force?: boolean } = {}): Promise<{
		ran: boolean;
		/** False when the runtime changed while the checks ran: their results were discarded. */
		recorded: boolean;
		evidence: EndoCapabilityEvidenceV0[];
		state: EndoCapabilityStateV0;
	}> {
		if (!this.#identified) await this.identify();
		const fingerprint = this.#fingerprint;
		if (fingerprint === null) return { ran: false, recorded: false, evidence: [], state: this.state() };
		const before = this.state();
		const needs = (kind: string) =>
			before.capabilities.some((entry) => entry.status === "unverified" && entry.requires === kind);
		const runs: PiCheckRunV0[] = [];
		// The documented-surface review is evidence about one release's documentation: it applies only to a reviewed
		// release. Other releases establish the same capabilities from the live study's observations.
		const reviewed =
			fingerprint.reported.version !== null && PI_SURFACE_REVIEWED_VERSIONS.includes(fingerprint.reported.version);
		if ((options.force === true || needs("static-surface")) && reviewed) runs.push(piStaticSurfaceV0());
		if (options.force === true || needs("local-protocol")) {
			runs.push(
				...(await runPiLocalChecksV0({
					executable: this.launchPath(fingerprint),
					env: { ...this.#env(), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
					...(this.options.requestTimeoutMs === undefined
						? {}
						: { requestTimeoutMs: this.options.requestTimeoutMs }),
				})),
			);
		}
		if (runs.length === 0) return { ran: false, recorded: false, evidence: [], state: this.state() };
		if (!(await this.#stillSame(fingerprint))) {
			return { ran: true, recorded: false, evidence: [], state: this.state() };
		}
		const evidence = runs.flatMap((run) => this.#record(run, fingerprint));
		return { ran: true, recorded: true, evidence, state: this.state() };
	}

	/** Run the live study. `authorized` must be exactly true: it runs agent work and may cost provider usage. */
	async studyLive(options: { authorized: true; stepTimeoutMs?: number }): Promise<{
		/** False when the runtime changed while the study ran: its results were discarded. */
		recorded: boolean;
		evidence: EndoCapabilityEvidenceV0[];
		inconclusive: string[];
		state: EndoCapabilityStateV0;
	}> {
		if (options?.authorized !== true) throw new TypeError("the Pi live study needs explicit operator authorization");
		if (!this.#identified) await this.identify();
		const fingerprint = this.#fingerprint;
		if (fingerprint === null) throw new TypeError("the live study needs an identified Pi runtime");
		const run = await runPiLiveStudyV0({
			authorized: true,
			executable: this.launchPath(fingerprint),
			env: this.#env(),
			...(this.options.provider === undefined ? {} : { provider: this.options.provider }),
			...(this.options.model === undefined ? {} : { model: this.options.model }),
			...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
		});
		const inconclusive = run.results
			.filter((result) => result.classification === "inconclusive")
			.map((result) => `${result.capability}: ${result.observed}`);
		if (!(await this.#stillSame(fingerprint))) {
			return { recorded: false, evidence: [], inconclusive, state: this.state() };
		}
		const evidence = this.#record(run, fingerprint);
		return { recorded: true, evidence, inconclusive, state: this.state() };
	}

	/** Open the operator's persistent Pi session and record it. identify() runs first when it has not. */
	async openSession(): Promise<PiSessionAttachmentV0> {
		if (!this.#identified) await this.identify();
		const fingerprint = this.#fingerprint;
		if (fingerprint === null) throw new TypeError("the Pi runtime could not be identified; no session is opened");
		const session = new PiSessionAttachmentV0(this, fingerprint, this.state());
		await session.connect();
		return session;
	}

	/** @internal */
	sessionConfig(): { sessionDir: string; sessionId: string } {
		const directory = join(this.options.root, "harness", this.attachment);
		const file = join(directory, "pi-session.json");
		if (existsSync(file)) {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { sessionDir?: unknown; sessionId?: unknown };
			if (typeof parsed.sessionDir === "string" && typeof parsed.sessionId === "string") {
				return { sessionDir: parsed.sessionDir, sessionId: parsed.sessionId };
			}
			throw new TypeError(`${file} is not a valid Pi session configuration`);
		}
		const config = {
			sessionDir: this.options.sessionDir ?? join(this.options.root, "pi-sessions", this.attachment),
			sessionId: `endo-${this.attachment.replace(/[^A-Za-z0-9]/g, "-")}-${randomBytes(6).toString("hex")}`,
		};
		mkdirSync(directory, { recursive: true });
		writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
		renameSync(`${file}.tmp`, file);
		return config;
	}

	/** @internal */
	launchEnv(): Readonly<Record<string, string>> {
		return this.#env();
	}

	/** @internal Re-identify for a reconnect: the recorded identification and the capability state it supports. */
	async reidentify(): Promise<{ fingerprint: EndoHarnessFingerprintV0 | null; state: EndoCapabilityStateV0 }> {
		const { fingerprint } = await this.identify();
		return { fingerprint, state: this.state() };
	}
}

/** What the session attachment has done so far; for the CLI and tests. */
export interface PiSessionCountersV0 {
	ingested: number;
	duplicatesSkipped: number;
	deltasDropped: number;
	protocolFaults: number;
	reconnects: number;
}

/** Thrown when another live session attachment already writes the same store root. */
export class PiStoreLockedErrorV0 extends Error {
	constructor(path: string, holder: string) {
		super(`another Endophasia session attachment (${holder}) is writing this store; lock ${path}`);
		this.name = "PiStoreLockedErrorV0";
	}
}

/**
 * Take the store root's writer lock: one session attachment per root at a time, so two writers cannot each extend the
 * event log from a different in-memory view. A lock left by a process that no longer exists is replaced.
 */
function acquireWriterLock(root: string, attachment: string): () => void {
	const path = join(root, "events", "session-attachment.lock");
	mkdirSync(join(root, "events"), { recursive: true });
	const content = `${JSON.stringify({ pid: process.pid, attachment, at: new Date().toISOString() })}\n`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			writeFileSync(path, content, { flag: "wx" });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				rmSync(path, { force: true });
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let holder: { pid?: unknown; attachment?: unknown } = {};
			try {
				holder = JSON.parse(readFileSync(path, "utf8")) as typeof holder;
			} catch {
				// An unreadable lock is treated as held: never silently stolen.
				throw new PiStoreLockedErrorV0(path, "unreadable lock");
			}
			const pid = typeof holder.pid === "number" ? holder.pid : undefined;
			let alive = pid === process.pid;
			if (pid !== undefined && !alive) {
				try {
					process.kill(pid, 0);
					alive = true;
				} catch (probe) {
					alive = (probe as NodeJS.ErrnoException).code === "EPERM";
				}
			}
			if (alive || pid === undefined) {
				throw new PiStoreLockedErrorV0(path, `pid ${String(pid)}, ${String(holder.attachment)}`);
			}
			rmSync(path, { force: true });
		}
	}
	throw new PiStoreLockedErrorV0(path, "lock contention");
}

/** One recorded Pi session: a persistent Pi session id that survives process restarts. */
export class PiSessionAttachmentV0 {
	readonly owner: PiAttachmentV0;
	readonly store: EndoDurableEventStoreV0;
	#fingerprint: EndoHarnessFingerprintV0;
	#capabilityState: EndoCapabilityStateV0;
	readonly #releaseLock: () => void;
	readonly counters: PiSessionCountersV0 = {
		ingested: 0,
		duplicatesSkipped: 0,
		deltasDropped: 0,
		protocolFaults: 0,
		reconnects: 0,
	};
	readonly #producer: string;
	readonly #seen = new Set<string>();
	/** Per Pi session id: the last recorded entry id (the catch-up cursor) and the last recorded leaf id. */
	readonly #cursor = new Map<string, string>();
	readonly #leaf = new Map<string, string | null>();
	#sequence = 0;
	#client: PiRpcClientV0 | null = null;
	#context: PiMappingContextV0 | null = null;
	#piSessionId: string | null = null;
	#work: Promise<void> = Promise.resolve();
	#closed = false;
	#storeClosed = false;
	#lastExit: RpcExitV0 | null = null;
	readonly #exitWaiters = new Set<() => void>();

	constructor(owner: PiAttachmentV0, fingerprint: EndoHarnessFingerprintV0, state: EndoCapabilityStateV0) {
		this.owner = owner;
		this.#fingerprint = fingerprint;
		this.#capabilityState = state;
		this.#releaseLock = acquireWriterLock(owner.options.root, owner.attachment);
		try {
			this.store = createEndoDurableEventStoreV0(owner.options.root);
		} catch (error) {
			this.#releaseLock();
			throw error;
		}
		this.#producer = `pi-rpc-adapter:${owner.attachment}`;
		// Rebuild the dedupe set, the cursors and the producer sequence from what the store already holds.
		let after = 0;
		for (;;) {
			const page = this.store.page({ afterSequence: after, limit: 10_000 });
			for (const event of page.events) this.#index(event);
			if (page.events.length === 0) break;
			after = page.nextAfterSequence;
		}
	}

	#index(event: EndoEventV0): void {
		this.#seen.add(event.id);
		if (event.producer === this.#producer) this.#sequence = Math.max(this.#sequence, event.sequence);
		const payload = event.payload as Record<string, unknown>;
		const source = payload?.source as { sessionId?: unknown; entryId?: unknown } | undefined;
		if (
			event.kind === "session.entry-observed" &&
			typeof source?.sessionId === "string" &&
			typeof source.entryId === "string"
		) {
			this.#cursor.set(source.sessionId, source.entryId);
		}
		if (event.kind === "session.leaf-observed" && typeof payload.piSessionId === "string") {
			this.#leaf.set(payload.piSessionId, typeof payload.leafId === "string" ? payload.leafId : null);
		}
	}

	get piSessionId(): string | null {
		return this.#piSessionId;
	}

	/** The fingerprint of the runtime the current (or last) process was launched from. */
	get fingerprint(): EndoHarnessFingerprintV0 {
		return this.#fingerprint;
	}

	/** The capability state controls are gated on; re-derived whenever the runtime is re-identified. */
	get capabilityState(): EndoCapabilityStateV0 {
		return this.#capabilityState;
	}

	/** The current Pi process id, while one runs. */
	get pid(): number | undefined {
		return this.#client?.connection.pid;
	}

	/** The connection state of the current process, or "disconnected". */
	get connection(): string {
		return this.#client === null ? "disconnected" : this.#client.connection.state;
	}

	#ingest(event: EndoEventV0): void {
		if (this.#storeClosed) return;
		if (this.#seen.has(event.id)) {
			this.counters.duplicatesSkipped += 1;
			return;
		}
		const stored = this.store.ingest(event);
		this.#index(stored);
		this.counters.ingested += 1;
	}

	#attachmentEvent(kind: string, payload: Record<string, JsonValueV0>): void {
		if (this.#context === null || this.#storeClosed) return;
		this.#ingest(mapAttachmentEventV0(this.#context, kind, payload));
	}

	/** Start (or restart) Pi on the attachment's persistent session and catch up. */
	async connect(): Promise<void> {
		if (this.#closed) throw new TypeError("the session attachment is closed");
		if (this.#client !== null && this.#client.connection.state === "running") return;
		const { sessionDir, sessionId } = this.owner.sessionConfig();
		mkdirSync(sessionDir, { recursive: true });
		const options = this.owner.options;
		// Events and diagnostics are accepted only from the process this attachment currently owns: a superseded
		// process may still flush buffered records after a reconnect, and those belong to no current instance.
		let owned: PiRpcClientV0 | null = null;
		const client = new PiRpcClientV0({
			executable: this.owner.launchPath(this.#fingerprint),
			cwd: options.cwd ?? process.cwd(),
			env: this.owner.launchEnv(),
			session: { kind: "persistent", sessionDir, sessionId },
			...(options.provider === undefined ? {} : { provider: options.provider }),
			...(options.model === undefined ? {} : { model: options.model }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
			onDiagnostic: (diagnostic) => {
				if (owned !== null && this.#client === owned) this.#diagnostic(diagnostic);
			},
		});
		owned = client;
		const instance = randomBytes(8).toString("hex");
		let live = 0;
		const self = this;
		const context: PiMappingContextV0 = {
			attachment: this.owner.attachment,
			get piSessionId() {
				return self.#piSessionId;
			},
			instance,
			producer: this.#producer,
			nextSequence: () => {
				this.#sequence += 1;
				return this.#sequence;
			},
			nextLive: () => {
				live += 1;
				return live;
			},
			now: () => (options.now ?? (() => new Date()))().toISOString(),
		};
		this.#client = client;
		this.#context = context;
		client.subscribe((event) => {
			if (this.#client === client) this.#onEvent(event);
		});
		void client.connection.exited.then((exit) => this.#onExit(client, exit));
		let state: Awaited<ReturnType<PiRpcClientV0["getState"]>>;
		try {
			state = await client.getState();
		} catch (error) {
			await client.close();
			this.#client = null;
			throw error;
		}
		this.#piSessionId = state.sessionId;
		this.#attachmentEvent("harness.attached", {
			fingerprintId: this.#fingerprint.id,
			identityDigest: this.#fingerprint.identity.digest,
			version: this.#fingerprint.reported.version,
			// Evidence never covers project configuration (checks run in scratch directories); it is recorded here.
			userConfigurationDigest: piUserConfigurationDigestV0(this.owner.launchEnv()),
			projectConfigurationDigest: piProjectConfigurationDigestV0(options.cwd ?? process.cwd()),
			instance,
			piSessionId: state.sessionId,
			requestedSessionId: sessionId,
			args: [...client.args],
		});
		if (state.sessionId !== sessionId) {
			this.#attachmentEvent("harness.session-mismatch", {
				requestedSessionId: sessionId,
				piSessionId: state.sessionId,
			});
		}
		await this.catchUp();
	}

	/**
	 * Restart Pi after its process ended, then catch up from the last recorded cursor. The runtime is identified again
	 * first: if it changed while disconnected, the change is recorded, the capability state is re-derived (so controls
	 * admitted for the old runtime are not offered for the new one), and observation continues on the new runtime. An
	 * unidentifiable runtime is not launched.
	 */
	async reconnect(): Promise<void> {
		if (this.#client !== null && this.#client.connection.state === "running") return;
		this.counters.reconnects += 1;
		this.#client = null;
		const { fingerprint, state } = await this.owner.reidentify();
		if (fingerprint === null) {
			this.#capabilityState = state;
			throw new TypeError("the Pi runtime could not be identified; not reconnecting");
		}
		if (fingerprint.identity.digest !== this.#fingerprint.identity.digest) {
			this.#attachmentEvent("harness.runtime-changed", {
				previousFingerprintId: this.#fingerprint.id,
				currentFingerprintId: fingerprint.id,
				previousVersion: this.#fingerprint.reported.version,
				currentVersion: fingerprint.reported.version,
			});
		}
		this.#fingerprint = fingerprint;
		this.#capabilityState = state;
		await this.connect();
	}

	/** Resolves when the current Pi process has exited (immediately if it already has). */
	exited(): Promise<RpcExitV0 | null> {
		if (
			this.#client === null ||
			this.#client.connection.state === "exited" ||
			this.#client.connection.state === "terminated"
		)
			return Promise.resolve(this.#lastExit);
		return new Promise((resolve) => this.#exitWaiters.add(() => resolve(this.#lastExit)));
	}

	#onExit(client: PiRpcClientV0, exit: RpcExitV0): void {
		if (this.#client !== client) return;
		this.#lastExit = exit;
		this.#attachmentEvent("harness.process-exited", {
			code: exit.code,
			signal: exit.signal,
			spawnFailed: exit.spawnFailed,
			expected: this.#closed,
		});
		this.#client = null;
		for (const resolve of [...this.#exitWaiters]) resolve();
		this.#exitWaiters.clear();
	}

	#diagnostic(diagnostic: RpcDiagnosticV0): void {
		if (diagnostic.kind !== "protocol-fault") return;
		this.counters.protocolFaults += 1;
		this.#attachmentEvent("harness.protocol-fault", { fault: diagnostic.fault });
	}

	#onEvent(event: RpcEventV0): void {
		const context = this.#context;
		if (context === null) return;
		if (event.type === "extension_ui_request") this.#answerDialog(event);
		const mapped = mapPiLiveEventV0(context, event.type, event.record);
		if (mapped.kind === "delta") {
			this.counters.deltasDropped += 1;
			return;
		}
		if (mapped.kind === "entry") {
			if (this.#piSessionId !== null) this.#ingestEntries([mapped.entry]);
			return;
		}
		this.#ingest(mapped.event);
		// Durable entries are written by Pi as a run proceeds; they are read back at run and compaction boundaries.
		if (event.type === "agent_settled" || event.type === "turn_end" || event.type === "compaction_end") {
			void this.catchUp().catch(() => {});
		}
	}

	/** Pi blocks on select/confirm/input/editor dialogs until answered; with no operator UI they are cancelled. */
	#answerDialog(event: RpcEventV0): void {
		const { id, method } = event.record;
		if (typeof id !== "string" || !["select", "confirm", "input", "editor"].includes(String(method))) return;
		void this.#client?.connection.answerExtensionUi(id, { cancelled: true }).then(
			() => this.#attachmentEvent("extension.dialog-cancelled", { method: String(method) }),
			() => {},
		);
	}

	#ingestEntries(entries: readonly PiSessionEntryV0[]): number {
		const context = this.#context;
		if (context === null || this.#piSessionId === null) return 0;
		let added = 0;
		for (const entry of entries) {
			if (this.#seen.has(piEntryEventIdV0(this.#piSessionId, entry.id))) {
				this.counters.duplicatesSkipped += 1;
				continue;
			}
			this.#ingest(mapPiEntryV0(context, entry));
			added += 1;
		}
		return added;
	}

	/**
	 * Read the entries after the last recorded cursor and record them. An unknown cursor (Pi refuses it: the session
	 * file was replaced or rewritten) falls back to a full read, deduplicated by entry id. Serialized.
	 */
	catchUp(): Promise<void> {
		const run = async (): Promise<void> => {
			const client = this.#client;
			const piSessionId = this.#piSessionId;
			if (client === null || piSessionId === null || client.connection.state !== "running") return;
			const cursor = this.#cursor.get(piSessionId);
			let mode: "full" | "since" | "full-after-refusal" = cursor === undefined ? "full" : "since";
			let page: Awaited<ReturnType<PiRpcClientV0["getEntries"]>>;
			try {
				page = await client.getEntries(cursor);
			} catch (error) {
				if (error instanceof PiRpcRefusalV0 && cursor !== undefined) {
					mode = "full-after-refusal";
					page = await client.getEntries();
				} else if (error instanceof PiRpcProtocolErrorV0) {
					this.counters.protocolFaults += 1;
					this.#attachmentEvent("harness.protocol-fault", { fault: "malformed-entries" });
					return;
				} else throw error;
			}
			const added = this.#ingestEntries(page.entries);
			if (mode !== "since" || added > 0) {
				this.#attachmentEvent("harness.catch-up", {
					mode,
					piSessionId,
					received: page.entries.length,
					added,
				});
			}
			if (this.#leaf.get(piSessionId) !== page.leafId) {
				this.#attachmentEvent("session.leaf-observed", { piSessionId, leafId: page.leafId });
			}
		};
		const next = this.#work.then(run, run);
		this.#work = next.catch(() => {});
		return next;
	}

	#admit(capability: string): void {
		const entry = this.#capabilityState.capabilities.find((candidate) => candidate.capability === capability);
		if (entry === undefined || (entry.status !== "admitted" && entry.status !== "admitted-partial")) {
			throw new PiCapabilityNotAdmittedErrorV0(capability, entry?.reason ?? "unknown capability");
		}
		if (!piCapabilityV0(capability).control) throw new PiCapabilityNotAdmittedErrorV0(capability, "not a control");
	}

	async #control<T>(capability: string, action: string, run: (client: PiRpcClientV0) => Promise<T>): Promise<T> {
		this.#admit(capability);
		const client = this.#client;
		if (client === null) throw new TypeError("Pi is not running; reconnect first");
		this.#attachmentEvent("control.requested", { capability, action });
		try {
			const value = await run(client);
			// Acceptance only: whatever effect follows is recorded from Pi's later events and entries, not inferred here.
			this.#attachmentEvent("control.accepted", {
				capability,
				action,
				...(typeof value === "string" ? { disposition: value } : {}),
			});
			return value;
		} catch (error) {
			this.#attachmentEvent("control.refused", {
				capability,
				action,
				reason: error instanceof PiRpcRefusalV0 ? "refused" : "failed",
			});
			throw error;
		}
	}

	/** Send a prompt. This starts agent work; it is the operator's explicit action, not a capability check. */
	async prompt(message: string): Promise<string> {
		const client = this.#client;
		if (client === null) throw new TypeError("Pi is not running; reconnect first");
		this.#attachmentEvent("control.requested", { capability: "session.prompt", action: "prompt" });
		const disposition = await client.prompt(message);
		this.#attachmentEvent("control.accepted", { capability: "session.prompt", action: "prompt", disposition });
		return disposition;
	}

	steer(message: string): Promise<string> {
		return this.#control("steering.steer", "steer", (client) => client.steer(message));
	}

	followUp(message: string): Promise<string> {
		return this.#control("steering.follow-up", "follow_up", (client) => client.followUp(message));
	}

	/** Untargeted: Pi aborts whatever is current (steering.stop is at most PARTIAL for this reason). */
	stop(): Promise<void> {
		return this.#control("steering.stop", "abort", (client) => client.abort());
	}

	setModel(provider: string, modelId: string) {
		return this.#control("control.model", "set_model", (client) => client.setModel(provider, modelId));
	}

	setThinkingLevel(level: string): Promise<void> {
		return this.#control("control.thinking", "set_thinking_level", (client) => client.setThinkingLevel(level));
	}

	/** Wait until Pi reports agent_settled (or the timeout), then catch up. */
	async waitForSettled(timeoutMs: number): Promise<boolean> {
		const client = this.#client;
		if (client === null) return false;
		const settled = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				stop();
				resolve(false);
			}, timeoutMs);
			const stop = client.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				clearTimeout(timer);
				stop();
				resolve(true);
			});
		});
		await this.catchUp();
		return settled;
	}

	/** Catch up once more, end Pi's input (orderly shutdown) and close the store. */
	async close(): Promise<void> {
		if (this.#closed) return;
		try {
			await this.catchUp();
		} catch {
			// A failing final read is recorded by the exit event; closing proceeds.
		}
		this.#closed = true;
		const client = this.#client;
		if (client !== null) {
			await client.close();
			await this.#work;
		}
		this.#storeClosed = true;
		this.store.close();
		this.#releaseLock();
	}
}
