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

/** A 10×20×5 mm box: volume 1000 mm³, trivially verifiable by hand. */
const BOX_SCRIPT = `
from build123d import *
with BuildPart() as p:
    Box(10, 20, 5)
result = p
`;

// ── cad_execute ─────────────────────────────────────────────────────────────

Deno.test("cad_execute - exact analytical metrics for a known box", async () => {
  const metrics = await getHandler("cad_execute")({
    script: BOX_SCRIPT,
  }) as Record<string, unknown>;

  assertAlmostEquals(metrics.volume_mm3 as number, 1000, 1e-6);
  assertAlmostEquals(metrics.area_mm2 as number, 700, 1e-6);
  assertEquals(metrics.solids, 1);
  assertEquals(metrics.faces, 6);
  const size = (metrics.bounding_box_mm as { size: number[] }).size;
  assertAlmostEquals(size[0], 10, 1e-9);
  assertAlmostEquals(size[1], 20, 1e-9);
  assertAlmostEquals(size[2], 5, 1e-9);
});

Deno.test("cad_execute - mass appears only with an explicit density", async () => {
  const without = await getHandler("cad_execute")({
    script: BOX_SCRIPT,
  }) as Record<string, unknown>;
  // No density → no mass at all. Never guessed from anything.
  assertEquals("mass_kg" in without, false);

  const withDensity = await getHandler("cad_execute")({
    script: BOX_SCRIPT,
    density_kg_m3: 2700,
  }) as Record<string, unknown>;
  // 1000 mm³ × 2700 kg/m³ = 2.7 g
  assertAlmostEquals(withDensity.mass_kg as number, 0.0027, 1e-9);
});

Deno.test("cad_execute - a script without 'result' fails naming the defined variables", async () => {
  await assertRejects(
    async () =>
      await getHandler("cad_execute")({
        script: "from build123d import *\nsomething = 42\n",
      }),
    CadExecutionError,
    "'result'",
  );
});

Deno.test("cad_execute - a raising script reports the Python exception", async () => {
  await assertRejects(
    async () =>
      await getHandler("cad_execute")({
        script: "raise ValueError('boom from user script')",
      }),
    CadExecutionError,
    "boom from user script",
  );
});

Deno.test("cad_execute - a non-geometric result is a clear error", async () => {
  await assertRejects(
    async () =>
      await getHandler("cad_execute")({ script: "result = 42" }),
    CadExecutionError,
    "no geometry",
  );
});

// ── cad_export ──────────────────────────────────────────────────────────────

Deno.test("cad_export - writes the requested formats and returns metrics", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-test-" });
  Deno.env.set("CAD_EXPORT_DIR", dir);
  try {
    const result = await getHandler("cad_export")({
      script: BOX_SCRIPT,
      formats: ["step", "gltf"],
      name: "box",
    }) as { metrics: Record<string, unknown>; files: Array<{ path: string; bytes: number }> };

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
    Deno.env.delete("CAD_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cad_export - path traversal in the name is neutralised", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cad-test-" });
  Deno.env.set("CAD_EXPORT_DIR", dir);
  try {
    const result = await getHandler("cad_export")({
      script: BOX_SCRIPT,
      formats: ["stl"],
      name: "../../etc/passwd",
    }) as { files: Array<{ path: string }> };

    // Directory components are stripped; the file lands inside the export dir.
    assertEquals(result.files[0].path, `${dir}/passwd.stl`);
  } finally {
    Deno.env.delete("CAD_EXPORT_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cad_export - a name that reduces to nothing is rejected", async () => {
  await assertRejects(
    async () =>
      await getHandler("cad_export")({
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
  }
});
