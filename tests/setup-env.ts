import { resolve } from "node:path";

/**
 * Runs before any test file import so `src/config/env.ts` reads stable values.
 */
const workdir = resolve("/tmp/release-bot-contract-workdir");

process.env.RELEASE_REPO_URL ??= "git@example.com/contract/monorepo.git";
process.env.RELEASE_WORKDIR = workdir;
process.env.RELEASE_BRANCH = "main";
process.env.DEPLOY_HOST = "127.0.0.1";
process.env.DEPLOY_USER = "root";
process.env.REPO_PATH = "/tmp";
process.env.RELEASE_CONFIRM_TOKEN = "";
process.env.RELEASE_AUTO_ROLLBACK_ON_DEPLOY_FAIL = "false";
process.env.RELEASE_PACKAGES_BUILD_CMD = "";
process.env.RELEASE_REMOTE_PRISMA_GENERATE = "false";

process.env.RELEASE_MODULES_JSON = JSON.stringify({
  server: {
    deployPath: "/remote/server",
    artifactPath: "apps/server/dist",
    remoteRestartCmd: "bash -lc true",
    buildCmd: "echo server-build",
    installCmd: "echo install-server",
  },
  "main-next": {
    deployPath: "/remote/main-next",
    artifactPath: "apps/main-next/.release",
    remoteRestartCmd: "bash -lc true",
    buildCmd: "echo next-build",
    installCmd: "echo install-next",
    postDeployCmd: "bash -lc true",
  },
});
