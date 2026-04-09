import { Request, Response } from "express";
import { env, getAllModuleNames, resolveModule } from "../config/env";
import {
  acquireFeishuEventLock,
  safeReply,
} from "../services/feishu.service";
import { buildRelease, deployRelease, releasePipeline } from "../services/release.service";
import {
  extractModuleArg,
  getCommandErrorHelpText,
  getCommandHelpText,
  normalizeCommandText,
  trimOutput,
} from "../utils/text";

export async function feishuWebhookController(req: Request, res: Response) {
  console.log("feishu body1:", JSON.stringify(req.body));
  try {
    if (req.body?.challenge) return res.json({ challenge: req.body.challenge });

    const eventId =
      (req.body?.header?.event_id as string | undefined) ||
      (req.body?.event?.message?.message_id as string | undefined) ||
      "";
    if (!eventId) return res.status(400).json({ ok: false, message: "missing event id" });

    if (!acquireFeishuEventLock(eventId)) {
      console.log("duplicate feishu event ignored:", eventId);
      return res.json({ ok: true, duplicate: true, eventId });
    }

    res.json({ ok: true, accepted: true, eventId });

    (async () => {
      try {
        console.log("feishu body:", JSON.stringify(req.body));
        const rawContent = req.body?.event?.message?.content || "";
        let text = "";
        try {
          const parsed = typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
          text = parsed?.text || "";
        } catch {
          text = typeof rawContent === "string" ? rawContent : "";
        }

        const normalized = normalizeCommandText(String(text));
        const messageId = req.body?.event?.message?.message_id as string | undefined;
        const chatId = req.body?.event?.message?.chat_id as string | undefined;
        console.log("feishu text:", normalized);

        const buildModuleName = extractModuleArg(normalized, "打包");
        const deployModuleName = extractModuleArg(normalized, "部署");

        let replyText = "unknown command";
        if (normalized === "指令" || normalized === "帮助" || normalized === "help") {
          replyText = getCommandHelpText();
        } else if (normalized.includes("打包")) {
          const result = await buildRelease(buildModuleName);
          replyText = `打包结果${result.module ? `(${result.module})` : ""}:\n${trimOutput(result.stdout || result.stderr)}`;
        } else if (normalized.includes("部署")) {
          const result = await deployRelease(deployModuleName);
          replyText = `部署结果${result.module ? `(${result.module})` : ""}:\n${trimOutput(result.stdout || result.stderr)}`;
        } else if (normalized.startsWith("发布")) {
          let rest = normalized.replace(/^发布\s*/, "").trim();
          let confirmToken = "";
          let releaseModuleName: string | undefined;
          const firstWord = rest.split(/\s+/).filter(Boolean)[0] || "";
          if (resolveModule(firstWord).module) {
            releaseModuleName = firstWord;
            rest = rest.replace(new RegExp(`^${firstWord}\\s*`), "").trim();
          } else if (firstWord === "全部") {
            releaseModuleName = "all";
            rest = rest.replace(/^全部\s*/, "").trim();
          }
          if (rest.includes("确认码")) {
            const parts = rest.split("确认码");
            confirmToken = (parts[1] || "").trim();
          }
          if (env.RELEASE_CONFIRM_TOKEN && confirmToken !== env.RELEASE_CONFIRM_TOKEN) {
            throw new Error("发布失败: 缺少或错误的确认码");
          }
          const moduleNames =
            releaseModuleName === "all"
              ? getAllModuleNames()
              : releaseModuleName
                ? [releaseModuleName]
                : getAllModuleNames();
          const output = await releasePipeline({
            moduleNames,
          });
          replyText = `发布完成:\n${trimOutput(output)}`;
        } else {
          replyText = getCommandErrorHelpText(normalized);
        }

        await safeReply({ messageId, chatId, text: replyText });
      } catch (err: any) {
        console.error("feishu async worker error:", err);
        try {
          const messageId = req.body?.event?.message?.message_id as string | undefined;
          const chatId = req.body?.event?.message?.chat_id as string | undefined;
          await safeReply({
            messageId,
            chatId,
            text: `执行失败: ${String(err?.message || err)}`,
          });
        } catch (notifyErr) {
          console.error("feishu async worker notify error:", notifyErr);
        }
      }
    })();
    return;
  } catch (e: any) {
    console.error("feishu webhook error:", e);
    return res.status(500).json({ ok: false, message: e.message });
  }
}
