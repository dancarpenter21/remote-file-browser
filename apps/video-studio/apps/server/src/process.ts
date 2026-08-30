import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
}

export function runProcess(executable: string, args: string[], options: RunOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      options.onStdout?.(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const abort = () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      timer.unref();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort);
      const stderrText = Buffer.concat(stderr).toString();
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr: stderrText });
      else reject(new Error(options.signal?.aborted ? "Render cancelled." : `Media process failed (${signal ?? code}).\n${stderrText.slice(-4000)}`));
    });
  });
}
