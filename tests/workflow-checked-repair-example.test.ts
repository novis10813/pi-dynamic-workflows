import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import type { RepairUntilPassResult } from "../src/workflow-repair.js";

const example = readFileSync(
  join(import.meta.dirname, "../skills/workflow-authoring/examples/checked-repair.js"),
  "utf8",
);

async function executeExample(mode: "repair" | "pass" | "exhaust" | "missing" | "malformed", maxRepairs?: number) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-checked-example-"));
  const state = join(cwd, "state");
  const phases: string[] = [];
  const labels: string[] = [];
  const prompts: string[] = [];
  writeFileSync(state, mode === "pass" ? "fixed" : "broken");
  const checks = ["tests", "types"].map((id) => ({
    id,
    command: process.execPath,
    args: [
      "-e",
      `const fs=require('fs');fs.appendFileSync('${id}.runs','x');process.exitCode=fs.readFileSync('state','utf8')==='fixed'?0:7`,
    ],
  }));
  try {
    let error: unknown;
    let result: RepairUntilPassResult | undefined;
    try {
      const execution = await runWorkflow<RepairUntilPassResult>(example, {
        cwd,
        args: { task: "Fix the current checkout", checks, ...(maxRepairs === undefined ? {} : { maxRepairs }) },
        persistLogs: false,
        onPhase: (phase) => phases.push(phase),
        agent: {
          async run(prompt: string, options?: { label?: string; schema?: unknown; thread?: string }) {
            const label = options?.label ?? "";
            labels.push(label);
            prompts.push(prompt);
            if (label === "implement") return "implementation ready";
            if (label.startsWith("repair:")) {
              assert.match(prompt, /"exitCode":7/);
              assert.match(prompt, /"id":"tests"/);
              assert.match(prompt, /"id":"types"/);
              assert.equal(options?.thread, undefined);
              if (mode === "repair") writeFileSync(state, "fixed");
              return "repair complete";
            }
            assert.ok(options?.schema);
            assert.match(prompt, /Read-only/);
            assert.match(prompt, /Do not edit code/);
            if (mode === "missing") return null;
            if (mode === "malformed") return { verdict: "PASS" };
            return { verdict: "PASS", findings: [] };
          },
        },
      });
      result = execution.result;
    } catch (caught) {
      error = caught;
    }
    return {
      result,
      error,
      phases,
      labels,
      prompts,
      checkRuns: checks.map(({ id }) => readFileSync(join(cwd, `${id}.runs`), "utf8")),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("checked-repair example repairs actual failing commands and reruns both structured reviews and checks", async () => {
  const execution = await executeExample("repair");
  assert.equal(execution.error, undefined);
  assert.equal(execution.result?.ok, true);
  assert.equal(execution.result?.repairs, 1);
  assert.equal(execution.result?.rounds, 2);
  assert.deepEqual(execution.phases, ["Implement", "Verify", "Accepted"]);
  assert.deepEqual(execution.labels, [
    "implement",
    "spec-review:1",
    "code-review:1",
    "repair:1",
    "spec-review:2",
    "code-review:2",
  ]);
  assert.deepEqual(execution.checkRuns, ["xx", "xx"]);
  assert.equal(
    execution.result?.report.checks.every(({ status }) => status === "PASS"),
    true,
  );
});

test("checked-repair example accepts a passing initial checkout without repair", async () => {
  const execution = await executeExample("pass", 0);
  assert.equal(execution.error, undefined);
  assert.equal(execution.result?.repairs, 0);
  assert.deepEqual(execution.labels, ["implement", "spec-review:1", "code-review:1"]);
  assert.deepEqual(execution.checkRuns, ["x", "x"]);
});

test("checked-repair example cannot advance on exhausted or zero repair budgets", async () => {
  for (const maxRepairs of [0, 2]) {
    const execution = await executeExample("exhaust", maxRepairs);
    assert.ok(execution.error instanceof WorkflowError);
    assert.equal(execution.error.code, WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED);
    assert.equal(execution.phases.includes("Accepted"), false);
    assert.equal(execution.labels.filter((label) => label.startsWith("repair:")).length, maxRepairs);
    assert.deepEqual(execution.checkRuns, ["x".repeat(maxRepairs + 1), "x".repeat(maxRepairs + 1)]);
  }
});

test("checked-repair example replays initial implementation but revalidates the checkout on resume", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-checked-resume-"));
  const journal: JournalEntry[] = [];
  const labels: string[] = [];
  const settings = {
    cwd,
    runId: "checked-resume",
    persistLogs: false,
    args: {
      task: "Keep existing implementation",
      maxRepairs: 0,
      checks: [{ id: "tests", command: process.execPath, args: ["-e", "require('fs').appendFileSync('runs','x')"] }],
    },
    agent: {
      async run(_prompt: string, options?: { label?: string }) {
        labels.push(options?.label ?? "");
        return options?.label === "implement" ? "implemented" : { verdict: "PASS", findings: [] };
      },
    },
  };
  try {
    await runWorkflow(example, { ...settings, onAgentJournal: (entry) => journal.push(entry) });
    labels.length = 0;
    await runWorkflow(example, {
      ...settings,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    });
    assert.deepEqual(labels, ["spec-review:1", "code-review:1"]);
    assert.equal(readFileSync(join(cwd, "runs"), "utf8"), "xx");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checked-repair example resumes from current files with a fresh per-execution repair budget", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-checked-repair-resume-"));
  const journal: JournalEntry[] = [];
  const labels: string[] = [];
  let repairCalls = 0;
  let interrupt = true;
  writeFileSync(join(cwd, "state"), "broken");
  const settings = {
    cwd,
    runId: "checked-repair-resume",
    persistLogs: false,
    args: {
      task: "Repair the current files, never replay an old verdict",
      maxRepairs: 1,
      checks: [
        {
          id: "tests",
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('fs');fs.appendFileSync('runs','x');process.exitCode=fs.readFileSync('state','utf8')==='fixed'?0:7",
          ],
        },
      ],
    },
    agent: {
      async run(_prompt: string, options?: { label?: string }) {
        const label = options?.label ?? "";
        labels.push(label);
        if (label === "implement") return "implemented";
        if (label.startsWith("repair:")) {
          repairCalls++;
          writeFileSync(join(cwd, "state"), repairCalls === 1 ? "still-broken" : "fixed");
          return "repair current files";
        }
        if (interrupt && label === "spec-review:2") {
          interrupt = false;
          throw new WorkflowError("external stop after repair", WorkflowErrorCode.WORKFLOW_ABORTED);
        }
        const fixed = readFileSync(join(cwd, "state"), "utf8") === "fixed";
        return { verdict: fixed ? "PASS" : "FAIL", findings: fixed ? [] : ["still broken"] };
      },
    },
  };
  try {
    await assert.rejects(
      runWorkflow(example, { ...settings, onAgentJournal: (entry) => journal.push(entry) }),
      (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED,
    );
    assert.equal(repairCalls, 1);
    assert.equal(readFileSync(join(cwd, "state"), "utf8"), "still-broken");
    labels.length = 0;
    const resumed = await runWorkflow<RepairUntilPassResult>(example, {
      ...settings,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    });
    assert.deepEqual(labels, ["spec-review:1", "code-review:1", "repair:1", "spec-review:2", "code-review:2"]);
    assert.equal(repairCalls, 2);
    assert.equal(resumed.result.repairs, 1);
    assert.equal(resumed.result.ok, true);
    assert.equal(readFileSync(join(cwd, "runs"), "utf8"), "xxx");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("checked-repair example stops on missing or malformed review evidence", async () => {
  for (const mode of ["missing", "malformed"] as const) {
    const execution = await executeExample(mode);
    assert.ok(execution.error instanceof WorkflowError);
    assert.equal(execution.error.code, WorkflowErrorCode.VERIFICATION_FAILED);
    assert.equal(execution.phases.includes("Accepted"), false);
    assert.equal(
      execution.labels.some((label) => label.startsWith("repair:")),
      false,
    );
  }
});
