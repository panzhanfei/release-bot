import { getAllModuleNames, resolveModule } from "../config/env";

export function shellEscape(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function safeBranch(v: string) {
  if (!/^[a-zA-Z0-9._/-]+$/.test(v)) {
    throw new Error("invalid branch name");
  }
  return v;
}

/** Repo-relative path segment for rsyncExtras (no absolute paths, no `..`). */
export function safeDeployRelPath(label: string, v: string) {
  const t = v
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!t || t.split("/").includes("..")) {
    throw new Error(`${label} must be a relative path without ..`);
  }
  return t;
}

/** Git commit / tag / branch ref for rollback (no shell metacharacters). */
export function safeGitRef(v: string) {
  const t = v.trim();
  if (!t || t.length > 200) {
    throw new Error("invalid git ref");
  }
  if (!/^[a-zA-Z0-9._^~/-]+$/.test(t)) {
    throw new Error("invalid git ref characters");
  }
  return t;
}

export function trimOutput(text: string, max = 1800) {
  const clean = text.trim();
  if (clean.length <= max) return clean || "(empty)";
  return `${clean.slice(0, max)}\n...(truncated)`;
}

export function normalizeCommandText(raw: string) {
  return raw
    .replace(/<at\s+user_id="[^"]*">[^<]*<\/at>/g, " ")
    .replace(/^@?[_a-zA-Z0-9-]+\s+/, "")
    .replace(/^a_[a-zA-Z0-9_]+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractModuleArg(text: string, command: "打包" | "部署" | "发布") {
  const m = text.match(new RegExp(`^${command}\\s+([^\\s]+)`));
  if (!m) return undefined;
  const value = m[1]?.trim();
  if (!value || value === "全部") return undefined;
  return resolveModule(value).module ? value : undefined;
}

export function getCommandHelpText() {
  const moduleNames = getAllModuleNames();
  const moduleText = moduleNames.length ? moduleNames.join(" / ") : "未配置模块";
  return [
    "可用指令如下：",
    "",
    "1) 打包 <模块名>",
    "   - 仅打包发布仓指定模块",
    "",
    "2) 部署 <模块名>",
    "   - 仅部署指定模块到服务器并重启对应 pm2",
    "",
    "3) 发布 <模块名|全部> [确认码 xxx]",
    "   - 拉取代码 → 安装与 packages 构建 → 各模块打包 → 各模块上传 / 远程命令 / 重启",
    "   - 部署失败时（默认）：若远端目录在同步前非空，会先备份到 <deployPath>.release-bot-prev；",
    "     单模块失败会自动从该快照恢复并重启；多模块「全部」发布时若中途失败，还会逆序回滚此前已成功同步的模块。",
    "   - 关闭自动快照：环境变量 RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL=false",
    "",
    "   同义词：一键发布（与「发布」相同）",
    "",
    "4) 暂停 / 暂停发布",
    "   - 暂停后拒绝「发布」「部署」「回滚」（「打包」仍可用）",
    "",
    "5) 恢复 / 恢复发布",
    "   - 取消暂停",
    "",
    "6) 回滚 <模块名|全部> <commit|tag|分支> [确认码 xxx]",
    "   - 在发布仓检出指定 git 引用后，按发布流程重新打包并部署（与发布相同确认码）",
    "   - 用于回到历史代码版本；与「部署失败自动恢复快照」不同，后者只恢复上一版已同步的文件",
    "",
    `当前可用模块：${moduleText}`,
    "",
    "示例：",
    "- 打包 server",
    "- 打包 main-next",
    "- 部署 sub-react",
    "- 发布 全部 确认码 123456",
    "- 一键发布 全部 确认码 123456",
    "- 一键发布 server",
    "- 暂停",
    "- 恢复",
    "- 回滚 server abc1234 确认码 123456",
  ].join("\n");
}

export function getCommandErrorHelpText(input: string) {
  return [
    `指令错误：无法识别「${input || "(空指令)"}」`,
    "",
    "常见指令如下：",
    "",
    "1) 打包 <模块名>",
    "   含义：在发布仓拉取最新代码并构建指定模块。",
    "",
    "2) 部署 <模块名>",
    "   含义：把指定模块构建产物上传到服务器并重启对应进程。",
    "",
    "3) 发布 / 一键发布 <模块名|全部> [确认码 xxx]",
    "   含义：拉取代码 → 打包（含安装与 packages）→ 上传与远程命令与重启。",
    "   部署失败时默认会尝试用远端 .release-bot-prev 快照恢复（见「指令」完整说明）。",
    "",
    "4) 暂停 / 恢复 — 控制是否允许发布、部署、回滚。",
    "",
    "5) 回滚 <模块名|全部> <commit|tag|分支> [确认码 xxx]",
    "   含义：检出指定版本后打包并部署。",
    "",
    "提示：发送“指令”或“帮助”可查看完整菜单。",
  ].join("\n");
}
