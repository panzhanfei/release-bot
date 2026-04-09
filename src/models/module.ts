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
};
