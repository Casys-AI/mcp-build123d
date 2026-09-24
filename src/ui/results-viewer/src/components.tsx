/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view-components";
import {
  ArtifactRow,
  Badge,
  Button,
  Card,
  definePreactComponent,
  ElementIdent,
  ElementSection,
  EmptyState,
  FocusedView,
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
import { ViewerBrandFooter } from "../../shared/branding.tsx";
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
  geometryReadings,
  geometryReference,
  isCanonicalRecordedSession,
  isGeometryReviewSession,
  isViewerSessionGeometryData,
} from "./component-model.ts";
import {
  type CadMeasurement,
  DEFAULT_SECTION_PLANE,
  formatMillimetres,
  type SectionAxis,
  type SectionPlaneState,
} from "./inspection-model.ts";
import { type CadSceneController, mountCadScene } from "./scene.ts";
import { geometryMessages } from "./locale.ts";

type Props = PreactSurfaceComponentProps<GeometryComponentData>;

/**
 * Model and recorded state stay visible; exact technical details are available
 * through the kit's native disclosure. The small components below expose the
 * same data to a host that explicitly chooses them.
 */
const GeometryDatasheet = ({ data, context }: Props) => {
  const locale = context.hostContext.locale;
  const t = geometryMessages(locale);
  const identity = geometryIdentity(data, locale);
  const readings = geometryReadings(data, locale);
  return (
    <>
      <FocusedView
        className="geometry-datasheet"
        label={identity.label}
        hostContext={context.hostContext}
        status={
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
          />
        }
        primary={
          <>
            <GeometryScene data={data} context={context} />
            {readings.length > 0 && (
              <MetricGrid className="geometry-readings" items={readings} />
            )}
          </>
        }
        detailsLabel={t("details")}
        details={
          <>
            <FactSections sections={geometryFactSections(data, locale)} />
            {!isViewerSessionGeometryData(data) && (
              <ElementSection title={t("artifacts")}>
                <Artifacts files={data.result.files} locale={locale} />
              </ElementSection>
            )}
          </>
        }
      />
      <ViewerBrandFooter />
    </>
  );
};

/** Technical fields remain exact and belong to the secondary inspector. */
const Facts = ({ items }: { readonly items: readonly GeometryFact[] }) => (
  <KeyValueList layout="inspector" items={items} />
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
        {geometryMessages(locale)("noExports")}
      </EmptyState>
    );

const GeometryStatus = ({ data, context }: Props) => {
  const identity = geometryIdentity(data, context.hostContext.locale);
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
    />
  );
};

const GeometryMetrics = ({ data, context }: Props) => {
  const locale = context.hostContext.locale;
  const t = geometryMessages(locale);
  return (
    <Card title={t("readings")} eyebrow={t("exactMeasures")}>
      {isViewerSessionGeometryData(data)
        ? (
          <EmptyState>
            {t("noSessionMetrics")}
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
    title={geometryMessages(context.hostContext.locale)("model")}
    eyebrow={isViewerSessionGeometryData(data)
      ? geometryMessages(context.hostContext.locale)("readOnlyProjection")
      : geometryMessages(context.hostContext.locale)("geometryInspection")}
  >
    <GeometryScene data={data} context={context} />
  </Card>
);

const ExportArtifacts = ({ data, context }: Props) =>
  isViewerSessionGeometryData(data)
    ? (
      <Card
        title={geometryMessages(context.hostContext.locale)("provenance")}
        eyebrow={isGeometryReviewSession(data.session)
          ? geometryMessages(context.hostContext.locale)("projectDraft")
          : geometryMessages(context.hostContext.locale)("canonicalEvidence")}
      >
        <FactSections
          sections={geometryFactSections(data, context.hostContext.locale)}
        />
      </Card>
    )
    : (
      <Card
        title={geometryMessages(context.hostContext.locale)("artifacts")}
        eyebrow={geometryMessages(context.hostContext.locale)(
          "immutableResources",
        )}
      >
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
  const t = geometryMessages(locale);
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
  const [section, setSection] = useState<SectionPlaneState>(
    DEFAULT_SECTION_PLANE,
  );
  const [sectionCoordinateMm, setSectionCoordinateMm] = useState<number>();
  const [measurementEnabled, setMeasurementEnabled] = useState(false);
  const [measurement, setMeasurement] = useState<CadMeasurement>();
  const [phase, setPhase] = useState<CanvasPhase>(() =>
    initialCanvasPhase(sessionProjection, gltf !== undefined, locale)
  );

  useEffect(() => {
    const target = viewport.current;
    controller.current?.dispose();
    controller.current = undefined;
    setWireframe(false);
    setSection(DEFAULT_SECTION_PLANE);
    setSectionCoordinateMm(undefined);
    setMeasurementEnabled(false);
    setMeasurement(undefined);

    if (!target || (!gltf && !sessionAvailable)) {
      setPhase(initialCanvasPhase(sessionProjection, false, locale));
      return;
    }

    let cancelled = false;
    let mounted: CadSceneController | undefined;
    setPhase({ kind: "loading", detail: t("loadingResource") });

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
        mounted = await mountCadScene(target, decodedBytes, {
          onMeasurementChange(next) {
            if (!cancelled) setMeasurement(next);
          },
        });
        if (cancelled) {
          mounted.dispose();
          return;
        }
        controller.current = mounted;
        setSectionCoordinateMm(
          mounted.setSectionPlane(DEFAULT_SECTION_PLANE).coordinateMm,
        );
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
          detail: error instanceof Error ? error.message : t("modelLoadFailed"),
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
    ? `${t(viewerSession ? "projectionVerified" : "glbVerified")} · ${
      formatBytes(phase.bytes, locale)
    } · ${t("navigation")}`
    : phase.kind === "loading"
    ? t("loadingResource")
    : phase.kind === "error"
    ? t("previewUnavailable")
    : t("noGeometry");

  const applySection = (next: SectionPlaneState): void => {
    // Mesh picks describe the currently rendered surface. A changed cut can
    // hide either point, so discard the old overlay instead of leaving a
    // plausible-looking line detached from visible geometry.
    if (measurement) controller.current?.clearMeasurement();
    setSection(next);
    const definition = controller.current?.setSectionPlane(next);
    if (definition) setSectionCoordinateMm(definition.coordinateMm);
  };
  const chooseSectionAxis = (axis: SectionAxis): void => {
    applySection({ ...section, axis });
  };
  const toggleMeasurement = (): void => {
    const next = !measurementEnabled;
    if (!next && measurement?.pointsMm.length === 1) {
      controller.current?.clearMeasurement();
    }
    controller.current?.setMeasurementEnabled(next);
    setMeasurementEnabled(next);
  };
  const measurementStatus = measurement?.distanceMm !== undefined
    ? t("meshDistance", {
      distance: formatMillimetres(measurement.distanceMm, locale),
    })
    : measurement
    ? t("pickSecondPoint")
    : t("pickFirstPoint");

  return (
    <>
      <Toolbar className="geometry-scene-controls" label={t("controls")}>
        <Button
          disabled={phase.kind !== "ready"}
          onClick={() => controller.current?.fit()}
        >
          {t("fit")}
        </Button>
        <Button
          disabled={phase.kind !== "ready"}
          onClick={() => controller.current?.reset()}
        >
          {t("reset")}
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
          {t("wireframe")}
        </Button>
        <Button
          disabled={phase.kind !== "ready"}
          pressed={section.enabled}
          title={t("sectionHelp")}
          onClick={() =>
            applySection({ ...section, enabled: !section.enabled })}
        >
          {t("section")}
        </Button>
        {section.enabled && (
          <>
            <span
              class="cad-axis-controls"
              role="group"
              aria-label={t("sectionAxis")}
            >
              {(["x", "y", "z"] as const).map((axis) => (
                <Button
                  className="cad-axis-button"
                  disabled={phase.kind !== "ready"}
                  key={axis}
                  pressed={section.axis === axis}
                  title={t("sectionAxisChoice", { axis: axis.toUpperCase() })}
                  onClick={() => chooseSectionAxis(axis)}
                >
                  {axis.toUpperCase()}
                </Button>
              ))}
            </span>
            <label class="cad-section-position">
              <span>{t("sectionPosition")}</span>
              <input
                aria-label={t("sectionPosition")}
                aria-valuetext={sectionCoordinateMm === undefined
                  ? undefined
                  : `${formatMillimetres(sectionCoordinateMm, locale)} mm`}
                disabled={phase.kind !== "ready"}
                max="1"
                min="0"
                step="0.01"
                type="range"
                value={section.position}
                onInput={(event) =>
                  applySection({
                    ...section,
                    position: Number(event.currentTarget.value),
                  })}
              />
            </label>
            <Button
              disabled={phase.kind !== "ready"}
              pressed={section.flipped}
              title={t("flipSectionHelp")}
              onClick={() =>
                applySection({ ...section, flipped: !section.flipped })}
            >
              {t("flipSection")}
            </Button>
          </>
        )}
        <Button
          disabled={phase.kind !== "ready"}
          pressed={measurementEnabled}
          title={t("measurementHelp")}
          onClick={toggleMeasurement}
        >
          {t("measure")}
        </Button>
        {measurement && (
          <Button
            disabled={phase.kind !== "ready"}
            onClick={() => controller.current?.clearMeasurement()}
          >
            {t("clearMeasurement")}
          </Button>
        )}
      </Toolbar>
      <Slot3D
        label={canonicalSession
          ? t("recordedModelLabel")
          : reviewSession
          ? t("reviewModelLabel")
          : t("modelLabel")}
        statusLabel={status}
      >
        <div class="cad-stage">
          <div
            ref={viewport}
            class="cad-viewport"
            role="img"
            aria-keyshortcuts={measurementEnabled ? "Enter Space" : undefined}
            aria-label={measurementEnabled
              ? `${status}. ${measurementStatus} ${
                t("measurementKeyboardHint")
              }`
              : status}
            tabIndex={measurementEnabled ? 0 : undefined}
            onKeyDown={(event) => {
              if (
                !measurementEnabled ||
                (event.key !== "Enter" && event.key !== " ")
              ) return;
              event.preventDefault();
              controller.current?.pickMeasurementAtCenter();
            }}
          />
          <div class="cad-reticle" aria-hidden="true" />
          {phase.kind === "ready" && (
            <div class="cad-hud" aria-live="polite">
              <Badge tone="success">
                {t(viewerSession ? "projectionVerified" : "glbVerified")}
              </Badge>
              <span>
                {formatCount(phase.meshes, locale)}{" "}
                {t(phase.meshes === 1 ? "mesh" : "meshes")} ·{" "}
                {formatCount(phase.nodes, locale)}{" "}
                {t(phase.nodes === 1 ? "node" : "nodes")}
              </span>
            </div>
          )}
          {phase.kind === "ready" &&
            (section.enabled || measurementEnabled || measurement) && (
            <div class="cad-inspection-hud" aria-live="polite">
              {section.enabled && sectionCoordinateMm !== undefined && (
                <span>
                  {t("sectionSummary", {
                    axis: section.axis.toUpperCase(),
                    position: formatMillimetres(sectionCoordinateMm, locale),
                    side: `${
                      section.flipped ? "−" : "+"
                    }${section.axis.toUpperCase()}`,
                  })}
                </span>
              )}
              {(measurementEnabled || measurement) && (
                <span>{measurementStatus}</span>
              )}
            </div>
          )}
          {phase.kind !== "ready" && (
            <div class="cad-state-overlay">
              <StateMessage
                title={phase.kind === "loading"
                  ? t("loadingGeometry")
                  : phase.kind === "error"
                  ? t("previewUnavailable")
                  : sessionProjection?.status === "unresolved" ||
                      sessionProjection?.status === "unavailable"
                  ? t("projectionStatus", { status: sessionProjection.status })
                  : t("noGeometry")}
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
          "Interactive verified GLB resource canvas with orbit, pan, visual sectioning and approximate two-point mesh measurement.",
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
  locale?: string,
): CanvasPhase {
  const t = geometryMessages(locale);
  if (projection?.status === "available" || hasToolGltf) {
    return { kind: "loading", detail: t("loadingResource") };
  }
  if (
    projection?.status === "unavailable" || projection?.status === "unresolved"
  ) {
    return { kind: "empty", detail: projection.reason };
  }
  return {
    kind: "empty",
    detail: t("requestGltf"),
  };
}
