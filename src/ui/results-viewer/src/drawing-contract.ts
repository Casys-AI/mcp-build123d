/** Strict, digest-bound payload accepted by the production 2D projection App. */

import {
  DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
  DRAWING_PROJECTION_VIEW_SPECS,
} from "../../../projection-2d-view-specs.ts";
export {
  DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
};

export const DRAWING_PROJECTION_SCHEMA =
  "io.casys.mcp-build123d.drawing-projection/1.0" as const;

export const DRAWING_REQUIRED_VIEW_IDS = DRAWING_PROJECTION_REQUIRED_VIEW_IDS;

export const DRAWING_VIEW_IDS = [
  ...DRAWING_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
] as const;

export type DrawingViewId = typeof DRAWING_VIEW_IDS[number];

export interface DrawingSvg {
  readonly mimeType: "image/svg+xml";
  readonly sha256: string;
  readonly bytes: number;
  readonly text: string;
}

export interface DrawingView {
  readonly id: DrawingViewId;
  readonly label: string;
  readonly orientation: string;
  readonly svg: DrawingSvg;
}

export interface DrawingProjection {
  readonly schemaVersion: typeof DRAWING_PROJECTION_SCHEMA;
  readonly kind: "drawing-projection";
  readonly sourceStep: {
    readonly mimeType: "model/step";
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly engine: {
    readonly build123d: "0.11.1";
    readonly ocp: "7.9.3.1";
  };
  readonly method: {
    readonly id: "build123d-step-svg-projection";
    readonly version: "1.0";
  };
  readonly envelopeMm: readonly [number, number, number];
  readonly views: readonly DrawingView[];
}

export type ParseDrawingProjection =
  | { readonly ok: true; readonly value: DrawingProjection }
  | { readonly ok: false; readonly error: string };

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const MAX_STEP_BYTES = 128 * 1024 * 1024;
export const MAX_DRAWING_SVG_BYTES = 1024 * 1024;
export const MAX_DRAWING_SVG_TOTAL_BYTES = 4 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  const source = record(value);
  return source && Object.keys(source).length === keys.length &&
      keys.every((key) => Object.hasOwn(source, key))
    ? source
    : undefined;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) =>
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

/**
 * SVG is displayed through an image blob URL, never inserted into the App DOM.
 * Reject active markup, external references and CSS URL obfuscation before the
 * already digest-checked bytes can reach the image decoder.
 */
export function isSafeDrawingSvg(text: string): boolean {
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

/** Validate source identity, canonical views and every exact SVG byte. */
export async function parseDrawingProjection(
  value: unknown,
): Promise<ParseDrawingProjection> {
  const source = exactRecord(value, [
    "schemaVersion",
    "kind",
    "sourceStep",
    "engine",
    "method",
    "envelopeMm",
    "views",
  ]);
  if (!source) return { ok: false, error: "Drawing result must be an object" };
  if (source.schemaVersion !== DRAWING_PROJECTION_SCHEMA) {
    return { ok: false, error: "Unsupported drawing projection schema" };
  }
  if (source.kind !== "drawing-projection") {
    return { ok: false, error: "Drawing result kind is invalid" };
  }

  const sourceStep = exactRecord(source.sourceStep, [
    "mimeType",
    "sha256",
    "bytes",
  ]);
  if (
    !sourceStep || sourceStep.mimeType !== "model/step" ||
    !sha256(sourceStep.sha256) || !positiveInteger(sourceStep.bytes) ||
    sourceStep.bytes > MAX_STEP_BYTES
  ) {
    return { ok: false, error: "Source STEP identity is invalid" };
  }

  const engine = exactRecord(source.engine, ["build123d", "ocp"]);
  if (!engine || engine.build123d !== "0.11.1" || engine.ocp !== "7.9.3.1") {
    return { ok: false, error: "Drawing engine version is unsupported" };
  }

  const method = exactRecord(source.method, ["id", "version"]);
  if (
    !method || method.id !== "build123d-step-svg-projection" ||
    method.version !== "1.0"
  ) {
    return { ok: false, error: "Drawing projection method is unsupported" };
  }

  const envelope = source.envelopeMm;
  if (
    !Array.isArray(envelope) || envelope.length !== 3 ||
    !envelope.every((entry) =>
      typeof entry === "number" && Number.isFinite(entry) && entry > 0
    )
  ) {
    return {
      ok: false,
      error: "Drawing envelope must have three positive millimetre dimensions",
    };
  }

  if (
    !Array.isArray(source.views) ||
    (source.views.length !== DRAWING_REQUIRED_VIEW_IDS.length &&
      source.views.length !== DRAWING_VIEW_IDS.length)
  ) {
    return {
      ok: false,
      error:
        "Drawing must contain the four canonical views and an optional YZ section",
    };
  }

  const views: DrawingView[] = [];
  let totalSvgBytes = 0;
  for (const [index, entry] of source.views.entries()) {
    const view = exactRecord(entry, ["id", "label", "orientation", "svg"]);
    const expected = DRAWING_PROJECTION_VIEW_SPECS[index];
    const expectedId = expected?.id;
    if (
      !view || !expected || view.id !== expected.id ||
      view.label !== expected.label ||
      view.orientation !== expected.orientation
    ) {
      return {
        ok: false,
        error: `Drawing view ${index} must be the canonical ${expectedId} view`,
      };
    }

    const svg = exactRecord(view.svg, [
      "mimeType",
      "sha256",
      "bytes",
      "text",
    ]);
    if (
      !svg || svg.mimeType !== "image/svg+xml" || !sha256(svg.sha256) ||
      !positiveInteger(svg.bytes) || svg.bytes > MAX_DRAWING_SVG_BYTES ||
      typeof svg.text !== "string" || svg.text.length > MAX_DRAWING_SVG_BYTES
    ) {
      return {
        ok: false,
        error: `Drawing view ${expectedId} has invalid SVG metadata`,
      };
    }

    const bytes = encoder.encode(svg.text);
    if (bytes.byteLength !== svg.bytes) {
      return {
        ok: false,
        error: `Drawing view ${expectedId} SVG byte length differs`,
      };
    }
    totalSvgBytes += bytes.byteLength;
    if (totalSvgBytes > MAX_DRAWING_SVG_TOTAL_BYTES) {
      return {
        ok: false,
        error: "Drawing SVG payload exceeds the cumulative byte limit",
      };
    }
    if (await digestHex(bytes) !== svg.sha256) {
      return {
        ok: false,
        error: `Drawing view ${expectedId} SVG SHA-256 differs`,
      };
    }
    if (!isSafeDrawingSvg(svg.text)) {
      return {
        ok: false,
        error: `Drawing view ${expectedId} SVG markup is unsafe`,
      };
    }

    views.push({
      id: expectedId,
      label: expected.label,
      orientation: expected.orientation,
      svg: {
        mimeType: "image/svg+xml",
        sha256: svg.sha256,
        bytes: svg.bytes,
        text: svg.text,
      },
    });
  }

  return {
    ok: true,
    value: {
      schemaVersion: DRAWING_PROJECTION_SCHEMA,
      kind: "drawing-projection",
      sourceStep: {
        mimeType: "model/step",
        sha256: sourceStep.sha256,
        bytes: sourceStep.bytes,
      },
      engine: { build123d: "0.11.1", ocp: "7.9.3.1" },
      method: { id: "build123d-step-svg-projection", version: "1.0" },
      envelopeMm: [envelope[0], envelope[1], envelope[2]],
      views,
    },
  };
}
