import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import type { RepairUntilPassResult } from "../src/workflow-repair.js";

const meta = `export const meta = { name: 'repair_test', description: 'bounded mechanical repair', phases: [{title:'Build'},{title:'Next'}] };phase('Build');`;
const command = (code = "", id = "tests") => JSON.stringify({ id, command: process.execPath, args: ["-e", code] });
const pass = `{verdict:'PASS',findings:[]}`;
const fail = `{verdict:'FAIL',findings:['needs fix']}`;
const runner = {
  async run() {
    return "implemented";
  },
};
const run = (body: string) => `${meta}\n${body}`;
const options = { agent: runner, persistLogs: false };
function codeIs(code: WorkflowErrorCode) {
  return (error: unknown) => error instanceof WorkflowError && error.code === code && !error.recoverable;
}

function plan(extra = "", reviewer = pass, check = command()) {
  return `{reviewers:[{id:'review',run:()=>(${reviewer})}],checks:[${check}],repair:()=> 'repaired',${extra}}`;
}

test("repairUntilPass returns only when every required reviewer and actual command passes", async () => {
  const res = await runWorkflow<RepairUntilPassResult>(
    run(`await agent('implement');const result=await repairUntilPass(${plan()});phase('Next');return result;`),
    options,
  );
  assert.equal(res.result.ok, true);
  assert.equal(res.result.rounds, 1);
  assert.equal(res.result.repairs, 0);
  assert.equal(res.result.report.reviewers[0].verdict, "PASS");
  assert.equal(res.result.report.checks[0].exitCode, 0);
  assert.equal(res.agentCount, 1);
  assert.ok(res.logs.some((line) => line.startsWith('{"type":"repair-round"')));
});

test("real failed checks and reviewer FAIL trigger awaited repairs and full revalidation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-repair-real-"));
  const stateFile = join(root, "state");
  const checksFile = join(root, "checks");
  writeFileSync(stateFile, "0");
  const prompts: string[] = [];
  try {
    const checks = command(
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(checksFile)},'x');process.exitCode=fs.readFileSync(${JSON.stringify(stateFile)},'utf8')==='1'?0:7`,
    );
    const result = await runWorkflow<RepairUntilPassResult>(
      run(`let reviews=0;await agent('implement');return await repairUntilPass({
reviewers:[{id:'spec',run:async({round})=>{reviews++;await agent('spec-'+round);return round===1?${fail}:${pass};}},
{id:'code',run:async({round})=>{await agent('code-'+round);return ${pass};}}],
checks:[${checks}],repair:async(report,number)=>{if(report.checks[0].exitCode!==7||number!==1)throw Error('bad feedback');return await agent('repair');}});`),
      {
        ...options,
        agent: {
          async run(prompt: string) {
            prompts.push(prompt);
            if (prompt === "repair") writeFileSync(stateFile, "1");
            return "done";
          },
        },
      },
    );
    assert.equal(result.result.rounds, 2);
    assert.equal(result.result.repairs, 1);
    assert.equal(readFileSync(checksFile, "utf8"), "xx");
    assert.deepEqual(prompts, ["implement", "spec-1", "code-1", "repair", "spec-2", "code-2"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default maxRepairs is two and exhaustion prevents the next phase", async () => {
  const phases: string[] = [];
  let report: unknown;
  await assert.rejects(
    runWorkflow(
      run(
        `let repairs=0;await repairUntilPass({...${plan("", fail)},repair:()=>{repairs++;return repairs;}});phase('Next');`,
      ),
      {
        ...options,
        onPhase: (phase) => phases.push(phase),
      },
    ),
    (error: unknown) => {
      if (!(error instanceof WorkflowError)) return false;
      assert.equal(error.code, WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED);
      assert.equal(error.recoverable, false);
      report = error.details;
      return true;
    },
  );
  const final = report as { rounds: number; repairs: number; report: { reviewers: Array<{ findings: string[] }> } };
  assert.equal(final.rounds, 3);
  assert.equal(final.repairs, 2);
  assert.equal(final.report.reviewers[0].findings[0], "needs fix");
  assert.equal(phases.includes("Next"), false);
});

test("zero repairs validates once and ordinary nonzero checks cannot be bypassed by reviewer PASS", async () => {
  await assert.rejects(
    runWorkflow(
      run(`return await repairUntilPass(${plan("maxRepairs:0", pass, command("process.exitCode=7"))});`),
      options,
    ),
    (error: unknown) => {
      if (!(error instanceof WorkflowError)) return false;
      assert.equal(error.code, WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED);
      const details = error.details as { repairs: number; report: { checks: Array<{ exitCode: number }> } };
      assert.equal(details.repairs, 0);
      assert.equal(details.report.checks[0].exitCode, 7);
      return true;
    },
  );
});

test("every required reviewer must PASS, with no majority vote or omission of missing results", async () => {
  const result = await runWorkflow<{ repaired: number; result: RepairUntilPassResult }>(
    run(`let repaired=0;
const result=await repairUntilPass({reviewers:[{id:'yes',run:()=>(${pass})},{id:'no',run:()=>repaired?${pass}:${fail}}],checks:[${command()}],repair:()=>++repaired});return {repaired,result};`),
    options,
  );
  assert.equal(result.result.repaired, 1);
  for (const value of [
    "null",
    "undefined",
    "'PASS'",
    "{verdict:true,findings:[]}",
    "{verdict:'SKIP',findings:[]}",
    "{verdict:'PASS'}",
    "{verdict:'PASS',findings:[null]}",
  ]) {
    await assert.rejects(
      runWorkflow(run(`return await repairUntilPass(${plan("", value)});`), options),
      codeIs(WorkflowErrorCode.VERIFICATION_FAILED),
    );
  }
});

test("check infrastructure errors stop instead of spending repair attempts", async () => {
  for (const check of [
    JSON.stringify({ id: "missing", command: "pi-repair-missing-39287" }),
    command("setInterval(()=>{},1000)", "timeout").replace('"args":', '"timeoutMs":50,"args":'),
  ]) {
    await assert.rejects(
      runWorkflow(
        run(
          `return await repairUntilPass({...${plan("", pass, check)},repair:()=>{throw Error('must not repair infrastructure');}});`,
        ),
        options,
      ),
      (error: unknown) => {
        if (!(error instanceof WorkflowError)) return false;
        assert.equal(error.code, WorkflowErrorCode.VERIFICATION_FAILED);
        const details = error.details as { repairs: number; report: { checks: Array<{ status: string }> } };
        assert.equal(details.repairs, 0);
        assert.equal(details.report.checks[0].status, "ERROR");
        return true;
      },
    );
  }
});

test("reviewer exceptions and missing repair results fail closed", async () => {
  await assert.rejects(
    runWorkflow(
      run(
        `return await repairUntilPass({...${plan()},reviewers:[{id:'throws',run:()=>{throw Error('review unavailable');}}]});`,
      ),
      options,
    ),
    codeIs(WorkflowErrorCode.VERIFICATION_FAILED),
  );
  for (const missing of ["null", "undefined"]) {
    await assert.rejects(
      runWorkflow(run(`return await repairUntilPass({...${plan("", fail)},repair:()=>${missing}});`), options),
      codeIs(WorkflowErrorCode.VERIFICATION_FAILED),
    );
  }
});

test("invalid repair plans are rejected before any reviewer executes", async () => {
  for (const bad of [
    "null",
    "{}",
    `${plan("maxRepairs:-1")}`,
    `${plan("maxRepairs:1.5")}`,
    `${plan("maxRepairs:Infinity")}`,
    `${plan("maxRepairs:'2'")}`,
    `${plan("extra:true")}`,
    `{...${plan()},reviewers:[]}`,
    `{...${plan()},checks:[]}`,
    `{...${plan()},checks:[{id:'tests',command:''}]}`,
    `{...${plan()},repair:null}`,
    `{...${plan()},reviewers:[{id:'tests',run:()=>(${pass})}]}`,
    `{...${plan()},reviewers:[{id:'r',run:()=>(${pass})},{id:'r',run:()=>(${pass})}]}`,
    `{...${plan()},reviewers:Array(1)}`,
    `{...${plan()},checks:Array(1)}`,
  ]) {
    await assert.rejects(
      runWorkflow(run(`return await repairUntilPass(${bad});`), { ...options, maxAgents: 0 }),
      codeIs(WorkflowErrorCode.SCRIPT_VALIDATION_ERROR),
    );
  }
});

test("round reports are frozen and options are snapshotted against callback mutation", async () => {
  const result = await runWorkflow<RepairUntilPassResult>(
    run(`let fixed=false;
const checks=[${command()}];const reviewers=[{id:'r',run:()=>{checks.length=0;reviewers.length=0;return fixed?${pass}:${fail};}}];
return await repairUntilPass({reviewers,checks,repair:report=>{if(!Object.isFrozen(report)||!Object.isFrozen(report.checks)||!Object.isFrozen(report.checks[0])||!Object.isFrozen(report.reviewers[0].findings))throw Error('mutable report');fixed=true;return 'fixed';}});`),
    options,
  );
  assert.equal(result.result.rounds, 2);
  assert.equal(result.result.report.checks.length, 1);
  assert.equal(result.result.report.reviewers.length, 1);
});

test("resume re-runs reviewers before checks instead of replaying prior PASS", async () => {
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  let shouldPass = true;
  const script = run(
    `await agent('before');return await repairUntilPass({reviewers:[{id:'review',run:()=>agent('review')}],checks:[${command()}],repair:()=>agent('repair'),maxRepairs:0});`,
  );
  const settings = {
    ...options,
    runId: "repair-resume",
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        return prompt === "review" ? { verdict: shouldPass ? "PASS" : "FAIL", findings: [] } : "ok";
      },
    },
  };
  await runWorkflow(script, { ...settings, onAgentJournal: (entry) => journal.push(entry) });
  shouldPass = false;
  prompts.length = 0;
  await assert.rejects(
    runWorkflow(script, {
      ...settings,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    }),
    codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
  );
  assert.deepEqual(prompts, ["review"]);
});

test("helper agent calls obey ordinary caps and preserve provider/control errors", async () => {
  await assert.rejects(
    runWorkflow(
      run(
        `return await repairUntilPass({reviewers:[{id:'review',run:()=>agent('review')}],checks:[${command()}],repair:()=>agent('repair')});`,
      ),
      { ...options, maxAgents: 0 },
    ),
    codeIs(WorkflowErrorCode.AGENT_LIMIT_EXCEEDED),
  );
  const quota = new WorkflowError("quota", WorkflowErrorCode.PROVIDER_USAGE_LIMIT);
  await assert.rejects(
    runWorkflow(
      run(
        `return await repairUntilPass({reviewers:[{id:'r',run:()=>agent('review')}],checks:[${command()}],repair:()=> 'repair'});`,
      ),
      {
        ...options,
        agent: {
          async run() {
            throw quota;
          },
        },
      },
    ),
    (error: unknown) => error === quota,
  );
});

test("a stop swallowed by reviewer callback still wins before any repair or next phase", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runWorkflow(
      run(
        `return await repairUntilPass({reviewers:[{id:'r',run:async()=>{try{await agent('review')}catch{}return ${pass};}}],checks:[${command()}],repair:()=> 'bad'});phase('Next');`,
      ),
      {
        ...options,
        signal: controller.signal,
        agent: {
          async run() {
            controller.abort();
            return "ignored";
          },
        },
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
});

test("schema and routing failures produce missing-evidence VERIFICATION_FAILED", async () => {
  for (const code of [WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, WorkflowErrorCode.MODEL_NOT_FOUND]) {
    await assert.rejects(
      runWorkflow(
        run(
          `return await repairUntilPass({reviewers:[{id:'r',run:()=>agent('review')}],checks:[${command()}],repair:()=> 'bad'});`,
        ),
        {
          ...options,
          agent: {
            async run() {
              throw new WorkflowError("unusable review", code);
            },
          },
        },
      ),
      (error: unknown) => {
        if (!(error instanceof WorkflowError)) return false;
        assert.equal(error.code, WorkflowErrorCode.VERIFICATION_FAILED);
        assert.equal(
          (error.details as { report: { reviewers: Array<{ verdict: string }> } }).report.reviewers[0].verdict,
          "ERROR",
        );
        return true;
      },
    );
  }
});

test("nested repair gates revalidate on resume and invalidate later parent replay", async () => {
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const child = run(
    `return await repairUntilPass({reviewers:[{id:'r',run:()=>agent('review')}],checks:[${command()}],repair:()=> 'fixed'});`,
  );
  const script = run("await agent('before');await workflow('child');return await agent('after');");
  const settings = {
    ...options,
    runId: "nested-repair",
    loadSavedWorkflow: () => child,
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        return prompt === "review" ? { verdict: "PASS", findings: [] } : "ok";
      },
    },
  };
  await runWorkflow(script, { ...settings, onAgentJournal: (entry) => journal.push(entry) });
  prompts.length = 0;
  await runWorkflow(script, {
    ...settings,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.deepEqual(prompts, ["review", "after"]);
});

test("unawaited repair failures cannot produce terminal success or advance phases", async () => {
  await assert.rejects(
    runWorkflow(run(`void repairUntilPass(${plan("maxRepairs:0", fail)});return 'not shipped';`), options),
    codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
  );
  const phases: string[] = [];
  await assert.rejects(
    runWorkflow(run(`void repairUntilPass(${plan()});phase('Next');return 'not shipped';`), {
      ...options,
      onPhase: (phase) => phases.push(phase),
    }),
    codeIs(WorkflowErrorCode.SCRIPT_VALIDATION_ERROR),
  );
  assert.equal(phases.includes("Next"), false);
  await assert.rejects(
    runWorkflow(
      run(`try {await repairUntilPass(${plan("maxRepairs:0", fail)});}catch{}return 'not shipped';`),
      options,
    ),
    codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
  );
});

test("unawaited reviewer abort before any check cannot resolve the workflow as success", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runWorkflow(
      run(
        `void repairUntilPass({reviewers:[{id:'r',run:()=>agent('review')}],checks:[${command()}],repair:()=> 'bad'});return 'not shipped';`,
      ),
      {
        ...options,
        signal: controller.signal,
        agent: {
          async run() {
            controller.abort();
            return { verdict: "PASS", findings: [] };
          },
        },
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED,
  );
});

test("invalid helper plans return rejected promises but cannot be caught into success", async () => {
  let caught = false;
  await assert.rejects(
    runWorkflow(run(`await repairUntilPass({}).catch(()=>agent('caught'));return 'not shipped';`), {
      ...options,
      agent: {
        async run() {
          caught = true;
          return "caught";
        },
      },
    }),
    codeIs(WorkflowErrorCode.SCRIPT_VALIDATION_ERROR),
  );
  assert.equal(caught, true);
});

test("falsy repair throws remain sticky when the helper was not awaited", async () => {
  for (const value of ["undefined", "null", "false", "0", "''"]) {
    await assert.rejects(
      runWorkflow(
        run(`void repairUntilPass({...${plan("", fail)},repair:()=>{throw ${value};}});return 'not shipped';`),
        options,
      ),
    );
  }
});

test("failed child repair gates block parent phase transitions and terminal success", async () => {
  const child = run(`try{await repairUntilPass(${plan("maxRepairs:0", fail)});}catch{}return 'child handled';`);
  for (const next of ["return 'not shipped';", "phase('Next');return 'not shipped';"]) {
    const phases: string[] = [];
    await assert.rejects(
      runWorkflow(run(`try{await workflow('child');}catch{}${next}`), {
        ...options,
        loadSavedWorkflow: () => child,
        onPhase: (phase) => phases.push(phase),
      }),
      codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
    );
    assert.equal(phases.includes("Next"), false);
  }
  const unawaitedChild = run(`void repairUntilPass(${plan("maxRepairs:0", fail)});return 'unawaited child';`);
  await assert.rejects(
    runWorkflow(run("await workflow('child');return 'not shipped';"), {
      ...options,
      loadSavedWorkflow: () => unawaitedChild,
    }),
    codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
  );
});

test("round log previews stay bounded with large findings", async () => {
  const logs: string[] = [];
  await assert.rejects(
    runWorkflow(
      run(`return await repairUntilPass(${plan("maxRepairs:0", `{verdict:'FAIL',findings:['界'.repeat(10000)]}`)});`),
      {
        ...options,
        onLog: (line) => logs.push(line),
      },
    ),
    codeIs(WorkflowErrorCode.REPAIR_LIMIT_EXCEEDED),
  );
  const rounds = logs.filter((line) => line.startsWith('{"type":"repair-round"'));
  assert.equal(rounds.length, 1);
  assert.ok(Buffer.byteLength(rounds[0]) <= 4096);
  assert.equal(JSON.parse(rounds[0]).truncated, true);
});
