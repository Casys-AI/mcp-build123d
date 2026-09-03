/// <reference lib="deno.ns" />

/**
 * Capture docs/assets/build123d-export-viewer.png from the committed viewer
 * bundle through a documentation host, so the README image is reproducible:
 * same export fixture, same handshake, same viewport, headless Chrome.
 *
 * Usage: deno task capture:docs
 *   CHROME_BIN  headless-capable Chrome binary (default: local Chrome / shell)
 *   FFMPEG_BIN  ffmpeg; the PNG is re-encoded deterministically
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { parseGeometryResult } from "../src/ui/results-viewer/src/contract.ts";

const root = dirname(dirname(fromFileUrl(import.meta.url)));
const fixtureDirectory = join(root, "docs/fixtures");
const viewerPath = join(root, "src/ui/dist/results-viewer/index.html");
const outputPath = join(root, "docs/assets/build123d-export-viewer.png");
const WINDOW = { width: 1040, height: 1020 };
/** Chrome and ffmpeg both finish in seconds; a deadline keeps a stuck one from hanging. */
const TOOL_DEADLINE_MS = 60_000;

// One recovery per input: the bundle is rebuilt, the fixture is restored from git.
for (
  const [required, recovery] of [
    ["src/ui/dist/results-viewer/index.html", "run deno task build:ui first"],
    ["docs/fixtures/bracket-r1.export.json", "restore the committed fixture"],
    ["docs/fixtures/bracket-r1.glb", "restore the committed fixture"],
  ] as const
) {
  await Deno.stat(join(root, required)).catch(() => {
    throw new Error(`CAPTURE_INPUT_MISSING ${required} — ${recovery}`);
  });
}

// Keep the documentation image on the same strict ingress path as the shipped App.
const exportFixture: unknown = JSON.parse(
  await Deno.readTextFile(join(fixtureDirectory, "bracket-r1.export.json")),
);
const exportResult = parseGeometryResult(exportFixture);
if (!exportResult.ok) {
  throw new Error(`CAPTURE_FIXTURE_INVALID ${exportResult.error}`);
}
const gltf = exportResult.value.files.find((file) => file.format === "gltf");
if (!gltf) throw new Error("CAPTURE_FIXTURE_INVALID no gltf export in fixture");
const glb = await Deno.readFile(join(fixtureDirectory, "bracket-r1.glb"));
const glbDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", glb))
  .toHex();
if (
  glbDigest !== gltf.artifact.sha256 || glb.byteLength !== gltf.artifact.bytes
) {
  throw new Error(
    `CAPTURE_FIXTURE_INVALID bracket-r1.glb does not match the export artifact identity`,
  );
}

const viewerHtml = await Deno.readTextFile(viewerPath);
const hostHtml = documentationHostHtml({
  // The wire envelope, not the parsed model: the App parses it itself.
  result: exportFixture,
  resource: {
    uri: gltf.artifact.uri,
    mimeType: gltf.artifact.mimeType,
    blob: glb.toBase64(),
  },
});
let resolvePort!: (port: number) => void;
const listening = new Promise<number>((resolve) => resolvePort = resolve);
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: ({ port }) => resolvePort(port) },
  (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/viewer") {
      return new Response(viewerHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/") {
      return new Response(hostHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
);

const port = await listening;
const temporaryDirectory = await Deno.makeTempDir({
  prefix: "mcp-build123d-doc-capture-",
});
const rawScreenshot = join(temporaryDirectory, "raw.png");
try {
  await Deno.mkdir(dirname(outputPath), { recursive: true });
  const chrome = await findExecutable([
    Deno.env.get("CHROME_BIN"),
    "/opt/homebrew/bin/chrome-headless-shell",
    "/usr/local/bin/chrome-headless-shell",
    "/usr/bin/chrome-headless-shell",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ], "CHROME_BIN");
  await run(chrome, [
    "--headless=new",
    "--disable-background-networking",
    // The sandboxed App frame must share the page's renderer: in its own
    // process the handshake round-trip escapes the virtual-time budget and
    // the frame is captured before the export lands.
    "--disable-features=IsolateSandboxedIframes",
    // Software WebGL renders the Three.js scene without a GPU.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=2",
    "--hide-scrollbars",
    // Locale-sensitive formatting must not follow the capturing machine.
    "--lang=en-US",
    "--run-all-compositor-stages-before-draw",
    "--timeout=10000",
    "--virtual-time-budget=10000",
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    `--screenshot=${rawScreenshot}`,
    `http://127.0.0.1:${port}/`,
  ]);
  const ffmpeg = await findExecutable([
    Deno.env.get("FFMPEG_BIN"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ]);
  await run(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rawScreenshot,
    "-compression_level",
    "9",
    "-pred",
    "mixed",
    outputPath,
  ]);
  const { size } = await Deno.stat(outputPath);
  console.log(
    `[capture:docs] wrote ${outputPath} (${(size / 1024).toFixed(1)} KiB)`,
  );
} finally {
  await server.shutdown();
  await Deno.remove(temporaryDirectory, { recursive: true });
}

/**
 * A minimal MCP Apps host: answers ui/initialize, delivers the export as a
 * tool result, and serves exactly one resources/read — the fixture GLB.
 */
function documentationHostHtml(payload: {
  readonly result: unknown;
  readonly resource: { uri: string; mimeType: string; blob: string };
}): string {
  const serialized = JSON.stringify(payload).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Build123d export viewer</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #fbfaf7; }
      iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
    </style>
  </head>
  <body>
    <iframe id="viewer" sandbox="allow-scripts" src="/viewer" title="Build123d export viewer"></iframe>
    <script>
      const fixture = ${serialized};
      const frame = document.getElementById("viewer");
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow || !event.data || event.data.jsonrpc !== "2.0") return;
        const message = event.data;
        const post = (value) => frame.contentWindow.postMessage(value, "*");
        if (message.method === "ui/initialize") {
          post({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: { name: "build123d-doc-capture-host", version: "1.0.0" },
              hostCapabilities: {},
              hostContext: {
                theme: "light",
                displayMode: "inline",
                availableDisplayModes: ["inline"],
                locale: "en-US",
                platform: "web",
                containerDimensions: { width: ${WINDOW.width}, maxHeight: ${WINDOW.height} },
              },
            },
          });
          return;
        }
        if (message.method === "ui/notifications/initialized") {
          post({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: {
              content: [{ type: "text", text: "build123d_export completed" }],
              structuredContent: fixture.result,
            },
          });
          return;
        }
        if (message.method === "resources/read") {
          const uri = message.params && message.params.uri;
          post(uri === fixture.resource.uri
            ? { jsonrpc: "2.0", id: message.id, result: { contents: [fixture.resource] } }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "Resource not found: " + uri } });
          return;
        }
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          post({ jsonrpc: "2.0", id: message.id, result: {} });
        }
      });
    </script>
  </body>
</html>`;
}

async function findExecutable(
  candidates: readonly (string | undefined)[],
  variable = "FFMPEG_BIN",
): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate;
    } catch {
      // Try the next documented local executable.
    }
  }
  throw new Error(`CAPTURE_TOOL_MISSING set ${variable} to a local executable`);
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const result = await new Deno.Command(command, {
    args: [...args],
    stdout: "piped",
    stderr: "piped",
    signal: AbortSignal.timeout(TOOL_DEADLINE_MS),
  }).output();
  if (result.success) return;
  throw new Error(
    `${command} failed (${result.code}): ${
      new TextDecoder().decode(result.stderr).trim()
    }`,
  );
}
