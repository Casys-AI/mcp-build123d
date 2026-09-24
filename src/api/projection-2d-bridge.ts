/** Closed bridge for the fixed build123d/OCCT STEP-to-SVG inspection method. */

import { join } from "@std/path";
import {
  BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  Build123dArtifactError,
  type OwnedStepResolver,
  type OwnedStepResource,
  parseBuild123dStepArtifactUri,
} from "../artifacts.ts";
import {
  collectBoundedChildOutput,
  ProcessOutputLimitError,
} from "./process.ts";
import { PROJECTION_2D_HARNESS_SOURCE } from "./projection-2d-harness-source.ts";
import {
  DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_REQUIRED_VIEW_SPECS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
  DRAWING_PROJECTION_SECTION_VIEW_SPEC,
} from "../projection-2d-view-specs.ts";
export {
  DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
};

export const DRAWING_PROJECTION_SCHEMA =
  "io.casys.mcp-build123d.drawing-projection/1.0" as const;
export const PROJECTION_2D_MAXIMUM_STEP_BYTES = 128 * 1_024 * 1_024;
export const PROJECTION_2D_MAXIMUM_BASE64_CHARACTERS: number = 4 *
  Math.ceil(PROJECTION_2D_MAXIMUM_STEP_BYTES / 3);
export const PROJECTION_2D_MAXIMUM_SVG_BYTES = 1_024 * 1_024;
export const PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES = 4 * 1_024 * 1_024;
export const PROJECTION_2D_MAXIMUM_VIEWS = 5;
export const PROJECTION_2D_TIMEOUT_MS = 60_000;

export const DRAWING_PROJECTION_ENGINE: Readonly<{
  build123d: "0.11.1";
  ocp: "7.9.3.1";
}> = Object.freeze(
  {
    build123d: "0.11.1",
    ocp: "7.9.3.1",
  } as const,
);

export const DRAWING_PROJECTION_METHOD: Readonly<{
  id: "build123d-step-svg-projection";
  version: "1.0";
}> = Object.freeze(
  {
    id: "build123d-step-svg-projection",
    version: "1.0",
  } as const,
);

const REQUIRED_VIEW_SPECS = DRAWING_PROJECTION_REQUIRED_VIEW_SPECS;
const SECTION_VIEW_SPEC = DRAWING_PROJECTION_SECTION_VIEW_SPEC;

const STEP_MIME_TYPE = "model/step" as const;
const SVG_MIME_TYPE = "image/svg+xml" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAXIMUM_HARNESS_RESPONSE_BYTES = 6 * 1_024 * 1_024;
const MAXIMUM_HARNESS_STDERR_BYTES = 64 * 1_024;

export interface DrawingProjectionSourceStep {
  readonly mimeType: typeof STEP_MIME_TYPE;
  readonly sha256: string;
  readonly bytes: number;
}

export type DrawingProjectionStepResource = OwnedStepResource;

export type DrawingProjectionInput =
  | {
    readonly step: DrawingProjectionSourceStep & { readonly blob: string };
    readonly includeSection?: boolean;
  }
  | {
    readonly stepResource: DrawingProjectionStepResource;
    readonly includeSection?: boolean;
  };

export interface ProjectStep2dDependencies {
  /** Current-process owned STEP resolver. Never accepted as MCP input. */
  readonly resolveOwnedStep?: OwnedStepResolver;
}

export type DrawingProjectionViewId =
  | typeof DRAWING_PROJECTION_REQUIRED_VIEW_IDS[number]
  | typeof DRAWING_PROJECTION_SECTION_VIEW_ID;

export interface DrawingProjectionSvg {
  readonly mimeType: typeof SVG_MIME_TYPE;
  readonly sha256: string;
  readonly bytes: number;
  readonly text: string;
}

export interface DrawingProjectionView {
  readonly id: DrawingProjectionViewId;
  readonly label: string;
  readonly orientation: string;
  readonly svg: DrawingProjectionSvg;
}

export interface DrawingProjection extends Record<string, unknown> {
  readonly schemaVersion: typeof DRAWING_PROJECTION_SCHEMA;
  readonly kind: "drawing-projection";
  readonly sourceStep: DrawingProjectionSourceStep;
  readonly engine: typeof DRAWING_PROJECTION_ENGINE;
  readonly method: typeof DRAWING_PROJECTION_METHOD;
  readonly envelopeMm: readonly [number, number, number];
  readonly views: readonly DrawingProjectionView[];
}

export class Projection2dInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Projection2dInputError";
  }
}

export class Projection2dGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Projection2dGenerationError";
  }
}

interface ParsedProjectionInput {
  readonly sourceStep: DrawingProjectionSourceStep;
  readonly bytes: Uint8Array;
  readonly includeSection: boolean;
}

/**
 * Rehash and privately stage one exact STEP before invoking the fixed harness.
 * No caller path, Python, camera, projection style, or section plane crosses
 * this interface.
 */
export async function projectStep2d(
  value: unknown,
  dependencies: ProjectStep2dDependencies = {},
): Promise<DrawingProjection> {
  const input = await parseProjectionInput(
    value,
    dependencies.resolveOwnedStep,
  );
  const temporaryDirectory = await Deno.makeTempDir({
    prefix: "build123d-projection-2d-",
  });
  try {
    const stagedStep = join(temporaryDirectory, "source.step");
    await Deno.writeFile(stagedStep, input.bytes, { mode: 0o600 });
    const response = await runProjectionHarness(
      stagedStep,
      input.sourceStep,
      input.includeSection,
    );
    return await parseDrawingProjection(
      response,
      input.sourceStep,
      input.includeSection,
    );
  } finally {
    await Deno.remove(temporaryDirectory, { recursive: true }).catch(() =>
      undefined
    );
  }
}

async function parseProjectionInput(
  value: unknown,
  resolveOwnedStep?: OwnedStepResolver,
): Promise<ParsedProjectionInput> {
  const root = inputRecord(value, "$input");
  const keys = Object.keys(root);
  if (
    keys.some((key) =>
      !["step", "stepResource", "includeSection"].includes(key)
    )
  ) {
    throw new Projection2dInputError("$input has an unsupported shape.");
  }
  const hasStep = Object.hasOwn(root, "step");
  const hasResource = Object.hasOwn(root, "stepResource");
  if (hasStep === hasResource) {
    throw new Projection2dInputError(
      "$input must contain exactly one of step or stepResource.",
    );
  }
  if (
    Object.hasOwn(root, "includeSection") &&
    typeof root.includeSection !== "boolean"
  ) {
    throw new Projection2dInputError("$input.includeSection must be boolean.");
  }
  const includeSection = root.includeSection === true;
  const parsed = hasStep
    ? await parseInlineStep(root.step)
    : await parseOwnedStepResource(root.stepResource, resolveOwnedStep);
  return { ...parsed, includeSection };
}

async function parseInlineStep(
  value: unknown,
): Promise<Omit<ParsedProjectionInput, "includeSection">> {
  const step = exactInputRecord(
    value,
    ["mimeType", "sha256", "bytes", "blob"],
    "$input.step",
  );
  const claimed = parseClaimedStepIdentity(step, "$input.step", {
    maximumBytes: PROJECTION_2D_MAXIMUM_STEP_BYTES,
  });
  if (typeof step.blob !== "string" || step.blob.length === 0) {
    throw new Projection2dInputError(
      "$input.step.blob must be canonical padded base64.",
    );
  }
  const bytes = decodeCanonicalBase64(step.blob);
  return await verifiedParsedStep(bytes, claimed, "$input.step");
}

async function parseOwnedStepResource(
  value: unknown,
  resolveOwnedStep?: OwnedStepResolver,
): Promise<Omit<ParsedProjectionInput, "includeSection">> {
  const resource = exactInputRecord(
    value,
    ["uri", "mimeType", "sha256", "bytes"],
    "$input.stepResource",
  );
  const claimed = parseClaimedStepIdentity(resource, "$input.stepResource", {
    maximumBytes: BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  });
  if (typeof resource.uri !== "string") {
    throw new Projection2dInputError(
      "$input.stepResource.uri must be a canonical STEP artifact URI.",
    );
  }
  const uriSha256 = parseBuild123dStepArtifactUri(resource.uri);
  if (uriSha256 === undefined) {
    throw new Projection2dInputError(
      "$input.stepResource.uri is not a canonical current-process STEP artifact URI.",
    );
  }
  if (uriSha256 !== claimed.sha256) {
    throw new Projection2dInputError(
      "$input.stepResource.sha256 does not match its canonical URI.",
    );
  }
  if (!resolveOwnedStep) {
    throw new Projection2dInputError(
      "$input.stepResource was not issued by this server process.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await resolveOwnedStep({
      uri: resource.uri,
      mimeType: STEP_MIME_TYPE,
      sha256: claimed.sha256,
      bytes: claimed.bytes,
    });
  } catch (error) {
    if (error instanceof Projection2dInputError) throw error;
    if (error instanceof Build123dArtifactError) {
      throw new Projection2dInputError(
        `$input.stepResource: ${error.message}`,
      );
    }
    throw new Projection2dInputError(
      "$input.stepResource was not issued by this server process.",
    );
  }
  return await verifiedParsedStep(bytes, claimed, "$input.stepResource");
}

function parseClaimedStepIdentity(
  value: Record<string, unknown>,
  path: string,
  bounds: { readonly maximumBytes: number },
): DrawingProjectionSourceStep {
  if (value.mimeType !== STEP_MIME_TYPE) {
    throw new Projection2dInputError(`${path}.mimeType must be model/step.`);
  }
  if (typeof value.sha256 !== "string" || !SHA256_HEX.test(value.sha256)) {
    throw new Projection2dInputError(
      `${path}.sha256 must be lowercase SHA-256.`,
    );
  }
  if (!positiveSafeInteger(value.bytes) || value.bytes > bounds.maximumBytes) {
    throw new Projection2dInputError(
      `${path}.bytes must be a positive integer at most ${bounds.maximumBytes}.`,
    );
  }
  return {
    mimeType: STEP_MIME_TYPE,
    sha256: value.sha256,
    bytes: value.bytes,
  };
}

async function verifiedParsedStep(
  bytes: Uint8Array,
  claimed: DrawingProjectionSourceStep,
  path: string,
): Promise<Omit<ParsedProjectionInput, "includeSection">> {
  if (bytes.byteLength !== claimed.bytes) {
    throw new Projection2dInputError(
      `${path}.bytes does not equal verified STEP length.`,
    );
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== claimed.sha256) {
    throw new Projection2dInputError(
      `${path}.sha256 does not equal verified STEP bytes.`,
    );
  }
  validatePart21(bytes, path);
  return {
    sourceStep: { mimeType: STEP_MIME_TYPE, sha256, bytes: bytes.byteLength },
    bytes,
  };
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length > PROJECTION_2D_MAXIMUM_BASE64_CHARACTERS) {
    throw new Projection2dInputError(
      "$input.step.blob exceeds the inline STEP bound.",
    );
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Projection2dInputError(
      "$input.step.blob must be canonical padded base64.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.fromBase64(value);
  } catch {
    throw new Projection2dInputError("$input.step.blob is not base64.");
  }
  if (
    bytes.byteLength > PROJECTION_2D_MAXIMUM_STEP_BYTES ||
    bytes.toBase64() !== value
  ) {
    throw new Projection2dInputError(
      "$input.step.blob is not canonical padded base64.",
    );
  }
  return bytes;
}

function validatePart21(bytes: Uint8Array, path: string): void {
  const source = path === "$input.step" ? `${path}.blob` : path;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Projection2dInputError(
      `${source} must be UTF-8 STEP Part 21 bytes.`,
    );
  }
  if (
    !text.startsWith("ISO-10303-21;") ||
    !text.trimEnd().endsWith("END-ISO-10303-21;") ||
    text.includes("\0") ||
    !/\bHEADER;[\s\S]*?ENDSEC;[\s\S]*?\bDATA;[\s\S]*?ENDSEC;/.test(text)
  ) {
    throw new Projection2dInputError(
      `${source} must contain one complete STEP Part 21 exchange.`,
    );
  }
}

async function runProjectionHarness(
  stepPath: string,
  sourceStep: DrawingProjectionSourceStep,
  includeSection: boolean,
): Promise<unknown> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(pythonBin(), {
      args: ["-I", "-B", "-c", PROJECTION_2D_HARNESS_SOURCE],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Projection2dGenerationError(
        "The configured Python interpreter is unavailable.",
      );
    }
    throw error;
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The fixed harness may already have exited.
    }
  }, PROJECTION_2D_TIMEOUT_MS);
  const result = collectBoundedChildOutput(child, {
    maximumStdoutBytes: MAXIMUM_HARNESS_RESPONSE_BYTES,
    maximumStderrBytes: MAXIMUM_HARNESS_STDERR_BYTES,
    terminate: () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The fixed harness may already have exited at an output boundary.
      }
    },
  });
  let inputWriteFailed = false;
  const writer = child.stdin.getWriter();
  try {
    await writer.write(
      new TextEncoder().encode(JSON.stringify({
        stepPath,
        sourceStep,
        includeSection,
      })),
    );
    await writer.close();
  } catch {
    inputWriteFailed = true;
    await writer.close().catch(() => undefined);
  }
  let stdout: Uint8Array;
  let stderr: Uint8Array;
  let success: boolean;
  try {
    ({ stdout, stderr, success } = await result);
  } catch (error) {
    if (error instanceof ProcessOutputLimitError) {
      throw new Projection2dGenerationError(
        "The fixed 2D projection harness produced no bounded response.",
      );
    }
    throw new Projection2dGenerationError(
      "The fixed 2D projection harness failed or timed out.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (inputWriteFailed || !success || stderr.byteLength !== 0) {
    throw new Projection2dGenerationError(
      "The fixed 2D projection harness failed or wrote stderr.",
    );
  }
  if (
    stdout.byteLength === 0 ||
    stdout.byteLength > MAXIMUM_HARNESS_RESPONSE_BYTES
  ) {
    throw new Projection2dGenerationError(
      "The fixed 2D projection harness produced no bounded response.",
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(stdout),
    );
  } catch {
    throw new Projection2dGenerationError(
      "The fixed 2D projection harness produced invalid JSON.",
    );
  }
  const root = outputRecord(response, "$harnessResponse");
  if (
    root.ok === true && Object.keys(root).length === 2 &&
    Object.hasOwn(root, "projection")
  ) {
    return root.projection;
  }
  if (root.ok === false && typeof root.error === "string") {
    throw new Projection2dGenerationError(
      "The fixed 2D projection harness could not project the STEP.",
    );
  }
  throw new Projection2dGenerationError(
    "The fixed 2D projection harness response is unsupported.",
  );
}

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

/** Validate the closed worker result and recross every identity and SVG byte. */
export async function parseDrawingProjection(
  value: unknown,
  expectedSourceStep: DrawingProjectionSourceStep,
  includeSection: boolean,
): Promise<DrawingProjection> {
  const root = exactOutputRecord(value, [
    "schemaVersion",
    "kind",
    "sourceStep",
    "engine",
    "method",
    "envelopeMm",
    "views",
  ], "$drawingProjection");
  if (root.schemaVersion !== DRAWING_PROJECTION_SCHEMA) {
    throw new Projection2dGenerationError(
      "The drawing projection schemaVersion is unsupported.",
    );
  }
  if (root.kind !== "drawing-projection") {
    throw new Projection2dGenerationError(
      "The drawing projection kind is unsupported.",
    );
  }

  const sourceStep = parseOutputSourceStep(root.sourceStep);
  if (
    sourceStep.mimeType !== expectedSourceStep.mimeType ||
    sourceStep.sha256 !== expectedSourceStep.sha256 ||
    sourceStep.bytes !== expectedSourceStep.bytes
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection source differs from the exact supplied STEP.",
    );
  }
  assertFixedEngine(root.engine);
  assertFixedMethod(root.method);
  const envelopeMm = parseEnvelope(root.envelopeMm);
  const views = await parseViews(root.views, includeSection);

  return {
    schemaVersion: DRAWING_PROJECTION_SCHEMA,
    kind: "drawing-projection",
    sourceStep,
    engine: DRAWING_PROJECTION_ENGINE,
    method: DRAWING_PROJECTION_METHOD,
    envelopeMm,
    views,
  };
}

function parseOutputSourceStep(value: unknown): DrawingProjectionSourceStep {
  const root = exactOutputRecord(
    value,
    ["mimeType", "sha256", "bytes"],
    "$drawingProjection.sourceStep",
  );
  if (
    root.mimeType !== STEP_MIME_TYPE ||
    typeof root.sha256 !== "string" ||
    !SHA256_HEX.test(root.sha256) ||
    !positiveSafeInteger(root.bytes) ||
    root.bytes > PROJECTION_2D_MAXIMUM_STEP_BYTES
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection sourceStep is invalid.",
    );
  }
  return {
    mimeType: STEP_MIME_TYPE,
    sha256: root.sha256,
    bytes: root.bytes,
  };
}

function assertFixedEngine(value: unknown): void {
  const root = exactOutputRecord(
    value,
    ["build123d", "ocp"],
    "$drawingProjection.engine",
  );
  if (
    root.build123d !== DRAWING_PROJECTION_ENGINE.build123d ||
    root.ocp !== DRAWING_PROJECTION_ENGINE.ocp
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection engine is unsupported.",
    );
  }
}

function assertFixedMethod(value: unknown): void {
  const root = exactOutputRecord(
    value,
    ["id", "version"],
    "$drawingProjection.method",
  );
  if (
    root.id !== DRAWING_PROJECTION_METHOD.id ||
    root.version !== DRAWING_PROJECTION_METHOD.version
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection method is unsupported.",
    );
  }
}

function parseEnvelope(value: unknown): readonly [number, number, number] {
  if (
    !Array.isArray(value) || value.length !== 3 ||
    value.some((entry) =>
      typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 ||
      Object.is(entry, -0)
    )
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection envelope must contain three positive finite millimetre dimensions.",
    );
  }
  return [value[0], value[1], value[2]] as [number, number, number];
}

async function parseViews(
  value: unknown,
  includeSection: boolean,
): Promise<readonly DrawingProjectionView[]> {
  if (
    !Array.isArray(value) || value.length < REQUIRED_VIEW_SPECS.length ||
    value.length > PROJECTION_2D_MAXIMUM_VIEWS ||
    (!includeSection && value.length !== REQUIRED_VIEW_SPECS.length)
  ) {
    throw new Projection2dGenerationError(
      "The drawing projection has an unsupported view set.",
    );
  }
  const specs = value.length === REQUIRED_VIEW_SPECS.length
    ? REQUIRED_VIEW_SPECS
    : [...REQUIRED_VIEW_SPECS, SECTION_VIEW_SPEC];
  const views: DrawingProjectionView[] = [];
  let totalSvgBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const spec = specs[index]!;
    const root = exactOutputRecord(
      value[index],
      ["id", "label", "orientation", "svg"],
      `$drawingProjection.views[${index}]`,
    );
    if (
      root.id !== spec.id || root.label !== spec.label ||
      root.orientation !== spec.orientation
    ) {
      throw new Projection2dGenerationError(
        `$drawingProjection.views[${index}] is not the fixed canonical view.`,
      );
    }
    const svg = await parseSvg(
      root.svg,
      `$drawingProjection.views[${index}].svg`,
    );
    totalSvgBytes += svg.bytes;
    if (totalSvgBytes > PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES) {
      throw new Projection2dGenerationError(
        "The drawing projection exceeds the total SVG byte bound.",
      );
    }
    views.push({
      id: spec.id,
      label: spec.label,
      orientation: spec.orientation,
      svg,
    });
  }
  return views;
}

async function parseSvg(
  value: unknown,
  path: string,
): Promise<DrawingProjectionSvg> {
  const root = exactOutputRecord(
    value,
    ["mimeType", "sha256", "bytes", "text"],
    path,
  );
  if (
    root.mimeType !== SVG_MIME_TYPE ||
    typeof root.sha256 !== "string" ||
    !SHA256_HEX.test(root.sha256) ||
    !positiveSafeInteger(root.bytes) ||
    root.bytes > PROJECTION_2D_MAXIMUM_SVG_BYTES ||
    typeof root.text !== "string" ||
    root.text.length > PROJECTION_2D_MAXIMUM_SVG_BYTES
  ) {
    throw new Projection2dGenerationError(`${path} metadata is invalid.`);
  }
  const bytes = new TextEncoder().encode(root.text);
  if (
    bytes.byteLength !== root.bytes ||
    await sha256Hex(bytes) !== root.sha256
  ) {
    throw new Projection2dGenerationError(
      `${path} identity differs from its exact UTF-8 bytes.`,
    );
  }
  if (!isSafeProjectionSvg(root.text)) {
    throw new Projection2dGenerationError(`${path} markup is unsafe.`);
  }
  return {
    mimeType: SVG_MIME_TYPE,
    sha256: root.sha256,
    bytes: root.bytes,
    text: root.text,
  };
}

/**
 * SVG is displayed through an image blob URL, never inserted into the App DOM.
 * Reject active markup, external references and CSS URL obfuscation before the
 * already digest-checked bytes can reach the image decoder.
 */
export function isSafeProjectionSvg(text: string): boolean {
  const source = text.trimStart().replace(/^\uFEFF/, "");
  if (!/^(?:<\?xml\s[^?]*\?>\s*)?<svg(?:\s|>)/i.test(source)) return false;

  // Numeric references cannot form XML names, but decoding them also catches
  // attempts to hide a CSS url() or scheme inside a presentation attribute.
  const scan = source.replace(
    /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
    (_match, hex: string | undefined, decimal: string | undefined) => {
      const code = Number.parseInt(hex ?? decimal ?? "", hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    },
  );
  const withoutDeclaration = scan.replace(/^<\?xml\s[^?]*\?>\s*/i, "");

  return !(
    /<\s*\/?\s*(?:[\w.-]+:)?(?:script|style|foreignObject|image|feImage|iframe|object|embed|audio|video|link|meta|a|use|animate|animateMotion|animateTransform|set|discard)\b/i
      .test(scan) ||
    /<!(?:DOCTYPE|ENTITY|\[CDATA\[)/i.test(scan) ||
    /<\?/.test(withoutDeclaration) ||
    /(?:^|[\s<])(?:[\w.-]+:)?(?:href|src|style)\s*=/i.test(scan) ||
    /(?:^|[\s<])on[a-z][\w:.-]*\s*=/i.test(scan) ||
    /(?:url\s*\(|javascript\s*:|@import\b)/i.test(scan) ||
    /\\|\/\*/.test(scan)
  );
}

function inputRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Projection2dInputError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactInputRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const root = inputRecord(value, path);
  if (
    Object.keys(root).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(root, key))
  ) {
    throw new Projection2dInputError(`${path} has an unsupported shape.`);
  }
  return root;
}

function outputRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Projection2dGenerationError(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactOutputRecord(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  const root = outputRecord(value, path);
  if (
    Object.keys(root).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(root, key))
  ) {
    throw new Projection2dGenerationError(`${path} has an unsupported shape.`);
  }
  return root;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
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
