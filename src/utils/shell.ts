import { exec } from "node:child_process";
import { env, ensureConfigured } from "../config/env";

export async function run(cmd: string, cwd = env.REPO, timeoutMs?: number) {
  ensureConfigured("REPO_PATH", cwd);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(
      cmd,
      { cwd, maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const message = stderr || err.message || "command failed";
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
