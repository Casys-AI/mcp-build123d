/**
 * CAD execution and immutable-artifact tests. Python with build123d is
 * required, just as it is for the server itself.
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { McpApp, SchemaValidator } from "@casys/mcp-server";
import {
  BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  Build123dArtifactError,
  Build123dArtifactStore,
  createBuild123dExportExecution,
} from "../src/artifacts.ts";
import {
  BUILD123D_MAXIMUM_HARNESS_STDOUT_BYTES,
  CadExecutionError,
  CadExecutionLimitError,
  type CadMetrics,
  runCadScript,
} from "../src/api/python-bridge.ts";
import { createCadMcpApp } from "../src/server-app.ts";
import {
  createExecuteTools,
  executeTools,
  geometryToolResult,
} from "../src/tools/execute.ts";

/** A 10×20×5 mm box: 1,000 mm³, independently checkable by hand. */
const BOX_SCRIPT = `
from build123d import *
with BuildPart() as p:
    Box(10, 20, 5)
result = p
`;

const STEP_FILE_NAME_TIMESTAMP_SENTINEL = "1970-01-01T00:00:00Z";
const FIXTURE_STEP = new TextEncoder().encode(
  `ISO-10303-21;\nFILE_NAME('Open CASCADE Shape Model','${STEP_FILE_NAME_TIMESTAMP_SENTINEL}');\nEND-ISO-10303-21;\n`,
);
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

const FIXTURE_METRICS: CadMetrics = {
  volume_mm3: 1000,
  area_mm2: 700,
  center_of_mass_mm: [5, 10, 2.5],
  bounding_box_mm: {
    min: [0, 0, 0],
    max: [10, 20, 5],
    size: [10, 20, 5],
  },
  solids: 1,
  faces: 6,
  edges: 12,
};

function handler(name: string) {
  const tool = executeTools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

function structuredContent(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> })
    .structuredContent;
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

interface ArtifactPayload {
  schemaVersion: "build123d-export-artifact/1.0";
  uri: string;
  format: "step" | "stl" | "gltf";
  mimeType: "model/step" | "model/stl" | "model/gltf-binary";
  bytes: number;
  sha256: string;
}

interface ExportPayloadFile {
  format: "step" | "stl" | "gltf";
  artifact: ArtifactPayload;
}

async function withServerRoots<T>(
  run: (roots: {
    readonly root: string;
    readonly exportsDirectory: string;
    readonly artifactsDirectory: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "mcp-build123d-test-" });
  const exportsDirectory = `${root}/delivery`;
  const artifactsDirectory = `${root}/artifacts`;
  await Deno.mkdir(exportsDirectory);
  try {
    return await run({ root, exportsDirectory, artifactsDirectory });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function testAssembly(
  exportsDirectory: string,
  artifactsDirectory: string,
) {
  return createCadMcpApp({
    exportDirectory: exportsDirectory,
    artifactDirectory: artifactsDirectory,
    viewerModuleUrl: "file:///test/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
}

async function build123dRuntimeAvailable(): Promise<boolean> {
  try {
    return (await new Deno.Command(
      Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3",
      { args: ["-c", "import build123d"], stdout: "null", stderr: "null" },
    ).output()).success;
  } catch {
    return false;
  }
}

const BUILD123D_RUNTIME_AVAILABLE = await build123dRuntimeAvailable();

function cadTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: !BUILD123D_RUNTIME_AVAILABLE, fn });
}

async function publishFixture(
  assembly: ReturnType<typeof testAssembly>,
  exportsDirectory: string,
  format: "step" | "stl" | "gltf",
  bytes: Uint8Array,
  name: string,
): Promise<ExportPayloadFile> {
  const extension = format === "gltf" ? "glb" : format;
  const path = `${exportsDirectory}/${name}.${extension}`;
  await Deno.writeFile(path, bytes);
  const exportFile = {
    format,
    path,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
  const [published] = await assembly.artifactStore.publishExports(
    [exportFile],
    await createBuild123dExportExecution({
      script: `# fixture ${name}\nresult = fixture`,
      formats: [format],
      name,
      metrics: FIXTURE_METRICS,
      exports: [exportFile],
    }),
  );
  return published;
}

cadTest(
  "build123d_execute returns exact analytical metrics for a known box",
  async () => {
    const result = await handler("build123d_execute")({ script: BOX_SCRIPT });
    const payload = structuredContent(result);
    const metrics = payload.metrics as Record<string, unknown>;

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.kind, "execution");
    assertEquals(payload.files, []);
    assertAlmostEquals(metrics.volume_mm3 as number, 1000, 1e-6);
    assertAlmostEquals(metrics.area_mm2 as number, 700, 1e-6);
    assertEquals(metrics.solids, 1);
    assertEquals(metrics.faces, 6);
    assertEquals((metrics.bounding_box_mm as { size: number[] }).size, [
      10,
      20,
      5,
    ]);
  },
);

cadTest(
  "build123d_execute reports mass only when density is explicit",
  async () => {
    const without = structuredContent(
      await handler("build123d_execute")({ script: BOX_SCRIPT }),
    ).metrics as Record<string, unknown>;
    assertEquals("mass_kg" in without, false);

    const withDensity = structuredContent(
      await handler("build123d_execute")({
        script: BOX_SCRIPT,
        density_kg_m3: 2700,
      }),
    ).metrics as Record<string, unknown>;
    assertAlmostEquals(withDensity.mass_kg as number, 0.0027, 1e-9);
  },
);

cadTest("build123d_execute surfaces a concrete build123d failure", async () => {
  await assertRejects(
    async () => await handler("build123d_execute")({ script: "result = 42" }),
    CadExecutionError,
    "no geometry",
  );
});

Deno.test("direct build123d_export refuses before Python or delivery staging", async () => {
  const root = await Deno.makeTempDir({ prefix: "mcp-build123d-preflight-" });
  const delivery = `${root}/delivery`;
  const marker = `${root}/python-was-run`;
  const fakePython = `${root}/python-must-not-run`;
  const previousExportDirectory = Deno.env.get("BUILD123D_EXPORT_DIR");
  const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
  try {
    await Deno.writeTextFile(
      fakePython,
      `#!/bin/sh\nprintf invoked > "${marker}"\n`,
    );
    await Deno.chmod(fakePython, 0o700);
    Deno.env.set("BUILD123D_EXPORT_DIR", delivery);
    Deno.env.set("BUILD123D_PYTHON_BIN", fakePython);
    const exported = createExecuteTools().find((tool) =>
      tool.name === "build123d_export"
    );
    if (!exported) throw new Error("Missing direct export tool");

    await assertRejects(
      async () =>
        await exported.handler({
          script: BOX_SCRIPT,
          formats: ["step"],
          name: "must-not-stage",
        }),
      Error,
      "requires a server-owned artifact publisher",
    );
    await assertRejects(() => Deno.lstat(delivery), Deno.errors.NotFound);
    await assertRejects(() => Deno.lstat(marker), Deno.errors.NotFound);
  } finally {
    if (previousExportDirectory === undefined) {
      Deno.env.delete("BUILD123D_EXPORT_DIR");
    } else {
      Deno.env.set("BUILD123D_EXPORT_DIR", previousExportDirectory);
    }
    if (previousPython === undefined) {
      Deno.env.delete("BUILD123D_PYTHON_BIN");
    } else {
      Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
    }
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("direct execution fails closed before buffering oversized Python stdout", async () => {
  const root = await Deno.makeTempDir({
    prefix: "mcp-build123d-stdout-limit-",
  });
  const interpreter = `${root}/noisy-python`;
  const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
  try {
    await Deno.writeTextFile(
      interpreter,
      "#!/bin/sh\nhead -c 2097152 /dev/zero\n",
      { mode: 0o700 },
    );
    Deno.env.set("BUILD123D_PYTHON_BIN", interpreter);
    const error = await assertRejects(
      () => runCadScript("result = fixture"),
      CadExecutionLimitError,
      "stdout",
    );
    assertEquals(error.limit, "stdout");
    assertEquals(BUILD123D_MAXIMUM_HARNESS_STDOUT_BYTES < 2_097_152, true);
  } finally {
    if (previousPython === undefined) Deno.env.delete("BUILD123D_PYTHON_BIN");
    else Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
    await Deno.remove(root, { recursive: true });
  }
});

cadTest(
  "timeout terminates the Python execution process group and descendants",
  async () => {
    const root = await Deno.makeTempDir({
      prefix: "mcp-build123d-process-tree-",
    });
    const marker = `${root}/descendant-survived`;
    try {
      const script = `
from build123d import Box
import subprocess
subprocess.Popen(["/bin/sh", "-c", "sleep 0.4; touch ${marker}"])
while True:
    pass
result = Box(1, 1, 1)
`;
      const error = await assertRejects(
        () => runCadScript(script, { timeoutMs: 30 }),
        CadExecutionLimitError,
        "exceeded",
      );
      assertEquals(error.limit, "timeout");
      await new Promise((resolve) => setTimeout(resolve, 600));
      await assertRejects(() => Deno.stat(marker), Deno.errors.NotFound);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test("artifact promotion rejects an oversized declared delivery before opening it", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const exportFile = {
      format: "gltf" as const,
      path: "never-read.glb",
      bytes: BUILD123D_MAXIMUM_ARTIFACT_BYTES + 1,
      sha256: "0".repeat(64),
    };
    const execution = await createBuild123dExportExecution({
      script: "result = fixture",
      formats: ["gltf"],
      name: "never-read",
      metrics: FIXTURE_METRICS,
      exports: [exportFile],
    });
    const error = await assertRejects(
      () => assembly.artifactStore.publishExports([exportFile], execution),
      Build123dArtifactError,
      "fixed artifact byte limit",
    );
    assertEquals(error.code, "artifact.too_large");
  });
});

Deno.test("artifact promotion exposes verified immutable resources, never paths", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const files = await Promise.all([
      publishFixture(
        assembly,
        exportsDirectory,
        "step",
        FIXTURE_STEP,
        "box",
      ),
      publishFixture(
        assembly,
        exportsDirectory,
        "gltf",
        FIXTURE_GLB,
        "box",
      ),
    ]);
    const payload = structuredContent(geometryToolResult("export", {
      volume_mm3: 1000,
      area_mm2: 700,
      center_of_mass_mm: [5, 10, 2.5],
      bounding_box_mm: {
        min: [0, 0, 0],
        max: [10, 20, 5],
        size: [10, 20, 5],
      },
      solids: 1,
      faces: 6,
      edges: 12,
    }, files));

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.kind, "export");
    assertEquals(files.map((file) => file.format), ["step", "gltf"]);
    assertEquals(
      (payload.files as ExportPayloadFile[]).map((file) => file.artifact.uri),
      files.map((file) => file.artifact.uri),
    );

    for (const file of files) {
      assertEquals("path" in file, false);
      assertEquals(
        file.artifact.schemaVersion,
        "build123d-export-artifact/1.0",
      );
      assertEquals(file.artifact.format, file.format);
      assertEquals(
        file.artifact.uri,
        `casys://build123d/artifacts/${file.artifact.sha256}.${
          file.format === "gltf" ? "glb" : file.format
        }`,
      );
      assertEquals(file.artifact.bytes > 0, true);
      assertEquals(/^[a-f0-9]{64}$/.test(file.artifact.sha256), true);

      const resource = assembly.app.getResourceInfo(file.artifact.uri);
      assertEquals(resource?.mimeType, file.artifact.mimeType);
      assertEquals(resource?.size, file.artifact.bytes);
      assertEquals(
        (resource?._meta as Record<string, Record<string, unknown>>)[
          "io.casys.mcp-build123d/artifact"
        ].sha256,
        file.artifact.sha256,
      );
      const content = await assembly.app.readResourceContent(file.artifact.uri);
      assertEquals(content?.mimeType, file.artifact.mimeType);
      assertEquals(typeof content?.blob, "string");
      const bytes = Uint8Array.from(
        atob(content?.blob ?? ""),
        (char) => char.charCodeAt(0),
      );
      assertEquals(bytes.byteLength, file.artifact.bytes);
      assertEquals(await sha256Hex(bytes), file.artifact.sha256);
    }

    // Resource bytes remain process-local. No artifact object directory is
    // created for a Python process to preseed or swap on disk.
    await assertRejects(
      () => Deno.lstat(artifactsDirectory),
      Deno.errors.NotFound,
    );

    // Delivery files are internal staging only: no name/path crossed MCP.
    const deliveryNames = Array.from(Deno.readDirSync(exportsDirectory))
      .map((entry) => entry.name)
      .sort();
    assertEquals(deliveryNames, ["box.glb", "box.step"]);
  });
});

Deno.test("an on-disk digest-shaped shadow cannot alter an issued resource", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const artifact = (await publishFixture(
      assembly,
      exportsDirectory,
      "step",
      FIXTURE_STEP,
      "tamper-check",
    )).artifact;
    await Deno.mkdir(artifactsDirectory);
    await Deno.writeTextFile(
      `${artifactsDirectory}/${artifact.sha256}.step`,
      "tampered bytes",
    );

    const content = await assembly.app.readResourceContent(artifact.uri);
    const bytes = Uint8Array.from(
      atob(content?.blob ?? ""),
      (char) => char.charCodeAt(0),
    );
    assertEquals(await sha256Hex(bytes), artifact.sha256);
  });
});

Deno.test("an issued artifact does not survive a server restart", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const first = testAssembly(exportsDirectory, artifactsDirectory);
    const artifact = (await publishFixture(
      first,
      exportsDirectory,
      "stl",
      new TextEncoder().encode("solid restart\nendsolid restart\n"),
      "restart",
    )).artifact;

    const restarted = testAssembly(exportsDirectory, artifactsDirectory);
    await restarted.artifactStore.restore();
    assertEquals(restarted.app.getResourceInfo(artifact.uri), undefined);
    assertEquals(await restarted.app.readResourceContent(artifact.uri), null);
  });
});

Deno.test("restart ignores a forged digest object and structured receipt", async () => {
  await withServerRoots(async ({ artifactsDirectory, exportsDirectory }) => {
    await Deno.mkdir(artifactsDirectory);
    const sha256 = await sha256Hex(FIXTURE_GLB);
    const uri = `casys://build123d/artifacts/${sha256}.glb`;
    await Deno.writeFile(`${artifactsDirectory}/${sha256}.glb`, FIXTURE_GLB);
    const forgedReceipt = await createBuild123dExportExecution({
      script: "# forged persisted receipt\nresult = fixture",
      formats: ["gltf"],
      name: "forged",
      metrics: FIXTURE_METRICS,
      exports: [{ format: "gltf", bytes: FIXTURE_GLB.byteLength, sha256 }],
    });
    await Deno.writeTextFile(
      `${artifactsDirectory}/.mcp-build123d-artifact-ledger.json`,
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

    const restarted = testAssembly(exportsDirectory, artifactsDirectory);
    await restarted.artifactStore.restore();
    assertEquals(restarted.app.getResourceInfo(uri), undefined);
    assertEquals(await restarted.app.readResourceContent(uri), null);
  });
});

Deno.test("artifact promotion refuses a bridge path outside its managed delivery root", async () => {
  await withServerRoots(
    async ({ root, exportsDirectory, artifactsDirectory }) => {
      const assembly = testAssembly(exportsDirectory, artifactsDirectory);
      const outside = `${root}/outside.step`;
      const bytes = new TextEncoder().encode("private source");
      await Deno.writeFile(outside, bytes);
      const sha256 = await sha256Hex(bytes);
      const exportFile = {
        format: "step" as const,
        path: outside,
        bytes: bytes.byteLength,
        sha256,
      };
      await assertRejects(
        async () =>
          await assembly.artifactStore.publishExports(
            [exportFile],
            await createBuild123dExportExecution({
              script: "result = fixture",
              formats: ["step"],
              name: "outside",
              metrics: FIXTURE_METRICS,
              exports: [exportFile],
            }),
          ),
        Build123dArtifactError,
        "escapes its managed directory",
      );
    },
  );
});

Deno.test({
  name: "artifact promotion rejects a named-pipe delivery without blocking",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
      const assembly = testAssembly(exportsDirectory, artifactsDirectory);
      const pipe = `${exportsDirectory}/blocked.step`;
      const created = await new Deno.Command("mkfifo", {
        args: [pipe],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(created.success, true);
      const exportFile = {
        format: "step" as const,
        path: pipe,
        bytes: FIXTURE_STEP.byteLength,
        sha256: await sha256Hex(FIXTURE_STEP),
      };
      const started = Date.now();
      await assertRejects(
        async () =>
          await assembly.artifactStore.publishExports(
            [exportFile],
            await createBuild123dExportExecution({
              script: "result = fixture",
              formats: ["step"],
              name: "blocked",
              metrics: FIXTURE_METRICS,
              exports: [exportFile],
            }),
          ),
        Build123dArtifactError,
        "not a regular file",
      );
      assertEquals(Date.now() - started < 1_000, true);
    });
  },
});

Deno.test({
  name:
    "artifact promotion rejects a post-stat named-pipe swap and releases its queue",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withServerRoots(async ({ exportsDirectory }) => {
      const victim = `${exportsDirectory}/race.step`;
      const pipe = `${exportsDirectory}/race.pipe`;
      await Deno.writeFile(victim, FIXTURE_STEP);
      const created = await new Deno.Command("mkfifo", {
        args: [pipe],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(created.success, true);

      let swapBeforeRead = true;
      const app = new McpApp({
        name: "artifact-race-test",
        version: "test",
        transport: "stateless",
      });
      const store = new Build123dArtifactStore(
        app,
        undefined,
        exportsDirectory,
        async (path) => {
          if (swapBeforeRead) {
            await Deno.remove(path);
            await Deno.symlink(pipe, path);
          }
        },
      );
      const exportFile = {
        format: "step" as const,
        path: victim,
        bytes: FIXTURE_STEP.byteLength,
        sha256: await sha256Hex(FIXTURE_STEP),
      };
      const receipt = await createBuild123dExportExecution({
        script: "result = fixture",
        formats: ["step"],
        name: "race",
        metrics: FIXTURE_METRICS,
        exports: [exportFile],
      });

      const started = Date.now();
      await assertRejects(
        () => store.publishExports([exportFile], receipt),
        Build123dArtifactError,
        "could not be read before promotion completed",
      );
      assertEquals(Date.now() - started < 1_000, true);

      swapBeforeRead = false;
      await Deno.remove(victim);
      await Deno.writeFile(victim, FIXTURE_STEP);
      const published = await store.publishExports([exportFile], receipt);
      assertEquals(published.length, 1);
    });
  },
});

Deno.test({
  name: "artifact promotion rejects a post-stat external symlink swap",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withServerRoots(async ({ root, exportsDirectory }) => {
      const victim = `${exportsDirectory}/symlink-race.step`;
      const outside = `${root}/outside.step`;
      await Deno.writeFile(victim, FIXTURE_STEP);
      // The external file deliberately has the declared digest: this proves
      // containment, rather than a later digest mismatch, rejects the swap.
      await Deno.writeFile(outside, FIXTURE_STEP);
      const app = new McpApp({
        name: "artifact-symlink-race-test",
        version: "test",
        transport: "stateless",
      });
      const store = new Build123dArtifactStore(
        app,
        undefined,
        exportsDirectory,
        async (path) => {
          await Deno.remove(path);
          await Deno.symlink(outside, path);
        },
      );
      const exportFile = {
        format: "step" as const,
        path: victim,
        bytes: FIXTURE_STEP.byteLength,
        sha256: await sha256Hex(FIXTURE_STEP),
      };
      const receipt = await createBuild123dExportExecution({
        script: "result = fixture",
        formats: ["step"],
        name: "symlink-race",
        metrics: FIXTURE_METRICS,
        exports: [exportFile],
      });
      const started = Date.now();
      await assertRejects(
        () => store.publishExports([exportFile], receipt),
        Build123dArtifactError,
        "could not be read before promotion completed",
      );
      assertEquals(Date.now() - started < 1_000, true);
      assertEquals(
        app.getResourceInfo(
          `casys://build123d/artifacts/${exportFile.sha256}.step`,
        ),
        undefined,
      );
    });
  },
});

cadTest("hostile delivery names are made inert before promotion", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const exportHandler = assembly.toolsClient.buildHandlersMap().get(
      "build123d_export",
    );
    if (!exportHandler) throw new Error("Missing export handler");
    const result = structuredContent(
      await exportHandler({
        script: BOX_SCRIPT,
        formats: ["stl"],
        name: "../../etc/passwd",
      }),
    );
    const file = (result.files as ExportPayloadFile[])[0];
    assertEquals(file.artifact.uri.includes("passwd"), false);
    assertEquals(
      Array.from(Deno.readDirSync(exportsDirectory)).map((entry) => entry.name),
      ["passwd.stl"],
    );
  });
});

Deno.test("different export bytes receive different artifact identities", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const one = await publishFixture(
      assembly,
      exportsDirectory,
      "gltf",
      FIXTURE_GLB,
      "part-a",
    );
    const different = FIXTURE_GLB.slice();
    different[8] = 11;
    const two = await publishFixture(
      assembly,
      exportsDirectory,
      "gltf",
      different,
      "part-b",
    );
    assertEquals(
      one.artifact.sha256 === two.artifact.sha256,
      false,
    );
  });
});

Deno.test("CAD schemas, annotations and artifact result contract stay coherent", () => {
  const tools = createExecuteTools();
  const execute = tools.find((tool) => tool.name === "build123d_execute");
  const exported = tools.find((tool) => tool.name === "build123d_export");
  if (!execute || !exported) throw new Error("Missing execute or export tool");

  assertEquals(execute.annotations, {
    title: "Compute build123d geometry",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assertEquals(exported.annotations, {
    title: "Export immutable CAD artifacts",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assertEquals(execute.inputSchema.additionalProperties, false);
  assertEquals(exported.inputSchema.additionalProperties, false);
  const executeProperties = execute.inputSchema.properties as Record<
    string,
    { maximum?: number }
  >;
  const exportProperties = exported.inputSchema.properties as Record<
    string,
    { maximum?: number }
  >;
  assertEquals(executeProperties.timeout_ms.maximum, 60_000);
  assertEquals(exportProperties.timeout_ms.maximum, 60_000);
  const properties = exported.outputSchema.properties as Record<
    string,
    unknown
  >;
  const fileItems = (properties.files as {
    items: { properties: Record<string, unknown> };
  }).items;
  const artifact = fileItems.properties.artifact as {
    required: string[];
    properties: { uri: { pattern: string }; sha256: { pattern: string } };
  };
  assertEquals(artifact.required, [
    "schemaVersion",
    "uri",
    "format",
    "mimeType",
    "bytes",
    "sha256",
  ]);
  assertStringIncludes(
    artifact.properties.uri.pattern,
    "casys://build123d/artifacts",
  );
  assertEquals(artifact.properties.uri.pattern.endsWith("$"), true);
  assertEquals(artifact.properties.sha256.pattern, "^[a-f0-9]{64}$");

  const validator = new SchemaValidator();
  validator.addSchema("build123d_execute", execute.inputSchema);
  validator.addSchema("build123d_export", exported.inputSchema);
  assertEquals(
    validator.validate("build123d_execute", { script: "result = 1" }).valid,
    true,
  );
  assertEquals(
    validator.validate("build123d_execute", {
      script: "result = 1",
      unexpected: true,
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["step"],
      name: "bracket",
      timeout_ms: 60_001,
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["step", "step"],
      name: "bracket",
    }).valid,
    false,
  );
});
