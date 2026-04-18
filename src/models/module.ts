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
};
