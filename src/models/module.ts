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
};
