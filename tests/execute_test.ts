/**
 * CAD tool tests — require python3 with build123d installed (as does the
 * server itself; CI installs it). Scripts are kept minimal so OCCT runs fast.
 */

import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
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
      files: payload.files as Array<{ path: string; bytes: number }>,
    };

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.kind, "export");
    assertEquals(result.files.length, 2);
    assertEquals(result.files[0].path, `${dir}/box.step`);
    assertEquals(result.files[1].path, `${dir}/box.glb`);
    for (const file of result.files) {
      const stat = await Deno.stat(file.path);
      assertEquals(stat.size > 0, true);
      assertEquals(stat.size, file.bytes);
    }
    assertAlmostEquals(result.metrics.volume_mm3 as number, 1000, 1e-6);
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
  assertEquals(executeTools.length, 2);
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
    assertEquals(
      tool._meta?.ui?.resourceUri,
      "ui://mcp-build123d/results-viewer",
    );
    assertEquals(tool.outputSchema.oneOf instanceof Array, true);
  }
});
