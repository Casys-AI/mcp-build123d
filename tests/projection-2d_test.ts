/** Contract and real-engine tests for the fixed 2D inspection projector. */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { SchemaValidator } from "@casys/mcp-platform";
import {
  DRAWING_PROJECTION_ENGINE,
  DRAWING_PROJECTION_METHOD,
  DRAWING_PROJECTION_SCHEMA,
  type DrawingProjectionSourceStep,
  isSafeProjectionSvg,
  parseDrawingProjection,
  Projection2dGenerationError,
  Projection2dInputError,
  PROJECTION_2D_MAXIMUM_SVG_BYTES,
  PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES,
  projectStep2d,
} from "../src/api/projection-2d-bridge.ts";
import { PROJECTION_2D_HARNESS_SOURCE } from "../src/api/projection-2d-harness-source.ts";
import { isSafeDrawingSvg } from "../src/ui/results-viewer/src/drawing-contract.ts";
import {
  createProjection2dTools,
  PROJECTION_2D_INPUT_SCHEMA,
  PROJECTION_2D_OUTPUT_SCHEMA,
  PROJECTION_2D_TOOL,
} from "../src/tools/projection-2d.ts";

const FIXTURE_SOURCE = String.raw`
from build123d import Box, Location, export_step
import sys

# A translated, asymmetric box proves the fixed cameras look at the source
# envelope instead of assuming that geometry is centred on the world origin.
shape = Box(10, 20, 30).located(Location((100, 200, 300)))
export_step(shape, sys.argv[1], timestamp="1970-01-01T00:00:00Z")
`;

const PART21_STEP = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);

const VIEW_SPECS = [
  ["top", "Top", "Orthographic projection along -Z"],
  ["front", "Front", "Orthographic projection along +Y"],
  ["right", "Right", "Orthographic projection along -X"],
  [
    "isometric",
    "Isometric",
    "Orthographic projection along (-1,-1,-1)",
  ],
] as const;

const UNSAFE_SVG_CASES = [
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0L1 1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.invalid/a.css"</style></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><a><path d="M0 0L1 1"/></a></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><use href="#shape"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity" values="0;1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><animateMotion path="M0 0L1 1"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><animateTransform attributeName="transform"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="fill" to="red"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><discard begin="1s"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><filter><feImage href="https://example.invalid/a.png"/></filter></svg>',
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><?xml-stylesheet href="https://example.invalid/a.css"?></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><?target data?></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path fill="javascript:alert(1)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><text>@import evil</text></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(https://example.invalid/a)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u&#x72;l(https://example.invalid/a)"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><desc>java/* split */script:alert(1)</desc></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><image src="https://example.invalid/a.png"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><path xlink:href="https://example.invalid/a"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[url(https://example.invalid/a)]]></svg>',
] as const;

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

async function build123dRuntimeAvailable(): Promise<boolean> {
  try {
    return (await new Deno.Command(pythonBin(), {
      args: [
        "-c",
        "import build123d, OCP; assert build123d.__version__ == '0.11.1'; assert OCP.__version__ == '7.9.3.1'",
      ],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}

const BUILD123D_RUNTIME_AVAILABLE = await build123dRuntimeAvailable();

function backendTest(name: string, fn: () => Promise<void>): void {
  Deno.test({ name, ignore: !BUILD123D_RUNTIME_AVAILABLE, fn });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fixture(): Promise<{
  readonly input: Record<string, unknown>;
  readonly bytes: Uint8Array;
  readonly sourceStep: DrawingProjectionSourceStep;
  readonly clean: () => Promise<void>;
}> {
  const directory = await Deno.makeTempDir({ prefix: "projection-2d-test-" });
  const path = `${directory}/fixture.step`;
  const result = await new Deno.Command(pythonBin(), {
    args: ["-I", "-B", "-c", FIXTURE_SOURCE, path],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `could not create projection fixture: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  const bytes = await Deno.readFile(path);
  const sourceStep = {
    mimeType: "model/step" as const,
    sha256: await sha256Hex(bytes),
    bytes: bytes.byteLength,
  };
  return {
    input: { step: { ...sourceStep, blob: bytes.toBase64() } },
    bytes,
    sourceStep,
    clean: () => Deno.remove(directory, { recursive: true }),
  };
}

function structuredContent(value: unknown): Record<string, unknown> {
  return (value as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

async function syntheticProjection(
  sourceStep: DrawingProjectionSourceStep,
  includeSection = false,
): Promise<Record<string, unknown>> {
  const specs = includeSection
    ? [
      ...VIEW_SPECS,
      [
        "section-yz",
        "Section YZ",
        "YZ section at envelope midpoint X",
      ] as const,
    ]
    : VIEW_SPECS;
  const views = [];
  for (const [id, label, orientation] of specs) {
    const text =
      `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1" id="${id}"/></svg>`;
    const bytes = new TextEncoder().encode(text);
    views.push({
      id,
      label,
      orientation,
      svg: {
        mimeType: "image/svg+xml",
        sha256: await sha256Hex(bytes),
        bytes: bytes.byteLength,
        text,
      },
    });
  }
  return {
    schemaVersion: DRAWING_PROJECTION_SCHEMA,
    kind: "drawing-projection",
    sourceStep,
    engine: DRAWING_PROJECTION_ENGINE,
    method: DRAWING_PROJECTION_METHOD,
    envelopeMm: [10, 20, 30],
    views,
  };
}

async function withMissingPython(fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("BUILD123D_PYTHON_BIN");
  Deno.env.set(
    "BUILD123D_PYTHON_BIN",
    "/definitely/missing/build123d-projection-python",
  );
  try {
    await fn();
  } finally {
    if (previous === undefined) Deno.env.delete("BUILD123D_PYTHON_BIN");
    else Deno.env.set("BUILD123D_PYTHON_BIN", previous);
  }
}

Deno.test("2D projection schemas keep exclusive digest-bound STEP forms and fixed output bounds", async () => {
  const validator = new SchemaValidator();
  validator.addSchema("projection-input", PROJECTION_2D_INPUT_SCHEMA);
  validator.addSchema("projection-output", PROJECTION_2D_OUTPUT_SCHEMA);
  const digest = await sha256Hex(PART21_STEP);
  const inline = {
    step: {
      mimeType: "model/step",
      sha256: digest,
      bytes: PART21_STEP.byteLength,
      blob: PART21_STEP.toBase64(),
    },
    includeSection: true,
  };
  const resource = {
    stepResource: {
      uri: `casys://build123d/artifacts/${digest}.step`,
      mimeType: "model/step",
      sha256: digest,
      bytes: PART21_STEP.byteLength,
    },
  };
  assertEquals(validator.validate("projection-input", inline).valid, true);
  assertEquals(validator.validate("projection-input", resource).valid, true);
  assertEquals(validator.validate("projection-input", {}).valid, false);
  assertEquals(
    validator.validate("projection-input", { ...inline, ...resource }).valid,
    false,
  );
  assertEquals(
    validator.validate("projection-input", { ...inline, camera: "+Z" }).valid,
    false,
  );
  assertEquals(
    validator.validate("projection-input", {
      ...inline,
      includeSection: "yes",
    }).valid,
    false,
  );

  const output = await syntheticProjection({
    mimeType: "model/step",
    sha256: digest,
    bytes: PART21_STEP.byteLength,
  }, true);
  assertEquals(validator.validate("projection-output", output).valid, true);
  const changedLabel = structuredClone(output);
  (changedLabel.views as Array<Record<string, unknown>>)[0]!.label = "Dessus";
  assertEquals(
    validator.validate("projection-output", changedLabel).valid,
    false,
  );
  const changedOrientation = structuredClone(output);
  (changedOrientation.views as Array<Record<string, unknown>>)[0]!.orientation =
    "XY";
  assertEquals(
    validator.validate("projection-output", changedOrientation).valid,
    false,
  );
  const views = (PROJECTION_2D_OUTPUT_SCHEMA.properties as {
    views: { maxItems: number; description: string };
  }).views;
  assertEquals(views.maxItems, 5);
  assertStringIncludes(
    views.description,
    String(PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES),
  );
});

Deno.test("2D projection rejects identity and caller-controlled method fields before Python", async () => {
  const digest = await sha256Hex(PART21_STEP);
  const valid = {
    step: {
      mimeType: "model/step",
      sha256: digest,
      bytes: PART21_STEP.byteLength,
      blob: PART21_STEP.toBase64(),
    },
  };
  await withMissingPython(async () => {
    await assertRejects(
      () => projectStep2d({ ...valid, camera: "+Z" }),
      Projection2dInputError,
      "unsupported shape",
    );
    await assertRejects(
      () => projectStep2d({ ...valid, includeSection: "true" }),
      Projection2dInputError,
      "must be boolean",
    );
    await assertRejects(
      () =>
        projectStep2d({
          step: {
            ...(valid.step as Record<string, unknown>),
            sha256: "0".repeat(64),
          },
        }),
      Projection2dInputError,
      "verified STEP bytes",
    );
    await assertRejects(
      () => projectStep2d(valid),
      Projection2dGenerationError,
      "Python interpreter is unavailable",
    );
    await assertRejects(
      () =>
        projectStep2d({
          stepResource: {
            uri: `casys://build123d/artifacts/${digest}.step`,
            mimeType: "model/step",
            sha256: digest,
            bytes: PART21_STEP.byteLength,
          },
        }),
      Projection2dInputError,
      "not issued by this server process",
    );
  });
});

Deno.test("2D projection parser recrosses source, method, order, SVG identity and safe markup", async () => {
  const sourceStep = {
    mimeType: "model/step" as const,
    sha256: "a".repeat(64),
    bytes: 123,
  };
  const canonical = await syntheticProjection(sourceStep, true);
  const parsed = await parseDrawingProjection(canonical, sourceStep, true);
  assertEquals(parsed.views.map((view) => view.id), [
    "top",
    "front",
    "right",
    "isometric",
    "section-yz",
  ]);
  assertEquals(parsed.engine, DRAWING_PROJECTION_ENGINE);
  assertEquals(parsed.method, DRAWING_PROJECTION_METHOD);

  const wrongSource = structuredClone(canonical);
  (wrongSource.sourceStep as Record<string, unknown>).sha256 = "b".repeat(64);
  await assertRejects(
    () => parseDrawingProjection(wrongSource, sourceStep, true),
    Projection2dGenerationError,
    "differs from the exact supplied STEP",
  );

  const wrongOrder = structuredClone(canonical);
  const orderedViews = wrongOrder.views as unknown[];
  [orderedViews[0], orderedViews[1]] = [orderedViews[1], orderedViews[0]];
  await assertRejects(
    () => parseDrawingProjection(wrongOrder, sourceStep, true),
    Projection2dGenerationError,
    "fixed canonical view",
  );

  const wrongLabel = structuredClone(canonical);
  (wrongLabel.views as Array<Record<string, unknown>>)[0]!.label = "Dessus";
  await assertRejects(
    () => parseDrawingProjection(wrongLabel, sourceStep, true),
    Projection2dGenerationError,
    "fixed canonical view",
  );

  const wrongOrientation = structuredClone(canonical);
  (wrongOrientation.views as Array<Record<string, unknown>>)[0]!.orientation =
    "XY";
  await assertRejects(
    () => parseDrawingProjection(wrongOrientation, sourceStep, true),
    Projection2dGenerationError,
    "fixed canonical view",
  );

  const wrongDigest = structuredClone(canonical);
  const firstSvg = (wrongDigest.views as Array<Record<string, unknown>>)[0]!
    .svg as Record<string, unknown>;
  firstSvg.sha256 = "0".repeat(64);
  await assertRejects(
    () => parseDrawingProjection(wrongDigest, sourceStep, true),
    Projection2dGenerationError,
    "exact UTF-8 bytes",
  );

  for (const activeText of UNSAFE_SVG_CASES) {
    const active = structuredClone(canonical);
    const activeSvg = (active.views as Array<Record<string, unknown>>)[0]!
      .svg as Record<string, unknown>;
    const activeBytes = new TextEncoder().encode(activeText);
    activeSvg.text = activeText;
    activeSvg.bytes = activeBytes.byteLength;
    activeSvg.sha256 = await sha256Hex(activeBytes);
    await assertRejects(
      () => parseDrawingProjection(active, sourceStep, true),
      Projection2dGenerationError,
      "markup is unsafe",
    );
    assertEquals(isSafeProjectionSvg(activeText), false);
    assertEquals(isSafeDrawingSvg(activeText), false);
  }

  await assertRejects(
    () => parseDrawingProjection(canonical, sourceStep, false),
    Projection2dGenerationError,
    "unsupported view set",
  );
});

Deno.test("2D projection SVG safety policy stays identical to the drawing viewer", () => {
  const safeSvgCases = [
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>',
    '<?xml version="1.0" encoding="utf-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"><g transform="scale(1,-1)"><line x1="0" y1="0" x2="1" y2="1"/></g></svg>',
    '\uFEFF  <svg xmlns="http://www.w3.org/2000/svg"><desc>inspection only</desc></svg>',
  ];
  for (const text of [...safeSvgCases, ...UNSAFE_SVG_CASES]) {
    assertEquals(isSafeProjectionSvg(text), isSafeDrawingSvg(text));
  }
  for (const text of safeSvgCases) {
    assertEquals(isSafeProjectionSvg(text), true);
  }
});

Deno.test("2D projection parser enforces per-view and aggregate SVG bounds", async () => {
  const sourceStep = {
    mimeType: "model/step" as const,
    sha256: "a".repeat(64),
    bytes: 123,
  };
  const oversized = await syntheticProjection(sourceStep);
  const svg = ((oversized.views as Array<Record<string, unknown>>)[0]!)
    .svg as Record<string, unknown>;
  svg.bytes = PROJECTION_2D_MAXIMUM_SVG_BYTES + 1;
  await assertRejects(
    () => parseDrawingProjection(oversized, sourceStep, false),
    Projection2dGenerationError,
    "metadata is invalid",
  );

  const excessiveTotal = await syntheticProjection(sourceStep, true);
  const payloadCharacters = Math.floor(
    PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES / 5,
  ) + 1;
  for (const view of excessiveTotal.views as Array<Record<string, unknown>>) {
    const boundedSvg = view.svg as Record<string, unknown>;
    const text = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${
      "a".repeat(payloadCharacters)
    }</desc></svg>`;
    const bytes = new TextEncoder().encode(text);
    assertEquals(bytes.byteLength <= PROJECTION_2D_MAXIMUM_SVG_BYTES, true);
    boundedSvg.text = text;
    boundedSvg.bytes = bytes.byteLength;
    boundedSvg.sha256 = await sha256Hex(bytes);
  }
  await assertRejects(
    () => parseDrawingProjection(excessiveTotal, sourceStep, true),
    Projection2dGenerationError,
    "total SVG byte bound",
  );
});

Deno.test("embedded 2D projection harness is generated from the reviewed Python source", async () => {
  assertEquals(
    PROJECTION_2D_HARNESS_SOURCE,
    await Deno.readTextFile(
      new URL("../src/api/projection-2d-harness.py", import.meta.url),
    ),
  );
  const hiddenLayer = PROJECTION_2D_HARNESS_SOURCE.indexOf(
    'exporter.add_layer(\n        "Hidden"',
  );
  const visibleLayer = PROJECTION_2D_HARNESS_SOURCE.indexOf(
    'exporter.add_layer(\n        "Visible"',
  );
  const hiddenShape = PROJECTION_2D_HARNESS_SOURCE.indexOf(
    'exporter.add_shape(hidden, layer="Hidden")',
  );
  const visibleShape = PROJECTION_2D_HARNESS_SOURCE.indexOf(
    'exporter.add_shape(visible, layer="Visible")',
  );
  assert(hiddenLayer >= 0 && hiddenLayer < visibleLayer);
  assert(hiddenShape >= 0 && hiddenShape < visibleShape);
});

backendTest(
  "2D projection produces deterministic inline and owned-resource views plus the optional fixed section",
  async () => {
    const source = await fixture();
    try {
      const inline = await projectStep2d(source.input);
      assertEquals(inline.schemaVersion, DRAWING_PROJECTION_SCHEMA);
      assertEquals(inline.kind, "drawing-projection");
      assertEquals(inline.sourceStep, source.sourceStep);
      assertEquals(inline.engine, {
        build123d: "0.11.1",
        ocp: "7.9.3.1",
      });
      assertEquals(inline.method, {
        id: "build123d-step-svg-projection",
        version: "1.0",
      });
      assertEquals(inline.views.map((view) => view.id), [
        "top",
        "front",
        "right",
        "isometric",
      ]);
      assertEquals(inline.envelopeMm.length, 3);
      for (
        const [actual, expected] of inline.envelopeMm.map((value) =>
          Math.round(value)
        ).map((value, index) => [value, [10, 20, 30][index]!] as const)
      ) {
        assertEquals(actual, expected);
      }
      for (const view of inline.views) {
        const bytes = new TextEncoder().encode(view.svg.text);
        assertEquals(bytes.byteLength, view.svg.bytes);
        assertEquals(await sha256Hex(bytes), view.svg.sha256);
        assertEquals(view.svg.bytes <= PROJECTION_2D_MAXIMUM_SVG_BYTES, true);
        assertEquals(isSafeProjectionSvg(view.svg.text), true);
        const hiddenLayer = view.svg.text.indexOf('id="Hidden"');
        const visibleLayer = view.svg.text.indexOf('id="Visible"');
        assert(hiddenLayer >= 0, `${view.id} must emit its Hidden layer`);
        assert(
          visibleLayer > hiddenLayer,
          `${view.id} must paint Visible after Hidden`,
        );
      }

      let resolved = false;
      const resourceTool = createProjection2dTools({
        resolveOwnedStep: (resource) => {
          assertEquals(resource, {
            uri: `casys://build123d/artifacts/${source.sourceStep.sha256}.step`,
            ...source.sourceStep,
          });
          resolved = true;
          return Promise.resolve(source.bytes);
        },
      })[0]!;
      assertEquals(resourceTool.name, PROJECTION_2D_TOOL);
      const owned = structuredContent(
        await resourceTool.handler({
          stepResource: {
            uri: `casys://build123d/artifacts/${source.sourceStep.sha256}.step`,
            ...source.sourceStep,
          },
        }),
      );
      assertEquals(resolved, true);
      assertEquals(owned, inline);

      const sectioned = await projectStep2d({
        ...source.input,
        includeSection: true,
      });
      assertEquals(sectioned.views.map((view) => view.id), [
        "top",
        "front",
        "right",
        "isometric",
        "section-yz",
      ]);
      assertEquals(
        sectioned.views.slice(0, 4),
        inline.views,
      );
      const total = sectioned.views.reduce(
        (sum, view) => sum + view.svg.bytes,
        0,
      );
      assertEquals(total <= PROJECTION_2D_MAXIMUM_TOTAL_SVG_BYTES, true);

      const validator = new SchemaValidator();
      validator.addSchema(
        "projection-output-real",
        PROJECTION_2D_OUTPUT_SCHEMA,
      );
      assertEquals(
        validator.validate("projection-output-real", sectioned).valid,
        true,
      );
    } finally {
      await source.clean();
    }
  },
);
