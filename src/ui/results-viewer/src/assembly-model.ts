/** Pure projection of the exact observation into one component datasheet. */

import type {
  AssemblyIntegrityFact,
  AssemblyIntegrityObservation,
  AssemblyIntegrityOccurrence,
  AssemblyIntegrityPair,
  AssemblyIntegrityRigidTransform,
} from "./assembly-contract.ts";
import { parseAssemblyObservation } from "./assembly-contract.ts";
import { assemblyMessages } from "./assembly-locale.ts";

export const BUILD123D_ASSEMBLY_COMPONENT_KEYS = {
  datasheet: "build123d.assembly-datasheet",
} as const;

/** A standalone host sees exactly one datasheet component. */
export const BUILD123D_ASSEMBLY_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "none" },
  components: [{
    id: "assembly-datasheet",
    component: BUILD123D_ASSEMBLY_COMPONENT_KEYS.datasheet,
  }],
} as const;

export interface AssemblyComponentData {
  readonly observation: AssemblyIntegrityObservation;
  /** Presentation-only names; exact STEP labels remain the row identities. */
  readonly displayNames: ReadonlyMap<string, string>;
}

export type AssemblyDisplayState =
  | {
    readonly kind: "error";
    readonly title: (locale?: string) => string;
    readonly code: "tool-error" | "result-rejected";
    readonly message: string | ((locale?: string) => string);
  }
  | { readonly kind: "result"; readonly result: AssemblyComponentData };

export interface AssemblyToolResult {
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly _meta?: unknown;
}

export const ASSEMBLY_PRESENTATION_META_KEY =
  "io.casys.mcp-build123d/assembly-presentation" as const;
export const ASSEMBLY_PRESENTATION_SCHEMA =
  "io.casys.mcp-build123d.assembly-presentation/1.0" as const;

export interface AssemblyOccurrenceDisplay {
  readonly name: string;
  readonly technicalId?: string;
}

export interface AssemblyIdentity {
  readonly marker: "imported" | "failed" | "unresolved" | "unavailable";
  readonly label: string;
  readonly detail: string;
  readonly tone: "neutral" | "warning";
}

export interface AssemblyMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

export interface AssemblyFactRow {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

/** Only structuredContent is authoritative; tool-error text is diagnostic. */
export function assemblyStateFromToolResult(
  result: AssemblyToolResult,
): AssemblyDisplayState {
  if (result.isError) {
    const diagnostic = errorText(result.content);
    return {
      kind: "error",
      title: (locale) => assemblyMessages(locale)("toolFailed"),
      code: "tool-error",
      message: diagnostic ??
        ((locale) => assemblyMessages(locale)("toolError")),
    };
  }
  const parsed = parseAssemblyObservation(result.structuredContent);
  if (!parsed.ok) {
    return {
      kind: "error",
      title: (locale) => assemblyMessages(locale)("resultRejected"),
      code: "result-rejected",
      message: parsed.error,
    };
  }
  return {
    kind: "result",
    result: {
      observation: parsed.value,
      displayNames: assemblyPresentationNames(result._meta, parsed.value),
    },
  };
}

export function assemblyIdentity(
  observation: AssemblyIntegrityObservation,
  locale?: string,
): AssemblyIdentity {
  const marker = observation.importability.status === "observed"
    ? observation.importability.value
    : observation.importability.status;
  return {
    marker,
    label: assemblyMessages(locale)("assembly"),
    detail: `sha256:${observation.inputArtifact.sha256}`,
    tone: marker === "imported" ? "neutral" : "warning",
  };
}

export function assemblyMetrics(
  observation: AssemblyIntegrityObservation,
  locale?: string,
): readonly AssemblyMetric[] {
  const t = assemblyMessages(locale);
  return [
    {
      id: "solids",
      label: t("solids"),
      value: factText(observation.topology.solidCount),
    },
    {
      id: "shells",
      label: t("shells"),
      value: factText(observation.topology.shellCount),
    },
    {
      id: "occurrences",
      label: t("directOccurrences"),
      value: factText(observation.occurrences, (value) => String(value.length)),
    },
    {
      id: "pairs",
      label: t("observedPairs"),
      value: factText(observation.pairs, (value) => String(value.length)),
    },
  ];
}

export function assemblyTopologyFacts(
  observation: AssemblyIntegrityObservation,
  locale?: string,
): readonly AssemblyFactRow[] {
  const t = assemblyMessages(locale);
  return [
    {
      id: "importability",
      label: t("importability"),
      value: factText(observation.importability),
    },
    {
      id: "unit-system",
      label: t("unitSystem"),
      value: factText(observation.unitSystem),
    },
    {
      id: "brep-validity",
      label: t("brepValidity"),
      value: factText(observation.topology.brepValidity),
    },
    {
      id: "solid-count",
      label: t("solidCount"),
      value: factText(observation.topology.solidCount),
    },
    {
      id: "shell-count",
      label: t("shellCount"),
      value: factText(observation.topology.shellCount),
    },
    {
      id: "degenerate-edges",
      label: t("degenerateEdgeCount"),
      value: factText(observation.topology.degenerateEdgeCount),
    },
    {
      id: "free-edges",
      label: t("freeEdgeCount"),
      value: factText(observation.topology.freeEdgeCount),
    },
  ];
}

export function assemblySourceFacts(
  observation: AssemblyIntegrityObservation,
  locale?: string,
): readonly AssemblyFactRow[] {
  const t = assemblyMessages(locale);
  return [
    { id: "schema", label: t("schema"), value: observation.schemaVersion },
    {
      id: "step-sha256",
      label: t("stepDigest"),
      value: observation.inputArtifact.sha256,
    },
    {
      id: "step-bytes",
      label: t("stepBytes"),
      value: String(observation.inputArtifact.bytes),
    },
    {
      id: "producer",
      label: t("producer"),
      value:
        `${observation.producer.service} ${observation.producer.packageVersion} · ${observation.producer.tool}`,
    },
    {
      id: "engine",
      label: t("engine"),
      value:
        `${observation.producer.engine.name} ${observation.producer.engine.version}`,
    },
    {
      id: "method",
      label: t("method"),
      value: `${observation.method.id} ${observation.method.version}`,
    },
    {
      id: "tolerance",
      label: t("tolerance"),
      value: `${observation.method.linearToleranceMm} mm`,
    },
  ];
}

/** Preserve both status and reason verbatim whenever the provider has no value. */
export function factText<T>(
  fact: AssemblyIntegrityFact<T>,
  formatObserved: (value: T) => string = String,
): string {
  return fact.status === "observed"
    ? formatObserved(fact.value)
    : `${fact.status} (${fact.reason})`;
}

export function assemblyOccurrenceRows(
  observation: AssemblyIntegrityObservation,
): readonly AssemblyIntegrityOccurrence[] {
  return observation.occurrences.status === "observed"
    ? observation.occurrences.value
    : [];
}

export function assemblyPairRows(
  observation: AssemblyIntegrityObservation,
): readonly AssemblyIntegrityPair[] {
  return observation.pairs.status === "observed" ? observation.pairs.value : [];
}

const OPAQUE_OCCURRENCE_LABEL =
  /^(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|[0-9a-f]{64})$/i;

/**
 * Prefer separately supplied presentation names. Opaque STEP identities fall
 * back to stable, localized aliases; readable STEP labels remain unchanged.
 */
export function assemblyOccurrenceDisplays(
  observation: AssemblyIntegrityObservation,
  displayNames: ReadonlyMap<string, string> = new Map(),
  locale?: string,
): ReadonlyMap<string, AssemblyOccurrenceDisplay> {
  const occurrences = assemblyOccurrenceRows(observation);
  const t = assemblyMessages(locale);
  const baseNames = occurrences.map((occurrence, index) =>
    displayNames.get(occurrence.label) ??
      (OPAQUE_OCCURRENCE_LABEL.test(occurrence.label)
        ? `${t("component")} ${index + 1}`
        : occurrence.label)
  );
  const counts = new Map<string, number>();
  for (const name of baseNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return new Map(occurrences.map((occurrence, index) => {
    const baseName = baseNames[index]!;
    const ordinal = (seen.get(baseName) ?? 0) + 1;
    seen.set(baseName, ordinal);
    const name = (counts.get(baseName) ?? 0) > 1
      ? `${baseName} · ${ordinal}`
      : baseName;
    return [occurrence.label, {
      name,
      ...(name === occurrence.label ? {} : { technicalId: occurrence.label }),
    }] as const;
  }));
}

function assemblyPresentationNames(
  metadata: unknown,
  observation: AssemblyIntegrityObservation,
): ReadonlyMap<string, string> {
  const meta = plainRecord(metadata);
  const presentation = plainRecord(meta?.[ASSEMBLY_PRESENTATION_META_KEY]);
  if (
    !presentation ||
    presentation.schemaVersion !== ASSEMBLY_PRESENTATION_SCHEMA ||
    presentation.sourceStepSha256 !== observation.inputArtifact.sha256
  ) return new Map();
  const names = plainRecord(presentation.names);
  const occurrences = assemblyOccurrenceRows(observation);
  if (!names || Object.keys(names).length !== occurrences.length) {
    return new Map();
  }
  const parsed = new Map<string, string>();
  for (const occurrence of occurrences) {
    const name = names[occurrence.label];
    if (
      typeof name !== "string" || name.length < 1 || name.length > 80 ||
      hasControlCharacter(name) || name.trim() !== name
    ) return new Map();
    parsed.set(occurrence.label, name);
  }
  return parsed;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export function assemblyTransformText(
  fact: AssemblyIntegrityFact<AssemblyIntegrityRigidTransform>,
): string {
  return factText(fact, (matrix) => `[${matrix.join(", ")}]`);
}

function errorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const messages = content.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const block = candidate as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return messages.length > 0 ? messages.join("\n") : undefined;
}
