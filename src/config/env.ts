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
  /** When true (default), each deploy snapshots remote deployPath to `<deployPath>.release-bot-prev` before rsync; on failure restores and restarts. Set to "false" to disable. */
  RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL:
    process.env.RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL !== "false",
  RELEASE_MODULES_JSON: process.env.RELEASE_MODULES_JSON || "",
  RELEASE_DEFAULT_MODULE: process.env.RELEASE_DEFAULT_MODULE || "",
  FEISHU_EVENT_TTL_MS: Number(process.env.FEISHU_EVENT_TTL_MS || 10 * 60 * 1000),
  /**
   * When not "false": after rsync+extras on modules that opt in (default: module name `server` or
   * remotePrismaGenerateAfterExtras), run remote prisma generate in a clean tmp dir (see .env.example).
   */
  RELEASE_REMOTE_PRISMA_GENERATE:
    process.env.RELEASE_REMOTE_PRISMA_GENERATE !== "false",
  /**
   * Remote absolute path to the API/server deploy dir (node_modules/@sentinel/database/...).
   * Optional if RELEASE_MODULES_JSON defines server.deployPath. Used before main-next postDeploy
   * so sync-main-next-prisma-client finds .prisma/client.
   */
  REMOTE_PRISMA_SERVER_DEPLOY_PATH:
    process.env.REMOTE_PRISMA_SERVER_DEPLOY_PATH || "",
  REMOTE_PRISMA_SCHEMA_REL:
    process.env.REMOTE_PRISMA_SCHEMA_REL ||
    "vendor/database/prisma/schema.prisma",
  REMOTE_PRISMA_GEN_TMP:
    process.env.REMOTE_PRISMA_GEN_TMP || "/tmp/sentinel-prisma-gen",
  /**
   * npm package spec for the Prisma CLI on the deploy host (must match schema / monorepo; Prisma 7+
   * rejects `url` in datasource blocks used by Prisma 6-style schemas).
   */
  REMOTE_PRISMA_CLI_PACKAGE:
    process.env.REMOTE_PRISMA_CLI_PACKAGE || "prisma@6.2.1",
  /** Dummy URL for `prisma generate` only (no DB connection required). */
  REMOTE_PRISMA_GENERATE_DATABASE_URL:
    process.env.REMOTE_PRISMA_GENERATE_DATABASE_URL ||
    "postgresql://127.0.0.1:5432/__prisma_generate_only__",
  /**
   * When not "false": rsync 主产物与 rsyncExtras 额外排除 infra 基线文件（ecosystem、docker、caddy、scripts 等），
   * 避免误传产物覆盖服务器 sentinel-infra 根目录由人维护的文件；与规范「密钥与 PM2 只在服务器」一致。
   */
  RELEASE_RSYNC_INFRA_EXCLUDES:
    process.env.RELEASE_RSYNC_INFRA_EXCLUDES !== "false",
  /**
   * Optional JSON object: package name -> file: spec for rewriteWorkspaceDepsInPackageJson.
   * Example: {"@sentinel/auth":"file:../vendor-sentinel/auth",...}
   */
  RELEASE_WORKSPACE_DEPS_REWRITE_JSON:
    process.env.RELEASE_WORKSPACE_DEPS_REWRITE_JSON || "",
};

export function ensureConfigured(name: string, value: string) {
  if (!value) throw new Error(`missing env: ${name}`);
}

/** 运行时读取（勿用快照的 env.RELEASE_WORKDIR：模块先于 dotenv 加载时会一直是空字符串）。 */
export function getReleaseWorkdir(): string {
  const w = (process.env.RELEASE_WORKDIR || "").trim();
  if (!w) {
    throw new Error(
      "RELEASE_WORKDIR 未设置。请在 .env 中填写 monorepo 绝对路径并执行 pm2 restart release-bot（或 pnpm run restart:env）。"
    );
  }
  return w;
}

export function parseModulesConfig(): Record<string, ModuleConfig> {
  const raw = process.env.RELEASE_MODULES_JSON || "";
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ModuleConfig>;
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
