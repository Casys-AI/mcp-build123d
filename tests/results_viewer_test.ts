import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  decodeGltfArtifact,
  type ExportArtifact,
  parseGeometryResult,
} from "../src/ui/results-viewer/src/contract.ts";
import { renderViewer } from "../src/ui/results-viewer/src/render.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  geometryArtifactRows,
  geometryMetricValues,
  geometryObjectIdent,
  geometryObjectProvenance,
  geometryObjectReading,
  geometryObjectReference,
  geometryObjectVerdict,
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

function artifact(
  format: "step" | "stl" | "gltf",
  sha256 = "a".repeat(64),
  bytes = 4256,
): ExportArtifact {
  const extension = format === "gltf" ? "glb" : format;
  const mimeType = format === "step"
    ? "model/step"
    : format === "stl"
    ? "model/stl"
    : "model/gltf-binary";
  return {
    schemaVersion: "build123d-export-artifact/1.0",
    uri: `casys://build123d/artifacts/${sha256}.${extension}`,
    format,
    mimeType,
    bytes,
    sha256,
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

Deno.test("results viewer parses execution and immutable export envelopes", () => {
  const execution = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [],
  });
  assertEquals(execution.ok, true);
  if (!execution.ok) return;
  assertEquals(execution.value.metrics.boundingBoxMm?.size, [10, 20, 5]);

  const exported = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{ format: "step", artifact: artifact("step") }],
  });
  assertEquals(exported.ok, true);
  if (!exported.ok) return;
  assertEquals(exported.value.files[0].artifact.uri.endsWith(".step"), true);
  assertEquals(exported.value.files[0].artifact.sha256, "a".repeat(64));
});

Deno.test("results viewer rejects a mutable path-shaped or incoherent export envelope", () => {
  const legacy = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      path: "/exports/assembly.glb",
      bytes: 12,
      sha256: "b".repeat(64),
    }],
  });
  assertEquals(legacy.ok, false);
  if (!legacy.ok) assertStringIncludes(legacy.error, "artifact");

  const mismatched = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{ format: "step", artifact: artifact("gltf") }],
  });
  assertEquals(mismatched.ok, false);
  if (!mismatched.ok) assertStringIncludes(mismatched.error, "match");

  const mismatchedDigest = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "step",
      artifact: {
        ...artifact("step", "c".repeat(64)),
        sha256: "d".repeat(64),
      },
    }],
  });
  assertEquals(mismatchedDigest.ok, false);
  if (!mismatchedDigest.ok) {
    assertStringIncludes(mismatchedDigest.error, "declared digest");
  }

  const trailingUri = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "step",
      artifact: {
        ...artifact("step"),
        uri: `${artifact("step").uri}?not-an-artifact`,
      },
    }],
  });
  assertEquals(trailingUri.ok, false);
  if (!trailingUri.ok) assertStringIncludes(trailingUri.error, "resource URI");
});

Deno.test("results viewer verifies a GLB resources/read response against the returned SHA-256", async () => {
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
  const expected = artifact("gltf", await sha256Hex(binary), binary.length);
  const decoded = await decodeGltfArtifact({
    contents: [{
      uri: expected.uri,
      mimeType: expected.mimeType,
      blob: binary.toBase64(),
    }],
  }, expected);
  assertEquals(decoded.ok, true);
  if (decoded.ok) assertEquals(decoded.value, binary);

  const wrongDigest = await decodeGltfArtifact({
    contents: [{
      uri: expected.uri,
      mimeType: expected.mimeType,
      blob: binary.toBase64(),
    }],
  }, { ...expected, sha256: "0".repeat(64) });
  assertEquals(wrongDigest.ok, false);
  if (!wrongDigest.ok) assertStringIncludes(wrongDigest.error, "SHA-256");

  const wrongUri = await decodeGltfArtifact({
    contents: [{
      uri: "casys://build123d/artifacts/other.glb",
      mimeType: expected.mimeType,
      blob: binary.toBase64(),
    }],
  }, expected);
  assertEquals(wrongUri.ok, false);
  if (!wrongUri.ok) assertStringIncludes(wrongUri.error, "URI");
});

Deno.test("results viewer publishes the small component catalog and a single-object default surface", () => {
  assertEquals(BUILD123D_COMPONENT_KEYS, {
    object: "build123d.geometry-object",
    status: "build123d.geometry-status",
    metrics: "build123d.geometry-metrics",
    canvas: "build123d.geometry-canvas",
    artifacts: "build123d.export-artifacts",
  });
  assertEquals(BUILD123D_DEFAULT_SURFACE, {
    layout: { type: "stack", gap: "sm" },
    components: [
      { id: "geometry-object", component: "build123d.geometry-object" },
    ],
  });
});

Deno.test("results viewer status and metrics derive from the verified artifact result", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      artifact: artifact("gltf", "d".repeat(64), 4096),
    }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  assertEquals(geometryStatusValue({ result: parsed.value }), {
    label: "EXPORTÉ",
    detail: "SHA-256 dddddddddddd… · 1 solide · 6 faces",
    tone: "success",
  });
  assertEquals(geometryObjectReference({ result: parsed.value }), {
    domain: "cad",
    kind: "export",
    id: "d".repeat(64),
  });
  assertEquals(geometryObjectIdent({ result: parsed.value }), {
    marker: "EXPORTÉ",
    label: "Geometry export",
    detail: "SHA-256 dddddddddddd… · 1 solide · 6 faces",
  });
  assertEquals(geometryObjectReading({ result: parsed.value }), {
    id: "volume",
    label: "Volume",
    value: "1,000",
    unit: "mm³",
  });
  assertEquals(geometryObjectProvenance({ result: parsed.value }), {
    label: "SHA-256",
    value: "d".repeat(64),
  });
  assertEquals(geometryObjectVerdict({ result: parsed.value }), undefined);
  assertEquals(geometryArtifactRows({ result: parsed.value }), [{
    kind: "GLTF",
    label: `${"d".repeat(64)}.glb`,
    uri: `casys://build123d/artifacts/${"d".repeat(64)}.glb`,
    digest: "d".repeat(64),
    bytes: 4096,
  }]);
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

Deno.test("results viewer lifecycle errors remain escaped HTML", () => {
  const errorHtml = renderViewer({
    phase: "error",
    message: "<script>alert(1)</script>",
  });
  assertEquals(errorHtml.includes("<script>alert"), false);
  assertStringIncludes(errorHtml, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assertStringIncludes(renderViewer({ phase: "loading" }), 'aria-busy="true"');
  assertStringIncludes(renderViewer({ phase: "empty" }), 'aria-busy="false"');
});

Deno.test("results viewer compact object omits invented units, verdicts and verification", () => {
  const execution = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: {
      volume_mm3: 8,
      area_mm2: 24,
      solids: 1,
      faces: 6,
      edges: 12,
    },
    files: [],
  });
  if (!execution.ok) throw new Error(execution.error);
  assertEquals(geometryObjectReference({ result: execution.value }), undefined);
  assertEquals(geometryObjectIdent({ result: execution.value }), {
    marker: "CALCULÉ",
    label: "Geometry",
    detail: "1 solide · 6 faces",
  });
  assertEquals(geometryObjectReading({ result: execution.value }), {
    id: "volume",
    label: "Volume",
    value: "8",
    unit: "mm³",
  });
  assertEquals(
    geometryObjectProvenance({ result: execution.value }),
    undefined,
  );
  assertEquals(geometryObjectVerdict({ result: execution.value }), undefined);
  assertEquals(geometryArtifactRows({ result: execution.value }), []);
});

Deno.test("result viewer uses the standard resource client and shared components", async () => {
  const styles = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/styles.css", import.meta.url),
  );
  const components = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/components.tsx", import.meta.url),
  );
  assertStringIncludes(styles, "container: build123d-view / inline-size");
  assertStringIncludes(
    styles,
    '.mcp-view-semantic-element[data-density="card"] .cad-stage',
  );
  for (
    const shared of [
      "ArtifactRow",
      "Badge",
      "Button",
      "Card",
      "ElementBody",
      "ElementIdent",
      "ElementProvenance",
      "ElementReading",
      "ElementVerdict",
      "EmptyState",
      "KeyValueList",
      "MetricGrid",
      "SemanticElement",
      "StateMessage",
      "Toolbar",
    ]
  ) {
    assertStringIncludes(components, shared);
  }
  assertStringIncludes(components, 'density="card"');
  assertEquals(components.includes('density="viewer"'), false);
  assertEquals(components.includes("LimitGauge"), false);
  assertEquals(components.includes("PathBar"), false);
  assertEquals(components.includes("verification:"), false);
  assertStringIncludes(components, "readServerResource");
  assertStringIncludes(components, "mountCadScene(");
  assertEquals(components.includes("gltfViewerReadArguments"), false);
  assertEquals(components.includes("build123d_export_read"), false);
});
