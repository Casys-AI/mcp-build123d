/// <reference lib="deno.ns" />
/** Build the result viewer against one exact mcp-view implementation. */

import { dirname, fromFileUrl, join } from "@std/path";
import { requireAuditedViewerSplitModules } from "../src/ui/viewer-build-config.ts";

const here = dirname(fromFileUrl(import.meta.url));
const viewer = join(here, "..", "src", "ui", "results-viewer");
const auditedModules = requireAuditedViewerSplitModules(Deno.env);
const mcpViewModule = auditedModules.core;
const mcpViewComponentsModule = auditedModules.components;
const mcpViewComponentsPreactModule = Deno.env.get(
  "MCP_VIEW_COMPONENTS_PREACT_MODULE",
) ?? (mcpViewComponentsModule.startsWith("jsr:")
  ? `${mcpViewComponentsModule}/preact`
  : mcpViewComponentsModule.replace(/(?:mod|index)\.tsx?$/, "preact.ts"));
const mcpViewContractsModule = Deno.env.get("MCP_VIEW_CONTRACTS_MODULE") ??
  (mcpViewModule.startsWith("jsr:")
    ? "jsr:@casys/mcp-view-contracts@0.1.0"
    : mcpViewModule.replace(
      /\/view\/(?:mod|index)\.tsx?$/,
      "/view-contracts/mod.ts",
    ));
const temporaryConfigDir = await Deno.makeTempDir({
  prefix: "mcp-build123d-view-",
});
const importMap = join(temporaryConfigDir, "import-map.json");
const builds = [
  { entry: "main.ts", viewer: "results-viewer" },
] as const;
const bundles = new Map<string, string>();

try {
  await Deno.writeTextFile(
    importMap,
    JSON.stringify({
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "preact",
      },
      // Keep Deno's dependency-age quarantine for the graph except for the
      // exact Casys package audited and published with this viewer work.
      minimumDependencyAge: {
        age: "P1D",
        exclude: [
          "jsr:@casys/mcp-view",
          "jsr:@casys/mcp-view-components",
          "jsr:@casys/mcp-view-contracts",
        ],
      },
      imports: {
        "@casys/mcp-view": mcpViewModule,
        "@casys/mcp-view-components": mcpViewComponentsModule,
        "@casys/mcp-view-components/preact": mcpViewComponentsPreactModule,
        "@casys/mcp-view-contracts": mcpViewContractsModule,
        "@modelcontextprotocol/ext-apps":
          "npm:@modelcontextprotocol/ext-apps@^1.7.4",
        "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.29.0",
        "@modelcontextprotocol/sdk/types.js":
          "npm:@modelcontextprotocol/sdk@^1.29.0/types.js",
        // Keep the application JSX/hooks on the same compatible Preact
        // instance resolved by @casys/mcp-view. Two exact versions can leave
        // precompiled VNodes invisible to the renderer without throwing.
        "preact": "npm:preact@^10.28.3",
        "preact/hooks": "npm:preact@^10.28.3/hooks",
        "three": "npm:three@0.172.0",
        "three/": "npm:/three@0.172.0/",
      },
    }),
  );

  for (const build of builds) {
    const temporaryBundle = join(temporaryConfigDir, `${build.viewer}.js`);
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "bundle",
        "--config",
        importMap,
        "--check",
        "--platform=browser",
        "--minify",
        "--output",
        temporaryBundle,
        join(viewer, "src", build.entry),
      ],
    });
    const output = await command.output();
    if (!output.success) {
      throw new Error(
        `${build.viewer} bundle failed:\n${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    const js = await Deno.readTextFile(temporaryBundle);
    try {
      new Function(js);
    } catch (error) {
      throw new Error(
        `${build.viewer} bundle is not valid JavaScript: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    bundles.set(build.viewer, js);
  }
} finally {
  await Deno.remove(temporaryConfigDir, { recursive: true });
}

const template = await Deno.readTextFile(join(viewer, "index.html"));
const css = await Deno.readTextFile(join(viewer, "src", "styles.css"));
for (const build of builds) {
  const js = bundles.get(build.viewer);
  if (js === undefined) throw new Error(`Missing bundle for ${build.viewer}`);
  const html = template
    .replace("/*__BUILD123D_VIEWER_STYLES__*/", () => css)
    .replace("/*__BUILD123D_VIEWER_BUNDLE__*/", () => js)
    .replace(/[\t ]+\n/g, "\n");
  const outDir = join(here, "..", "src", "ui", "dist", build.viewer);
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(join(outDir, "index.html"), html);
  console.log(
    `[build:ui] wrote ${join(outDir, "index.html")} (${
      Math.round(html.length / 1024)
    } KB)`,
  );
}
