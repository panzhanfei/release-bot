import express from "express";
import { runActionController } from "../controllers/agent.controller";
import { feishuWebhookController } from "../controllers/feishu.controller";

export function createRouter() {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "release-bot" });
  });
  router.post("/run", runActionController);
  router.post("/feishu/webhook", feishuWebhookController);

  return router;
}
