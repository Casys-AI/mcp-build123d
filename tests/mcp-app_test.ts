import { assertEquals, assertStringIncludes } from "@std/assert";
import { CadToolsClient } from "../src/client.ts";
import { createCadMcpApp } from "../src/server-app.ts";
import { geometryToolResult } from "../src/tools/execute.ts";
import { RESULTS_VIEWER_URI } from "../src/ui/constants.ts";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

function startOnFreePort() {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

const METRICS = {
  volume_mm3: 1000,
  area_mm2: 700,
  center_of_mass_mm: [5, 10, 2.5] as [number, number, number],
  bounding_box_mm: {
    min: [0, 0, 0] as [number, number, number],
    max: [10, 20, 5] as [number, number, number],
    size: [10, 20, 5] as [number, number, number],
  },
  solids: 1,
  faces: 6,
  edges: 12,
};

Deno.test("geometry result keeps a concise fallback and no source or file contents", () => {
  const result = geometryToolResult("execution", METRICS, []);

  assertStringIncludes(result.content, "1,000 mm³ volume");
  assertStringIncludes(result.content, "700 mm² area");
  assertStringIncludes(result.content, "0 files");
  assertEquals(result.structuredContent, {
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [],
  });
  assertEquals("script" in result.structuredContent, false);
});

Deno.test("build123d MCP App tools publish the shared viewer and explicit output schema", () => {
  const tools = new CadToolsClient().toMCPFormat();
  assertEquals(tools.map((tool) => tool.name), [
    "build123d_execute",
    "build123d_export",
  ]);
  for (const tool of tools) {
    assertEquals(tool._meta?.ui?.resourceUri, RESULTS_VIEWER_URI);
    assertEquals(
      (tool.outputSchema.properties as { kind: { const: string } }).kind.const,
      tool.name === "build123d_execute" ? "execution" : "export",
    );
    assertEquals(
      (tool.outputSchema.properties as {
        metrics: { properties: Record<string, { minimum: number }> };
      })
        .metrics.properties.volume_mm3.minimum,
      0,
    );
  }
});

Deno.test("build123d tools/list uses the stateless 2026 wire contract", async () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [PROTOCOL_KEY]: PROTOCOL_VERSION,
            [CAPABILITIES_KEY]: {},
          },
        },
      }),
    });
    assertEquals(response.status, 200);
    const body = await response.json() as {
      result: { tools: Array<Record<string, unknown>> };
    };
    assertEquals(body.result.tools.length, 2);
    for (const tool of body.result.tools) {
      assertEquals(
        (tool._meta as { ui: { resourceUri: string } }).ui.resourceUri,
        RESULTS_VIEWER_URI,
      );
      assertEquals(
        (tool.outputSchema as { properties: { kind: { const: string } } })
          .properties.kind.const,
        tool.name === "build123d_execute" ? "execution" : "export",
      );
    }
  } finally {
    await http.shutdown();
  }
});

Deno.test("build123d result viewer reads the exact published remote bundle path", async () => {
  const seen: string[] = [];
  const remote = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (request) => {
      seen.push(new URL(request.url).pathname);
      return new Response("<!doctype html><title>published CAD result</title>");
    },
  );
  const port = (remote.addr as Deno.NetAddr).port;
  try {
    const assembly = createCadMcpApp({
      viewerModuleUrl:
        `http://127.0.0.1:${port}/@casys/mcp-build123d/0.1.2/server.ts`,
    });
    assertEquals(assembly.viewers, {
      registered: ["results-viewer"],
      skipped: [],
    });
    assertStringIncludes(
      (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))?.text ?? "",
      "published CAD result",
    );
    assertEquals(seen, [
      "/@casys/mcp-build123d/0.1.2/src/ui/dist/results-viewer/index.html",
    ]);
  } finally {
    await remote.shutdown();
  }
});

Deno.test("build123d result viewer is registered when its HTML bundle exists", async () => {
  const html = "<!doctype html><title>CAD result</title>";
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: {
      exists: (path) =>
        path === "/project/src/ui/dist/results-viewer/index.html",
      readFile: (path) => {
        assertEquals(path, "/project/src/ui/dist/results-viewer/index.html");
        return html;
      },
    },
  });

  assertEquals(assembly.viewers, {
    registered: ["results-viewer"],
    skipped: [],
  });
  assertEquals(assembly.app.getToolCount(), 2);
  assertEquals(assembly.app.hasResource(RESULTS_VIEWER_URI), true);
  assertEquals(
    (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))?.text,
    html,
  );
});

Deno.test("build123d result viewer is skipped before its bundle is built", () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });

  assertEquals(assembly.viewers, {
    registered: [],
    skipped: ["results-viewer"],
  });
  assertEquals(assembly.app.hasResource(RESULTS_VIEWER_URI), false);
});
