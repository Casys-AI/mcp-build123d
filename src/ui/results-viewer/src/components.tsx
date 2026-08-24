/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view";
import {
  Badge,
  Button,
  Card,
  DataTable,
  type DataTableColumn,
  definePreactComponent,
  EmptyState,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  StateMessage,
  Toolbar,
} from "@casys/mcp-view/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  decodeGltfArtifact,
  type ExportFile,
  gltfViewerReadArguments,
} from "./contract.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  type GeometryComponentData,
  geometryMetricValues,
  geometryStatusValue,
} from "./component-model.ts";
import { type CadSceneController, mountCadScene } from "./scene.ts";

type Props = PreactSurfaceComponentProps<GeometryComponentData>;

const GeometryStatus = ({ data }: Props) => {
  const status = geometryStatusValue(data);
  const result = data.result;
  return (
    <Card
      title="Geometry status"
      eyebrow="build123d"
      actions={<Badge tone={status.tone}>{status.label}</Badge>}
    >
      <KeyValueList
        items={[
          { id: "summary", label: "Result", value: status.detail },
          {
            id: "topology",
            label: "Topology",
            value:
              `${result.metrics.solids} solids · ${result.metrics.faces} faces · ${result.metrics.edges} edges`,
          },
        ]}
      />
    </Card>
  );
};

const GeometryMetrics = ({ data }: Props) => (
  <Card title="Geometry metrics" eyebrow="Exact OCCT measures">
    <MetricGrid items={geometryMetricValues(data)} />
  </Card>
);

type CanvasPhase =
  | { kind: "loading"; detail: string }
  | { kind: "ready"; meshes: number; nodes: number }
  | { kind: "empty"; detail: string }
  | { kind: "error"; detail: string };

const GeometryCanvas = ({ data, context }: Props) => {
  const gltf = data.result.files.find((file) => file.format === "gltf");
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<CadSceneController>();
  const [wireframe, setWireframe] = useState(false);
  const [phase, setPhase] = useState<CanvasPhase>(() =>
    gltf?.viewer
      ? { kind: "loading", detail: "Loading the local GLB artifact…" }
      : {
        kind: "empty",
        detail: gltf
          ? "This GLB export does not provide a bounded viewer reference."
          : "Add the gltf format to build123d_export to mount the 3D component.",
      }
  );

  useEffect(() => {
    const target = viewport.current;
    controller.current?.dispose();
    controller.current = undefined;
    setWireframe(false);

    const viewer = gltf?.viewer;
    if (!target || !gltf || !viewer) {
      setPhase({
        kind: "empty",
        detail: gltf
          ? "This GLB export does not provide a bounded viewer reference."
          : "Add the gltf format to build123d_export to mount the 3D component.",
      });
      return;
    }

    let cancelled = false;
    let mounted: CadSceneController | undefined;
    setPhase({ kind: "loading", detail: "Loading the local GLB artifact…" });

    void (async () => {
      try {
        const read = gltfViewerReadArguments(gltf);
        if (!read) {
          throw new Error(
            "This GLB export does not provide a bounded viewer reference.",
          );
        }
        const artifact = await context.callTool(viewer.toolName, {
          name: read.name,
          expected_sha256: read.expected_sha256,
        });
        if (artifact.isError) {
          throw new Error(
            mcpErrorText(artifact.content) ??
              "The server rejected the local GLB artifact.",
          );
        }
        const decoded = decodeGltfArtifact(artifact.structuredContent);
        if (!decoded.ok) throw new Error(decoded.error);
        if (cancelled) return;
        mounted = await mountCadScene(target, decoded.value);
        if (cancelled) {
          mounted.dispose();
          return;
        }
        controller.current = mounted;
        setPhase({
          kind: "ready",
          meshes: mounted.meshes,
          nodes: mounted.nodes,
        });
      } catch (error) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          detail: error instanceof Error
            ? error.message
            : "The 3D model could not be loaded.",
        });
      }
    })();

    return () => {
      cancelled = true;
      mounted?.dispose();
      if (controller.current === mounted) controller.current = undefined;
    };
  }, [
    context,
    gltf?.path,
    gltf?.sha256,
    gltf?.viewer?.name,
    gltf?.viewer?.toolName,
  ]);

  const controls = (
    <Toolbar label="3D model controls">
      <Button
        disabled={phase.kind !== "ready"}
        onClick={() => controller.current?.fit()}
      >
        Fit
      </Button>
      <Button
        disabled={phase.kind !== "ready"}
        onClick={() => controller.current?.reset()}
      >
        Reset
      </Button>
      <Button
        disabled={phase.kind !== "ready"}
        pressed={wireframe}
        onClick={() =>
          setWireframe((current) => {
            const next = !current;
            controller.current?.setWireframe(next);
            return next;
          })}
      >
        Wireframe
      </Button>
    </Toolbar>
  );

  return (
    <Card
      className="model-panel"
      title="Assembly / 3D space"
      eyebrow="Geometry inspection"
      actions={controls}
    >
      <div class="cad-stage">
        <div
          ref={viewport}
          class="cad-viewport"
          role="img"
          aria-label="Interactive build123d 3D model"
        />
        <div class="cad-reticle" aria-hidden="true" />
        {phase.kind === "ready" && (
          <div class="cad-hud" aria-live="polite">
            <Badge tone="success">Local GLB</Badge>
            <span>
              {phase.meshes} mesh{phase.meshes === 1 ? "" : "es"} ·{" "}
              {phase.nodes} nodes
            </span>
          </div>
        )}
        {phase.kind !== "ready" && (
          <div class="cad-state-overlay">
            <StateMessage
              title={phase.kind === "loading"
                ? "Loading interactive geometry"
                : phase.kind === "error"
                ? "3D preview unavailable"
                : "No interactive geometry"}
              tone={phase.kind === "error"
                ? "danger"
                : phase.kind === "loading"
                ? "info"
                : "neutral"}
            >
              {phase.detail}
            </StateMessage>
          </div>
        )}
      </div>
      <footer class="model-foot">
        <span>Orbit · Pan · Zoom</span>
        <code>{gltf?.path ?? "No GLB artifact"}</code>
        <span>{gltf ? formatBytes(gltf.bytes) : "—"}</span>
      </footer>
    </Card>
  );
};

const artifactColumns: readonly DataTableColumn<ExportFile>[] = [
  {
    id: "format",
    label: "Format",
    render: (file) => <Badge tone="info">{file.format.toUpperCase()}</Badge>,
  },
  {
    id: "path",
    label: "Path",
    render: (file) => <code>{file.path}</code>,
  },
  {
    id: "bytes",
    label: "Size",
    align: "right",
    render: (file) => formatBytes(file.bytes),
  },
];

const ExportArtifacts = ({ data }: Props) => (
  <Card title="Export artifacts" eyebrow="Generated files">
    {data.result.files.length > 0
      ? (
        <DataTable
          label="Generated build123d artifacts"
          rows={data.result.files}
          columns={artifactColumns}
          rowKey={(file) => `${file.format}:${file.path}`}
        />
      )
      : (
        <EmptyState>
          No export for this calculation. Use build123d_export to produce STEP,
          STL or GLB files.
        </EmptyState>
      )}
  </Card>
);

export const BUILD123D_COMPONENT_REGISTRY = defineComponentRegistry<
  GeometryComponentData,
  PreactSurfaceContext<GeometryComponentData>
>({
  components: {
    [BUILD123D_COMPONENT_KEYS.status]: definePreactComponent(
      {
        title: "Geometry status",
        description:
          "Computation/export status and available geometry identity.",
      },
      GeometryStatus,
    ),
    [BUILD123D_COMPONENT_KEYS.metrics]: definePreactComponent(
      {
        title: "Geometry metrics",
        description:
          "Exact OCCT volume, surface, envelope, topology and optional mass data.",
      },
      GeometryMetrics,
    ),
    [BUILD123D_COMPONENT_KEYS.canvas]: definePreactComponent(
      {
        title: "Interactive geometry",
        description:
          "Interactive local GLB canvas with orbit, pan and inspection.",
      },
      GeometryCanvas,
    ),
    [BUILD123D_COMPONENT_KEYS.artifacts]: definePreactComponent(
      {
        title: "Export artifacts",
        description: "Exact generated formats, paths and byte sizes.",
      },
      ExportArtifacts,
    ),
  },
  defaultSurface: BUILD123D_DEFAULT_SURFACE,
});

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function mcpErrorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const messages = content.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const block = entry as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return messages.length > 0 ? messages.join("\n") : undefined;
}
