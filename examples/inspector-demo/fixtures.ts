/** Exact saved payloads for local Inspector tools, checked before serving. */

import { dirname, fromFileUrl, join } from "@std/path";
import { parseAssemblyObservation } from "../../src/ui/results-viewer/src/assembly-contract.ts";
import {
  ASSEMBLY_PRESENTATION_META_KEY,
  ASSEMBLY_PRESENTATION_SCHEMA,
} from "../../src/ui/results-viewer/src/assembly-model.ts";
import { parseDrawingProjection } from "../../src/ui/results-viewer/src/drawing-contract.ts";

const here = dirname(fromFileUrl(import.meta.url));

interface Identity {
  readonly sha256: string;
  readonly bytes: number;
}

interface AssemblyCase {
  readonly sourceCapture: Identity;
  readonly sourceStep: Identity;
  readonly labels: Readonly<Record<string, string>>;
}

interface AssemblyManifest {
  readonly cases: Record<"tps03" | "msm01", AssemblyCase>;
}

interface DrawingManifest {
  readonly sourceStep: Identity;
  readonly engine: { readonly build123d: string; readonly ocp: string };
  readonly envelopeMm: readonly number[];
  readonly views: readonly {
    readonly id: string;
    readonly label: string;
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
}

export interface InspectorFixture {
  readonly name: string;
  readonly title: string;
  readonly viewer: "assembly" | "drawing";
  readonly result: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path)) as Record<string, unknown>;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))
    .toHex();
}

async function checkedBytes(
  path: string,
  identity: Identity,
): Promise<Uint8Array> {
  const bytes = await Deno.readFile(path);
  if (
    bytes.byteLength !== identity.bytes ||
    await digest(bytes) !== identity.sha256
  ) {
    throw new Error(`Fixture identity mismatch: ${path}`);
  }
  return bytes;
}

const drawingViews = {
  top: {
    label: "Top",
    orientation: "Orthographic projection along -Z",
  },
  front: {
    label: "Front",
    orientation: "Orthographic projection along +Y",
  },
  right: {
    label: "Right",
    orientation: "Orthographic projection along -X",
  },
  isometric: {
    label: "Isometric",
    orientation: "Orthographic projection along (-1,-1,-1)",
  },
  "section-yz": {
    label: "Section YZ",
    orientation: "YZ section at envelope midpoint X",
  },
};

/** The old L3 captures remain provenance, while Apps receive direct schemas. */
export async function loadInspectorFixtures(): Promise<
  readonly InspectorFixture[]
> {
  const assemblyManifest = await readJson(
    join(here, "assembly/manifest.json"),
  ) as unknown as AssemblyManifest;
  const fixtures: InspectorFixture[] = [];
  for (const caseId of ["tps03", "msm01"] as const) {
    const metadata = assemblyManifest.cases[caseId];
    await checkedBytes(
      join(here, `assembly/${caseId}.json`),
      metadata.sourceCapture,
    );
    const result = await readJson(
      join(here, `assembly/${caseId}.observation.json`),
    );
    const parsed = parseAssemblyObservation(result);
    if (!parsed.ok) throw new Error(`${caseId}: ${parsed.error}`);
    if (
      parsed.value.inputArtifact.sha256 !== metadata.sourceStep.sha256 ||
      parsed.value.inputArtifact.bytes !== metadata.sourceStep.bytes
    ) {
      throw new Error(`${caseId}: source STEP identity differs from manifest`);
    }
    const occurrenceLabels = parsed.value.occurrences.status === "observed"
      ? parsed.value.occurrences.value.map((occurrence) => occurrence.label)
      : [];
    if (
      occurrenceLabels.length === 0 ||
      Object.keys(metadata.labels).length !== occurrenceLabels.length ||
      occurrenceLabels.some((label) =>
        typeof metadata.labels[label] !== "string"
      )
    ) {
      throw new Error(`${caseId}: display-name mapping is incomplete`);
    }
    fixtures.push({
      name: `assembly-${caseId}`,
      title: `Assembly observation · ${caseId.toUpperCase()}`,
      viewer: "assembly",
      result,
      meta: {
        [ASSEMBLY_PRESENTATION_META_KEY]: {
          schemaVersion: ASSEMBLY_PRESENTATION_SCHEMA,
          sourceStepSha256: metadata.sourceStep.sha256,
          names: Object.fromEntries(
            Object.entries(metadata.labels).map(([label, name]) => [
              label,
              presentationName(name),
            ]),
          ),
        },
      },
    });
  }

  const drawingManifest = await readJson(
    join(here, "drawing/manifest.json"),
  ) as unknown as DrawingManifest;
  const declaredViews = new Map(
    drawingManifest.views.map((view) => [view.id, view]),
  );
  const views = [];
  for (const [id, canonical] of Object.entries(drawingViews)) {
    const view = declaredViews.get(id);
    if (!view || view.file !== `${id}.svg`) {
      throw new Error(`Missing canonical drawing fixture view: ${id}`);
    }
    const bytes = await checkedBytes(join(here, "drawing", view.file), view);
    views.push({
      id,
      label: canonical.label,
      orientation: canonical.orientation,
      svg: {
        mimeType: "image/svg+xml",
        sha256: view.sha256,
        bytes: view.bytes,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      },
    });
  }
  const drawing: Record<string, unknown> = {
    schemaVersion: "io.casys.mcp-build123d.drawing-projection/1.0",
    kind: "drawing-projection",
    sourceStep: {
      mimeType: "model/step",
      sha256: drawingManifest.sourceStep.sha256,
      bytes: drawingManifest.sourceStep.bytes,
    },
    engine: drawingManifest.engine,
    method: { id: "build123d-step-svg-projection", version: "1.0" },
    envelopeMm: drawingManifest.envelopeMm,
    views,
  };
  const parsedDrawing = await parseDrawingProjection(drawing);
  if (!parsedDrawing.ok) throw new Error(`ID01: ${parsedDrawing.error}`);
  fixtures.push({
    name: "drawing-id01",
    title: "2D projection · ID01 CameraMountBracket",
    viewer: "drawing",
    result: drawing,
  });
  return fixtures;
}

function presentationName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}
