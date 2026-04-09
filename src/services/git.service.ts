import { env } from "../config/env";
import { run } from "../utils/shell";

export async function status() {
  return run("git status --short");
}

export async function createBranch(branch: string) {
  if (!branch) throw new Error("branch required");
  return run(`git checkout -b ${branch}`);
}

export async function commitAll(message: string) {
  if (!message) throw new Error("message required");
  await run("git add .");
  return run(`git commit -m "${message.replace(/"/g, '\\"')}"`);
}

export async function push() {
  if (!env.ALLOW_PUSH) throw new Error("push disabled");
  return run("git push");
}
