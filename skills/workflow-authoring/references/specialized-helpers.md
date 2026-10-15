# Specialized helpers

Preserve candidate or work identity outside helper results that may omit failed agents.

## Quality

| Helper | Authoring contract |
| --- | --- |
| `completenessCheck(args, results)` | Consumes one logical agent slot and preflights that capacity before starting the critic; an external pause/stop abort wins before the critic starts. Returns `{ complete, missing? }` or recoverable `null`. The critic sees only the first 4,000 serialized characters, so chunk or summarize larger evidence. Treat the verdict as advisory. |
| `loopUntilDry({ round, key, consecutiveEmpty, maxRounds })` | `round(index)` is zero-based. Defaults: `JSON.stringify` key, two dry rounds, 50 rounds. Null, non-array, and duplicate-only rounds are dry. Token-budget or agent-limit exhaustion returns the partial array without a termination reason; keep failed-round identity and stopping state outside the helper. |

## CLI checks and bounded repair

Use project-supplied executable commands and argument arrays, not shell strings or agent-reported test results. `runCheck({ id, command, args?, cwd?, timeoutMs? })` spawns directly with no shell. Relative `cwd` resolves against the workflow checkout. Quiet exit zero is PASS, ordinary nonzero is FAIL, and timeout, spawn failure, or signal is ERROR. Configure the project runner to reject missing or skipped tests where required. Exit zero alone cannot prove tests ran.

For implementation acceptance, use `repairUntilPass({ reviewers, checks, repair, maxRepairs? })` rather than advisory voting or `gate()`. Each reviewer needs a callback returning `{ verdict: "PASS" | "FAIL", findings: string[] }`. Reviewer and check IDs must be unique across the entire plan. Keep schema and routing decisions in the callbacks. Await the initial implementation before entering the helper.

Await the helper before advancing: every reviewer and command must PASS in the same round. An ordinary FAIL awaits `repair(report, oneBasedRepairNumber)` and then reruns all reviewers and checks. The default permits two repairs after initial validation, while zero validates once. Return the repair result explicitly. Missing or malformed reviews, reviewer exceptions, command ERROR, or a null/missing repair result stop verification. Cancellation, run limits, provider limits, and durable checkpoint suspension propagate instead of becoming code repairs. Include all reviewer/repair agent calls when sizing invocation capacity.

Only success returns `{ ok: true, rounds, repairs, report }`. Exhaustion throws `REPAIR_LIMIT_EXCEEDED`; unusable evidence throws `VERIFICATION_FAILED`. Both retain final round evidence in `error.details`. Automatic logs contain bounded previews, not the full returned report. Gate failure remains sticky even if caught or unawaited and blocks later phases and terminal success. Do not catch a failed gate to continue shipping.

Keep implementers, reviewers, and commands on the same checkout. Await all writers, keep reviewers and checks from editing code, and prevent unrelated writes until validation completes. Worktree isolation is not a substitute: a separate snapshot can miss the implementation. `phase()` does not lock or snapshot a repository. On resume, both helpers force fresh validation and invalidate downstream cached calls, including nested workflows. Each helper execution has its own repair budget: an explicit resume restarts validation from the current checkout with the full budget, not a persisted lifetime allowance. A still-failing checkout can invoke repair again, so repairs must be safe to repeat against current files. Only an unchanged journaled prefix before the helper, such as the initial implementation, can replay. Threaded implementers instead always rerun. See [checked repair](../examples/checked-repair.js) for structured spec/code reviews, direct checks, and feedback handoff.

## Control

| Helper | Authoring contract |
| --- | --- |
| `gate(thunk, validator, { attempts })` | Calls `thunk(feedback, attempt)` with initial `undefined` feedback and a zero-based attempt. `validator(value)` returns `{ ok, feedback? }`, synchronously or asynchronously; a bare boolean is not accepted. Three attempts by default. Returns `{ ok, value, attempts }`, including the last value on exhaustion. See [validated gate](../examples/validated-gate.js). |
| `checkpoint(prompt, options?)` | Journals a human/default decision. Only foreground confirm and documented headless behavior work; input, select, and timeout are declared-only. |
| `checkpoint({ kind, checkpointId, payload })` | Durably suspends the run until a controller attaches a JSON response for that exact ID and resumes it. Works without foreground UI; replay returns the journaled response. |

For durable checkpoints, use a stable, unique `checkpointId` and lossless JSON payload. The host controller calls `WorkflowManager.attachCheckpointResponse(runId, checkpointId, response)` before `resume(runId, { checkpointId })`; attachment alone does not restart execution. The response survives process restart. Do not catch checkpoint suspension to continue work: it remains a run-level pause, including inside helpers. This overload does not display a confirmation dialog or grant permission to perform external actions.

Always `await gate()`. A thunk containing `await` must itself be declared `async`; await `agent()` before adding its resolved value to a ledger. Runtime agent retries repeat recoverable execution failures; helper attempts are new semantic calls. Bound both layers and ledger exhaustion.
