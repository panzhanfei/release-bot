import {
  env,
  ensureConfigured,
  getAllModuleNames,
  resolveModule,
} from "../config/env";
import { run } from "../utils/shell";
import { safeBranch, shellEscape, trimOutput } from "../utils/text";

export async function prepareReleaseWorkspace() {
  ensureConfigured("RELEASE_REPO_URL", env.RELEASE_REPO_URL);
  ensureConfigured("RELEASE_WORKDIR", env.RELEASE_WORKDIR);
  const branch = safeBranch(env.RELEASE_BRANCH);

  await run(`mkdir -p ${shellEscape(env.RELEASE_WORKDIR)}`, "/");
  try {
    await run("git rev-parse --is-inside-work-tree", env.RELEASE_WORKDIR);
    await run("git fetch --all --prune", env.RELEASE_WORKDIR);
    await run(`git checkout ${shellEscape(branch)}`, env.RELEASE_WORKDIR);
    await run(`git reset --hard origin/${branch}`, env.RELEASE_WORKDIR);
  } catch {
    await run(
      `git clone --branch ${shellEscape(branch)} ${shellEscape(env.RELEASE_REPO_URL)} ${shellEscape(env.RELEASE_WORKDIR)}`,
      "/"
    );
  }
}

export async function buildRelease(moduleName?: string) {
  const { module, config } = resolveModule(moduleName);
  await prepareReleaseWorkspace();

  const buildCwd = config.repoSubdir
    ? `${env.RELEASE_WORKDIR}/${config.repoSubdir}`
    : env.RELEASE_WORKDIR;
  const preBuildCmd = config.preBuildCmd || "";
  const installCmd = config.installCmd || env.INSTALL_CMD;
  const buildCmd = config.buildCmd || env.BUILD_CMD;

  if (preBuildCmd) await run(preBuildCmd, env.RELEASE_WORKDIR);
  const installRes = await run(installCmd, buildCwd);
  const buildRes = await run(buildCmd, buildCwd);

  return {
    module,
    stdout: [installRes.stdout, buildRes.stdout].filter(Boolean).join("\n"),
    stderr: [installRes.stderr, buildRes.stderr].filter(Boolean).join("\n"),
  };
}

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

  const rsyncCmd =
    `rsync -az ${deleteFlag} -e "ssh -p ${env.SSH_PORT}" ` +
    `${shellEscape(`${artifactDir}/`)} ` +
    `${shellEscape(`${env.DEPLOY_USER}@${env.DEPLOY_HOST}:${deployPath}/`)}`;
  const postDeployCmd = postDeployCmdRaw
    ? `ssh -p ${env.SSH_PORT} ${shellEscape(`${env.DEPLOY_USER}@${env.DEPLOY_HOST}`)} ${shellEscape(postDeployCmdRaw)}`
    : "";
  const restartCmd =
    `ssh -p ${env.SSH_PORT} ${shellEscape(`${env.DEPLOY_USER}@${env.DEPLOY_HOST}`)} ` +
    `${shellEscape(restartCmdRaw)}`;

  const uploadRes = await run(rsyncCmd, "/");
  const postDeployRes = postDeployCmd ? await run(postDeployCmd, "/") : { stdout: "", stderr: "" };
  const restartRes = await run(restartCmd, "/");

  return {
    module,
    stdout: [uploadRes.stdout, postDeployRes.stdout, restartRes.stdout].filter(Boolean).join("\n"),
    stderr: [uploadRes.stderr, postDeployRes.stderr, restartRes.stderr].filter(Boolean).join("\n"),
  };
}

export async function releasePipeline(options: {
  moduleNames?: string[];
}) {
  const chunks: string[] = [];

  const targets = options.moduleNames?.length ? options.moduleNames : [undefined];
  for (const target of targets) {
    const buildRes = await buildRelease(target);
    chunks.push(
      `打包完成${buildRes.module ? `(${buildRes.module})` : ""}:\n${trimOutput(buildRes.stdout || buildRes.stderr, 600)}`
    );
    const deployRes = await deployRelease(target);
    chunks.push(
      `部署完成${deployRes.module ? `(${deployRes.module})` : ""}:\n${trimOutput(deployRes.stdout || deployRes.stderr, 600)}`
    );
  }
  return chunks.join("\n\n");
}

export function resolveReleaseModules(moduleName?: string) {
  if (moduleName === "all") return getAllModuleNames();
  if (moduleName) return [moduleName];
  return getAllModuleNames();
}
