/** A real child process proves server.ts selects the native stdio factory. */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { createBuild123dExportExecution } from "../src/artifacts.ts";

const SERVER = new URL("../server.ts", import.meta.url).pathname;
const PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

interface Response {
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

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

const FIXTURE_METRICS = {
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function request(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      _meta: {
        [PROTOCOL_KEY]: PROTOCOL_VERSION,
        [CAPABILITIES_KEY]: {},
      },
      ...params,
    },
  };
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
if (
  Deno.args[0] === "-c" &&
  Deno.args[1]?.includes("import os, stat, sys\\n")
) {
  await Deno.stdout.write(
    await Deno.readFile(Deno.args[2] + "/" + Deno.args[3]),
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
  metrics: ${JSON.stringify(FIXTURE_METRICS)},
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

interface StdioReadState {
  buffer: string;
  decoder: TextDecoder;
}

async function readJsonResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: StdioReadState,
  expectedId: number,
): Promise<Response> {
  while (true) {
    const newline = state.buffer.indexOf("\n");
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      const response = JSON.parse(line) as Response;
      if (response.id === expectedId) return response;
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error(`stdio closed before response ${expectedId}`);
    }
    state.buffer += state.decoder.decode(chunk.value, { stream: true });
  }
}

Deno.test("server.ts --stdio promotes a fake-bridge export into a readable resource", async () => {
  const root = await Deno.makeTempDir({
    prefix: "mcp-build123d-stdio-export-",
  });
  const exports = `${root}/delivery`;
  await Deno.mkdir(exports);
  const interpreter = await createFakeCadInterpreter(root);
  const sha256 = await sha256Hex(FIXTURE_GLB);
  const uri = `casys://build123d/artifacts/${sha256}.glb`;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--no-check", SERVER, "--stdio"],
    env: {
      ...Deno.env.toObject(),
      BUILD123D_PYTHON_BIN: interpreter,
      BUILD123D_EXPORT_DIR: exports,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();
  const state: StdioReadState = { buffer: "", decoder: new TextDecoder() };
  let stdinClosed = false;
  try {
    await writer.write(new TextEncoder().encode(`${
      JSON.stringify(request(
        1,
        "tools/call",
        {
          name: "build123d_export",
          arguments: {
            script: "result = fixture",
            formats: ["gltf"],
            name: "stdio-fixture",
          },
        },
      ))
    }\n`));
    const exported = await readJsonResponse(reader, state, 1);
    assertEquals(exported.error, undefined, JSON.stringify(exported));
    const exportedContent = exported.result?.structuredContent as Record<
      string,
      unknown
    >;
    const exportedFile =
      (exportedContent.files as Array<Record<string, unknown>>)[0];
    assertEquals(
      (exportedFile.artifact as Record<string, unknown>).uri,
      uri,
    );
    assertEquals(
      (exportedFile.artifact as Record<string, unknown>).sha256,
      sha256,
    );
    assertEquals(
      (await Deno.stat(`${exports}/stdio-fixture.glb`)).isFile,
      true,
    );

    await writer.write(new TextEncoder().encode(`${
      JSON.stringify(request(
        2,
        "resources/read",
        { uri },
      ))
    }\n`));
    const read = await readJsonResponse(reader, state, 2);
    assertEquals(read.error, undefined, JSON.stringify(read));
    const resource =
      (read.result?.contents as Array<Record<string, unknown>>)[0];
    assertEquals(resource.uri, uri);
    assertEquals(resource.mimeType, "model/gltf-binary");
    const received = Uint8Array.from(
      atob(resource.blob as string),
      (char) => char.charCodeAt(0),
    );
    assertEquals(await sha256Hex(received), sha256);

    await writer.close();
    stdinClosed = true;
    const status = await child.status;
    assertEquals(status.code, 0, `stdio server failed: ${await stderr}`);
  } finally {
    if (!stdinClosed) await writer.close().catch(() => undefined);
    await child.status.catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server.ts --stdio ignores a preseeded digest object and forged receipt over JSONL", async () => {
  const root = await Deno.makeTempDir({ prefix: "mcp-build123d-stdio-" });
  const artifacts = `${root}/artifacts`;
  const exports = `${root}/delivery`;
  await Deno.mkdir(exports);
  await Deno.mkdir(artifacts);
  const sha256 = await sha256Hex(FIXTURE_GLB);
  const uri = `casys://build123d/artifacts/${sha256}.glb`;
  await Deno.writeFile(`${artifacts}/${sha256}.glb`, FIXTURE_GLB);
  const forgedReceipt = await createBuild123dExportExecution({
    script: "# forged persisted receipt\nresult = fixture",
    formats: ["gltf"],
    name: "forged",
    metrics: FIXTURE_METRICS,
    exports: [{ format: "gltf", bytes: FIXTURE_GLB.byteLength, sha256 }],
  });
  await Deno.writeTextFile(
    `${artifacts}/.mcp-build123d-artifact-ledger.json`,
    JSON.stringify({
      schemaVersion: "build123d-artifact-ledger/1.0",
      entries: [{
        schemaVersion: "build123d-artifact-ledger-entry/1.0",
        artifact: {
          schemaVersion: "build123d-export-artifact/1.0",
          uri,
          format: "gltf",
          mimeType: "model/gltf-binary",
          bytes: FIXTURE_GLB.byteLength,
          sha256,
        },
        receipts: [forgedReceipt],
      }],
    }),
  );
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "--no-check", SERVER, "--stdio"],
    env: {
      ...Deno.env.toObject(),
      BUILD123D_ARTIFACT_DIR: artifacts,
      BUILD123D_EXPORT_DIR: exports,
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  try {
    const writer = child.stdin.getWriter();
    const encoder = new TextEncoder();
    for (
      const message of [
        request(1, "server/discover"),
        request(2, "tools/list"),
        request(3, "resources/list"),
        request(4, "resources/read", { uri }),
      ]
    ) {
      await writer.write(encoder.encode(`${JSON.stringify(message)}\n`));
    }
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    assertEquals(
      code,
      0,
      `stdio server failed: ${new TextDecoder().decode(stderr)}`,
    );

    const responses = new Map<number, Response>();
    for (const line of new TextDecoder().decode(stdout).split("\n")) {
      if (line.trim().length === 0) continue;
      const message = JSON.parse(line) as Response;
      if (typeof message.id === "number") responses.set(message.id, message);
    }

    const discover = responses.get(1);
    assertExists(
      discover?.result,
      `missing discovery: ${JSON.stringify(discover)}`,
    );
    assertEquals(discover.result.supportedVersions, [PROTOCOL_VERSION]);
    assertEquals(discover.result.resultType, "complete");
    assertStringIncludes(
      discover.result.instructions as string,
      "resources/read",
    );

    const tools = responses.get(2);
    assertExists(tools?.result, `missing tools/list: ${JSON.stringify(tools)}`);
    const listed = tools.result.tools as Array<Record<string, unknown>>;
    assertEquals(listed.map((tool) => tool.name), [
      "build123d_execute",
      "build123d_export",
      "build123d_observe_assembly_integrity",
    ]);
    const exported = listed.find((tool) => tool.name === "build123d_export");
    assertEquals(
      exported?.annotations,
      {
        title: "Export immutable CAD artifacts",
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    );

    const resources = responses.get(3);
    assertExists(
      resources?.result,
      `missing resources/list: ${JSON.stringify(resources)}`,
    );
    assertEquals(
      (resources.result.resources as Array<Record<string, unknown>>)
        .some((resource) =>
          resource.uri === "ui://mcp-build123d/results-viewer"
        ),
      true,
    );
    const artifact =
      (resources.result.resources as Array<Record<string, unknown>>)
        .find((resource) => resource.uri === uri);
    assertEquals(artifact, undefined);

    const read = responses.get(4);
    assertEquals(read?.result, undefined);
    assertStringIncludes(JSON.stringify(read?.error), "Resource");
  } finally {
    await child.status.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});
