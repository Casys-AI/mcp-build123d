import type { GeometryResult } from "./contract.ts";
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
  if (isViewerSessionGeometryData(data)) {
    const { session } = data;
    const projection = session.projection;
    if (isGeometryReviewSession(session)) {
      return {
        marker: session.status,
        label: "Geometry review",
        detail:
          `${session.basis.projectId} r${session.basis.projectRevision} · ${session.basis.subjectId} · review r${session.anchor.revision}${
            projectionSuffix(projection)
          }`,
        tone: session.status === "provisional" ? "warning" : "neutral",
      };
    }
    return {
      marker: projection.status === "available"
        ? "recorded"
        : projection.status,
      label: "Recorded geometry projection",
      detail:
        `${session.basis.projectId} r${session.basis.projectRevision} · ${session.basis.thread.id} r${session.basis.thread.revision} · ${session.anchor.kind}:${session.anchor.id}${
          projectionSuffix(projection)
        }`,
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
    label: result.kind === "export" ? "Exported geometry" : "Computed geometry",
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
): GeometryProvenance | undefined {
  if (isViewerSessionGeometryData(data)) {
    const { session } = data;
    if (isGeometryReviewSession(session)) {
      return { label: "Review anchor", value: session.anchor.fingerprint };
    }
    return {
      label: "Canonical capture",
      value: session.provenance.canonicalCapture.artifactFingerprint,
    };
  }
  const primary = data.result.files[0]?.artifact;
  return primary
    ? {
      label: `${primary.format.toUpperCase()} artifact`,
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
  const metrics = data.result.metrics;
  const readings: GeometryReading[] = [
    {
      id: "volume",
      label: "Volume",
      value: formatNumber(metrics.volumeMm3, locale),
      unit: "mm³",
    },
    {
      id: "surface-area",
      label: "Surface",
      value: formatNumber(metrics.areaMm2, locale),
      unit: "mm²",
    },
  ];
  if (metrics.massKg !== undefined) {
    readings.push({
      id: "mass",
      label: "Mass",
      value: formatNumber(metrics.massKg, locale),
      unit: "kg",
    });
  }
  if (metrics.boundingBoxMm) {
    readings.push({
      id: "bounding-envelope",
      label: "Envelope",
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
  if (isViewerSessionGeometryData(data)) {
    return sessionFactSections(data.session);
  }
  const { result } = data;
  const metrics = result.metrics;
  const geometry: GeometryFact[] = [
    { id: "topology", label: "Topology", value: topologyLine(result, locale) },
  ];
  if (metrics.boundingBoxMm) {
    geometry.push({
      id: "bounding-box",
      label: "Bounding box",
      value: `[${formatVector(metrics.boundingBoxMm.min, locale)}] → [${
        formatVector(metrics.boundingBoxMm.max, locale)
      }] mm`,
    });
  }
  if (metrics.centerOfMassMm) {
    geometry.push({
      id: "center-of-mass",
      label: "Center of mass",
      value: `[${formatVector(metrics.centerOfMassMm, locale)}] mm`,
    });
  }
  if (metrics.densityKgM3 !== undefined) {
    geometry.push({
      id: "density",
      label: "Density",
      value: `${formatNumber(metrics.densityKgM3, locale)} kg/m³`,
    });
  }
  return [{ id: "geometry", title: "Geometry", items: geometry }];
}

function sessionFactSections(
  session: Build123dViewerSession,
): readonly GeometryFactSection[] {
  const projection = projectionFacts(session.projection);
  if (isGeometryReviewSession(session)) {
    const { anchor, basis, provenance, status } = session;
    const draft = provenance.draftCapture;
    return [
      {
        id: "basis",
        title: "Project basis",
        items: [
          {
            id: "project",
            label: "Project",
            value: `${basis.projectId} r${basis.projectRevision}`,
          },
          { id: "subject", label: "Subject", value: basis.subjectId },
          {
            id: "review",
            label: "Review",
            value: `${anchor.id} · r${anchor.revision}`,
          },
          { id: "status", label: "Status", value: status },
        ],
      },
      {
        id: "draft-capture",
        title: "Draft capture",
        items: [
          {
            id: "draft",
            label: "Artifact",
            value: `${draft.artifactId} · ${draft.artifactVersion}`,
          },
          {
            id: "draft-fingerprint",
            label: "Fingerprint",
            value: draft.artifactFingerprint,
          },
          {
            id: "draft-producer",
            label: "Producer",
            value:
              `${draft.producer.serverId} · ${draft.producer.tool} · ${draft.producer.runId}`,
          },
        ],
      },
      { id: "projection", title: "GLB projection", items: projection },
    ];
  }
  const { anchor, basis, provenance } = session;
  const capture = provenance.canonicalCapture;
  return [
    {
      id: "basis",
      title: "Thread basis",
      items: [
        {
          id: "project",
          label: "Project",
          value: `${basis.projectId} r${basis.projectRevision}`,
        },
        { id: "subject", label: "Subject", value: basis.subjectId },
        {
          id: "thread",
          label: "Thread",
          value: `${basis.thread.id} r${basis.thread.revision}`,
        },
        { id: "anchor", label: "Anchor", value: `${anchor.kind}:${anchor.id}` },
      ],
    },
    {
      id: "canonical-capture",
      title: "Canonical capture",
      items: [
        {
          id: "capture",
          label: "Artifact",
          value: `${capture.artifactId} · ${capture.artifactVersion}`,
        },
        {
          id: "capture-fingerprint",
          label: "Fingerprint",
          value: capture.artifactFingerprint,
        },
        {
          id: "capture-producer",
          label: "Producer",
          value: `${capture.producer.serverId} · ${capture.producer.tool}`,
        },
        { id: "capture-run", label: "Run", value: capture.producer.runId },
      ],
    },
    { id: "projection", title: "GLB projection", items: projection },
  ];
}

function projectionFacts(
  projection: Build123dRecordedGeometryProjection,
): readonly GeometryFact[] {
  if (projection.status !== "available") {
    return [
      { id: "projection-status", label: "Status", value: projection.status },
      { id: "projection-reason", label: "Reason", value: projection.reason },
    ];
  }
  const { artifact } = projection;
  return [
    { id: "projection-status", label: "Status", value: projection.status },
    {
      id: "projection-artifact",
      label: "Artifact",
      value: `${artifact.artifactId} · ${artifact.artifactVersion}`,
    },
    {
      id: "projection-fingerprint",
      label: "Fingerprint",
      value: artifact.artifactFingerprint,
    },
    {
      id: "projection-producer",
      label: "Producer",
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
  const { solids, faces, edges } = result.metrics;
  return `${formatCount(solids, locale)} ${plural(solids, "solid")} · ${
    formatCount(faces, locale)
  } ${plural(faces, "face")} · ${formatCount(edges, locale)} ${
    plural(edges, "edge")
  }`;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

function digest(fingerprint: `sha256:${string}`): string {
  return fingerprint.slice("sha256:".length);
}

/** The host declares the locale; the viewing machine's own setting is not it. */
export function formatNumber(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
    value,
  );
}

export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
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
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(scaled)
  } ${unit}`;
}
