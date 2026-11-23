// The OpenClaw tool plugin definition, written against OpenClaw 2026.10.5's `defineToolPlugin` (openclaw/plugin-sdk/tool-plugin).
// The SDK is passed in rather than imported so the definition can be exercised against a mocked OpenClaw boundary in this repository's
// tests; src/index.ts binds the real one. One tool, `endophasia_status`: read-only, one optional parameter (a permitted project),
// no shell, no path, no flag, no write. It never gains Endophasia's terminal-control authority: it cannot reach the control socket, the
// workbench or any attempt command, because the only command it can run is `endo coordinator status`.

import {
	type EndophasiaRunV0,
	EndophasiaStatusConfigErrorV0,
	externalEndophasiaStatusV0,
	readEndophasiaStatusV0,
	redactEndophasiaStatusV0,
	selectEndophasiaProjectsV0,
	summariseEndophasiaStatusV0,
	validateEndophasiaStatusConfigV0,
} from "./status-reader.ts";

export const ENDOPHASIA_STATUS_PLUGIN_ID = "endophasia-status";
export const ENDOPHASIA_STATUS_TOOL_NAME = "endophasia_status";

/** The slice of TypeBox's `Type` builder this plugin uses. */
export interface TypeBuilderV0 {
	Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
	Optional(schema: unknown): unknown;
	String(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Integer(options?: Record<string, unknown>): unknown;
	Array(items: unknown, options?: Record<string, unknown>): unknown;
}

/** The slice of `defineToolPlugin` this plugin uses: identity, config schema, and a static tool list. */
export type DefineToolPluginV0 = (definition: {
	id: string;
	name: string;
	description: string;
	configSchema: unknown;
	tools: (tool: (definition: ToolDefinitionV0) => unknown) => unknown[];
}) => unknown;

export interface ToolDefinitionV0 {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	/** Optional tools are sent to a model only after the operator allowlists them explicitly. */
	optional: boolean;
	execute: (params: { project?: string }, config: unknown, context: { signal?: AbortSignal }) => Promise<unknown>;
}

const DESCRIPTION =
	"Read-only status of the operator's Endophasia projects: tasks by the operator's own status (in progress, awaiting review, completed, open, blocked), each task's latest controller-observed verification and unresolved evidence gaps, agent sessions as active or last-observed with agent-reported vs controller-observed activity, explicit vs unknown session/task relationships, and the freshness of every part. Use it for questions like \"what's happening with Endophasia, what needs my attention, which agent sessions are active?\". It cannot change anything: it never moves a task, prompts or launches an agent, or approves anything. Relay its qualifications (stale, unknown, unverified, unavailable) rather than smoothing them over.";

export function endophasiaToolExecuteV0(run?: EndophasiaRunV0) {
	return async (params: { project?: string }, rawConfig: unknown, context: { signal?: AbortSignal }) => {
		let config: ReturnType<typeof validateEndophasiaStatusConfigV0>;
		try {
			config = validateEndophasiaStatusConfigV0(rawConfig);
		} catch (error) {
			if (!(error instanceof EndophasiaStatusConfigErrorV0)) throw error;
			return { ok: false, error: `The endophasia-status plugin is not configured correctly: ${error.message}` };
		}
		const projectIds = selectEndophasiaProjectsV0(config, params.project);
		if (projectIds === null)
			return {
				ok: false,
				error: `"${String(params.project).slice(0, 80)}" is not a permitted project. Permitted: ${config.projects.map((p) => p.label ?? p.id).join(", ")}.`,
			};
		context.signal?.throwIfAborted();
		const read = await readEndophasiaStatusV0(config, projectIds, {
			...(run === undefined ? {} : { run }),
			...(context.signal === undefined ? {} : { signal: context.signal }),
		});
		const provenance = {
			source: "endo coordinator status (read-only projection of Endophasia's local records)",
			projects: projectIds,
			sandbox: "bwrap",
			durationMs: read.durationMs,
		};
		if (read.availability === "unavailable")
			return {
				ok: true,
				availability: "unavailable",
				summary: `Endophasia's status is unavailable right now (${read.reason}: ${read.detail}). Nothing is known about its tasks or sessions from this call; do not infer any.`,
				provenance,
			};
		const view = externalEndophasiaStatusV0(read.status, config);
		return {
			ok: true,
			availability: "available",
			summary: summariseEndophasiaStatusV0(view),
			provenance: { ...provenance, schemaVersion: read.status.schemaVersion, readAtMs: read.status.readAtMs },
			status: view,
			...(config.disclose?.detail === true
				? { coordinatorStatus: redactEndophasiaStatusV0(read.status, config) }
				: {}),
		};
	};
}

export function createEndophasiaStatusPluginV0(
	sdk: { defineToolPlugin: DefineToolPluginV0; Type: TypeBuilderV0 },
	run?: EndophasiaRunV0,
) {
	const { Type } = sdk;
	return sdk.defineToolPlugin({
		id: ENDOPHASIA_STATUS_PLUGIN_ID,
		name: "Endophasia Status",
		description: "Read-only, evidence-qualified status of permitted Endophasia projects.",
		configSchema: Type.Object(
			{
				endo: Type.Object(
					{
						node: Type.String({ description: "Absolute path of the node binary that runs endo." }),
						entry: Type.String({
							description: "Absolute path of endo's CLI entry (cli/index.ts or dist/cli/index.js).",
						}),
					},
					{ additionalProperties: false },
				),
				storeRoot: Type.String({ description: "Absolute path of the Endophasia store root to read." }),
				projects: Type.Array(
					Type.Object(
						{
							id: Type.String({ description: "A permitted project id (endo.project.<32 hex>)." }),
							root: Type.String({
								description:
									"Absolute path of the project's registered working tree; the only project path the sandbox mounts.",
							}),
							label: Type.Optional(Type.String({ description: "A short name the operator may use for it." })),
						},
						{ additionalProperties: false },
					),
					{ minItems: 1, maxItems: 8 },
				),
				staleAfterSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800 })),
				timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 60000 })),
				bwrapPath: Type.Optional(Type.String()),
				disclose: Type.Optional(
					Type.Object(
						{ taskTitles: Type.Optional(Type.Boolean()), detail: Type.Optional(Type.Boolean()) },
						{ additionalProperties: false },
					),
				),
			},
			{ additionalProperties: false },
		),
		tools: (tool) => [
			tool({
				name: ENDOPHASIA_STATUS_TOOL_NAME,
				label: "Endophasia Status",
				description: DESCRIPTION,
				optional: true,
				parameters: Type.Object(
					{
						project: Type.Optional(
							Type.String({
								description:
									"Optional: one permitted project, by its label or id. Omit to read every permitted project.",
								maxLength: 80,
							}),
						),
					},
					{ additionalProperties: false },
				),
				execute: endophasiaToolExecuteV0(run),
			}),
		],
	});
}
