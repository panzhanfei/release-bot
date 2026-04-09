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
    "   - 执行完整流程：打包 + 部署",
    "",
    `当前可用模块：${moduleText}`,
    "",
    "示例：",
    "- 打包 server",
    "- 打包 main-next",
    "- 部署 sub-react",
    "- 发布 全部 确认码 123456",
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
    "3) 发布 <模块名|全部> [确认码 xxx]",
    "   含义：执行打包 + 部署的一体化流程。",
    "",
    "提示：发送“指令”或“帮助”可查看完整菜单。",
  ].join("\n");
}
