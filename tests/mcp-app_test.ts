/** Real HTTP wire coverage for the build123d MCP application. */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { relative } from "@std/path";
import { SchemaValidator } from "@casys/mcp-platform";
import { CadToolsClient } from "../src/client.ts";
import {
  ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES,
  AssemblyIntegrityObservationError,
} from "../src/api/assembly-integrity-bridge.ts";
import {
  Projection2dGenerationError,
  Projection2dInputError,
} from "../src/api/projection-2d-bridge.ts";
import { CadExecutionLimitError } from "../src/api/python-bridge.ts";
import { createBuild123dExportExecution } from "../src/artifacts.ts";
import { createCadMcpApp } from "../src/server-app.ts";
import { build123dToolErrorResult } from "../src/tool-errors.ts";
import { geometryToolResult } from "../src/tools/execute.ts";
import {
  ASSEMBLY_VIEWER_URI,
  DRAWING_VIEWER_URI,
  RESULTS_VIEWER_URI,
} from "../src/ui/constants.ts";
import {
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
} from "../src/ui/recorded-view-session.ts";
import { MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE } from "../src/ui/results-viewer/src/resource-bridge.ts";
import { BUILD123D_MCP_APP_INFO } from "../src/ui/view-app-manifest.ts";

const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

const FIXTURE_GLB = new Uint8Array([
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

function startOnFreePort(): number {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function mcpRpc(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const name = method === "resources/read" ? params.uri : params.name;
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      "Mcp-Method": method,
      ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
    },
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
  return { status: response.status, body: await response.json() };
}

function assertNoHostPath(value: unknown, path: string): void {
  assertEquals(JSON.stringify(value).includes(path), false);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\\''")}'`;
}

async function createFakeCadInterpreter(root: string): Promise<string> {
  const harness = `${root}/fake-build123d.ts`;
  const interpreter = `${root}/fake-python`;
  await Deno.writeTextFile(
    harness,
    `
const fixture = new Uint8Array(${JSON.stringify(Array.from(FIXTURE_GLB))});
const sourceIndex = Deno.args.indexOf("-c");
const source = sourceIndex >= 0 ? Deno.args[sourceIndex + 1] : undefined;
if (source?.includes("cadqueryOcp")) {
  console.log(JSON.stringify({
    ok: true,
    build123d: "0.11.1",
    cadqueryOcp: "7.9.3.1",
  }));
  Deno.exit(0);
}
if (source?.includes("import os, stat, sys\\n")) {
  await Deno.stdout.write(
    await Deno.readFile(Deno.args[sourceIndex + 2] + "/" + Deno.args[sourceIndex + 3]),
  );
  Deno.exit(0);
}
const request = JSON.parse(await new Response(Deno.stdin.readable).text());
const copy = new ArrayBuffer(fixture.byteLength);
new Uint8Array(copy).set(fixture);
const sha256 = Array.from(
  new Uint8Array(await crypto.subtle.digest("SHA-256", copy)),
  (byte) => byte.toString(16).padStart(2, "0"),
).join("");
for (const file of request.exports) {
  await Deno.writeFile(file.path, fixture);
}
console.log(JSON.stringify({
  ok: true,
  metrics: ${JSON.stringify(METRICS)},
  exports: request.exports.map((file) => ({
    format: file.format,
    path: file.path,
    bytes: fixture.byteLength,
    sha256,
  })),
}));
`,
  );
  await Deno.writeTextFile(
    interpreter,
    `#!/bin/sh\nexec ${
      shellQuote(Deno.execPath())
    } run --quiet --allow-read --allow-write ${shellQuote(harness)} "$@"\n`,
    { mode: 0o700 },
  );
  return interpreter;
}

async function withServerRoots<T>(
  run: (
    roots: { exportsDirectory: string; artifactsDirectory: string },
  ) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "mcp-build123d-wire-" });
  const exportsDirectory = `${root}/delivery`;
  const artifactsDirectory = `${root}/artifacts`;
  await Deno.mkdir(exportsDirectory);
  try {
    return await run({ exportsDirectory, artifactsDirectory });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function testAssembly(exportsDirectory?: string, artifactsDirectory?: string) {
  return createCadMcpApp({
    exportDirectory: exportsDirectory,
    artifactDirectory: artifactsDirectory,
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
}

const BUILD123D_RUNTIME_AVAILABLE = await (async () => {
  try {
    return (await new Deno.Command(
      Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3",
      { args: ["-c", "import build123d"], stdout: "null", stderr: "null" },
    ).output()).success;
  } catch {
    return false;
  }
})();

function cadTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: !BUILD123D_RUNTIME_AVAILABLE, fn });
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

Deno.test("geometry fallback is compact and export payload has no delivery path", () => {
  const execution = geometryToolResult("execution", METRICS, []);
  assertStringIncludes(execution.content, "1,000 mm³ volume");
  assertStringIncludes(execution.content, "700 mm² area");
  assertEquals("script" in execution.structuredContent, false);

  const exported = geometryToolResult("export", METRICS, [{
    format: "gltf",
    artifact: {
      schemaVersion: "build123d-export-artifact/1.0",
      uri: `casys://build123d/artifacts/${"a".repeat(64)}.glb`,
      format: "gltf",
      mimeType: "model/gltf-binary",
      bytes: 2048,
      sha256: "a".repeat(64),
    },
  }]);
  const file =
    (exported.structuredContent.files as Array<Record<string, unknown>>)[0];
  assertEquals("path" in file, false);
  assertEquals("base64" in file, false);
  assertStringIncludes(exported.content, "Immutable export resources");
});

Deno.test("an injected export directory is shared by the runner and artifact store", async () => {
  const root = await Deno.makeTempDir({
    prefix: "mcp-build123d-injected-root-",
  });
  const injected = `${root}/injected`;
  const wrong = `${root}/wrong`;
  await Deno.mkdir(injected);
  const interpreter = await createFakeCadInterpreter(root);
  const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
  const previousExport = Deno.env.get("BUILD123D_EXPORT_DIR");
  Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
  Deno.env.set("BUILD123D_EXPORT_DIR", wrong);
  try {
    const assembly = createCadMcpApp({
      exportDirectory: relative(Deno.cwd(), injected),
      viewerModuleUrl: "file:///project/server.ts",
      viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
    });
    const exportHandler = assembly.toolsClient.buildHandlersMap().get(
      "build123d_export",
    );
    if (!exportHandler) throw new Error("Missing export handler");
    const result = await exportHandler({
      script: "result = fixture",
      formats: ["gltf"],
      name: "injected-root",
    });
    const file = (result as {
      structuredContent: {
        files: Array<{
          artifact: Record<string, unknown>;
        }>;
      };
    }).structuredContent.files[0];
    assertEquals(
      file.artifact.uri,
      `casys://build123d/artifacts/${await sha256Hex(FIXTURE_GLB)}.glb`,
    );
    assertEquals(Array.from(Deno.readDirSync(injected)), []);
    await assertRejects(() => Deno.lstat(wrong), Deno.errors.NotFound);
  } finally {
    if (previousPython === undefined) Deno.env.delete("BUILD123D_PYTHON_BIN");
    else Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
    if (previousExport === undefined) Deno.env.delete("BUILD123D_EXPORT_DIR");
    else Deno.env.set("BUILD123D_EXPORT_DIR", previousExport);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("tool descriptors give agents a factual contract and behavioral hints", () => {
  const tools = new CadToolsClient().toMCPFormat();
  assertEquals(tools.map((tool) => tool.name), [
    "build123d_execute",
    "build123d_export",
    "build123d_observe_assembly_integrity",
    "build123d_project_2d",
  ]);
  const execute = tools.find((tool) => tool.name === "build123d_execute");
  const exported = tools.find((tool) => tool.name === "build123d_export");
  const observed = tools.find((tool) =>
    tool.name === "build123d_observe_assembly_integrity"
  );
  const projected = tools.find((tool) => tool.name === "build123d_project_2d");
  if (!execute || !exported || !observed || !projected) {
    throw new Error("Missing CAD tools");
  }
  assertEquals(execute._meta?.ui?.resourceUri, RESULTS_VIEWER_URI);
  assertEquals(exported._meta?.ui?.resourceUri, RESULTS_VIEWER_URI);
  assertEquals(observed._meta?.ui?.resourceUri, ASSEMBLY_VIEWER_URI);
  assertEquals(projected._meta?.ui?.resourceUri, DRAWING_VIEWER_URI);
  assertEquals(execute.annotations?.destructiveHint, true);
  assertEquals(execute.annotations?.idempotentHint, false);
  assertEquals(execute.annotations?.openWorldHint, true);
  assertEquals(observed.annotations, {
    title: "Observe STEP assembly integrity",
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assertEquals(projected.annotations, {
    title: "Project STEP for 2D inspection",
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  assertStringIncludes(exported.description, "resources/read");
  assertEquals(
    tools.some((tool) => tool.name === "build123d_export_read"),
    false,
  );
});

Deno.test("HTTP discover and tools/list expose instructions, annotations and stateless transport", async () => {
  const assembly = testAssembly();
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const discover = await mcpRpc(port, "server/discover");
    assertEquals(discover.status, 200);
    assertEquals(
      (discover.body.result as { serverInfo: unknown }).serverInfo,
      { name: "mcp-build123d", version: "0.6.4" },
    );
    assertStringIncludes(
      (discover.body.result as { instructions: string }).instructions,
      "resources/read",
    );
    assertStringIncludes(
      (discover.body.result as { instructions: string }).instructions,
      "trusted arbitrary Python",
    );

    const listed = await mcpRpc(port, "tools/list");
    const tools =
      (listed.body.result as { tools: Array<Record<string, unknown>> })
        .tools;
    assertEquals(tools.every((tool) => tool._meta === undefined), true);
    const exported = tools.find((tool) => tool.name === "build123d_export");
    assertEquals(
      (exported?.annotations as { destructiveHint: boolean }).destructiveHint,
      true,
    );
    assertEquals(
      (exported?.annotations as { idempotentHint: boolean }).idempotentHint,
      false,
    );
    assertEquals(
      (exported?.annotations as { openWorldHint: boolean }).openWorldHint,
      true,
    );

    const textOnly = await mcpRpc(port, "tools/call", {
      name: "build123d_execute",
      arguments: {},
    });
    const textOnlyResult = textOnly.body.result as {
      isError: boolean;
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(textOnlyResult.isError, true);
    assertEquals(
      textOnlyResult.structuredContent.code,
      "request.invalid_arguments",
    );
    assertEquals(textOnlyResult.content[0]?.type, "text");
    assertStringIncludes(
      textOnlyResult.content[0]?.text ?? "",
      "Tool arguments do not satisfy",
    );
  } finally {
    await http.shutdown();
  }
});

Deno.test("tools advertise only viewer resources that were registered", async () => {
  const assembly = createCadMcpApp({
    viewerModuleUrl: "file:///project/server.ts",
    viewerFilesystem: {
      exists: (path) => path.endsWith("/assembly-viewer/index.html"),
      readFile: () => "<!doctype html><title>assembly</title>",
    },
  });
  assertEquals(assembly.viewers, {
    registered: ["assembly-viewer"],
    skipped: ["results-viewer", "drawing-viewer"],
  });

  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const listed = await mcpRpc(port, "tools/list");
    const tools =
      (listed.body.result as { tools: Array<Record<string, unknown>> }).tools;
    const viewerUri = (
      name: string,
    ): unknown => ((tools.find((tool) => tool.name === name)?._meta as
      | { ui?: { resourceUri?: unknown } }
      | undefined)?.ui?.resourceUri);
    assertEquals(viewerUri("build123d_execute"), undefined);
    assertEquals(viewerUri("build123d_export"), undefined);
    assertEquals(
      viewerUri("build123d_observe_assembly_integrity"),
      ASSEMBLY_VIEWER_URI,
    );
    assertEquals(viewerUri("build123d_project_2d"), undefined);
  } finally {
    await http.shutdown();
  }
});

Deno.test("HTTP resources/list and resources/read preserve promoted digest-bound bytes", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const port = startOnFreePort();
    const http = await assembly.app.startHttp({ port, onListen: () => {} });
    try {
      const path = `${exportsDirectory}/wire.glb`;
      await Deno.writeFile(path, FIXTURE_GLB);
      const exportFile = {
        format: "gltf",
        path,
        bytes: FIXTURE_GLB.byteLength,
        sha256: await sha256Hex(FIXTURE_GLB),
      } as const;
      const [published] = await assembly.artifactStore.publishExports(
        [exportFile],
        await createBuild123dExportExecution({
          script: "# HTTP artifact fixture\nresult = fixture",
          formats: ["gltf"],
          name: "wire",
          metrics: METRICS,
          exports: [exportFile],
        }),
      );
      const { uri, sha256, bytes } = published.artifact;

      const listed = await mcpRpc(port, "resources/list");
      const resources =
        (listed.body.result as { resources: Array<Record<string, unknown>> })
          .resources;
      const resource = resources.find((candidate) => candidate.uri === uri);
      assertEquals(resource?.mimeType, "model/gltf-binary");
      assertEquals(resource?.size, bytes);
      assertEquals(
        (resource?._meta as Record<string, Record<string, unknown>>)[
          "io.casys.mcp-build123d/artifact"
        ].sha256,
        sha256,
      );

      const read = await mcpRpc(port, "resources/read", { uri });
      const content =
        (read.body.result as { contents: Array<Record<string, unknown>> })
          .contents[0];
      assertEquals(content.uri, uri);
      assertEquals(content.mimeType, "model/gltf-binary");
      assertEquals(typeof content.blob, "string");
      const received = Uint8Array.from(
        atob(content.blob as string),
        (char) => char.charCodeAt(0),
      );
      assertEquals(received.byteLength, bytes);
      assertEquals(await sha256Hex(received), sha256);

      const fabricated = await mcpRpc(port, "resources/read", {
        uri: `casys://build123d/artifacts/${"f".repeat(64)}.step`,
      });
      assertEquals(fabricated.body.result, undefined);
      assertStringIncludes(JSON.stringify(fabricated.body.error), "Resource");
    } finally {
      await http.shutdown();
    }
  });
});

cadTest(
  "a native non-geometric result is a structured CAD execution failure",
  async () => {
    const assembly = testAssembly();
    const port = startOnFreePort();
    const http = await assembly.app.startHttp({ port, onListen: () => {} });
    try {
      const response = await mcpRpc(port, "tools/call", {
        name: "build123d_execute",
        arguments: { script: "result = 42" },
      });
      const result = response.body.result as {
        isError: boolean;
        structuredContent: Record<string, unknown>;
      };
      assertEquals(result.isError, true);
      assertEquals(
        result.structuredContent.schemaVersion,
        "build123d-tool-error/1.0",
      );
      assertEquals(result.structuredContent.kind, "error");
      assertEquals(result.structuredContent.tool, "build123d_execute");
      assertEquals(result.structuredContent.code, "cad.execution_failed");
      assertEquals(typeof result.structuredContent.recovery, "string");
    } finally {
      await http.shutdown();
    }
  },
);

Deno.test(
  "an explicitly missing build123d runtime is a structured recovery error",
  async () => {
    const directory = await Deno.makeTempDir({
      prefix: "mcp-build123d-missing-runtime-",
    });
    const interpreter = `${directory}/python-without-build123d`;
    const secretInterpreter = "/Users/secret/build123d/python3";
    const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
    await Deno.writeTextFile(
      interpreter,
      "#!/bin/sh\n" +
        "cat >/dev/null\n" +
        `printf '%s\\n' ${
          shellQuote(JSON.stringify({
            ok: false,
            error: "build123d is not installed for this Python interpreter. " +
              `(interpreter: ${secretInterpreter})`,
            traceback: `ImportError at ${secretInterpreter}`,
          }))
        }\n`,
      { mode: 0o700 },
    );
    Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
    try {
      const assembly = testAssembly();
      const port = startOnFreePort();
      const http = await assembly.app.startHttp({ port, onListen: () => {} });
      try {
        const response = await mcpRpc(port, "tools/call", {
          name: "build123d_execute",
          arguments: { script: "result = 42" },
        });
        const result = response.body.result as {
          isError: boolean;
          structuredContent: Record<string, unknown>;
        };
        assertEquals(result.isError, true);
        assertEquals(
          result.structuredContent.schemaVersion,
          "build123d-tool-error/1.0",
        );
        assertEquals(result.structuredContent.kind, "error");
        assertEquals(result.structuredContent.tool, "build123d_execute");
        assertEquals(
          result.structuredContent.code,
          "runtime.build123d_unavailable",
        );
        assertEquals(typeof result.structuredContent.recovery, "string");
        assertNoHostPath(response.body, secretInterpreter);
      } finally {
        await http.shutdown();
      }
    } finally {
      if (previousPython === undefined) {
        Deno.env.delete("BUILD123D_PYTHON_BIN");
      } else {
        Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
      }
      await Deno.remove(directory, { recursive: true });
    }
  },
);

Deno.test("Python and harness failures never expose host paths through HTTP", async () => {
  const secretPython = "/Users/secret/runtime/python3";
  const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
  try {
    Deno.env.set("BUILD123D_PYTHON_BIN", secretPython);
    const missingAssembly = testAssembly();
    const missingPort = startOnFreePort();
    const missingHttp = await missingAssembly.app.startHttp({
      port: missingPort,
      onListen: () => {},
    });
    try {
      const missing = await mcpRpc(missingPort, "tools/call", {
        name: "build123d_execute",
        arguments: { script: "result = fixture" },
      });
      const result = missing.body.result as {
        isError: boolean;
        structuredContent: Record<string, unknown>;
      };
      assertEquals(result.isError, true);
      assertEquals(result.structuredContent.code, "runtime.python_unavailable");
      assertNoHostPath(missing.body, secretPython);
    } finally {
      await missingHttp.shutdown();
    }

    const root = await Deno.makeTempDir({
      prefix: "mcp-build123d-redacted-harness-",
    });
    const interpreter = `${root}/fake-python`;
    const secretExport = "/Users/secret/delivery/private-output.glb";
    await Deno.writeTextFile(
      interpreter,
      "#!/bin/sh\n" +
        "cat >/dev/null\n" +
        `printf '%s\\n' ${
          shellQuote(JSON.stringify({
            ok: false,
            error: `Export gltf to ${secretExport} failed: OSError`,
            traceback: `Traceback includes ${secretExport}`,
          }))
        }\n`,
      { mode: 0o700 },
    );
    Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
    const exportDirectory = `${root}/delivery`;
    await Deno.mkdir(exportDirectory);
    const harnessAssembly = testAssembly(exportDirectory, `${root}/artifacts`);
    const harnessPort = startOnFreePort();
    const harnessHttp = await harnessAssembly.app.startHttp({
      port: harnessPort,
      onListen: () => {},
    });
    try {
      const failedExport = await mcpRpc(harnessPort, "tools/call", {
        name: "build123d_export",
        arguments: {
          script: "result = fixture",
          formats: ["gltf"],
          name: "private-output",
        },
      });
      const result = failedExport.body.result as {
        isError: boolean;
        structuredContent: Record<string, unknown>;
      };
      assertEquals(result.isError, true);
      assertEquals(result.structuredContent.code, "cad.execution_failed");
      assertNoHostPath(failedExport.body, secretExport);
    } finally {
      await harnessHttp.shutdown();
      await Deno.remove(root, { recursive: true });
    }
  } finally {
    if (previousPython === undefined) Deno.env.delete("BUILD123D_PYTHON_BIN");
    else Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
  }
});

Deno.test("artifact storage failures never expose an absolute host path to MCP", async () => {
  const root = await Deno.makeTempDir({ prefix: "mcp-build123d-path-safe-" });
  const deliveryParent = `${root}/delivery-is-a-file`;
  const deliveryPath = `${deliveryParent}/nested`;
  await Deno.writeTextFile(deliveryParent, "not a directory");
  const assembly = testAssembly(deliveryPath, `${root}/artifacts`);
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const response = await mcpRpc(port, "tools/call", {
      name: "build123d_export",
      arguments: {
        script: "result = 42",
        formats: ["step"],
        name: "path-safe",
      },
    });
    const result = response.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
      content: Array<{ text: string }>;
    };
    assertEquals(result.isError, true);
    assertEquals(result.structuredContent.code, "artifact.store_unavailable");
    assertEquals(JSON.stringify(result).includes(root), false);
    assertEquals(result.content[0].text.includes(root), false);
  } finally {
    await http.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("wire schemas reject invalid requests without echoing host paths", async () => {
  const assembly = testAssembly();
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const extra = await mcpRpc(port, "tools/call", {
      name: "build123d_execute",
      arguments: { script: "result = 1", "/Users/secret/request": true },
    });
    const extraResult = extra.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(extraResult.isError, true);
    assertEquals(
      extraResult.structuredContent.code,
      "request.invalid_arguments",
    );
    assertNoHostPath(extra.body, "/Users/secret/request");

    const invalidFormats = await mcpRpc(port, "tools/call", {
      name: "build123d_export",
      arguments: { script: "result = 1", formats: ["step", "step"], name: "x" },
    });
    const formatsResult = invalidFormats.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(formatsResult.isError, true);
    assertEquals(
      formatsResult.structuredContent.code,
      "request.invalid_arguments",
    );
  } finally {
    await http.shutdown();
  }
});

Deno.test(
  "wire schema rejects a 251-character export name before Python or staging",
  async () => {
    await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
      const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
      const root = await Deno.makeTempDir({
        prefix: "mcp-build123d-basename-limit-",
      });
      const interpreter = `${root}/python`;
      const ran = `${root}/ran`;
      await Deno.writeTextFile(
        interpreter,
        `#!/bin/sh\nprintf ran > ${shellQuote(ran)}\nexit 1\n`,
        { mode: 0o700 },
      );
      Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
      const assembly = testAssembly(exportsDirectory, artifactsDirectory);
      const port = startOnFreePort();
      const http = await assembly.app.startHttp({ port, onListen: () => {} });
      try {
        const response = await mcpRpc(port, "tools/call", {
          name: "build123d_export",
          arguments: {
            script: "result = 1",
            formats: ["step"],
            name: "a".repeat(251),
          },
        });
        const result = response.body.result as {
          isError: boolean;
          structuredContent: Record<string, unknown>;
        };
        assertEquals(result.isError, true);
        assertEquals(
          result.structuredContent.code,
          "request.invalid_arguments",
        );
        assertEquals(
          Array.from(Deno.readDirSync(exportsDirectory)).map((entry) =>
            entry.name
          ),
          [],
        );
        await assertRejects(() => Deno.stat(ran), Deno.errors.NotFound);
      } finally {
        await http.shutdown();
        if (previousPython === undefined) {
          Deno.env.delete("BUILD123D_PYTHON_BIN");
        } else {
          Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
        }
        await Deno.remove(root, { recursive: true });
      }
    });
  },
);

Deno.test(
  "wire accepts 250 emoji in schema then rejects the sanitized basename before Python or staging",
  async () => {
    await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
      const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
      const root = await Deno.makeTempDir({
        prefix: "mcp-build123d-basename-emoji-",
      });
      const interpreter = `${root}/python`;
      const ran = `${root}/ran`;
      await Deno.writeTextFile(
        interpreter,
        `#!/bin/sh\nprintf ran > ${shellQuote(ran)}\nexit 1\n`,
        { mode: 0o700 },
      );
      Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
      const assembly = testAssembly(exportsDirectory, artifactsDirectory);
      const exported = assembly.toolsClient.toMCPFormat().find((tool) =>
        tool.name === "build123d_export"
      );
      if (!exported) throw new Error("Missing export tool");
      const validator = new SchemaValidator();
      validator.addSchema("build123d_export", exported.inputSchema);
      const emojiName = "😀".repeat(250);
      assertEquals([...emojiName].length, 250);
      assertEquals(emojiName.length, 500);
      assertEquals(
        validator.validate("build123d_export", {
          script: "result = 1",
          formats: ["step"],
          name: emojiName,
        }).valid,
        true,
      );
      const port = startOnFreePort();
      const http = await assembly.app.startHttp({ port, onListen: () => {} });
      try {
        const response = await mcpRpc(port, "tools/call", {
          name: "build123d_export",
          arguments: {
            script: "result = 1",
            formats: ["step"],
            name: emojiName,
          },
        });
        const result = response.body.result as {
          isError: boolean;
          structuredContent: Record<string, unknown>;
        };
        assertEquals(result.isError, true);
        assertEquals(
          result.structuredContent.code,
          "request.invalid_arguments",
        );
        assertEquals(result.structuredContent.retryable, false);
        assertEquals(
          Array.from(Deno.readDirSync(exportsDirectory)).map((entry) =>
            entry.name
          ),
          [],
        );
        await assertRejects(() => Deno.stat(ran), Deno.errors.NotFound);
      } finally {
        await http.shutdown();
        if (previousPython === undefined) {
          Deno.env.delete("BUILD123D_PYTHON_BIN");
        } else {
          Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
        }
        await Deno.remove(root, { recursive: true });
      }
    });
  },
);

Deno.test("the three published viewers load from their package paths", async () => {
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
        `http://127.0.0.1:${port}/@casys/mcp-build123d/0.6.4/server.ts`,
    });
    assertEquals(assembly.viewers, {
      registered: ["results-viewer", "assembly-viewer", "drawing-viewer"],
      skipped: [],
    });
    for (
      const uri of [
        RESULTS_VIEWER_URI,
        ASSEMBLY_VIEWER_URI,
        DRAWING_VIEWER_URI,
      ]
    ) {
      assertStringIncludes(
        (await assembly.app.readResourceContent(uri))?.text ?? "",
        "published CAD result",
      );
    }
    assertEquals(seen, [
      "/@casys/mcp-build123d/0.6.4/src/ui/dist/results-viewer/index.html",
      "/@casys/mcp-build123d/0.6.4/src/ui/dist/assembly-viewer/index.html",
      "/@casys/mcp-build123d/0.6.4/src/ui/dist/drawing-viewer/index.html",
    ]);
  } finally {
    await remote.shutdown();
  }
});

Deno.test("viewer resource failures never expose host paths through HTTP", async () => {
  const secret = "/Users/secret/results-viewer.html";
  const assembly = createCadMcpApp({
    viewerFilesystem: {
      exists: () => true,
      readFile: () => {
        throw new Error(`viewer read failed: ${secret}`);
      },
    },
  });
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const response = await mcpRpc(port, "resources/read", {
      uri: RESULTS_VIEWER_URI,
    });
    assertEquals(response.body.result, undefined);
    assertNoHostPath(response.body, secret);
    assertEquals(
      JSON.stringify(response.body).includes("viewer read failed"),
      false,
    );
    assertStringIncludes(
      JSON.stringify(response.body),
      "requested build123d viewer could not be read",
    );
  } finally {
    await http.shutdown();
  }
});

Deno.test("the generated result viewer uses resources/read instead of a private tool", async () => {
  const assembly = createCadMcpApp();
  assertEquals(assembly.viewers, {
    registered: ["results-viewer", "assembly-viewer", "drawing-viewer"],
    skipped: [],
  });
  const html =
    (await assembly.app.readResourceContent(RESULTS_VIEWER_URI))?.text ?? "";
  assertStringIncludes(html, BUILD123D_MCP_APP_INFO.name);
  assertStringIncludes(html, BUILD123D_MCP_APP_INFO.version);
  assertStringIncludes(html, BUILD123D_RECORDED_VIEW_SESSION_SCHEMA);
  assertStringIncludes(html, BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA);
  assertStringIncludes(html, MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE);
  assertStringIncludes(
    html,
    "--mcp-view-text: var(--color-text-primary, #101519)",
  );
  assertStringIncludes(html, ':root[data-theme="dark"]');
  assertStringIncludes(html, "readServerResource");
  assertEquals(html.includes("build123d_export_read"), false);
  assertEquals(/<script[^>]+src=/i.test(html), false);

  for (const uri of [ASSEMBLY_VIEWER_URI, DRAWING_VIEWER_URI]) {
    const inspectionHtml =
      (await assembly.app.readResourceContent(uri))?.text ?? "";
    assertStringIncludes(inspectionHtml, BUILD123D_MCP_APP_INFO.name);
    assertStringIncludes(inspectionHtml, "Powered by Casys.ai");
    assertEquals(/<script[^>]+src=/i.test(inspectionHtml), false);
  }
});

Deno.test("assembly-integrity accepts a legal-size inline envelope through the HTTP cap", async () => {
  const assembly = testAssembly();
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({
    port,
    maxBodyBytes: ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES,
    onListen: () => {},
  });
  try {
    const response = await mcpRpc(port, "tools/call", {
      name: "build123d_observe_assembly_integrity",
      arguments: {
        step: {
          mimeType: "model/step",
          sha256: "0".repeat(64),
          bytes: 786_432,
          blob: "A".repeat(1_048_576),
        },
      },
    });
    assertEquals(response.status === 413, false);
    const result = response.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(result.isError, true);
    assertEquals(
      result.structuredContent.code,
      "assembly_integrity.input_invalid",
    );
    assertEquals(result.structuredContent.retryable, false);
  } finally {
    await http.shutdown();
  }
});

Deno.test("assembly-integrity HTTP schema rejects both inline and resource forms together", async () => {
  const assembly = testAssembly();
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const sha256 = "0".repeat(64);
    const response = await mcpRpc(port, "tools/call", {
      name: "build123d_observe_assembly_integrity",
      arguments: {
        step: {
          mimeType: "model/step",
          sha256,
          bytes: 1,
          blob: "QQ==",
        },
        stepResource: {
          uri: `casys://build123d/artifacts/${sha256}.step`,
          mimeType: "model/step",
          sha256,
          bytes: 1,
        },
      },
    });
    const result = response.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(result.isError, true);
    assertEquals(result.structuredContent.code, "request.invalid_arguments");
  } finally {
    await http.shutdown();
  }
});

Deno.test("assembly-integrity HTTP resource form rejects an unknown current-process URI", async () => {
  const assembly = testAssembly();
  const port = startOnFreePort();
  const http = await assembly.app.startHttp({ port, onListen: () => {} });
  try {
    const sha256 = "0".repeat(64);
    const response = await mcpRpc(port, "tools/call", {
      name: "build123d_observe_assembly_integrity",
      arguments: {
        stepResource: {
          uri: `casys://build123d/artifacts/${sha256}.step`,
          mimeType: "model/step",
          sha256,
          bytes: 1,
        },
      },
    });
    const result = response.body.result as {
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };
    assertEquals(result.isError, true);
    assertEquals(
      result.structuredContent.code,
      "assembly_integrity.input_invalid",
    );
    assertEquals(result.structuredContent.retryable, false);
  } finally {
    await http.shutdown();
  }
});

Deno.test("assembly-integrity observer failures are structured and non-retryable", () => {
  const result = build123dToolErrorResult(
    "build123d_observe_assembly_integrity",
    new AssemblyIntegrityObservationError(
      "Fixed observer could not inspect the STEP bytes.",
    ),
  );
  assertEquals(result.isError, true);
  assertEquals(
    result.structuredContent.code,
    "assembly_integrity.observation_failed",
  );
  assertEquals(result.structuredContent.retryable, false);
});

Deno.test("2D projection failures keep input and generation recovery distinct", () => {
  const invalid = build123dToolErrorResult(
    "build123d_project_2d",
    new Projection2dInputError("private input detail"),
  );
  assertEquals(invalid.structuredContent.code, "projection_2d.input_invalid");
  assertEquals(invalid.structuredContent.retryable, false);
  assertEquals(JSON.stringify(invalid).includes("private input detail"), false);

  const failed = build123dToolErrorResult(
    "build123d_project_2d",
    new Projection2dGenerationError("private harness detail"),
  );
  assertEquals(
    failed.structuredContent.code,
    "projection_2d.generation_failed",
  );
  assertEquals(failed.structuredContent.retryable, false);
  assertEquals(
    JSON.stringify(failed).includes("private harness detail"),
    false,
  );
});

Deno.test("execution resource limits are structured, non-retryable recovery errors", () => {
  const result = build123dToolErrorResult(
    "build123d_execute",
    new CadExecutionLimitError("stdout", "internal stdout limit detail"),
  );
  assertEquals(result.isError, true);
  assertEquals(result.structuredContent.code, "execution.resource_limit");
  assertEquals(result.structuredContent.retryable, false);
  assertEquals(
    JSON.stringify(result).includes("internal stdout limit detail"),
    false,
  );
});
