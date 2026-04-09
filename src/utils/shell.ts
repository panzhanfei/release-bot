import { exec } from "node:child_process";
import { env } from "../config/env";

export async function run(cmd: string, cwd = env.REPO, timeoutMs?: number) {
  if (!cwd) {
    throw new Error("missing shell working directory (cwd)");
  }
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(
      cmd,
      { cwd, maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const parts = [stderr?.trim(), stdout?.trim(), err.message?.trim()].filter(Boolean);
          const message = parts.length ? parts.join("\n---\n") : "command failed";
          if ((err as any).killed && timeoutMs) {
            return reject(new Error(`command timeout after ${Math.ceil(timeoutMs / 1000)}s: ${message}`));
          }
          return reject(new Error(message));
        }
        resolve({ stdout, stderr });
      }
    );
  });
}
