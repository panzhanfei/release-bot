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
  /**
   * Local file (path relative to release-bot cwd, or absolute) rsync'd to
   * `{deployPath}/.env.production` on the remote host before postDeploy/restart.
   * Keep the real file out of git (e.g. under `.secrets/`).
   */
  envProductionFile?: string;
};
