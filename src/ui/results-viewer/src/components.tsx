/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view-components";
import {
  ArtifactRow,
  Badge,
  Button,
  Card,
  definePreactComponent,
  ElementBody,
  ElementIdent,
  ElementProvenance,
  ElementReading,
  ElementVerdict,
  EmptyState,
  InlineCode,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  SemanticElement,
  Stack,
  StateMessage,
  Toolbar,
} from "@casys/mcp-view-components/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Build123dRecordedGeometryProjection,
  loadBuild123dRecordedGltf,
} from "../../recorded-view-session.ts";
import { decodeGltfArtifact } from "./contract.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  geometryArtifactRows,
  type GeometryComponentData,
  geometryMetricValues,
  geometryObjectIdent,
  geometryObjectProvenance,
  geometryObjectReading,
  geometryObjectReference,
  geometryObjectVerdict,
  geometryStatusValue,
  isCanonicalRecordedSession,
  isGeometryReviewSession,
  isViewerSessionGeometryData,
} from "./component-model.ts";
import { type CadSceneController, mountCadScene } from "./scene.ts";

type Props = PreactSurfaceComponentProps<GeometryComponentData>;
type StageProps = Pick<Props, "data" | "context">;

const GeometryStatus = ({ data }: Props) => {
  const status = geometryStatusValue(data);
  if (isViewerSessionGeometryData(data)) {
    const session = data.session;
    if (isGeometryReviewSession(session)) {
      return (
        <Card
          title="Geometry review"
          eyebrow="Project draft · no canonical or proof authority"
          actions={<Badge tone={status.tone}>{status.label}</Badge>}
        >
          <KeyValueList
            items={[
              { id: "summary", label: "Projection", value: status.detail },
              {
                id: "basis",
                label: "Project basis",
                value:
                  `${session.basis.projectId} r${session.basis.projectRevision} · ${session.basis.subjectId}`,
              },
              {
                id: "anchor",
                label: "Review",
                value:
                  `${session.anchor.id} · r${session.anchor.revision} · ${session.anchor.fingerprint}`,
              },
            ]}
          />
        </Card>
      );
    }
    return (
      <Card
        title="Recorded geometry projection"
        eyebrow="Digital Thread · exact recorded basis"
        actions={<Badge tone={status.tone}>{status.label}</Badge>}
      >
        <KeyValueList
          items={[
            { id: "summary", label: "Projection", value: status.detail },
            {
              id: "basis",
              label: "Basis",
              value:
                `${session.basis.projectId} r${session.basis.projectRevision} · ${session.basis.thread.id} r${session.basis.thread.revision}`,
            },
            {
              id: "anchor",
              label: "Anchor",
              value: `${session.anchor.kind}:${session.anchor.id}`,
            },
          ]}
        />
      </Card>
    );
  }
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
    {isViewerSessionGeometryData(data)
      ? (
        <EmptyState>
          No Build123d execution metrics are included in this read-only geometry
          session.
        </EmptyState>
      )
      : <MetricGrid items={geometryMetricValues(data)} />}
  </Card>
);

const GeometryObject = ({ data, context }: Props) => {
  const reference = geometryObjectReference(data);
  const ident = geometryObjectIdent(data);
  const reading = geometryObjectReading(data);
  const provenance = geometryObjectProvenance(data);
  const verdict = geometryObjectVerdict(data);
  const readingSlot = reading
    ? (
      <ElementReading
        label={reading.label}
        value={reading.value}
        unit={reading.unit}
      />
    )
    : undefined;
  const body = (
    <ElementBody className="geometry-object-body">
      <GeometryStage data={data} context={context} />
    </ElementBody>
  );

  // A direct execution without an artifact has no provider-owned stable ID.
  // Keep its compact visualization, but do not manufacture a semantic ref.
  if (reference === undefined) {
    return (
      <Card
        className="geometry-object-card"
        eyebrow={ident.detail}
        title={ident.label}
        actions={<Badge>{ident.marker}</Badge>}
      >
        {readingSlot}
        {body}
      </Card>
    );
  }
  return (
    <SemanticElement
      reference={reference}
      density="card"
      tone={verdict?.tone}
      ident={
        <ElementIdent
          marker={ident.marker}
          label={ident.label}
          detail={ident.detail}
        />
      }
      reading={readingSlot}
      body={body}
      verdict={verdict
        ? <ElementVerdict label={verdict.label} value={verdict.value} />
        : undefined}
      provenance={provenance
        ? (
          <ElementProvenance
            label={provenance.label}
            value={provenance.value}
          />
        )
        : undefined}
    />
  );
};

type CanvasPhase =
  | { kind: "loading"; detail: string }
  | {
    kind: "ready";
    meshes: number;
    nodes: number;
    bytes: number;
    resourceUri: string;
  }
  | { kind: "empty"; detail: string }
  | { kind: "error"; detail: string };

const GeometryStage = ({ data, context }: StageProps) => {
  const viewerSession = isViewerSessionGeometryData(data)
    ? data.session
    : undefined;
  const sessionProjection = viewerSession?.projection;
  const sessionAvailable = sessionProjection?.status === "available"
    ? sessionProjection
    : undefined;
  const canonicalSession = viewerSession !== undefined &&
    isCanonicalRecordedSession(viewerSession);
  const reviewSession = viewerSession !== undefined &&
      isGeometryReviewSession(viewerSession)
    ? viewerSession
    : undefined;
  const gltf = !isViewerSessionGeometryData(data)
    ? data.result.files.find((file) => file.format === "gltf")
    : undefined;
  const viewport = useRef<HTMLDivElement>(null);
  const controller = useRef<CadSceneController>();
  const [wireframe, setWireframe] = useState(false);
  const [phase, setPhase] = useState<CanvasPhase>(() =>
    initialCanvasPhase(sessionProjection, gltf !== undefined)
  );

  useEffect(() => {
    const target = viewport.current;
    controller.current?.dispose();
    controller.current = undefined;
    setWireframe(false);

    if (!target || (!gltf && !sessionAvailable)) {
      setPhase(initialCanvasPhase(sessionProjection, false));
      return;
    }

    let cancelled = false;
    let mounted: CadSceneController | undefined;
    setPhase({ kind: "loading", detail: "Loading the verified GLB resource…" });

    void (async () => {
      try {
        let decodedBytes: Uint8Array;
        let resourceUri: string;
        if (sessionAvailable && isViewerSessionGeometryData(data)) {
          const decoded = await loadBuild123dRecordedGltf(
            sessionAvailable,
            data.readResource,
          );
          if (!decoded.ok) throw new Error(decoded.error);
          decodedBytes = decoded.value.bytes;
          resourceUri = decoded.value.uri;
        } else {
          const resource = await context.app.readServerResource({
            uri: gltf!.artifact.uri,
          });
          const decoded = await decodeGltfArtifact(resource, gltf!.artifact);
          if (!decoded.ok) throw new Error(decoded.error);
          decodedBytes = decoded.value;
          resourceUri = gltf!.artifact.uri;
        }
        if (cancelled) return;
        mounted = await mountCadScene(target, decodedBytes);
        if (cancelled) {
          mounted.dispose();
          return;
        }
        controller.current = mounted;
        setPhase({
          kind: "ready",
          meshes: mounted.meshes,
          nodes: mounted.nodes,
          bytes: decodedBytes.byteLength,
          resourceUri,
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
    gltf?.artifact.bytes,
    gltf?.artifact.sha256,
    gltf?.artifact.uri,
    data,
    sessionAvailable?.resourceFingerprint,
    sessionProjection?.status,
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
    <div class="geometry-stage-shell">
      {controls}
      <div class="cad-stage">
        <div
          ref={viewport}
          class="cad-viewport"
          role="img"
          aria-label={canonicalSession
            ? "Interactive recorded GLB projection linked to Digital Thread geometry"
            : reviewSession
            ? "Interactive Project geometry review projection"
            : "Interactive build123d 3D model"}
        />
        <div class="cad-reticle" aria-hidden="true" />
        {phase.kind === "ready" && (
          <div class="cad-hud" aria-live="polite">
            <Badge tone="success">
              {viewerSession ? "Projection digest verified" : "Verified GLB"}
            </Badge>
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
                : sessionProjection?.status === "unresolved"
                ? "UNRESOLVED"
                : sessionProjection?.status === "unavailable"
                ? "UNAVAILABLE"
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
        <span>
          {canonicalSession
            ? "Recorded · Orbit · Pan · Zoom"
            : reviewSession
            ? "Review · Orbit · Pan · Zoom"
            : "Orbit · Pan · Zoom"}
        </span>
        <InlineCode>
          {phase.kind === "ready"
            ? phase.resourceUri
            : sessionAvailable?.resourceFingerprint ??
              gltf?.artifact.uri ?? "No GLB artifact"}
        </InlineCode>
        <span>
          {phase.kind === "ready"
            ? formatBytes(phase.bytes)
            : gltf
            ? formatBytes(gltf.artifact.bytes)
            : "—"}
        </span>
      </footer>
    </div>
  );
};

const GeometryCanvas = ({ data, context }: Props) => {
  const viewerSession = isViewerSessionGeometryData(data)
    ? data.session
    : undefined;
  const canonicalSession = viewerSession !== undefined &&
    isCanonicalRecordedSession(viewerSession);
  const reviewSession = viewerSession !== undefined &&
      isGeometryReviewSession(viewerSession)
    ? viewerSession
    : undefined;
  return (
    <Card
      className="model-panel"
      title={canonicalSession
        ? "Recorded GLB projection / 3D space"
        : reviewSession
        ? "Geometry review / 3D space"
        : "Assembly / 3D space"}
      eyebrow={canonicalSession
        ? "Recorded read-only projection"
        : reviewSession
        ? `${reviewSession.status} Project projection · read-only`
        : "Geometry inspection"}
    >
      <GeometryStage data={data} context={context} />
    </Card>
  );
};

const ExportArtifacts = ({ data }: Props) => {
  if (isViewerSessionGeometryData(data)) {
    if (isGeometryReviewSession(data.session)) {
      const { anchor, basis, projection, provenance, status } = data.session;
      const draft = provenance.draftCapture;
      return (
        <Card
          title="Review provenance"
          eyebrow="Project draft · no canonical or proof claim"
        >
          <KeyValueList
            items={[
              {
                id: "review",
                label: "Review identity",
                value:
                  `${anchor.id} · r${anchor.revision} · ${anchor.fingerprint}`,
              },
              {
                id: "status",
                label: "Review status",
                value: status,
              },
              {
                id: "draft",
                label: "Draft capture",
                value: `${draft.artifactId} · ${draft.artifactVersion}`,
              },
              {
                id: "draft-fingerprint",
                label: "Draft fingerprint",
                value: draft.artifactFingerprint,
              },
              {
                id: "draft-producer",
                label: "Draft producer",
                value:
                  `${draft.producer.serverId} · ${draft.producer.tool} · ${draft.producer.runId}`,
              },
              {
                id: "subject",
                label: "Project subject",
                value:
                  `${basis.projectId} r${basis.projectRevision} · ${basis.subjectId}`,
              },
              ...(projection.status === "available"
                ? [
                  {
                    id: "projection-artifact",
                    label: "Review GLB",
                    value:
                      `${projection.artifact.artifactId} · ${projection.artifact.artifactVersion}`,
                  },
                  {
                    id: "projection-fingerprint",
                    label: "GLB fingerprint",
                    value: projection.artifact.artifactFingerprint,
                  },
                  {
                    id: "projection-producer",
                    label: "GLB producer",
                    value:
                      `${projection.artifact.producer.serverId} · ${projection.artifact.producer.tool} · ${projection.artifact.producer.runId}`,
                  },
                ]
                : [{
                  id: "projection-reason",
                  label: projection.status.toUpperCase(),
                  value: projection.reason,
                }]),
            ]}
          />
        </Card>
      );
    }
    const { basis, projection, provenance } = data.session;
    const capture = provenance.canonicalCapture;
    return (
      <Card title="Recorded provenance" eyebrow="Canonical Thread evidence">
        <KeyValueList
          items={[
            {
              id: "artifact",
              label: "Canonical capture",
              value: `${capture.artifactId} · ${capture.artifactVersion}`,
            },
            {
              id: "fingerprint",
              label: "Capture fingerprint",
              value: capture.artifactFingerprint,
            },
            {
              id: "producer",
              label: "Capture producer",
              value: `${capture.producer.serverId} · ${capture.producer.tool}`,
            },
            {
              id: "run",
              label: "Capture run",
              value: capture.producer.runId,
            },
            {
              id: "subject",
              label: "Subject",
              value: `${basis.subjectId} · ${projection.status}`,
            },
            ...(projection.status === "available"
              ? [
                {
                  id: "projection-artifact",
                  label: "Projected GLB",
                  value:
                    `${projection.artifact.artifactId} · ${projection.artifact.artifactVersion}`,
                },
                {
                  id: "projection-fingerprint",
                  label: "GLB fingerprint",
                  value: projection.artifact.artifactFingerprint,
                },
                {
                  id: "projection-producer",
                  label: "GLB producer",
                  value:
                    `${projection.artifact.producer.serverId} · ${projection.artifact.producer.tool} · ${projection.artifact.producer.runId}`,
                },
              ]
              : [{
                id: "projection-reason",
                label: projection.status.toUpperCase(),
                value: projection.reason,
              }]),
          ]}
        />
      </Card>
    );
  }
  const rows = geometryArtifactRows(data);
  return (
    <Card title="Export artifacts" eyebrow="Immutable resources">
      {rows.length > 0
        ? (
          <Stack gap="sm">
            {rows.map((row) => (
              <ArtifactRow
                key={`${row.kind}:${row.digest}`}
                kind={row.kind}
                label={row.label}
                uri={row.uri}
                fingerprint={{ algorithm: "SHA-256", digest: row.digest }}
                sizeLabel={formatBytes(row.bytes)}
              />
            ))}
          </Stack>
        )
        : (
          <EmptyState>
            No export for this calculation. Use build123d_export to produce
            STEP, STL or GLB files.
          </EmptyState>
        )}
    </Card>
  );
};

export const BUILD123D_COMPONENT_REGISTRY = defineComponentRegistry<
  GeometryComponentData,
  PreactSurfaceContext<GeometryComponentData>
>({
  components: {
    [BUILD123D_COMPONENT_KEYS.object]: definePreactComponent(
      {
        title: "Geometry object",
        description:
          "One bounded geometry result or review, with a semantic identity only when the provider supplies one.",
      },
      GeometryObject,
    ),
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
          "Interactive verified GLB resource canvas with orbit, pan and inspection.",
      },
      GeometryCanvas,
    ),
    [BUILD123D_COMPONENT_KEYS.artifacts]: definePreactComponent(
      {
        title: "Export artifacts",
        description: "Immutable export resource URIs, digests and byte sizes.",
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

function initialCanvasPhase(
  projection: Build123dRecordedGeometryProjection | undefined,
  hasToolGltf: boolean,
): CanvasPhase {
  if (projection?.status === "available" || hasToolGltf) {
    return { kind: "loading", detail: "Loading the verified GLB resource…" };
  }
  if (
    projection?.status === "unavailable" || projection?.status === "unresolved"
  ) {
    return { kind: "empty", detail: projection.reason };
  }
  return {
    kind: "empty",
    detail:
      "Add the gltf format to build123d_export to mount the 3D component.",
  };
}
