import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  BUILD123D_CANONICAL_GEOMETRY_TOOL,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
  type Build123dRecordedResourceReader,
  parseBuild123dViewerSession,
} from "../src/ui/recorded-view-session.ts";
import {
  decodeGltfArtifact,
  type ExportArtifact,
  parseGeometryResult,
} from "../src/ui/results-viewer/src/contract.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  formatBytes,
  geometryFactSections,
  geometryIdentity,
  geometryProvenance,
  geometryReadings,
  geometryReference,
} from "../src/ui/results-viewer/src/component-model.ts";
import {
  geometryStateFromToolResult,
  geometryStateFromViewerSession,
  RESULT_REJECTED_CODE,
  SESSION_REJECTED_CODE,
  TOOL_ERROR_CODE,
} from "../src/ui/results-viewer/src/projection.ts";

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

Deno.test("results viewer publishes the datasheet default and the small component catalog", () => {
  assertEquals(BUILD123D_COMPONENT_KEYS, {
    datasheet: "build123d.geometry-datasheet",
    status: "build123d.geometry-status",
    metrics: "build123d.geometry-metrics",
    canvas: "build123d.geometry-canvas",
    artifacts: "build123d.export-artifacts",
  });
  assertEquals(BUILD123D_DEFAULT_SURFACE, {
    layout: { type: "stack", gap: "none" },
    components: [
      { id: "geometry-datasheet", component: "build123d.geometry-datasheet" },
    ],
  });
});

Deno.test("results viewer datasheet derives identity, readings, facts and provenance from the verified result", () => {
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
  const data = { result: parsed.value };
  assertEquals(geometryIdentity(data, "en-US"), {
    marker: "exported",
    label: "Exported geometry",
    detail: "build123d · 1 solid · 6 faces · 12 edges",
    tone: "success",
  });
  assertEquals(geometryReference(data), {
    domain: "build123d",
    kind: "export",
    id: "d".repeat(64),
    basisFingerprint: "d".repeat(64),
  });
  assertEquals(geometryReadings(data, "en-US"), [
    { id: "volume", label: "Volume", value: "1,000", unit: "mm³" },
    { id: "surface-area", label: "Surface", value: "700", unit: "mm²" },
    { id: "mass", label: "Mass", value: "0.0027", unit: "kg" },
    {
      id: "bounding-envelope",
      label: "Envelope",
      value: "10 × 20 × 5",
      unit: "mm",
    },
  ]);
  assertEquals(geometryFactSections(data, "en-US"), [{
    id: "geometry",
    title: "Geometry",
    items: [
      {
        id: "topology",
        label: "Topology",
        value: "1 solid · 6 faces · 12 edges",
      },
      {
        id: "bounding-box",
        label: "Bounding box",
        value: "[0, 0, 0] → [10, 20, 5] mm",
      },
      {
        id: "center-of-mass",
        label: "Center of mass",
        value: "[5, 10, 2.5] mm",
      },
      { id: "density", label: "Density", value: "2,700 kg/m³" },
    ],
  }]);
  assertEquals(geometryProvenance(data), {
    label: "GLTF · Artifact",
    value: `sha256:${"d".repeat(64)}`,
  });
});

Deno.test("results viewer formats numbers for the host locale, never the machine's", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: {
      volume_mm3: 1234.5,
      area_mm2: 1000,
      solids: 2,
      faces: 12,
      // A count past the grouping threshold proves the locale reaches formatCount.
      edges: 1200,
    },
    files: [],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const data = { result: parsed.value };
  assertEquals(
    geometryReadings(data, "de-DE").map((reading) => reading.value),
    ["1.234,5", "1.000"],
  );
  assertEquals(geometryIdentity(data, "de-DE"), {
    marker: "computed",
    label: "Computed geometry",
    detail: "build123d · 2 solids · 12 faces · 1.200 edges",
    tone: "success",
  });
  assertEquals(
    geometryFactSections(data, "en-US")[0].items[0].value,
    "2 solids · 12 faces · 1,200 edges",
  );
  assertEquals(geometryReference(data), {
    domain: "build123d",
    kind: "execution",
    id: "execution",
    basisFingerprint: undefined,
  });
  assertEquals(geometryProvenance(data), undefined);
  assertEquals(formatBytes(512, "en-US"), "512 B");
  assertEquals(formatBytes(77_000, "en-US"), "75.2 KB");
  assertEquals(formatBytes(77_000, "de-DE"), "75,2 KB");
  assertEquals(formatBytes(3 * 1024 * 1024, "en-US"), "3.0 MB");
});

function resolveLabel(
  value: string | ((locale?: string) => string),
  locale?: string,
): string {
  return typeof value === "function" ? value(locale) : value;
}

function projectedError(
  state: ReturnType<typeof geometryStateFromToolResult>,
  locale?: string,
) {
  assertEquals(state.kind, "error");
  if (state.kind !== "error") {
    throw new Error("expected an error display state");
  }
  return {
    kind: "error" as const,
    code: state.code,
    title: resolveLabel(state.title, locale),
    message: resolveLabel(state.message, locale),
    titleKind: typeof state.title,
    messageKind: typeof state.message,
  };
}

Deno.test("a tool error projects the MCP text block as a computation failure", () => {
  const state = geometryStateFromToolResult({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  });
  assertEquals(projectedError(state), {
    kind: "error",
    code: TOOL_ERROR_CODE,
    message: "boom",
    title: "Computation failed",
    titleKind: "function",
    messageKind: "string",
  });
  assertEquals(projectedError(state, "fr").title, "Échec du calcul");
  assertEquals(projectedError(state, "fr").message, "boom");
});

Deno.test("a tool error without a text block uses the default computation-failed message", () => {
  const state = geometryStateFromToolResult({ isError: true });
  assertEquals(projectedError(state), {
    kind: "error",
    code: TOOL_ERROR_CODE,
    message: "The build123d computation returned an error.",
    title: "Computation failed",
    titleKind: "function",
    messageKind: "function",
  });
  assertEquals(
    projectedError(state, "fr").message,
    "Le calcul build123d a retourné une erreur.",
  );
});

Deno.test("an invalid tool envelope is rejected as not displayable", () => {
  const envelope = {
    schemaVersion: "1.0",
    kind: "export",
    metrics: METRICS,
    files: [{
      format: "gltf",
      path: "/exports/assembly.glb",
      bytes: 12,
      sha256: "b".repeat(64),
    }],
  };
  const parsed = parseGeometryResult(envelope);
  assertEquals(parsed.ok, false);
  if (parsed.ok) return;
  const state = geometryStateFromToolResult({ structuredContent: envelope });
  assertEquals(projectedError(state), {
    kind: "error",
    code: RESULT_REJECTED_CODE,
    title: "Result not displayable",
    message: parsed.error,
    titleKind: "function",
    messageKind: "string",
  });
  assertEquals(projectedError(state, "fr").title, "Résultat non affichable");
  assertEquals(projectedError(state, "fr").message, parsed.error);
});

Deno.test("a valid tool envelope projects as a geometry result", () => {
  const envelope = {
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [],
  };
  const parsed = parseGeometryResult(envelope);
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(geometryStateFromToolResult({ structuredContent: envelope }), {
    kind: "result",
    result: { result: parsed.value },
  });
});

Deno.test("an invalid viewer session is rejected", () => {
  const reader: Build123dRecordedResourceReader = () =>
    Promise.resolve({ ok: false, error: "unused" });
  const parsed = parseBuild123dViewerSession({ kind: "not-a-session" });
  assertEquals(parsed.ok, false);
  if (parsed.ok) return;
  const state = geometryStateFromViewerSession(
    { kind: "not-a-session" },
    reader,
  );
  assertEquals(projectedError(state), {
    kind: "error",
    code: SESSION_REJECTED_CODE,
    title: "Session rejected",
    message: parsed.error,
    titleKind: "function",
    messageKind: "string",
  });
  assertEquals(projectedError(state, "fr").title, "Session rejetée");
  assertEquals(projectedError(state, "fr").message, parsed.error);
});

Deno.test("a valid viewer session projects with the given resource reader", () => {
  const reader: Build123dRecordedResourceReader = () =>
    Promise.resolve({ ok: false, error: "unused" });
  const capture = `sha256:${"a".repeat(64)}` as const;
  const glb = `sha256:${"b".repeat(64)}` as const;
  const session = {
    schemaVersion: BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
    kind: "recorded-canonical-geometry",
    basis: {
      projectId: "project-tps03",
      projectRevision: 24,
      subjectId: "two-piece-tablet-stand",
      thread: { id: "thread-tps03", revision: 19 },
    },
    anchor: { kind: "part-definition", id: "TabletStand" },
    provenance: {
      canonicalCapture: {
        artifactId: `geometry-${capture.slice(7)}`,
        artifactVersion: capture.slice(7),
        artifactFingerprint: capture,
        producer: {
          serverId: "digital-thread",
          tool: BUILD123D_CANONICAL_GEOMETRY_TOOL,
          runId: "geometry-run-r19",
        },
      },
    },
    projection: {
      status: "available" as const,
      artifact: {
        artifactId: `cad-asset-capture-glb-${glb.slice(7)}`,
        artifactVersion: glb.slice(7),
        artifactFingerprint: glb,
        producer: {
          serverId: "build123d-sandbox",
          tool: "build123d_export",
          runId: "preview-run-r19",
        },
      },
      resourceFingerprint: glb,
    },
  };
  const parsed = parseBuild123dViewerSession(session);
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  const state = geometryStateFromViewerSession(session, reader);
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  assertEquals("source" in state.result, true);
  if (!("source" in state.result)) return;
  assertEquals(state.result.source, "viewer-session");
  assertEquals(state.result.readResource === reader, true);
  assertEquals(state, {
    kind: "result",
    result: {
      source: "viewer-session",
      session: parsed.value,
      readResource: reader,
    },
  });
});

Deno.test("result viewer uses the standard resource client and shared components", async () => {
  const styles = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/styles.css", import.meta.url),
  );
  const components = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/components.tsx", import.meta.url),
  );
  assertStringIncludes(styles, "container: build123d-view / inline-size");
  for (
    const shared of [
      "ArtifactRow",
      "Badge",
      "Button",
      "Card",
      "FocusedView",
      "ElementSection",
      "EmptyState",
      "KeyValueList",
      "MetricGrid",
      "SemanticElement",
      "Slot3D",
      "StateMessage",
      "Toolbar",
    ]
  ) {
    assertStringIncludes(components, shared);
  }
  assertStringIncludes(components, "readServerResource");
  assertEquals(components.includes("gltfViewerReadArguments"), false);
  assertEquals(components.includes("build123d_export_read"), false);
});

Deno.test("French interface labels preserve measurements, contract states and raw diagnostics", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: METRICS,
    files: [],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const data = { result: parsed.value };
  assertEquals(geometryIdentity(data, "fr-CA"), {
    marker: "computed",
    label: "Géométrie calculée",
    detail: "build123d · 1 solide · 6 faces · 12 arêtes",
    tone: "success",
  });
  assertEquals(geometryReadings(data, "fr")[2], {
    id: "mass",
    label: "Masse",
    value: "0,0027",
    unit: "kg",
  });
  const diagnostic = "source.unresolved <unaltered>";
  const state = geometryStateFromToolResult({
    isError: true,
    content: [{ type: "text", text: diagnostic }],
  }, { locale: "fr" });
  assertEquals(projectedError(state, "fr"), {
    kind: "error",
    title: "Échec du calcul",
    code: TOOL_ERROR_CODE,
    message: diagnostic,
    titleKind: "function",
    messageKind: "string",
  });
  assertEquals(projectedError(state).title, "Computation failed");
  assertEquals(projectedError(state).message, diagnostic);
});
