export interface RunCheckOptions {
    id: string;
    command: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
}
export interface RunCheckResult {
    id: string;
    command: string;
    args: string[];
    cwd: string;
    status: "PASS" | "FAIL" | "ERROR";
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    error?: string;
}
/** Compact serialized previews also bound JSON escaping, not just source text. */
export declare function checkAuditEntry(result: RunCheckResult): string;
/** Validate synchronously, including calls whose returned promise is never awaited. */
export declare function validateRunCheck(input: RunCheckOptions, workflowCwd: string): Required<RunCheckOptions>;
/** Host-only execution: no model, shell, journal, or accumulated output chunks. */
export declare function executeRunCheck(options: Required<RunCheckOptions>, signals: readonly AbortSignal[]): Promise<RunCheckResult>;
