/**
 * App-owned read model for canonical geometry already recorded by a Digital
 * Thread. This is deliberately distinct from the `build123d_execute` and
 * `build123d_export` result envelopes.
 */

export { VIEWER_SESSION_APPLY_ACTION } from "@casys/mcp-view-contracts";
export const BUILD123D_RECORDED_VIEW_SESSION_SCHEMA =
  "io.casys.mcp-build123d.recorded-geometry-session/1.0" as const;
export const BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA =
  "io.casys.mcp-build123d.geometry-review-session/1.0" as const;
export const BUILD123D_CANONICAL_GEOMETRY_TOOL =
  "design.write-geometry@1" as const;

export interface Build123dRecordedViewBasis {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly subjectId: string;
  readonly thread: {
    readonly id: string;
    readonly revision: number;
  };
}

export interface Build123dRecordedViewAnchor {
  readonly kind: string;
  readonly id: string;
}

export interface Build123dRecordedProducer {
  readonly serverId: string;
  /** Literal `ThreadOperationRef.tool` recorded on the Thread artifact. */
  readonly tool: string;
  readonly runId: string;
}

export interface Build123dCanonicalCaptureProvenance {
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly artifactFingerprint: `sha256:${string}`;
  readonly producer: {
    readonly serverId: string;
    readonly tool: typeof BUILD123D_CANONICAL_GEOMETRY_TOOL;
    readonly runId: string;
  };
}

export interface Build123dRecordedViewProvenance {
  /**
   * The primary `cad-model` capture sealed by design.write-geometry@1. This
   * artifact is JSON and is not the projected GLB.
   */
  readonly canonicalCapture: Build123dCanonicalCaptureProvenance;
}

export interface Build123dRecordedGltfArtifact {
  readonly artifactId: string;
  readonly artifactVersion: string;
  readonly artifactFingerprint: `sha256:${string}`;
  /** Exact preview producer recorded on the sibling GLB Thread artifact. */
  readonly producer: Build123dRecordedProducer;
}

export type Build123dRecordedGeometryProjection =
  | {
    readonly status: "available";
    readonly artifact: Build123dRecordedGltfArtifact;
    /** Exact GLB bytes registered independently with the read-only App host. */
    readonly resourceFingerprint: `sha256:${string}`;
  }
  | {
    readonly status: "unavailable";
    readonly reason: string;
  }
  | {
    readonly status: "unresolved";
    readonly reason: string;
  };

export interface Build123dRecordedViewSession {
  readonly schemaVersion: typeof BUILD123D_RECORDED_VIEW_SESSION_SCHEMA;
  readonly kind: "recorded-canonical-geometry";
  readonly basis: Build123dRecordedViewBasis;
  readonly anchor: Build123dRecordedViewAnchor;
  readonly provenance: Build123dRecordedViewProvenance;
  readonly projection: Build123dRecordedGeometryProjection;
}

export interface Build123dGeometryReviewBasis {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly subjectId: string;
}

export interface Build123dGeometryReviewAnchor {
  readonly kind: "project-review";
  readonly id: string;
  readonly revision: number;
  readonly fingerprint: `sha256:${string}`;
}

export interface Build123dGeometryReviewProvenance {
  /** Exact pre-MRTR draft capture; never canonical Thread geometry or proof. */
  readonly draftCapture: Build123dRecordedGltfArtifact;
}

/**
 * Exact read-only Project review material before an MRTR decision. This does
 * not contain a Thread basis and never grants canonical or proof authority.
 */
export interface Build123dGeometryReviewSession {
  readonly schemaVersion: typeof BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA;
  readonly kind: "project-geometry-review";
  readonly basis: Build123dGeometryReviewBasis;
  readonly anchor: Build123dGeometryReviewAnchor;
  readonly status: "provisional" | "documentary";
  readonly provenance: Build123dGeometryReviewProvenance;
  readonly projection: Build123dRecordedGeometryProjection;
}

export type Build123dViewerSession =
  | Build123dRecordedViewSession
  | Build123dGeometryReviewSession;

export type ParseBuild123dRecordedViewSession =
  | { readonly ok: true; readonly value: Build123dRecordedViewSession }
  | { readonly ok: false; readonly error: string };

export type ParseBuild123dGeometryReviewSession =
  | { readonly ok: true; readonly value: Build123dGeometryReviewSession }
  | { readonly ok: false; readonly error: string };

export type ParseBuild123dViewerSession =
  | { readonly ok: true; readonly value: Build123dViewerSession }
  | { readonly ok: false; readonly error: string };

export type LoadBuild123dRecordedGltf =
  | {
    readonly ok: true;
    readonly value: {
      readonly bytes: Uint8Array;
      readonly uri: string;
    };
  }
  | { readonly ok: false; readonly error: string };

export interface Build123dRecordedResourceResponse {
  readonly uri: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly fingerprint: string;
  readonly encoding: string;
  readonly data: string;
}

export type Build123dRecordedResourceReader = (
  fingerprint: `sha256:${string}`,
) => Promise<
  | { readonly ok: true; readonly resource: Build123dRecordedResourceResponse }
  | { readonly ok: false; readonly error: string }
>;

const MAX_RECORDED_GLTF_BYTES = 24 * 1024 * 1024;
const MAX_SESSION_STRING_LENGTH = 512;
const MAX_SESSION_IDENTIFIER_LENGTH = 256;
const MAX_REASON_CODE_LENGTH = 256;
const SHA256_FINGERPRINT = /^sha256:([a-f0-9]{64})$/;
const REASON_CODE = /^[a-z][a-z0-9._-]*$/;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_HEADER_BYTES = 8;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;
const GLB_EMBEDDED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
]);

/** Strictly parse and normalize one untrusted whole-view session payload. */
export function parseBuild123dRecordedViewSession(
  value: unknown,
): ParseBuild123dRecordedViewSession {
  if (
    !isExactRecord(value, [
      "schemaVersion",
      "kind",
      "basis",
      "anchor",
      "provenance",
      "projection",
    ])
  ) {
    return failure(
      "Recorded geometry session must contain only schemaVersion, kind, basis, anchor, provenance, and projection",
    );
  }
  if (value.schemaVersion !== BUILD123D_RECORDED_VIEW_SESSION_SCHEMA) {
    return failure(
      `Recorded geometry session schema must be ${BUILD123D_RECORDED_VIEW_SESSION_SCHEMA}`,
    );
  }
  if (value.kind !== "recorded-canonical-geometry") {
    return failure("Recorded geometry session kind is unsupported");
  }

  const basis = parseBasis(value.basis);
  if (typeof basis === "string") return failure(basis);
  const anchor = parseAnchor(value.anchor);
  if (typeof anchor === "string") return failure(anchor);
  const provenance = parseProvenance(value.provenance);
  if (typeof provenance === "string") return failure(provenance);
  const projection = parseProjection(value.projection);
  if (typeof projection === "string") return failure(projection);

  if (
    projection.status === "available" &&
    projection.artifact.artifactFingerprint !==
      projection.resourceFingerprint
  ) {
    return failure(
      "Recorded geometry resource fingerprint must match the projected GLB artifact",
    );
  }
  if (projection.status === "available") {
    const capture = provenance.canonicalCapture;
    const glb = projection.artifact;
    if (capture.artifactFingerprint === glb.artifactFingerprint) {
      return failure(
        "Recorded canonical capture and projected GLB fingerprints must be distinct",
      );
    }
    if (
      capture.artifactId === glb.artifactId &&
      capture.artifactVersion === glb.artifactVersion
    ) {
      return failure(
        "Recorded canonical capture and projected GLB artifact identities must be distinct",
      );
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
      kind: "recorded-canonical-geometry",
      basis,
      anchor,
      provenance,
      projection,
    }),
  };
}

/** Strictly parse one pre-MRTR Project geometry review payload. */
export function parseBuild123dGeometryReviewSession(
  value: unknown,
): ParseBuild123dGeometryReviewSession {
  if (
    !isExactRecord(value, [
      "schemaVersion",
      "kind",
      "basis",
      "anchor",
      "status",
      "provenance",
      "projection",
    ])
  ) {
    return failure(
      "Geometry review session must contain only schemaVersion, kind, basis, anchor, status, provenance, and projection",
    );
  }
  if (value.schemaVersion !== BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA) {
    return failure(
      `Geometry review session schema must be ${BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA}`,
    );
  }
  if (value.kind !== "project-geometry-review") {
    return failure("Geometry review session kind is unsupported");
  }
  if (value.status !== "provisional" && value.status !== "documentary") {
    return failure("Geometry review status must be provisional or documentary");
  }

  const basis = parseReviewBasis(value.basis);
  if (typeof basis === "string") return failure(basis);
  const anchor = parseReviewAnchor(value.anchor);
  if (typeof anchor === "string") return failure(anchor);
  if (anchor.revision !== basis.projectRevision) {
    return failure(
      "Geometry review anchor revision must match the exact Project basis",
    );
  }
  if (!isExactRecord(value.provenance, ["draftCapture"])) {
    return failure("Geometry review provenance is invalid");
  }
  const draftCapture = parseArtifactIdentity(value.provenance.draftCapture);
  if (typeof draftCapture === "string") {
    return failure("Geometry review draft capture identity is invalid");
  }
  const projection = parseProjection(value.projection);
  if (typeof projection === "string") return failure(projection);
  if (
    projection.status === "available" &&
    projection.artifact.artifactFingerprint !== projection.resourceFingerprint
  ) {
    return failure(
      "Geometry review resource fingerprint must match the projected GLB artifact",
    );
  }
  if (projection.status === "available") {
    if (
      draftCapture.artifactFingerprint ===
        projection.artifact.artifactFingerprint
    ) {
      return failure(
        "Geometry review draft capture and projected GLB fingerprints must be distinct",
      );
    }
    if (
      draftCapture.artifactId === projection.artifact.artifactId &&
      draftCapture.artifactVersion === projection.artifact.artifactVersion
    ) {
      return failure(
        "Geometry review draft capture and projected GLB artifact identities must be distinct",
      );
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
      kind: "project-geometry-review",
      basis,
      anchor,
      status: value.status,
      provenance: Object.freeze({ draftCapture }),
      projection,
    }),
  };
}

/** Dispatch only between the exact App-owned session schema identities. */
export function parseBuild123dViewerSession(
  value: unknown,
): ParseBuild123dViewerSession {
  if (!isRecord(value)) return failure("Build123d viewer session is invalid");
  if (value.schemaVersion === BUILD123D_RECORDED_VIEW_SESSION_SCHEMA) {
    return parseBuild123dRecordedViewSession(value);
  }
  if (value.schemaVersion === BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA) {
    return parseBuild123dGeometryReviewSession(value);
  }
  return failure("Build123d viewer session schema is unsupported");
}

/**
 * Decode, bound, validate and rehash one GLB delivered by the explicit
 * read-only App-host bridge before Three.js sees it. The App selects only the
 * registered GLB fingerprint; it never fetches a URI from its opaque-origin
 * sandbox and never calls an MCP resource or provider tool in this mode.
 */
export async function loadBuild123dRecordedGltf(
  projection: Extract<Build123dRecordedGeometryProjection, {
    readonly status: "available";
  }>,
  readResource: Build123dRecordedResourceReader,
): Promise<LoadBuild123dRecordedGltf> {
  const bridged = await readResource(projection.resourceFingerprint);
  if (!bridged.ok) return failure(bridged.error);
  const resource = bridged.resource;
  if (
    !isBrowserSafeAssetUri(resource.uri) ||
    resource.mimeType !== "model/gltf-binary" ||
    resource.fingerprint !== projection.resourceFingerprint ||
    resource.encoding !== "base64" ||
    !isNonNegativeInteger(resource.bytes) ||
    resource.bytes > MAX_RECORDED_GLTF_BYTES
  ) return failure("Recorded GLB host resource identity is invalid");

  const bytes = decodeCanonicalBase64(resource.data, resource.bytes);
  if (typeof bytes === "string") return failure(bytes);
  if (
    bytes.byteLength < GLB_HEADER_BYTES ||
    bytes.byteLength > MAX_RECORDED_GLTF_BYTES
  ) {
    return failure("Recorded GLB asset byte length is invalid");
  }

  const digestInput = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(digestInput).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput);
  const sha256 = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (`sha256:${sha256}` !== projection.resourceFingerprint) {
    return failure("Recorded GLB asset SHA-256 does not match");
  }
  const structureError = validateSelfContainedGlb(bytes);
  if (structureError) return failure(structureError);
  return { ok: true, value: { bytes, uri: resource.uri } };
}

/**
 * Accept only the strict, self-contained GLB 2.0 subset that Three.js can
 * parse without resolving another URL. One JSON chunk may be followed by one
 * embedded BIN chunk; unknown, reordered, duplicate or trailing chunks fail.
 */
function validateSelfContainedGlb(bytes: Uint8Array): string | undefined {
  if (
    bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 ||
    bytes[3] !== 0x46
  ) return "Recorded GLB asset header is invalid";
  if (uint32le(bytes, 4) !== 2) {
    return "Recorded GLB asset must use version 2";
  }
  if (uint32le(bytes, 8) !== bytes.byteLength) {
    return "Recorded GLB declared length does not match";
  }

  let offset = GLB_HEADER_BYTES;
  let chunkIndex = 0;
  let jsonChunk: Uint8Array | undefined;
  let binChunk: Uint8Array | undefined;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < GLB_CHUNK_HEADER_BYTES) {
      return "Recorded GLB has trailing bytes outside a complete chunk";
    }
    const chunkLength = uint32le(bytes, offset);
    const chunkType = uint32le(bytes, offset + 4);
    if (chunkLength % 4 !== 0) {
      return "Recorded GLB chunk length is not four-byte aligned";
    }
    const chunkStart = offset + GLB_CHUNK_HEADER_BYTES;
    const chunkEnd = chunkStart + chunkLength;
    if (chunkEnd > bytes.byteLength) {
      return "Recorded GLB chunk exceeds the declared asset bounds";
    }
    const chunk = bytes.subarray(chunkStart, chunkEnd);
    if (chunkIndex === 0 && chunkType === GLB_JSON_CHUNK) {
      if (chunkLength === 0) return "Recorded GLB JSON chunk is empty";
      jsonChunk = chunk;
    } else if (chunkIndex === 1 && chunkType === GLB_BIN_CHUNK) {
      binChunk = chunk;
    } else {
      return "Recorded GLB contains a reordered, duplicate, or unsupported chunk";
    }
    chunkIndex += 1;
    offset = chunkEnd;
  }
  if (!jsonChunk) return "Recorded GLB must start with one JSON chunk";

  let document: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(jsonChunk);
    document = JSON.parse(json);
  } catch {
    return "Recorded GLB JSON chunk is invalid";
  }
  if (!isRecord(document) || !isRecord(document.asset)) {
    return "Recorded GLB JSON document is invalid";
  }
  if (document.asset.version !== "2.0") {
    return "Recorded GLB JSON asset.version must be 2.0";
  }

  const buffers = parseEmbeddedBuffers(document.buffers, binChunk);
  if (typeof buffers === "string") return buffers;
  const bufferViews = parseEmbeddedBufferViews(
    document.bufferViews,
    buffers.declaredBytes,
  );
  if (typeof bufferViews === "string") return bufferViews;
  return validateEmbeddedImages(document.images, bufferViews);
}

function parseEmbeddedBuffers(
  value: unknown,
  binChunk: Uint8Array | undefined,
): { readonly declaredBytes: number | undefined } | string {
  if (value === undefined) {
    return binChunk === undefined
      ? { declaredBytes: undefined }
      : "Recorded GLB BIN chunk requires one embedded buffer";
  }
  if (!Array.isArray(value) || value.length > 1) {
    return "Recorded GLB must declare at most one embedded buffer";
  }
  if (value.length === 0) {
    return binChunk === undefined
      ? { declaredBytes: undefined }
      : "Recorded GLB BIN chunk requires one embedded buffer";
  }
  const buffer = value[0];
  if (!isRecord(buffer)) return "Recorded GLB buffer declaration is invalid";
  if (Object.hasOwn(buffer, "uri")) {
    return "Recorded GLB buffer URI is forbidden in offline mode";
  }
  if (!isNonNegativeInteger(buffer.byteLength)) {
    return "Recorded GLB buffer byteLength is invalid";
  }
  if (!binChunk) return "Recorded GLB embedded buffer has no BIN chunk";
  const padding = binChunk.byteLength - buffer.byteLength;
  if (padding < 0 || padding > 3) {
    return "Recorded GLB BIN chunk length does not match its buffer";
  }
  for (let index = buffer.byteLength; index < binChunk.byteLength; index++) {
    if (binChunk[index] !== 0) {
      return "Recorded GLB BIN padding is invalid";
    }
  }
  return { declaredBytes: buffer.byteLength };
}

function parseEmbeddedBufferViews(
  value: unknown,
  declaredBufferBytes: number | undefined,
): readonly Record<string, unknown>[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return "Recorded GLB bufferViews declaration is invalid";
  }
  if (declaredBufferBytes === undefined && value.length > 0) {
    return "Recorded GLB bufferViews require an embedded buffer";
  }
  const views: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) || entry.buffer !== 0 ||
      !isNonNegativeInteger(entry.byteLength) ||
      (entry.byteOffset !== undefined &&
        !isNonNegativeInteger(entry.byteOffset))
    ) return "Recorded GLB bufferView is invalid";
    const byteOffset = entry.byteOffset === undefined ? 0 : entry.byteOffset;
    if (
      (byteOffset as number) + (entry.byteLength as number) >
        (declaredBufferBytes ?? 0)
    ) return "Recorded GLB bufferView exceeds the embedded buffer";
    views.push(entry);
  }
  return views;
}

function validateEmbeddedImages(
  value: unknown,
  bufferViews: readonly Record<string, unknown>[],
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return "Recorded GLB images declaration is invalid";
  }
  for (const image of value) {
    if (!isRecord(image)) return "Recorded GLB image declaration is invalid";
    if (Object.hasOwn(image, "uri")) {
      return "Recorded GLB image URI is forbidden in offline mode";
    }
    if (
      !isNonNegativeInteger(image.bufferView) ||
      (image.bufferView as number) >= bufferViews.length ||
      typeof image.mimeType !== "string" ||
      !GLB_EMBEDDED_IMAGE_MIME_TYPES.has(image.mimeType)
    ) return "Recorded GLB embedded image declaration is invalid";
  }
  return undefined;
}

function parseBasis(value: unknown): Build123dRecordedViewBasis | string {
  if (
    !isExactRecord(value, [
      "projectId",
      "projectRevision",
      "subjectId",
      "thread",
    ])
  ) return "Recorded geometry basis is invalid";
  if (
    !isNonEmptyString(value.projectId) ||
    !isNonNegativeInteger(value.projectRevision) ||
    !isNonEmptyString(value.subjectId) ||
    !isExactRecord(value.thread, ["id", "revision"]) ||
    !isNonEmptyString(value.thread.id) ||
    !isNonNegativeInteger(value.thread.revision)
  ) return "Recorded geometry basis is invalid";
  return Object.freeze({
    projectId: value.projectId,
    projectRevision: value.projectRevision,
    subjectId: value.subjectId,
    thread: Object.freeze({
      id: value.thread.id,
      revision: value.thread.revision,
    }),
  });
}

function parseReviewBasis(
  value: unknown,
): Build123dGeometryReviewBasis | string {
  if (
    !isExactRecord(value, ["projectId", "projectRevision", "subjectId"]) ||
    !isNonEmptyString(value.projectId) ||
    !isNonNegativeInteger(value.projectRevision) ||
    !isNonEmptyString(value.subjectId)
  ) return "Geometry review Project basis is invalid";
  return Object.freeze({
    projectId: value.projectId,
    projectRevision: value.projectRevision,
    subjectId: value.subjectId,
  });
}

function parseReviewAnchor(
  value: unknown,
): Build123dGeometryReviewAnchor | string {
  if (
    !isExactRecord(value, [
      "kind",
      "id",
      "revision",
      "fingerprint",
    ]) ||
    value.kind !== "project-review" ||
    !isNonEmptyString(value.id) ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.fingerprint !== "string" ||
    !SHA256_FINGERPRINT.test(value.fingerprint)
  ) return "Geometry review anchor is invalid";
  return Object.freeze({
    kind: "project-review",
    id: value.id,
    revision: value.revision,
    fingerprint: value.fingerprint as `sha256:${string}`,
  });
}

function parseAnchor(value: unknown): Build123dRecordedViewAnchor | string {
  if (
    !isExactRecord(value, ["kind", "id"]) ||
    !isIdentifier(value.kind) || !isNonEmptyString(value.id)
  ) return "Recorded geometry anchor is invalid";
  return Object.freeze({ kind: value.kind, id: value.id });
}

function parseProvenance(
  value: unknown,
): Build123dRecordedViewProvenance | string {
  if (!isExactRecord(value, ["canonicalCapture"])) {
    return "Recorded geometry provenance is invalid";
  }
  const canonicalCapture = parseCanonicalCapture(value.canonicalCapture);
  return typeof canonicalCapture === "string"
    ? "Recorded geometry canonical capture provenance is invalid"
    : Object.freeze({ canonicalCapture });
}

function parseCanonicalCapture(
  value: unknown,
): Build123dCanonicalCaptureProvenance | string {
  const artifact = parseArtifactIdentity(value);
  if (
    typeof artifact === "string" ||
    artifact.producer.tool !== BUILD123D_CANONICAL_GEOMETRY_TOOL
  ) return "Recorded geometry canonical capture identity is invalid";
  return Object.freeze({
    ...artifact,
    producer: Object.freeze({
      ...artifact.producer,
      tool: BUILD123D_CANONICAL_GEOMETRY_TOOL,
    }),
  });
}

function parseArtifactIdentity(
  value: unknown,
): Build123dRecordedGltfArtifact | string {
  if (
    !isExactRecord(value, [
      "artifactId",
      "artifactVersion",
      "artifactFingerprint",
      "producer",
    ]) ||
    !isNonEmptyString(value.artifactId) ||
    !isNonEmptyString(value.artifactVersion) ||
    typeof value.artifactFingerprint !== "string" ||
    !SHA256_FINGERPRINT.test(value.artifactFingerprint) ||
    !isExactRecord(value.producer, ["serverId", "tool", "runId"]) ||
    !isIdentifier(value.producer.serverId) ||
    !isIdentifier(value.producer.tool) ||
    !isNonEmptyString(value.producer.runId)
  ) return "Recorded geometry artifact identity is invalid";
  return Object.freeze({
    artifactId: value.artifactId,
    artifactVersion: value.artifactVersion,
    artifactFingerprint: value.artifactFingerprint as `sha256:${string}`,
    producer: Object.freeze({
      serverId: value.producer.serverId,
      tool: value.producer.tool,
      runId: value.producer.runId,
    }),
  });
}

function parseProjection(
  value: unknown,
): Build123dRecordedGeometryProjection | string {
  if (!isRecord(value)) return "Recorded geometry projection is invalid";
  if (value.status === "available") {
    if (
      !isExactRecord(value, [
        "status",
        "artifact",
        "resourceFingerprint",
      ]) ||
      typeof value.resourceFingerprint !== "string" ||
      !SHA256_FINGERPRINT.test(value.resourceFingerprint)
    ) {
      return "Available recorded geometry projection is invalid";
    }
    const artifact = parseArtifactIdentity(value.artifact);
    return typeof artifact === "string"
      ? "Recorded geometry GLB artifact identity is invalid"
      : Object.freeze({
        status: "available" as const,
        artifact: artifact as Build123dRecordedGltfArtifact,
        resourceFingerprint: value.resourceFingerprint as `sha256:${string}`,
      });
  }
  if (value.status === "unavailable" || value.status === "unresolved") {
    if (
      !isExactRecord(value, ["status", "reason"]) ||
      typeof value.reason !== "string" ||
      value.reason.length > MAX_REASON_CODE_LENGTH ||
      !REASON_CODE.test(value.reason)
    ) return `Recorded geometry ${value.status} reason is invalid`;
    return Object.freeze({ status: value.status, reason: value.reason });
  }
  return "Recorded geometry projection status is invalid";
}

function isBrowserSafeAssetUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.glb$/.test(value)
  ) return false;
  return value.slice(1).split("/").every((segment) =>
    segment !== "." && segment !== ".."
  );
}

function decodeCanonicalBase64(
  value: unknown,
  expectedBytes: number,
): Uint8Array | string {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_RECORDED_GLTF_BYTES / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) return "Recorded GLB host resource base64 is invalid";
  try {
    const raw = atob(value);
    if (btoa(raw) !== value || raw.length !== expectedBytes) {
      return "Recorded GLB host resource byte length is invalid";
    }
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  } catch {
    return "Recorded GLB host resource base64 is invalid";
  }
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, true);
}

function failure(
  error: string,
): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= MAX_SESSION_IDENTIFIER_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_SESSION_STRING_LENGTH;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
