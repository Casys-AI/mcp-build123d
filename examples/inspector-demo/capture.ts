/** Capture the local kit Apps after the real MCP Apps iframe handshake. */
import { dirname, fromFileUrl, join } from "@std/path";
import { loadInspectorFixtures } from "./fixtures.ts";

const here = dirname(fromFileUrl(import.meta.url));
const root = join(here, "..", "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await Deno.stat(chrome);
await Deno.mkdir(join(here, "assets"), { recursive: true });

for (const example of await loadInspectorFixtures()) {
  const bundle = `${example.viewer}-viewer`;
  const html = await Deno.readTextFile(
    join(root, "src", "ui", "dist", bundle, "index.html"),
  );
  let resolvePort!: (port: number) => void;
  const portReady = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/viewer") {
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (path === "/") {
        return new Response(
          hostHtml(example.result, example.meta, example.viewer),
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  );
  const port = await portReady;
  const outputPath = join(here, "assets", `${example.name}.png`);
  try {
    const output = await new Deno.Command(chrome, {
      args: [
        "--headless=new",
        "--disable-background-networking",
        "--disable-features=IsolateSandboxedIframes",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        "--window-size=1200,1100",
        "--virtual-time-budget=8000",
        "--dump-dom",
        `--screenshot=${outputPath}`,
        `http://127.0.0.1:${port}/`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(new TextDecoder().decode(output.stderr));
    }
    const dom = new TextDecoder().decode(output.stdout);
    if (!dom.includes('data-demo-state="ready"')) {
      throw new Error(
        `The ${example.name} App did not render successfully: ${
          dom.match(/<body[^>]*>/)?.[0] ?? "no body in Chrome dump"
        }`,
      );
    }
    const png = await Deno.readFile(outputPath);
    if (png.byteLength < 1024) {
      throw new Error(`The ${example.name} screenshot is empty`);
    }
    const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
    if (header.getUint32(16) < 1200 || header.getUint32(20) < 1100) {
      throw new Error(`The ${example.name} screenshot has wrong dimensions`);
    }
    console.log(`${example.name}: ${outputPath} · ${png.byteLength} bytes`);
  } finally {
    await server.shutdown();
  }
}

function hostHtml(
  payload: unknown,
  meta: Record<string, unknown> | undefined,
  viewer: "assembly" | "drawing",
): string {
  const serialized = JSON.stringify(payload).replaceAll("<", "\\u003c");
  const serializedMeta = JSON.stringify(meta ?? {}).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Build123d App capture</title>
<style>html,body{width:100%;height:100%;margin:0;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
</head><body>
<iframe id="viewer" sandbox="allow-scripts allow-same-origin" src="/viewer" title="Build123d MCP App"></iframe>
<script>
  const result = ${serialized};
  const resultMeta = ${serializedMeta};
  const viewer = ${JSON.stringify(viewer)};
  const frame = document.getElementById("viewer");
  function inspect() {
    const doc = frame.contentDocument;
    if (doc) {
      const drawingImage = doc.querySelector('[data-drawing-state] img');
      const ready = viewer === "drawing"
        ? drawingImage?.complete && drawingImage.naturalWidth > 0
        : doc.querySelector('.build123d-assembly-surface .mcp-view-focused-view');
      if (ready) document.body.dataset.demoState = "ready";
      if (doc.querySelector('.mcp-view-state[data-tone="danger"]')) {
        document.body.dataset.demoState = "failed";
      }
    }
    if (!document.body.dataset.demoState) requestAnimationFrame(inspect);
  }
  requestAnimationFrame(inspect);
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
    const message = event.data;
    const post = (data) => frame.contentWindow.postMessage(data, "*");
    if (message.method === "ui/initialize") {
      post({ jsonrpc: "2.0", id: message.id, result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "build123d-local-capture", version: "0.1.0" },
        hostCapabilities: {},
        hostContext: { theme: "light", locale: "fr-FR", displayMode: "inline",
          availableDisplayModes: ["inline"], platform: "web",
          containerDimensions: { width: 1200, maxHeight: 1100 } }
      }});
    } else if (message.method === "ui/notifications/initialized") {
      post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: {
        content: [{ type: "text", text: "Saved local example" }],
        structuredContent: result,
        _meta: resultMeta
      }});
    } else if (Object.prototype.hasOwnProperty.call(message, "id")) {
      post({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  });
</script></body></html>`;
}
