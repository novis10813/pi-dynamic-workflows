import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
const OUTPUT_LIMIT = 32 * 1024;
const KILL_GRACE_MS = 250;
// These temporary hooks cover normal host shutdown, not arbitrary fatal signals
// or crashes. Existing host signal handlers retain their termination policy.
const activeChecks = new Set();
const hostSignalHandlers = new Map(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR2"].map((signal) => [
    signal,
    () => onHostSignal(signal),
]));
function killActiveChecks() {
    for (const kill of activeChecks)
        kill();
}
function onHostSignal(signal) {
    const ours = hostSignalHandlers.get(signal);
    const hostOwnsSignal = process.listeners(signal).some((listener) => listener !== ours);
    killActiveChecks();
    if (!hostOwnsSignal) {
        process.removeListener(signal, ours);
        process.kill(process.pid, signal);
    }
}
function trackCheck(kill) {
    if (activeChecks.size === 0) {
        process.on("exit", killActiveChecks);
        for (const [signal, handler] of hostSignalHandlers)
            process.on(signal, handler);
    }
    activeChecks.add(kill);
    return () => {
        activeChecks.delete(kill);
        if (activeChecks.size === 0) {
            process.removeListener("exit", killActiveChecks);
            for (const [signal, handler] of hostSignalHandlers)
                process.removeListener(signal, handler);
        }
    };
}
/** Preserve a UTF-8 tail without a cut leading codepoint, including after binary decoding. */
function utf8Tail(bytes, limit) {
    let start = Math.max(0, bytes.length - limit);
    if (start > 0) {
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
            start++;
    }
    const decoded = bytes.subarray(start).toString("utf8");
    const encoded = Buffer.from(decoded);
    if (encoded.length <= limit)
        return decoded;
    start = encoded.length - limit;
    while (start < encoded.length && (encoded[start] & 0xc0) === 0x80)
        start++;
    return encoded.subarray(start).toString("utf8");
}
/** Compact serialized previews also bound JSON escaping, not just source text. */
export function checkAuditEntry(result) {
    const preview = (value, limit) => {
        let text = utf8Tail(Buffer.from(value), limit);
        while (Buffer.byteLength(JSON.stringify(text)) > limit) {
            text = Array.from(text).slice(1).join("");
        }
        return text;
    };
    return JSON.stringify({
        type: "check-result",
        id: preview(result.id, 128),
        command: preview(result.command, 256),
        cwd: preview(result.cwd, 256),
        status: result.status,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: preview(result.stdout, 1024),
        stderr: preview(result.stderr, 1024),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        ...(result.error ? { error: preview(result.error, 512) } : {}),
    });
}
/** Validate synchronously, including calls whose returned promise is never awaited. */
export function validateRunCheck(input, workflowCwd) {
    const invalid = (message) => {
        throw new WorkflowError(`runCheck() ${message}`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
            recoverable: false,
        });
    };
    const nonblank = (value) => typeof value === "string" && value.trim().length > 0;
    if (!input || typeof input !== "object" || Array.isArray(input))
        invalid("requires an options object");
    const allowed = new Set(["id", "command", "args", "cwd", "timeoutMs"]);
    if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !allowed.has(key)))
        invalid("contains unknown options");
    if (!nonblank(input.id))
        invalid("id must be a nonblank string");
    if (!nonblank(input.command))
        invalid("command must be a nonblank string");
    if (input.args !== undefined &&
        (!Array.isArray(input.args) || !Array.from(input.args).every((v) => typeof v === "string")))
        invalid("args must be an array of strings");
    if (input.cwd !== undefined && !nonblank(input.cwd))
        invalid("cwd must be a nonblank string");
    if ([input.id, input.command, ...(input.args ?? []), input.cwd ?? workflowCwd].some((value) => value.includes("\0")))
        invalid("id, command, args, and cwd must not contain NUL");
    const timeoutMs = input.timeoutMs === undefined ? 120_000 : input.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
        invalid("timeoutMs must be a positive finite integer");
    return {
        id: input.id,
        command: input.command,
        args: [...(input.args ?? [])],
        cwd: resolve(workflowCwd, input.cwd ?? "."),
        timeoutMs,
    };
}
/** Host-only execution: no model, shell, journal, or accumulated output chunks. */
export async function executeRunCheck(options, signals) {
    const aborted = () => signals.some((signal) => signal.aborted);
    const abortError = () => new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    if (aborted())
        throw abortError();
    const started = Date.now();
    return new Promise((resolveResult, reject) => {
        const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        const truncated = { stdout: false, stderr: false };
        const append = (stream, data) => {
            truncated[stream] ||= tails[stream].length + data.length > OUTPUT_LIMIT;
            // Retain up to three extra bytes so decoding can locate a cut UTF-8 boundary.
            const retained = OUTPUT_LIMIT + 3;
            tails[stream] = Buffer.from(Buffer.concat([tails[stream], data.subarray(-retained)]).subarray(-retained));
        };
        let exitCode = null;
        let signal = null;
        let timedOut = false;
        let child;
        try {
            child = spawn(options.command, options.args, {
                cwd: options.cwd,
                shell: false,
                detached: process.platform !== "win32",
                stdio: ["ignore", "pipe", "pipe"],
            });
        }
        catch (error) {
            if (aborted())
                return reject(abortError());
            return resolveResult(result(String(error)));
        }
        let error;
        let settled = false;
        let terminating = false;
        let closed = false;
        let timeout;
        let killTimer;
        let finishTimer;
        const untrack = trackCheck(() => kill("SIGKILL"));
        function result(failure) {
            return {
                id: options.id,
                command: options.command,
                args: options.args,
                cwd: options.cwd,
                status: failure || timedOut || signal ? "ERROR" : exitCode === 0 ? "PASS" : "FAIL",
                exitCode,
                signal,
                timedOut,
                durationMs: Date.now() - started,
                stdout: utf8Tail(tails.stdout, OUTPUT_LIMIT),
                stderr: utf8Tail(tails.stderr, OUTPUT_LIMIT),
                stdoutTruncated: truncated.stdout,
                stderrTruncated: truncated.stderr,
                ...(failure ? { error: failure } : {}),
            };
        }
        function finish() {
            if (settled)
                return;
            settled = true;
            untrack();
            clearTimeout(timeout);
            clearTimeout(killTimer);
            clearTimeout(finishTimer);
            for (const source of signals)
                source.removeEventListener("abort", onAbort);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (aborted())
                reject(abortError());
            else
                resolveResult(result(error));
        }
        function kill(kind) {
            try {
                if (process.platform !== "win32" && child.pid)
                    process.kill(-child.pid, kind);
                else
                    child.kill(kind);
            }
            catch (failure) {
                if (failure.code !== "ESRCH")
                    error ??= String(failure);
            }
        }
        function terminate() {
            if (terminating || settled)
                return;
            terminating = true;
            clearTimeout(timeout);
            kill("SIGTERM");
            // Keep the group escalation even if the direct child closes first: its
            // descendants may ignore TERM or have inherited the output descriptors.
            killTimer = setTimeout(() => {
                kill("SIGKILL");
                if (closed)
                    finish();
                else
                    finishTimer = setTimeout(finish, KILL_GRACE_MS);
            }, KILL_GRACE_MS);
        }
        function onAbort() {
            terminate();
        }
        child.stdout?.on("data", (data) => append("stdout", data));
        child.stderr?.on("data", (data) => append("stderr", data));
        child.on("error", (failure) => {
            error = failure.message;
        });
        child.on("exit", (code, exitSignal) => {
            exitCode = code;
            signal = exitSignal;
            // Clean up background descendants even after an ordinary direct-child exit.
            if (process.platform !== "win32" && child.pid) {
                try {
                    process.kill(-child.pid, 0);
                    terminate();
                }
                catch {
                    /* group already gone */
                }
            }
        });
        child.on("close", (code, exitSignal) => {
            exitCode = child.pid ? code : null;
            signal = exitSignal;
            closed = true;
            if (!terminating)
                finish();
        });
        for (const source of signals)
            source.addEventListener("abort", onAbort, { once: true });
        // Node timers overflow above 2^31-1; re-arm against the absolute deadline.
        const armTimeout = () => {
            const remaining = options.timeoutMs - (Date.now() - started);
            if (remaining <= 0) {
                timedOut = true;
                error ??= "command timed out";
                terminate();
            }
            else
                timeout = setTimeout(armTimeout, Math.min(remaining, 2_147_483_647));
        };
        armTimeout();
        if (aborted())
            onAbort();
    });
}
