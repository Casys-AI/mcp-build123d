/** Fixed STEP-only OCCT/XCAF assembly-integrity observation tool. */

import type { StructuredToolResult } from "@casys/mcp-server";
import {
  ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS,
  ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES,
  ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS,
  ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
  ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA,
  ASSEMBLY_INTEGRITY_PRODUCER,
  type AssemblyIntegrityObservation,
  observeAssemblyIntegrity,
  OCCT_ASSEMBLY_INTEGRITY_METHOD,
} from "../api/assembly-integrity-bridge.ts";
import type { CadTool } from "./types.ts";

export const ASSEMBLY_INTEGRITY_TOOL = "build123d_observe_assembly_integrity";

const SHA256_SCHEMA = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
} as const;

const UNRESOLVED_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reason"],
  properties: {
    status: { const: "unresolved" },
    reason: { enum: ["identity-missing", "observability-missing"] },
  },
} as const;

const UNAVAILABLE_FACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "reason"],
  properties: {
    status: { const: "unavailable" },
    reason: { const: "unsupported" },
  },
} as const;

function factSchema(value: Record<string, unknown>): Record<string, unknown> {
  return {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "value"],
        properties: { status: { const: "observed" }, value },
      },
      UNRESOLVED_FACT_SCHEMA,
      UNAVAILABLE_FACT_SCHEMA,
    ],
  };
}

const INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["step"],
  properties: {
    step: {
      type: "object",
      additionalProperties: false,
      required: ["mimeType", "sha256", "bytes", "blob"],
      properties: {
        mimeType: { const: "model/step" },
        sha256: SHA256_SCHEMA,
        bytes: {
          type: "integer",
          minimum: 1,
          maximum: ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
        },
        blob: {
          type: "string",
          minLength: 4,
          maximum: ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS,
          pattern:
            "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
          description: "Exact padded base64 of the same model/step bytes.",
        },
      },
    },
  },
} as const;

const TOPOLOGY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "brepValidity",
    "solidCount",
    "shellCount",
    "degenerateEdgeCount",
    "freeEdgeCount",
  ],
  properties: {
    brepValidity: factSchema({ type: "string", enum: ["valid", "invalid"] }),
    solidCount: factSchema({ type: "integer", minimum: 0 }),
    shellCount: factSchema({ type: "integer", minimum: 0 }),
    degenerateEdgeCount: factSchema({ type: "integer", minimum: 0 }),
    freeEdgeCount: factSchema({ type: "integer", minimum: 0 }),
  },
} as const;

const OCCURRENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "transform"],
  properties: {
    label: { type: "string", pattern: "^[\\x21-\\x7e]{1,255}$" },
    transform: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "value"],
          properties: {
            status: { const: "observed" },
            value: {
              type: "array",
              minItems: 16,
              maxItems: 16,
              items: { type: "number" },
              // The Deno parser additionally checks the rigid rotation and
              // canonical homogeneous bottom row.
            },
          },
        },
        UNRESOLVED_FACT_SCHEMA,
        UNAVAILABLE_FACT_SCHEMA,
      ],
    },
  },
} as const;

const PAIR_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "firstLabel",
    "secondLabel",
    "linearToleranceMm",
    "minimumDistanceMm",
    "intersectionVolumeMm3",
    "contact",
  ],
  properties: {
    firstLabel: { type: "string", pattern: "^[\\x21-\\x7e]{1,255}$" },
    secondLabel: { type: "string", pattern: "^[\\x21-\\x7e]{1,255}$" },
    linearToleranceMm: {
      const: OCCT_ASSEMBLY_INTEGRITY_METHOD.linearToleranceMm,
    },
    minimumDistanceMm: factSchema({ type: "number", minimum: 0 }),
    intersectionVolumeMm3: factSchema({ type: "number", minimum: 0 }),
    contact: factSchema({ type: "string", enum: ["contact", "no-contact"] }),
  },
} as const;

export const ASSEMBLY_INTEGRITY_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "kind",
    "producer",
    "inputArtifact",
    "method",
    "importability",
    "unitSystem",
    "topology",
    "occurrences",
    "pairs",
  ],
  properties: {
    schemaVersion: { const: ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA },
    kind: { const: "assembly-integrity-observation" },
    producer: {
      type: "object",
      additionalProperties: false,
      required: ["service", "packageVersion", "tool", "engine"],
      properties: {
        service: { const: ASSEMBLY_INTEGRITY_PRODUCER.service },
        packageVersion: { const: ASSEMBLY_INTEGRITY_PRODUCER.packageVersion },
        tool: { const: ASSEMBLY_INTEGRITY_PRODUCER.tool },
        engine: {
          type: "object",
          additionalProperties: false,
          required: ["name", "version"],
          properties: {
            name: { const: ASSEMBLY_INTEGRITY_PRODUCER.engine.name },
            version: { const: ASSEMBLY_INTEGRITY_PRODUCER.engine.version },
          },
        },
      },
    },
    inputArtifact: {
      type: "object",
      additionalProperties: false,
      required: ["mimeType", "sha256", "bytes"],
      properties: {
        mimeType: { const: "model/step" },
        sha256: SHA256_SCHEMA,
        bytes: {
          type: "integer",
          minimum: 1,
          maximum: ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
        },
      },
    },
    method: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version", "linearToleranceMm"],
      properties: {
        id: { const: OCCT_ASSEMBLY_INTEGRITY_METHOD.id },
        version: { const: OCCT_ASSEMBLY_INTEGRITY_METHOD.version },
        linearToleranceMm: {
          const: OCCT_ASSEMBLY_INTEGRITY_METHOD.linearToleranceMm,
        },
      },
    },
    importability: factSchema({ type: "string", enum: ["imported", "failed"] }),
    unitSystem: factSchema({ const: "mm" }),
    topology: TOPOLOGY_SCHEMA,
    occurrences: factSchema({
      type: "array",
      maxItems: ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES,
      items: OCCURRENCE_SCHEMA,
    }),
    pairs: factSchema({
      type: "array",
      maxItems: ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS,
      items: PAIR_SCHEMA,
    }),
  },
} as const;

export const assemblyIntegrityTools: CadTool[] = [{
  name: ASSEMBLY_INTEGRITY_TOOL,
  description:
    "Observe one exact STEP Part 21 artifact with the fixed OCCT/XCAF assembly " +
    "integrity method. The input is a digest-bound padded-base64 STEP only; " +
    "there is no caller code, path, tolerance, transform or runtime option. " +
    "The result reports factual import, unit, topology, direct occurrence and " +
    "pairwise observations, with unresolved or unavailable facts preserved.",
  category: "execute",
  inputSchema: INPUT_SCHEMA,
  outputSchema: ASSEMBLY_INTEGRITY_OUTPUT_SCHEMA,
  handler: async (args): Promise<StructuredToolResult> => {
    const observation = await observeAssemblyIntegrity(args);
    return {
      content: observationText(observation),
      structuredContent: observation,
    };
  },
}];

function observationText(observation: AssemblyIntegrityObservation): string {
  const importability = observation.importability.status === "observed"
    ? observation.importability.value
    : observation.importability.status;
  const occurrences = observation.occurrences.status === "observed"
    ? observation.occurrences.value.length
    : observation.occurrences.status;
  return `Assembly integrity observation: STEP ${importability}; direct occurrences ${occurrences}.`;
}
