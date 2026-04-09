import "dotenv/config";
import { env } from "../src/config/env";
import {
  releasePipeline,
  resolveReleaseModules,
} from "../src/services/release.service";

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

  const spec = positional[0];
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
