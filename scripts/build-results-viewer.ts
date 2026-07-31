/// <reference lib="deno.ns" />
/** Build the results viewer against the published, exact mcp-view release. */

import { dirname, fromFileUrl, join } from "@std/path";

const here = dirname(fromFileUrl(import.meta.url));
const viewer = join(here, "..", "src", "ui", "results-viewer");
const mcpViewModule = Deno.env.get("MCP_VIEW_MODULE") ??
  "jsr:@casys/mcp-view@0.4.1";
const temporaryConfigDir = await Deno.makeTempDir({
  prefix: "mcp-build123d-view-",
});
const importMap = join(temporaryConfigDir, "import-map.json");
const temporaryBundle = join(temporaryConfigDir, "results-viewer.js");

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
      join(viewer, "src", "main.ts"),
    ],
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `Viewer bundle failed:\n${new TextDecoder().decode(output.stderr)}`,
    );
  }
  const js = await Deno.readTextFile(temporaryBundle);
  try {
    new Function(js);
  } catch (error) {
    throw new Error(
      `Viewer bundle is not valid JavaScript: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const template = await Deno.readTextFile(join(viewer, "index.html"));
  const css = await Deno.readTextFile(join(viewer, "src", "styles.css"));
  const html = template
    .replace("/*__BUILD123D_VIEWER_STYLES__*/", () => css)
    .replace("/*__BUILD123D_VIEWER_BUNDLE__*/", () => js)
    .replace(/[\t ]+\n/g, "\n");
  const outDir = join(here, "..", "src", "ui", "dist", "results-viewer");
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(join(outDir, "index.html"), html);
  console.log(
    `[build:ui] wrote ${join(outDir, "index.html")} (${
      Math.round(html.length / 1024)
    } KB)`,
  );
} finally {
  await Deno.remove(temporaryConfigDir, { recursive: true });
}
