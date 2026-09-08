/** Real STEP/XCAF contract tests for the fixed assembly-integrity observer. */

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { SchemaValidator } from "@casys/mcp-server";
import {
  ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS,
  ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES,
  ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
  type AssemblyIntegrityInputArtifact,
  AssemblyIntegrityInputError,
  AssemblyIntegrityObservationError,
  observeAssemblyIntegrity,
  parseAssemblyIntegrityObservation,
} from "../src/api/assembly-integrity-bridge.ts";
import {
  BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  Build123dArtifactError,
  createBuild123dExportExecution,
} from "../src/artifacts.ts";
import { createCadMcpApp } from "../src/server-app.ts";
import {
  ASSEMBLY_INTEGRITY_TOOL,
  assemblyIntegrityTools,
  createAssemblyIntegrityTools,
} from "../src/tools/assembly-integrity.ts";
import type { CadMetrics } from "../src/api/python-bridge.ts";

const FIXTURE_SOURCE = String.raw`
from build123d import Box, Compound, Location, export_step
from pathlib import Path
import sys

destination = Path(sys.argv[1])
mode = sys.argv[2]

def occurrence(label, position=(0, 0, 0), rotation=(0, 0, 0)):
    shape = Box(1, 1, 1)
    shape.label = label
    shape.location = Location(position, rotation)
    return shape

if mode == "separated":
    root = Compound(children=[
        occurrence("alpha"),
        occurrence("bravo", (5, 7, 11), (0, 0, 90)),
    ], label="fixture-root")
elif mode == "contact":
    root = Compound(children=[
        occurrence("alpha"),
        occurrence("bravo", (1, 0, 0)),
    ], label="fixture-root")
elif mode == "intersection":
    root = Compound(children=[
        occurrence("alpha"),
        occurrence("bravo", (0.5, 0, 0)),
    ], label="fixture-root")
elif mode == "too-many":
    root = Compound(children=[
        occurrence(f"item-{index:02d}", (index * 3, 0, 0))
        for index in range(33)
    ], label="fixture-root")
elif mode == "single":
    # A plain STEPControl export has one free shape but no XCAF direct
    # components, so it proves the zero-component identity gap branch.
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    writer = STEPControl_Writer()
    writer.Transfer(Box(1, 1, 1).wrapped, STEPControl_AsIs)
    if writer.Write(str(destination)) != IFSelect_RetDone:
        raise RuntimeError("could not write plain STEP fixture")
    sys.exit(0)
elif mode == "multi-root":
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFApp import XCAFApp_Application
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    application = XCAFApp_Application.GetApplication_s()
    document = TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))
    application.NewDocument(TCollection_ExtendedString("MDTV-XCAF"), document)
    application.InitDocument(document)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(document.Main())
    shapes.AddShape(BRepPrimAPI_MakeBox(1, 1, 1).Shape(), False)
    shapes.AddShape(BRepPrimAPI_MakeBox(2, 2, 2).Shape(), False)
    writer = STEPCAFControl_Writer()
    if not writer.Transfer(document, STEPControl_AsIs):
        raise RuntimeError("could not transfer multi-root STEP fixture")
    if writer.Write(str(destination)) != IFSelect_RetDone:
        raise RuntimeError("could not write multi-root STEP fixture")
    sys.exit(0)
else:
    raise ValueError("unsupported fixture mode")

export_step(root, destination, timestamp="1970-01-01T00:00:00Z")
`;

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

async function build123dRuntimeAvailable(): Promise<boolean> {
  try {
    return (await new Deno.Command(pythonBin(), {
      args: ["-c", "import build123d, OCP"],
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

function observerHandler() {
  const tool = assemblyIntegrityTools.find((candidate) =>
    candidate.name === ASSEMBLY_INTEGRITY_TOOL
  );
  if (!tool) throw new Error("assembly-integrity tool is not registered");
  return tool.handler;
}

async function fixtureInput(mode: string): Promise<{
  input: Record<string, unknown>;
  bytes: Uint8Array;
  clean: () => Promise<void>;
}> {
  const directory = await Deno.makeTempDir({
    prefix: "assembly-integrity-test-",
  });
  const path = `${directory}/fixture.step`;
  const child = new Deno.Command(pythonBin(), {
    args: ["-I", "-B", "-c", FIXTURE_SOURCE, path, mode],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      `could not create ${mode} STEP fixture: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  const bytes = await Deno.readFile(path);
  return {
    input: {
      step: {
        mimeType: "model/step",
        sha256: await sha256Hex(bytes),
        bytes: bytes.byteLength,
        blob: bytes.toBase64(),
      },
    },
    bytes,
    clean: () => Deno.remove(directory, { recursive: true }),
  };
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

function structuredContent(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

function artifact(
  input: Record<string, unknown>,
): AssemblyIntegrityInputArtifact {
  const step = input.step as Record<string, unknown>;
  return {
    mimeType: "model/step",
    sha256: step.sha256 as string,
    bytes: step.bytes as number,
  };
}

function observedValue<T>(fact: Record<string, unknown>): T {
  assertEquals(fact.status, "observed");
  return fact.value as T;
}

backendTest(
  "assembly integrity observes exact labels, unit, placements and separated pair facts",
  async () => {
    const fixture = await fixtureInput("separated");
    try {
      const first = structuredContent(await observerHandler()(fixture.input));
      const second = structuredContent(await observerHandler()(fixture.input));
      assertEquals(second, first);

      assertEquals(
        first.schemaVersion,
        "build123d-assembly-integrity-observation/1.0",
      );
      assertEquals(first.kind, "assembly-integrity-observation");
      assertEquals(first.producer, {
        service: "mcp-build123d",
        packageVersion: "0.6.3",
        tool: "build123d_observe_assembly_integrity",
        engine: { name: "cadquery-ocp", version: "7.9.3.1" },
      });
      assertEquals(
        observedValue<string>(first.importability as Record<string, unknown>),
        "imported",
      );
      assertEquals(
        observedValue<string>(first.unitSystem as Record<string, unknown>),
        "mm",
      );
      assertEquals(
        observedValue<string>(
          (first.topology as Record<string, Record<string, unknown>>)
            .brepValidity,
        ),
        "valid",
      );

      const occurrences = observedValue<Array<Record<string, unknown>>>(
        first.occurrences as Record<string, unknown>,
      );
      assertEquals(occurrences.map((occurrence) => occurrence.label), [
        "alpha",
        "bravo",
      ]);
      const bravoTransform = observedValue<number[]>(
        occurrences[1]!.transform as Record<string, unknown>,
      );
      assertEquals(bravoTransform.slice(3, 4), [5]);
      assertEquals(bravoTransform.slice(7, 8), [7]);
      assertEquals(bravoTransform.slice(11, 12), [11]);
      assertAlmostEquals(bravoTransform[0]!, 0, 1e-12);
      assertEquals(bravoTransform[1], -1);
      assertEquals(bravoTransform[4], 1);
      assertAlmostEquals(bravoTransform[5]!, 0, 1e-12);
      assertEquals(bravoTransform.slice(12), [0, 0, 0, 1]);

      const pairs = observedValue<Array<Record<string, unknown>>>(
        first.pairs as Record<string, unknown>,
      );
      assertEquals(pairs.length, 1);
      assertEquals(pairs[0]!.firstLabel, "alpha");
      assertEquals(pairs[0]!.secondLabel, "bravo");
      assertEquals(pairs[0]!.linearToleranceMm, 0.000001);
      assertEquals(
        observedValue<string>(pairs[0]!.contact as Record<string, unknown>),
        "no-contact",
      );
      assertEquals(
        observedValue<number>(
          pairs[0]!.intersectionVolumeMm3 as Record<string, unknown>,
        ),
        0,
      );
      assertEquals(
        observedValue<number>(
          pairs[0]!.minimumDistanceMm as Record<string, unknown>,
        ) > 0.000001,
        true,
      );

      const tool = assemblyIntegrityTools[0]!;
      const validator = new SchemaValidator();
      validator.addSchema("assembly-integrity-input", tool.inputSchema);
      validator.addSchema("assembly-integrity-output", tool.outputSchema);
      assertEquals(
        validator.validate("assembly-integrity-input", fixture.input).valid,
        true,
      );
      assertEquals(
        validator.validate("assembly-integrity-output", first).valid,
        true,
      );
    } finally {
      await fixture.clean();
    }
  },
);

backendTest(
  "assembly integrity reports contact and intersection as separate factual metrics",
  async () => {
    for (const mode of ["contact", "intersection"] as const) {
      const fixture = await fixtureInput(mode);
      try {
        const observation = structuredContent(
          await observerHandler()(fixture.input),
        );
        const pair = observedValue<Array<Record<string, unknown>>>(
          observation.pairs as Record<string, unknown>,
        )[0]!;
        assertEquals(
          observedValue<string>(pair.contact as Record<string, unknown>),
          "contact",
        );
        assertEquals(
          observedValue<number>(
            pair.minimumDistanceMm as Record<string, unknown>,
          ),
          0,
        );
        const volume = observedValue<number>(
          pair.intersectionVolumeMm3 as Record<string, unknown>,
        );
        assertEquals(mode === "intersection" ? volume > 0 : volume === 0, true);
      } finally {
        await fixture.clean();
      }
    }
  },
);

backendTest(
  "assembly integrity preserves factual import failure and identity or bound gaps",
  async () => {
    const malformed = new TextEncoder().encode(
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('empty'),'2;1');\n" +
        "FILE_NAME('empty','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\n" +
        "ENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
    );
    const failedInput = {
      step: {
        mimeType: "model/step",
        sha256: await sha256Hex(malformed),
        bytes: malformed.byteLength,
        blob: malformed.toBase64(),
      },
    };
    const failed = structuredContent(await observerHandler()(failedInput));
    assertEquals(
      observedValue<string>(failed.importability as Record<string, unknown>),
      "failed",
    );
    assertEquals(
      (failed.occurrences as Record<string, unknown>).status,
      "unresolved",
    );
    assertEquals(
      (failed.pairs as Record<string, unknown>).status,
      "unresolved",
    );

    const single = await fixtureInput("single");
    const limited = await fixtureInput("too-many");
    try {
      const singleObservation = structuredContent(
        await observerHandler()(single.input),
      );
      assertEquals(
        (singleObservation.occurrences as Record<string, unknown>).status,
        "unresolved",
      );
      assertEquals(
        (singleObservation.occurrences as Record<string, unknown>).reason,
        "identity-missing",
      );
      assertEquals(
        (singleObservation.pairs as Record<string, unknown>).reason,
        "identity-missing",
      );

      const limitedObservation = structuredContent(
        await observerHandler()(limited.input),
      );
      assertEquals(
        (limitedObservation.occurrences as Record<string, unknown>).status,
        "unavailable",
      );
      assertEquals(
        (limitedObservation.pairs as Record<string, unknown>).status,
        "unavailable",
      );
    } finally {
      await single.clean();
      await limited.clean();
    }
  },
);

backendTest(
  "assembly integrity keeps a successful multi-root import distinct from identity",
  async () => {
    const fixture = await fixtureInput("multi-root");
    try {
      const observation = structuredContent(
        await observerHandler()(fixture.input),
      );
      assertEquals(
        observedValue<string>(
          observation.importability as Record<string, unknown>,
        ),
        "imported",
      );
      assertEquals(
        (observation.occurrences as Record<string, unknown>).status,
        "unresolved",
      );
      assertEquals(
        (observation.occurrences as Record<string, unknown>).reason,
        "identity-missing",
      );
      assertEquals(
        (observation.pairs as Record<string, unknown>).status,
        "unresolved",
      );
      assertEquals(
        (observation.topology as Record<string, Record<string, unknown>>)
          .solidCount.status,
        "observed",
      );
    } finally {
      await fixture.clean();
    }
  },
);

backendTest(
  "assembly integrity rejects tampered, nonclosed and noncanonical observations",
  async () => {
    const fixture = await fixtureInput("separated");
    try {
      const step = fixture.input.step as Record<string, unknown>;
      await assertRejects(
        async () =>
          await observerHandler()({
            step: { ...step, sha256: "0".repeat(64) },
          }),
        AssemblyIntegrityInputError,
        "sha256",
      );
      await assertRejects(
        async () =>
          await observerHandler()({ ...fixture.input, unexpected: true }),
        AssemblyIntegrityInputError,
        "unsupported shape",
      );

      const observation = structuredContent(
        await observerHandler()(fixture.input),
      );
      const tampered = structuredClone(observation) as Record<string, unknown>;
      const pairs = (tampered.pairs as Record<string, unknown>).value as Array<
        Record<string, unknown>
      >;
      ((pairs[0]!.minimumDistanceMm as Record<string, unknown>).value) = -0;
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(tampered, artifact(fixture.input)),
        AssemblyIntegrityObservationError,
        "non-negative finite",
      );

      const negativeZeroTopology = structuredClone(observation) as Record<
        string,
        unknown
      >;
      (((negativeZeroTopology.topology as Record<string, unknown>)
        .solidCount as Record<string, unknown>).value) = -0;
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(
            negativeZeroTopology,
            artifact(fixture.input),
          ),
        AssemblyIntegrityObservationError,
        "non-negative safe integer",
      );

      const reversedPair = structuredClone(observation) as Record<
        string,
        unknown
      >;
      const reversed = ((reversedPair.pairs as Record<string, unknown>)
        .value as Array<Record<string, unknown>>)[0]!;
      [reversed.firstLabel, reversed.secondLabel] = [
        reversed.secondLabel,
        reversed.firstLabel,
      ];
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(
            reversedPair,
            artifact(fixture.input),
          ),
        AssemblyIntegrityObservationError,
        "noncanonical pair",
      );

      const reflected = structuredClone(observation) as Record<string, unknown>;
      const transform = (((reflected.occurrences as Record<string, unknown>)
        .value as Array<Record<string, unknown>>)[0]!
        .transform as Record<string, unknown>).value as number[];
      transform[0] = -1;
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(reflected, artifact(fixture.input)),
        AssemblyIntegrityObservationError,
        "right-handed",
      );

      const forgedProducer = structuredClone(observation) as Record<
        string,
        unknown
      >;
      ((forgedProducer.producer as Record<string, unknown>).engine as Record<
        string,
        unknown
      >).version = "0";
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(
            forgedProducer,
            artifact(fixture.input),
          ),
        AssemblyIntegrityObservationError,
        "producer",
      );

      const overLimit = structuredClone(observation) as Record<string, unknown>;
      overLimit.occurrences = {
        status: "observed",
        value: Array.from(
          { length: ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES + 1 },
          (_, index) => ({
            label: `item-${index.toString().padStart(2, "0")}`,
            transform: { status: "unavailable", reason: "unsupported" },
          }),
        ),
      };
      assertThrows(
        () =>
          parseAssemblyIntegrityObservation(overLimit, artifact(fixture.input)),
        AssemblyIntegrityObservationError,
        "occurrence bound",
      );
    } finally {
      await fixture.clean();
    }
  },
);

Deno.test("assembly integrity rejects a nonzero or noisy private harness before receipt parsing", async () => {
  const bytes = new TextEncoder().encode(
    "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('fixture'),'2;1');\n" +
      "FILE_NAME('fixture','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\n" +
      "ENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
  );
  const input = {
    step: {
      mimeType: "model/step",
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      blob: bytes.toBase64(),
    },
  };
  const directory = await Deno.makeTempDir({
    prefix: "assembly-integrity-child-",
  });
  const previousPython = Deno.env.get("BUILD123D_PYTHON_BIN");
  try {
    for (
      const [name, exitCode, stderr] of [
        ["nonzero", "1", ""],
        ["stderr", "0", "noise"],
      ] as const
    ) {
      const executable = `${directory}/${name}`;
      await Deno.writeTextFile(
        executable,
        "#!/bin/sh\n" +
          "printf '%s\\n' '{\"ok\":true,\"observation\":{}}'\n" +
          (stderr ? `printf '%s\\n' '${stderr}' >&2\n` : "") +
          `exit ${exitCode}\n`,
        { mode: 0o700 },
      );
      Deno.env.set("BUILD123D_PYTHON_BIN", executable);
      await assertRejects(
        () => observeAssemblyIntegrity(input),
        AssemblyIntegrityObservationError,
        "failed or wrote stderr",
      );
    }
  } finally {
    if (previousPython === undefined) {
      Deno.env.delete("BUILD123D_PYTHON_BIN");
    } else {
      Deno.env.set("BUILD123D_PYTHON_BIN", previousPython);
    }
    await Deno.remove(directory, { recursive: true });
  }
});

const PART21_STEP = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('fixture'),'2;1');\n" +
    "FILE_NAME('fixture','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\n" +
    "ENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);
const STL_BYTES = new TextEncoder().encode("solid fixture\nendsolid fixture\n");
const GLB_BYTES = new Uint8Array([
  0x67,
  0x6c,
  0x54,
  0x46,
  2,
  0,
  0,
  0,
  12,
  0,
  0,
  0,
]);
const FIXTURE_METRICS: CadMetrics = {
  volume_mm3: 1000,
  area_mm2: 700,
  center_of_mass_mm: [5, 10, 2.5],
  bounding_box_mm: {
    min: [0, 0, 0],
    max: [10, 20, 5],
    size: [10, 20, 5],
  },
  solids: 1,
  faces: 6,
  edges: 12,
};

function assemblyInputSchema(): Record<string, unknown> {
  return assemblyIntegrityTools[0]!.inputSchema;
}

function schemaInlineStep(): Record<string, unknown> {
  return {
    step: {
      mimeType: "model/step",
      sha256: "0".repeat(64),
      bytes: 1,
      blob: "QQ==",
    },
  };
}

function schemaStepResource(
  sha256 = "0".repeat(64),
  bytes = 1,
): Record<string, unknown> {
  return {
    stepResource: {
      uri: `casys://build123d/artifacts/${sha256}.step`,
      mimeType: "model/step",
      sha256,
      bytes,
    },
  };
}

async function withMissingPython<T>(run: () => Promise<T>): Promise<T> {
  const previous = Deno.env.get("BUILD123D_PYTHON_BIN");
  Deno.env.set("BUILD123D_PYTHON_BIN", "/definitely-missing-build123d-python");
  try {
    return await run();
  } finally {
    if (previous === undefined) Deno.env.delete("BUILD123D_PYTHON_BIN");
    else Deno.env.set("BUILD123D_PYTHON_BIN", previous);
  }
}

async function withServerRoots<T>(
  run: (roots: {
    readonly exportsDirectory: string;
    readonly artifactsDirectory: string;
  }) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({
    prefix: "assembly-integrity-resource-",
  });
  const exportsDirectory = `${root}/delivery`;
  const artifactsDirectory = `${root}/artifacts`;
  await Deno.mkdir(exportsDirectory);
  try {
    return await run({ exportsDirectory, artifactsDirectory });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function testAssembly(
  exportsDirectory: string,
  artifactsDirectory: string,
) {
  return createCadMcpApp({
    exportDirectory: exportsDirectory,
    artifactDirectory: artifactsDirectory,
    viewerModuleUrl: "file:///test/server.ts",
    viewerFilesystem: { exists: () => false, readFile: () => "unreachable" },
  });
}

async function publishBytes(
  assembly: ReturnType<typeof testAssembly>,
  exportsDirectory: string,
  format: "step" | "stl" | "gltf",
  bytes: Uint8Array,
  name: string,
) {
  const extension = format === "gltf" ? "glb" : format;
  const path = `${exportsDirectory}/${name}.${extension}`;
  await Deno.writeFile(path, bytes);
  const exportFile = {
    format,
    path,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  };
  const [published] = await assembly.artifactStore.publishExports(
    [exportFile],
    await createBuild123dExportExecution({
      script: `# fixture ${name}\nresult = fixture`,
      formats: [format],
      name,
      metrics: FIXTURE_METRICS,
      exports: [exportFile],
    }),
  );
  return published.artifact;
}

function resourceArgs(artifact: {
  readonly uri: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: number;
}): Record<string, unknown> {
  return {
    stepResource: {
      uri: artifact.uri,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
  };
}

function wiredObserver(
  assembly: ReturnType<typeof testAssembly>,
): (args: Record<string, unknown>) => Promise<unknown> {
  const handler = assembly.toolsClient.buildHandlersMap().get(
    ASSEMBLY_INTEGRITY_TOOL,
  );
  if (!handler) throw new Error("wired assembly-integrity tool is missing");
  return async (args) => await handler(args);
}

Deno.test("assembly integrity schema keeps exclusive inline or owned STEP resource forms", () => {
  const validator = new SchemaValidator();
  validator.addSchema("assembly-integrity-input", assemblyInputSchema());
  const inline = schemaInlineStep();
  const resource = schemaStepResource();

  assertEquals(
    validator.validate("assembly-integrity-input", inline).valid,
    true,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", resource).valid,
    true,
  );
  assertEquals(validator.validate("assembly-integrity-input", {}).valid, false);
  assertEquals(
    validator.validate("assembly-integrity-input", { ...inline, ...resource })
      .valid,
    false,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", { ...inline, extra: true })
      .valid,
    false,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", {
      stepResource: {
        ...(resource.stepResource as Record<string, unknown>),
        format: "step",
      },
    }).valid,
    false,
  );
});

Deno.test("assembly integrity blob schema uses maxLength and keeps both size bounds", () => {
  const schema = assemblyInputSchema();
  const properties = schema.properties as {
    step: {
      properties: {
        bytes: { maximum: number };
        blob: { minLength: number; maxLength?: number; maximum?: number };
      };
    };
    stepResource: {
      properties: {
        bytes: { maximum: number };
        uri: { pattern: string };
      };
    };
  };
  assertEquals(
    properties.step.properties.bytes.maximum,
    ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
  );
  assertEquals(properties.step.properties.blob.minLength, 4);
  assertEquals(
    properties.step.properties.blob.maxLength,
    ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS,
  );
  assertEquals(properties.step.properties.blob.maximum, undefined);
  assertEquals(
    properties.stepResource.properties.bytes.maximum,
    BUILD123D_MAXIMUM_ARTIFACT_BYTES,
  );
  assertEquals(
    properties.stepResource.properties.uri.pattern,
    "^casys://build123d/artifacts/[a-f0-9]{64}\\.step$",
  );

  const validator = new SchemaValidator();
  validator.addSchema("assembly-integrity-input", schema);
  const inline = schemaInlineStep();
  const step = inline.step as Record<string, unknown>;
  assertEquals(
    validator.validate("assembly-integrity-input", {
      step: { ...step, blob: "QQ=" },
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", {
      step: { ...step, blob: "QQ==" },
    }).valid,
    true,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", {
      step: { ...step, bytes: 0 },
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", {
      step: { ...step, bytes: ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES + 1 },
    }).valid,
    false,
  );
  assertEquals(
    validator.validate("assembly-integrity-input", {
      step: { ...step, bytes: BUILD123D_MAXIMUM_ARTIFACT_BYTES + 1 },
    }).valid,
    true,
  );
  assertEquals(
    validator.validate(
      "assembly-integrity-input",
      schemaStepResource("0".repeat(64), BUILD123D_MAXIMUM_ARTIFACT_BYTES + 1),
    ).valid,
    false,
  );
  assertEquals(
    validator.validate(
      "assembly-integrity-input",
      schemaStepResource("0".repeat(64), ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES),
    ).valid,
    false,
  );
});

Deno.test("assembly integrity rejects exclusive-form violations before Python", async () => {
  const inline = schemaInlineStep();
  const resource = schemaStepResource();
  await withMissingPython(async () => {
    await assertRejects(
      () => observeAssemblyIntegrity({}),
      AssemblyIntegrityInputError,
      "unsupported shape",
    );
    await assertRejects(
      () => observeAssemblyIntegrity({ ...inline, ...resource }),
      AssemblyIntegrityInputError,
      "unsupported shape",
    );
    await assertRejects(
      () => observeAssemblyIntegrity({ ...inline, extra: true }),
      AssemblyIntegrityInputError,
      "unsupported shape",
    );
    await assertRejects(
      () =>
        observeAssemblyIntegrity({
          stepResource: {
            ...(resource.stepResource as Record<string, unknown>),
            format: "step",
          },
        }),
      AssemblyIntegrityInputError,
      "unsupported shape",
    );
  });
});

Deno.test("default assembly-integrity tools still accept inline STEP only through the library catalogue", async () => {
  const bytes = PART21_STEP;
  const input = {
    step: {
      mimeType: "model/step",
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      blob: bytes.toBase64(),
    },
  };
  await withMissingPython(async () => {
    await assertRejects(
      async () => await observerHandler()(input),
      AssemblyIntegrityObservationError,
      "Python interpreter is unavailable",
    );
    await assertRejects(
      async () => await observerHandler()(schemaStepResource()),
      AssemblyIntegrityInputError,
      "not issued by this server process",
    );
  });
});

Deno.test("owned STEP resolver returns rehashed current-process bytes", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const artifact = await publishBytes(
      assembly,
      exportsDirectory,
      "step",
      PART21_STEP,
      "owned-step",
    );
    const resolved = await assembly.artifactStore.readOwnedStep({
      uri: artifact.uri,
      mimeType: "model/step",
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    });
    assertEquals(resolved, PART21_STEP);
    assertEquals(await sha256Hex(resolved), artifact.sha256);
  });
});

Deno.test("owned STEP resource observation is accepted before the harness runs", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const artifact = await publishBytes(
      assembly,
      exportsDirectory,
      "step",
      PART21_STEP,
      "accepted-step",
    );
    await withMissingPython(async () => {
      await assertRejects(
        () => wiredObserver(assembly)(resourceArgs(artifact)),
        AssemblyIntegrityObservationError,
        "Python interpreter is unavailable",
      );
    });
  });
});

Deno.test("assembly integrity rejects unknown, non-STEP, mismatched and generic STEP resources before Python", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const step = await publishBytes(
      assembly,
      exportsDirectory,
      "step",
      PART21_STEP,
      "known-step",
    );
    const stl = await publishBytes(
      assembly,
      exportsDirectory,
      "stl",
      STL_BYTES,
      "known-stl",
    );
    const glb = await publishBytes(
      assembly,
      exportsDirectory,
      "gltf",
      GLB_BYTES,
      "known-glb",
    );
    const observe = wiredObserver(assembly);
    const otherSha = "a".repeat(64);
    let genericRead = false;
    assembly.app.registerResource({
      uri: `casys://build123d/artifacts/${otherSha}.step`,
      name: "forged-step",
      mimeType: "model/step",
      size: PART21_STEP.byteLength,
    }, () => {
      genericRead = true;
      return Promise.resolve({
        uri: `casys://build123d/artifacts/${otherSha}.step`,
        mimeType: "model/step",
        blob: PART21_STEP.toBase64(),
      });
    });

    await withMissingPython(async () => {
      await assertRejects(
        () => observe(schemaStepResource(otherSha, PART21_STEP.byteLength)),
        AssemblyIntegrityInputError,
        "not issued by this server process",
      );
      assertEquals(genericRead, false);
      await assertRejects(
        () => observe(resourceArgs(stl)),
        AssemblyIntegrityInputError,
        "model/step",
      );
      await assertRejects(
        () =>
          observe({
            stepResource: {
              uri: stl.uri,
              mimeType: "model/step",
              sha256: stl.sha256,
              bytes: stl.bytes,
            },
          }),
        AssemblyIntegrityInputError,
        "canonical",
      );
      await assertRejects(
        () =>
          observe({
            stepResource: {
              uri: glb.uri,
              mimeType: "model/step",
              sha256: glb.sha256,
              bytes: glb.bytes,
            },
          }),
        AssemblyIntegrityInputError,
        "canonical",
      );
      await assertRejects(
        () =>
          observe({
            stepResource: {
              uri: step.uri,
              mimeType: "model/stl",
              sha256: step.sha256,
              bytes: step.bytes,
            },
          }),
        AssemblyIntegrityInputError,
        "model/step",
      );
      await assertRejects(
        () =>
          observe({
            stepResource: {
              uri: step.uri,
              mimeType: "model/step",
              sha256: otherSha,
              bytes: step.bytes,
            },
          }),
        AssemblyIntegrityInputError,
        "does not match its canonical URI",
      );
      await assertRejects(
        () =>
          assembly.artifactStore.readOwnedStep({
            uri: step.uri,
            mimeType: "model/step",
            sha256: otherSha,
            bytes: step.bytes,
          }),
        Build123dArtifactError,
        "does not match its canonical URI",
      );
      await assertRejects(
        () =>
          observe({
            stepResource: {
              uri: step.uri,
              mimeType: "model/step",
              sha256: step.sha256,
              bytes: step.bytes + 1,
            },
          }),
        AssemblyIntegrityInputError,
        "bytes do not match the issued artifact",
      );
    });
  });
});

Deno.test("assembly integrity does not trust a generic MCP STEP registration", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const assembly = testAssembly(exportsDirectory, artifactsDirectory);
    const sha256 = await sha256Hex(PART21_STEP);
    const uri = `casys://build123d/artifacts/${sha256}.step`;
    let genericRead = false;
    assembly.app.registerResource({
      uri,
      name: "external-step",
      mimeType: "model/step",
      size: PART21_STEP.byteLength,
    }, () => {
      genericRead = true;
      return Promise.resolve({
        uri,
        mimeType: "model/step",
        blob: PART21_STEP.toBase64(),
      });
    });
    assertEquals(assembly.app.getResourceInfo(uri) !== undefined, true);
    await withMissingPython(async () => {
      await assertRejects(
        () =>
          wiredObserver(assembly)({
            stepResource: {
              uri,
              mimeType: "model/step",
              sha256,
              bytes: PART21_STEP.byteLength,
            },
          }),
        AssemblyIntegrityInputError,
        "not issued by this server process",
      );
    });
    assertEquals(genericRead, false);
  });
});

Deno.test("owned STEP resources do not survive restore even with a forged disk object", async () => {
  await withServerRoots(async ({ exportsDirectory, artifactsDirectory }) => {
    const first = testAssembly(exportsDirectory, artifactsDirectory);
    const artifact = await publishBytes(
      first,
      exportsDirectory,
      "step",
      PART21_STEP,
      "restart-step",
    );
    await Deno.mkdir(artifactsDirectory);
    await Deno.writeFile(
      `${artifactsDirectory}/${artifact.sha256}.step`,
      PART21_STEP,
    );
    await Deno.writeTextFile(
      `${artifactsDirectory}/.mcp-build123d-artifact-ledger.json`,
      JSON.stringify({
        schemaVersion: "build123d-artifact-ledger/1.0",
        entries: [{
          schemaVersion: "build123d-artifact-ledger-entry/1.0",
          artifact,
        }],
      }),
    );

    const restarted = testAssembly(exportsDirectory, artifactsDirectory);
    await restarted.artifactStore.restore();
    assertEquals(restarted.app.getResourceInfo(artifact.uri), undefined);
    await withMissingPython(async () => {
      await assertRejects(
        () => wiredObserver(restarted)(resourceArgs(artifact)),
        AssemblyIntegrityInputError,
        "not issued by this server process",
      );
      await assertRejects(
        () =>
          restarted.artifactStore.readOwnedStep({
            uri: artifact.uri,
            mimeType: "model/step",
            sha256: artifact.sha256,
            bytes: artifact.bytes,
          }),
        Build123dArtifactError,
        "not issued by this server process",
      );
    });
  });
});

Deno.test("createAssemblyIntegrityTools without a resolver keeps inline compatibility", async () => {
  const tools = createAssemblyIntegrityTools();
  const handler = tools[0]!.handler;
  const input = {
    step: {
      mimeType: "model/step",
      sha256: await sha256Hex(PART21_STEP),
      bytes: PART21_STEP.byteLength,
      blob: PART21_STEP.toBase64(),
    },
  };
  await withMissingPython(async () => {
    await assertRejects(
      async () => await handler(input),
      AssemblyIntegrityObservationError,
      "Python interpreter is unavailable",
    );
    await assertRejects(
      async () => await handler(schemaStepResource()),
      AssemblyIntegrityInputError,
      "not issued by this server process",
    );
  });
});

backendTest(
  "assembly integrity matches native observation of the same provider-exported STEP via inline and owned resource",
  async () => {
    await withServerRoots(
      async ({ exportsDirectory, artifactsDirectory }) => {
        const assembly = testAssembly(exportsDirectory, artifactsDirectory);
        const exportHandler = assembly.toolsClient.buildHandlersMap().get(
          "build123d_export",
        );
        if (!exportHandler) throw new Error("Missing export handler");
        const exported = structuredContent(
          await exportHandler({
            script: "from build123d import Box\nresult = Box(1, 2, 3)",
            formats: ["step"],
            name: "native-export",
          }),
        );
        assertEquals(exported.kind, "export");
        const file = (exported.files as Array<{
          artifact: {
            schemaVersion: string;
            uri: string;
            format: string;
            mimeType: "model/step";
            bytes: number;
            sha256: string;
          };
        }>)[0];
        if (!file) throw new Error("export returned no artifact");
        const artifact = file.artifact;
        assertEquals(
          artifact.schemaVersion,
          "build123d-export-artifact/1.0",
        );
        assertEquals(artifact.format, "step");
        assertEquals(artifact.mimeType, "model/step");
        assertEquals(
          artifact.uri,
          `casys://build123d/artifacts/${artifact.sha256}.step`,
        );

        const ownedBytes = await assembly.artifactStore.readOwnedStep({
          uri: artifact.uri,
          mimeType: "model/step",
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        });
        assertEquals(ownedBytes.byteLength, artifact.bytes);
        assertEquals(await sha256Hex(ownedBytes), artifact.sha256);

        const content = await assembly.app.readResourceContent(artifact.uri);
        assertEquals(content?.mimeType, "model/step");
        const resourceBytes = Uint8Array.from(
          atob(content?.blob ?? ""),
          (char) => char.charCodeAt(0),
        );
        assertEquals(resourceBytes, ownedBytes);

        const observe = wiredObserver(assembly);
        const inline = structuredContent(
          await observe({
            step: {
              mimeType: "model/step",
              sha256: artifact.sha256,
              bytes: artifact.bytes,
              blob: ownedBytes.toBase64(),
            },
          }),
        );
        const resource = structuredContent(
          await observe(resourceArgs({
            uri: artifact.uri,
            mimeType: "model/step",
            sha256: artifact.sha256,
            bytes: artifact.bytes,
          })),
        );
        assertEquals(resource, inline);
        assertEquals(inline.inputArtifact, {
          mimeType: "model/step",
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        });
        assertEquals(resource.inputArtifact, inline.inputArtifact);
      },
    );
  },
);
