import { Request, Response } from "express";
import { env, getAllModuleNames, resolveModule } from "../config/env";
import {
  acquireFeishuEventLock,
  safeReply,
} from "../services/feishu.service";
import { buildRelease, deployRelease, releasePipeline } from "../services/release.service";
import {
  assertReleaseNotPaused,
  setReleasePaused,
} from "../state/releasePause";
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
        } else if (normalized === "暂停" || normalized === "暂停发布") {
          const { changed } = await setReleasePaused(true);
          replyText = changed
            ? "已暂停：后续「发布」「部署」「回滚」将被拒绝；「打包」仍可用。发送「恢复」或「恢复发布」可解除。"
            : "当前已是暂停状态。";
        } else if (normalized === "恢复" || normalized === "恢复发布") {
          const { changed } = await setReleasePaused(false);
          replyText = changed
            ? "已恢复，可正常「发布」「部署」「回滚」。"
            : "当前未处于暂停状态。";
        } else if (normalized.includes("打包")) {
          const result = await buildRelease(buildModuleName);
          replyText = `打包结果${result.module ? `(${result.module})` : ""}:\n${trimOutput(result.stdout || result.stderr)}`;
        } else if (normalized.includes("部署")) {
          await assertReleaseNotPaused("部署");
          const result = await deployRelease(deployModuleName);
          replyText = `部署结果${result.module ? `(${result.module})` : ""}:\n${trimOutput(result.stdout || result.stderr)}`;
        } else if (normalized.startsWith("回滚")) {
          await assertReleaseNotPaused("回滚");
          let rest = normalized.replace(/^回滚\s*/, "").trim();
          let confirmToken = "";
          let body = rest;
          if (rest.includes("确认码")) {
            const parts = rest.split("确认码");
            confirmToken = (parts[1] || "").trim();
            body = (parts[0] || "").trim();
          }
          const tokens = body.split(/\s+/).filter(Boolean);
          if (!tokens.length) {
            throw new Error(
              "回滚失败: 请指定模块与引用，例如：回滚 server abc1234 确认码 xxx"
            );
          }
          const head = tokens[0] || "";
          let releaseModuleName: string | undefined;
          if (head === "全部") {
            releaseModuleName = "all";
          } else if (resolveModule(head).module) {
            releaseModuleName = head;
          } else {
            throw new Error(
              "回滚失败: 未知模块，请使用已配置模块名或「全部」"
            );
          }
          const gitRef = tokens.slice(1).join(" ").trim();
          if (!gitRef) {
            throw new Error(
              "回滚失败: 请指定 commit、tag 或分支（例：回滚 server v1.2.3）"
            );
          }
          if (env.RELEASE_CONFIRM_TOKEN && confirmToken !== env.RELEASE_CONFIRM_TOKEN) {
            throw new Error("回滚失败: 缺少或错误的确认码");
          }
          const moduleNames =
            releaseModuleName === "all"
              ? getAllModuleNames()
              : releaseModuleName
                ? [releaseModuleName]
                : getAllModuleNames();
          const output = await releasePipeline({ moduleNames, gitRef });
          replyText = `回滚完成:\n${trimOutput(output)}`;
        } else if (
          normalized.startsWith("发布") ||
          normalized.startsWith("一键发布")
        ) {
          await assertReleaseNotPaused("发布");
          let rest = normalized
            .replace(/^(发布|一键发布)\s*/, "")
            .trim();
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
