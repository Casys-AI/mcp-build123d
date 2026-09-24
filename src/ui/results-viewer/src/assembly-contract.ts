/** Browser-safe parser for the direct assembly-integrity tool result. */

import { MCP_BUILD123D_VERSION } from "../../../version.ts";

/** Mirrors the current wire contract without importing the server's Deno bridge. */
export type AssemblyIntegrityFact<T> =
  | { readonly status: "observed"; readonly value: T }
  | {
    readonly status: "unresolved";
    readonly reason: "identity-missing" | "observability-missing";
  }
  | { readonly status: "unavailable"; readonly reason: "unsupported" };

export interface AssemblyIntegrityInputArtifact {
  readonly mimeType: "model/step";
  readonly sha256: string;
  readonly bytes: number;
}

export type AssemblyIntegrityRigidTransform = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  0,
  0,
  0,
  1,
];

export interface AssemblyIntegrityOccurrence {
  readonly label: string;
  readonly transform: AssemblyIntegrityFact<AssemblyIntegrityRigidTransform>;
}

export interface AssemblyIntegrityPair {
  readonly firstLabel: string;
  readonly secondLabel: string;
  readonly linearToleranceMm: 0.000001;
  readonly minimumDistanceMm: AssemblyIntegrityFact<number>;
  readonly intersectionVolumeMm3: AssemblyIntegrityFact<number>;
  readonly contact: AssemblyIntegrityFact<"contact" | "no-contact">;
}

export interface AssemblyIntegrityTopology {
  readonly brepValidity: AssemblyIntegrityFact<"valid" | "invalid">;
  readonly solidCount: AssemblyIntegrityFact<number>;
  readonly shellCount: AssemblyIntegrityFact<number>;
  readonly degenerateEdgeCount: AssemblyIntegrityFact<number>;
  readonly freeEdgeCount: AssemblyIntegrityFact<number>;
}

export interface AssemblyIntegrityObservation {
  readonly schemaVersion: "build123d-assembly-integrity-observation/1.0";
  readonly kind: "assembly-integrity-observation";
  readonly producer: typeof PRODUCER;
  readonly inputArtifact: AssemblyIntegrityInputArtifact;
  readonly method: typeof METHOD;
  readonly importability: AssemblyIntegrityFact<"imported" | "failed">;
  readonly unitSystem: AssemblyIntegrityFact<"mm">;
  readonly topology: AssemblyIntegrityTopology;
  readonly occurrences: AssemblyIntegrityFact<
    readonly AssemblyIntegrityOccurrence[]
  >;
  readonly pairs: AssemblyIntegrityFact<readonly AssemblyIntegrityPair[]>;
}

export type ParseAssemblyObservation =
  | { readonly ok: true; readonly value: AssemblyIntegrityObservation }
  | { readonly ok: false; readonly error: string };

const SCHEMA = "build123d-assembly-integrity-observation/1.0";
const METHOD = {
  id: "occt-assembly-integrity-v1",
  version: "1.0.0",
  linearToleranceMm: 0.000001,
} as const;
const PRODUCER = {
  service: "mcp-build123d",
  packageVersion: MCP_BUILD123D_VERSION,
  tool: "build123d_observe_assembly_integrity",
  engine: { name: "cadquery-ocp", version: "7.9.3.1" },
} as const;
const MAX_STEP_BYTES = 128 * 1_024 * 1_024;
const MAX_OCCURRENCES = 32;
const MAX_PAIRS = 496;
const SHA256 = /^[a-f0-9]{64}$/;
const LABEL = /^[\x21-\x7e]{1,255}$/;

/** Accept only the current provider's exact, internally coherent observation. */
export function parseAssemblyObservation(
  value: unknown,
): ParseAssemblyObservation {
  try {
    return { ok: true, value: parseObservation(value) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : "Invalid assembly observation",
    };
  }
}

function parseObservation(value: unknown): AssemblyIntegrityObservation {
  const root = exactRecord(value, [
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
  ], "observation");
  if (root.schemaVersion !== SCHEMA) fail("Unsupported observation schema");
  if (root.kind !== "assembly-integrity-observation") {
    fail("Unsupported observation kind");
  }
  parseProducer(root.producer);
  const inputArtifact = parseInputArtifact(root.inputArtifact);
  parseMethod(root.method);
  const importability = parseFact(
    root.importability,
    "importability",
    (value) =>
      enumValue(value, ["imported", "failed"] as const, "importability.value"),
  );
  if (importability.status !== "observed") {
    fail("Importability must be an observed fact");
  }
  const unitSystem = parseFact(
    root.unitSystem,
    "unitSystem",
    (value) => enumValue(value, ["mm"] as const, "unitSystem.value"),
  );
  const topology = parseTopology(root.topology);
  const occurrences = parseFact(
    root.occurrences,
    "occurrences",
    parseOccurrences,
  );
  const pairs = parseFact(root.pairs, "pairs", parsePairs);
  recrossBranches(
    importability.value,
    unitSystem,
    topology,
    occurrences,
    pairs,
  );
  return {
    schemaVersion: SCHEMA,
    kind: "assembly-integrity-observation",
    producer: PRODUCER,
    inputArtifact,
    method: METHOD,
    importability,
    unitSystem,
    topology,
    occurrences,
    pairs,
  };
}

function parseProducer(value: unknown): void {
  const producer = exactRecord(
    value,
    ["service", "packageVersion", "tool", "engine"],
    "producer",
  );
  const engine = exactRecord(
    producer.engine,
    ["name", "version"],
    "producer.engine",
  );
  if (
    producer.service !== PRODUCER.service ||
    producer.packageVersion !== PRODUCER.packageVersion ||
    producer.tool !== PRODUCER.tool ||
    engine.name !== PRODUCER.engine.name ||
    engine.version !== PRODUCER.engine.version
  ) fail("Unsupported assembly observation producer");
}

function parseInputArtifact(value: unknown): AssemblyIntegrityInputArtifact {
  const artifact = exactRecord(
    value,
    ["mimeType", "sha256", "bytes"],
    "inputArtifact",
  );
  if (artifact.mimeType !== "model/step") {
    fail("inputArtifact.mimeType must be model/step");
  }
  if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) {
    fail("inputArtifact.sha256 must be lowercase SHA-256");
  }
  if (!positiveSafeInteger(artifact.bytes) || artifact.bytes > MAX_STEP_BYTES) {
    fail("inputArtifact.bytes exceeds the STEP bound");
  }
  return {
    mimeType: "model/step",
    sha256: artifact.sha256,
    bytes: artifact.bytes,
  };
}

function parseMethod(value: unknown): void {
  const method = exactRecord(
    value,
    ["id", "version", "linearToleranceMm"],
    "method",
  );
  if (
    method.id !== METHOD.id || method.version !== METHOD.version ||
    !Object.is(method.linearToleranceMm, METHOD.linearToleranceMm)
  ) fail("Unsupported assembly observation method");
}

function parseTopology(value: unknown): AssemblyIntegrityTopology {
  const topology = exactRecord(value, [
    "brepValidity",
    "solidCount",
    "shellCount",
    "degenerateEdgeCount",
    "freeEdgeCount",
  ], "topology");
  return {
    brepValidity: parseFact(
      topology.brepValidity,
      "topology.brepValidity",
      (value) =>
        enumValue(
          value,
          ["valid", "invalid"] as const,
          "topology.brepValidity.value",
        ),
    ),
    solidCount: parseFact(
      topology.solidCount,
      "topology.solidCount",
      (value) => nonNegativeInteger(value, "topology.solidCount.value"),
    ),
    shellCount: parseFact(
      topology.shellCount,
      "topology.shellCount",
      (value) => nonNegativeInteger(value, "topology.shellCount.value"),
    ),
    degenerateEdgeCount: parseFact(
      topology.degenerateEdgeCount,
      "topology.degenerateEdgeCount",
      (value) =>
        nonNegativeInteger(value, "topology.degenerateEdgeCount.value"),
    ),
    freeEdgeCount: parseFact(
      topology.freeEdgeCount,
      "topology.freeEdgeCount",
      (value) => nonNegativeInteger(value, "topology.freeEdgeCount.value"),
    ),
  };
}

function parseOccurrences(
  value: unknown,
): readonly AssemblyIntegrityOccurrence[] {
  if (!Array.isArray(value) || value.length > MAX_OCCURRENCES) {
    fail("occurrences exceeds the direct occurrence bound");
  }
  const occurrences = value.map((candidate, index) => {
    const path = `occurrences[${index}]`;
    const entry = exactRecord(candidate, ["label", "transform"], path);
    return {
      label: asciiLabel(entry.label, `${path}.label`),
      transform: parseFact(
        entry.transform,
        `${path}.transform`,
        (value) => parseRigidTransform(value, `${path}.transform.value`),
      ),
    };
  });
  for (let index = 1; index < occurrences.length; index += 1) {
    if (occurrences[index - 1]!.label >= occurrences[index]!.label) {
      fail("Occurrence labels must be unique and ASCII-sorted");
    }
  }
  return occurrences;
}

function parsePairs(value: unknown): readonly AssemblyIntegrityPair[] {
  if (!Array.isArray(value) || value.length > MAX_PAIRS) {
    fail("pairs exceeds the pair bound");
  }
  return value.map((candidate, index) => {
    const path = `pairs[${index}]`;
    const pair = exactRecord(candidate, [
      "firstLabel",
      "secondLabel",
      "linearToleranceMm",
      "minimumDistanceMm",
      "intersectionVolumeMm3",
      "contact",
    ], path);
    const firstLabel = asciiLabel(pair.firstLabel, `${path}.firstLabel`);
    const secondLabel = asciiLabel(pair.secondLabel, `${path}.secondLabel`);
    if (
      firstLabel >= secondLabel ||
      !Object.is(pair.linearToleranceMm, METHOD.linearToleranceMm)
    ) fail(`${path} has a noncanonical identity or tolerance`);
    return {
      firstLabel,
      secondLabel,
      linearToleranceMm: METHOD.linearToleranceMm,
      minimumDistanceMm: parseFact(
        pair.minimumDistanceMm,
        `${path}.minimumDistanceMm`,
        (value) => nonNegativeFinite(value, `${path}.minimumDistanceMm.value`),
      ),
      intersectionVolumeMm3: parseFact(
        pair.intersectionVolumeMm3,
        `${path}.intersectionVolumeMm3`,
        (value) =>
          nonNegativeFinite(value, `${path}.intersectionVolumeMm3.value`),
      ),
      contact: parseFact(
        pair.contact,
        `${path}.contact`,
        (value) =>
          enumValue(
            value,
            ["contact", "no-contact"] as const,
            `${path}.contact.value`,
          ),
      ),
    };
  });
}

function recrossBranches(
  importability: "imported" | "failed",
  unitSystem: AssemblyIntegrityFact<"mm">,
  topology: AssemblyIntegrityTopology,
  occurrences: AssemblyIntegrityFact<readonly AssemblyIntegrityOccurrence[]>,
  pairs: AssemblyIntegrityFact<readonly AssemblyIntegrityPair[]>,
): void {
  if (importability === "failed") {
    if (
      !isObservabilityGap(unitSystem) ||
      Object.values(topology).some((fact) => !isObservabilityGap(fact)) ||
      !isObservabilityGap(occurrences) || !isObservabilityGap(pairs)
    ) fail("Failed import must preserve downstream observability gaps");
    return;
  }
  if (occurrences.status !== "observed") {
    if (pairs.status === "observed") {
      fail("Observed pairs require observed direct occurrences");
    }
    return;
  }
  if (pairs.status !== "observed") {
    fail("Observed direct occurrences require a complete pair table");
  }
  const labels = occurrences.value.map((entry) => entry.label);
  const expectedCount = labels.length * (labels.length - 1) / 2;
  if (pairs.value.length !== expectedCount) {
    fail("Pair table does not cover all direct occurrences");
  }
  let index = 0;
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      const pair = pairs.value[index++];
      if (
        pair?.firstLabel !== labels[first] ||
        pair.secondLabel !== labels[second]
      ) fail("Pair table is not in canonical occurrence order");
    }
  }
}

function parseFact<T>(
  value: unknown,
  path: string,
  parseObserved: (value: unknown) => T,
): AssemblyIntegrityFact<T> {
  const fact = record(value, path);
  if (fact.status === "observed") {
    exactKeys(fact, ["status", "value"], path);
    return { status: "observed", value: parseObserved(fact.value) };
  }
  if (fact.status === "unresolved") {
    exactKeys(fact, ["status", "reason"], path);
    if (
      fact.reason !== "identity-missing" &&
      fact.reason !== "observability-missing"
    ) fail(`${path}.reason is unsupported`);
    return { status: "unresolved", reason: fact.reason };
  }
  if (fact.status === "unavailable") {
    exactKeys(fact, ["status", "reason"], path);
    if (fact.reason !== "unsupported") fail(`${path}.reason is unsupported`);
    return { status: "unavailable", reason: "unsupported" };
  }
  fail(`${path}.status is unsupported`);
}

function parseRigidTransform(
  value: unknown,
  path: string,
): AssemblyIntegrityRigidTransform {
  if (!Array.isArray(value) || value.length !== 16) {
    fail(`${path} must be a row-major 4x4 transform`);
  }
  const matrix = value.map((entry, index) => {
    if (
      typeof entry !== "number" || !Number.isFinite(entry) ||
      Object.is(entry, -0)
    ) {
      fail(`${path}[${index}] must be a canonical finite number`);
    }
    return entry as number;
  });
  if (
    !Object.is(matrix[12], 0) || !Object.is(matrix[13], 0) ||
    !Object.is(matrix[14], 0) || !Object.is(matrix[15], 1)
  ) fail(`${path} has a noncanonical homogeneous row`);
  const rotation = [
    [matrix[0]!, matrix[1]!, matrix[2]!],
    [matrix[4]!, matrix[5]!, matrix[6]!],
    [matrix[8]!, matrix[9]!, matrix[10]!],
  ];
  for (let row = 0; row < 3; row += 1) {
    if (Math.abs(dot(rotation[row]!, rotation[row]!) - 1) > 1e-9) {
      fail(`${path} rotation row is not unit length`);
    }
    for (let other = row + 1; other < 3; other += 1) {
      if (Math.abs(dot(rotation[row]!, rotation[other]!)) > 1e-9) {
        fail(`${path} rotation rows are not orthogonal`);
      }
    }
  }
  const determinant = rotation[0]![0]! *
      (rotation[1]![1]! * rotation[2]![2]! -
        rotation[1]![2]! * rotation[2]![1]!) -
    rotation[0]![1]! *
      (rotation[1]![0]! * rotation[2]![2]! -
        rotation[1]![2]! * rotation[2]![0]!) +
    rotation[0]![2]! *
      (rotation[1]![0]! * rotation[2]![1]! -
        rotation[1]![1]! * rotation[2]![0]!);
  if (Math.abs(determinant - 1) > 1e-9) {
    fail(`${path} rotation is not right-handed`);
  }
  return matrix as unknown as AssemblyIntegrityRigidTransform;
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]!;
}

function asciiLabel(value: unknown, path: string): string {
  if (typeof value !== "string" || !LABEL.test(value)) {
    fail(`${path} must be printable ASCII`);
  }
  return value;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(`${path} is unsupported`);
  }
  return value as T[number];
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < 0 ||
    Object.is(value, -0)
  ) {
    fail(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeFinite(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    Object.is(value, -0)
  ) {
    fail(`${path} must be a non-negative finite number`);
  }
  return value;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isObservabilityGap(fact: AssemblyIntegrityFact<unknown>): boolean {
  return fact.status === "unresolved" &&
    fact.reason === "observability-missing";
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const parsed = record(value, path);
  exactKeys(parsed, keys, path);
  return parsed;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) fail(`${path} has an unsupported shape`);
}

function fail(message: string): never {
  throw new Error(message);
}
