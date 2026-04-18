import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  orderedTargetsForDeploy,
  releasePipeline,
} from "../src/services/release.service";
import { run } from "../src/utils/shell";

vi.mock("../src/utils/shell", () => ({
  run: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs/promises")>();
  return { ...mod, access: vi.fn() };
});

const mockedRun = vi.mocked(run);
const mockedAccess = vi.mocked(access);

function gitOkMocks() {
  mockedRun.mockImplementation(async (cmd: string) => {
    if (cmd.includes("git rev-parse --is-inside-work-tree")) {
      return { stdout: "true\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });
}

describe("orderedTargetsForDeploy", () => {
  it("places server first when present", () => {
    expect(orderedTargetsForDeploy(["main-next", "server", "sub-vue"])).toEqual([
      "server",
      "main-next",
      "sub-vue",
    ]);
  });

  it("leaves order unchanged when server absent", () => {
    expect(orderedTargetsForDeploy(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("releasePipeline (contract, mocked I/O)", () => {
  beforeEach(() => {
    gitOkMocks();
    mockedAccess.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs full publish for all modules: install once, build each, deploy server before main-next", async () => {
    const rsyncOrder: string[] = [];
    mockedRun.mockImplementation(async (cmd: string) => {
      if (cmd.includes("git rev-parse --is-inside-work-tree")) {
        return { stdout: "true\n", stderr: "" };
      }
      if (cmd.startsWith("rsync -azL") && cmd.includes("127.0.0.1")) {
        if (cmd.includes("/remote/server/")) rsyncOrder.push("server");
        if (cmd.includes("/remote/main-next/")) rsyncOrder.push("main-next");
      }
      return { stdout: "", stderr: "" };
    });

    const out = await releasePipeline({
      moduleNames: ["main-next", "server"],
    });

    expect(out).toContain("【1 拉取代码】完成");
    expect(out).toContain("【2 安装与 packages 构建】");
    expect(out).toContain("【3 打包】");
    expect(out).toContain("【4 上传 / 远程命令 / 重启】");
    expect(rsyncOrder).toEqual(["server", "main-next"]);
  });

  it("rollback path: passes git ref into hard reset", async () => {
    const cmds: string[] = [];
    mockedRun.mockImplementation(async (cmd: string) => {
      cmds.push(cmd);
      if (cmd.includes("git rev-parse --is-inside-work-tree")) {
        return { stdout: "true\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    await releasePipeline({
      moduleNames: ["server"],
      gitRef: "v1.2.3",
    });

    expect(cmds.some((c) => c.includes("git reset --hard") && c.includes("v1.2.3"))).toBe(
      true
    );
  });
});
