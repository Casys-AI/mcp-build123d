import type { GeometryResult } from "./contract.ts";
import { geometryMessages } from "./locale.ts";
import type {
  Build123dRecordedGeometryProjection,
  Build123dRecordedResourceReader,
  Build123dViewerSession,
} from "../../recorded-view-session.ts";
import {
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
} from "../../recorded-view-session.ts";

export const BUILD123D_COMPONENT_KEYS = {
  datasheet: "build123d.geometry-datasheet",
  status: "build123d.geometry-status",
  metrics: "build123d.geometry-metrics",
  canvas: "build123d.geometry-canvas",
  artifacts: "build123d.export-artifacts",
} as const;

export interface ToolGeometryComponentData {
  readonly result: GeometryResult;
}

export interface ViewerSessionGeometryComponentData {
  readonly source: "viewer-session";
  readonly session: Build123dViewerSession;
  /** Fingerprint-only access through the explicit read-only parent bridge. */
  readonly readResource: Build123dRecordedResourceReader;
}

export type GeometryComponentData =
  | ToolGeometryComponentData
  | ViewerSessionGeometryComponentData;

export type GeometryTone = "success" | "info" | "warning" | "neutral";

/** The ident line of the datasheet: one literal status, one title, one detail. */
export interface GeometryIdentity {
  /** Literal status word; the kit renders it as the ident marker. */
  readonly marker: string;
  readonly label: string;
  readonly detail: string;
  readonly tone: GeometryTone;
}

/** Structured identity carried by the semantic element, never resolved here. */
export interface GeometryReference {
  readonly domain: "build123d";
  readonly kind: string;
  readonly id: string;
  readonly basisFingerprint?: string;
}

export interface GeometryProvenance {
  readonly label: string;
  readonly value: string;
}

export interface GeometryReading {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly detail?: string;
}

export interface GeometryFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface GeometryFactSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly GeometryFact[];
}

/** Standalone default: one bounded geometry datasheet, not a 4-pane dashboard. */
export const BUILD123D_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "none" },
  components: [
    {
      id: "geometry-datasheet",
      component: BUILD123D_COMPONENT_KEYS.datasheet,
    },
  ],
} as const;

/**
 * A viewer-session action replaces the complete App read model. It does
 * not require a host-selected component surface and deliberately omits OCCT
 * execution metrics that are not present in the canonical Thread projection.
 */
export const BUILD123D_VIEWER_SESSION_SURFACE = {
  layout: { type: "stack", gap: "none" },
  components: [
    {
      id: "session-geometry-datasheet",
      component: BUILD123D_COMPONENT_KEYS.datasheet,
    },
  ],
} as const;

export function isViewerSessionGeometryData(
  data: GeometryComponentData,
): data is ViewerSessionGeometryComponentData {
  return "source" in data && data.source === "viewer-session";
}

export function isCanonicalRecordedSession(
  session: Build123dViewerSession,
): session is Extract<Build123dViewerSession, {
  schemaVersion: typeof BUILD123D_RECORDED_VIEW_SESSION_SCHEMA;
}> {
  return session.schemaVersion === BUILD123D_RECORDED_VIEW_SESSION_SCHEMA;
}

export function isGeometryReviewSession(
  session: Build123dViewerSession,
): session is Extract<Build123dViewerSession, {
  schemaVersion: typeof BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA;
}> {
  return session.schemaVersion === BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA;
}

/**
 * Recorded sessions own their complete surface. Direct tool results return no
 * override so the component runtime can honor the host-selected surface, with
 * the registry default as its standalone fallback.
 */
export function geometrySurfaceOverride(
  data: GeometryComponentData,
): typeof BUILD123D_VIEWER_SESSION_SURFACE | undefined {
  return isViewerSessionGeometryData(data)
    ? BUILD123D_VIEWER_SESSION_SURFACE
    : undefined;
}

export function geometryIdentity(
  data: GeometryComponentData,
  locale?: string,
): GeometryIdentity {
  const t = geometryMessages(locale);
  if (isViewerSessionGeometryData(data)) {
    const { session } = data;
    const projection = session.projection;
    if (isGeometryReviewSession(session)) {
      return {
        marker: session.status,
        label: t("geometryReview"),
        detail:
          `${session.basis.projectId} · r${session.basis.projectRevision} · ${
            t("reviewRevision", { revision: session.anchor.revision })
          }${projectionSuffix(projection)}`,
        tone: session.status === "provisional" ? "warning" : "neutral",
      };
    }
    return {
      marker: projection.status === "available"
        ? "recorded"
        : projection.status,
      label: t("recordedGeometry"),
      detail:
        `${session.basis.projectId} · r${session.basis.projectRevision} · ${
          t("threadRevision", { revision: session.basis.thread.revision })
        }${projectionSuffix(projection)}`,
      tone: projection.status === "available"
        ? "info"
        : projection.status === "unresolved"
        ? "warning"
        : "neutral",
    };
  }
  const { result } = data;
  return {
    marker: result.kind === "export" ? "exported" : "computed",
    label: t(
      result.kind === "export" ? "exportedGeometry" : "computedGeometry",
    ),
    detail: `build123d · ${topologyLine(result, locale)}`,
    tone: "success",
  };
}

export function geometryReference(
  data: GeometryComponentData,
): GeometryReference {
  if (isViewerSessionGeometryData(data)) {
    const { session } = data;
    if (isGeometryReviewSession(session)) {
      return {
        domain: "build123d",
        kind: session.kind,
        id: session.anchor.id,
        basisFingerprint: digest(session.anchor.fingerprint),
      };
    }
    return {
      domain: "build123d",
      kind: session.kind,
      id: `${session.anchor.kind}:${session.anchor.id}`,
      basisFingerprint: digest(
        session.provenance.canonicalCapture.artifactFingerprint,
      ),
    };
  }
  const primary = data.result.files[0]?.artifact.sha256;
  return {
    domain: "build123d",
    kind: data.result.kind,
    id: primary ?? data.result.kind,
    basisFingerprint: primary,
  };
}

/** One provenance line per datasheet; undefined when the result sealed no bytes. */
export function geometryProvenance(
  data: GeometryComponentData,
  locale?: string,
): GeometryProvenance | undefined {
  const t = geometryMessages(locale);
  if (isViewerSessionGeometryData(data)) {
    const { session } = data;
    if (isGeometryReviewSession(session)) {
      return { label: t("reviewAnchor"), value: session.anchor.fingerprint };
    }
    return {
      label: t("canonicalCapture"),
      value: session.provenance.canonicalCapture.artifactFingerprint,
    };
  }
  const primary = data.result.files[0]?.artifact;
  return primary
    ? {
      label: `${primary.format.toUpperCase()} · ${t("artifact")}`,
      value: `sha256:${primary.sha256}`,
    }
    : undefined;
}

/** At most four primary readings; sessions carry no OCCT execution metrics. */
export function geometryReadings(
  data: GeometryComponentData,
  locale?: string,
): readonly GeometryReading[] {
  if (isViewerSessionGeometryData(data)) return [];
  const t = geometryMessages(locale);
  const metrics = data.result.metrics;
  const readings: GeometryReading[] = [
    {
      id: "volume",
      label: t("volume"),
      value: formatNumber(metrics.volumeMm3, locale),
      unit: "mm³",
    },
    {
      id: "surface-area",
      label: t("surface"),
      value: formatNumber(metrics.areaMm2, locale),
      unit: "mm²",
    },
  ];
  if (metrics.massKg !== undefined) {
    readings.push({
      id: "mass",
      label: t("mass"),
      value: formatNumber(metrics.massKg, locale),
      unit: "kg",
    });
  }
  if (metrics.boundingBoxMm) {
    readings.push({
      id: "bounding-envelope",
      label: t("envelope"),
      value: formatVector(metrics.boundingBoxMm.size, locale, " × "),
      unit: "mm",
    });
  }
  return readings;
}

/** Titled fact sections below the readings; each fact belongs to exactly one. */
export function geometryFactSections(
  data: GeometryComponentData,
  locale?: string,
): readonly GeometryFactSection[] {
  const t = geometryMessages(locale);
  if (isViewerSessionGeometryData(data)) {
    return sessionFactSections(data.session, locale);
  }
  const { result } = data;
  const metrics = result.metrics;
  const geometry: GeometryFact[] = [
    {
      id: "topology",
      label: t("topology"),
      value: topologyLine(result, locale),
    },
  ];
  if (metrics.boundingBoxMm) {
    geometry.push({
      id: "bounding-box",
      label: t("boundingBox"),
      value: `[${formatVector(metrics.boundingBoxMm.min, locale)}] → [${
        formatVector(metrics.boundingBoxMm.max, locale)
      }] mm`,
    });
  }
  if (metrics.centerOfMassMm) {
    geometry.push({
      id: "center-of-mass",
      label: t("centerOfMass"),
      value: `[${formatVector(metrics.centerOfMassMm, locale)}] mm`,
    });
  }
  if (metrics.densityKgM3 !== undefined) {
    geometry.push({
      id: "density",
      label: t("density"),
      value: `${formatNumber(metrics.densityKgM3, locale)} kg/m³`,
    });
  }
  return [{ id: "geometry", title: t("geometry"), items: geometry }];
}

function sessionFactSections(
  session: Build123dViewerSession,
  locale?: string,
): readonly GeometryFactSection[] {
  const t = geometryMessages(locale);
  const projection = projectionFacts(session.projection, locale);
  if (isGeometryReviewSession(session)) {
    const { anchor, basis, provenance, status } = session;
    const draft = provenance.draftCapture;
    return [
      {
        id: "basis",
        title: t("projectBasis"),
        items: [
          {
            id: "project",
            label: t("project"),
            value: `${basis.projectId} r${basis.projectRevision}`,
          },
          { id: "subject", label: t("subject"), value: basis.subjectId },
          {
            id: "review",
            label: t("review"),
            value: `${anchor.id} · r${anchor.revision}`,
          },
          { id: "status", label: t("status"), value: status },
        ],
      },
      {
        id: "draft-capture",
        title: t("draftCapture"),
        items: [
          {
            id: "draft",
            label: t("artifact"),
            value: `${draft.artifactId} · ${draft.artifactVersion}`,
          },
          {
            id: "draft-fingerprint",
            label: t("fingerprint"),
            value: draft.artifactFingerprint,
          },
          {
            id: "draft-producer",
            label: t("producer"),
            value:
              `${draft.producer.serverId} · ${draft.producer.tool} · ${draft.producer.runId}`,
          },
        ],
      },
      { id: "projection", title: t("glbProjection"), items: projection },
    ];
  }
  const { anchor, basis, provenance } = session;
  const capture = provenance.canonicalCapture;
  return [
    {
      id: "basis",
      title: t("threadBasis"),
      items: [
        {
          id: "project",
          label: t("project"),
          value: `${basis.projectId} r${basis.projectRevision}`,
        },
        { id: "subject", label: t("subject"), value: basis.subjectId },
        {
          id: "thread",
          label: t("thread"),
          value: `${basis.thread.id} r${basis.thread.revision}`,
        },
        {
          id: "anchor",
          label: t("anchor"),
          value: `${anchor.kind}:${anchor.id}`,
        },
      ],
    },
    {
      id: "canonical-capture",
      title: t("canonicalCapture"),
      items: [
        {
          id: "capture",
          label: t("artifact"),
          value: `${capture.artifactId} · ${capture.artifactVersion}`,
        },
        {
          id: "capture-fingerprint",
          label: t("fingerprint"),
          value: capture.artifactFingerprint,
        },
        {
          id: "capture-producer",
          label: t("producer"),
          value: `${capture.producer.serverId} · ${capture.producer.tool}`,
        },
        { id: "capture-run", label: t("run"), value: capture.producer.runId },
      ],
    },
    { id: "projection", title: t("glbProjection"), items: projection },
  ];
}

function projectionFacts(
  projection: Build123dRecordedGeometryProjection,
  locale?: string,
): readonly GeometryFact[] {
  const t = geometryMessages(locale);
  if (projection.status !== "available") {
    return [
      { id: "projection-status", label: t("status"), value: projection.status },
      { id: "projection-reason", label: t("reason"), value: projection.reason },
    ];
  }
  const { artifact } = projection;
  return [
    { id: "projection-status", label: t("status"), value: projection.status },
    {
      id: "projection-artifact",
      label: t("artifact"),
      value: `${artifact.artifactId} · ${artifact.artifactVersion}`,
    },
    {
      id: "projection-fingerprint",
      label: t("fingerprint"),
      value: artifact.artifactFingerprint,
    },
    {
      id: "projection-producer",
      label: t("producer"),
      value:
        `${artifact.producer.serverId} · ${artifact.producer.tool} · ${artifact.producer.runId}`,
    },
  ];
}

function projectionSuffix(
  projection: Build123dRecordedGeometryProjection,
): string {
  return projection.status === "available" ? "" : ` · ${projection.reason}`;
}

function topologyLine(result: GeometryResult, locale?: string): string {
  const t = geometryMessages(locale);
  const { solids, faces, edges } = result.metrics;
  return `${formatCount(solids, locale)} ${
    t(solids === 1 ? "solid" : "solids")
  } · ${formatCount(faces, locale)} ${t(faces === 1 ? "face" : "faces")} · ${
    formatCount(edges, locale)
  } ${t(edges === 1 ? "edge" : "edges")}`;
}

function digest(fingerprint: `sha256:${string}`): string {
  return fingerprint.slice("sha256:".length);
}

/** The host declares the locale; the viewing machine's own setting is not it. */
export function formatNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale ?? "en", { maximumFractionDigits: 4 })
    .format(
      value,
    );
}

export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale ?? "en").format(value);
}

function formatVector(
  vector: readonly number[],
  locale?: string,
  separator = ", ",
): string {
  return vector.map((component) => formatNumber(component, locale)).join(
    separator,
  );
}

/** Byte sizes as the readers see them in file managers: KB/MB, one decimal. */
export function formatBytes(value: number, locale?: string): string {
  const unit = value < 1024 ? "B" : value < 1024 * 1024 ? "KB" : "MB";
  const scaled = unit === "B"
    ? value
    : unit === "KB"
    ? value / 1024
    : value / (1024 * 1024);
  const digits = unit === "B" ? 0 : 1;
  return `${
    new Intl.NumberFormat(locale ?? "en", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(scaled)
  } ${unit}`;
}
