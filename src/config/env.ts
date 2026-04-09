import { ModuleConfig } from "../models/module";

export const env = {
  PORT: Number(process.env.PORT || 8787),
  TOKEN: process.env.AGENT_TOKEN || "change_me",
  REPO: process.env.REPO_PATH || "",
  ALLOW_PUSH: process.env.ALLOW_PUSH === "true",
  FEISHU_APP_ID: process.env.FEISHU_APP_ID || "",
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || "",
  RELEASE_REPO_URL: process.env.RELEASE_REPO_URL || "",
  RELEASE_WORKDIR: process.env.RELEASE_WORKDIR || "",
  RELEASE_BRANCH: process.env.RELEASE_BRANCH || "main",
  INSTALL_CMD: process.env.INSTALL_CMD || "pnpm install --frozen-lockfile",
  /** Run in RELEASE_WORKDIR after install, before each module preBuild/build (monorepo packages/*). Empty = skip. */
  RELEASE_PACKAGES_BUILD_CMD: process.env.RELEASE_PACKAGES_BUILD_CMD || "",
  BUILD_CMD: process.env.BUILD_CMD || "pnpm build",
  BUILD_ARTIFACT_PATH: process.env.BUILD_ARTIFACT_PATH || "dist",
  DEPLOY_HOST: process.env.DEPLOY_HOST || "",
  DEPLOY_USER: process.env.DEPLOY_USER || "",
  DEPLOY_PATH: process.env.DEPLOY_PATH || "",
  SSH_PORT: process.env.SSH_PORT || "22",
  REMOTE_RESTART_CMD: process.env.REMOTE_RESTART_CMD || "",
  RELEASE_CONFIRM_TOKEN: process.env.RELEASE_CONFIRM_TOKEN || "",
  RELEASE_MODULES_JSON: process.env.RELEASE_MODULES_JSON || "",
  RELEASE_DEFAULT_MODULE: process.env.RELEASE_DEFAULT_MODULE || "",
  FEISHU_EVENT_TTL_MS: Number(process.env.FEISHU_EVENT_TTL_MS || 10 * 60 * 1000),
};

export function ensureConfigured(name: string, value: string) {
  if (!value) throw new Error(`missing env: ${name}`);
}

export function parseModulesConfig(): Record<string, ModuleConfig> {
  if (!env.RELEASE_MODULES_JSON.trim()) return {};
  try {
    const parsed = JSON.parse(env.RELEASE_MODULES_JSON) as Record<
      string,
      ModuleConfig
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("invalid RELEASE_MODULES_JSON");
  }
}

export function resolveModule(moduleName?: string) {
  const modules = parseModulesConfig();
  const name = moduleName || env.RELEASE_DEFAULT_MODULE || "";
  if (!name || !modules[name]) {
    return { module: "", config: {} as ModuleConfig };
  }
  return { module: name, config: modules[name] };
}

export function getAllModuleNames(): string[] {
  return Object.keys(parseModulesConfig());
}
