import type { GeometryResult } from "./contract.ts";
import type {
  Build123dRecordedResourceReader,
  Build123dViewerSession,
} from "../../recorded-view-session.ts";
import {
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
} from "../../recorded-view-session.ts";

export const BUILD123D_COMPONENT_KEYS = {
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

export interface GeometryStatusValue {
  readonly label: string;
  readonly detail: string;
  readonly tone: "success" | "info" | "warning" | "neutral";
}

export interface GeometryMetricValue {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly detail?: string;
}

/** Standalone mode is simply the default composition of every small component. */
export const BUILD123D_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "md" },
  components: [
    { id: "geometry-status", component: BUILD123D_COMPONENT_KEYS.status },
    { id: "geometry-metrics", component: BUILD123D_COMPONENT_KEYS.metrics },
    { id: "geometry-canvas", component: BUILD123D_COMPONENT_KEYS.canvas },
    { id: "export-artifacts", component: BUILD123D_COMPONENT_KEYS.artifacts },
  ],
} as const;

/**
 * A viewer-session action replaces the complete App read model. It does
 * not require a host-selected component surface and deliberately omits OCCT
 * execution metrics that are not present in the canonical Thread projection.
 */
export const BUILD123D_VIEWER_SESSION_SURFACE = {
  layout: { type: "stack", gap: "md" },
  components: [
    {
      id: "session-geometry-status",
      component: BUILD123D_COMPONENT_KEYS.status,
    },
    {
      id: "session-geometry-canvas",
      component: BUILD123D_COMPONENT_KEYS.canvas,
    },
    {
      id: "session-geometry-provenance",
      component: BUILD123D_COMPONENT_KEYS.artifacts,
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

export function geometryStatusValue(
  data: GeometryComponentData,
): GeometryStatusValue {
  if (isViewerSessionGeometryData(data)) {
    if (isGeometryReviewSession(data.session)) {
      const projection = data.session.projection;
      return {
        label: data.session.status.toUpperCase(),
        detail: projection.status === "available"
          ? `Review GLB projection · SHA-256 ${
            projection.artifact.artifactFingerprint.slice(
              "sha256:".length,
              19,
            )
          }…`
          : `${projection.status.toUpperCase()} · ${projection.reason}`,
        tone: data.session.status === "provisional" ? "warning" : "neutral",
      };
    }
    const projection = data.session.projection;
    if (projection.status === "available") {
      return {
        label: "RECORDED",
        detail: `Recorded GLB projection · SHA-256 ${
          projection.artifact.artifactFingerprint.slice("sha256:".length, 19)
        }…`,
        tone: "info",
      };
    }
    return {
      label: projection.status.toUpperCase(),
      detail: projection.reason,
      tone: projection.status === "unresolved" ? "warning" : "neutral",
    };
  }
  const result = data.result;
  const identity = result.files[0]?.artifact.sha256.slice(0, 12);
  const topology = `${result.metrics.solids} solide${
    result.metrics.solids === 1 ? "" : "s"
  } · ${result.metrics.faces} faces`;
  return {
    label: result.kind === "export" ? "EXPORTÉ" : "CALCULÉ",
    detail: identity ? `SHA-256 ${identity}… · ${topology}` : topology,
    tone: "success",
  };
}

export function geometryMetricValues(
  data: GeometryComponentData,
): readonly GeometryMetricValue[] {
  if (isViewerSessionGeometryData(data)) return [];
  const metrics = data.result.metrics;
  const values: GeometryMetricValue[] = [
    {
      id: "volume",
      label: "Volume",
      value: numeric(metrics.volumeMm3),
      unit: "mm³",
    },
    {
      id: "surface-area",
      label: "Surface",
      value: numeric(metrics.areaMm2),
      unit: "mm²",
    },
  ];
  if (metrics.boundingBoxMm) {
    values.push({
      id: "bounding-envelope",
      label: "Envelope",
      value: metrics.boundingBoxMm.size.map(numeric).join(" × "),
      unit: "mm",
    });
  }
  if (metrics.centerOfMassMm) {
    values.push({
      id: "center-of-mass",
      label: "Centre de masse",
      value: metrics.centerOfMassMm.map(numeric).join(" × "),
      unit: "mm",
    });
  }
  values.push({
    id: "topology",
    label: "Topologie",
    value: `${metrics.solids} / ${metrics.faces} / ${metrics.edges}`,
    detail: "solides / faces / arêtes",
  });
  if (metrics.massKg !== undefined) {
    values.push({
      id: "mass",
      label: "Masse",
      value: numeric(metrics.massKg),
      unit: "kg",
    });
  }
  if (metrics.densityKgM3 !== undefined) {
    values.push({
      id: "density",
      label: "Densité",
      value: numeric(metrics.densityKgM3),
      unit: "kg/m³",
    });
  }
  return values;
}

function numeric(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(
    value,
  );
}
