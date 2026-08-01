/// <reference lib="deno.ns" />
/** Build both viewer resources against one exact mcp-view implementation. */

import { dirname, fromFileUrl, join } from "@std/path";

const here = dirname(fromFileUrl(import.meta.url));
const viewer = join(here, "..", "src", "ui", "results-viewer");
const mcpViewModule = Deno.env.get("MCP_VIEW_MODULE") ??
  "jsr:@casys/mcp-view@0.4.1";
const temporaryConfigDir = await Deno.makeTempDir({
  prefix: "mcp-build123d-view-",
});
const importMap = join(temporaryConfigDir, "import-map.json");
const builds = [
  { entry: "main.ts", viewer: "results-viewer" },
  { entry: "artifact-main.ts", viewer: "artifact-helper-viewer" },
] as const;
const bundles = new Map<string, string>();

try {
  await Deno.writeTextFile(
    importMap,
    JSON.stringify({
      // Keep Deno's dependency-age quarantine for the graph except for the
      // exact Casys package audited and published with this viewer work.
      minimumDependencyAge: {
        age: "P1D",
        exclude: ["jsr:@casys/mcp-view"],
      },
      imports: {
        "@casys/mcp-view": mcpViewModule,
        "@modelcontextprotocol/ext-apps":
          "npm:@modelcontextprotocol/ext-apps@^1.7.4",
        "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.29.0",
        "@modelcontextprotocol/sdk/types.js":
          "npm:@modelcontextprotocol/sdk@^1.29.0/types.js",
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
