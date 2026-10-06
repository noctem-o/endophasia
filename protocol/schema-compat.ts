// The compatibility catalogue: which schema versions Endophasia promises to keep reading, and the permanent fixtures
// that prove it. Metadata only: this file imports nothing, so the protocol layer stays independent of storage and of
// every family's validators. docs/schema-compatibility.md states the rule; tests/schema-compat.test.ts enforces it against
// each family's own version table.
//
// Adding a durable version means adding its table entry, its fixture and its entry here. Removing a version, or
// editing one of its fixtures, is a breaking change to a durable contract: the fixture's SHA-256 is pinned below so
// that an edit shows up in review.

export interface EndoDurableSchemaFixtureV0 {
	/** File name under tests/fixtures/schema-compat/<schemaVersion>/. */
	readonly file: string;
	/** SHA-256 (hex) of the file's bytes. */
	readonly sha256: string;
}

export interface EndoDurableSchemaV0 {
	/** The schemaVersion string without its version suffix. */
	readonly family: string;
	readonly schemaVersion: string;
	/** `current`: a writer emits (or may emit) this version. `legacy`: read-only; writers have moved on. */
	readonly status: "current" | "legacy";
	/** The module and boundary where durable bytes of this version become trusted typed objects. */
	readonly boundary: string;
	/** At least one, permanent. */
	readonly fixtures: readonly EndoDurableSchemaFixtureV0[];
	/**
	 * Paths (dotted; `*` is any array element or any key of an open map) of intentionally open JSON containers inside
	 * this version: a strict-JSON value whose interpretation belongs to the container, not unknown fields of the envelope.
	 */
	readonly openPaths?: readonly string[];
}

export const ENDO_DURABLE_SCHEMAS_V0: readonly EndoDurableSchemaV0[] = [
	{
		family: "endo.artifact",
		schemaVersion: "endo.artifact.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "726490a418e44f3974eba53afdcffdd1aefc8baabc3f2391cd5a50d4a573b21c" }],
	},
	{
		family: "endo.candidate",
		schemaVersion: "endo.candidate.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [
			{ file: "base.json", sha256: "2be927b48aa64a0416787d93056f7d5d95f65827d8cf25556053127052498107" },
			{ file: "minimal.json", sha256: "a4ab059d2408b018bc929042da95ff40964b641ff3efb9ae71202943d25ccd87" },
		],
	},
	{
		family: "endo.capability-evidence",
		schemaVersion: "endo.capability-evidence.v0",
		status: "current",
		boundary: "storage/harness-registry.ts (registry frames)",
		fixtures: [{ file: "minimal.json", sha256: "5991dfe2d4b7f1730c9780082b6c5b23519bca8521458ee7699a4c4f6c58d6a8" }],
	},
	{
		family: "endo.capability-state",
		schemaVersion: "endo.capability-state.v0",
		status: "current",
		boundary: "storage/harness-registry.ts (registry frames)",
		fixtures: [{ file: "minimal.json", sha256: "684c0db368508b63decde48a3f5ffb290209a023d4908d2c41e65381991fc376" }],
	},
	{
		family: "endo.collab-approval-decision",
		schemaVersion: "endo.collab-approval-decision.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "b956647ca372edc704198c5cb78cebc717fcfd6e529957c6847e544e2c97db19" }],
	},
	{
		family: "endo.collab-approval-request",
		schemaVersion: "endo.collab-approval-request.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "aa39638e826ed33836d6953dc23c91dd524ffd33d044faac5a907a54dba5cd59" }],
	},
	{
		family: "endo.collab-discussion",
		schemaVersion: "endo.collab-discussion.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "6427dfe65e195a908ce25beab1a3c3261f66850986e1921d302199c19fbdf76e" }],
	},
	{
		family: "endo.collab-patch",
		schemaVersion: "endo.collab-patch.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "d5122cbee73ad1948aec5d4fb11177fc6943b14e2aefbd73d19c24fa9f0c1bb6" }],
	},
	{
		family: "endo.collab-room",
		schemaVersion: "endo.collab-room.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "5deb866f0caae5bcdb16c6c2364526f2e36e00dd98a65ee6d0b04ef89869ca3d" }],
	},
	{
		family: "endo.collab-steering",
		schemaVersion: "endo.collab-steering.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "9cda447ec0f983bdb61236045a951dbbe06e364b25f5e67df61f09ddf527f4c7" }],
	},
	{
		family: "endo.conformance-suite",
		schemaVersion: "endo.conformance-suite.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "e5374a3ebfed3ccf6fcb59f98b2d8430c76f4a0ee9709f600da1561c4980819d" }],
	},
	{
		family: "endo.digest-key",
		schemaVersion: "endo.digest-key.v0",
		status: "current",
		boundary: "storage/digest-key.ts (key file)",
		fixtures: [{ file: "minimal.json", sha256: "3d2dd280d84ba4ef78404153b1a35496a501f831132332c9c114e546d88a6981" }],
	},
	{
		family: "endo.evaluation-profile",
		schemaVersion: "endo.evaluation-profile.v0",
		status: "current",
		boundary: "protocol/evaluation.ts (nested in evaluation results)",
		fixtures: [{ file: "minimal.json", sha256: "d9520d507cf8679597d6368b48bd1bde6ee19085103f26ebf4ab48661bfde7ea" }],
	},
	{
		family: "endo.evaluation-profile",
		schemaVersion: "endo.evaluation-profile.v1",
		status: "current",
		boundary: "protocol/evaluation.ts (nested in evaluation results)",
		fixtures: [{ file: "minimal.json", sha256: "7d5a39af6e85b436187327ea5fdff48b94dbe5a3b893bc529c55527638412dee" }],
	},
	{
		family: "endo.evaluation-result",
		schemaVersion: "endo.evaluation-result.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [
			{ file: "profile-v0.json", sha256: "df547a5cf9a6989aa74e8402864393d9f2ea9fff13d8582761a217a6ab1dab2c" },
			{ file: "profile-v1.json", sha256: "e0f96ccd8065c7b01ac1fcf30ae0852f1fb8ece082b3a544cced67fd4bb7c74b" },
			{ file: "full.json", sha256: "e31fbb8c7e344fa0a8603425a842657878c27037cd610255cdade496b7ec0f12" },
		],
		openPaths: ["trials.*.raw", "trials.*.derived"],
	},
	{
		family: "endo.event",
		schemaVersion: "endo.event.v0",
		status: "current",
		boundary: "storage/event-store.ts (event frames)",
		fixtures: [
			{ file: "minimal.json", sha256: "f16c7bd58634be452fe77d219248bd7c68c22dffa4280f3de9ea4cb4287a5114" },
			{ file: "with-payload.json", sha256: "be426695b8eb352b0c90ba3dad1d9d45a664dd06acc0473c582ab1b048528f60" },
			{ file: "full.json", sha256: "09c44ca5263172dae5e96185b7cd209a78fe5ce7c87a02525a38bb2d454a7eb4" },
		],
		openPaths: ["payload"],
	},
	{
		family: "endo.evidence-ledger",
		schemaVersion: "endo.evidence-ledger.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger snapshot)",
		fixtures: [{ file: "minimal.json", sha256: "47b9add7051a9a74d0d8c6843a3c3efc97177f1ca7252ae70cf6a7f020451874" }],
	},
	{
		family: "endo.experiment-bundle",
		schemaVersion: "endo.experiment-bundle.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "3da75af23b148b4edbbf1f2c219601d9aa35e93a0e8e8b8c52ded9f5cd55c967" }],
		openPaths: ["result.trials.*.raw", "result.trials.*.derived"],
	},
	{
		family: "endo.experiment-plan",
		schemaVersion: "endo.experiment-plan.v0",
		status: "current",
		boundary: "cli/experiment-artifacts.ts (run directory plan.json; the unversioned legacy plan is read separately)",
		fixtures: [{ file: "blocked.json", sha256: "8cd6a4c6f95d9c457ed4e49f8956316807317d15c0588a04fed795980174cec9" }],
	},
	{
		family: "endo.experiment-run",
		schemaVersion: "endo.experiment-run.v0",
		status: "current",
		boundary: "cli/experiment-artifacts.ts (run directory experiment.json)",
		fixtures: [
			{ file: "full.json", sha256: "03638d123bd5b0a55d5f9814503d64d370ee23e46c77f2efe31062c7ff0de427" },
			{ file: "minimal.json", sha256: "bed2e29d0745421c24358e0c120d5397691e44ed037153ac59c1a4582016acb5" },
		],
		openPaths: [
			"spec.tasks.*.workspace",
			"spec.conditions.*.modelEntry",
			"spec.conditions.*.settings",
			"spec.conditions.*.extensions",
			"spec.conditions.*.environment.variables",
			"spec.conditions.*.environment.files",
			"spec.manipulation.conditions.*.injected",
			"experiment.budget",
		],
	},
	{
		family: "endo.experiment-spec",
		schemaVersion: "endo.experiment-spec.v0",
		status: "current",
		boundary: "cli/experiment-artifacts.ts (the operator's spec file)",
		fixtures: [
			{ file: "full.json", sha256: "42a8d503150e42343f203d817b5ccfd4fa2bba28389f7102acc63177651c4fa1" },
			{ file: "minimal.json", sha256: "65d8ae213ab1bae9875f439b369dc5e7df0c64f2b6504bd29fcf919f036ea0ae" },
		],
		openPaths: [
			"tasks.*.workspace",
			"conditions.*.modelEntry",
			"conditions.*.settings",
			"conditions.*.extensions",
			"conditions.*.environment.variables",
			"conditions.*.environment.files",
			"manipulation.conditions.*.injected",
		],
	},
	{
		family: "endo.experiment-transition",
		schemaVersion: "endo.experiment-transition.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "8ee49b175abd0a2c61d31e6eddf4ad4086857fb438861082e3696911d84f3f57" }],
	},
	{
		family: "endo.experiment-trial",
		schemaVersion: "endo.experiment-trial.v0",
		status: "current",
		boundary: "cli/experiment-artifacts.ts (run directory trials/**/result.json)",
		fixtures: [
			{ file: "full.json", sha256: "13f50996b2edc655561675dd9d93380d6b402123478ff799eaba22c2cde7ec5e" },
			{ file: "minimal.json", sha256: "78374f39f760beded6e6f8196095385fcfc331d16df59e8d003f7499aa5cd477" },
		],
		openPaths: ["requestParameters"],
	},
	{
		family: "endo.experiment",
		schemaVersion: "endo.experiment.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger meta)",
		fixtures: [{ file: "minimal.json", sha256: "7610c2dcb29622c9c7a1858ad58bb24fd4140c43f9fc3e9f34ebcdb9ff311047" }],
	},
	{
		family: "endo.harness-change",
		schemaVersion: "endo.harness-change.v0",
		status: "current",
		boundary: "storage/harness-registry.ts (registry frames)",
		fixtures: [{ file: "minimal.json", sha256: "abf33ae5c5f109fcc3318e50ca56b5f43101f6d631c14e687802abcdaa094a96" }],
	},
	{
		family: "endo.harness-fingerprint",
		schemaVersion: "endo.harness-fingerprint.v0",
		status: "current",
		boundary: "storage/harness-registry.ts (registry frames)",
		fixtures: [{ file: "minimal.json", sha256: "be0b7b2797591b0dcf8c17539ca966577812c8a1c0896f6cfd0ac82d1027dd2e" }],
	},
	{
		family: "endo.harness-notification",
		schemaVersion: "endo.harness-notification.v0",
		status: "current",
		boundary: "storage/harness-registry.ts (registry frames)",
		fixtures: [{ file: "minimal.json", sha256: "0ab617b91a863c8a8e1312474c81c91ff24e8b5dc6769b9142d63252e6875695" }],
	},
	{
		family: "endo.lease",
		schemaVersion: "endo.lease.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "090b50bfaefcb1b60d62f62f5855a3d94536c46ea291e9823e6dfa23c1e7d4ff" }],
	},
	{
		family: "endo.model-pool",
		schemaVersion: "endo.model-pool.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "801cd704c956cbd4bcf20cc3b40b5ec0abac16dd013e4cd1f59e52f523bd6309" }],
	},
	{
		family: "endo.model-profile",
		schemaVersion: "endo.model-profile.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "963a196e8343b9e62dce0284eac478d840b29b011c9bed9433ab148171b88ad6" }],
	},
	{
		family: "endo.model-telemetry",
		schemaVersion: "endo.model-telemetry.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "01145110ab7f1599d0fa4b74f91991532cfeec71e9c118f13df53a922eb1deef" }],
	},
	{
		family: "endo.mutation",
		schemaVersion: "endo.mutation.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "9714cb1153055d89ff60c7b24be126d8d5c7b569738b0d4f60774d41b0e389c1" }],
	},
	{
		family: "endo.promotion-decision",
		schemaVersion: "endo.promotion-decision.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "04b059cb44ecf7a05c47cf0e7013c5f633d9bb79acf408f902b13284f99e0c64" }],
	},
	{
		family: "endo.promotion-request",
		schemaVersion: "endo.promotion-request.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "2f9e61b9c59791ce4602b8f265d3ded7dcf11ec6257a2365ba19fab5dde25fb1" }],
	},
	{
		family: "endo.receipt",
		schemaVersion: "endo.receipt.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "cdf0297afba7099024d617ade3334ff4a1876a687bda635901af34ff83cab429" }],
	},
	{
		family: "endo.replay-comparison",
		schemaVersion: "endo.replay-comparison.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "9d8907213d7faa4f7a1beaacded412897a1917ed64207f7a18a092e08b98b092" }],
	},
	{
		family: "endo.runtime-admission",
		schemaVersion: "endo.runtime-admission.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "e105b43df1f6fd4c7d8cab8fb83e03069ffefe05eef695f772a099cad1aab174" }],
	},
	{
		family: "endo.selection-decision",
		schemaVersion: "endo.selection-decision.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "84f2c10b3b17b49f1bfc45e9ae07ba67ed089bbdb25b1f4f89fb59d3f556c560" }],
	},
	{
		family: "endo.standing",
		schemaVersion: "endo.standing.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "f5f7e44bbabfd5f15722ab682140a7eac000fa1fc4163b55481b3ac12cfaa8b0" }],
	},
	{
		family: "endo.witness",
		schemaVersion: "endo.witness.v0",
		status: "current",
		boundary: "storage/ledger.ts (ledger frames)",
		fixtures: [{ file: "minimal.json", sha256: "3fc4c999b85676050d620fcbad57ce23535392b0aa16bd845c11f585a0b019d6" }],
	},
	{
		family: "endo.workspace-archive",
		schemaVersion: "endo.workspace-archive.v0",
		status: "legacy",
		boundary: "storage/workspace-snapshot.ts (blob store, cassette replay)",
		fixtures: [{ file: "minimal.json", sha256: "c85514b59626d935ec951c64e7fe9738323f7f1c1f13a501ab2d737e52ec4019" }],
	},
	{
		family: "endo.workspace-archive",
		schemaVersion: "endo.workspace-archive.v1",
		status: "current",
		boundary: "storage/workspace-snapshot.ts (blob store, cassette replay)",
		fixtures: [{ file: "minimal.json", sha256: "f255d64f2350e2b1827722f2777680b15a343081fbaf4cc94d2075dd5ab8d62e" }],
	},
];
