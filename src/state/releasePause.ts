import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE_DIR = path.join(process.cwd(), ".data");
const DEFAULT_STATE_FILE = path.join(DEFAULT_STATE_DIR, "release-pause.json");

type StateFile = { paused: boolean; updatedAt?: string };

async function readState(): Promise<StateFile> {
  try {
    const raw = await readFile(DEFAULT_STATE_FILE, "utf8");
    const j = JSON.parse(raw) as StateFile;
    return typeof j?.paused === "boolean" ? j : { paused: false };
  } catch {
    return { paused: false };
  }
}

async function writeState(paused: boolean) {
  await mkdir(DEFAULT_STATE_DIR, { recursive: true });
  const body: StateFile = {
    paused,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(DEFAULT_STATE_FILE, `${JSON.stringify(body, null, 0)}\n`, "utf8");
}

export async function isReleasePaused(): Promise<boolean> {
  const s = await readState();
  return s.paused;
}

export async function setReleasePaused(paused: boolean): Promise<{ changed: boolean }> {
  const cur = await readState();
  if (cur.paused === paused) return { changed: false };
  await writeState(paused);
  return { changed: true };
}

export async function assertReleaseNotPaused(op: string) {
  if (await isReleasePaused()) {
    throw new Error(
      `${op}已暂停：请稍后或联系管理员发送「恢复」或「恢复发布」后再试`
    );
  }
}
