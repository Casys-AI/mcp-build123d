import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  BUILD123D_VIEWER_SESSION_SURFACE,
  geometryFactSections,
  geometryIdentity,
  geometryProvenance,
  geometryReadings,
  geometryReference,
  geometrySurfaceOverride,
} from "../src/ui/results-viewer/src/component-model.ts";
import { parseGeometryResult } from "../src/ui/results-viewer/src/contract.ts";
import {
  BUILD123D_CANONICAL_GEOMETRY_TOOL,
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
  type Build123dRecordedGeometryProjection,
  type Build123dRecordedResourceReader,
  loadBuild123dRecordedGltf,
  parseBuild123dGeometryReviewSession,
  parseBuild123dRecordedViewSession,
  parseBuild123dViewerSession,
  VIEWER_SESSION_APPLY_ACTION,
} from "../src/ui/recorded-view-session.ts";
import {
  createMcpAppHostResourceBridge,
  MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE,
  MCP_APP_HOST_RESOURCE_READ_RESULT_TYPE,
  MCP_APP_HOST_RESOURCE_READ_SCHEMA,
  MCP_APP_HOST_RESOURCE_READ_TYPE,
} from "../src/ui/results-viewer/src/resource-bridge.ts";
import {
  BUILD123D_GEOMETRY_RESULT_SCHEMA,
  BUILD123D_MCP_APP_INFO,
  BUILD123D_VIEW_APP_MANIFEST,
  VIEW_APP_MANIFEST_SCHEMA,
} from "../src/ui/view-app-manifest.ts";
import { requireAuditedViewerSplitModules } from "../src/ui/viewer-build-config.ts";

const CAPTURE_FINGERPRINT = sha256Fingerprint("a");
const GLB_FINGERPRINT = sha256Fingerprint("b");
const DRAFT_FINGERPRINT = sha256Fingerprint("c");
const REVIEW_FINGERPRINT = sha256Fingerprint("d");

function sha256Fingerprint(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

function availableProjection(
  fingerprint: `sha256:${string}` = GLB_FINGERPRINT,
): Extract<Build123dRecordedGeometryProjection, { status: "available" }> {
  return {
    status: "available",
    artifact: {
      artifactId: `cad-asset-capture-glb-${fingerprint.slice(7)}`,
      artifactVersion: fingerprint.slice(7),
      artifactFingerprint: fingerprint,
      producer: {
        serverId: "build123d-sandbox",
        tool: "build123d_export",
        runId: "preview-run-r19",
      },
    },
    resourceFingerprint: fingerprint,
  };
}

function recordedSession(
  projection: Build123dRecordedGeometryProjection,
  captureFingerprint = CAPTURE_FINGERPRINT,
) {
  return {
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
        artifactId: `geometry-${captureFingerprint.slice(7)}`,
        artifactVersion: captureFingerprint.slice(7),
        artifactFingerprint: captureFingerprint,
        producer: {
          serverId: "digital-thread",
          tool: BUILD123D_CANONICAL_GEOMETRY_TOOL,
          runId: "geometry-run-r19",
        },
      },
    },
    projection,
  };
}

function geometryReviewSession(
  projection: Build123dRecordedGeometryProjection,
  status: "provisional" | "documentary" = "provisional",
) {
  return {
    schemaVersion: BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
    kind: "project-geometry-review",
    basis: {
      projectId: "project-tps03",
      projectRevision: 24,
      subjectId: "two-piece-tablet-stand",
    },
    anchor: {
      kind: "project-review",
      id: "review-tps03-geometry-r24",
      revision: 24,
      fingerprint: REVIEW_FINGERPRINT,
    },
    status,
    provenance: {
      draftCapture: {
        artifactId: `geometry-draft-${DRAFT_FINGERPRINT.slice(7)}`,
        artifactVersion: DRAFT_FINGERPRINT.slice(7),
        artifactFingerprint: DRAFT_FINGERPRINT,
        producer: {
          serverId: "build123d-sandbox",
          tool: "build123d_export",
          runId: "draft-run-r24",
        },
      },
    },
    projection,
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

function canonicalBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

const TEST_GLB_JSON_CHUNK = 0x4e4f534a;
const TEST_GLB_BIN_CHUNK = 0x004e4942;

function jsonChunk(value: unknown): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const padded = new Uint8Array(Math.ceil(encoded.byteLength / 4) * 4);
  padded.fill(0x20);
  padded.set(encoded);
  return padded;
}

function glbWithChunks(
  chunks: readonly { readonly type: number; readonly data: Uint8Array }[],
  trailing = new Uint8Array(),
): Uint8Array {
  const length = 12 + chunks.reduce(
    (total, chunk) => total + 8 + chunk.data.byteLength,
    0,
  ) + trailing.byteLength;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x67, 0x6c, 0x54, 0x46]);
  view.setUint32(4, 2, true);
  view.setUint32(8, length, true);
  let offset = 12;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.byteLength, true);
    view.setUint32(offset + 4, chunk.type, true);
    bytes.set(chunk.data, offset + 8);
    offset += 8 + chunk.data.byteLength;
  }
  bytes.set(trailing, offset);
  return bytes;
}

function minimalGlb(
  document: unknown = { asset: { version: "2.0" } },
): Uint8Array {
  return glbWithChunks([{
    type: TEST_GLB_JSON_CHUNK,
    data: jsonChunk(document),
  }]);
}

async function loadRecordedGlbBytes(bytes: Uint8Array) {
  const fingerprint: `sha256:${string}` = `sha256:${await sha256Hex(bytes)}`;
  return await loadBuild123dRecordedGltf(
    availableProjection(fingerprint),
    () =>
      Promise.resolve({
        ok: true as const,
        resource: {
          uri: `/api/thread/assets/${fingerprint.slice(7)}.glb`,
          mimeType: "model/gltf-binary",
          bytes: bytes.byteLength,
          fingerprint,
          encoding: "base64",
          data: canonicalBase64(bytes),
        },
      }),
  );
}

const unusedResourceReader: Build123dRecordedResourceReader = () =>
  Promise.resolve({ ok: false, error: "not used" });

Deno.test("recorded GLB loader accepts content-addressed host URIs without an extension", async () => {
  const bytes = minimalGlb();
  const fingerprint: `sha256:${string}` = `sha256:${await sha256Hex(bytes)}`;
  const path = `/api/thread/viewer-apps/resources/${fingerprint.slice(7)}`;
  for (
    const [uri, expected] of [
      [path, true],
      [`${path}.glb`, true],
      [`https://thread.invalid${path}`, false],
      [`//thread.invalid${path}`, false],
      [`${path}?download=1`, false],
      [`${path}#model`, false],
      [`${path}/`, false],
      [path.replace("/resources/", "/../resources/"), false],
      [path.replace("/resources/", "/%2e%2e/resources/"), false],
    ] as const
  ) {
    const loaded = await loadBuild123dRecordedGltf(
      availableProjection(fingerprint),
      () =>
        Promise.resolve({
          ok: true as const,
          resource: {
            uri,
            mimeType: "model/gltf-binary",
            bytes: bytes.byteLength,
            fingerprint,
            encoding: "base64",
            data: canonicalBase64(bytes),
          },
        }),
    );
    assertEquals(loaded.ok, expected, uri);
    if (loaded.ok) assertEquals(loaded.value.uri, uri);
  }
});

Deno.test("recorded geometry keeps canonical capture and projected GLB identities separate", () => {
  assertEquals(
    BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
    "io.casys.mcp-build123d.recorded-geometry-session/1.0",
  );
  const parsed = parseBuild123dRecordedViewSession(
    recordedSession(availableProjection()),
  );
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(parsed.value.kind, "recorded-canonical-geometry");
  assertEquals(parsed.value.basis.thread, { id: "thread-tps03", revision: 19 });
  assertEquals(
    parsed.value.provenance.canonicalCapture.producer.tool,
    "design.write-geometry@1",
  );
  assertEquals(
    parsed.value.provenance.canonicalCapture.artifactFingerprint,
    CAPTURE_FINGERPRINT,
  );
  assertEquals(parsed.value.projection, availableProjection());
  if (parsed.value.projection.status !== "available") return;
  assertEquals(
    parsed.value.provenance.canonicalCapture.artifactFingerprint ===
      parsed.value.projection.artifact.artifactFingerprint,
    false,
  );
});

Deno.test("recorded geometry refuses capture and GLB identity equivalence", () => {
  const sameFingerprint = parseBuild123dRecordedViewSession(
    recordedSession(availableProjection(CAPTURE_FINGERPRINT)),
  );
  assertEquals(sameFingerprint.ok, false);
  if (!sameFingerprint.ok) {
    assertStringIncludes(
      sameFingerprint.error,
      "fingerprints must be distinct",
    );
  }

  const sameArtifactIdentity = availableProjection();
  const sameIdAndVersion = {
    ...sameArtifactIdentity,
    artifact: {
      ...sameArtifactIdentity.artifact,
      artifactId: `geometry-${CAPTURE_FINGERPRINT.slice(7)}`,
      artifactVersion: CAPTURE_FINGERPRINT.slice(7),
    },
  };
  const repeatedIdentity = parseBuild123dRecordedViewSession(
    recordedSession(sameIdAndVersion),
  );
  assertEquals(repeatedIdentity.ok, false);
  if (!repeatedIdentity.ok) {
    assertStringIncludes(
      repeatedIdentity.error,
      "artifact identities must be distinct",
    );
  }
});

Deno.test("recorded geometry session keeps unavailable and unresolved literal", () => {
  for (
    const projection of [
      { status: "unavailable", reason: "asset-projection-unavailable" },
      { status: "unresolved", reason: "canonical-join-unresolved" },
    ] as const
  ) {
    const parsed = parseBuild123dRecordedViewSession(
      recordedSession(projection),
    );
    assertEquals(parsed.ok, true);
    if (!parsed.ok) continue;
    assertEquals(parsed.value.projection, projection);
    assertEquals(
      geometryIdentity({
        source: "viewer-session",
        session: parsed.value,
        readResource: unusedResourceReader,
      }).marker,
      projection.status,
    );
  }
});

Deno.test("pre-MRTR geometry review preserves exact Project review identity without Thread authority", () => {
  const parsed = parseBuild123dGeometryReviewSession(
    geometryReviewSession(availableProjection()),
  );
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(
    parsed.value.schemaVersion,
    BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  );
  assertEquals(parsed.value.kind, "project-geometry-review");
  assertEquals(parsed.value.status, "provisional");
  assertEquals(parsed.value.basis, {
    projectId: "project-tps03",
    projectRevision: 24,
    subjectId: "two-piece-tablet-stand",
  });
  assertEquals("thread" in parsed.value.basis, false);
  assertEquals(parsed.value.anchor, {
    kind: "project-review",
    id: "review-tps03-geometry-r24",
    revision: 24,
    fingerprint: REVIEW_FINGERPRINT,
  });
  assertEquals(parseBuild123dViewerSession(parsed.value), parsed);
});

Deno.test("pre-MRTR geometry review keeps documentary and unavailable literal", () => {
  const parsed = parseBuild123dGeometryReviewSession(
    geometryReviewSession(
      { status: "unavailable", reason: "draft-glb-unavailable" },
      "documentary",
    ),
  );
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(parsed.value.status, "documentary");
  assertEquals(parsed.value.projection, {
    status: "unavailable",
    reason: "draft-glb-unavailable",
  });
});

Deno.test("pre-MRTR geometry review rejects authority claims and mismatched basis", () => {
  const mismatched = geometryReviewSession(availableProjection()) as {
    anchor: { revision: number };
  };
  mismatched.anchor.revision = 23;
  assertEquals(parseBuild123dGeometryReviewSession(mismatched).ok, false);

  const authority = {
    ...geometryReviewSession(availableProjection()),
    authority: "canonical",
  };
  assertEquals(parseBuild123dGeometryReviewSession(authority).ok, false);

  const canonicalProvenance = geometryReviewSession(
    availableProjection(),
  ) as unknown as { provenance: Record<string, unknown> };
  canonicalProvenance.provenance.canonicalCapture =
    canonicalProvenance.provenance.draftCapture;
  assertEquals(
    parseBuild123dGeometryReviewSession(canonicalProvenance).ok,
    false,
  );

  const invalidStatus = {
    ...geometryReviewSession(availableProjection()),
    status: "verified",
  };
  assertEquals(parseBuild123dGeometryReviewSession(invalidStatus).ok, false);

  const sameDraftFingerprint = geometryReviewSession(
    availableProjection(DRAFT_FINGERPRINT),
  );
  assertEquals(
    parseBuild123dGeometryReviewSession(sameDraftFingerprint).ok,
    false,
  );
});

Deno.test("recorded geometry rejects authority fields, transport fields and GLB identity drift", () => {
  const payload = recordedSession(availableProjection()) as Record<
    string,
    unknown
  >;
  payload.providerEndpoint = "http://provider.internal/mcp";
  const authority = parseBuild123dRecordedViewSession(payload);
  assertEquals(authority.ok, false);
  if (!authority.ok) assertStringIncludes(authority.error, "contain only");

  const transportInSession = recordedSession({
    ...availableProjection(),
    uri: "/api/thread/assets/projected.glb",
  } as unknown as Build123dRecordedGeometryProjection);
  assertEquals(
    parseBuild123dRecordedViewSession(transportInSession).ok,
    false,
  );

  const wrongSealProducer = recordedSession(
    availableProjection(),
  ) as unknown as {
    provenance: { canonicalCapture: { producer: { tool: string } } };
  };
  wrongSealProducer.provenance.canonicalCapture.producer.tool =
    "build123d_export";
  assertEquals(parseBuild123dRecordedViewSession(wrongSealProducer).ok, false);

  const drifted = availableProjection();
  const drift = parseBuild123dRecordedViewSession(recordedSession({
    ...drifted,
    resourceFingerprint: sha256Fingerprint("c"),
  }));
  assertEquals(drift.ok, false);
  if (!drift.ok) assertStringIncludes(drift.error, "projected GLB artifact");
});

Deno.test("recorded GLB loader uses the host bridge and rehashes exact bytes", async () => {
  const bytes = minimalGlb();
  const fingerprint: `sha256:${string}` = `sha256:${await sha256Hex(bytes)}`;
  let requestedFingerprint = "";
  const loaded = await loadBuild123dRecordedGltf(
    availableProjection(fingerprint),
    (requested) => {
      requestedFingerprint = requested;
      return Promise.resolve({
        ok: true,
        resource: {
          uri: `/api/thread/assets/${fingerprint.slice(7)}.glb`,
          mimeType: "model/gltf-binary",
          bytes: bytes.byteLength,
          fingerprint,
          encoding: "base64",
          data: canonicalBase64(bytes),
        },
      });
    },
  );
  assertEquals(loaded.ok, true);
  if (loaded.ok) {
    assertEquals(loaded.value.bytes, bytes);
    assertEquals(
      loaded.value.uri,
      `/api/thread/assets/${fingerprint.slice(7)}.glb`,
    );
  }
  assertEquals(requestedFingerprint, fingerprint);

  const mismatchFingerprint = sha256Fingerprint("0");
  const mismatch = await loadBuild123dRecordedGltf(
    availableProjection(mismatchFingerprint),
    () =>
      Promise.resolve({
        ok: true,
        resource: {
          uri: "/api/thread/assets/wrong.glb",
          mimeType: "model/gltf-binary",
          bytes: bytes.byteLength,
          fingerprint: mismatchFingerprint,
          encoding: "base64",
          data: canonicalBase64(bytes),
        },
      }),
  );
  assertEquals(mismatch.ok, false);
  if (!mismatch.ok) assertStringIncludes(mismatch.error, "SHA-256");
});

Deno.test("recorded GLB loader refuses every external buffer or image URI", async () => {
  for (
    const document of [
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: 4, uri: "https://provider.invalid/mesh.bin" }],
      },
      {
        asset: { version: "2.0" },
        images: [{ uri: "data:image/png;base64,AA==" }],
      },
      {
        asset: { version: "2.0" },
        images: [{ uri: "/api/thread/assets/texture.png" }],
      },
    ]
  ) {
    const loaded = await loadRecordedGlbBytes(minimalGlb(document));
    assertEquals(loaded.ok, false);
    if (!loaded.ok) assertStringIncludes(loaded.error, "URI is forbidden");
  }
});

Deno.test("recorded GLB loader refuses embedded active image formats", async () => {
  const bytes = glbWithChunks([
    {
      type: TEST_GLB_JSON_CHUNK,
      data: jsonChunk({
        asset: { version: "2.0" },
        buffers: [{ byteLength: 4 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
        images: [{ bufferView: 0, mimeType: "image/svg+xml" }],
      }),
    },
    { type: TEST_GLB_BIN_CHUNK, data: new Uint8Array(4) },
  ]);
  const loaded = await loadRecordedGlbBytes(bytes);
  assertEquals(loaded.ok, false);
  if (!loaded.ok) {
    assertStringIncludes(loaded.error, "embedded image declaration is invalid");
  }
});

Deno.test("recorded GLB loader rejects malformed, trailing and duplicate chunks", async () => {
  const invalidJson = glbWithChunks([{
    type: TEST_GLB_JSON_CHUNK,
    data: new Uint8Array([0x7b, 0x20, 0x20, 0x20]),
  }]);
  const trailing = glbWithChunks(
    [{
      type: TEST_GLB_JSON_CHUNK,
      data: jsonChunk({ asset: { version: "2.0" } }),
    }],
    new Uint8Array(4),
  );
  const duplicateJson = glbWithChunks([
    {
      type: TEST_GLB_JSON_CHUNK,
      data: jsonChunk({ asset: { version: "2.0" } }),
    },
    {
      type: TEST_GLB_JSON_CHUNK,
      data: jsonChunk({ asset: { version: "2.0" } }),
    },
  ]);
  const duplicateBin = glbWithChunks([
    {
      type: TEST_GLB_JSON_CHUNK,
      data: jsonChunk({
        asset: { version: "2.0" },
        buffers: [{ byteLength: 0 }],
      }),
    },
    { type: TEST_GLB_BIN_CHUNK, data: new Uint8Array() },
    { type: TEST_GLB_BIN_CHUNK, data: new Uint8Array() },
  ]);
  const outOfBounds = minimalGlb().slice();
  new DataView(outOfBounds.buffer).setUint32(
    12,
    new DataView(outOfBounds.buffer).getUint32(12, true) + 4,
    true,
  );

  for (
    const [bytes, expected] of [
      [invalidJson, "JSON chunk is invalid"],
      [trailing, "trailing bytes"],
      [duplicateJson, "duplicate"],
      [duplicateBin, "duplicate"],
      [outOfBounds, "exceeds the declared asset bounds"],
    ] as const
  ) {
    const loaded = await loadRecordedGlbBytes(bytes);
    assertEquals(loaded.ok, false);
    if (!loaded.ok) assertStringIncludes(loaded.error, expected);
  }
});

Deno.test("opaque-origin resource bridge requests only a registered fingerprint", async () => {
  let portListener: ((event: MessageEvent) => void) | undefined;
  const sent: unknown[] = [];
  const offers: unknown[] = [];
  let started = false;
  let closed = false;
  let hostPortClosed = false;
  const appPort = {
    postMessage(message: unknown) {
      sent.push(message);
    },
    addEventListener(_type: string, next: (event: MessageEvent) => void) {
      portListener = next;
    },
    removeEventListener(_type: string, next: (event: MessageEvent) => void) {
      if (portListener === next) portListener = undefined;
    },
    start() {
      started = true;
    },
    close() {
      closed = true;
    },
  } as unknown as MessagePort;
  const hostPort = {
    close() {
      hostPortClosed = true;
    },
  } as MessagePort;
  const bridge = createMcpAppHostResourceBridge({
    createChannel() {
      return { port1: appPort, port2: hostPort };
    },
    offer(message, transferredPort) {
      offers.push({ message, transferredPort });
    },
  });
  assertEquals(started, true);
  assertEquals(offers, [{
    message: {
      schemaVersion: MCP_APP_HOST_RESOURCE_READ_SCHEMA,
      type: MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE,
    },
    transferredPort: hostPort,
  }]);
  const reading = bridge.read(GLB_FINGERPRINT);
  assertEquals(sent, [{
    schemaVersion: MCP_APP_HOST_RESOURCE_READ_SCHEMA,
    type: MCP_APP_HOST_RESOURCE_READ_TYPE,
    requestId: "build123d-resource-1",
    fingerprint: GLB_FINGERPRINT,
  }]);

  const response = {
    schemaVersion: MCP_APP_HOST_RESOURCE_READ_SCHEMA,
    type: MCP_APP_HOST_RESOURCE_READ_RESULT_TYPE,
    requestId: "build123d-resource-1",
    fingerprint: GLB_FINGERPRINT,
    status: "available",
    resource: {
      uri: `/api/thread/assets/${GLB_FINGERPRINT.slice(7)}.glb`,
      mimeType: "model/gltf-binary",
      bytes: 12,
      fingerprint: GLB_FINGERPRINT,
      encoding: "base64",
      data: "Z2xURgIAAAAMAAAA",
    },
  };
  portListener?.({ data: response } as MessageEvent);
  const result = await reading;
  assertEquals(result.ok, true);
  if (result.ok) assertEquals(result.resource, response.resource);
  bridge.dispose();
  assertEquals(closed, true);
  assertEquals(hostPortClosed, false);
  assertEquals(portListener, undefined);
});

Deno.test("Build123d declares a whole-view session resource without mandatory components", () => {
  assertEquals(BUILD123D_VIEW_APP_MANIFEST, {
    schemaVersion: VIEW_APP_MANIFEST_SCHEMA,
    app: {
      id: "io.casys.mcp-build123d.results",
      title: "Build123d geometry",
      version: "0.6.1",
    },
    resources: [{
      uri: "ui://mcp-build123d/results-viewer",
      ownership: "whole-view",
      resultSchemas: [BUILD123D_GEOMETRY_RESULT_SCHEMA],
      acceptedActions: [VIEWER_SESSION_APPLY_ACTION],
      sessionSchemas: [
        BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
        BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
      ],
    }],
  });
  assertEquals("components" in BUILD123D_VIEW_APP_MANIFEST.resources[0], false);
  assertEquals(
    JSON.stringify(BUILD123D_VIEW_APP_MANIFEST).includes("provider"),
    false,
  );
  assertEquals(BUILD123D_MCP_APP_INFO, {
    name: BUILD123D_VIEW_APP_MANIFEST.app.id,
    version: BUILD123D_VIEW_APP_MANIFEST.app.version,
  });
});

Deno.test("namespaced geometry result identity maps to the unchanged execution/export wire union", () => {
  assertEquals(
    BUILD123D_GEOMETRY_RESULT_SCHEMA,
    "io.casys.mcp-build123d.geometry-result/1.0",
  );
  for (const kind of ["execution", "export"] as const) {
    const digest = "d".repeat(64);
    const parsed = parseGeometryResult({
      schemaVersion: "1.0",
      kind,
      metrics: {
        volume_mm3: 1,
        area_mm2: 1,
        solids: 1,
        faces: 6,
        edges: 12,
      },
      files: kind === "execution" ? [] : [{
        format: "step",
        artifact: {
          schemaVersion: "build123d-export-artifact/1.0",
          uri: `casys://build123d/artifacts/${digest}.step`,
          format: "step",
          mimeType: "model/step",
          bytes: 1,
          sha256: digest,
        },
      }],
    });
    assertEquals(parsed.ok, true);
    if (parsed.ok) {
      assertEquals(parsed.value.schemaVersion, "1.0");
      assertEquals(parsed.value.kind, kind);
    }
  }
  assertEquals(BUILD123D_VIEW_APP_MANIFEST.resources[0].resultSchemas, [
    BUILD123D_GEOMETRY_RESULT_SCHEMA,
  ]);
});

Deno.test("direct tool results preserve host-selected surface ownership", () => {
  const parsed = parseGeometryResult({
    schemaVersion: "1.0",
    kind: "execution",
    metrics: {
      volume_mm3: 1,
      area_mm2: 1,
      solids: 1,
      faces: 6,
      edges: 12,
    },
    files: [],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  assertEquals(geometrySurfaceOverride({ result: parsed.value }), undefined);
});

Deno.test("recorded geometry owns a dedicated surface and never invents OCCT metrics", () => {
  const parsed = parseBuild123dRecordedViewSession(
    recordedSession(availableProjection()),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const data = {
    source: "viewer-session" as const,
    session: parsed.value,
    readResource: unusedResourceReader,
  };
  assertEquals(
    geometrySurfaceOverride(data),
    BUILD123D_VIEWER_SESSION_SURFACE,
  );
  assertEquals(
    BUILD123D_VIEWER_SESSION_SURFACE.components.map((item) => item.component),
    ["build123d.geometry-datasheet"],
  );
  assertEquals(geometryReadings(data), []);
  assertEquals(geometryIdentity(data), {
    marker: "recorded",
    label: "Recorded geometry projection",
    detail:
      "project-tps03 r24 · thread-tps03 r19 · part-definition:TabletStand",
    tone: "info",
  });
  assertEquals(geometryReference(data), {
    domain: "build123d",
    kind: "recorded-canonical-geometry",
    id: "part-definition:TabletStand",
    basisFingerprint: "a".repeat(64),
  });
  assertEquals(geometryProvenance(data), {
    label: "Canonical capture",
    value: CAPTURE_FINGERPRINT,
  });
  const projection = parsed.value.projection;
  if (projection.status !== "available") throw new Error(projection.status);
  const { artifactId, artifactVersion } = projection.artifact;
  const capture = parsed.value.provenance.canonicalCapture;
  assertEquals(geometryFactSections(data), [
    {
      id: "basis",
      title: "Thread basis",
      items: [
        { id: "project", label: "Project", value: "project-tps03 r24" },
        { id: "subject", label: "Subject", value: "two-piece-tablet-stand" },
        { id: "thread", label: "Thread", value: "thread-tps03 r19" },
        { id: "anchor", label: "Anchor", value: "part-definition:TabletStand" },
      ],
    },
    {
      id: "canonical-capture",
      title: "Canonical capture",
      items: [
        {
          id: "capture",
          label: "Artifact",
          value: `${capture.artifactId} · ${capture.artifactVersion}`,
        },
        {
          id: "capture-fingerprint",
          label: "Fingerprint",
          value: CAPTURE_FINGERPRINT,
        },
        {
          id: "capture-producer",
          label: "Producer",
          value: `digital-thread · ${BUILD123D_CANONICAL_GEOMETRY_TOOL}`,
        },
        { id: "capture-run", label: "Run", value: "geometry-run-r19" },
      ],
    },
    {
      id: "projection",
      title: "GLB projection",
      items: [
        { id: "projection-status", label: "Status", value: "available" },
        {
          id: "projection-artifact",
          label: "Artifact",
          value: `${artifactId} · ${artifactVersion}`,
        },
        {
          id: "projection-fingerprint",
          label: "Fingerprint",
          value: GLB_FINGERPRINT,
        },
        {
          id: "projection-producer",
          label: "Producer",
          value: "build123d-sandbox · build123d_export · preview-run-r19",
        },
      ],
    },
  ]);
});

Deno.test("an unresolved projection is stated as status and reason, never as a GLB", () => {
  const parsed = parseBuild123dRecordedViewSession(
    recordedSession({
      status: "unresolved",
      reason: "canonical-join-unresolved",
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const data = {
    source: "viewer-session" as const,
    session: parsed.value,
    readResource: unusedResourceReader,
  };
  const sections = geometryFactSections(data);
  assertEquals(sections.map((section) => section.title), [
    "Thread basis",
    "Canonical capture",
    "GLB projection",
  ]);
  assertEquals(sections[2].items, [
    { id: "projection-status", label: "Status", value: "unresolved" },
    {
      id: "projection-reason",
      label: "Reason",
      value: "canonical-join-unresolved",
    },
  ]);
  // Identity and provenance follow the canonical capture, not the projection.
  assertEquals(geometryReference(data).basisFingerprint, "a".repeat(64));
  assertEquals(geometryProvenance(data)?.value, CAPTURE_FINGERPRINT);
});

Deno.test("pre-MRTR review surface stays provisional and omits canonical metrics", () => {
  const parsed = parseBuild123dGeometryReviewSession(
    geometryReviewSession(availableProjection()),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  const data = {
    source: "viewer-session" as const,
    session: parsed.value,
    readResource: unusedResourceReader,
  };
  assertEquals(
    geometrySurfaceOverride(data),
    BUILD123D_VIEWER_SESSION_SURFACE,
  );
  assertEquals(geometryReadings(data), []);
  assertEquals(geometryIdentity(data), {
    marker: "provisional",
    label: "Geometry review",
    detail: "project-tps03 r24 · two-piece-tablet-stand · review r24",
    tone: "warning",
  });
  // The review anchor, not any capture, is the identity of a pre-MRTR review.
  assertEquals(geometryReference(data), {
    domain: "build123d",
    kind: "project-geometry-review",
    id: "review-tps03-geometry-r24",
    basisFingerprint: "d".repeat(64),
  });
  assertEquals(geometryProvenance(data), {
    label: "Review anchor",
    value: REVIEW_FINGERPRINT,
  });
  const draft = parsed.value.provenance.draftCapture;
  const sections = geometryFactSections(data);
  assertEquals(sections.map((section) => section.title), [
    "Project basis",
    "Draft capture",
    "GLB projection",
  ]);
  assertEquals(sections[0].items, [
    { id: "project", label: "Project", value: "project-tps03 r24" },
    { id: "subject", label: "Subject", value: "two-piece-tablet-stand" },
    {
      id: "review",
      label: "Review",
      value: "review-tps03-geometry-r24 · r24",
    },
    { id: "status", label: "Status", value: "provisional" },
  ]);
  assertEquals(sections[1].items, [
    {
      id: "draft",
      label: "Artifact",
      value: `${draft.artifactId} · ${draft.artifactVersion}`,
    },
    { id: "draft-fingerprint", label: "Fingerprint", value: DRAFT_FINGERPRINT },
    {
      id: "draft-producer",
      label: "Producer",
      value: "build123d-sandbox · build123d_export · draft-run-r24",
    },
  ]);
  assertEquals(sections[2].items[0], {
    id: "projection-status",
    label: "Status",
    value: "available",
  });
});

Deno.test("viewer error text reaches the DOM as text nodes, never as markup", async () => {
  const main = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/main.ts", import.meta.url),
  );
  // The kit status renderer builds elements; the connect failure goes through it too.
  assertStringIncludes(main, "root.replaceChildren(renderStatusMessage(");
  assertEquals(main.includes("innerHTML"), false);
  assertEquals(main.includes("insertAdjacentHTML"), false);
  assertEquals(main.includes("dangerouslySetInnerHTML"), false);
});

Deno.test("direct viewer mounts the kit surface App with data-owned surface selection", async () => {
  const main = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/main.ts", import.meta.url),
  );
  const components = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/components.tsx", import.meta.url),
  );
  assertStringIncludes(main, "startPreactSurfaceApp(");
  assertStringIncludes(main, "surfaceFor: geometrySurfaceOverride");
  assertStringIncludes(main, "fromToolResult: geometryStateFromToolResult");
  assertStringIncludes(main, "strict: true");
  assertStringIncludes(main, "info: BUILD123D_MCP_APP_INFO");
  assertStringIncludes(main, "registry: BUILD123D_COMPONENT_REGISTRY");
  assertStringIncludes(main, 'from "@casys/mcp-view-components/preact"');
  assertEquals(main.includes("@casys/mcp-view/preact"), false);
  assertEquals(main.includes("componentCatalogCapabilities("), false);
  assertEquals(main.includes('addEventListener("hostcontextchanged"'), false);
  assertStringIncludes(components, "defaultSurface: BUILD123D_DEFAULT_SURFACE");
  assertStringIncludes(
    components,
    'from "@casys/mcp-view-components/preact"',
  );
  assertEquals(components.includes("@casys/mcp-view/preact"), false);
});

Deno.test("recorded viewer projects sessions through the kit and owns its resource bridge", async () => {
  const main = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/main.ts", import.meta.url),
  );
  const components = await Deno.readTextFile(
    new URL("../src/ui/results-viewer/src/components.tsx", import.meta.url),
  );
  const recordedContract = await Deno.readTextFile(
    new URL("../src/ui/recorded-view-session.ts", import.meta.url),
  );
  assertStringIncludes(main, "viewerSession:");
  assertStringIncludes(
    main,
    "validate: (_value: unknown): _value is unknown => true",
  );
  assertStringIncludes(main, "toState: (value) =>");
  assertStringIncludes(
    main,
    "geometryStateFromViewerSession(value, appHostResourceBridge.read)",
  );
  assertEquals(
    main.indexOf("createMcpAppHostResourceBridge({") <
      main.indexOf("startPreactSurfaceApp("),
    true,
  );
  const teardownIndex = main.indexOf("onTeardown()");
  assertEquals(teardownIndex >= 0, true);
  assertStringIncludes(
    main.slice(teardownIndex, main.indexOf("onError:", teardownIndex)),
    "appHostResourceBridge.dispose()",
  );
  assertStringIncludes(main, 'addEventListener("pagehide", onPageHide');
  assertStringIncludes(
    main,
    'globalThis.parent.postMessage(message, "*", [port])',
  );
  assertEquals(main.includes('addEventListener("message"'), false);
  assertEquals(main.includes("beginRender("), false);
  assertEquals(main.includes("commitLatestStagedRender("), false);
  assertEquals(main.includes("isCurrentRender("), false);
  assertEquals(main.includes("showStateForRender("), false);
  assertEquals(main.includes("viewerSessionActive"), false);
  assertStringIncludes(components, "loadBuild123dRecordedGltf(");
  assertStringIncludes(components, "context.app.readServerResource");
  assertStringIncludes(components, "Canonical Thread evidence");
  assertStringIncludes(
    components,
    "Interactive recorded GLB projection linked to Digital Thread geometry",
  );
  assertEquals(
    components.includes("Interactive canonical Digital Thread geometry"),
    false,
  );
  assertEquals(recordedContract.includes("fetch("), false);
  assertEquals(components.includes("fetch("), false);
});

Deno.test("viewer build fails closed without explicit audited split modules", () => {
  const missing = { get: (_name: string) => undefined };
  assertThrows(
    () => requireAuditedViewerSplitModules(missing),
    Error,
    "MCP_VIEW_MODULE is required",
  );
  assertThrows(
    () =>
      requireAuditedViewerSplitModules({
        get: (name) =>
          name === "MCP_VIEW_MODULE"
            ? "file:///audited/view/mod.ts"
            : undefined,
      }),
    Error,
    "MCP_VIEW_COMPONENTS_MODULE is required",
  );
  const modules = requireAuditedViewerSplitModules({
    get(name) {
      return name === "MCP_VIEW_MODULE"
        ? "file:///audited/view/mod.ts"
        : name === "MCP_VIEW_COMPONENTS_MODULE"
        ? "file:///audited/view-components/mod.ts"
        : undefined;
    },
  });
  assertEquals(modules, {
    core: "file:///audited/view/mod.ts",
    components: "file:///audited/view-components/mod.ts",
  });
});
