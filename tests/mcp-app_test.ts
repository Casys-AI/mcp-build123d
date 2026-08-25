import { assertEquals, assertStringIncludes } from "@std/assert";
import { CadToolsClient } from "../src/client.ts";
import { ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES } from "../src/api/assembly-integrity-bridge.ts";
import { createCadMcpApp } from "../src/server-app.ts";
import { geometryToolResult } from "../src/tools/execute.ts";
import {
  ARTIFACT_HELPER_VIEWER_URI,
  RESULTS_VIEWER_URI,
} from "../src/ui/constants.ts";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

function startOnFreePort() {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function mcpRpc(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
    "Mcp-Method": method,
  };
  if (method === "tools/call" && typeof params.name === "string") {
    headers["Mcp-Name"] = params.name;
  }
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        _meta: {
          [PROTOCOL_KEY]: PROTOCOL_VERSION,
          [CAPABILITIES_KEY]: {},
        },
        ...params,
      },
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
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

  const exported = geometryToolResult("export", METRICS, [{
    format: "gltf",
    path: "/exports/assembly.glb",
    bytes: 2048,
    sha256: "a".repeat(64),
  }]);
  assertEquals(exported.structuredContent.files, [{
    format: "gltf",
    path: "/exports/assembly.glb",
    bytes: 2048,
    sha256: "a".repeat(64),
    viewer: {
      toolName: "build123d_export_read",
      name: "assembly.glb",
    },
  }]);
  assertEquals("base64" in exported.structuredContent, false);
});

Deno.test("build123d MCP App tools publish the shared viewer and explicit output schema", () => {
  const tools = new CadToolsClient().toMCPFormat();
  assertEquals(tools.map((tool) => tool.name), [
    "build123d_execute",
    "build123d_export",
    "build123d_export_read",
    "build123d_observe_assembly_integrity",
  ]);
  for (const tool of tools) {
    if (tool.name === "build123d_export_read") {
      assertEquals(tool._meta?.ui, {
        resourceUri: ARTIFACT_HELPER_VIEWER_URI,
      });
      assertEquals(
        (tool.outputSchema.properties as { kind: { const: string } }).kind
          .const,
        "gltf-binary",
      );
      continue;
    }
    if (tool.name === "build123d_observe_assembly_integrity") {
      assertEquals(tool._meta, undefined);
      assertEquals(
        (tool.outputSchema.properties as { kind: { const: string } }).kind
          .const,
        "assembly-integrity-observation",
      );
      assertEquals(
        (tool.inputSchema as { additionalProperties: boolean })
          .additionalProperties,
        false,
      );
      continue;
    }
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
    assertEquals(
      (tool.outputSchema.properties as {
        metrics: {
          properties: {
            density_kg_m3: { exclusiveMinimum: number };
            mass_kg: { minimum: number };
          };
        };
      }).metrics.properties.density_kg_m3.exclusiveMinimum,
      0,
    );
    assertEquals(
      (tool.outputSchema.properties as {
        metrics: { properties: { mass_kg: { minimum: number } } };
      }).metrics.properties.mass_kg.minimum,
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
    // A model-only tools/list does not advertise the app-only GLB reader.
    assertEquals(
      body.result.tools.map((tool) => tool.name),
      [
        "build123d_execute",
        "build123d_export",
        "build123d_observe_assembly_integrity",
      ],
    );
    for (const tool of body.result.tools) {
      if (tool.name === "build123d_export_read") {
        assertEquals((tool._meta as { ui: unknown }).ui, {
          resourceUri: ARTIFACT_HELPER_VIEWER_URI,
        });
        continue;
      }
      if (tool.name === "build123d_observe_assembly_integrity") {
        assertEquals(tool._meta, undefined);
        assertEquals(
          (tool.outputSchema as { properties: { kind: { const: string } } })
            .properties.kind.const,
          "assembly-integrity-observation",
        );
        continue;
      }
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

Deno.test("build123d server/discover uses the 2026-07-28 stateless wire without a session", async () => {
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
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "server/discover",
        params: {
          _meta: {
            [PROTOCOL_KEY]: PROTOCOL_VERSION,
            [CAPABILITIES_KEY]: {},
          },
        },
      }),
    });
    assertEquals(response.status, 200);
    assertEquals(
      response.headers.get("mcp-protocol-version"),
      PROTOCOL_VERSION,
    );
    assertEquals(response.headers.get("mcp-session-id"), null);
    const body = await response.json() as {
      result: {
        supportedVersions: string[];
        serverInfo: { name: string; version: string };
      };
    };
    assertEquals(
      body.result.supportedVersions.includes(PROTOCOL_VERSION),
      true,
    );
    assertEquals(body.result.serverInfo, {
      name: "mcp-build123d",
      version: "0.5.0",
    });
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
        `http://127.0.0.1:${port}/@casys/mcp-build123d/0.5.0/server.ts`,
    });
    assertEquals(assembly.viewers, {
      registered: ["results-viewer", "artifact-helper-viewer"],
      skipped: [],
    });
    assertStringIncludes(
      (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))?.text ?? "",
      "published CAD result",
    );
    assertStringIncludes(
      (await assembly.app.readResourceContent(ARTIFACT_HELPER_VIEWER_URI))
        ?.text ?? "",
      "published CAD result",
    );
    assertEquals(seen, [
      "/@casys/mcp-build123d/0.5.0/src/ui/dist/results-viewer/index.html",
      "/@casys/mcp-build123d/0.5.0/src/ui/dist/artifact-helper-viewer/index.html",
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
    skipped: ["artifact-helper-viewer"],
  });
  assertEquals(assembly.app.getToolCount(), 4);
  assertEquals(assembly.app.hasResource(RESULTS_VIEWER_URI), true);
  assertEquals(
    (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))?.text,
    html,
  );
});

Deno.test("build123d ships the generated standalone results viewer", async () => {
  const assembly = createCadMcpApp();
  assertEquals(assembly.viewers, {
    registered: ["results-viewer", "artifact-helper-viewer"],
    skipped: [],
  });
  const html = (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))
    ?.text ?? "";
  assertStringIncludes(html, "build123d-results-viewer");
  const helperHtml = (await assembly.app.readResourceContent(
    ARTIFACT_HELPER_VIEWER_URI,
  ))?.text ?? "";
  assertStringIncludes(helperHtml, "build123d-artifact-helper-viewer");
  assertEquals(helperHtml.includes("build123d.geometry-status"), false);
  assertEquals(helperHtml.includes("build123d.geometry-canvas"), false);
  assertStringIncludes(html, "io.casys.mcp.view-components/v1");
  assertStringIncludes(html, "build123d.geometry-status");
  assertStringIncludes(html, "build123d.geometry-metrics");
  assertStringIncludes(html, "build123d.geometry-canvas");
  assertStringIncludes(html, "build123d.export-artifacts");
  assertStringIncludes(html, "expected_sha256");
  assertEquals(helperHtml.includes("expected_sha256"), false);
  assertEquals(html.includes("io.casys.mcp.composable-view/v1"), false);
  assertEquals(html.includes("build123d-glance"), false);
  assertEquals(html.includes("__BUILD123D_VIEWER_BUNDLE__"), false);
  assertEquals(/<script[^>]+src=/i.test(html), false);
});

Deno.test("build123d result viewer is skipped before its bundle is built", () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });

  assertEquals(assembly.viewers, {
    registered: [],
    skipped: ["results-viewer", "artifact-helper-viewer"],
  });
  assertEquals(assembly.app.hasResource(RESULTS_VIEWER_URI), false);
});

Deno.test("build123d input schemas reject extra properties and invalid bounds on the wire", async () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const extra = await mcpRpc(port, "tools/call", {
      name: "build123d_execute",
      arguments: { script: "result = 1", unexpected: true },
    });
    assertEquals(extra.body.result, undefined);
    assertStringIncludes(JSON.stringify(extra.body.error), "unexpected");

    const emptyFormats = await mcpRpc(port, "tools/call", {
      name: "build123d_export",
      arguments: { script: "result = 1", formats: [], name: "bracket" },
    });
    assertEquals(emptyFormats.body.result, undefined);
    assertStringIncludes(JSON.stringify(emptyFormats.body.error), "formats");

    const duplicateFormats = await mcpRpc(port, "tools/call", {
      name: "build123d_export",
      arguments: {
        script: "result = 1",
        formats: ["step", "step"],
        name: "bracket",
      },
    });
    assertEquals(duplicateFormats.body.result, undefined);
    assertStringIncludes(
      JSON.stringify(duplicateFormats.body.error),
      "duplicate",
    );

    const zeroDensity = await mcpRpc(port, "tools/call", {
      name: "build123d_execute",
      arguments: { script: "result = 1", density_kg_m3: 0 },
    });
    assertEquals(zeroDensity.body.result, undefined);
    assertStringIncludes(JSON.stringify(zeroDensity.body.error), "must be > 0");

    const fractionalTimeout = await mcpRpc(port, "tools/call", {
      name: "build123d_execute",
      arguments: { script: "result = 1", timeout_ms: 1.5 },
    });
    assertEquals(fractionalTimeout.body.result, undefined);
    assertStringIncludes(
      JSON.stringify(fractionalTimeout.body.error),
      "integer",
    );
  } finally {
    await http.shutdown();
  }
});

Deno.test("assembly-integrity HTTP cap admits a legal-size inline artifact envelope", async () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({
    port,
    maxBodyBytes: ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES,
    onListen: () => {},
  });
  try {
    // 1 MiB crosses the generic server default. It is structurally valid
    // base64; the deliberately wrong digest proves the request reached the
    // observer bridge rather than being rejected as HTTP 413.
    const blob = "A".repeat(1_048_576);
    const response = await mcpRpc(port, "tools/call", {
      name: "build123d_observe_assembly_integrity",
      arguments: {
        step: {
          mimeType: "model/step",
          sha256: "0".repeat(64),
          bytes: 786_432,
          blob,
        },
      },
    });
    assertEquals(response.status === 413, false);
    assertStringIncludes(JSON.stringify(response.body.error), "sha256");
  } finally {
    await http.shutdown();
  }
});

Deno.test("build123d_export_read tools/call requires expected_sha256 on the app-only wire", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-wire-glb-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const bytes = new Uint8Array([
      0x67,
      0x6c,
      0x54,
      0x46,
      2,
      0,
      0,
      0,
      12,
      0,
      0,
      0,
    ]);
    await Deno.writeFile(`${dir}/assembly.glb`, bytes);
    const digest = await sha256Hex(bytes);

    const listed = await mcpRpc(port, "tools/list");
    const tools = (listed.body.result as { tools: Array<{ name: string }> })
      .tools;
    assertEquals(
      tools.map((tool) => tool.name).includes("build123d_export_read"),
      false,
    );

    const missing = await mcpRpc(port, "tools/call", {
      name: "build123d_export_read",
      arguments: { name: "assembly.glb" },
    });
    assertEquals(missing.body.result, undefined);
    assertStringIncludes(JSON.stringify(missing.body.error), "expected_sha256");

    const accepted = await mcpRpc(port, "tools/call", {
      name: "build123d_export_read",
      arguments: {
        name: "assembly.glb",
        expected_sha256: digest,
      },
    });
    const acceptedResult = accepted.body.result as {
      structuredContent: {
        name: string;
        kind: string;
        bytes: number;
      };
    };
    assertEquals(acceptedResult.structuredContent.name, "assembly.glb");
    assertEquals(acceptedResult.structuredContent.kind, "gltf-binary");
    assertEquals(acceptedResult.structuredContent.bytes, bytes.length);
  } finally {
    await http.shutdown();
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});
