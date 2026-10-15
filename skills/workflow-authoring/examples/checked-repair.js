export const meta = {
  name: "checked_repair",
  description: "Require structured reviews and direct CLI checks before advancing",
  phases: [{ title: "Implement" }, { title: "Verify" }, { title: "Accepted" }],
};

// ADAPT: supply args.task and args.checks from this project's real test/typecheck commands.
// Checks are { id, command, args?, cwd?, timeoutMs? }, not shell command strings.
// Default capacity: 1 implementer + 3 rounds × 2 reviewers + 2 repairs = 9 agent calls.
// Use the same checkout for all agents/checks. Do not use worktree isolation here.
// Explicit resume starts fresh validation and a new repair budget on current files.
// Repairs must be safe to repeat. Initial implementation may replay from its journal.
if (!args || typeof args.task !== "string" || !args.task.trim()) {
  throw new Error("Supply a nonblank args.task");
}
if (!Array.isArray(args.checks) || args.checks.length === 0) {
  throw new Error("Supply nonempty project-owned args.checks");
}
const maxRepairs = args.maxRepairs === undefined ? 2 : args.maxRepairs;
if (!Number.isSafeInteger(maxRepairs) || maxRepairs < 0) {
  throw new Error("args.maxRepairs must be a nonnegative safe integer");
}
const reviewSchema = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "findings"],
  additionalProperties: false,
};
const task = args.task;

phase("Implement");
const implementation = await agent(`Implement this task in ${cwd}: ${task}`, {
  label: "implement",
});
if (implementation === null) throw new Error("Initial implementation returned no evidence");

phase("Verify");
const outcome = await repairUntilPass({
  reviewers: ["spec", "code"].map((id) => ({
    id,
    run: ({ round }) =>
      agent(
        `Read-only ${id} review, round ${round}, of the current files in ${cwd}. ` +
          `Do not edit code or start background writers. Task: ${task}. ` +
          "Inspect the checkout, not just an implementer summary. Return the structured verdict and findings.",
        { label: `${id}-review:${round}`, schema: reviewSchema },
      ),
  })),
  checks: args.checks,
  maxRepairs,
  repair: (report, repairNumber) =>
    agent(
      `Repair the current checkout in ${cwd} for task: ${task}. ` +
        "Address all failed reviews/checks below. Do not weaken checks or leave background writers. " +
        `Full validation evidence: ${JSON.stringify(report)}`,
      { label: `repair:${repairNumber}` },
    ),
});

// No catch-and-continue: a failed or pending repair gate must not advance this phase.
phase("Accepted");
return outcome;
