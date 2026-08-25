/**
 * Closed bridge for the fixed OCCT assembly-integrity observer.
 *
 * Unlike the CAD-as-code bridge, this module accepts one exact STEP artifact
 * only. It rehashes and stages those bytes privately, then invokes an
 * image/provider-owned Python harness which imports no caller code. Its
 * producer identity attests the `cadquery-ocp` binding, not an OCCT API build.
 */

import { join } from "@std/path";
import { ASSEMBLY_INTEGRITY_HARNESS_SOURCE } from "./assembly-integrity-harness-source.ts";
import { MCP_BUILD123D_VERSION } from "../version.ts";

export const ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA =
  "build123d-assembly-integrity-observation/1.0" as const;
export const ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES = 128 * 1_024 * 1_024;
/** Exact maximum length of canonical padded base64 for the accepted STEP. */
export const ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS: number = 4 *
  Math.ceil(ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES / 3);
/** Reserved for the fixed JSON-RPC envelope, method, identity and metadata. */
export const ASSEMBLY_INTEGRITY_MCP_ENVELOPE_BYTES = 64 * 1_024;
/**
 * HTTP cap which can carry the largest legal inline STEP plus a bounded MCP
 * envelope. The decoded STEP limit remains the authoritative artifact limit.
 */
export const ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES =
  ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS +
  ASSEMBLY_INTEGRITY_MCP_ENVELOPE_BYTES;
export const ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES = 32;
export const ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS = 496;
export const ASSEMBLY_INTEGRITY_TIMEOUT_MS = 60_000;
export const OCCT_ASSEMBLY_INTEGRITY_METHOD: Readonly<{
  readonly id: "occt-assembly-integrity-v1";
  readonly version: "1.0.0";
  readonly linearToleranceMm: 0.000001;
}> = Object.freeze(
  {
    id: "occt-assembly-integrity-v1",
    version: "1.0.0",
    linearToleranceMm: 0.000001,
  } as const,
);
export const ASSEMBLY_INTEGRITY_PRODUCER: Readonly<{
  readonly service: "mcp-build123d";
  readonly packageVersion: typeof MCP_BUILD123D_VERSION;
  readonly tool: "build123d_observe_assembly_integrity";
  readonly engine: Readonly<{
    readonly name: "cadquery-ocp";
    readonly version: "7.9.3.1";
  }>;
}> = Object.freeze(
  {
    service: "mcp-build123d",
    packageVersion: MCP_BUILD123D_VERSION,
    tool: "build123d_observe_assembly_integrity",
    engine: Object.freeze({ name: "cadquery-ocp", version: "7.9.3.1" }),
  } as const,
);

const STEP_MIME_TYPE = "model/step" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const ASCII_LABEL = /^[\x21-\x7e]{1,255}$/;
const MAXIMUM_HARNESS_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export interface AssemblyIntegrityInputArtifact {
  readonly mimeType: typeof STEP_MIME_TYPE;
  readonly sha256: string;
  readonly bytes: number;
}

export interface AssemblyIntegrityProducer {
  readonly service: typeof ASSEMBLY_INTEGRITY_PRODUCER.service;
  readonly packageVersion: typeof ASSEMBLY_INTEGRITY_PRODUCER.packageVersion;
  readonly tool: typeof ASSEMBLY_INTEGRITY_PRODUCER.tool;
  readonly engine: typeof ASSEMBLY_INTEGRITY_PRODUCER.engine;
}

export interface AssemblyIntegrityObservationInput {
  readonly step: AssemblyIntegrityInputArtifact & { readonly blob: string };
}

export type AssemblyIntegrityFact<T> =
  | { readonly status: "observed"; readonly value: T }
  | {
    readonly status: "unresolved";
    readonly reason: "identity-missing" | "observability-missing";
  }
  | { readonly status: "unavailable"; readonly reason: "unsupported" };

/** Canonical row-major, right-handed rigid 4×4 matrix in STEP millimetres. */
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
  /** Observed only from XCAF's component Location, never a caller pose. */
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

export interface AssemblyIntegrityObservation extends Record<string, unknown> {
  readonly schemaVersion: typeof ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA;
  readonly kind: "assembly-integrity-observation";
  readonly producer: AssemblyIntegrityProducer;
  readonly inputArtifact: AssemblyIntegrityInputArtifact;
  readonly method: typeof OCCT_ASSEMBLY_INTEGRITY_METHOD;
  readonly importability: AssemblyIntegrityFact<"imported" | "failed">;
  readonly unitSystem: AssemblyIntegrityFact<"mm">;
  readonly topology: AssemblyIntegrityTopology;
  readonly occurrences: AssemblyIntegrityFact<
    readonly AssemblyIntegrityOccurrence[]
  >;
  readonly pairs: AssemblyIntegrityFact<readonly AssemblyIntegrityPair[]>;
}

export class AssemblyIntegrityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyIntegrityInputError";
  }
}

export class AssemblyIntegrityObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyIntegrityObservationError";
  }
}

/**
 * Rehash, validate and privately stage a closed STEP before invoking the
 * fixed Python harness. No caller path, timeout, interpreter argument, or
 * code crosses this interface.
 */
export async function observeAssemblyIntegrity(
  value: unknown,
): Promise<AssemblyIntegrityObservation> {
  const input = await parseObservationInput(value);
  const temporaryDirectory = await Deno.makeTempDir({
    prefix: "build123d-assembly-integrity-",
  });
  try {
    const stagedStep = join(temporaryDirectory, "assembly.step");
    await Deno.writeFile(stagedStep, input.bytes, { mode: 0o600 });
    const response = await runAssemblyIntegrityHarness(
      stagedStep,
      input.artifact,
    );
    return parseAssemblyIntegrityObservation(response, input.artifact);
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true }).catch(() =>
      undefined
    );
  }
}

interface ParsedInput {
  readonly artifact: AssemblyIntegrityInputArtifact;
  readonly bytes: Uint8Array;
}

async function parseObservationInput(value: unknown): Promise<ParsedInput> {
  const root = exactInputRecord(value, ["step"], "$input");
  const step = exactInputRecord(
    root.step,
    ["mimeType", "sha256", "bytes", "blob"],
    "$input.step",
  );
  if (step.mimeType !== STEP_MIME_TYPE) {
    throw new AssemblyIntegrityInputError(
      "$input.step.mimeType must be model/step.",
    );
  }
  if (typeof step.sha256 !== "string" || !SHA256_HEX.test(step.sha256)) {
    throw new AssemblyIntegrityInputError(
      "$input.step.sha256 must be lowercase SHA-256.",
    );
  }
  if (
    !isPositiveSafeInteger(step.bytes) ||
    step.bytes > ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES
  ) {
    throw new AssemblyIntegrityInputError(
      `$input.step.bytes must be a positive integer at most ${ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES}.`,
    );
  }
  if (typeof step.blob !== "string" || step.blob.length === 0) {
    throw new AssemblyIntegrityInputError(
      "$input.step.blob must be canonical padded base64.",
    );
  }
  const bytes = decodeCanonicalBase64(step.blob);
  if (bytes.byteLength !== step.bytes) {
    throw new AssemblyIntegrityInputError(
      "$input.step.bytes does not equal decoded blob length.",
    );
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== step.sha256) {
    throw new AssemblyIntegrityInputError(
      "$input.step.sha256 does not equal decoded blob bytes.",
    );
  }
  validatePart21(bytes);
  return {
    artifact: { mimeType: STEP_MIME_TYPE, sha256, bytes: bytes.byteLength },
    bytes,
  };
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new AssemblyIntegrityInputError(
      "$input.step.blob must be canonical padded base64.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(value);
  } catch {
    throw new AssemblyIntegrityInputError("$input.step.blob is not base64.");
  }
  if (
    bytes.byteLength > ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES ||
    bytes.toBase64() !== value
  ) {
    throw new AssemblyIntegrityInputError(
      "$input.step.blob is not canonical padded base64.",
    );
  }
  return bytes;
}

function validatePart21(bytes: Uint8Array): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AssemblyIntegrityInputError(
      "$input.step.blob must be UTF-8 STEP Part 21 bytes.",
    );
  }
  if (
    !text.startsWith("ISO-10303-21;") ||
    !text.trimEnd().endsWith("END-ISO-10303-21;") ||
    text.includes("\0") ||
    !/\bHEADER;[\s\S]*?ENDSEC;[\s\S]*?\bDATA;[\s\S]*?ENDSEC;/.test(text)
  ) {
    throw new AssemblyIntegrityInputError(
      "$input.step.blob must contain one complete STEP Part 21 exchange.",
    );
  }
}

async function runAssemblyIntegrityHarness(
  stepPath: string,
  inputArtifact: AssemblyIntegrityInputArtifact,
): Promise<unknown> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(pythonBin(), {
      args: ["-I", "-B", "-c", ASSEMBLY_INTEGRITY_HARNESS_SOURCE],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new AssemblyIntegrityObservationError(
        "The configured Python interpreter is unavailable.",
      );
    }
    throw error;
  }
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(JSON.stringify({ stepPath, inputArtifact })),
  );
  await writer.close();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The fixed harness may already have exited.
    }
  }, ASSEMBLY_INTEGRITY_TIMEOUT_MS);
  const { stdout, stderr, success } = await child.output();
  clearTimeout(timer);
  if (
    stdout.byteLength === 0 ||
    stdout.byteLength > MAXIMUM_HARNESS_RESPONSE_BYTES
  ) {
    throw new AssemblyIntegrityObservationError(
      success
        ? "The assembly-integrity harness produced no bounded response."
        : "The fixed assembly-integrity harness failed or timed out.",
    );
  }
  // The private protocol is one successful process with one clean JSON stdout
  // receipt. Never accept a superficially valid body from a failed/noisy child.
  if (!success || stderr.byteLength !== 0) {
    throw new AssemblyIntegrityObservationError(
      "The fixed assembly-integrity harness failed or wrote stderr.",
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(stdout),
    );
  } catch {
    throw new AssemblyIntegrityObservationError(
      "The assembly-integrity harness produced invalid JSON.",
    );
  }
  const root = record(response, "$harnessResponse");
  if (
    root.ok === true && Object.keys(root).length === 2 &&
    Object.hasOwn(root, "observation")
  ) {
    return root.observation;
  }
  if (root.ok === false && typeof root.error === "string") {
    throw new AssemblyIntegrityObservationError(
      "The fixed assembly-integrity harness could not observe the STEP.",
    );
  }
  throw new AssemblyIntegrityObservationError(
    "The assembly-integrity harness response is unsupported.",
  );
}

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

/** Parse closed worker JSON and recross the exact artifact/method basis. */
export function parseAssemblyIntegrityObservation(
  value: unknown,
  inputArtifact: AssemblyIntegrityInputArtifact,
): AssemblyIntegrityObservation {
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
  ], "$assemblyIntegrityObservation");
  if (root.schemaVersion !== ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA) {
    throw new AssemblyIntegrityObservationError(
      "The observation schemaVersion is unsupported.",
    );
  }
  if (root.kind !== "assembly-integrity-observation") {
    throw new AssemblyIntegrityObservationError(
      "The observation kind is unsupported.",
    );
  }
  assertFixedProducer(root.producer);
  const outputArtifact = parseInputArtifact(
    root.inputArtifact,
    "$assemblyIntegrityObservation.inputArtifact",
  );
  if (
    outputArtifact.mimeType !== inputArtifact.mimeType ||
    outputArtifact.sha256 !== inputArtifact.sha256 ||
    outputArtifact.bytes !== inputArtifact.bytes
  ) {
    throw new AssemblyIntegrityObservationError(
      "The observation inputArtifact differs from the exact supplied STEP.",
    );
  }
  assertFixedMethod(root.method);
  const importability = parseFact(
    root.importability,
    "$assemblyIntegrityObservation.importability",
    (candidate, path) =>
      enumValue(candidate, ["imported", "failed"] as const, path),
  );
  if (importability.status !== "observed") {
    throw new AssemblyIntegrityObservationError(
      "Importability must be an observed imported or failed fact.",
    );
  }
  const unitSystem = parseFact(
    root.unitSystem,
    "$assemblyIntegrityObservation.unitSystem",
    (candidate, path) => enumValue(candidate, ["mm"] as const, path),
  );
  const topology = parseTopology(root.topology);
  const occurrences = parseFact(
    root.occurrences,
    "$assemblyIntegrityObservation.occurrences",
    parseOccurrences,
  );
  const pairs = parseFact(
    root.pairs,
    "$assemblyIntegrityObservation.pairs",
    parsePairs,
  );
  recrossObservationBranches(
    importability.value,
    unitSystem,
    topology,
    occurrences,
    pairs,
  );
  return {
    schemaVersion: ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA,
    kind: "assembly-integrity-observation",
    producer: ASSEMBLY_INTEGRITY_PRODUCER,
    inputArtifact,
    method: OCCT_ASSEMBLY_INTEGRITY_METHOD,
    importability,
    unitSystem,
    topology,
    occurrences,
    pairs,
  };
}

function assertFixedProducer(value: unknown): void {
  const producer = exactRecord(
    value,
    ["service", "packageVersion", "tool", "engine"],
    "$assemblyIntegrityObservation.producer",
  );
  const engine = exactRecord(
    producer.engine,
    ["name", "version"],
    "$assemblyIntegrityObservation.producer.engine",
  );
  if (
    producer.service !== ASSEMBLY_INTEGRITY_PRODUCER.service ||
    producer.packageVersion !== ASSEMBLY_INTEGRITY_PRODUCER.packageVersion ||
    producer.tool !== ASSEMBLY_INTEGRITY_PRODUCER.tool ||
    engine.name !== ASSEMBLY_INTEGRITY_PRODUCER.engine.name ||
    engine.version !== ASSEMBLY_INTEGRITY_PRODUCER.engine.version
  ) {
    throw new AssemblyIntegrityObservationError(
      "The observation producer is not the fixed build123d cadquery-ocp provider.",
    );
  }
}

function parseInputArtifact(
  value: unknown,
  path: string,
): AssemblyIntegrityInputArtifact {
  const root = exactRecord(value, ["mimeType", "sha256", "bytes"], path);
  if (
    root.mimeType !== STEP_MIME_TYPE || typeof root.sha256 !== "string" ||
    !SHA256_HEX.test(root.sha256)
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} is not one exact STEP artifact identity.`,
    );
  }
  if (
    !isPositiveSafeInteger(root.bytes) ||
    root.bytes > ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path}.bytes is outside the supported STEP bound.`,
    );
  }
  return { mimeType: STEP_MIME_TYPE, sha256: root.sha256, bytes: root.bytes };
}

function assertFixedMethod(value: unknown): void {
  const root = exactRecord(
    value,
    ["id", "version", "linearToleranceMm"],
    "$assemblyIntegrityObservation.method",
  );
  if (
    root.id !== OCCT_ASSEMBLY_INTEGRITY_METHOD.id ||
    root.version !== OCCT_ASSEMBLY_INTEGRITY_METHOD.version ||
    !Object.is(
      root.linearToleranceMm,
      OCCT_ASSEMBLY_INTEGRITY_METHOD.linearToleranceMm,
    )
  ) {
    throw new AssemblyIntegrityObservationError(
      "The observation method is not the fixed OCCT method.",
    );
  }
}

function parseTopology(value: unknown): AssemblyIntegrityTopology {
  const root = exactRecord(value, [
    "brepValidity",
    "solidCount",
    "shellCount",
    "degenerateEdgeCount",
    "freeEdgeCount",
  ], "$assemblyIntegrityObservation.topology");
  return {
    brepValidity: parseFact(
      root.brepValidity,
      "$assemblyIntegrityObservation.topology.brepValidity",
      (candidate, path) =>
        enumValue(candidate, ["valid", "invalid"] as const, path),
    ),
    solidCount: parseFact(
      root.solidCount,
      "$assemblyIntegrityObservation.topology.solidCount",
      nonNegativeInteger,
    ),
    shellCount: parseFact(
      root.shellCount,
      "$assemblyIntegrityObservation.topology.shellCount",
      nonNegativeInteger,
    ),
    degenerateEdgeCount: parseFact(
      root.degenerateEdgeCount,
      "$assemblyIntegrityObservation.topology.degenerateEdgeCount",
      nonNegativeInteger,
    ),
    freeEdgeCount: parseFact(
      root.freeEdgeCount,
      "$assemblyIntegrityObservation.topology.freeEdgeCount",
      nonNegativeInteger,
    ),
  };
}

function parseOccurrences(
  value: unknown,
  path: string,
): readonly AssemblyIntegrityOccurrence[] {
  if (
    !Array.isArray(value) ||
    value.length > ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} exceeds the occurrence bound.`,
    );
  }
  const occurrences = value.map((entry, index) => {
    const root = exactRecord(
      entry,
      ["label", "transform"],
      `${path}[${index}]`,
    );
    const label = parseAsciiLabel(root.label, `${path}[${index}].label`);
    return {
      label,
      transform: parseFact(
        root.transform,
        `${path}[${index}].transform`,
        parseRigidTransform,
      ),
    };
  });
  const labels = occurrences.map((entry) => entry.label);
  if (
    new Set(labels).size !== labels.length ||
    labels.some((label, index) => index > 0 && labels[index - 1]! >= label)
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} labels must be unique and ASCII-sorted.`,
    );
  }
  if (pairCount(labels.length) > ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS) {
    throw new AssemblyIntegrityObservationError(
      `${path} exceeds the pair bound.`,
    );
  }
  return occurrences;
}

function parsePairs(
  value: unknown,
  path: string,
): readonly AssemblyIntegrityPair[] {
  if (
    !Array.isArray(value) || value.length > ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} exceeds the pair bound.`,
    );
  }
  return value.map((entry, index) => {
    const root = exactRecord(entry, [
      "firstLabel",
      "secondLabel",
      "linearToleranceMm",
      "minimumDistanceMm",
      "intersectionVolumeMm3",
      "contact",
    ], `${path}[${index}]`);
    const firstLabel = parseAsciiLabel(
      root.firstLabel,
      `${path}[${index}].firstLabel`,
    );
    const secondLabel = parseAsciiLabel(
      root.secondLabel,
      `${path}[${index}].secondLabel`,
    );
    if (
      firstLabel >= secondLabel ||
      !Object.is(
        root.linearToleranceMm,
        OCCT_ASSEMBLY_INTEGRITY_METHOD.linearToleranceMm,
      )
    ) {
      throw new AssemblyIntegrityObservationError(
        `${path}[${index}] has a noncanonical pair identity or tolerance.`,
      );
    }
    return {
      firstLabel,
      secondLabel,
      linearToleranceMm: 0.000001,
      minimumDistanceMm: parseFact(
        root.minimumDistanceMm,
        `${path}[${index}].minimumDistanceMm`,
        nonNegativeFinite,
      ),
      intersectionVolumeMm3: parseFact(
        root.intersectionVolumeMm3,
        `${path}[${index}].intersectionVolumeMm3`,
        nonNegativeFinite,
      ),
      contact: parseFact(
        root.contact,
        `${path}[${index}].contact`,
        (candidate, candidatePath) =>
          enumValue(
            candidate,
            ["contact", "no-contact"] as const,
            candidatePath,
          ),
      ),
    };
  });
}

function recrossObservationBranches(
  importability: "imported" | "failed",
  unitSystem: AssemblyIntegrityFact<"mm">,
  topology: AssemblyIntegrityTopology,
  occurrences: AssemblyIntegrityFact<readonly AssemblyIntegrityOccurrence[]>,
  pairs: AssemblyIntegrityFact<readonly AssemblyIntegrityPair[]>,
): void {
  if (importability === "failed") {
    const topologyFacts = Object.values(topology);
    if (
      topologyFacts.some((fact) => !isUnresolvedObservability(fact)) ||
      !isUnresolvedObservability(unitSystem) ||
      !isUnresolvedObservability(occurrences) ||
      !isUnresolvedObservability(pairs)
    ) {
      throw new AssemblyIntegrityObservationError(
        "Failed imports must retain literal downstream observability gaps.",
      );
    }
    return;
  }
  if (occurrences.status === "observed") {
    if (pairs.status !== "observed") {
      throw new AssemblyIntegrityObservationError(
        "Observed occurrences require a complete pair observation table.",
      );
    }
    const expected = expectedPairs(
      occurrences.value.map((entry) => entry.label),
    );
    if (
      pairs.value.length !== expected.length ||
      pairs.value.some((pair, index) =>
        pair.firstLabel !== expected[index]![0] ||
        pair.secondLabel !== expected[index]![1]
      )
    ) {
      throw new AssemblyIntegrityObservationError(
        "Observed pairs must cover every direct occurrence pair in canonical order.",
      );
    }
  } else if (pairs.status === "observed") {
    throw new AssemblyIntegrityObservationError(
      "Pairs cannot be observed without a complete direct occurrence identity table.",
    );
  }
}

function parseFact<T>(
  value: unknown,
  path: string,
  parseObserved: (value: unknown, path: string) => T,
): AssemblyIntegrityFact<T> {
  const root = record(value, path);
  if (root.status === "observed") {
    exactKeys(root, ["status", "value"], path);
    return {
      status: "observed",
      value: parseObserved(root.value, `${path}.value`),
    };
  }
  if (root.status === "unresolved") {
    exactKeys(root, ["status", "reason"], path);
    if (
      root.reason !== "identity-missing" &&
      root.reason !== "observability-missing"
    ) {
      throw new AssemblyIntegrityObservationError(
        `${path}.reason is unsupported.`,
      );
    }
    return { status: "unresolved", reason: root.reason };
  }
  if (root.status === "unavailable") {
    exactKeys(root, ["status", "reason"], path);
    if (root.reason !== "unsupported") {
      throw new AssemblyIntegrityObservationError(
        `${path}.reason is unsupported.`,
      );
    }
    return { status: "unavailable", reason: "unsupported" };
  }
  throw new AssemblyIntegrityObservationError(`${path}.status is unsupported.`);
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new AssemblyIntegrityObservationError(
      `${path} has an unsupported value.`,
    );
  }
  return value as T[number];
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AssemblyIntegrityObservationError(
      `${path} must be a non-negative safe integer.`,
    );
  }
  return value as number;
}

function nonNegativeFinite(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    Object.is(value, -0)
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} must be a non-negative finite number.`,
    );
  }
  return value;
}

function parseRigidTransform(
  value: unknown,
  path: string,
): AssemblyIntegrityRigidTransform {
  if (!Array.isArray(value) || value.length !== 16) {
    throw new AssemblyIntegrityObservationError(
      `${path} must be one row-major 4x4 matrix.`,
    );
  }
  const matrix = value.map((entry, index) => {
    if (
      typeof entry !== "number" || !Number.isFinite(entry) ||
      Object.is(entry, -0)
    ) {
      throw new AssemblyIntegrityObservationError(
        `${path}[${index}] must be a canonical finite number.`,
      );
    }
    return entry;
  });
  if (
    !Object.is(matrix[12], 0) || !Object.is(matrix[13], 0) ||
    !Object.is(matrix[14], 0) || !Object.is(matrix[15], 1)
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} must have the canonical homogeneous bottom row.`,
    );
  }
  const rotation = [
    [matrix[0]!, matrix[1]!, matrix[2]!],
    [matrix[4]!, matrix[5]!, matrix[6]!],
    [matrix[8]!, matrix[9]!, matrix[10]!],
  ];
  const rigidTolerance = 1e-9;
  for (let row = 0; row < 3; row += 1) {
    const norm = dot(rotation[row]!, rotation[row]!);
    if (Math.abs(norm - 1) > rigidTolerance) {
      throw new AssemblyIntegrityObservationError(
        `${path} rotation rows must be unit length.`,
      );
    }
    for (let other = row + 1; other < 3; other += 1) {
      if (Math.abs(dot(rotation[row]!, rotation[other]!)) > rigidTolerance) {
        throw new AssemblyIntegrityObservationError(
          `${path} rotation rows must be orthogonal.`,
        );
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
  if (Math.abs(determinant - 1) > rigidTolerance) {
    throw new AssemblyIntegrityObservationError(
      `${path} rotation must be right-handed.`,
    );
  }
  return matrix as unknown as AssemblyIntegrityRigidTransform;
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0]! * right[0]! + left[1]! * right[1]! +
    left[2]! * right[2]!;
}

function parseAsciiLabel(value: unknown, path: string): string {
  if (typeof value !== "string" || !ASCII_LABEL.test(value)) {
    throw new AssemblyIntegrityObservationError(
      `${path} must be a non-empty printable ASCII label.`,
    );
  }
  return value;
}

function isUnresolvedObservability(
  value: AssemblyIntegrityFact<unknown>,
): boolean {
  return value.status === "unresolved" &&
    value.reason === "observability-missing";
}

function expectedPairs(
  labels: readonly string[],
): readonly (readonly [string, string])[] {
  const pairs: Array<readonly [string, string]> = [];
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      pairs.push([labels[first]!, labels[second]!]);
    }
  }
  return pairs;
}

function pairCount(occurrences: number): number {
  return occurrences * (occurrences - 1) / 2;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const root = record(value, path);
  exactKeys(root, keys, path);
  return root;
}

function exactInputRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AssemblyIntegrityInputError(`${path} must be an object.`);
  }
  const root = value as Record<string, unknown>;
  if (
    Object.keys(root).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(root, key))
  ) {
    throw new AssemblyIntegrityInputError(`${path} has an unsupported shape.`);
  }
  return root;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AssemblyIntegrityObservationError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new AssemblyIntegrityObservationError(
      `${path} has an unsupported shape.`,
    );
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copied.buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
