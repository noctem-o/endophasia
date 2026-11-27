export interface ReconciliationErrorV0 {
	readonly code: string;
	readonly detail: string;
}

export interface ReconciledFileResultV0 {
	readonly file: string;
	readonly status: string;
	readonly durationMs: number;
	readonly passed: number;
	readonly failed: number;
	readonly skipped: number;
	readonly todo: number;
}

export interface ConfidentialFailureSummaryV0 {
	readonly file: string;
	readonly fullName: string;
	readonly category: string;
	readonly errorName: string;
	readonly location: { readonly line: number; readonly column: number } | null;
}

export interface PermittedWholeFileSkipV0 {
	readonly file: string;
	readonly skipped: number;
	readonly reason: string;
}

export interface ReconciliationSummaryV0 {
	readonly expectedFileCount: number;
	readonly observedFileCount: number;
	readonly missingFiles: string[];
	readonly unexpectedFiles: string[];
	readonly duplicateFiles: string[];
	readonly zeroTestFiles: string[];
	readonly mandatoryWholeFileSkips: string[];
	readonly permittedWholeFileSkips: PermittedWholeFileSkipV0[];
	readonly totalTests: number;
	readonly passedTests: number;
	readonly failedTests: number;
	readonly skippedTests: number;
	readonly todoTests: number;
}

export interface ReconciliationResultV0 {
	readonly ok: boolean;
	readonly errors: ReconciliationErrorV0[];
	readonly fileResults: ReconciledFileResultV0[];
	readonly failures: ConfidentialFailureSummaryV0[];
	readonly summary: ReconciliationSummaryV0;
}

export function validateStrictPassthroughArgs(passthroughArgs: readonly string[]): string[];
export function normalizeReportedFilePath(
	rawPath: unknown,
	canonicalRepoRoot: string,
): { readonly ok: true; readonly relPath: string } | { readonly ok: false; readonly reason: string };
export function sanitizeBoundedLabel(value: unknown, maxLen?: number): string;
export function escapeMarkdownCell(value: unknown, maxLen?: number): string;
export function classifyFailureSignature(
	failureMessages: readonly string[],
	suiteMessage?: string,
): { readonly category: string; readonly errorName: string };
export function reconcileVitestExecution(opts: {
	readonly repoRoot: string;
	readonly expectedFiles: readonly string[];
	readonly reportPath: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly vitestExitCode: number;
	readonly vitestSignal?: string | null;
	readonly permittedOptionalWholeFileSkips?: Readonly<Record<string, string>>;
}): ReconciliationResultV0;
