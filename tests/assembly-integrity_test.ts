/** Real STEP/XCAF contract tests for the fixed assembly-integrity observer. */

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { SchemaValidator } from "@casys/mcp-server";
import {
  ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES,
  type AssemblyIntegrityInputArtifact,
  AssemblyIntegrityInputError,
  AssemblyIntegrityObservationError,
  observeAssemblyIntegrity,
  parseAssemblyIntegrityObservation,
} from "../src/api/assembly-integrity-bridge.ts";
import {
  ASSEMBLY_INTEGRITY_TOOL,
  assemblyIntegrityTools,
} from "../src/tools/assembly-integrity.ts";

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
        packageVersion: "0.6.1",
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
