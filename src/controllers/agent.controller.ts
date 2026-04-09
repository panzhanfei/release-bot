import { Request, Response } from "express";
import { env, getAllModuleNames, resolveModule } from "../config/env";
import {
  buildRelease,
  deployRelease,
  releasePipeline,
} from "../services/release.service";
import {
  assertReleaseNotPaused,
  setReleasePaused,
} from "../state/releasePause";
import { safeGitRef } from "../utils/text";

export function auth(req: Request, res: Response): boolean {
  const token = req.header("x-agent-token");
  if (token !== env.TOKEN) {
    res.status(401).json({ ok: false, message: "unauthorized" });
    return false;
  }
  return true;
}

export async function runActionController(req: Request, res: Response) {
  try {
    if (!auth(req, res)) return;

    const { action, confirmToken, moduleName, gitRef } =
      req.body as {
        action:
          | "build-release"
          | "deploy-release"
          | "release"
          | "rollback-release"
          | "pause-release"
          | "resume-release";
        confirmToken?: string;
        moduleName?: string;
        gitRef?: string;
      };

    if (action === "pause-release") {
      const { changed } = await setReleasePaused(true);
      return res.json({ ok: true, action, paused: true, changed });
    }

    if (action === "resume-release") {
      const { changed } = await setReleasePaused(false);
      return res.json({ ok: true, action, paused: false, changed });
    }

    if (action === "build-release") {
      return res.json({ ok: true, action, ...(await buildRelease(moduleName)) });
    }

    if (action === "deploy-release") {
      await assertReleaseNotPaused("deploy-release");
      return res.json({ ok: true, action, ...(await deployRelease(moduleName)) });
    }

    if (action === "release") {
      await assertReleaseNotPaused("release");
      if (env.RELEASE_CONFIRM_TOKEN && confirmToken !== env.RELEASE_CONFIRM_TOKEN) {
        return res.status(403).json({ ok: false, message: "invalid release confirm token" });
      }
      const moduleNames =
        moduleName === "all"
          ? getAllModuleNames()
          : moduleName
            ? [moduleName]
            : getAllModuleNames();
      const output = await releasePipeline({
        moduleNames,
      });
      return res.json({ ok: true, action, output });
    }

    if (action === "rollback-release") {
      await assertReleaseNotPaused("rollback-release");
      if (env.RELEASE_CONFIRM_TOKEN && confirmToken !== env.RELEASE_CONFIRM_TOKEN) {
        return res.status(403).json({ ok: false, message: "invalid release confirm token" });
      }
      const ref = safeGitRef(String(gitRef || ""));
      const mod = moduleName === "all" ? "all" : moduleName || "";
      if (mod !== "all" && !resolveModule(mod).module) {
        return res.status(400).json({ ok: false, message: "unknown moduleName" });
      }
      const moduleNames =
        mod === "all"
          ? getAllModuleNames()
          : mod
            ? [mod]
            : getAllModuleNames();
      const output = await releasePipeline({ moduleNames, gitRef: ref });
      return res.json({ ok: true, action, output, gitRef: ref });
    }

    return res.status(400).json({ ok: false, message: "invalid action" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
