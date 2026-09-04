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
  ElementSection,
  EmptyState,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  SemanticElement,
  Slot3D,
  StateMessage,
  Toolbar,
} from "@casys/mcp-view-components/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Build123dRecordedGeometryProjection,
  loadBuild123dRecordedGltf,
} from "../../recorded-view-session.ts";
import { decodeGltfArtifact, type ExportFile } from "./contract.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  formatBytes,
  formatCount,
  type GeometryComponentData,
  type GeometryFact,
  type GeometryFactSection,
  geometryFactSections,
  geometryIdentity,
  geometryProvenance,
  geometryReadings,
  geometryReference,
  isCanonicalRecordedSession,
  isGeometryReviewSession,
  isViewerSessionGeometryData,
} from "./component-model.ts";
import { type CadSceneController, mountCadScene } from "./scene.ts";

type Props = PreactSurfaceComponentProps<GeometryComponentData>;

/**
 * Standalone default and viewer-session surface: one bounded datasheet with an
 * identity line, at most four readings, the 3D model, titled fact sections and
 * one provenance line. The four small components below slice the same model
 * for Compose hosts.
 */
const GeometryDatasheet = ({ data, context }: Props) => {
  const locale = context.hostContext.locale;
  const identity = geometryIdentity(data, locale);
  const readings = geometryReadings(data, locale);
  const provenance = geometryProvenance(data);
  return (
    <SemanticElement
      className="geometry-datasheet"
      reference={geometryReference(data)}
      density="card"
      ident={
        <ElementIdent
          marker={<Badge tone={identity.tone}>{identity.marker}</Badge>}
          label={identity.label}
          detail={identity.detail}
        />
      }
      body={
        <ElementBody>
          {readings.length > 0 && (
            <MetricGrid className="geometry-readings" items={readings} />
          )}
          <ElementSection title="3D model">
            <GeometryScene data={data} context={context} />
          </ElementSection>
          <FactSections sections={geometryFactSections(data, locale)} />
          {!isViewerSessionGeometryData(data) && (
            <ElementSection title="Artifacts">
              <Artifacts files={data.result.files} locale={locale} />
            </ElementSection>
          )}
        </ElementBody>
      }
      provenance={provenance && (
        <ElementProvenance label={provenance.label} value={provenance.value} />
      )}
    />
  );
};

/** Reader-worded facts in one aligned column; the inspector layout is for field dumps. */
const Facts = ({ items }: { readonly items: readonly GeometryFact[] }) => (
  <KeyValueList layout="facts" items={items} />
);

const FactSections = (
  { sections }: { readonly sections: readonly GeometryFactSection[] },
) => (
  <>
    {sections.map((section) => (
      <ElementSection key={section.id} title={section.title}>
        <Facts items={section.items} />
      </ElementSection>
    ))}
  </>
);

/** One row per sealed export; verification is displayed from the result, never inferred. */
const Artifacts = (
  { files, locale }: {
    readonly files: readonly ExportFile[];
    readonly locale: string | undefined;
  },
) =>
  files.length > 0
    ? (
      <div class="geometry-artifacts">
        {files.map((file) => (
          <ArtifactRow
            key={`${file.format}:${file.artifact.sha256}`}
            kind={file.format.toUpperCase()}
            label={file.artifact.mimeType}
            uri={file.artifact.uri}
            fingerprint={{ algorithm: "sha256", digest: file.artifact.sha256 }}
            sizeLabel={formatBytes(file.artifact.bytes, locale)}
          />
        ))}
      </div>
    )
    : (
      <EmptyState>
        No export for this calculation. Use build123d_export to produce STEP,
        STL or GLB files.
      </EmptyState>
    );

const GeometryStatus = ({ data, context }: Props) => {
  const identity = geometryIdentity(data, context.hostContext.locale);
  const provenance = geometryProvenance(data);
  return (
    <SemanticElement
      reference={geometryReference(data)}
      density="row"
      ident={
        <ElementIdent
          marker={<Badge tone={identity.tone}>{identity.marker}</Badge>}
          label={identity.label}
          detail={identity.detail}
        />
      }
      provenance={provenance && (
        <ElementProvenance label={provenance.label} value={provenance.value} />
      )}
    />
  );
};

const GeometryMetrics = ({ data, context }: Props) => {
  const locale = context.hostContext.locale;
  return (
    <Card title="Readings" eyebrow="Exact OCCT measures">
      {isViewerSessionGeometryData(data)
        ? (
          <EmptyState>
            No Build123d execution metrics are included in this read-only
            geometry session.
          </EmptyState>
        )
        : (
          <>
            <MetricGrid
              className="geometry-readings"
              items={geometryReadings(data, locale)}
            />
            <FactSections sections={geometryFactSections(data, locale)} />
          </>
        )}
    </Card>
  );
};

const GeometryCanvas = ({ data, context }: Props) => (
  <Card
    title="3D model"
    eyebrow={isViewerSessionGeometryData(data)
      ? "Read-only projection"
      : "Geometry inspection"}
  >
    <GeometryScene data={data} context={context} />
  </Card>
);

const ExportArtifacts = ({ data, context }: Props) =>
  isViewerSessionGeometryData(data)
    ? (
      <Card
        title="Provenance"
        eyebrow={isGeometryReviewSession(data.session)
          ? "Project draft · no canonical or proof claim"
          : "Canonical Thread evidence"}
      >
        <FactSections sections={geometryFactSections(data)} />
      </Card>
    )
    : (
      <Card title="Artifacts" eyebrow="Immutable resources">
        <Artifacts
          files={data.result.files}
          locale={context.hostContext.locale}
        />
      </Card>
    );

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

type SceneProps = Pick<Props, "data" | "context">;

/** The Three.js stage in a kit Slot3D, with its controls and a literal status line. */
const GeometryScene = ({ data, context }: SceneProps) => {
  const locale = context.hostContext.locale;
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
    isGeometryReviewSession(viewerSession);
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

  const status = phase.kind === "ready"
    ? `${viewerSession ? "Projection digest verified" : "Verified GLB"} · ${
      formatBytes(phase.bytes, locale)
    } · Orbit · Pan · Zoom`
    : phase.kind === "loading"
    ? "Loading the verified GLB resource…"
    : phase.kind === "error"
    ? "3D preview unavailable"
    : "No interactive geometry";

  return (
    <>
      <Toolbar className="geometry-scene-controls" label="3D model controls">
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
      <Slot3D
        label={canonicalSession
          ? "Interactive recorded GLB projection linked to Digital Thread geometry"
          : reviewSession
          ? "Interactive Project geometry review projection"
          : "Interactive build123d 3D model"}
        statusLabel={status}
      >
        <div class="cad-stage">
          <div
            ref={viewport}
            class="cad-viewport"
            role="img"
            aria-label={status}
          />
          <div class="cad-reticle" aria-hidden="true" />
          {phase.kind === "ready" && (
            <div class="cad-hud" aria-live="polite">
              <Badge tone="success">
                {viewerSession ? "Projection digest verified" : "Verified GLB"}
              </Badge>
              <span>
                {formatCount(phase.meshes, locale)}{" "}
                {phase.meshes === 1 ? "mesh" : "meshes"} ·{" "}
                {formatCount(phase.nodes, locale)}{" "}
                {phase.nodes === 1 ? "node" : "nodes"}
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
                  : sessionProjection?.status === "unresolved" ||
                      sessionProjection?.status === "unavailable"
                  ? `Projection ${sessionProjection.status}`
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
      </Slot3D>
    </>
  );
};

export const BUILD123D_COMPONENT_REGISTRY = defineComponentRegistry<
  GeometryComponentData,
  PreactSurfaceContext<GeometryComponentData>
>({
  components: {
    [BUILD123D_COMPONENT_KEYS.datasheet]: definePreactComponent(
      {
        title: "Geometry datasheet",
        description:
          "One geometry identity with its primary readings, the interactive verified GLB, titled facts and exact provenance.",
      },
      GeometryDatasheet,
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
