import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decodeGltfArtifact,
  parseGeometryResult,
} from "../src/ui/results-viewer/src/contract.ts";
import { renderViewer } from "../src/ui/results-viewer/src/render.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  geometryMetricValues,
  geometryStatusValue,
} from "../src/ui/results-viewer/src/component-model.ts";

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

  const gltf = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      path: "/exports/assembly.glb",
      bytes: 12,
      viewer: { toolName: "build123d_export_read", name: "assembly.glb" },
    }],
  });
  assertEquals(gltf.ok, true);
  if (!gltf.ok) return;
  assertEquals(gltf.value.files[0].viewer, {
    toolName: "build123d_export_read",
    name: "assembly.glb",
  });
});

Deno.test("results viewer publishes the small component catalog and standalone surface", () => {
  assertEquals(BUILD123D_COMPONENT_KEYS, {
    status: "build123d.geometry-status",
    metrics: "build123d.geometry-metrics",
    canvas: "build123d.geometry-canvas",
    artifacts: "build123d.export-artifacts",
  });
  assertEquals(BUILD123D_DEFAULT_SURFACE, {
    layout: { type: "stack", gap: "md" },
    components: [
      { id: "geometry-status", component: "build123d.geometry-status" },
      { id: "geometry-metrics", component: "build123d.geometry-metrics" },
      { id: "geometry-canvas", component: "build123d.geometry-canvas" },
      { id: "export-artifacts", component: "build123d.export-artifacts" },
    ],
  });
  assertEquals(
    new Set(BUILD123D_DEFAULT_SURFACE.components.map((item) => item.id)).size,
    BUILD123D_DEFAULT_SURFACE.components.length,
  );
});

Deno.test("results viewer validates and decodes only the GLB helper envelope", () => {
  const binary = new Uint8Array([
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
  const decoded = decodeGltfArtifact({
    schemaVersion: "1.0",
    kind: "gltf-binary",
    name: "assembly.glb",
    mimeType: "model/gltf-binary",
    bytes: binary.length,
    base64: binary.toBase64(),
  });
  assertEquals(decoded.ok, true);
  if (decoded.ok) assertEquals(decoded.value, binary);

  const wrongLength = decodeGltfArtifact({
    schemaVersion: "1.0",
    kind: "gltf-binary",
    name: "assembly.glb",
    mimeType: "model/gltf-binary",
    bytes: binary.length + 1,
    base64: binary.toBase64(),
  });
  assertEquals(wrongLength.ok, false);

  const wrongVersion = binary.slice();
  wrongVersion[4] = 1;
  const versionResult = decodeGltfArtifact({
    schemaVersion: "1.0",
    kind: "gltf-binary",
    name: "assembly.glb",
    mimeType: "model/gltf-binary",
    bytes: wrongVersion.length,
    base64: wrongVersion.toBase64(),
  });
  assertEquals(versionResult.ok, false);
  if (!versionResult.ok) assertStringIncludes(versionResult.error, "version 2");

  const badDeclaredLength = binary.slice();
  badDeclaredLength[8] = 13;
  const lengthResult = decodeGltfArtifact({
    schemaVersion: "1.0",
    kind: "gltf-binary",
    name: "assembly.glb",
    mimeType: "model/gltf-binary",
    bytes: badDeclaredLength.length,
    base64: badDeclaredLength.toBase64(),
  });
  assertEquals(lengthResult.ok, false);
  if (!lengthResult.ok) {
    assertStringIncludes(lengthResult.error, "declared length");
  }
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

Deno.test("results viewer lifecycle errors escape markup", () => {
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
  assertStringIncludes(
    geometryStatusValue({ result: parsed.value }).detail,
    '<img src=x onerror="alert(1)">',
  );

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

Deno.test("results viewer derives component data from the real geometry result", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      path: "/exports/assembly.glb",
      bytes: 4096,
      viewer: { toolName: "build123d_export_read", name: "assembly.glb" },
    }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  assertEquals(geometryStatusValue({ result: parsed.value }), {
    label: "EXPORTÉ",
    detail: "assembly.glb · 1 solide · 6 faces",
    tone: "success",
  });
  assertEquals(geometryMetricValues({ result: parsed.value }), [
    { id: "volume", label: "Volume", value: "1,000", unit: "mm³" },
    { id: "surface-area", label: "Surface", value: "700", unit: "mm²" },
    {
      id: "bounding-envelope",
      label: "Envelope",
      value: "10 × 20 × 5",
      unit: "mm",
    },
    {
      id: "center-of-mass",
      label: "Centre de masse",
      value: "5 × 10 × 2.5",
      unit: "mm",
    },
    {
      id: "topology",
      label: "Topologie",
      value: "1 / 6 / 12",
      detail: "solides / faces / arêtes",
    },
    { id: "mass", label: "Masse", value: "0.0027", unit: "kg" },
    { id: "density", label: "Densité", value: "2,700", unit: "kg/m³" },
  ]);
});

Deno.test("results viewer implements component surface and container layouts in CSS", async () => {
  const styles = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/styles.css", import.meta.url),
  );
  assertStringIncludes(styles, "container: build123d-view / inline-size");
  assertStringIncludes(
    styles,
    "@container build123d-view (max-width: 620px)",
  );
  assertStringIncludes(styles, ".mcp-view-surface");
  assertStringIncludes(styles, ".mcp-view-component");
  assertEquals(styles.includes("data-casys-projection"), false);
  assertEquals(styles.includes("build123d-glance"), false);
});
