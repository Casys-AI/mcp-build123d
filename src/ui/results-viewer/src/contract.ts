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
  path: string;
  bytes: number;
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
    if (typeof file.path !== "string") {
      return `files[${index}].path must be a string`;
    }
    const bytes = number(file.bytes, `files[${index}].bytes`, true);
    if (typeof bytes === "string") return bytes;
    parsed.push({ format: file.format, path: file.path, bytes });
  }
  return parsed;
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
