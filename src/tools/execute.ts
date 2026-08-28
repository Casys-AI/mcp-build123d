/**
 * CAD execution tools
 *
 * `build123d_execute` runs a build123d script and reports exact geometry metrics.
 * `build123d_export` additionally writes STEP / STL / GLTF files — STEP is the
 * entry point of any FEA chain (Gmsh, CalculiX), GLB feeds 3D viewers.
 *
 * `build123d_execute` and `build123d_export` execute arbitrary Python by design:
 * CAD-as-code means the script IS the artifact. Do not expose this server to
 * untrusted callers.
 *
 * @module lib/cad/tools/execute
 */

import type { StructuredToolResult } from "@casys/mcp-server";
import type { CadTool } from "./types.ts";
import {
  Build123dArtifactError,
  type Build123dExportExecution,
  createBuild123dExportExecution,
  type PublishedCadExportFile,
} from "../artifacts.ts";
import {
  BUILD123D_MAXIMUM_SCRIPT_BYTES,
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

const MAXIMUM_EXECUTION_TIMEOUT_MS = 60_000;

function executionTimeoutMs(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > MAXIMUM_EXECUTION_TIMEOUT_MS
  ) {
    throw new Error(
      `timeout_ms must be an integer between 1 and ${MAXIMUM_EXECUTION_TIMEOUT_MS}.`,
    );
  }
  return value;
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
      "[build123d_export] File name reduces to nothing safe. " +
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

/** Promotes one mutable delivery export into a server-owned artifact resource. */
export interface ExportArtifactPublisher {
  publishExports(
    exports: readonly CadExportFile[],
    execution: Build123dExportExecution,
  ): Promise<PublishedCadExportFile[]>;
}

export interface CreateExecuteToolsOptions {
  artifactPublisher?: ExportArtifactPublisher;
  /**
   * Server-owned delivery root. This must match the root the artifact
   * publisher verifies after the Python bridge returns.
   */
  exportDirectory?: string;
}

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
    volume_mm3: { type: "number", minimum: 0 },
    area_mm2: { type: "number", minimum: 0 },
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
    density_kg_m3: { type: "number", exclusiveMinimum: 0 },
    mass_kg: { type: "number", minimum: 0 },
  },
} as const;

const FILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["format", "artifact"],
  properties: {
    format: { type: "string", enum: ["step", "stl", "gltf"] },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: [
        "schemaVersion",
        "uri",
        "format",
        "mimeType",
        "bytes",
        "sha256",
      ],
      properties: {
        schemaVersion: { const: "build123d-export-artifact/1.0" },
        uri: {
          type: "string",
          pattern:
            "^casys://build123d/artifacts/[a-f0-9]{64}\\.(step|stl|glb)$",
          description:
            "Immutable MCP resource URI. Read this URI with resources/read; never derive a host path.",
        },
        format: { type: "string", enum: ["step", "stl", "gltf"] },
        mimeType: {
          type: "string",
          enum: ["model/step", "model/stl", "model/gltf-binary"],
        },
        bytes: { type: "integer", minimum: 0 },
        sha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "SHA-256 of the exact immutable artifact bytes",
        },
      },
    },
  },
} as const;

const EXECUTION_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "metrics", "files"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "execution" },
    metrics: METRICS_SCHEMA,
    files: { type: "array", maxItems: 0, items: FILE_SCHEMA },
  },
} as const;

const EXPORT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "kind", "metrics", "files"],
  properties: {
    schemaVersion: { const: "1.0" },
    kind: { const: "export" },
    metrics: METRICS_SCHEMA,
    files: { type: "array", minItems: 1, items: FILE_SCHEMA },
  },
} as const;

export interface GeometryStructuredContent {
  schemaVersion: "1.0";
  kind: "execution" | "export";
  metrics: CadMetrics;
  files: PublishedCadExportFile[];
}

function metricText(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/** Build the compact text fallback and complete app payload without leaking code. */
export function geometryToolResult(
  kind: GeometryStructuredContent["kind"],
  metrics: CadMetrics,
  files: PublishedCadExportFile[],
): StructuredToolResult {
  const action = kind === "export" ? "Geometry exported" : "Geometry computed";
  return {
    content: `${action}: ${metricText(metrics.volume_mm3)} mm³ volume; ` +
      `${metricText(metrics.area_mm2)} mm² area.` +
      (kind === "export"
        ? " Immutable export resources are available at the returned artifact URIs."
        : ""),
    structuredContent: {
      schemaVersion: "1.0",
      kind,
      metrics,
      files,
    } satisfies GeometryStructuredContent,
  };
}

/**
 * Create the CAD-as-code tool definitions around a concrete artifact publisher.
 * The process server supplies one; direct library consumers must do the same
 * before calling build123d_export so no mutable path becomes a read surface.
 */
export function createExecuteTools(
  options: CreateExecuteToolsOptions = {},
): CadTool[] {
  const artifactPublisher = options.artifactPublisher;
  return [
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
      annotations: {
        title: "Compute build123d geometry",
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          script: {
            type: "string",
            minLength: 1,
            maxLength: BUILD123D_MAXIMUM_SCRIPT_BYTES,
            description: SCRIPT_DESCRIPTION,
          },
          density_kg_m3: {
            type: "number",
            exclusiveMinimum: 0,
            description:
              "Material density in kg/m³ (e.g. 2700 for aluminium 6061, 7850 " +
              "for steel). Optional — omitting it omits mass_kg from the result.",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: MAXIMUM_EXECUTION_TIMEOUT_MS,
            description:
              "Execution time limit in milliseconds (1–60000; default 60000)",
          },
        },
        required: ["script"],
      },
      outputSchema: EXECUTION_OUTPUT_SCHEMA,
      handler: async (args) => {
        const timeoutMs = executionTimeoutMs(args.timeout_ms);
        const { metrics } = await runCadScript(args.script as string, {
          densityKgM3: args.density_kg_m3 as number | undefined,
          timeoutMs,
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
        "viewers). The delivery files are promoted into immutable, digest-bound " +
        "MCP resources; use the returned artifact.uri with resources/read rather " +
        "than a host path. The file name is reduced to a safe basename and the " +
        "extension is imposed by the format. Also returns the same metrics as " +
        "build123d_execute — the script runs once for both.",
      category: "execute",
      annotations: {
        title: "Export immutable CAD artifacts",
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { ui: { resourceUri: RESULTS_VIEWER_URI } },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          script: {
            type: "string",
            minLength: 1,
            maxLength: BUILD123D_MAXIMUM_SCRIPT_BYTES,
            description: SCRIPT_DESCRIPTION,
          },
          formats: {
            type: "array",
            items: { type: "string", enum: ["step", "stl", "gltf"] },
            minItems: 1,
            maxItems: 3,
            uniqueItems: true,
            description: "One or more formats to export",
          },
          name: {
            type: "string",
            minLength: 1,
            maxLength: 251,
            description:
              "Base file name without extension (e.g. 'bracket'). Directory " +
              "components are stripped.",
          },
          density_kg_m3: {
            type: "number",
            exclusiveMinimum: 0,
            description:
              "Material density in kg/m³, for mass_kg in the metrics",
          },
          timeout_ms: {
            type: "integer",
            minimum: 1,
            maximum: MAXIMUM_EXECUTION_TIMEOUT_MS,
            description:
              "Execution time limit in milliseconds (1–60000; default 60000)",
          },
        },
        required: ["script", "formats", "name"],
      },
      outputSchema: EXPORT_OUTPUT_SCHEMA,
      handler: async (args) => {
        // This guard is deliberately first: the direct public catalogue must
        // not start Python or create a delivery directory without the private
        // publisher that will atomically admit immutable resources.
        if (!artifactPublisher) {
          throw new Error(
            "build123d_export requires a server-owned artifact publisher. Create the tools through createCadMcpApp().",
          );
        }
        const timeoutMs = executionTimeoutMs(args.timeout_ms);
        const script = args.script as string;
        const formats = args.formats as ExportSpec["format"][];
        const basename = sanitizeBasename(args.name as string);
        // Keep an injected application root coupled to the publisher. The
        // direct-library fallback remains environment-configurable for callers
        // that assemble their own publisher.
        const dir = options.exportDirectory ?? exportDir();
        try {
          await Deno.mkdir(dir, { recursive: true });
        } catch (error) {
          console.error(
            `[mcp-build123d] delivery staging creation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          throw new Build123dArtifactError(
            "artifact.store_unavailable",
            "Managed export delivery staging is unavailable.",
            "Fix BUILD123D_EXPORT_DIR permissions, then run build123d_export again.",
          );
        }

        const exports: ExportSpec[] = formats.map((format) => ({
          format,
          path: `${dir}/${basename}.${EXTENSIONS[format]}`,
        }));

        const densityKgM3 = args.density_kg_m3 as number | undefined;
        const result = await runCadScript(script, {
          densityKgM3,
          timeoutMs,
          exports,
        });

        const execution = await createBuild123dExportExecution({
          script,
          formats,
          name: args.name as string,
          densityKgM3,
          timeoutMs,
          metrics: result.metrics,
          exports: result.exports,
        });
        const artifacts = await artifactPublisher.publishExports(
          result.exports,
          execution,
        );
        return geometryToolResult("export", result.metrics, artifacts);
      },
    },
  ];
}

/**
 * Backward-compatible direct catalogue. `build123d_export` intentionally
 * refuses to run until it is assembled with a real artifact publisher.
 */
export const executeTools: CadTool[] = createExecuteTools();
