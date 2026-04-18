import "dotenv/config";
import { env, resolveModule } from "../src/config/env";
import {
  releasePipeline,
  resolveReleaseModules,
} from "../src/services/release.service";
import { safeGitRef } from "../src/utils/text";

function parseArgs(argv: string[]) {
  let confirm: string | undefined;
  const positional: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--confirm=")) {
      confirm = a.slice("--confirm=".length);
    } else if (!a.startsWith("-")) {
      positional.push(a);
    }
  }
  return { confirm, positional };
}

async function main() {
  const { confirm, positional } = parseArgs(process.argv.slice(2));
  if (env.RELEASE_CONFIRM_TOKEN && confirm !== env.RELEASE_CONFIRM_TOKEN) {
    console.error(
      "需要确认码：在命令后追加 --confirm=<你的 RELEASE_CONFIRM_TOKEN>"
    );
    process.exit(1);
  }

  const head = positional[0];
  if (head === "rollback") {
    const modSpec = positional[1];
    const gitRefRaw = positional.slice(2).join(" ").trim();
    if (!modSpec || !gitRefRaw) {
      console.error(
        "用法: pnpm run release rollback <模块名|all> <commit|tag|分支> [--confirm=...]"
      );
      process.exit(1);
    }
    const gitRef = safeGitRef(gitRefRaw);
    if (modSpec !== "all" && !resolveModule(modSpec).module) {
      console.error(`未知模块: ${modSpec}（请使用 RELEASE_MODULES_JSON 中的模块名或 all）`);
      process.exit(1);
    }
    const moduleNames = resolveReleaseModules(modSpec === "all" ? "all" : modSpec);
    if (!moduleNames.length) {
      console.error(
        "未解析到任何模块：请配置 RELEASE_MODULES_JSON，或指定已配置模块名，或 all"
      );
      process.exit(1);
    }
    console.log(`Git 回滚开始，引用: ${gitRef}，模块: ${moduleNames.join(", ")}`);
    const out = await releasePipeline({ moduleNames, gitRef });
    console.log(out);
    console.log("Git 回滚结束");
    return;
  }

  const spec = head;
  const moduleNames = resolveReleaseModules(
    spec === "all" ? "all" : spec
  );

  if (!moduleNames.length) {
    console.error(
      "未解析到任何模块：请配置 RELEASE_MODULES_JSON，或指定模块名，或使用 all"
    );
    process.exit(1);
  }

  console.log(`一键发布开始，模块: ${moduleNames.join(", ")}`);
  const out = await releasePipeline({ moduleNames });
  console.log(out);
  console.log("一键发布结束");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
