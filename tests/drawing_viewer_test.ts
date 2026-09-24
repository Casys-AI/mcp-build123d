import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DRAWING_PROJECTION_SCHEMA,
  DRAWING_REQUIRED_VIEW_IDS,
  MAX_DRAWING_SVG_BYTES,
  parseDrawingProjection,
} from "../src/ui/results-viewer/src/drawing-contract.ts";
import {
  defaultDrawingViewId,
  drawingFacts,
  drawingMetrics,
  drawingStateFromToolResult,
  drawingViewOptions,
} from "../src/ui/results-viewer/src/drawing-model.ts";

const SOURCE_SHA256 = "a".repeat(64);
const VIEW_DEFINITIONS = [
  {
    id: "top",
    label: "Top",
    orientation: "Orthographic projection along -Z",
  },
  {
    id: "front",
    label: "Front",
    orientation: "Orthographic projection along +Y",
  },
  {
    id: "right",
    label: "Right",
    orientation: "Orthographic projection along -X",
  },
  {
    id: "isometric",
    label: "Isometric",
    orientation: "Orthographic projection along (-1,-1,-1)",
  },
  {
    id: "section-yz",
    label: "Section YZ",
    orientation: "YZ section at envelope midpoint X",
  },
] as const;

function svgText(id: string): string {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" ' +
    'height="10mm" viewBox="0 0 10 10">' +
    `<path id="${id}" d="M 1 1 L 9 9" fill="none" stroke="black"/>` +
    "</svg>";
}

async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return new Uint8Array(digest).toHex();
}

async function view(
  id: string,
  label: string,
  orientation: string,
  text = svgText(id),
) {
  return {
    id,
    label,
    orientation,
    svg: {
      mimeType: "image/svg+xml",
      sha256: await digestHex(text),
      bytes: new TextEncoder().encode(text).byteLength,
      text,
    },
  };
}

async function drawingFixture(includeSection = true) {
  const definitions = includeSection
    ? VIEW_DEFINITIONS
    : VIEW_DEFINITIONS.slice(0, DRAWING_REQUIRED_VIEW_IDS.length);
  return {
    schemaVersion: DRAWING_PROJECTION_SCHEMA,
    kind: "drawing-projection",
    sourceStep: {
      mimeType: "model/step",
      sha256: SOURCE_SHA256,
      bytes: 48_786,
    },
    engine: { build123d: "0.11.1", ocp: "7.9.3.1" },
    method: { id: "build123d-step-svg-projection", version: "1.0" },
    envelopeMm: [35, 30, 35],
    views: await Promise.all(
      definitions.map((definition) =>
        view(definition.id, definition.label, definition.orientation)
      ),
    ),
  };
}

Deno.test("drawing viewer projects verified orthographic, isometric and section views", async () => {
  const parsed = await parseDrawingProjection(await drawingFixture());
  assertEquals(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error);

  assertEquals(
    drawingViewOptions(parsed.value).map(({ id }) => id),
    VIEW_DEFINITIONS.map(({ id }) => id),
  );
  assertEquals(defaultDrawingViewId(parsed.value), "top");
  assertEquals(
    drawingViewOptions(parsed.value).find(({ id }) => id === "section-yz")
      ?.orientation,
    "YZ section at envelope midpoint X",
  );

  const metrics = drawingMetrics(parsed.value);
  assert(metrics.filter(({ unit }) => unit === "mm").length >= 3);
  assertStringIncludes(JSON.stringify(metrics), "35");
  assertStringIncludes(JSON.stringify(metrics), "30");

  const facts = drawingFacts(parsed.value, "section-yz");
  assert(facts.length > 0);
  assertStringIncludes(JSON.stringify(facts), SOURCE_SHA256);
  assertStringIncludes(
    JSON.stringify(facts),
    "build123d-step-svg-projection",
  );
});

Deno.test("drawing viewer rejects altered SVG bytes or a false digest", async () => {
  const original = await drawingFixture();
  const altered = structuredClone(original);
  altered.views[0].svg.text = altered.views[0].svg.text.replace(
    "L 9 9",
    "L 8 8",
  );
  assertEquals((await parseDrawingProjection(altered)).ok, false);

  const wrongByteCount = structuredClone(original);
  wrongByteCount.views[0].svg.bytes += 1;
  assertEquals((await parseDrawingProjection(wrongByteCount)).ok, false);

  const wrongDigest = structuredClone(original);
  wrongDigest.views[0].svg.sha256 = "b".repeat(64);
  assertEquals((await parseDrawingProjection(wrongDigest)).ok, false);
});

Deno.test("drawing viewer bounds embedded SVGs and rejects undeclared payload fields", async () => {
  const original = await drawingFixture();
  assertEquals(
    (await parseDrawingProjection({ ...original, unexpected: true })).ok,
    false,
  );

  const extraViewField = structuredClone(original);
  Object.assign(extraViewField.views[0], { url: "https://example.invalid" });
  assertEquals((await parseDrawingProjection(extraViewField)).ok, false);

  const oversizedSvg = structuredClone(original);
  oversizedSvg.views[0].svg.bytes = MAX_DRAWING_SVG_BYTES + 1;
  assertEquals((await parseDrawingProjection(oversizedSvg)).ok, false);

  const oversizedStep = structuredClone(original);
  oversizedStep.sourceStep.bytes = 128 * 1024 * 1024 + 1;
  assertEquals((await parseDrawingProjection(oversizedStep)).ok, false);
});

Deno.test("drawing viewer rejects altered canonical labels and orientations", async () => {
  const original = await drawingFixture();
  const changedLabel = structuredClone(original);
  changedLabel.views[0].label = "Dessus";
  assertEquals((await parseDrawingProjection(changedLabel)).ok, false);

  const changedOrientation = structuredClone(original);
  changedOrientation.views[0].orientation = "XY";
  assertEquals((await parseDrawingProjection(changedOrientation)).ok, false);
});

Deno.test("drawing viewer rejects executable SVG even when its digest matches", async () => {
  for (
    const unsafeSvg of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0 L1 1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.invalid/a.css"</style></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:u\\72l(https://example.invalid/a)" d="M0 0 L1 1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="u\\72l(https://example.invalid/a)" d="M0 0 L1 1"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><image src="https://example.invalid/a.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="opacity" values="0;1"/></svg>',
    ]
  ) {
    const fixture = await drawingFixture();
    fixture.views[0] = await view(
      "top",
      "Top",
      "Orthographic projection along -Z",
      unsafeSvg,
    );
    assertEquals((await parseDrawingProjection(fixture)).ok, false);
  }
});

Deno.test("drawing viewer rejects ambiguous tabs and impossible model dimensions", async () => {
  const duplicate = await drawingFixture();
  duplicate.views[1].id = "top";
  assertEquals((await parseDrawingProjection(duplicate)).ok, false);

  const missingView = await drawingFixture();
  missingView.views.splice(2, 1);
  assertEquals((await parseDrawingProjection(missingView)).ok, false);

  const legacySheet = await drawingFixture();
  legacySheet.views[0] = await view("sheet", "Planche", "composite");
  assertEquals((await parseDrawingProjection(legacySheet)).ok, false);

  const impossible = await drawingFixture();
  impossible.envelopeMm[2] = 0;
  assertEquals((await parseDrawingProjection(impossible)).ok, false);
});

Deno.test("drawing viewer accepts the four production views without a section", async () => {
  const parsed = await parseDrawingProjection(await drawingFixture(false));
  assertEquals(parsed.ok, true);
  if (!parsed.ok) throw new Error(parsed.error);
  assertEquals(
    parsed.value.views.map(({ id }) => id),
    [...DRAWING_REQUIRED_VIEW_IDS],
  );
  assertEquals(defaultDrawingViewId(parsed.value), "top");
});

Deno.test("drawing viewer rejects SVG payloads over the cumulative bound", async () => {
  const largeSvg = (id: string) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
    `<desc>${id}${"x".repeat(900_000)}</desc>` +
    '<path d="M 1 1 L 9 9" fill="none" stroke="black"/></svg>';
  const fixture = await drawingFixture();
  fixture.views = await Promise.all(
    VIEW_DEFINITIONS.map((definition) =>
      view(
        definition.id,
        definition.label,
        definition.orientation,
        largeSvg(definition.id),
      )
    ),
  );
  assertEquals((await parseDrawingProjection(fixture)).ok, false);
});

Deno.test("drawing viewer distinguishes a valid tool result, tool failure and invalid payload", async () => {
  const success = await drawingStateFromToolResult({
    structuredContent: await drawingFixture(),
  });
  assertEquals(success.kind, "result");
  if (success.kind === "result") {
    assertEquals(success.result.views.length, VIEW_DEFINITIONS.length);
  }

  const toolError = await drawingStateFromToolResult({
    isError: true,
    content: [{ type: "text", text: "STEP projection failed" }],
  });
  assertEquals(toolError.kind, "error");
  if (toolError.kind === "error") {
    assertStringIncludes(String(toolError.message), "STEP projection failed");
  }

  const rejected = await drawingStateFromToolResult({
    structuredContent: { schemaVersion: "unrelated/1.0" },
  });
  assertEquals(rejected.kind, "error");
  if (rejected.kind === "error") {
    assert(rejected.code.length > 0);
  }
});

Deno.test("drawing viewer keeps deterministic dark SVG linework on a paper surface", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "../src/ui/results-viewer/src/drawing-components.tsx",
      import.meta.url,
    ),
  );
  assertStringIncludes(source, 'background: "#ffffff"');
  assertStringIncludes(source, 'color: "#334155"');
});
