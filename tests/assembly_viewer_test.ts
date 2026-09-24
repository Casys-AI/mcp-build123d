import { assertEquals, assertStringIncludes } from "@std/assert";
import { MCP_BUILD123D_VERSION } from "../src/version.ts";
import { parseAssemblyObservation } from "../src/ui/results-viewer/src/assembly-contract.ts";
import {
  ASSEMBLY_PRESENTATION_META_KEY,
  ASSEMBLY_PRESENTATION_SCHEMA,
  assemblyIdentity,
  assemblyMetrics,
  assemblyOccurrenceDisplays,
  assemblyOccurrenceRows,
  assemblyPairRows,
  assemblySourceFacts,
  assemblyStateFromToolResult,
  assemblyTopologyFacts,
  assemblyTransformText,
  BUILD123D_ASSEMBLY_COMPONENT_KEYS,
  BUILD123D_ASSEMBLY_DEFAULT_SURFACE,
  factText,
} from "../src/ui/results-viewer/src/assembly-model.ts";

const observed = <T>(value: T) => ({ status: "observed", value });
const unresolved = (reason: "identity-missing" | "observability-missing") => ({
  status: "unresolved",
  reason,
});
const unavailable = () => ({ status: "unavailable", reason: "unsupported" });

const identityMatrix = [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
];

function observation(): Record<string, unknown> {
  return {
    schemaVersion: "build123d-assembly-integrity-observation/1.0",
    kind: "assembly-integrity-observation",
    producer: {
      service: "mcp-build123d",
      packageVersion: MCP_BUILD123D_VERSION,
      tool: "build123d_observe_assembly_integrity",
      engine: { name: "cadquery-ocp", version: "7.9.3.1" },
    },
    inputArtifact: {
      mimeType: "model/step",
      sha256: "a".repeat(64),
      bytes: 1024,
    },
    method: {
      id: "occt-assembly-integrity-v1",
      version: "1.0.0",
      linearToleranceMm: 0.000001,
    },
    importability: observed("imported"),
    unitSystem: observed("mm"),
    topology: {
      brepValidity: observed("valid"),
      solidCount: observed(2),
      shellCount: observed(2),
      degenerateEdgeCount: unavailable(),
      freeEdgeCount: unresolved("observability-missing"),
    },
    occurrences: observed([
      { label: "alpha", transform: observed([...identityMatrix]) },
      {
        label: "bravo",
        transform: observed([
          1,
          0,
          0,
          10,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
          0,
          0,
          0,
          0,
          1,
        ]),
      },
    ]),
    pairs: observed([{
      firstLabel: "alpha",
      secondLabel: "bravo",
      linearToleranceMm: 0.000001,
      minimumDistanceMm: observed(0),
      intersectionVolumeMm3: unresolved("observability-missing"),
      contact: observed("contact"),
    }]),
  };
}

function nested(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return value[key] as Record<string, unknown>;
}

Deno.test("assembly viewer accepts the current observation and keeps each fact status", () => {
  const parsed = parseAssemblyObservation(observation());
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  const result = parsed.value;
  assertEquals(
    result.schemaVersion,
    "build123d-assembly-integrity-observation/1.0",
  );
  assertEquals(result.occurrences.status, "observed");
  assertEquals(result.pairs.status, "observed");
  assertEquals(result.topology.degenerateEdgeCount, {
    status: "unavailable",
    reason: "unsupported",
  });
  assertEquals(result.topology.freeEdgeCount, {
    status: "unresolved",
    reason: "observability-missing",
  });
  assertEquals(assemblyOccurrenceRows(result).map((row) => row.label), [
    "alpha",
    "bravo",
  ]);
  assertEquals(assemblyPairRows(result)[0]?.contact, {
    status: "observed",
    value: "contact",
  });
  assertEquals(factText(result.pairs, (rows) => String(rows.length)), "1");
  assertEquals(
    factText(result.topology.freeEdgeCount),
    "unresolved (observability-missing)",
  );
  assertEquals(
    factText(result.topology.degenerateEdgeCount),
    "unavailable (unsupported)",
  );
  assertStringIncludes(
    assemblyTransformText(assemblyOccurrenceRows(result)[1]!.transform),
    "10",
  );
});

Deno.test("assembly viewer preserves imported identity and capability gaps", () => {
  const source = observation();
  source.occurrences = unresolved("identity-missing");
  source.pairs = unresolved("identity-missing");
  const parsed = parseAssemblyObservation(source);
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(parsed.value.occurrences, {
    status: "unresolved",
    reason: "identity-missing",
  });
  assertEquals(parsed.value.pairs, {
    status: "unresolved",
    reason: "identity-missing",
  });
  assertEquals(assemblyOccurrenceRows(parsed.value), []);
  assertEquals(assemblyPairRows(parsed.value), []);
  assertEquals(
    assemblyMetrics(parsed.value)[2]?.value,
    "unresolved (identity-missing)",
  );
});

Deno.test("assembly viewer accepts a failed import only with literal observability gaps", () => {
  const source = observation();
  source.importability = observed("failed");
  source.unitSystem = unresolved("observability-missing");
  source.topology = {
    brepValidity: unresolved("observability-missing"),
    solidCount: unresolved("observability-missing"),
    shellCount: unresolved("observability-missing"),
    degenerateEdgeCount: unresolved("observability-missing"),
    freeEdgeCount: unresolved("observability-missing"),
  };
  source.occurrences = unresolved("observability-missing");
  source.pairs = unresolved("observability-missing");
  const parsed = parseAssemblyObservation(source);
  assertEquals(parsed.ok, true);
  if (!parsed.ok) return;
  assertEquals(assemblyIdentity(parsed.value).marker, "failed");
  assertEquals(
    assemblyMetrics(parsed.value)[0]?.value,
    "unresolved (observability-missing)",
  );

  source.pairs = unavailable();
  const rejected = parseAssemblyObservation(source);
  assertEquals(rejected.ok, false);
  if (!rejected.ok) assertStringIncludes(rejected.error, "observability gaps");
});

Deno.test("assembly viewer rejects schema, source, method and nested shape drift", () => {
  const edits: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["schema", (value) => {
      value.schemaVersion = "assembly-integrity-observation/1.0";
    }],
    ["extra root field", (value) => {
      value.verdict = "passed";
    }],
    ["engine", (value) => {
      nested(nested(value, "producer"), "engine").version = "other";
    }],
    ["artifact digest", (value) => {
      nested(value, "inputArtifact").sha256 = "A".repeat(64);
    }],
    ["artifact size", (value) => {
      nested(value, "inputArtifact").bytes = 0;
    }],
    ["method", (value) => {
      nested(value, "method").linearToleranceMm = 0.01;
    }],
    ["fact shape", (value) => {
      nested(value, "importability").reason = "surplus";
    }],
    ["fact reason", (value) => {
      nested(nested(value, "topology"), "freeEdgeCount").reason = "maybe";
    }],
  ];
  for (const [name, edit] of edits) {
    const value = observation();
    edit(value);
    const result = parseAssemblyObservation(value);
    assertEquals(result.ok, false, name);
  }
});

Deno.test("assembly viewer rejects noncanonical occurrences, transforms and pair tables", () => {
  const edits: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["occurrence order", (value) => {
      (nested(value, "occurrences").value as Array<unknown>).reverse();
    }],
    ["duplicate label", (value) => {
      const rows = nested(value, "occurrences").value as Array<
        Record<string, unknown>
      >;
      rows[1]!.label = "alpha";
    }],
    ["reflected transform", (value) => {
      const rows = nested(value, "occurrences").value as Array<
        Record<string, unknown>
      >;
      (nested(rows[0]!, "transform").value as number[])[0] = -1;
    }],
    ["negative zero coordinate", (value) => {
      const rows = nested(value, "occurrences").value as Array<
        Record<string, unknown>
      >;
      (nested(rows[0]!, "transform").value as number[])[3] = -0;
    }],
    ["missing pair", (value) => {
      nested(value, "pairs").value = [];
    }],
    ["reversed pair", (value) => {
      const rows = nested(value, "pairs").value as Array<
        Record<string, unknown>
      >;
      rows[0]!.firstLabel = "bravo";
      rows[0]!.secondLabel = "alpha";
    }],
    ["negative distance", (value) => {
      const rows = nested(value, "pairs").value as Array<
        Record<string, unknown>
      >;
      nested(rows[0]!, "minimumDistanceMm").value = -0;
    }],
    ["wrong pair tolerance", (value) => {
      const rows = nested(value, "pairs").value as Array<
        Record<string, unknown>
      >;
      rows[0]!.linearToleranceMm = 0.1;
    }],
    ["too many occurrences", (value) => {
      nested(value, "occurrences").value = Array.from(
        { length: 33 },
        (_, index) => ({
          label: `part${String(index).padStart(2, "0")}`,
          transform: observed(identityMatrix),
        }),
      );
    }],
  ];
  for (const [name, edit] of edits) {
    const value = observation();
    edit(value);
    assertEquals(parseAssemblyObservation(value).ok, false, name);
  }
});

Deno.test("assembly viewer accepts the closed 32-occurrence and 496-pair bound", () => {
  const source = observation();
  const labels = Array.from(
    { length: 32 },
    (_, index) => `part${String(index).padStart(2, "0")}`,
  );
  source.occurrences = observed(labels.map((label) => ({
    label,
    transform: observed([...identityMatrix]),
  })));
  const pairs = [];
  for (let first = 0; first < labels.length; first += 1) {
    for (let second = first + 1; second < labels.length; second += 1) {
      pairs.push({
        firstLabel: labels[first],
        secondLabel: labels[second],
        linearToleranceMm: 0.000001,
        minimumDistanceMm: observed(0),
        intersectionVolumeMm3: observed(0),
        contact: observed("no-contact"),
      });
    }
  }
  source.pairs = observed(pairs);
  const parsed = parseAssemblyObservation(source);
  assertEquals(parsed.ok, true);
  if (parsed.ok) {
    assertEquals(assemblyOccurrenceRows(parsed.value).length, 32);
    assertEquals(assemblyPairRows(parsed.value).length, 496);
  }
});

Deno.test("assembly viewer projects one datasheet and exact provenance without a verdict", () => {
  const state = assemblyStateFromToolResult({
    structuredContent: observation(),
  });
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  const result = state.result.observation;
  assertEquals(BUILD123D_ASSEMBLY_DEFAULT_SURFACE.components, [{
    id: "assembly-datasheet",
    component: BUILD123D_ASSEMBLY_COMPONENT_KEYS.datasheet,
  }]);
  assertEquals(assemblyIdentity(result).tone, "neutral");
  assertEquals(
    assemblyTopologyFacts(result).find((fact) => fact.id === "free-edges")
      ?.value,
    "unresolved (observability-missing)",
  );
  assertEquals(
    assemblySourceFacts(result).find((fact) => fact.id === "step-sha256")
      ?.value,
    "a".repeat(64),
  );
  assertEquals(
    assemblySourceFacts(result).find((fact) => fact.id === "tolerance")?.value,
    "0.000001 mm",
  );
});

Deno.test("assembly viewer presents verified names while preserving opaque STEP identities", () => {
  const first = "22afa6fa-829b-4372-b126-6bbbeefd1a51";
  const second = "56a97aee-becf-4645-8e76-3bb3406e3cdc";
  const source = observation();
  nested(source, "occurrences").value = [
    { label: first, transform: observed([...identityMatrix]) },
    { label: second, transform: observed([...identityMatrix]) },
  ];
  nested(source, "pairs").value = [{
    firstLabel: first,
    secondLabel: second,
    linearToleranceMm: 0.000001,
    minimumDistanceMm: observed(0),
    intersectionVolumeMm3: observed(0),
    contact: observed("contact"),
  }];

  const state = assemblyStateFromToolResult({
    structuredContent: source,
    _meta: {
      [ASSEMBLY_PRESENTATION_META_KEY]: {
        schemaVersion: ASSEMBLY_PRESENTATION_SCHEMA,
        sourceStepSha256: "a".repeat(64),
        names: {
          [first]: "StandBase",
          [second]: "StandBackrest",
        },
      },
    },
  });
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  const displays = assemblyOccurrenceDisplays(
    state.result.observation,
    state.result.displayNames,
    "fr-FR",
  );
  assertEquals(displays.get(first), {
    name: "StandBase",
    technicalId: first,
  });
  assertEquals(displays.get(second), {
    name: "StandBackrest",
    technicalId: second,
  });
  const pair = assemblyPairRows(state.result.observation)[0];
  assertEquals(pair?.firstLabel, first);
  assertEquals(pair?.secondLabel, second);
  assertEquals(pair?.minimumDistanceMm, { status: "observed", value: 0 });
  assertEquals(pair?.contact, { status: "observed", value: "contact" });
});

Deno.test("assembly viewer uses localized aliases when opaque names are unavailable", () => {
  const first = "22afa6fa-829b-4372-b126-6bbbeefd1a51";
  const second = "56a97aee-becf-4645-8e76-3bb3406e3cdc";
  const source = observation();
  nested(source, "occurrences").value = [
    { label: first, transform: observed([...identityMatrix]) },
    { label: second, transform: observed([...identityMatrix]) },
  ];
  nested(source, "pairs").value = [{
    firstLabel: first,
    secondLabel: second,
    linearToleranceMm: 0.000001,
    minimumDistanceMm: observed(0),
    intersectionVolumeMm3: observed(0),
    contact: observed("contact"),
  }];
  const state = assemblyStateFromToolResult({
    structuredContent: source,
    _meta: {
      [ASSEMBLY_PRESENTATION_META_KEY]: {
        schemaVersion: ASSEMBLY_PRESENTATION_SCHEMA,
        sourceStepSha256: "b".repeat(64),
        names: { [first]: "Wrong source", [second]: "Wrong source" },
      },
    },
  });
  assertEquals(state.kind, "result");
  if (state.kind !== "result") return;
  assertEquals(state.result.displayNames.size, 0);
  assertEquals(
    [
      ...assemblyOccurrenceDisplays(
        state.result.observation,
        state.result.displayNames,
        "fr-FR",
      ).values(),
    ],
    [
      { name: "Composant 1", technicalId: first },
      { name: "Composant 2", technicalId: second },
    ],
  );

  const readable = assemblyStateFromToolResult({
    structuredContent: observation(),
  });
  assertEquals(readable.kind, "result");
  if (readable.kind === "result") {
    assertEquals(
      [
        ...assemblyOccurrenceDisplays(
          readable.result.observation,
          readable.result.displayNames,
          "en-US",
        ).values(),
      ],
      [{ name: "alpha" }, { name: "bravo" }],
    );
  }
});

Deno.test("assembly viewer distinguishes a tool error from a rejected result", () => {
  const failed = assemblyStateFromToolResult({
    isError: true,
    content: [{ type: "text", text: "STEP import failed" }],
    structuredContent: observation(),
  });
  assertEquals(failed.kind, "error");
  if (failed.kind === "error") {
    assertEquals(failed.code, "tool-error");
    assertEquals(failed.message, "STEP import failed");
  }
  const rejected = assemblyStateFromToolResult({
    structuredContent: { kind: "legacy" },
  });
  assertEquals(rejected.kind, "error");
  if (rejected.kind === "error") assertEquals(rejected.code, "result-rejected");
});
