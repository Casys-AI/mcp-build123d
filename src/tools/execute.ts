/**
 * CAD execution tools
 *
 * `build123d_execute` runs a build123d script and reports exact geometry metrics.
 * `build123d_export` additionally writes STEP / STL / GLTF files — STEP is the
 * entry point of any FEA chain (Gmsh, CalculiX), GLB feeds 3D viewers.
 *
 * Both tools execute arbitrary Python by design: CAD-as-code means the
 * script IS the artifact. Do not expose this server to untrusted callers.
 *
 * @module lib/cad/tools/execute
 */

import type { StructuredToolResult } from "@casys/mcp-server";
import type { CadTool } from "./types.ts";
import {
  type CadExportFile,
  type CadMetrics,
  type ExportSpec,
  runCadScript,
} from "../api/python-bridge.ts";
import { RESULTS_VIEWER_URI } from "../ui/constants.ts";

const SCRIPT_DESCRIPTION =
  "build123d Python script. It must assign its final shape to a variable " +
  "named 'result' — a Part, Solid, Compound, or a BuildPart builder. " +
  "Example: with BuildPart() as p: Box(60, 40, 5)\\nresult = p";

/** Directory exports are written into — never anywhere else. */
function exportDir(): string {
  return Deno.env.get("BUILD123D_EXPORT_DIR") ?? `${Deno.cwd()}/cad-exports`;
}

/**
 * Reduce a requested file name to a safe basename: strip any directory
 * components, then restrict to a conservative character set. The extension
 * is imposed by the format, so callers cannot smuggle one in.
 */
function sanitizeBasename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";
  const stem = base.replace(/\.[a-zA-Z0-9]+$/, "");
  const safe = stem.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safe || /^\.+$/.test(safe)) {
    throw new Error(
      `[build123d_export] File name '${name}' reduces to nothing safe. ` +
        `Use letters, digits, dots, dashes and underscores.`,
    );
  }
  return safe;
}

const EXTENSIONS: Record<ExportSpec["format"], string> = {
  step: "step",
  stl: "stl",
  gltf: "glb",
};

const METRICS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "volume_mm3",
    "area_mm2",
    "center_of_mass_mm",
    "bounding_box_mm",
    "solids",
    "faces",
    "edges",
  ],
  properties: {
    volume_mm3: { type: "number" },
    area_mm2: { type: "number" },
    center_of_mass_mm: {
      type: "array",
      items: { type: "number" },
      minItems: 3,
      maxItems: 3,
    },
    bounding_box_mm: {
      type: "object",
      additionalProperties: false,
      required: ["min", "max", "size"],
      properties: {
        min: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
        max: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
        size: {
          type: "array",
          items: { type: "number" },
          minItems: 3,
          maxItems: 3,
        },
      },
    },
    solids: { type: "integer", minimum: 0 },
    faces: { type: "integer", minimum: 0 },
    edges: { type: "integer", minimum: 0 },
    density_kg_m3: { type: "number", minimum: 0 },
    mass_kg: { type: "number", minimum: 0 },
  },
} as const;

const FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "path", "bytes"],
  properties: {
    format: { type: "string", enum: ["step", "stl", "gltf"] },
    path: { type: "string" },
    bytes: { type: "integer", minimum: 0 },
  },
} as const;

const RESULT_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "metrics", "files"],
      properties: {
        schemaVersion: { const: "1.0" },
        kind: { const: "execution" },
        metrics: METRICS_SCHEMA,
        files: { type: "array", maxItems: 0, items: FILE_SCHEMA },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "metrics", "files"],
      properties: {
        schemaVersion: { const: "1.0" },
        kind: { const: "export" },
        metrics: METRICS_SCHEMA,
        files: { type: "array", items: FILE_SCHEMA },
      },
    },
  ],
} as const;

export interface GeometryStructuredContent {
  schemaVersion: "1.0";
  kind: "execution" | "export";
  metrics: CadMetrics;
  files: CadExportFile[];
}

function metricText(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Build the compact text fallback and complete app payload without leaking code. */
export function geometryToolResult(
  kind: GeometryStructuredContent["kind"],
  metrics: CadMetrics,
  files: CadExportFile[],
): StructuredToolResult {
  const action = kind === "export" ? "Geometry exported" : "Geometry computed";
  return {
    content: `${action}: ${metricText(metrics.volume_mm3)} mm³ volume; ` +
      `${metricText(metrics.area_mm2)} mm² area; ${files.length} file${
        files.length === 1 ? "" : "s"
      }.`,
    structuredContent: {
      schemaVersion: "1.0",
      kind,
      metrics,
      files,
    } satisfies GeometryStructuredContent,
  };
}

export const executeTools: CadTool[] = [
  {
    name: "build123d_execute",
    description:
      "Execute a build123d (Python) script and return exact geometry metrics " +
      "computed analytically by the OCCT kernel: volume, surface area, " +
      "center of mass, bounding box, solid/face/edge counts. Provide " +
      "density_kg_m3 to also get the mass — without it no mass is reported, " +
      "it is never guessed from a material name. The script must assign its " +
      "final shape to a variable named 'result'. Runs arbitrary Python by " +
      "design (CAD-as-code); requires python3 with build123d installed.",
    category: "execute",
    _meta: { ui: { resourceUri: RESULTS_VIEWER_URI } },
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: SCRIPT_DESCRIPTION },
        density_kg_m3: {
          type: "number",
          description:
            "Material density in kg/m³ (e.g. 2700 for aluminium 6061, 7850 " +
            "for steel). Optional — omitting it omits mass_kg from the result.",
        },
        timeout_ms: {
          type: "number",
          description: "Execution time limit in milliseconds (default 60000)",
        },
      },
      required: ["script"],
    },
    outputSchema: RESULT_OUTPUT_SCHEMA,
    handler: async (args) => {
      const { metrics } = await runCadScript(args.script as string, {
        densityKgM3: args.density_kg_m3 as number | undefined,
        timeoutMs: args.timeout_ms as number | undefined,
      });
      return geometryToolResult("execution", metrics, []);
    },
  },

  {
    name: "build123d_export",
    description:
      "Execute a build123d script and export the resulting shape. Formats: " +
      "'step' (exact BREP — the input for FEA meshing and other CAD tools), " +
      "'stl' (triangle mesh for 3D printing), 'gltf' (binary .glb for 3D " +
      "viewers). Files are written under BUILD123D_EXPORT_DIR (default " +
      "./cad-exports); the file name is reduced to a safe basename and the " +
      "extension is imposed by the format. Also returns the same metrics as " +
      "build123d_execute — the script runs once for both.",
    category: "execute",
    _meta: { ui: { resourceUri: RESULTS_VIEWER_URI } },
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: SCRIPT_DESCRIPTION },
        formats: {
          type: "array",
          items: { type: "string", enum: ["step", "stl", "gltf"] },
          minItems: 1,
          description: "One or more formats to export",
        },
        name: {
          type: "string",
          description:
            "Base file name without extension (e.g. 'bracket'). Directory " +
            "components are stripped.",
        },
        density_kg_m3: {
          type: "number",
          description: "Material density in kg/m³, for mass_kg in the metrics",
        },
        timeout_ms: {
          type: "number",
          description: "Execution time limit in milliseconds (default 60000)",
        },
      },
      required: ["script", "formats", "name"],
    },
    outputSchema: RESULT_OUTPUT_SCHEMA,
    handler: async (args) => {
      const formats = args.formats as ExportSpec["format"][];
      const basename = sanitizeBasename(args.name as string);
      const dir = exportDir();
      await Deno.mkdir(dir, { recursive: true });

      const exports: ExportSpec[] = formats.map((format) => ({
        format,
        path: `${dir}/${basename}.${EXTENSIONS[format]}`,
      }));

      const result = await runCadScript(args.script as string, {
        densityKgM3: args.density_kg_m3 as number | undefined,
        timeoutMs: args.timeout_ms as number | undefined,
        exports,
      });

      return geometryToolResult("export", result.metrics, result.exports);
    },
  },
];
