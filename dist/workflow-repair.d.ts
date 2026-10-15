import type { RunCheckOptions, RunCheckResult } from "./workflow-check.js";
export interface RepairReviewerVerdict {
    verdict: "PASS" | "FAIL";
    findings: string[];
}
export interface RepairRoundContext {
    /** One-based validation round. */
    round: number;
    /** Number of repairs completed before this validation. */
    repairs: number;
}
export interface RepairReviewerResult {
    id: string;
    verdict: "PASS" | "FAIL" | "ERROR";
    findings: string[];
}
export interface RepairRoundReport extends RepairRoundContext {
    ok: boolean;
    reviewers: RepairReviewerResult[];
    checks: RunCheckResult[];
}
export interface RepairUntilPassOptions {
    reviewers: Array<{
        id: string;
        run: (context: RepairRoundContext) => unknown | Promise<unknown>;
    }>;
    checks: RunCheckOptions[];
    /** Return the implementation result. Missing/null results stop the loop. */
    repair: (report: RepairRoundReport, repairNumber: number) => unknown | Promise<unknown>;
    maxRepairs?: number;
}
export interface RepairUntilPassResult {
    ok: true;
    rounds: number;
    repairs: number;
    report: RepairRoundReport;
}
export interface RepairRuntime {
    validateCheck: (input: RunCheckOptions) => Required<RunCheckOptions>;
    runCheck: (input: RunCheckOptions) => Promise<RunCheckResult>;
    throwIfAborted: () => void;
    fresh: () => void;
    observe: (report: RepairRoundReport) => void;
}
/** Validate the entire plan before any reviewer, command, or repair is started. */
export declare function createRepairUntilPass(runtime: RepairRuntime): (input: RepairUntilPassOptions) => Promise<RepairUntilPassResult>;
/** Keep automatic evidence logging bounded even for large reviewer findings. */
export declare function repairAuditEntry(report: RepairRoundReport): string;
