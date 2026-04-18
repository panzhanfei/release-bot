export type RsyncExtra = {
  /** Relative to RELEASE_WORKDIR (monorepo root). */
  from: string;
  /** Relative to module deployPath on the remote host. */
  to: string;
};

export type ModuleConfig = {
  repoSubdir?: string;
  preBuildCmd?: string;
  installCmd?: string;
  buildCmd?: string;
  artifactPath?: string;
  deployPath?: string;
  remoteRestartCmd?: string;
  postDeployCmd?: string;
  rsyncDelete?: boolean;
  /**
   * After the main artifact rsync: copy extra directories (e.g. built `@sentinel/*`
   * packages) into paths under deployPath. Does not use `--delete` on extras.
   */
  rsyncExtras?: RsyncExtra[];
  /** When true, skip release-bot’s automatic remote `prisma generate` for this module. */
  skipRemotePrismaGenerate?: boolean;
  /**
   * When true, after rsync + extras run remote `prisma generate` against this module’s deployPath
   * (for monorepo API dirs that ship `@sentinel/database` under node_modules). Overrides name-based default.
   */
  remotePrismaGenerateAfterExtras?: boolean;
  /**
   * When true, before postDeployCmd run `prisma generate` on REMOTE_PRISMA_SERVER_DEPLOY_PATH
   * (main-next often runs sync-main-next-prisma-client inside postDeploy; client must exist first).
   */
  remotePrismaHostGenerateBeforePostDeploy?: boolean;
  /**
   * After rsync + rsyncExtras: 本机重写 deploy 产物与 rsyncExtras 源里的 package.json（workspace:/catalog:、
   * 单段 file: 等），避免远端 npm 把 file:database 解析成 deploy 根下的 database/。
   * 默认开启；仅当显式设为 `false` 时跳过（不推荐：易导致未改写的 file: 上传）。
   * 映射见 .env.example；可用 `workspaceDepsRewrite` 或 RELEASE_WORKSPACE_DEPS_REWRITE_JSON 覆盖。
   */
  rewriteWorkspaceDepsInPackageJson?: boolean;
  /** Per-module override for workspace: -> file: 映射（优先级高于 RELEASE_WORKSPACE_DEPS_REWRITE_JSON）。 */
  workspaceDepsRewrite?: Record<string, string>;
  /**
   * 在 rewrite 之后、postDeploy 之前：SSH 删除远端 deployPath/node_modules，再按 rsyncExtras 从本机重传一遍。
   * 解决 pnpm 软链树 + npm install 的 matches / cp 断链；随后再跑内置远端 prisma（若开启）。
   */
  cleanRemoteNodeModulesAndResyncExtrasBeforePostDeploy?: boolean;
};
