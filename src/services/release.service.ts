import { access } from "node:fs/promises";
import {
  env,
  ensureConfigured,
  getAllModuleNames,
  resolveModule,
} from "../config/env";
import { run } from "../utils/shell";
import {
  safeBranch,
  safeDeployRelPath,
  safeGitRef,
  resolveEnvProductionLocalPath,
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
function orderedTargetsForDeploy(
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

/** 部署：SSH mkdir → rsync 主产物 → rsyncExtras → 可选上传 .env.production → postDeployCmd → remoteRestartCmd */
export async function deployRelease(moduleName?: string) {
  const { module, config } = resolveModule(moduleName);
  ensureConfigured("DEPLOY_HOST", env.DEPLOY_HOST);
  ensureConfigured("DEPLOY_USER", env.DEPLOY_USER);
  ensureConfigured("DEPLOY_PATH", config.deployPath || env.DEPLOY_PATH);
  ensureConfigured("REMOTE_RESTART_CMD", config.remoteRestartCmd || env.REMOTE_RESTART_CMD);
  ensureConfigured("RELEASE_WORKDIR", env.RELEASE_WORKDIR);
  ensureConfigured("BUILD_ARTIFACT_PATH", config.artifactPath || env.BUILD_ARTIFACT_PATH);

  const artifactPath = config.artifactPath || env.BUILD_ARTIFACT_PATH;
  const deployPath = config.deployPath || env.DEPLOY_PATH;
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
  const mkdirCmd =
    `${sshExe} ${shellEscape(sshTarget())} ${shellEscape(`mkdir -p ${deployPath}`)}`;
  await run(mkdirCmd, "/");

  const rsyncCmd =
    `rsync -azL ${deleteFlag} -e ${shellEscape(sshExe)} ` +
    `${shellEscape(`${artifactDir}/`)} ` +
    `${shellEscape(`${sshTarget()}:${deployPath}/`)}`;
  const postDeployCmd = postDeployCmdRaw
    ? `${sshExe} ${shellEscape(sshTarget())} ${shellEscape(postDeployCmdRaw)}`
    : "";
  const restartCmd =
    `${sshExe} ${shellEscape(sshTarget())} ${shellEscape(restartCmdRaw)}`;

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
    const remoteDest = `${deployPath.replace(/\/+$/, "")}/${toRel}`;
    const mkdirExtra = `${sshExe} ${shellEscape(sshTarget())} ${shellEscape(`mkdir -p ${remoteDest}`)}`;
    await run(mkdirExtra, "/");
    // -L/--copy-links: workspace packages often symlink into .pnpm (e.g. @prisma/client);
    // dereference so the server gets real files, not broken relative symlinks.
    const rsyncExtra =
      `rsync -azL -e ${shellEscape(sshExe)} ` +
      `${shellEscape(`${localDir}/`)} ` +
      `${shellEscape(`${sshTarget()}:${remoteDest}/`)}`;
    extraChunks.push(await run(rsyncExtra, "/"));
  }

  const envChunks: { stdout: string; stderr: string }[] = [];
  const envFileCfg = config.envProductionFile?.trim();
  if (envFileCfg) {
    const localEnv = resolveEnvProductionLocalPath(envFileCfg);
    try {
      await access(localEnv);
    } catch {
      throw new Error(
        `缺少本机生产环境文件: ${localEnv}\n请将对应 .example 复制为该路径并填写真实值（勿提交 git）。`
      );
    }
    const remoteEnv = `${deployPath.replace(/\/+$/, "")}/.env.production`;
    const rsyncEnv =
      `rsync -az -e ${shellEscape(sshExe)} ` +
      `${shellEscape(localEnv)} ` +
      `${shellEscape(`${sshTarget()}:${remoteEnv}`)}`;
    envChunks.push(await run(rsyncEnv, "/"));
  }

  const postDeployRes = postDeployCmd ? await run(postDeployCmd, "/") : { stdout: "", stderr: "" };
  const restartRes = await run(restartCmd, "/");

  return {
    module,
    stdout: [
      uploadRes.stdout,
      ...extraChunks.map((c) => c.stdout),
      ...envChunks.map((c) => c.stdout),
      envChunks.length ? "(uploaded remote .env.production)\n" : "",
      postDeployRes.stdout,
      restartRes.stdout,
    ]
      .filter(Boolean)
      .join("\n"),
    stderr: [
      uploadRes.stderr,
      ...extraChunks.map((c) => c.stderr),
      ...envChunks.map((c) => c.stderr),
      postDeployRes.stderr,
      restartRes.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * 发布流水线（顺序固定）：
 * 1. 拉取发布仓代码（fetch / checkout / reset / clean）
 * 2. 安装依赖 + 全仓 packages 构建（若配置了 RELEASE_PACKAGES_BUILD_CMD）
 * 3. 按模块依次打包（preBuild + buildCmd，不再拉代码、不再重复 install/packages）
 * 4. 按模块依次：上传（rsync 主产物 + extras + 可选 .env）→ 远程 postDeployCmd → 远程重启
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

  for (const target of orderedTargetsForDeploy(targets)) {
    const deployRes = await deployRelease(target);
    chunks.push(
      `【4 上传 / 远程命令 / 重启】${deployRes.module ? `(${deployRes.module})` : ""}\n${trimOutput(deployRes.stdout || deployRes.stderr, 600)}`
    );
  }

  return chunks.join("\n\n");
}

export function resolveReleaseModules(moduleName?: string) {
  if (moduleName === "all") return getAllModuleNames();
  if (moduleName) return [moduleName];
  return getAllModuleNames();
}
