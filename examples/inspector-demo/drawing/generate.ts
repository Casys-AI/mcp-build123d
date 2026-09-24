/** Regenerate the saved ID01 drawing fixture through the production projector. */

import { dirname, fromFileUrl, resolve } from "@std/path";
import {
  DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
  projectStep2d,
} from "../../../src/api/projection-2d-bridge.ts";

const STEP_SHA256 =
  "b821e5598b75449636eb57d0ea7db48ea560260ce56a6872ebeaec0f7691d201";
const CAPTURE_SHA256 =
  "ae70dd5928700f06d2434f410c15890ca3e1b007b5c781785a27a29d85781a01";
const CAPTURE_RUN = "run:id01-queue-camera-bracket-geometry-20260906";

interface Options {
  readonly step: string;
  readonly capture: string;
  readonly outputDir: string;
  readonly sourceReference?: string;
  readonly captureReference?: string;
}

const options = parseOptions(Deno.args);
const source = await Deno.readFile(options.step);
const sourceSha256 = await sha256(source);
if (sourceSha256 !== STEP_SHA256) {
  throw new Error(
    "Source STEP fingerprint differs from the recorded ID01 artifact",
  );
}

const captureBytes = await Deno.readFile(options.capture);
if (await sha256(captureBytes) !== CAPTURE_SHA256) {
  throw new Error(
    "Geometry capture fingerprint differs from the recorded ID01 artifact",
  );
}
const capture = JSON.parse(new TextDecoder().decode(captureBytes)) as {
  readonly schemaVersion?: unknown;
  readonly operation?: { readonly id?: unknown; readonly version?: unknown };
  readonly trustedRunId?: unknown;
  readonly sourceScript?: {
    readonly label?: unknown;
    readonly authoritativeStep?: {
      readonly fingerprint?: { readonly digest?: unknown };
      readonly bytes?: unknown;
    };
  };
};
const authoritativeStep = capture.sourceScript?.authoritativeStep;
if (
  capture.schemaVersion !== "geometry-part-capture/1.0" ||
  capture.operation?.id !== "design.write-geometry" ||
  capture.operation.version !== "1" ||
  capture.trustedRunId !== CAPTURE_RUN ||
  capture.sourceScript?.label !== "CameraMountBracket" ||
  authoritativeStep?.fingerprint?.digest !== STEP_SHA256 ||
  authoritativeStep?.bytes !== source.byteLength
) {
  throw new Error(
    "Capture does not link CameraMountBracket to the exact STEP artifact",
  );
}

const projection = await projectStep2d({
  step: {
    mimeType: "model/step",
    sha256: STEP_SHA256,
    bytes: source.byteLength,
    blob: source.toBase64(),
  },
  includeSection: true,
});
const expectedIds = [
  ...DRAWING_PROJECTION_REQUIRED_VIEW_IDS,
  DRAWING_PROJECTION_SECTION_VIEW_ID,
] as const;
if (
  projection.views.length !== expectedIds.length ||
  projection.views.some((view, index) => view.id !== expectedIds[index])
) {
  throw new Error(
    "The production projector did not return all five ID01 views",
  );
}

await Deno.mkdir(options.outputDir, { recursive: true });
for (const view of projection.views) {
  await Deno.writeTextFile(
    resolve(options.outputDir, `${view.id}.svg`),
    view.svg.text,
  );
}

const labels: Readonly<Record<string, string>> = {
  top: "Dessus",
  front: "Face",
  right: "Droite",
  isometric: "Isométrique",
  "section-yz": "Coupe YZ",
};
const manifest = {
  schemaVersion: "build123d-inspector-drawing/1.0",
  title: "CameraMountBracket — projections et coupe",
  project: "inspection-drone-id01",
  sourceStep: {
    reference: options.sourceReference ?? `sha256:${STEP_SHA256}`,
    sha256: STEP_SHA256,
    bytes: source.byteLength,
  },
  sourceCapture: {
    id: `geometry-${CAPTURE_SHA256}`,
    reference: options.captureReference ?? `sha256:${CAPTURE_SHA256}`,
    sha256: CAPTURE_SHA256,
    bytes: captureBytes.byteLength,
    producer: "digital-thread/design.write-geometry@1",
    runId: CAPTURE_RUN,
  },
  engine: projection.engine,
  method: projection.method,
  views: projection.views.map((view) => ({
    id: view.id,
    label: labels[view.id],
    file: `${view.id}.svg`,
    sha256: view.svg.sha256,
    bytes: view.svg.bytes,
  })),
  envelopeMm: projection.envelopeMm,
  status: "saved-production-projection",
};
await Deno.writeTextFile(
  resolve(options.outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(
  `Saved ${projection.views.length} production SVG projections for ${STEP_SHA256}`,
);

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))
    .toHex();
}

function parseOptions(args: readonly string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: generate.ts --step <path> --capture <path> [--output-dir <path>]",
      );
    }
    values.set(name, value);
  }
  const step = values.get("--step");
  const capture = values.get("--capture");
  if (!step || !capture) {
    throw new Error("Both --step and --capture are required");
  }
  return {
    step,
    capture,
    outputDir: values.get("--output-dir") ??
      dirname(fromFileUrl(import.meta.url)),
    ...(values.has("--source-reference")
      ? { sourceReference: values.get("--source-reference") }
      : {}),
    ...(values.has("--capture-reference")
      ? { captureReference: values.get("--capture-reference") }
      : {}),
  };
}
