import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { type JournalEntry, runWorkflow } from "../src/workflow.js";
import { checkAuditEntry, executeRunCheck, validateRunCheck } from "../src/workflow-check.js";

const meta = `export const meta = { name: 'check_test', description: 'mechanical checks' };`;
const runner = {
  async run(prompt: string) {
    return `ran:${prompt}`;
  },
};
const check = (code: string, extra: Record<string, unknown> = {}) => ({
  id: "test",
  command: process.execPath,
  args: ["-e", code],
  ...extra,
});
const run = (body: string) => `${meta}\n${body}`;
const isAbort = (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED;
const execute = (code: string, extra: Record<string, unknown> = {}, signals: AbortSignal[] = []) =>
  executeRunCheck(validateRunCheck(check(code, extra), process.cwd()), signals);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // An orphan zombie has exited and cannot execute work, although kill(0) succeeds.
    if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    return true;
  } catch {
    return false;
  }
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
function cleanPid(file: string) {
  if (!existsSync(file)) return;
  try {
    process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
  } catch {
    /* already dead */
  }
}

test("runCheck reports quiet exit-zero PASS and nonzero FAIL with genuine output", async () => {
  const quiet = await execute("");
  assert.equal(quiet.status, "PASS");
  assert.equal(quiet.exitCode, 0);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.timedOut, false);
  const fail = await execute("process.stdout.write('out');process.stderr.write('err');process.exitCode=7");
  assert.equal(fail.status, "FAIL");
  assert.equal(fail.exitCode, 7);
  assert.equal(fail.stdout, "out");
  assert.equal(fail.stderr, "err");
  assert.ok(fail.durationMs >= 0);
  assert.equal(fail.signal, null);
});

test("runCheck reports spawn failures and unexpected signals as ERROR", async () => {
  const missing = await execute("", { command: "pi-check-nonexistent-command-17382" });
  assert.equal(missing.status, "ERROR");
  assert.equal(missing.exitCode, null);
  assert.match(missing.error ?? "", /ENOENT/);
  if (process.platform !== "win32") {
    const killed = await execute("process.kill(process.pid, 'SIGKILL')");
    assert.equal(killed.status, "ERROR");
    assert.equal(killed.signal, "SIGKILL");
  }
});

test("runCheck validates options strictly before spawning and snapshots args", () => {
  for (const bad of [
    null,
    [],
    {},
    { ...check(""), id: " " },
    { ...check(""), command: " " },
    { ...check(""), args: [1] },
    { ...check(""), args: Array(1) },
    { ...check(""), cwd: "" },
    { ...check(""), timeout: 2 },
    { ...check(""), id: "id\0bad" },
    { ...check(""), command: "node\0bad" },
    { ...check(""), args: ["\0"] },
    { ...check(""), cwd: "bad\0cwd" },
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "20"].map((timeoutMs) => ({ ...check(""), timeoutMs })),
  ]) {
    assert.throws(
      () => validateRunCheck(bad as never, process.cwd()),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        !error.recoverable,
    );
  }
  const input = check("");
  const validated = validateRunCheck(input, process.cwd());
  input.args.push("changed");
  assert.equal(validated.args.length, 2);
  assert.equal(validated.timeoutMs, 120_000);
});

test("sandbox binds runCheck, resolves cwd relative to invocation, and does not invoke an agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-check-cwd-"));
  mkdirSync(join(root, "child"));
  let calls = 0;
  try {
    const result = await runWorkflow<{ stdout: string; cwd: string }>(
      run(`return await runCheck(${JSON.stringify(check("process.stdout.write(process.cwd())", { cwd: "child" }))})`),
      {
        cwd: root,
        persistLogs: false,
        agent: {
          async run() {
            calls++;
            return "unused";
          },
        },
      },
    );
    assert.equal(result.result.cwd, join(root, "child"));
    assert.equal(result.result.stdout, join(root, "child"));
    assert.equal(result.agentCount, 0);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCheck bounds actual output and retains UTF-8 tails without replacement characters", async () => {
  for (const unit of ["x", "界", "😀"]) {
    const output = await execute(
      `process.stdout.write(${JSON.stringify(unit)}.repeat(40000));process.stderr.write('e'.repeat(40000))`,
    );
    assert.equal(output.status, "PASS");
    assert.equal(output.stdoutTruncated, true);
    assert.equal(output.stderrTruncated, true);
    assert.ok(Buffer.byteLength(output.stdout) <= 32 * 1024);
    assert.ok(Buffer.byteLength(output.stderr) <= 32 * 1024);
    assert.ok(output.stdout.endsWith(unit));
    assert.equal(output.stdout.includes("\ufffd"), false);
  }
  const binary = await execute("process.stdout.write(Buffer.alloc(32000,255))");
  assert.ok(Buffer.byteLength(binary.stdout) <= 32 * 1024);
});

test("timeout terminates the check and reports ERROR", async () => {
  const result = await execute("setInterval(()=>{},1000)", { timeoutMs: 100 });
  assert.equal(result.status, "ERROR");
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 3000);
});

test("timeout kills TERM-ignoring grandchildren in the spawned process group", {
  skip: process.platform === "win32",
  timeout: 15000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-check-grandchild-"));
  const pidFile = join(root, "grandchild-pid");
  const grandchild = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
  const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  try {
    const result = await execute(parent, { timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    assert.equal(result.status, "ERROR");
    assert.ok(existsSync(pidFile), "grandchild started before the timeout");
    await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  } finally {
    cleanPid(pidFile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("external cancellation throws WORKFLOW_ABORTED and restores temporary host listeners", async () => {
  const signals = ["exit", "SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"];
  const before = signals.map((signal) => process.listenerCount(signal));
  const controller = new AbortController();
  const pending = execute("setInterval(()=>{},1000)", {}, [controller.signal]);
  controller.abort();
  await assert.rejects(pending, isAbort);
  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    before,
  );
  await assert.rejects(execute("", {}, [controller.signal]), isAbort);
  await execute("");
  assert.deepEqual(
    signals.map((signal) => process.listenerCount(signal)),
    before,
  );
});

for (const termination of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"] as const) {
  test(`host ${termination} terminates detached checks`, {
    skip: process.platform === "win32",
    timeout: 10000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-check-host-"));
    const pidFile = join(root, "pid");
    const moduleUrl = new URL("../src/workflow-check.ts", import.meta.url).href;
    const command = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const body = `import {executeRunCheck,validateRunCheck} from ${JSON.stringify(moduleUrl)};
void executeRunCheck(validateRunCheck(${JSON.stringify(check(command))},process.cwd()),[]);`;
    const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], { stdio: "ignore" });
    const closed = once(host, "close");
    try {
      await waitFor(() => existsSync(pidFile));
      host.kill(termination);
      const [, signal] = await closed;
      assert.equal(signal, termination);
      await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    } finally {
      host.kill("SIGKILL");
      cleanPid(pidFile);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("normal host process.exit kills checks and existing host signal policy is preserved", {
  skip: process.platform === "win32",
  timeout: 10000,
}, async () => {
  for (const policy of ["exit", "handler"]) {
    const root = mkdtempSync(join(tmpdir(), "pi-check-policy-"));
    const pidFile = join(root, "pid");
    const moduleUrl = new URL("../src/workflow-check.ts", import.meta.url).href;
    const command = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const body = `import {existsSync} from 'node:fs';import {executeRunCheck,validateRunCheck} from ${JSON.stringify(moduleUrl)};
${policy === "handler" ? "process.on('SIGTERM',()=>setTimeout(()=>process.exit(23),20));" : ""}
void executeRunCheck(validateRunCheck(${JSON.stringify(check(command))},process.cwd()),[]);
${policy === "exit" ? `setInterval(()=>{if(existsSync(${JSON.stringify(pidFile)}))process.exit(17)},10)` : ""}`;
    const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], { stdio: "ignore" });
    const closed = once(host, "close");
    try {
      if (policy === "handler") {
        await waitFor(() => existsSync(pidFile));
        host.kill("SIGTERM");
      }
      const [code] = await closed;
      assert.equal(code, policy === "exit" ? 17 : 23);
      await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
    } finally {
      host.kill("SIGKILL");
      cleanPid(pidFile);
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("checks rerun on resume and invalidate later agent and checkpoint replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-check-resume-"));
  const file = join(root, "executions");
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const script =
    run(`await agent('before'); await runCheck(${JSON.stringify(check(`require('fs').appendFileSync(${JSON.stringify(file)},'x')`))});
await agent('after'); return await checkpoint('confirm', {default:false});`);
  let confirms = 0;
  const options = {
    runId: "check-resume",
    persistLogs: false,
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        return prompt;
      },
    },
    confirm: async () => {
      confirms++;
      return true;
    },
  };
  try {
    await runWorkflow(script, { ...options, onAgentJournal: (entry) => journal.push(entry) });
    prompts.length = 0;
    await runWorkflow(script, {
      ...options,
      resumeFromRunId: options.runId,
      resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    });
    assert.equal(readFileSync(file, "utf8"), "xx");
    assert.deepEqual(prompts, ["after"]);
    assert.equal(confirms, 2);
    assert.deepEqual(
      journal.map((entry) => entry.index),
      [0, 2, 3],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a nested check invalidates later parent and nested agent replay", async () => {
  const journal: JournalEntry[] = [];
  const prompts: string[] = [];
  const child = run(`await runCheck(${JSON.stringify(check(""))});return await agent('child-after');`);
  const parent = run("await agent('parent-before');await workflow('child');return await agent('parent-after');");
  const options = {
    runId: "nested-check",
    persistLogs: false,
    agent: {
      async run(prompt: string) {
        prompts.push(prompt);
        return prompt;
      },
    },
    loadSavedWorkflow: () => child,
  };
  await runWorkflow(parent, { ...options, onAgentJournal: (entry) => journal.push(entry) });
  prompts.length = 0;
  await runWorkflow(parent, {
    ...options,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.deepEqual(prompts, ["child-after", "parent-after"]);
});

test("an awaited parent check invalidates child workflow replay", async () => {
  const journal: JournalEntry[] = [];
  let calls = 0;
  const script = run(
    `await agent('before');await runCheck(${JSON.stringify(check(""))});return await workflow('child');`,
  );
  const options = {
    runId: "parent-check",
    persistLogs: false,
    agent: {
      async run() {
        calls++;
        return "ok";
      },
    },
    loadSavedWorkflow: () => run("return await agent('child');"),
  };
  await runWorkflow(script, { ...options, onAgentJournal: (entry) => journal.push(entry) });
  calls = 0;
  await runWorkflow(script, {
    ...options,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(calls, 1);
});

test("unawaited checks are drained before successful completion", async () => {
  const started = Date.now();
  const result = await runWorkflow(
    run(
      `void runCheck(${JSON.stringify(check("setTimeout(()=>process.stdout.write('done'),100)"))});return 'finished';`,
    ),
    { agent: runner, persistLogs: false },
  );
  assert.equal(result.result, "finished");
  assert.ok(Date.now() - started >= 100);
  assert.ok(result.logs.some((line) => line.includes('"stdout":"done"')));
});

test("abort drains unawaited nested checks even with a short agent grace", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-check-drain-"));
  const pidFile = join(root, "pid");
  const controller = new AbortController();
  const child = run(
    `void runCheck(${JSON.stringify(check(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`))});return 'started';`,
  );
  const pending = runWorkflow(run("await workflow('child');return 'complete';"), {
    signal: controller.signal,
    drainAbortGraceMs: 1,
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: () => child,
  });
  const rejected = assert.rejects(pending, isAbort);
  try {
    await waitFor(() => existsSync(pidFile));
    controller.abort();
    await rejected;
    await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  } finally {
    controller.abort();
    cleanPid(pidFile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fatal script failure cancels in-flight checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-check-fatal-"));
  const pidFile = join(root, "pid");
  try {
    await assert.rejects(
      runWorkflow(
        run(`void runCheck(${JSON.stringify(check(`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`))});
await agent('fatal');`),
        {
          persistLogs: false,
          agent: {
            async run() {
              await waitFor(() => existsSync(pidFile));
              throw new WorkflowError("fatal", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
            },
          },
        },
      ),
      /fatal/,
    );
    await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  } finally {
    cleanPid(pidFile);
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic check logs have bounded previews and a shared aggregate audit budget", async () => {
  const result = await execute(
    "process.stdout.write('\\u0000'.repeat(40000));process.stderr.write('界'.repeat(40000))",
  );
  const entry = checkAuditEntry(result);
  assert.ok(Buffer.byteLength(entry) <= 4096);
  const preview = JSON.parse(entry);
  assert.ok(Buffer.byteLength(JSON.stringify(preview.stdout)) <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(preview.stderr)) <= 1024);
  const command = JSON.stringify(
    check("process.stdout.write('x'.repeat(40000));process.stderr.write('e'.repeat(40000))"),
  );
  const child = run(`for(let i=0;i<35;i++)await runCheck(${command});return 'child';`);
  const allLogs: string[] = [];
  // Child results forward through onLog, while frame-local logs stay on that frame.
  const observed = await runWorkflow(
    run(`for(let i=0;i<35;i++)await runCheck(${command});await workflow('child');return await runCheck(${command});`),
    {
      agent: runner,
      persistLogs: false,
      loadSavedWorkflow: () => child,
      onLog: (line) => allLogs.push(line),
    },
  );
  const audits = allLogs.filter((line) => line.startsWith('{"type":"check-'));
  assert.ok(audits.reduce((bytes, line) => bytes + Buffer.byteLength(line), 0) <= 128 * 1024);
  assert.equal(audits.filter((line) => line.includes('"type":"check-log-suppressed"')).length, 1);
  assert.ok(audits.every((line) => Buffer.byteLength(line) <= 4096));
  assert.equal((observed.result as { stdout: string }).stdout.length, 32768, "returned evidence is not suppressed");
});
