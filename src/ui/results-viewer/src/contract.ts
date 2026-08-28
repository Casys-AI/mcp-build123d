/** The only result envelopes rendered by the build123d MCP App. */

export type GeometryKind = "execution" | "export";

export interface GeometryMetrics {
  volumeMm3: number;
  areaMm2: number;
  centerOfMassMm?: [number, number, number];
  boundingBoxMm?: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  solids: number;
  faces: number;
  edges: number;
  densityKgM3?: number;
  massKg?: number;
}

export interface ExportFile {
  format: "step" | "stl" | "gltf";
  artifact: ExportArtifact;
}

/** Immutable server-owned MCP resource returned by build123d_export. */
export interface ExportArtifact {
  schemaVersion: "build123d-export-artifact/1.0";
  uri: string;
  format: "step" | "stl" | "gltf";
  mimeType: "model/step" | "model/stl" | "model/gltf-binary";
  bytes: number;
  /** Lowercase SHA-256 of the exact immutable bytes. */
  sha256: string;
}

export interface GeometryResult {
  schemaVersion: "1.0";
  kind: GeometryKind;
  metrics: GeometryMetrics;
  files: ExportFile[];
}

export type ParseGeometryResult =
  | { ok: true; value: GeometryResult }
  | { ok: false; error: string };

export type DecodeGltfArtifact =
  | { ok: true; value: Uint8Array }
  | { ok: false; error: string };

const MAX_GLTF_ARTIFACT_BYTES = 24 * 1024 * 1024;

function uint32le(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    4,
  ).getUint32(0, true);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function number(
  value: unknown,
  field: string,
  integer = false,
): number | string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return `${field} must be a finite non-negative number`;
  }
  if (integer && !Number.isInteger(value)) return `${field} must be an integer`;
  return value;
}

function point(
  value: unknown,
  field: string,
  nonNegative = false,
): [number, number, number] | string {
  if (!Array.isArray(value) || value.length !== 3) {
    return `${field} must contain exactly three coordinates`;
  }
  const parsed = value.map((entry, index) => {
    if (
      typeof entry !== "number" || !Number.isFinite(entry) ||
      (nonNegative && entry < 0)
    ) {
      return `${field}[${index}] must be a finite ${
        nonNegative ? "non-negative " : ""
      }number`;
    }
    return entry;
  });
  const error = parsed.find((entry): entry is string =>
    typeof entry === "string"
  );
  return error ??
    [parsed[0] as number, parsed[1] as number, parsed[2] as number];
}

function metrics(value: unknown): GeometryMetrics | string {
  const source = record(value);
  if (!source) return "metrics must be an object";

  const volumeMm3 = number(source.volume_mm3, "metrics.volume_mm3");
  const areaMm2 = number(source.area_mm2, "metrics.area_mm2");
  const solids = number(source.solids, "metrics.solids", true);
  const faces = number(source.faces, "metrics.faces", true);
  const edges = number(source.edges, "metrics.edges", true);
  const required = [volumeMm3, areaMm2, solids, faces, edges];
  const error = required.find((entry): entry is string =>
    typeof entry === "string"
  );
  if (error) return error;

  const parsed: GeometryMetrics = {
    volumeMm3: volumeMm3 as number,
    areaMm2: areaMm2 as number,
    solids: solids as number,
    faces: faces as number,
    edges: edges as number,
  };

  if (source.center_of_mass_mm !== undefined) {
    const center = point(source.center_of_mass_mm, "metrics.center_of_mass_mm");
    if (typeof center === "string") return center;
    parsed.centerOfMassMm = center;
  }
  if (source.bounding_box_mm !== undefined) {
    const box = record(source.bounding_box_mm);
    if (!box) return "metrics.bounding_box_mm must be an object";
    const min = point(box.min, "metrics.bounding_box_mm.min");
    const max = point(box.max, "metrics.bounding_box_mm.max");
    const size = point(box.size, "metrics.bounding_box_mm.size", true);
    const boxError = [min, max, size].find((entry): entry is string =>
      typeof entry === "string"
    );
    if (boxError) return boxError;
    parsed.boundingBoxMm = {
      min: min as [number, number, number],
      max: max as [number, number, number],
      size: size as [number, number, number],
    };
  }
  for (
    const [sourceKey, targetKey] of [
      ["density_kg_m3", "densityKgM3"],
      ["mass_kg", "massKg"],
    ] as const
  ) {
    if (source[sourceKey] === undefined) continue;
    const parsedNumber = number(source[sourceKey], `metrics.${sourceKey}`);
    if (typeof parsedNumber === "string") return parsedNumber;
    parsed[targetKey] = parsedNumber;
  }
  return parsed;
}

function files(value: unknown): ExportFile[] | string {
  if (!Array.isArray(value)) return "files must be an array";
  const parsed: ExportFile[] = [];
  for (const [index, entry] of value.entries()) {
    const file = record(entry);
    if (!file) return `files[${index}] must be an object`;
    if (
      file.format !== "step" && file.format !== "stl" && file.format !== "gltf"
    ) {
      return `files[${index}].format is not supported`;
    }
    const artifact = record(file.artifact);
    if (!artifact) return `files[${index}].artifact must be an object`;
    if (artifact.schemaVersion !== "build123d-export-artifact/1.0") {
      return `files[${index}].artifact has an unsupported schema version`;
    }
    const uri = artifact.uri;
    if (typeof uri !== "string") {
      return `files[${index}].artifact.uri must be an immutable build123d resource URI`;
    }
    const resourceMatch =
      /^casys:\/\/build123d\/artifacts\/([a-f0-9]{64})\.(step|stl|glb)$/
        .exec(uri);
    if (!resourceMatch) {
      return `files[${index}].artifact.uri must be an immutable build123d resource URI`;
    }
    if (artifact.format !== file.format) {
      return `files[${index}].artifact.format must match files[${index}].format`;
    }
    const expectedMime = file.format === "step"
      ? "model/step"
      : file.format === "stl"
      ? "model/stl"
      : "model/gltf-binary";
    if (artifact.mimeType !== expectedMime) {
      return `files[${index}].artifact.mimeType does not match its format`;
    }
    const bytes = number(
      artifact.bytes,
      `files[${index}].artifact.bytes`,
      true,
    );
    if (typeof bytes === "string") return bytes;
    if (
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    ) {
      return `files[${index}].artifact.sha256 must be a lowercase SHA-256 digest`;
    }
    const expectedExtension = file.format === "gltf" ? "glb" : file.format;
    if (
      resourceMatch[1] !== artifact.sha256 ||
      resourceMatch[2] !== expectedExtension
    ) {
      return `files[${index}].artifact.uri must encode the declared digest and format`;
    }
    parsed.push({
      format: file.format,
      artifact: {
        schemaVersion: "build123d-export-artifact/1.0",
        uri,
        format: file.format,
        mimeType: expectedMime,
        bytes,
        sha256: artifact.sha256,
      },
    });
  }
  return parsed;
}

/** Validate, size-check and decode an immutable GLB resource response. */
export async function decodeGltfArtifact(
  value: unknown,
  expected: ExportArtifact,
): Promise<DecodeGltfArtifact> {
  const source = record(value);
  if (
    !source || !Array.isArray(source.contents) || source.contents.length !== 1
  ) {
    return {
      ok: false,
      error: "GLB resource response must contain one artifact",
    };
  }
  const content = record(source.contents[0]);
  if (!content) return { ok: false, error: "GLB resource content is invalid" };
  if (content.uri !== expected.uri) {
    return {
      ok: false,
      error: "GLB resource URI does not match the export result",
    };
  }
  if (content.mimeType !== "model/gltf-binary") {
    return { ok: false, error: "GLB resource MIME type is invalid" };
  }
  if (
    typeof content.blob !== "string" ||
    content.blob.length > Math.ceil(MAX_GLTF_ARTIFACT_BYTES / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)
  ) {
    return { ok: false, error: "GLB resource base64 is invalid" };
  }
  try {
    const raw = atob(content.blob);
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    if (
      bytes.length !== expected.bytes || bytes.length < 12 ||
      bytes.length > MAX_GLTF_ARTIFACT_BYTES
    ) {
      return { ok: false, error: "GLB resource byte length does not match" };
    }
    if (
      bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 ||
      bytes[3] !== 0x46
    ) {
      return { ok: false, error: "GLB artifact header is invalid" };
    }
    if (uint32le(bytes, 4) !== 2) {
      return { ok: false, error: "GLB artifact must use version 2" };
    }
    if (uint32le(bytes, 8) !== bytes.length) {
      return { ok: false, error: "GLB declared length does not match" };
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (sha256 !== expected.sha256) {
      return { ok: false, error: "GLB resource SHA-256 does not match" };
    }
    return { ok: true, value: bytes };
  } catch {
    return { ok: false, error: "GLB artifact base64 cannot be decoded" };
  }
}

/** Parse and narrow the versioned server payload before it reaches rendering. */
export function parseGeometryResult(value: unknown): ParseGeometryResult {
  const source = record(value);
  if (!source) return { ok: false, error: "Result payload must be an object" };
  if (source.schemaVersion !== "1.0") {
    return {
      ok: false,
      error: "This viewer only supports result schema version 1.0",
    };
  }
  if (source.kind !== "execution" && source.kind !== "export") {
    return { ok: false, error: "Result kind must be execution or export" };
  }
  const parsedMetrics = metrics(source.metrics);
  if (typeof parsedMetrics === "string") {
    return { ok: false, error: parsedMetrics };
  }
  const parsedFiles = files(source.files);
  if (typeof parsedFiles === "string") return { ok: false, error: parsedFiles };
  if (source.kind === "execution" && parsedFiles.length !== 0) {
    return {
      ok: false,
      error: "Execution results must not contain exported files",
    };
  }
  if (source.kind === "export" && parsedFiles.length === 0) {
    return {
      ok: false,
      error: "Export results must contain at least one file",
    };
  }
  return {
    ok: true,
    value: {
      schemaVersion: "1.0",
      kind: source.kind,
      metrics: parsedMetrics,
      files: parsedFiles,
    },
  };
}
