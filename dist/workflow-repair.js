import { WorkflowCheckpointSuspensionError, WorkflowError, WorkflowErrorCode } from "./errors.js";
function immutable(value) {
    if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value))
            immutable(entry);
        Object.freeze(value);
    }
    return value;
}
/** Validate the entire plan before any reviewer, command, or repair is started. */
export function createRepairUntilPass(runtime) {
    return (input) => {
        runtime.throwIfAborted();
        const invalid = (message) => {
            throw new WorkflowError(`repairUntilPass() ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
        };
        if (!input || typeof input !== "object" || Array.isArray(input))
            invalid("requires an options object");
        const allowed = new Set(["reviewers", "checks", "repair", "maxRepairs"]);
        if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.has(key)))
            invalid("contains unknown options");
        const { reviewers: reviewerInputs, checks: checkInputs, repair, maxRepairs: configuredMax } = input;
        if (!Array.isArray(reviewerInputs) || reviewerInputs.length === 0)
            invalid("requires at least one reviewer");
        if (!Array.isArray(checkInputs) || checkInputs.length === 0)
            invalid("requires at least one command check");
        if (typeof repair !== "function")
            invalid("repair must be a function");
        const maxRepairs = configuredMax === undefined ? 2 : configuredMax;
        if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0)
            invalid("maxRepairs must be a nonnegative safe integer");
        const ids = new Set();
        const reviewers = Array.from(reviewerInputs, (reviewer) => {
            if (!reviewer || typeof reviewer !== "object")
                invalid("each reviewer needs a nonblank id and run function");
            const { id, run } = reviewer;
            if (typeof id !== "string" || !id.trim() || id.includes("\0") || typeof run !== "function")
                invalid("each reviewer needs a nonblank id and run function");
            if (ids.has(id))
                invalid("reviewer and check ids must be unique");
            ids.add(id);
            return { id, run };
        });
        const checks = Array.from(checkInputs, (check) => {
            const validated = runtime.validateCheck(check);
            if (ids.has(validated.id))
                invalid("reviewer and check ids must be unique");
            ids.add(validated.id);
            return validated;
        });
        // Invalidate reviewer replay BEFORE any review, even if checks come later.
        runtime.fresh();
        return execute();
        async function execute() {
            for (let repairs = 0;; repairs++) {
                runtime.throwIfAborted();
                const context = immutable({ round: repairs + 1, repairs });
                const reviews = [];
                for (const reviewer of reviewers) {
                    runtime.throwIfAborted();
                    let value;
                    try {
                        value = await reviewer.run(context);
                    }
                    catch (error) {
                        runtime.throwIfAborted();
                        // Preserve run-control failures, not unusable reviewer evidence.
                        if (isControlFailure(error))
                            throw error;
                        reviews.push({ id: reviewer.id, verdict: "ERROR", findings: [String(error)] });
                        continue;
                    }
                    runtime.throwIfAborted();
                    let verdict;
                    let findings;
                    try {
                        if (value && typeof value === "object") {
                            ({ verdict, findings } = value);
                            if (Array.isArray(findings))
                                findings = Array.from(findings);
                        }
                    }
                    catch (error) {
                        runtime.throwIfAborted();
                        if (isControlFailure(error))
                            throw error;
                    }
                    if (!["PASS", "FAIL"].includes(verdict) ||
                        !Array.isArray(findings) ||
                        !findings.every((finding) => typeof finding === "string")) {
                        reviews.push({
                            id: reviewer.id,
                            verdict: "ERROR",
                            findings: [
                                "Reviewer returned missing or invalid { verdict: 'PASS' | 'FAIL', findings: string[] } evidence",
                            ],
                        });
                    }
                    else {
                        reviews.push({
                            id: reviewer.id,
                            verdict: verdict,
                            findings,
                        });
                    }
                }
                const results = [];
                for (const check of checks) {
                    runtime.throwIfAborted();
                    results.push(await runtime.runCheck(check));
                    runtime.throwIfAborted();
                }
                const report = immutable({
                    ...context,
                    ok: reviews.every((review) => review.verdict === "PASS") && results.every((check) => check.status === "PASS"),
                    reviewers: reviews,
                    checks: results,
                });
                runtime.observe(report);
                runtime.throwIfAborted();
                if (report.ok)
                    return { ok: true, rounds: context.round, repairs, report };
                const infrastructure = reviews.some((review) => review.verdict === "ERROR") || results.some((check) => check.status === "ERROR");
                if (infrastructure)
                    fail("verification infrastructure failed", WorkflowErrorCode.VERIFICATION_FAILED, report);
                if (repairs === maxRepairs)
                    fail("repair limit exhausted", WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED, report);
                const repaired = await repair(report, repairs + 1);
                runtime.throwIfAborted();
                if (repaired === null || repaired === undefined)
                    fail("repair returned missing evidence", WorkflowErrorCode.VERIFICATION_FAILED, report);
            }
        }
    };
}
function isControlFailure(error) {
    return (error instanceof WorkflowCheckpointSuspensionError ||
        (error instanceof WorkflowError &&
            [
                WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
                WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
                WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
                WorkflowErrorCode.WORKFLOW_ABORTED,
            ].includes(error.code)));
}
function fail(message, code, report) {
    const failedIds = [
        ...report.reviewers.filter((review) => review.verdict !== "PASS"),
        ...report.checks.filter((check) => check.status !== "PASS"),
    ].map((entry) => entry.id);
    throw new WorkflowError(`repairUntilPass(): ${message} after ${report.repairs} repair(s), round ${report.round}; failed: ${failedIds.join(", ")}`, code, { details: { ok: false, rounds: report.round, repairs: report.repairs, report } });
}
/** Keep automatic evidence logging bounded even for large reviewer findings. */
export function repairAuditEntry(report) {
    let preview = JSON.stringify(report);
    const truncated = Buffer.byteLength(preview) > 2800;
    if (truncated)
        preview = Array.from(preview.slice(0, 2800)).slice(0, 1400).join("");
    let result = JSON.stringify({
        type: "repair-round",
        round: report.round,
        repairs: report.repairs,
        ok: report.ok,
        truncated,
        reportPreview: preview,
    });
    while (Buffer.byteLength(result) > 4096) {
        preview = Array.from(preview)
            .slice(0, Math.floor(Array.from(preview).length / 2))
            .join("");
        result = JSON.stringify({
            type: "repair-round",
            round: report.round,
            repairs: report.repairs,
            ok: report.ok,
            truncated: true,
            reportPreview: preview,
        });
    }
    return result;
}
