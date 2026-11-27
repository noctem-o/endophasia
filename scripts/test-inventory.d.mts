export type ExecutionClass = "fast" | "browser" | "process";

export const REPO_ROOT: string;
export const EXECUTION_CLASSES: readonly ExecutionClass[];
export const FAST_DURATION_THRESHOLD_MS: number;
export const DEFAULT_UNMEASURED_WEIGHT_MS: number;
export const WORKSTATION_PATH_EXCEPTIONS: ReadonlySet<string>;
export const BROWSER_TEXT_ONLY_FILES: ReadonlySet<string>;

export interface SpecialistSuiteSpec {
	readonly description: string;
	readonly files: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export const SPECIALIST_SUITES: Readonly<Record<string, SpecialistSuiteSpec>>;

export interface DurationHints {
	readonly sourceRunId: number | null;
	readonly sourceCommit: string | null;
	readonly runner: string | null;
	readonly defaultWeightMs: number;
	readonly durationsMs: Record<string, number>;
}

export interface PartitionedTestFiles {
	readonly allFiles: string[];
	readonly classes: Record<ExecutionClass, string[]>;
	readonly hints: DurationHints;
	readonly sources: Record<string, string>;
}

export interface ShardAllocation {
	readonly shardIndex: number;
	readonly shardCount: number;
	readonly files: string[];
	readonly shardWeightMs: number;
	readonly allShardWeightsMs: number[];
	readonly imbalanceMs: number;
}

export interface ClassCoverageSummary {
	readonly fileCount: number;
	readonly totalWeightMs: number;
	readonly shards: number;
	readonly shardWeightsMs: number[];
	readonly imbalanceMs: number;
}

export interface CoverageAccountingReport {
	readonly ok: boolean;
	readonly totalDiskFiles: number;
	readonly classSummaries: Record<ExecutionClass, ClassCoverageSummary>;
	readonly specialistJobs: string[];
	readonly errors: string[];
	readonly warnings: string[];
}

export function discoverTestFiles(rootDir?: string): string[];
export function loadDurationHints(rootDir?: string): DurationHints;
export function isBrowserTestFile(relPath: string, sourceText: string): boolean;
export function classifyTestFile(
	relPath: string,
	sourceText: string,
	durationsMs: Record<string, number>,
): ExecutionClass;
export function partitionTestFiles(rootDir?: string): PartitionedTestFiles;
export function allocateLptShard(
	files: readonly string[],
	durationsMs: Record<string, number>,
	shardIndex: number,
	shardCount: number,
	defaultWeightMs?: number,
): ShardAllocation;
export function defaultMaxWorkersForClass(cls: ExecutionClass | "all", cpuCount?: number): number;
export function validateCoverageAccounting(
	rootDir?: string,
	shardPlan?: Readonly<Record<ExecutionClass, number>>,
): CoverageAccountingReport;
