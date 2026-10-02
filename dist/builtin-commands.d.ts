/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`,
 * `/multi-perspective`, `/code-review`, and `/codebase-audit`.
 *
 * Each command starts its generated workflow through the WorkflowManager's
 * background path — the command returns immediately, progress is visible in
 * the task panel and `/workflows` (pause/stop work like any managed run), and
 * the report is delivered back into the conversation on completion by
 * installResultDelivery. Running inline in the handler instead would block the
 * whole session until the workflow finished (#104).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import { type WorkflowStorage } from "./workflow-saved.js";
export interface CapturedCommandPrefix {
    stdout: string;
    totalChars: number;
}
export interface DiffNumstatEntry {
    path: string;
    addedLines: number | null;
    deletedLines: number | null;
    binary: boolean;
}
export interface ExcludedDiffEntry extends DiffNumstatEntry {
    reason: string;
}
export interface CodeReviewAutoScope {
    included: DiffNumstatEntry[];
    excluded: ExcludedDiffEntry[];
}
/**
 * Stream command output while retaining only the prefix the review can use.
 * This keeps memory bounded by MAX_DIFF_CHARS without imposing a child-process
 * maxBuffer that rejects large diffs before the review's own truncation policy
 * can run. stdout is decoded incrementally so split UTF-8 sequences are counted
 * the same way as JavaScript String.length.
 */
export declare function captureCommandPrefix(command: string, args: string[], options: {
    cwd: string;
    maxChars: number;
}): Promise<CapturedCommandPrefix>;
/** Parse `git diff --numstat -z --no-renames` without losing unusual filenames. */
export declare function parseDiffNumstat(output: string): DiffNumstatEntry[];
/** Return a reason only for paths that are high-confidence generated artifacts. */
export declare function classifyCodeReviewArtifact(path: string): string | undefined;
export declare function discoverCodeReviewAutoScope(cwd: string): Promise<CodeReviewAutoScope>;
export declare function registerBuiltinWorkflows(pi: ExtensionAPI, opts: {
    cwd?: string;
    manager?: WorkflowManager;
    storage?: WorkflowStorage;
    /** Live accessors — preferred when the extension may replace manager/cwd after session_start. */
    getManager?: () => WorkflowManager;
    getCwd?: () => string;
    getStorage?: () => WorkflowStorage;
}): void;
