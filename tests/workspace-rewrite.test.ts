import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyWorkspaceDepRewritesToPackageJsonObject,
  assertPackageJsonHasNoBareSingleSegmentFileDeps,
  assertPostDeployCmdNoFragileNodeEval,
  inferDepInstallContextForPackageJsonPath,
  rewriteWorkspacePackageJsonsForDeploy,
} from "../src/services/release.service";

const sentinelMap = {
  "@sentinel/auth": "file:./vendor/auth",
  "@sentinel/database": "file:./vendor/database",
  "@sentinel/security-sdk": "file:./vendor/security-sdk",
};

describe("applyWorkspaceDepRewritesToPackageJsonObject", () => {
  it("replaces workspace: and normalizes single-segment file: deps (root package)", () => {
    const j = {
      name: "test-api",
      dependencies: {
        "@sentinel/database": "file:./database",
        "@sentinel/security-sdk": "file:security-sdk",
        "@sentinel/auth": "workspace:*",
      },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: true,
    });
    const deps = j.dependencies as Record<string, string>;
    expect(deps["@sentinel/database"]).toBe("file:./vendor/database");
    expect(deps["@sentinel/security-sdk"]).toBe("file:./vendor/security-sdk");
    expect(deps["@sentinel/auth"]).toBe("file:./vendor/auth");
  });

  it("replaces catalog: with map target (pnpm catalog protocol)", () => {
    const j = {
      dependencies: { "@sentinel/database": "catalog:default" },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
    });
    expect((j.dependencies as Record<string, string>)["@sentinel/database"]).toBe(
      "file:./vendor/database"
    );
  });

  it("normalizes file: in nested npm overrides", () => {
    const j = {
      overrides: {
        "@sentinel/security-sdk": {
          "@sentinel/database": "file:database",
        },
      },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
    });
    const inner = (j.overrides as Record<string, Record<string, string>>)[
      "@sentinel/security-sdk"
    ];
    expect(inner["@sentinel/database"]).toBe("file:./vendor/database");
  });

  it("deployRoot: @sentinel manifest uses ./vendor paths for peers", () => {
    const j = {
      name: "@sentinel/security-sdk",
      dependencies: { "@sentinel/database": "file:database" },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
      depInstallContext: "deployRoot",
    });
    const deps = j.dependencies as Record<string, string>;
    expect(deps["@sentinel/database"]).toBe("file:./vendor/database");
  });

  it("legacy vendor-sentinel paths become ./vendor when extras use vendor/ (deployRoot)", () => {
    const j = {
      name: "server",
      dependencies: {
        "@sentinel/auth": "file:../vendor-sentinel/auth",
        "@sentinel/database": "file:./../vendor-sentinel/database",
      },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
      depInstallContext: "deployRoot",
      legacyVendorSentinelToNodeModules: true,
    });
    const deps = j.dependencies as Record<string, string>;
    expect(deps["@sentinel/auth"]).toBe("file:./vendor/auth");
    expect(deps["@sentinel/database"]).toBe("file:./vendor/database");
  });

  it("rewrites file:./node_modules/@sentinel/x to file:./vendor/x (npm 9)", () => {
    const j = {
      dependencies: {
        "@sentinel/auth": "file:./node_modules/@sentinel/auth",
      },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
      depInstallContext: "deployRoot",
    });
    expect((j.dependencies as Record<string, string>)["@sentinel/auth"]).toBe(
      "file:./vendor/auth"
    );
  });

  it("sentinelSibling: file:/workspace under @sentinel package dir uses ../ peers (npm resolution)", () => {
    const j = {
      name: "@sentinel/security-sdk",
      dependencies: {
        "@sentinel/database": "file:database",
        "@sentinel/auth": "workspace:*",
      },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
      depInstallContext: "sentinelSibling",
    });
    const deps = j.dependencies as Record<string, string>;
    expect(deps["@sentinel/database"]).toBe("file:../database");
    expect(deps["@sentinel/auth"]).toBe("file:../auth");
  });

  it("normalizes file: in yarn-style resolutions", () => {
    const j = {
      resolutions: { "@sentinel/database": "file:database" },
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, sentinelMap, {
      stripPackageManagerAndWorkspaces: false,
    });
    expect((j.resolutions as Record<string, string>)["@sentinel/database"]).toBe(
      "file:./vendor/database"
    );
  });

  it("strips packageManager and workspaces when strip option true", () => {
    const j = {
      packageManager: "pnpm@9",
      workspaces: ["packages/*"],
      dependencies: {},
    } as Record<string, unknown>;
    applyWorkspaceDepRewritesToPackageJsonObject(j, {}, {
      stripPackageManagerAndWorkspaces: true,
    });
    expect(j.packageManager).toBeUndefined();
    expect(j.workspaces).toBeUndefined();
  });

  it("assertPackageJsonHasNoBareSingleSegmentFileDeps throws on file:database", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-bot-assert-"));
    const p = join(tmp, "package.json");
    writeFileSync(p, JSON.stringify({ dependencies: { "@sentinel/database": "file:database" } }));
    expect(() => assertPackageJsonHasNoBareSingleSegmentFileDeps(p)).toThrow(/单段 file:/);
  });

  it("when dist/ has no package.json, rewrites apps/server/package.json and copies into dist/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-bot-dist-pkg-"));
    const appServer = join(tmp, "apps", "server");
    const dist = join(appServer, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(appServer, "package.json"),
      JSON.stringify({
        name: "server",
        dependencies: { "@sentinel/database": "file:database" },
      })
    );
    rewriteWorkspacePackageJsonsForDeploy({ rsyncExtras: [] }, dist, tmp);
    expect(readFileSync(join(dist, "package.json"), "utf8")).toContain("file:./vendor/database");
  });

  it("deep-rewrites nested package.json under rsyncExtras.from and under artifact node_modules", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-bot-deep-"));
    const dist = join(tmp, "apps", "server", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(tmp, "apps", "server", "package.json"),
      JSON.stringify({
        name: "server",
        dependencies: { "@sentinel/database": "file:database" },
      })
    );
    const dbPkg = join(tmp, "packages", "database");
    mkdirSync(join(dbPkg, "tools", "x"), { recursive: true });
    writeFileSync(
      join(dbPkg, "package.json"),
      JSON.stringify({ name: "@sentinel/database", dependencies: {} })
    );
    writeFileSync(
      join(dbPkg, "tools", "x", "package.json"),
      JSON.stringify({
        dependencies: { "@sentinel/security-sdk": "file:security-sdk" },
      })
    );
    const nmAuth = join(dist, "node_modules", "@sentinel", "auth");
    mkdirSync(nmAuth, { recursive: true });
    writeFileSync(
      join(nmAuth, "package.json"),
      JSON.stringify({
        name: "@sentinel/auth",
        dependencies: { "@sentinel/database": "file:database" },
      })
    );

    rewriteWorkspacePackageJsonsForDeploy(
      {
        rsyncExtras: [{ from: "packages/database", to: "vendor/database" }],
      },
      dist,
      tmp
    );

    const nested = JSON.parse(
      readFileSync(join(dbPkg, "tools", "x", "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(nested.dependencies["@sentinel/security-sdk"]).toBe("file:./vendor/security-sdk");
    const shipped = JSON.parse(
      readFileSync(join(nmAuth, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> };
    expect(shipped.dependencies["@sentinel/database"]).toBe("file:../database");
  });

  it("inferDepInstallContextForPackageJsonPath: artifact root vs @sentinel vs extras root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-bot-infer-"));
    const dist = join(tmp, "apps", "server", "dist");
    mkdirSync(join(dist, "node_modules", "@sentinel", "auth"), { recursive: true });
    const rootPkg = join(dist, "package.json");
    const authPkg = join(dist, "node_modules", "@sentinel", "auth", "package.json");
    writeFileSync(rootPkg, "{}");
    writeFileSync(authPkg, "{}");
    const dbSrc = join(tmp, "packages", "database");
    mkdirSync(dbSrc, { recursive: true });
    const dbPkg = join(dbSrc, "package.json");
    writeFileSync(dbPkg, "{}");

    const cfg = {
      rsyncExtras: [{ from: "packages/database", to: "vendor/database" }],
    };

    expect(
      inferDepInstallContextForPackageJsonPath(rootPkg, dist, cfg, tmp)
    ).toBe("deployRoot");
    expect(
      inferDepInstallContextForPackageJsonPath(authPkg, dist, cfg, tmp)
    ).toBe("sentinelSibling");
    expect(
      inferDepInstallContextForPackageJsonPath(dbPkg, dist, cfg, tmp)
    ).toBe("sentinelSibling");
  });

  it("inferDepInstallContext: vendor/foo/package.json under artifact is sentinelSibling", () => {
    const tmp = mkdtempSync(join(tmpdir(), "release-bot-infer-vendor-"));
    const dist = join(tmp, "apps", "server", "dist");
    mkdirSync(join(dist, "vendor", "auth"), { recursive: true });
    const vpkg = join(dist, "vendor", "auth", "package.json");
    writeFileSync(join(dist, "package.json"), "{}");
    writeFileSync(vpkg, "{}");
    expect(
      inferDepInstallContextForPackageJsonPath(vpkg, dist, { rsyncExtras: [] }, tmp)
    ).toBe("sentinelSibling");
  });
});

describe("assertPostDeployCmdNoFragileNodeEval", () => {
  const saved = process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL;

  afterEach(() => {
    if (saved === undefined) delete process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL;
    else process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL = saved;
  });

  it("throws when postDeployCmd contains node -e and allow flag unset", () => {
    delete process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL;
    expect(() =>
      assertPostDeployCmdNoFragileNodeEval(
        `bash -lc "cd /x && node -e \\"console.log(1)\\""`
      )
    ).toThrow(/node -e/);
  });

  it("allows node -e when RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL=true", () => {
    process.env.RELEASE_ALLOW_POSTDEPLOY_NODE_EVAL = "true";
    expect(() => assertPostDeployCmdNoFragileNodeEval(`node -e "1"`)).not.toThrow();
  });
});
