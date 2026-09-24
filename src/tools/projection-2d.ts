/** Fixed STEP-only 2D inspection projection tool. */

import type { StructuredToolResult } from "@casys/mcp-platform";
import {
  BUILD123D_ARTIFACT_URI_PREFIX,
  BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  type OwnedStepResolver,
} from "../artifacts.ts";
import {
  DRAWING_PROJECTION_ENGINE,
  DRAWING_PROJECTION_METHOD,
  DRAWING_PROJECTION_SCHEMA,
  type DrawingProjection,
  PROJECTION_2D_MAXIMUM_BASE64_CHARACTERS,
  PROJECTION_2D_MAXIMUM_STEP_BYTES,
  PROJECTION_2D_MAXIMUM_SVG_BYTES,
  PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES,
  PROJECTION_2D_MAXIMUM_VIEWS,
  projectStep2d,
} from "../api/projection-2d-bridge.ts";
import { DRAWING_VIEWER_URI } from "../ui/constants.ts";
import { DRAWING_PROJECTION_VIEW_SPECS } from "../projection-2d-view-specs.ts";
import type { CadTool } from "./types.ts";

export const PROJECTION_2D_TOOL = "build123d_project_2d" as const;

const SHA256_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
} as const;

const STEP_RESOURCE_URI_PATTERN = `^${
  BUILD123D_ARTIFACT_URI_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}[a-f0-9]{64}\\.step$`;

const INLINE_STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mimeType", "sha256", "bytes", "blob"],
  properties: {
    mimeType: { const: "model/step" },
    sha256: SHA256_SCHEMA,
    bytes: {
      type: "integer",
      minimum: 1,
      maximum: PROJECTION_2D_MAXIMUM_STEP_BYTES,
    },
    blob: {
      type: "string",
      minLength: 4,
      maxLength: PROJECTION_2D_MAXIMUM_BASE64_CHARACTERS,
      pattern:
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
      description: "Exact canonical padded base64 of the model/step bytes.",
    },
  },
} as const;

const STEP_RESOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["uri", "mimeType", "sha256", "bytes"],
  properties: {
    uri: {
      type: "string",
      pattern: STEP_RESOURCE_URI_PATTERN,
      description:
        "Canonical current-process STEP URI casys://build123d/artifacts/<sha256>.step.",
    },
    mimeType: { const: "model/step" },
    sha256: SHA256_SCHEMA,
    bytes: {
      type: "integer",
      minimum: 1,
      maximum: BUILD123D_MAXIMUM_ARTIFACT_BYTES,
    },
  },
} as const;

export const PROJECTION_2D_INPUT_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["step"],
      properties: {
        step: INLINE_STEP_SCHEMA,
        includeSection: {
          type: "boolean",
          default: false,
          description:
            "Attempt the fixed YZ section at the source envelope midpoint. It is omitted when that plane contains no face.",
        },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["stepResource"],
      properties: {
        stepResource: STEP_RESOURCE_SCHEMA,
        includeSection: {
          type: "boolean",
          default: false,
          description:
            "Attempt the fixed YZ section at the source envelope midpoint. It is omitted when that plane contains no face.",
        },
      },
    },
  ],
} as const;

const SVG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mimeType", "sha256", "bytes", "text"],
  properties: {
    mimeType: { const: "image/svg+xml" },
    sha256: SHA256_SCHEMA,
    bytes: {
      type: "integer",
      minimum: 1,
      maximum: PROJECTION_2D_MAXIMUM_SVG_BYTES,
    },
    text: {
      type: "string",
      minLength: 1,
      maxLength: PROJECTION_2D_MAXIMUM_SVG_BYTES,
      description:
        "Exact UTF-8 SVG text whose byte length and SHA-256 match this object.",
    },
  },
} as const;

const VIEW_SCHEMAS = DRAWING_PROJECTION_VIEW_SPECS.map((view) => ({
  type: "object",
  additionalProperties: false,
  required: ["id", "label", "orientation", "svg"],
  properties: {
    id: { const: view.id },
    label: { const: view.label },
    orientation: { const: view.orientation },
    svg: SVG_SCHEMA,
  },
}));

export const PROJECTION_2D_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "sourceStep",
    "engine",
    "method",
    "envelopeMm",
    "views",
  ],
  properties: {
    schemaVersion: { const: DRAWING_PROJECTION_SCHEMA },
    kind: { const: "drawing-projection" },
    sourceStep: {
      type: "object",
      additionalProperties: false,
      required: ["mimeType", "sha256", "bytes"],
      properties: {
        mimeType: { const: "model/step" },
        sha256: SHA256_SCHEMA,
        bytes: {
          type: "integer",
          minimum: 1,
          maximum: PROJECTION_2D_MAXIMUM_STEP_BYTES,
        },
      },
    },
    engine: {
      type: "object",
      additionalProperties: false,
      required: ["build123d", "ocp"],
      properties: {
        build123d: { const: DRAWING_PROJECTION_ENGINE.build123d },
        ocp: { const: DRAWING_PROJECTION_ENGINE.ocp },
      },
    },
    method: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version"],
      properties: {
        id: { const: DRAWING_PROJECTION_METHOD.id },
        version: { const: DRAWING_PROJECTION_METHOD.version },
      },
    },
    envelopeMm: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "number", exclusiveMinimum: 0 },
    },
    views: {
      type: "array",
      minItems: 4,
      maxItems: PROJECTION_2D_MAXIMUM_VIEWS,
      description:
        `Canonical top, front, right and isometric views, followed by an optional fixed section; total SVG bytes are bounded to ${PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES}.`,
      prefixItems: VIEW_SCHEMAS,
      items: false,
    },
  },
} as const;

export interface CreateProjection2dToolsOptions {
  /** Server-assembly owned STEP resolver. Never an MCP input. */
  readonly resolveOwnedStep?: OwnedStepResolver;
}

/** Create the projector. Resource form requires a current-process resolver. */
export function createProjection2dTools(
  options: CreateProjection2dToolsOptions = {},
): CadTool[] {
  return [{
    name: PROJECTION_2D_TOOL,
    description:
      "Project one exact STEP Part 21 artifact into fixed, digest-verified SVG " +
      "inspection views. Supply either digest-bound padded-base64 STEP bytes or " +
      "a current-process owned STEP resource; the forms are exclusive. The " +
      "method always returns top, front, right and isometric orthographic views. " +
      "includeSection may add the fixed mid-envelope YZ section when material " +
      "crosses that plane. There is no caller code, path, camera, plane, style or " +
      "tolerance input. This is visual inspection output without dimensions, " +
      "tolerances, a title block, manufacturing authority or a compliance verdict.",
    category: "execute",
    annotations: {
      title: "Project STEP for 2D inspection",
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: PROJECTION_2D_INPUT_SCHEMA,
    outputSchema: PROJECTION_2D_OUTPUT_SCHEMA,
    _meta: { ui: { resourceUri: DRAWING_VIEWER_URI } },
    handler: async (args): Promise<StructuredToolResult> => {
      const projection = await projectStep2d(args, {
        resolveOwnedStep: options.resolveOwnedStep,
      });
      return {
        content: projectionText(projection),
        structuredContent: projection,
      };
    },
  }];
}

/** Inline STEP works directly; owned resources require server assembly wiring. */
export const projection2dTools: CadTool[] = createProjection2dTools();

function projectionText(projection: DrawingProjection): string {
  const hasSection = projection.views.some((view) => view.id === "section-yz");
  return `2D inspection projection: ${projection.views.length} verified SVG views${
    hasSection ? ", including the fixed YZ section" : ""
  }.`;
}
