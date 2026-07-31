import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseGeometryResult } from "../src/ui/results-viewer/src/contract.ts";
import { renderViewer } from "../src/ui/results-viewer/src/render.ts";

const METRICS = {
  volume_mm3: 1000,
  area_mm2: 700,
  center_of_mass_mm: [5, 10, 2.5],
  bounding_box_mm: { min: [0, 0, 0], max: [10, 20, 5], size: [10, 20, 5] },
  solids: 1,
  faces: 6,
  edges: 12,
  density_kg_m3: 2700,
  mass_kg: 0.0027,
};

Deno.test("results viewer parses exactly the v1 execution and export envelopes", () => {
  const execution = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [],
  });
  assertEquals(execution.ok, true);
  if (!execution.ok) return;
  assertEquals(execution.value.kind, "execution");
  assertEquals(execution.value.metrics.boundingBoxMm?.size, [10, 20, 5]);

  const exported = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{ format: "step", path: "/exports/bracket.step", bytes: 4256 }],
  });
  assertEquals(exported.ok, true);
  if (!exported.ok) return;
  assertEquals(exported.value.files[0].format, "step");
});

Deno.test("results viewer rejects invalid v1 envelopes before rendering", () => {
  const wrongVersion = parseGeometryResult({ schemaVersion: "2.0" });
  assertEquals(wrongVersion.ok, false);
  if (!wrongVersion.ok) assertStringIncludes(wrongVersion.error, "version 1.0");

  const executionWithFile = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [{ format: "stl", path: "unexpected.stl", bytes: 1 }],
  });
  assertEquals(executionWithFile.ok, false);
  if (!executionWithFile.ok) {
    assertStringIncludes(executionWithFile.error, "must not contain");
  }

  const emptyExport = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [],
  });
  assertEquals(emptyExport.ok, false);
  if (!emptyExport.ok) assertStringIncludes(emptyExport.error, "at least one");
});

Deno.test("results viewer accepts signed coordinates around the origin", () => {
  const centered = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: {
      ...METRICS,
      center_of_mass_mm: [0, 0, 0],
      bounding_box_mm: {
        min: [-5, -10, -2.5],
        max: [5, 10, 2.5],
        size: [10, 20, 5],
      },
    },
    files: [],
  });
  assertEquals(centered.ok, true);
  if (!centered.ok) return;
  assertEquals(centered.value.metrics.boundingBoxMm?.min, [-5, -10, -2.5]);
});

Deno.test("results viewer escapes file paths and errors instead of injecting markup", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      path: '<img src=x onerror="alert(1)">',
      bytes: 12,
    }],
  });
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  const html = renderViewer({ phase: "ready", result: parsed.value });
  assertEquals(html.includes("<img src=x"), false);
  assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");

  const errorHtml = renderViewer({
    phase: "error",
    message: "<script>alert(1)</script>",
  });
  assertEquals(errorHtml.includes("<script>alert"), false);
  assertStringIncludes(errorHtml, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

Deno.test("results viewer exposes loading state without leaving the host busy", () => {
  assertStringIncludes(renderViewer({ phase: "loading" }), 'aria-busy="true"');
  assertStringIncludes(renderViewer({ phase: "empty" }), 'aria-busy="false"');
  assertStringIncludes(
    renderViewer({ phase: "error", message: "Nope" }),
    'aria-busy="false"',
  );
});
