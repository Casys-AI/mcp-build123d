/**
 * CAD tool tests — require python3 with build123d installed (as does the
 * server itself; CI installs it). Scripts are kept minimal so OCCT runs fast.
 */

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SchemaValidator } from "@casys/mcp-server";
import { executeTools } from "../src/tools/execute.ts";
import { CadExecutionError } from "../src/api/python-bridge.ts";

function getHandler(name: string) {
  const tool = executeTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.handler;
}

function structuredContent(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

/** A 10×20×5 mm box: volume 1000 mm³, trivially verifiable by hand. */
const BOX_SCRIPT = `
from build123d import *
with BuildPart() as p:
    Box(10, 20, 5)
result = p
`;

const OTHER_BOX_SCRIPT = `
from build123d import *
with BuildPart() as p:
    Box(20, 20, 5)
result = p
`;

const MINIMAL_GLB = new Uint8Array([
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

const STEP_FILE_NAME_TIMESTAMP_SENTINEL = "1970-01-01T00:00:00Z";
const DUMMY_SHA256 = "a".repeat(64);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

// ── build123d_execute ─────────────────────────────────────────────────────────────

Deno.test("build123d_execute - exact analytical metrics for a known box", async () => {
  const result = await getHandler("build123d_execute")({
    script: BOX_SCRIPT,
  });
  const payload = structuredContent(result);
  const metrics = payload.metrics as Record<string, unknown>;

  assertEquals(payload.schemaVersion, "1.0");
  assertEquals(payload.kind, "execution");
  assertEquals(payload.files, []);
  assertAlmostEquals(metrics.volume_mm3 as number, 1000, 1e-6);
  assertAlmostEquals(metrics.area_mm2 as number, 700, 1e-6);
  assertEquals(metrics.solids, 1);
  assertEquals(metrics.faces, 6);
  const size = (metrics.bounding_box_mm as { size: number[] }).size;
  assertAlmostEquals(size[0], 10, 1e-9);
  assertAlmostEquals(size[1], 20, 1e-9);
  assertAlmostEquals(size[2], 5, 1e-9);
});

Deno.test("build123d_execute - mass appears only with an explicit density", async () => {
  const without = structuredContent(
    await getHandler("build123d_execute")({
      script: BOX_SCRIPT,
    }),
  ).metrics as Record<string, unknown>;
  // No density → no mass at all. Never guessed from anything.
  assertEquals("mass_kg" in without, false);

  const withDensity = structuredContent(
    await getHandler("build123d_execute")({
      script: BOX_SCRIPT,
      density_kg_m3: 2700,
    }),
  ).metrics as Record<string, unknown>;
  // 1000 mm³ × 2700 kg/m³ = 2.7 g
  assertAlmostEquals(withDensity.mass_kg as number, 0.0027, 1e-9);
});

Deno.test("build123d_execute - a script without 'result' fails naming the defined variables", async () => {
  await assertRejects(
    async () =>
      await getHandler("build123d_execute")({
        script: "from build123d import *\nsomething = 42\n",
      }),
    CadExecutionError,
    "'result'",
  );
});

Deno.test("build123d_execute - a raising script reports the Python exception", async () => {
  await assertRejects(
    async () =>
      await getHandler("build123d_execute")({
        script: "raise ValueError('boom from user script')",
      }),
    CadExecutionError,
    "boom from user script",
  );
});

Deno.test("build123d_execute - a non-geometric result is a clear error", async () => {
  await assertRejects(
    async () =>
      await getHandler("build123d_execute")({ script: "result = 42" }),
    CadExecutionError,
    "no geometry",
  );
});

// ── build123d_export ──────────────────────────────────────────────────────────────

Deno.test("build123d_export - writes the requested formats and returns metrics", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-test-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const payload = structuredContent(
      await getHandler("build123d_export")({
        script: BOX_SCRIPT,
        formats: ["step", "gltf"],
        name: "box",
      }),
    );
    const result = {
      metrics: payload.metrics as Record<string, unknown>,
      files: payload.files as Array<{
        path: string;
        bytes: number;
        sha256: string;
        viewer?: { toolName: string; name: string };
      }>,
    };

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.kind, "export");
    assertEquals(result.files.length, 2);
    assertEquals(result.files[0].path, `${dir}/box.step`);
    assertEquals(result.files[1].path, `${dir}/box.glb`);
    assertEquals(result.files[0].viewer, undefined);
    assertEquals(result.files[1].viewer, {
      toolName: "build123d_export_read",
      name: "box.glb",
    });
    for (const file of result.files) {
      const stat = await Deno.stat(file.path);
      assertEquals(stat.size > 0, true);
      assertEquals(stat.size, file.bytes);
      const bytes = await Deno.readFile(file.path);
      assertEquals(file.sha256, await sha256Hex(bytes));
    }
    assertAlmostEquals(result.metrics.volume_mm3 as number, 1000, 1e-6);
    const step = await Deno.readTextFile(result.files[0].path);
    assertStringIncludes(
      step,
      `FILE_NAME('Open CASCADE Shape Model','${STEP_FILE_NAME_TIMESTAMP_SENTINEL}'`,
    );
    assertEquals(
      (step.match(/1970-01-01T00:00:00Z/g) ?? []).length,
      1,
    );
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export - STEP bytes are identical across wall-clock seconds", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-step-repro-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const exportStep = async (name: string) => {
      const payload = structuredContent(
        await getHandler("build123d_export")({
          script: BOX_SCRIPT,
          formats: ["step"],
          name,
        }),
      );
      const file = (payload.files as Array<{
        path: string;
        bytes: number;
        sha256: string;
      }>)[0];
      const bytes = await Deno.readFile(file.path);
      return { file, bytes, text: new TextDecoder().decode(bytes) };
    };

    const first = await exportStep("repro-a");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await exportStep("repro-b");

    assertEquals(first.bytes, second.bytes);
    assertEquals(first.file.sha256, second.file.sha256);
    assertEquals(first.file.bytes, first.bytes.length);
    assertEquals(first.file.sha256, await sha256Hex(first.bytes));
    assertEquals(
      (first.text.match(/1970-01-01T00:00:00Z/g) ?? []).length,
      1,
    );
    assertStringIncludes(
      first.text,
      `FILE_NAME('Open CASCADE Shape Model','${STEP_FILE_NAME_TIMESTAMP_SENTINEL}'`,
    );
    assertEquals(
      /FILE_NAME\('Open CASCADE Shape Model','\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/
        .test(first.text),
      false,
    );
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export_read - returns a bounded GLB without exposing another path", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-artifact-test-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const bytes = MINIMAL_GLB;
    await Deno.writeFile(`${dir}/assembly.glb`, bytes);
    const digest = await sha256Hex(bytes);

    const payload = structuredContent(
      await getHandler("build123d_export_read")({
        name: "assembly.glb",
        expected_sha256: digest,
      }),
    );
    assertEquals(payload, {
      schemaVersion: "1.0",
      kind: "gltf-binary",
      name: "assembly.glb",
      mimeType: "model/gltf-binary",
      bytes: bytes.length,
      base64: bytes.toBase64(),
    });

    const fallback = await getHandler("build123d_export_read")({
      name: "assembly.glb",
      expected_sha256: digest,
    });
    assertStringIncludes(fallback.content, "assembly.glb");
    assertEquals(fallback.content.includes(bytes.toBase64()), false);
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export_read - handler and function reject a missing or mismatched digest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-digest-direct-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    await Deno.writeFile(`${dir}/assembly.glb`, MINIMAL_GLB);
    const digest = await sha256Hex(MINIMAL_GLB);

    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({ name: "assembly.glb" }),
      Error,
      "expected_sha256",
    );
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "assembly.glb",
          expected_sha256: "A".repeat(64),
        }),
      Error,
      "lowercase 64-hex",
    );
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "assembly.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "does not match expected_sha256",
    );

    const ok = structuredContent(
      await getHandler("build123d_export_read")({
        name: "assembly.glb",
        expected_sha256: digest,
      }),
    );
    assertEquals(ok.bytes, MINIMAL_GLB.length);
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export_read - rejects a later export at the same basename with a stale digest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-digest-overwrite-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const first = structuredContent(
      await getHandler("build123d_export")({
        script: BOX_SCRIPT,
        formats: ["gltf"],
        name: "part",
      }),
    );
    const firstFile = (first.files as Array<{
      sha256: string;
      viewer?: { toolName: string; name: string };
    }>)[0];
    const staleDigest = firstFile.sha256;
    assertEquals(firstFile.viewer, {
      toolName: "build123d_export_read",
      name: "part.glb",
    });

    const second = structuredContent(
      await getHandler("build123d_export")({
        script: OTHER_BOX_SCRIPT,
        formats: ["gltf"],
        name: "part",
      }),
    );
    const freshDigest = (second.files as Array<{ sha256: string }>)[0].sha256;
    assertEquals(staleDigest === freshDigest, false);

    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "part.glb",
          expected_sha256: staleDigest,
        }),
      Error,
      "does not match expected_sha256",
    );

    const ok = structuredContent(
      await getHandler("build123d_export_read")({
        name: "part.glb",
        expected_sha256: freshDigest,
      }),
    );
    assertEquals(ok.name, "part.glb");
    assertEquals(ok.kind, "gltf-binary");
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export_read - rejects traversal, other formats and oversized GLB", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-artifact-test-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  Deno.env.set("BUILD123D_GLTF_MAX_BYTES", "12");
  try {
    await Deno.writeFile(`${dir}/too-large.glb`, new Uint8Array(13));
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "../secret.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "safe .glb basename",
    );
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "part.step",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "safe .glb basename",
    );
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "too-large.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "exceeds",
    );
  } finally {
    Deno.env.delete("BUILD123D_GLTF_MAX_BYTES");
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export_read - rejects a symlink escaping the export directory", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-artifact-root-" });
  const outside = await Deno.makeTempDir({ prefix: "cad-artifact-outside-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
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
    await Deno.writeFile(`${outside}/private.glb`, bytes);
    await Deno.symlink(`${outside}/private.glb`, `${dir}/linked.glb`);
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "linked.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "escapes BUILD123D_EXPORT_DIR",
    );
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("build123d_export_read - rejects wrong GLB version and declared length", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-artifact-header-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const wrongVersion = new Uint8Array([
      0x67,
      0x6c,
      0x54,
      0x46,
      1,
      0,
      0,
      0,
      12,
      0,
      0,
      0,
    ]);
    await Deno.writeFile(`${dir}/v1.glb`, wrongVersion);
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "v1.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "version 2",
    );

    const wrongLength = wrongVersion.slice();
    wrongLength[4] = 2;
    wrongLength[8] = 13;
    await Deno.writeFile(`${dir}/length.glb`, wrongLength);
    await assertRejects(
      async () =>
        await getHandler("build123d_export_read")({
          name: "length.glb",
          expected_sha256: DUMMY_SHA256,
        }),
      Error,
      "declared GLB length",
    );
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export - path traversal in the name is neutralised", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-test-" });
  Deno.env.set("BUILD123D_EXPORT_DIR", dir);
  try {
    const payload = structuredContent(
      await getHandler("build123d_export")({
        script: BOX_SCRIPT,
        formats: ["stl"],
        name: "../../etc/passwd",
      }),
    );
    const result = { files: payload.files as Array<{ path: string }> };

    // Directory components are stripped; the file lands inside the export dir.
    assertEquals(result.files[0].path, `${dir}/passwd.stl`);
  } finally {
    Deno.env.delete("BUILD123D_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("build123d_export - a name that reduces to nothing is rejected", async () => {
  await assertRejects(
    async () =>
      await getHandler("build123d_export")({
        script: BOX_SCRIPT,
        formats: ["stl"],
        name: "../..",
      }),
    Error,
    "reduces to nothing safe",
  );
});

// ── Invariants ──────────────────────────────────────────────────────────────

Deno.test("executeTools - tool count, category, schema coherence", () => {
  assertEquals(executeTools.length, 3);
  for (const tool of executeTools) {
    assertEquals(tool.category, "execute");
    const schema = tool.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    for (const field of schema.required ?? []) {
      assertEquals(
        Object.hasOwn(schema.properties, field),
        true,
        `${tool.name}: required field "${field}" missing from properties`,
      );
    }
    if (tool.name === "build123d_export_read") {
      assertEquals(tool._meta?.ui, {
        resourceUri: "ui://mcp-build123d/artifact-helper-viewer",
      });
      assertEquals(
        (tool.outputSchema.properties as { kind: { const: string } }).kind
          .const,
        "gltf-binary",
      );
      assertEquals(
        (tool.inputSchema as { additionalProperties: boolean })
          .additionalProperties,
        false,
      );
      assertEquals(
        (tool.inputSchema as { required: string[] }).required,
        ["name", "expected_sha256"],
      );
      continue;
    }
    assertEquals(
      tool._meta?.ui?.resourceUri,
      "ui://mcp-build123d/results-viewer",
    );
    const output = tool.outputSchema as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: {
        kind: { const: string };
        metrics: {
          properties: {
            volume_mm3: { minimum: number };
            area_mm2: { minimum: number };
            density_kg_m3: { exclusiveMinimum: number };
            mass_kg: { minimum: number };
          };
        };
        files: { minItems?: number; maxItems?: number };
      };
    };
    assertEquals(output.type, "object");
    assertEquals(output.additionalProperties, false);
    assertEquals(output.required, [
      "schemaVersion",
      "kind",
      "metrics",
      "files",
    ]);
    assertEquals(
      output.properties.kind.const,
      tool.name === "build123d_execute" ? "execution" : "export",
    );
    assertEquals(output.properties.metrics.properties.volume_mm3.minimum, 0);
    assertEquals(output.properties.metrics.properties.area_mm2.minimum, 0);
    assertEquals(
      output.properties.metrics.properties.density_kg_m3.exclusiveMinimum,
      0,
    );
    assertEquals(output.properties.metrics.properties.mass_kg.minimum, 0);
    if (tool.name === "build123d_execute") {
      assertEquals(output.properties.files.maxItems, 0);
      assertEquals(output.properties.files.minItems, undefined);
    } else {
      assertEquals(output.properties.files.minItems, 1);
      assertEquals(output.properties.files.maxItems, undefined);
    }
  }
});

Deno.test("execute tool input schemas reject extra properties and invalid bounds", () => {
  const execute = executeTools.find((tool) =>
    tool.name === "build123d_execute"
  );
  const exported = executeTools.find((tool) =>
    tool.name === "build123d_export"
  );
  const reader = executeTools.find((tool) =>
    tool.name === "build123d_export_read"
  );
  if (!execute || !exported || !reader) {
    throw new Error("expected execute, export and export_read tools");
  }

  type InputSchema = {
    additionalProperties: boolean;
    required: string[];
    properties: {
      script?: { type: string; minLength?: number };
      name?: { type: string; minLength?: number; maxLength?: number };
      formats?: {
        minItems: number;
        maxItems: number;
        uniqueItems: boolean;
        items: { enum: string[] };
      };
      density_kg_m3?: { exclusiveMinimum: number };
      timeout_ms?: { type: string; minimum: number };
      expected_sha256?: { pattern: string };
    };
  };

  const executeSchema = execute.inputSchema as InputSchema;
  const exportSchema = exported.inputSchema as InputSchema;
  const readSchema = reader.inputSchema as InputSchema;

  assertEquals(executeSchema.additionalProperties, false);
  assertEquals(exportSchema.additionalProperties, false);
  assertEquals(readSchema.additionalProperties, false);
  assertEquals(executeSchema.properties.script?.minLength, 1);
  assertEquals(exportSchema.properties.script?.minLength, 1);
  assertEquals(exportSchema.properties.name?.minLength, 1);
  assertEquals(exportSchema.properties.name?.maxLength, 251);
  assertEquals(exportSchema.properties.formats?.minItems, 1);
  assertEquals(exportSchema.properties.formats?.maxItems, 3);
  assertEquals(exportSchema.properties.formats?.uniqueItems, true);
  assertEquals(exportSchema.properties.formats?.items.enum, [
    "step",
    "stl",
    "gltf",
  ]);
  assertEquals(executeSchema.properties.density_kg_m3?.exclusiveMinimum, 0);
  assertEquals(exportSchema.properties.density_kg_m3?.exclusiveMinimum, 0);
  assertEquals(executeSchema.properties.timeout_ms?.type, "integer");
  assertEquals(executeSchema.properties.timeout_ms?.minimum, 1);
  assertEquals(exportSchema.properties.timeout_ms?.type, "integer");
  assertEquals(exportSchema.properties.timeout_ms?.minimum, 1);
  assertEquals(readSchema.required, ["name", "expected_sha256"]);
  assertEquals(
    readSchema.properties.expected_sha256?.pattern,
    "^[a-f0-9]{64}$",
  );

  const validator = new SchemaValidator();
  validator.addSchema("build123d_execute", execute.inputSchema);
  validator.addSchema("build123d_export", exported.inputSchema);
  validator.addSchema("build123d_export_read", reader.inputSchema);

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
    validator.validate("build123d_execute", { script: "" }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_execute", {
      script: "result = 1",
      density_kg_m3: 0,
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_execute", {
      script: "result = 1",
      timeout_ms: 0,
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_execute", {
      script: "result = 1",
      timeout_ms: 1.5,
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["step"],
      name: "bracket",
    }).valid,
    true,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["gltf"],
      name: "a".repeat(251),
    }).valid,
    true,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["gltf"],
      name: "a".repeat(252),
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: [],
      name: "bracket",
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
  assertEquals(
    validator.validate("build123d_export", {
      script: "result = 1",
      formats: ["step", "stl", "gltf", "step"],
      name: "bracket",
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export_read", { name: "assembly.glb" }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export_read", {
      name: "assembly.glb",
      expected_sha256: "A".repeat(64),
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("build123d_export_read", {
      name: "assembly.glb",
      expected_sha256: DUMMY_SHA256,
    }).valid,
    true,
  );
});
