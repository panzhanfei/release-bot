import { access } from "node:fs/promises";
import {
  env,
  ensureConfigured,
  getAllModuleNames,
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

/** Remote prisma generate in a clean tmp dir (see .env.example — avoids broken nested prisma in pnpm hoists). */
function remotePrismaGenerateBash(remoteDeployRoot: string) {
  const d = deployPathNormalized(remoteDeployRoot);
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
    `pkg="$d/node_modules/@sentinel/database"`,
    `need="$pkg/node_modules/.prisma/client"`,
    `legacy="$pkg/.prisma/client"`,
    `rootc="$d/node_modules/.prisma/client"`,
    `if [ ! -d "$need" ] && [ -d "$legacy" ]; then mkdir -p "$pkg/node_modules/.prisma" && rm -rf "$pkg/node_modules/.prisma/client" && cp -a "$legacy" "$pkg/node_modules/.prisma/client" && echo "release-bot: normalized $legacy into node_modules/.prisma"; fi`,
    `if [ ! -d "$need" ] && [ -d "$rootc" ]; then mkdir -p "$pkg/node_modules/.prisma" && rm -rf "$pkg/node_modules/.prisma/client" && cp -a "$rootc" "$pkg/node_modules/.prisma/client" && echo "release-bot: copied server root .prisma/client into @sentinel/database"; fi`,
    `if [ -d "$need" ] && [ ! -d "$legacy" ]; then mkdir -p "$pkg/.prisma" && cp -a "$need" "$legacy" && echo "release-bot: mirrored client to $legacy (sync scripts often check package root)"; fi`,
    `if [ ! -d "$need" ]; then echo "release-bot: missing Prisma client at $need under $pkg; found:" >&2; find "$d/node_modules" -path "*/.prisma/client" -type d 2>/dev/null | head -40 >&2; exit 1; fi`,
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
  return [
    `s=${shellEscape(s)}`,
    `m=${shellEscape(m)}`,
    `spkg="$s/node_modules/@sentinel/database"`,
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
  ensureConfigured("RELEASE_WORKDIR", env.RELEASE_WORKDIR);
  const branch = safeBranch(env.RELEASE_BRANCH);
  const ref = options?.gitRef ? safeGitRef(options.gitRef) : undefined;

  await run(`mkdir -p ${shellEscape(env.RELEASE_WORKDIR)}`, "/");
  try {
    await run("git rev-parse --is-inside-work-tree", env.RELEASE_WORKDIR);
    await run("git fetch --all --prune --tags", env.RELEASE_WORKDIR);
    if (ref) {
      await run(`git checkout -f ${shellEscape(ref)}`, env.RELEASE_WORKDIR);
      await run(`git reset --hard ${shellEscape(ref)}`, env.RELEASE_WORKDIR);
    } else {
      await run(`git checkout ${shellEscape(branch)}`, env.RELEASE_WORKDIR);
      await run(`git reset --hard origin/${branch}`, env.RELEASE_WORKDIR);
    }
    await run("git clean -fd", env.RELEASE_WORKDIR);
  } catch {
    await run(
      `git clone --branch ${shellEscape(branch)} ${shellEscape(env.RELEASE_REPO_URL)} ${shellEscape(env.RELEASE_WORKDIR)}`,
      "/"
    );
    await run("git fetch --all --prune --tags", env.RELEASE_WORKDIR);
    if (ref) {
      await run(`git checkout -f ${shellEscape(ref)}`, env.RELEASE_WORKDIR);
      await run(`git reset --hard ${shellEscape(ref)}`, env.RELEASE_WORKDIR);
      await run("git clean -fd", env.RELEASE_WORKDIR);
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
  return config.repoSubdir
    ? `${env.RELEASE_WORKDIR}/${config.repoSubdir}`
    : env.RELEASE_WORKDIR;
}

/** 部署阶段把 `server` 放最前，便于先完成远端 prisma generate 再部署依赖其 .prisma 的模块（如 main-next）。 */
export function orderedTargetsForDeploy(
  targets: (string | undefined)[]
): (string | undefined)[] {
  if (!targets.includes("server")) return targets;
  return ["server", ...targets.filter((t) => t !== "server")];
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
        await run(env.RELEASE_PACKAGES_BUILD_CMD.trim(), env.RELEASE_WORKDIR)
      );
    }
  }

  const preChunks: { stdout: string; stderr: string }[] = [];
  if (preBuildCmd) preChunks.push(await run(preBuildCmd, env.RELEASE_WORKDIR));
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
  ensureConfigured("RELEASE_WORKDIR", env.RELEASE_WORKDIR);
  ensureConfigured("BUILD_ARTIFACT_PATH", config.artifactPath || env.BUILD_ARTIFACT_PATH);

  const artifactPath = config.artifactPath || env.BUILD_ARTIFACT_PATH;
  const deployPath = deployPathNormalized(
    config.deployPath || env.DEPLOY_PATH
  );
  const restartCmdRaw = config.remoteRestartCmd || env.REMOTE_RESTART_CMD;
  const postDeployCmdRaw = config.postDeployCmd || "";
  const deleteFlag = config.rsyncDelete === false ? "" : "--delete";
  const artifactDir = `${env.RELEASE_WORKDIR}/${artifactPath}`.replace(/\/+$/, "");

  try {
    await access(artifactDir);
  } catch {
    throw new Error(`本地产物目录不存在，请先打包: ${artifactDir}`);
  }

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

  // 勿同步环境文件：产物里常有占位 .env.production，会覆盖服务器上已配置的真实密钥；--delete 下被 exclude 的远端文件默认不会被删（见 rsync 文档）
  const rsyncExcludeEnv =
    "--exclude '.env.production' --exclude '.env' --exclude '.env.local' --exclude '.env.development' ";

  const rsyncCmd =
    `rsync -azL ${deleteFlag} ${rsyncExcludeEnv}-e ${shellEscape(sshExe)} ` +
    `${shellEscape(`${artifactDir}/`)} ` +
    `${shellEscape(`${target}:${deployPath}/`)}`;
  const postDeployCmd = postDeployCmdRaw
    ? `${sshExe} ${shellEscape(target)} ${shellEscape(postDeployCmdRaw)}`
    : "";
  const restartCmd =
    `${sshExe} ${shellEscape(target)} ${shellEscape(restartCmdRaw)}`;

  const runDeploySteps = async () => {
    const uploadRes = await run(rsyncCmd, "/");

    const extraChunks: { stdout: string; stderr: string }[] = [];
    for (const extra of config.rsyncExtras || []) {
      const fromRel = safeDeployRelPath("rsyncExtras.from", extra.from);
      const toRel = safeDeployRelPath("rsyncExtras.to", extra.to);
      const localDir = `${env.RELEASE_WORKDIR}/${fromRel}`.replace(/\/+$/, "");
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
        `rsync -azL ${rsyncExcludeEnv}-e ${shellEscape(sshExe)} ` +
        `${shellEscape(`${localDir}/`)} ` +
        `${shellEscape(`${target}:${remoteDest}/`)}`;
      extraChunks.push(await run(rsyncExtra, "/"));
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

    const postDeployRes = postDeployCmd
      ? await run(postDeployCmd, "/")
      : { stdout: "", stderr: "" };

    const restartRes = await run(restartCmd, "/");

    return {
      uploadRes,
      extraChunks,
      prismaAfterExtrasRes,
      postDeployRes,
      prismaHostRes,
      prismaMainNextMirrorRes,
      restartRes,
    };
  };

  try {
    const {
      uploadRes,
      extraChunks,
      prismaAfterExtrasRes,
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
        ...extraChunks.map((c) => c.stdout),
        prismaAfterExtrasRes.stdout
          ? `【远端 Prisma generate（模块目录）】\n${prismaAfterExtrasRes.stdout}`
          : "",
        prismaHostRes.stdout
          ? `【远端 Prisma generate（API 目录，postDeploy 前）】\n${prismaHostRes.stdout}`
          : "",
        prismaMainNextMirrorRes.stdout
          ? `【远端 Prisma client → main-next（postDeploy 前）】\n${prismaMainNextMirrorRes.stdout}`
          : "",
        postDeployRes.stdout,
        restartRes.stdout,
      ]
        .filter(Boolean)
        .join("\n"),
      stderr: [
        uploadRes.stderr,
        ...extraChunks.map((c) => c.stderr),
        prismaAfterExtrasRes.stderr,
        prismaHostRes.stderr,
        prismaMainNextMirrorRes.stderr,
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
      env.RELEASE_WORKDIR
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
