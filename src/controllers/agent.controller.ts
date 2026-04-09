import { Request, Response } from "express";
import { env, getAllModuleNames } from "../config/env";
import {
  buildRelease,
  deployRelease,
  releasePipeline,
} from "../services/release.service";

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

    const { action, confirmToken, moduleName } =
      req.body as {
        action:
          | "build-release"
          | "deploy-release"
          | "release";
        confirmToken?: string;
        moduleName?: string;
      };

    if (action === "build-release") {
      return res.json({ ok: true, action, ...(await buildRelease(moduleName)) });
    }

    if (action === "deploy-release") {
      return res.json({ ok: true, action, ...(await deployRelease(moduleName)) });
    }

    if (action === "release") {
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

    return res.status(400).json({ ok: false, message: "invalid action" });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e.message });
  }
}
