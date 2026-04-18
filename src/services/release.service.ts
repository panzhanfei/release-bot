import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  env,
  ensureConfigured,
  getAllModuleNames,
  getReleaseWorkdir,
  resolveModule,
} from "../config/env";
import { run } from "../utils/shell";
import type { ModuleConfig } from "../models/module";
import {
  safeBranch,
  safeDeployRelPath,
  safeGitRef,
  shellEscape,
  trimOutput,
} from "../utils/text";

function sshTarget() {
  return `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`;
}

/** SSH 选项：避免卡住等待密码；断线时尽早失败，减少 rsync unexpected end of file */
function sshBaseOpts() {
  return `-p ${env.SSH_PORT} -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15`;
}

const BACKUP_MARK = "__RELEASE_BOT_BACKUP_OK__";
const RESTORE_MARK = "__RELEASE_BOT_RESTORE_OK__";

export type DeployRollbackMeta = {
  module: string;
  deployPath: string;
};

function deployPathNormalized(deployPath: string) {
  return deployPath.replace(/\/+$/, "");
}

function prevSnapshotPath(deployPath: string) {
  return `${deployPathNormalized(deployPath)}.release-bot-prev`;
}

function wantsRemotePrismaAfterExtras(moduleName: string, config: ModuleConfig) {
  if (config.skipRemotePrismaGenerate) return false;
  if (!env.RELEASE_REMOTE_PRISMA_GENERATE) return false;
  if (config.remotePrismaGenerateAfterExtras) return true;
  return moduleName === "server";
}

function wantsRemotePrismaHostBeforePostDeploy(
  moduleName: string,
  config: ModuleConfig
) {
  if (config.skipRemotePrismaGenerate) return false;
  /** main-next 的 postDeploy 常含 sync-main-next-prisma-client：必须在 API 目录有 client，与「是否给 server 多跑一遍 generate」无关。 */
  if (config.remotePrismaHostGenerateBeforePostDeploy) return true;
  return moduleName === "main-next";
}

function assertSafeRemoteNpmPackageSpec(spec: string) {
  const t = spec.trim();
  if (!t || t.length > 120 || /[\s;'"\`$|&<>()]/.test(t)) {
    throw new Error("REMOTE_PRISMA_CLI_PACKAGE must be a single npm package spec without shell metacharacters");
  }
}

/**
 * 从 REMOTE_PRISMA_SCHEMA_REL 推出 @sentinel/database 在 deploy 根下的相对目录（如 vendor/database）。
 * Prisma 脚本与镜像逻辑依赖此路径（与 rsyncExtras 同步的目录一致）。
 */
export function remoteSentinelDatabasePackageRelFromSchemaEnv(): string {
  const schemaRel = env.REMOTE_PRISMA_SCHEMA_REL.trim().replace(/^\/+/, "");
  const parts = schemaRel.split("/").filter(Boolean);
  if (
    parts.length < 3 ||
    parts[parts.length - 1] !== "schema.prisma" ||
    parts[parts.length - 2] !== "prisma"
  ) {
    throw new Error(
      "REMOTE_PRISMA_SCHEMA_REL 须为 <dir>/prisma/schema.prisma（例如 vendor/database/prisma/schema.prisma）"
    );
  }
  if (parts.includes("..")) {
    throw new Error("REMOTE_PRISMA_SCHEMA_REL must not contain ..");
  }
  const rel = parts.slice(0, -2).join("/");
  if (!/^[a-zA-Z0-9/_-]+$/.test(rel)) {
    throw new Error("REMOTE_PRISMA_SCHEMA_REL 解析出的包路径含非法字符");
  }
  return rel;
}

/** Remote prisma generate in a clean tmp dir (see .env.example — avoids broken nested prisma in pnpm hoists). */
function remotePrismaGenerateBash(remoteDeployRoot: string) {
  const d = deployPathNormalized(remoteDeployRoot);
  const dbPkgRel = remoteSentinelDatabasePackageRelFromSchemaEnv();
  const schemaRel = env.REMOTE_PRISMA_SCHEMA_REL.trim().replace(/^\/+/, "");
  if (!schemaRel || schemaRel.split("/").includes("..")) {
    throw new Error("REMOTE_PRISMA_SCHEMA_REL must be a relative path without ..");
  }
  const tmp = env.REMOTE_PRISMA_GEN_TMP.trim().replace(/\/+$/, "");
  if (!tmp || tmp.includes("..")) {
    throw new Error("REMOTE_PRISMA_GEN_TMP must be an absolute path without ..");
  }
  const cliPkg = env.REMOTE_PRISMA_CLI_PACKAGE.trim() || "prisma@6.2.1";
  assertSafeRemoteNpmPackageSpec(cliPkg);
  const dbUrl = env.REMOTE_PRISMA_GENERATE_DATABASE_URL.trim();
  if (!dbUrl || /[';]/.test(dbUrl)) {
    throw new Error("REMOTE_PRISMA_GENERATE_DATABASE_URL must be non-empty and must not contain ' or ;");
  }
  const tmpBase = tmp;
  return [
    `d=${shellEscape(d)}`,
    `schema_path="$d/${schemaRel}"`,
    `tmp_base=${shellEscape(tmpBase)}`,
    `tmp="$tmp_base/gen-$$"`,
    `if [ ! -f "$schema_path" ]; then echo "release-bot: prisma schema missing at $schema_path" >&2; exit 1; fi`,
    `rm -rf "$tmp" && mkdir -p "$tmp" && cd "$tmp" && npm init -y >/dev/null 2>&1 && npm install ${shellEscape(cliPkg)} --no-save --silent --no-fund --no-audit && export DATABASE_URL=${shellEscape(dbUrl)} && node node_modules/prisma/build/index.js generate --schema="$schema_path" || exit 1`,
    `pkg="$d/${dbPkgRel}"`,
    `need="$pkg/node_modules/.prisma/client"`,
    `legacy="$pkg/.prisma/client"`,
    `rootc="$d/node_modules/.prisma/client"`,
    `if [ ! -d "$need" ] && [ -d "$legacy" ]; then mkdir -p "$pkg/node_modules/.prisma" && rm -rf "$pkg/node_modules/.prisma/client" && cp -a "$legacy" "$pkg/node_modules/.prisma/client" && echo "release-bot: normalized $legacy into node_modules/.prisma"; fi`,
    `if [ ! -d "$need" ] && [ -d "$rootc" ]; then mkdir -p "$pkg/node_modules/.prisma" && rm -rf "$pkg/node_modules/.prisma/client" && cp -a "$rootc" "$pkg/node_modules/.prisma/client" && echo "release-bot: copied server root .prisma/client into @sentinel/database"; fi`,
    `if [ -d "$need" ] && [ ! -d "$legacy" ]; then mkdir -p "$pkg/.prisma" && cp -a "$need" "$legacy" && echo "release-bot: mirrored client to $legacy (sync scripts often check package root)"; fi`,
    `if [ ! -d "$need" ]; then echo "release-bot: missing Prisma client at $need under $pkg; found:" >&2; find "$d" -path "*/.prisma/client" -type d 2>/dev/null | head -40 >&2; exit 1; fi`,
  ].join("; ");
}

async function runRemotePrismaGenerate(
  remoteDeployRoot: string,
  sshExe: string,
  target: string
) {
  const inner = `bash -lc ${shellEscape(remotePrismaGenerateBash(remoteDeployRoot))}`;
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(inner)}`;
  return run(cmd, "/");
}

/**
 * Next standalone 通常不带 prisma/schema；在 API 目录已 generate 后，把 `.prisma/client` 拷进 main-next 内
 * `@sentinel/database`（与 sync-main-next-prisma-client 期望的布局一致），无需在 main-next 再跑 prisma。
 */
function remoteMirrorPrismaClientBash(
  apiDeployRoot: string,
  mainNextDeployRoot: string
) {
  const s = deployPathNormalized(apiDeployRoot);
  const m = deployPathNormalized(mainNextDeployRoot);
  const dbPkgRel = remoteSentinelDatabasePackageRelFromSchemaEnv();
  return [
    `s=${shellEscape(s)}`,
    `m=${shellEscape(m)}`,
    `spkg="$s/${dbPkgRel}"`,
    `mpkg="$m/node_modules/@sentinel/database"`,
    `sneed="$spkg/node_modules/.prisma/client"`,
    `sleg="$spkg/.prisma/client"`,
    `if [ ! -d "$spkg" ]; then echo "release-bot: API 缺少 $spkg" >&2; exit 1; fi`,
    `if [ ! -d "$mpkg" ]; then mkdir -p "$m/node_modules" && cp -a "$spkg" "$mpkg" && echo "release-bot: main-next 原无 @sentinel/database，已从 API 整包复制"; fi`,
    `if [ -d "$sneed" ]; then src="$sneed"; elif [ -d "$sleg" ]; then src="$sleg"; else src=""; fi`,
    `if [ -z "$src" ]; then echo "release-bot: API 目录无可用 Prisma client，无法镜像；检查 $sneed 与 $sleg" >&2; find "$spkg" -path "*/.prisma/client" -type d 2>/dev/null | head -15 >&2; exit 1; fi`,
    `mkdir -p "$mpkg/node_modules/.prisma" && rm -rf "$mpkg/node_modules/.prisma/client" && cp -a "$src" "$mpkg/node_modules/.prisma/client"`,
    `mkdir -p "$mpkg/.prisma" && rm -rf "$mpkg/.prisma/client" && cp -a "$src" "$mpkg/.prisma/client"`,
    `echo "release-bot: 已从 API 目录复制 Prisma client 至 main-next/@sentinel/database"`,
  ].join("; ");
}

async function runRemoteMirrorPrismaClientFromApiToMainNext(
  apiDeployRoot: string,
  mainNextDeployRoot: string,
  sshExe: string,
  target: string
) {
  const inner = `bash -lc ${shellEscape(remoteMirrorPrismaClientBash(apiDeployRoot, mainNextDeployRoot))}`;
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(inner)}`;
  return run(cmd, "/");
}

/** Prefer REMOTE_PRISMA_SERVER_DEPLOY_PATH; else server module deployPath from RELEASE_MODULES_JSON. */
function remotePrismaServerDeployPathForSync(): string {
  const fromEnv = env.REMOTE_PRISMA_SERVER_DEPLOY_PATH.trim();
  if (fromEnv) return deployPathNormalized(fromEnv);
  const { config } = resolveModule("server");
  const d = (config.deployPath || "").trim();
  return d ? deployPathNormalized(d) : "";
}

/** Snapshot remote deploy dir to sibling `<deployPath>.release-bot-prev` (rsync --delete). */
async function remoteSnapshotDeployDir(
  deployPath: string,
  sshExe: string,
  target: string
) {
  const d = deployPathNormalized(deployPath);
  const b = prevSnapshotPath(deployPath);
  // 赋值与 if 之间必须有 `;`，否则 bash 会把 `b=... if` 解析坏掉
  const script = [
    `d=${shellEscape(d)}; b=${shellEscape(b)}; `,
    `if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ]; then `,
    `mkdir -p "$b" && rsync -a --delete "$d/" "$b/" && echo ${BACKUP_MARK}; `,
    `fi`,
  ].join("");
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(script)}`;
  return run(cmd, "/");
}

async function remoteRestoreDeployFromSnapshot(
  deployPath: string,
  sshExe: string,
  target: string
) {
  const d = deployPathNormalized(deployPath);
  const b = prevSnapshotPath(deployPath);
  const script = [
    `d=${shellEscape(d)}; b=${shellEscape(b)}; `,
    `if [ -d "$b" ] && [ -n "$(ls -A "$b" 2>/dev/null)" ]; then `,
    `rsync -a --delete "$b/" "$d/" && echo ${RESTORE_MARK}; `,
    `fi`,
  ].join("");
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(script)}`;
  return run(cmd, "/");
}

/**
 * postDeploy 里 npm install 前：递归扫描 deploy 树下所有 package.json，若仍含单段 file:xxx（无 /、非 ./、非 ../），
 * npm 会在 deploy 根下解析成 deployPath/xxx 并报 ENOENT。
 */
/** 主产物 rsync 后：确认远端根 package.json 不含 npm 无法安装的 workspace:/catalog:（与 assertPackageJsonHasNoUnsupportedProtocolsForNpmInstall 对齐）。 */
async function runRemoteRootPackageJsonNpmProtocolCheck(
  deployPath: string,
  sshExe: string,
  target: string
) {
  const d = deployPathNormalized(deployPath);
  const inner = [
    `d=${shellEscape(d)}`,
    `p="$d/package.json"`,
    `if [ ! -f "$p" ]; then echo "release-bot: 远端缺少 $p" >&2; exit 1; fi`,
    `if grep -qE '"workspace:|"catalog:' "$p"; then`,
    `  echo "release-bot: 远端根 package.json 仍含 workspace:/catalog:（rsync 未更新或路径错误），npm 会按 file:database 解析：" >&2`,
    `  grep -nE '"workspace:|"catalog:' "$p" >&2 || true`,
    `  exit 1`,
    `fi`,
    `exit 0`,
  ].join("\n");
  const b64 = Buffer.from(inner, "utf8").toString("base64");
  const remote = `printf '%s' ${shellEscape(b64)} | base64 -d | bash`;
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(remote)}`;
  return run(cmd, "/");
}

async function runRemoteBareSentinelFileSpecCheck(
  deployPath: string,
  sshExe: string,
  target: string
) {
  const d = deployPathNormalized(deployPath);
  /**
   * 与 assertPackageJsonHasNoBareSingleSegmentFileDeps 一致。
   * 多行 bash 若嵌进 `ssh … bash -lc '…'`，经本机 exec/sh 时易被压成一行产生 `do; if` 等语法错误；
   * 故将脚本 base64 后由远端 `base64 -d | bash` 执行（payload 仅 [A-Za-z0-9+/=]，可安全包在单引号里）。
   */
  const inner = [
    `d=${shellEscape(d)}`,
    `bad=0`,
    `while IFS= read -r -d '' f; do`,
    `  if grep -qE '"file:[^./][^/"]*"' "$f" 2>/dev/null; then`,
    `    echo "release-bot: 远端 package.json 仍含单段 file: 依赖（npm 会在 deploy 根下解析路径）:" >&2`,
    `    echo "$f" >&2`,
    `    grep -nE '"file:[^./][^/"]*"' "$f" >&2 || true`,
    `    bad=1`,
    `  fi`,
    `done < <(find "$d" -name package.json -not -path '*/.git/*' -print0 2>/dev/null)`,
    `exit $bad`,
  ].join("\n");
  const b64 = Buffer.from(inner, "utf8").toString("base64");
  const remote = `printf '%s' ${shellEscape(b64)} | base64 -d | bash`;
  const cmd = `${sshExe} ${shellEscape(target)} ${shellEscape(remote)}`;
  return run(cmd, "/");
}

async function remoteRestartForModule(moduleName?: string) {
  const { config } = resolveModule(moduleName);
  ensureConfigured("DEPLOY_HOST", env.DEPLOY_HOST);
  ensureConfigured("DEPLOY_USER", env.DEPLOY_USER);
  const restartCmdRaw = config.remoteRestartCmd || env.REMOTE_RESTART_CMD;
  ensureConfigured("REMOTE_RESTART_CMD", restartCmdRaw);
  const sshExe = `ssh ${sshBaseOpts()}`;
  const restartCmd = `${sshExe} ${shellEscape(sshTarget())} ${shellEscape(restartCmdRaw)}`;
  return run(restartCmd, "/");
}

async function rollbackDeployStack(stack: DeployRollbackMeta[]) {
  const sshExe = `ssh ${sshBaseOpts()}`;
  const target = sshTarget();
  const lines: string[] = [];
  for (const meta of [...stack].reverse()) {
    const out = await remoteRestoreDeployFromSnapshot(
      meta.deployPath,
      sshExe,
      target
    );
    if (out.stdout.includes(RESTORE_MARK)) {
      lines.push(`已恢复模块 ${meta.module} 目录（自 .release-bot-prev）`);
    } else {
      lines.push(
        `模块 ${meta.module} 无可用快照，跳过目录恢复（可能为首装或快照为空）`
      );
    }
    try {
      await remoteRestartForModule(meta.module);
      lines.push(`已执行模块 ${meta.module} 的 remoteRestartCmd`);
    } catch (e: any) {
      lines.push(`模块 ${meta.module} 重启失败: ${e?.message || e}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}

export async function prepareReleaseWorkspace(options?: { gitRef?: string }) {
  ensureConfigured("RELEASE_REPO_URL", env.RELEASE_REPO_URL);
  const wd = getReleaseWorkdir();
  const branch = safeBranch(env.RELEASE_BRANCH);
  const ref = options?.gitRef ? safeGitRef(options.gitRef) : undefined;

  await run(`mkdir -p ${shellEscape(wd)}`, "/");
  try {
    await run("git rev-parse --is-inside-work-tree", wd);
    await run("git fetch --all --prune --tags", wd);
    if (ref) {
      await run(`git checkout -f ${shellEscape(ref)}`, wd);
      await run(`git reset --hard ${shellEscape(ref)}`, wd);
    } else {
      await run(`git checkout ${shellEscape(branch)}`, wd);
      await run(`git reset --hard origin/${branch}`, wd);
    }
    await run("git clean -fd", wd);
  } catch {
    await run(
      `git clone --branch ${shellEscape(branch)} ${shellEscape(env.RELEASE_REPO_URL)} ${shellEscape(wd)}`,
      "/"
    );
    await run("git fetch --all --prune --tags", wd);
    if (ref) {
      await run(`git checkout -f ${shellEscape(ref)}`, wd);
      await run(`git reset --hard ${shellEscape(ref)}`, wd);
      await run("git clean -fd", wd);
    }
  }
}

export type BuildReleaseOptions = {
  gitRef?: string;
  /** When true, skip clone/checkout/clean (used after pipeline already prepared workspace). */
  skipWorkspacePrepare?: boolean;
  /** When true, skip install + packages build (pipeline ran them once for all modules). */
  skipInstallAndPackages?: boolean;
};

function moduleInstallCwd(config: { repoSubdir?: string }) {
  const wd = getReleaseWorkdir();
  return config.repoSubdir ? `${wd}/${config.repoSubdir}` : wd;
}

/**
 * 部署顺序：vendor-sentinel（若在本轮发布中）→ server → 其余模块按原相对顺序。
 * vendor 先于 server，保证 file:../vendor-sentinel 在 API/Next 同步前已就位；server 先于 main-next 等同理。
 */
export function orderedTargetsForDeploy(
  targets: (string | undefined)[]
): (string | undefined)[] {
  if (targets.some((t) => t === undefined)) return targets;
  const names = targets as string[];
  const needVendor = names.includes("vendor-sentinel");
  const needServer = names.includes("server");
  if (!needVendor && !needServer) return targets;
  const skip = new Set<string>();
  if (needVendor) skip.add("vendor-sentinel");
  if (needServer) skip.add("server");
  const head: string[] = [];
  if (needVendor) head.push("vendor-sentinel");
  if (needServer) head.push("server");
  const tail = names.filter((n) => !skip.has(n));
  return [...head, ...tail];
}

function rsyncExcludeFlags(): string {
  const envExcludes =
    "--exclude '.env.production' --exclude '.env' --exclude '.env.local' " +
    "--exclude '.env.development' --exclude '.env.*' ";
  if (!env.RELEASE_RSYNC_INFRA_EXCLUDES) return envExcludes;
  const infraExcludes =
    "--exclude 'ecosystem.config.cjs' --exclude 'docker-compose.yml' " +
    "--exclude 'Caddyfile' --exclude 'caddy.d/' --exclude 'scripts/' ";
  return envExcludes + infraExcludes;
}

/** 将 rsyncExtras 从 RELEASE_WORKDIR 同步到远端 deployPath（-L 跟软链）。 */
async function runRsyncExtrasUpload(
  extras: ModuleConfig["rsyncExtras"],
  deployPath: string,
  sshExe: string,
  target: string,
  rsyncExcludes: string
): Promise<{ stdout: string; stderr: string }[]> {
  const chunks: { stdout: string; stderr: string }[] = [];
  for (const extra of extras || []) {
    const fromRel = safeDeployRelPath("rsyncExtras.from", extra.from);
    const toRel = safeDeployRelPath("rsyncExtras.to", extra.to);
    const localDir = `${getReleaseWorkdir()}/${fromRel}`.replace(/\/+$/, "");
    try {
      await access(localDir);
    } catch {
      throw new Error(
        `rsyncExtras 本地产物不存在: ${localDir}（请确认 preBuildCmd/buildCmd 已生成该目录）`
      );
    }
    const remoteDest = `${deployPath}/${toRel}`;
    const mkdirExtra = `${sshExe} ${shellEscape(target)} ${shellEscape(`mkdir -p ${remoteDest}`)}`;
    await run(mkdirExtra, "/");
    const rsyncExtra =
      `rsync -azL ${rsyncExcludes}-e ${shellEscape(sshExe)} ` +
      `${shellEscape(`${localDir}/`)} ` +
      `${shellEscape(`${target}:${remoteDest}/`)}`;
    chunks.push(await run(rsyncExtra, "/"));
  }
  return chunks;
}

type DepRecord = Record<string, unknown>;

export type DepInstallContext = "deployRoot" | "sentinelSibling";

/**
 * 部署根目录：workspace:/catalog: 按 map；单段 file: 对 @sentinel/* 落到 file:./vendor/<seg>（与 rsyncExtras 一致）。
 * npm@9 会将 file:./node_modules/@sentinel/x 错误解析为根目录 file:x（ENOENT）；切勿再使用该形式。
 * 子包 manifest（vendor/* 或 node_modules/@sentinel/*）：用 file:../peer 兄弟路径。
 */
function sentinelSiblingFileSpec(depKey: string): string | undefined {
  if (!depKey.startsWith("@sentinel/")) return undefined;
  const rest = depKey.slice("@sentinel/".length);
  if (!rest || rest.includes("/")) return undefined;
  return `file:../${rest}`;
}

function workspaceOrCatalogSubst(
  depKey: string,
  map: Record<string, string>,
  ctx: DepInstallContext
): string | undefined {
  if (ctx === "sentinelSibling") {
    return sentinelSiblingFileSpec(depKey) ?? map[depKey];
  }
  return map[depKey];
}

/**
 * 历史布局：file:../vendor-sentinel/<seg>；现 rsyncExtras 同步到 deploy 根下 vendor/<seg>。
 */
function rewriteVendorSentinelPathsToVendorDir(
  o: DepRecord | undefined,
  enabled: boolean
): void {
  if (!enabled || !o) return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v !== "string" || !v.startsWith("file:")) continue;
    let rest = v.slice("file:".length).trim();
    if (rest.startsWith("./")) rest = rest.slice(2);
    const m = /^\.\.\/vendor-sentinel\/([^/]+)\/?$/.exec(rest);
    if (!m) continue;
    const seg = m[1];
    if (k !== `@sentinel/${seg}`) continue;
    o[k] = `file:./vendor/${seg}`;
  }
}

/** 将已写死的 file:./node_modules/@sentinel/x 改为 file:./vendor/x（npm 9 兼容）。 */
function rewriteFileNodeModulesSentinelRefsToVendor(
  o: DepRecord | undefined,
  ctx: DepInstallContext
): void {
  if (ctx !== "deployRoot" || !o) return;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v !== "string" || !v.startsWith("file:")) continue;
    let rest = v.slice("file:".length).trim();
    if (rest.startsWith("./")) rest = rest.slice(2);
    const m = /^node_modules\/@sentinel\/([^/]+)\/?$/.exec(rest);
    if (!m) continue;
    const seg = m[1];
    if (k !== `@sentinel/${seg}`) continue;
    o[k] = `file:./vendor/${seg}`;
  }
}

export function assertRsyncExtrasSentinelNotUnderNodeModules(config: ModuleConfig): void {
  for (const extra of config.rsyncExtras || []) {
    const t = extra.to.replace(/\\/g, "/");
    if (t.includes("node_modules/@sentinel/")) {
      throw new Error(
        "rsyncExtras.to 不能使用 node_modules/@sentinel/*：npm@9 会将 file:./node_modules/@sentinel/x 解析为根目录的 file:x 并失败。请改为 vendor/auth、vendor/database、vendor/security-sdk，并设置 REMOTE_PRISMA_SCHEMA_REL=vendor/database/prisma/schema.prisma（见 .env.example）。"
      );
    }
  }
}

export function wantsLegacyVendorSentinelRewrite(config: ModuleConfig): boolean {
  return (config.rsyncExtras || []).some((e) => {
    const t = e.to.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^vendor\//.test(t);
  });
}

/** 与远端 npm install 一致（本机写入，随 rsync 上传，不依赖 SSH 跑 node）。 */
export function applyWorkspaceDepRewritesToPackageJsonObject(
  j: Record<string, unknown>,
  map: Record<string, string>,
  opts: {
    stripPackageManagerAndWorkspaces: boolean;
    depInstallContext?: DepInstallContext;
    /** 将 file:../vendor-sentinel/<pkg> 改为 file:./vendor/<pkg>（见 wantsLegacyVendorSentinelRewrite） */
    legacyVendorSentinelToNodeModules?: boolean;
  }
): void {
  const ctx: DepInstallContext = opts.depInstallContext ?? "deployRoot";
  const legacyVendor = opts.legacyVendorSentinelToNodeModules ?? false;
  function normalizeFlatFileDeps(o: DepRecord | undefined) {
    if (!o) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v !== "string" || !v.startsWith("file:")) continue;
      let rest = v.slice("file:".length);
      if (rest.startsWith("./")) rest = rest.slice(2);
      if (!rest || rest.startsWith("/")) continue;
      if (rest.includes("/")) continue;
      const sib = ctx === "sentinelSibling" ? sentinelSiblingFileSpec(k) : undefined;
      if (sib) {
        o[k] = sib;
        continue;
      }
      if (ctx === "deployRoot" && k.startsWith("@sentinel/")) {
        const seg = k.slice("@sentinel/".length);
        if (seg && !seg.includes("/")) {
          o[k] = `file:./vendor/${seg}`;
          continue;
        }
      }
      o[k] = `file:./node_modules/${k}`;
    }
  }
  /** pnpm：workspace:* / catalog:；npm overrides 可嵌套子对象，内层仍是「包名 → 版本串」 */
  function replaceProtoSpecString(v: string): boolean {
    return /^workspace:/.test(v) || /^catalog:/.test(v);
  }
  function rewriteWorkspaceDepsInObject(o: DepRecord | undefined) {
    if (!o) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string" && replaceProtoSpecString(v)) {
        const sub = workspaceOrCatalogSubst(k, map, ctx);
        if (sub != null) o[k] = sub;
      }
    }
    rewriteFileNodeModulesSentinelRefsToVendor(o, ctx);
    rewriteVendorSentinelPathsToVendorDir(o, legacyVendor);
    normalizeFlatFileDeps(o);
  }
  function rewriteOverridesDeep(ov: unknown): void {
    if (!ov || typeof ov !== "object" || Array.isArray(ov)) return;
    const o = ov as DepRecord;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string") {
        if (replaceProtoSpecString(v)) {
          const sub = workspaceOrCatalogSubst(k, map, ctx);
          if (sub != null) o[k] = sub;
        }
      } else if (v && typeof v === "object" && !Array.isArray(v)) {
        rewriteOverridesDeep(v);
      }
    }
    rewriteFileNodeModulesSentinelRefsToVendor(o, ctx);
    rewriteVendorSentinelPathsToVendorDir(o, legacyVendor);
    normalizeFlatFileDeps(o);
  }
  rewriteWorkspaceDepsInObject(j.dependencies as DepRecord);
  rewriteWorkspaceDepsInObject(j.devDependencies as DepRecord);
  rewriteWorkspaceDepsInObject(j.optionalDependencies as DepRecord);
  rewriteWorkspaceDepsInObject(j.peerDependencies as DepRecord);
  rewriteWorkspaceDepsInObject(j.resolutions as DepRecord);
  if (j.overrides) rewriteOverridesDeep(j.overrides);
  const pnpm = j.pnpm;
  if (pnpm && typeof pnpm === "object" && !Array.isArray(pnpm)) {
    const po = pnpm as Record<string, unknown>;
    if (po.overrides) rewriteOverridesDeep(po.overrides);
  }
  if (opts.stripPackageManagerAndWorkspaces) {
    delete j.packageManager;
    if (Array.isArray(j.workspaces)) delete j.workspaces;
    /** 远端只用 npm install；保留 pnpm 块易导致未展开的 catalog: 等语义残留 */
    delete j.pnpm;
  }
}

function rewriteOneDeployPackageJson(
  absPath: string,
  map: Record<string, string>,
  depInstallContext: DepInstallContext = "deployRoot",
  legacyVendorSentinelToNodeModules = false
) {
  const j = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
  applyWorkspaceDepRewritesToPackageJsonObject(j, map, {
    stripPackageManagerAndWorkspaces: true,
    depInstallContext,
    legacyVendorSentinelToNodeModules,
  });
  writeFileSync(absPath, JSON.stringify(j, null, 2) + "\n");
}

/** 按路径判断 file: 应相对部署根还是相对 @sentinel 包目录（与 npm 解析规则一致）。 */
export function inferDepInstallContextForPackageJsonPath(
  absPath: string,
  artifactDir: string,
  config: ModuleConfig,
  workdir: string
): DepInstallContext {
  const r = resolve(absPath);
  const normArt = resolve(artifactDir.replace(/\/+$/, ""));
  const wd = workdir.trim();

  if (r === resolve(join(normArt, "package.json"))) return "deployRoot";
  if (basename(normArt) === "dist") {
    const parentPkg = resolve(join(dirname(normArt), "package.json"));
    if (r === parentPkg) return "deployRoot";
  }
  if (config.repoSubdir?.trim()) {
    const subPkg = resolve(
      join(wd, safeDeployRelPath("repoSubdir", config.repoSubdir.trim()), "package.json")
    );
    if (r === subPkg) return "deployRoot";
  }

  const artRel = relative(normArt, r);
  if (artRel && !artRel.startsWith("..") && !artRel.startsWith("/")) {
    const segs = artRel.split(/[/\\]/);
    if (
      segs.length === 4 &&
      segs[0] === "node_modules" &&
      segs[1] === "@sentinel" &&
      segs[3] === "package.json"
    ) {
      return "sentinelSibling";
    }
    if (segs.length === 3 && segs[0] === "vendor" && segs[2] === "package.json") {
      return "sentinelSibling";
    }
  }

  for (const extra of config.rsyncExtras || []) {
    const fromRel = safeDeployRelPath("rsyncExtras.from", extra.from);
    const srcRoot = resolve(join(wd, fromRel));
    const rootPkg = resolve(join(srcRoot, "package.json"));
    if (r === rootPkg) return "sentinelSibling";
  }

  return "deployRoot";
}

/** npm 会把 file:database 解析成 <deployRoot>/database；rsync 前必须在本机消灭此类单段 file: */
export function assertPackageJsonHasNoBareSingleSegmentFileDeps(absPath: string): void {
  const j = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
  const bad: string[] = [];
  function visit(node: unknown, path: string): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => visit(x, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = `${path}.${k}`;
      if (typeof v === "string" && v.startsWith("file:")) {
        let rest = v.slice("file:".length);
        if (rest.startsWith("./")) rest = rest.slice(2);
        if (
          rest &&
          !rest.startsWith("/") &&
          !rest.includes("/") &&
          !rest.startsWith("..")
        ) {
          bad.push(`${p} = ${v}`);
        }
      } else {
        visit(v, p);
      }
    }
  }
  visit(j, "$");
  if (bad.length) {
    throw new Error(
      [
        `本机 ${absPath} 仍含单段 file: 依赖，不应再 rsync（npm 会在服务器根目录下找同名文件夹）。`,
        ...bad.slice(0, 20),
        `运行时 process.env.RELEASE_WORKDIR=${JSON.stringify(process.env.RELEASE_WORKDIR || "")}`,
      ].join("\n")
    );
  }
}

/**
 * 远端 postDeploy 使用 npm install；若 manifest 仍含 workspace:/catalog:，npm 会按 monorepo 展开成 file:database 等并 ENOENT。
 */
export function assertPackageJsonHasNoUnsupportedProtocolsForNpmInstall(
  absPath: string
): void {
  const j = JSON.parse(readFileSync(absPath, "utf8")) as Record<string, unknown>;
  const bad: string[] = [];
  function visit(node: unknown, path: string): void {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((x, i) => visit(x, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = `${path}.${k}`;
      if (typeof v === "string") {
        if (/^workspace:/.test(v) || /^catalog:/.test(v)) {
          bad.push(`${p} = ${v}`);
        }
      } else {
        visit(v, p);
      }
    }
  }
  visit(j, "$");
  if (bad.length) {
    throw new Error(
      [
        `本机 ${absPath} 仍含 workspace:/catalog:，npm install 会解析失败（请确认 rewriteWorkspaceDepsInPackageJson 已生效）。`,
        ...bad.slice(0, 20),
      ].join("\n")
    );
  }
}

const DEEP_REWRITE_SKIP_DIR_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".turbo",
  "coverage",
  ".nyc_output",
]);

const MAX_PACKAGE_JSON_FILES_PER_DEEP_SCAN = 800;

/**
 * 递归收集目录下所有 package.json。extras 源目录默认跳过 node_modules；产物目录会进入 node_modules（如 Next standalone）
 * 以便改写已打进产物的 @sentinel 包 manifest。
 */
export function collectPackageJsonPathsUnderDir(
  rootDir: string,
  opts: { skipNodeModules: boolean }
): string[] {
  const out: string[] = [];
  const root = resolve(rootDir.trim());
  if (!existsSync(root)) return out;
  function walk(dir: string) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      out.push(resolve(pkg));
      if (out.length > MAX_PACKAGE_JSON_FILES_PER_DEEP_SCAN) {
        throw new Error(
          `本机目录 ${root} 下递归找到的 package.json 超过 ${MAX_PACKAGE_JSON_FILES_PER_DEEP_SCAN} 个，已中止（避免误扫巨型树）。请缩小 rsync 范围或联系维护者提高上限。`
        );
      }
    }
    let ents: ReturnType<typeof readdirSync>;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (opts.skipNodeModules && name === "node_modules") continue;
      if (DEEP_REWRITE_SKIP_DIR_NAMES.has(name)) continue;
      walk(join(dir, name));
    }
  }
  walk(root);
  return out;
}

/**
 * 本机 rsync 前改写依赖。常见坑：artifact 仅为 apps/server/dist 且构建未把 package.json 打进 dist，
 * 只改 dist/package.json 会跳过，远端仍用旧文件 → file:database。此时会改写 apps/server/package.json 并复制到 dist/。
 */
export function rewriteWorkspacePackageJsonsForDeploy(
  config: ModuleConfig,
  artifactDir: string,
  workdir?: string
) {
  const wd = (workdir ?? getReleaseWorkdir()).trim();
  const map = workspaceDepsRewriteMap(config);
  const legacyVendor = wantsLegacyVendorSentinelRewrite(config);
  const normArt = artifactDir.replace(/\/+$/, "");
  const artifactPkg = join(normArt, "package.json");
  const hadArtifactPkg = existsSync(artifactPkg);

  const toRewrite = new Set<string>();
  const touch = (p: string) => {
    if (existsSync(p)) toRewrite.add(resolve(p));
  };

  touch(artifactPkg);
  if (basename(normArt) === "dist") {
    touch(join(dirname(normArt), "package.json"));
  }
  if (config.repoSubdir?.trim()) {
    touch(
      join(
        wd,
        safeDeployRelPath("repoSubdir", config.repoSubdir.trim()),
        "package.json"
      )
    );
  }

  for (const p of toRewrite) {
    rewriteOneDeployPackageJson(p, map, "deployRoot", legacyVendor);
  }

  if (!hadArtifactPkg && basename(normArt) === "dist" && toRewrite.size === 0) {
    throw new Error(
      `rewriteWorkspaceDepsInPackageJson：产物目录 ${normArt} 下无 package.json，且未找到 ${join(dirname(normArt), "package.json")}（或 repoSubdir package.json）。请让构建把 package.json 打进 dist，或检查 artifactPath。`
    );
  }

  if (!hadArtifactPkg && toRewrite.size > 0) {
    const parentPkg =
      basename(normArt) === "dist" ? join(dirname(normArt), "package.json") : "";
    const prefer =
      parentPkg && toRewrite.has(resolve(parentPkg))
        ? resolve(parentPkg)
        : [...toRewrite][0];
    copyFileSync(prefer, artifactPkg);
  }

  for (const extra of config.rsyncExtras || []) {
    const fromRel = safeDeployRelPath("rsyncExtras.from", extra.from);
    const srcRoot = join(wd, fromRel);
    const pkgPath = join(srcRoot, "package.json");
    if (!existsSync(pkgPath)) {
      throw new Error(
        `rsyncExtras 源 ${srcRoot} 缺少 package.json，无法改写依赖；npm install 会读到未改写的 file:database（与根目录 assert 通过无关）。`
      );
    }
    const j = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, map, {
      stripPackageManagerAndWorkspaces: true,
      depInstallContext: "sentinelSibling",
      legacyVendorSentinelToNodeModules: legacyVendor,
    });
    writeFileSync(pkgPath, JSON.stringify(j, null, 2) + "\n");
    assertPackageJsonHasNoBareSingleSegmentFileDeps(pkgPath);
    assertPackageJsonHasNoUnsupportedProtocolsForNpmInstall(pkgPath);
  }

  if (!existsSync(artifactPkg)) {
    throw new Error(`内部错误：改写流程结束后仍缺少部署产物 package.json：${artifactPkg}`);
  }
  rewriteOneDeployPackageJson(artifactPkg, map, "deployRoot", legacyVendor);
  assertPackageJsonHasNoBareSingleSegmentFileDeps(artifactPkg);
  assertPackageJsonHasNoUnsupportedProtocolsForNpmInstall(artifactPkg);

  const deepAll = new Set<string>();
  for (const p of collectPackageJsonPathsUnderDir(normArt, { skipNodeModules: false })) {
    deepAll.add(p);
  }
  for (const extra of config.rsyncExtras || []) {
    const fromRel = safeDeployRelPath("rsyncExtras.from", extra.from);
    const srcRoot = join(wd, fromRel);
    for (const p of collectPackageJsonPathsUnderDir(srcRoot, { skipNodeModules: true })) {
      deepAll.add(p);
    }
  }
  for (const p of deepAll) {
    const ctx = inferDepInstallContextForPackageJsonPath(p, normArt, config, wd);
    rewriteOneDeployPackageJson(p, map, ctx, legacyVendor);
  }
  for (const p of deepAll) {
    assertPackageJsonHasNoBareSingleSegmentFileDeps(p);
    assertPackageJsonHasNoUnsupportedProtocolsForNpmInstall(p);
  }
}

function workspaceDepsRewriteMap(config: ModuleConfig): Record<string, string> {
  if (config.workspaceDepsRewrite && Object.keys(config.workspaceDepsRewrite).length > 0) {
    return config.workspaceDepsRewrite;
  }
  const raw = env.RELEASE_WORKSPACE_DEPS_REWRITE_JSON.trim();
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (!o || typeof o !== "object") throw new Error("not an object");
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch (e: any) {
      throw new Error(
        `invalid RELEASE_WORKSPACE_DEPS_REWRITE_JSON: ${e?.message || e}`
      );
    }
  }
  return {
    "@sentinel/auth": "file:./vendor/auth",
    "@sentinel/database": "file:./vendor/database",
    "@sentinel/security-sdk": "file:./vendor/security-sdk",
  };
}

/** postDeployCmd 中的 node -e 经 ssh + bash -lc 嵌套后极易丢引号，远端表现为 SyntaxError / require(fs)。 */
export function assertPostDeployCmdNoFragileNodeEval(raw: string) {
  const t = raw.trim();
  if (!t || process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL === "true") return;
  if (/\bnode\s+(-e|--eval)\b/i.test(t)) {
    throw new Error(
      "postDeployCmd 中含有 node -e 或 node --eval：经 SSH 传到服务器后内层引号常被剥掉，远端会报 SyntaxError（例如 require(fs)、Invalid regular expression flags）。\n" +
        "请从 postDeployCmd 中删除用于改写 package.json 的那段 node -e，并在该模块的 RELEASE_MODULES_JSON 中设置 " +
        '"rewriteWorkspaceDepsInPackageJson": true（release-bot 会在本机 rsync 前改写产物与 rsyncExtras 源目录中的 package.json）。\n' +
        "若你确认引号已手工处理无误，可设环境变量 RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL=true 跳过此检查。"
    );
  }
}

export async function buildRelease(
  moduleName?: string,
  opts?: BuildReleaseOptions
) {
  const { module, config } = resolveModule(moduleName);
  if (!opts?.skipWorkspacePrepare) {
    await prepareReleaseWorkspace(opts?.gitRef ? { gitRef: opts.gitRef } : undefined);
  }

  const buildCwd = moduleInstallCwd(config);
  const preBuildCmd = config.preBuildCmd || "";
  const installCmd = config.installCmd || env.INSTALL_CMD;
  const buildCmd = config.buildCmd || env.BUILD_CMD;

  const installChunks: { stdout: string; stderr: string }[] = [];
  const packagesChunks: { stdout: string; stderr: string }[] = [];

  if (!opts?.skipInstallAndPackages) {
    installChunks.push(await run(installCmd, buildCwd));
    if (env.RELEASE_PACKAGES_BUILD_CMD.trim()) {
      packagesChunks.push(
        await run(env.RELEASE_PACKAGES_BUILD_CMD.trim(), getReleaseWorkdir())
      );
    }
  }

  const preChunks: { stdout: string; stderr: string }[] = [];
  if (preBuildCmd) preChunks.push(await run(preBuildCmd, getReleaseWorkdir()));
  const buildRes = await run(buildCmd, buildCwd);

  return {
    module,
    stdout: [
      ...installChunks.map((c) => c.stdout),
      ...packagesChunks.map((c) => c.stdout),
      ...preChunks.map((c) => c.stdout),
      buildRes.stdout,
    ]
      .filter(Boolean)
      .join("\n"),
    stderr: [
      ...installChunks.map((c) => c.stderr),
      ...packagesChunks.map((c) => c.stderr),
      ...preChunks.map((c) => c.stderr),
      buildRes.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/** 部署：SSH mkdir → 可选快照 → rsync 主产物 → rsyncExtras → postDeployCmd → remoteRestartCmd */
export async function deployRelease(moduleName?: string) {
  const { module, config } = resolveModule(moduleName);
  ensureConfigured("DEPLOY_HOST", env.DEPLOY_HOST);
  ensureConfigured("DEPLOY_USER", env.DEPLOY_USER);
  ensureConfigured("DEPLOY_PATH", config.deployPath || env.DEPLOY_PATH);
  ensureConfigured("REMOTE_RESTART_CMD", config.remoteRestartCmd || env.REMOTE_RESTART_CMD);
  ensureConfigured("BUILD_ARTIFACT_PATH", config.artifactPath || env.BUILD_ARTIFACT_PATH);

  const artifactPath = config.artifactPath || env.BUILD_ARTIFACT_PATH;
  const deployPath = deployPathNormalized(
    config.deployPath || env.DEPLOY_PATH
  );
  const restartCmdRaw = config.remoteRestartCmd || env.REMOTE_RESTART_CMD;
  const postDeployCmdRaw = config.postDeployCmd || "";
  const deleteFlag = config.rsyncDelete === false ? "" : "--delete";
  const artifactDir = `${getReleaseWorkdir()}/${artifactPath}`.replace(/\/+$/, "");

  try {
    await access(artifactDir);
  } catch {
    throw new Error(`本地产物目录不存在，请先打包: ${artifactDir}`);
  }

  assertPostDeployCmdNoFragileNodeEval(postDeployCmdRaw);

  const sshOpts = sshBaseOpts();
  const sshExe = `ssh ${sshOpts}`;
  const target = sshTarget();
  const mkdirCmd =
    `${sshExe} ${shellEscape(target)} ${shellEscape(`mkdir -p ${deployPath}`)}`;
  await run(mkdirCmd, "/");

  let hadRemoteSnapshot = false;
  if (env.RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL) {
    const snapRes = await remoteSnapshotDeployDir(deployPath, sshExe, target);
    hadRemoteSnapshot = snapRes.stdout.includes(BACKUP_MARK);
  }

  // 勿同步环境文件与 infra 基线：被 exclude 的远端路径在 --delete 下通常仍保留（见 rsync 文档）
  const rsyncExcludes = rsyncExcludeFlags();

  const rsyncCmd =
    `rsync -azL ${deleteFlag} ${rsyncExcludes}-e ${shellEscape(sshExe)} ` +
    `${shellEscape(`${artifactDir}/`)} ` +
    `${shellEscape(`${target}:${deployPath}/`)}`;
  const postDeployCmd = postDeployCmdRaw
    ? `${sshExe} ${shellEscape(target)} ${shellEscape(postDeployCmdRaw)}`
    : "";
  const restartCmd =
    `${sshExe} ${shellEscape(target)} ${shellEscape(restartCmdRaw)}`;

  /** 默认开启，避免未配 rsyncExtras / 未显式 true 时仍上传单段 file:database 导致远端 npm ENOENT。 */
  const shouldRewriteWorkspaceDeps =
    config.rewriteWorkspaceDepsInPackageJson !== false;

  const runDeploySteps = async () => {
    assertRsyncExtrasSentinelNotUnderNodeModules(config);
    let rewriteWorkspaceRes = { stdout: "", stderr: "" };
    if (shouldRewriteWorkspaceDeps) {
      rewriteWorkspacePackageJsonsForDeploy(config, artifactDir);
      rewriteWorkspaceRes = {
        stdout:
          "【本机】已重写 deploy 产物与 rsyncExtras 源目录中的 package.json（将随 rsync 上传；不依赖远端 SSH 执行 node）\n",
        stderr: "",
      };
    }

    const uploadRes = await run(rsyncCmd, "/");

    let remoteRootProtoCheckRes = { stdout: "", stderr: "" };
    if (shouldRewriteWorkspaceDeps) {
      remoteRootProtoCheckRes = await runRemoteRootPackageJsonNpmProtocolCheck(
        deployPath,
        sshExe,
        target
      );
    }

    let extraChunks = await runRsyncExtrasUpload(
      config.rsyncExtras,
      deployPath,
      sshExe,
      target,
      rsyncExcludes
    );

    let cleanResyncChunks: { stdout: string; stderr: string }[] = [];
    if (config.cleanRemoteNodeModulesAndResyncExtrasBeforePostDeploy) {
      if (!(config.rsyncExtras && config.rsyncExtras.length > 0)) {
        throw new Error(
          "cleanRemoteNodeModulesAndResyncExtrasBeforePostDeploy 需要配置 rsyncExtras，否则清空 node_modules 后无法恢复 @sentinel"
        );
      }
      const rmNm = `${sshExe} ${shellEscape(target)} ${shellEscape(`rm -rf ${deployPath}/node_modules`)}`;
      await run(rmNm, "/");
      cleanResyncChunks = await runRsyncExtrasUpload(
        config.rsyncExtras,
        deployPath,
        sshExe,
        target,
        rsyncExcludes
      );
    }

    let prismaAfterExtrasRes = { stdout: "", stderr: "" };
    if (wantsRemotePrismaAfterExtras(module || "", config)) {
      prismaAfterExtrasRes = await runRemotePrismaGenerate(
        deployPath,
        sshExe,
        target
      );
    }

    let prismaHostRes = { stdout: "", stderr: "" };
    let prismaMainNextMirrorRes = { stdout: "", stderr: "" };
    const modName = module || "";
    if (wantsRemotePrismaHostBeforePostDeploy(modName, config)) {
      const hostPath = remotePrismaServerDeployPathForSync();
      if (!hostPath) {
        throw new Error(
          "无法解析 API 部署目录（请设置 REMOTE_PRISMA_SERVER_DEPLOY_PATH，或在 RELEASE_MODULES_JSON 中为 server 配置 deployPath），否则无法在 sync-main-next 前生成 Prisma client"
        );
      }
      prismaHostRes = await runRemotePrismaGenerate(
        hostPath,
        sshExe,
        target
      );
      /** standalone 无 schema 文件，改为从 API 目录已生成的 client 拷入 main-next */
      if (modName === "main-next") {
        prismaMainNextMirrorRes = await runRemoteMirrorPrismaClientFromApiToMainNext(
          hostPath,
          deployPath,
          sshExe,
          target
        );
      }
    }

    let remoteBareFileCheckRes = { stdout: "", stderr: "" };
    remoteBareFileCheckRes = await runRemoteBareSentinelFileSpecCheck(
      deployPath,
      sshExe,
      target
    );

    const postDeployRes = postDeployCmd
      ? await run(postDeployCmd, "/")
      : { stdout: "", stderr: "" };

    const restartRes = await run(restartCmd, "/");

    return {
      uploadRes,
      remoteRootProtoCheckRes,
      extraChunks,
      cleanResyncChunks,
      rewriteWorkspaceRes,
      prismaAfterExtrasRes,
      remoteBareFileCheckRes,
      postDeployRes,
      prismaHostRes,
      prismaMainNextMirrorRes,
      restartRes,
    };
  };

  try {
    const {
      uploadRes,
      remoteRootProtoCheckRes,
      extraChunks,
      cleanResyncChunks,
      rewriteWorkspaceRes,
      prismaAfterExtrasRes,
      remoteBareFileCheckRes,
      postDeployRes,
      prismaHostRes,
      prismaMainNextMirrorRes,
      restartRes,
    } = await runDeploySteps();

    const rollbackMeta: DeployRollbackMeta | undefined = hadRemoteSnapshot
      ? {
          module: module || env.RELEASE_DEFAULT_MODULE || "",
          deployPath,
        }
      : undefined;

    return {
      module,
      stdout: [
        hadRemoteSnapshot
          ? `【快照】已备份远端目录至 ${prevSnapshotPath(deployPath)}`
          : "",
        uploadRes.stdout,
        remoteRootProtoCheckRes.stdout
          ? `【远端根 package.json 协议预检（rsync 后）】\n${remoteRootProtoCheckRes.stdout}`
          : "",
        ...extraChunks.map((c) => c.stdout),
        cleanResyncChunks.length
          ? `【远端清空 node_modules 后再次 rsyncExtras】\n${cleanResyncChunks.map((c) => c.stdout).filter(Boolean).join("\n")}`
          : "",
        rewriteWorkspaceRes.stdout
          ? `【package.json 依赖重写】\n${rewriteWorkspaceRes.stdout}`
          : "",
        prismaAfterExtrasRes.stdout
          ? `【远端 Prisma generate（模块目录）】\n${prismaAfterExtrasRes.stdout}`
          : "",
        prismaHostRes.stdout
          ? `【远端 Prisma generate（API 目录，postDeploy 前）】\n${prismaHostRes.stdout}`
          : "",
        prismaMainNextMirrorRes.stdout
          ? `【远端 Prisma client → main-next（postDeploy 前）】\n${prismaMainNextMirrorRes.stdout}`
          : "",
        remoteBareFileCheckRes.stdout
          ? `【远端单段 file: 预检（postDeploy 前）】\n${remoteBareFileCheckRes.stdout}`
          : "",
        postDeployRes.stdout,
        restartRes.stdout,
      ]
        .filter(Boolean)
        .join("\n"),
      stderr: [
        uploadRes.stderr,
        remoteRootProtoCheckRes.stderr,
        ...extraChunks.map((c) => c.stderr),
        ...cleanResyncChunks.map((c) => c.stderr),
        rewriteWorkspaceRes.stderr,
        prismaAfterExtrasRes.stderr,
        prismaHostRes.stderr,
        prismaMainNextMirrorRes.stderr,
        remoteBareFileCheckRes.stderr,
        postDeployRes.stderr,
        restartRes.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
      rollbackMeta,
    };
  } catch (err: any) {
    if (env.RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL && hadRemoteSnapshot) {
      try {
        await remoteRestoreDeployFromSnapshot(deployPath, sshExe, target);
        await run(restartCmd, "/");
      } catch (restoreErr: any) {
        throw new Error(
          `部署失败，且自动回滚远端目录时出错: ${restoreErr?.message || restoreErr}\n原始错误: ${err?.message || err}`
        );
      }
      throw new Error(
        `部署失败，已从 ${prevSnapshotPath(deployPath)} 恢复远端目录并已尝试重启。\n原始错误: ${err?.message || err}`
      );
    }
    throw err;
  }
}

/**
 * 发布流水线（顺序固定）：
 * 1. 拉取发布仓代码（fetch / checkout / reset / clean）
 * 2. 安装依赖 + 全仓 packages 构建（若配置了 RELEASE_PACKAGES_BUILD_CMD）
 * 3. 按模块依次打包（preBuild + buildCmd，不再拉代码、不再重复 install/packages）
 * 4. 按模块依次：上传（rsync 主产物 + extras）→ 远程 postDeployCmd → 远程重启
 *    部署顺序见 orderedTargetsForDeploy（vendor-sentinel → server → 其余）。
 */
export async function releasePipeline(options: {
  moduleNames?: string[];
  gitRef?: string;
}) {
  const chunks: string[] = [];
  const gitRef = options.gitRef;

  const targets = options.moduleNames?.length ? options.moduleNames : [undefined];

  await prepareReleaseWorkspace(gitRef ? { gitRef } : undefined);
  chunks.push("【1 拉取代码】完成");

  const { config: batchConfig } = resolveModule(targets[0]);
  const batchInstallCwd = moduleInstallCwd(batchConfig);
  const batchInstallCmd = batchConfig.installCmd || env.INSTALL_CMD;
  const installRes = await run(batchInstallCmd, batchInstallCwd);
  let packagesOut = { stdout: "", stderr: "" };
  if (env.RELEASE_PACKAGES_BUILD_CMD.trim()) {
    packagesOut = await run(
      env.RELEASE_PACKAGES_BUILD_CMD.trim(),
      getReleaseWorkdir()
    );
  }
  chunks.push(
    `【2 安装与 packages 构建】\n${trimOutput(
      [
        installRes.stdout,
        installRes.stderr,
        packagesOut.stdout,
        packagesOut.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
      800
    )}`
  );

  const pipelineOpts: BuildReleaseOptions = {
    ...(gitRef ? { gitRef } : {}),
    skipWorkspacePrepare: true,
    skipInstallAndPackages: true,
  };

  for (const target of targets) {
    const buildRes = await buildRelease(target, pipelineOpts);
    chunks.push(
      `【3 打包】${buildRes.module ? `(${buildRes.module})` : ""}\n${trimOutput(buildRes.stdout || buildRes.stderr, 600)}`
    );
  }

  const deployedStack: DeployRollbackMeta[] = [];
  try {
    for (const target of orderedTargetsForDeploy(targets)) {
      const deployRes = await deployRelease(target);
      if (deployRes.rollbackMeta) deployedStack.push(deployRes.rollbackMeta);
      chunks.push(
        `【4 上传 / 远程命令 / 重启】${deployRes.module ? `(${deployRes.module})` : ""}\n${trimOutput(deployRes.stdout || deployRes.stderr, 600)}`
      );
    }
  } catch (e: any) {
    if (deployedStack.length && env.RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL) {
      const extra = await rollbackDeployStack(deployedStack);
      throw new Error(
        `${e?.message || e}\n\n【多模块发布】后续步骤失败，已按逆序尝试回滚此前已成功部署的模块：\n${extra}`
      );
    }
    throw e;
  }

  return chunks.join("\n\n");
}

export function resolveReleaseModules(moduleName?: string) {
  if (moduleName === "all") return getAllModuleNames();
  if (moduleName) return [moduleName];
  return getAllModuleNames();
}
