import type { GeometryResult } from "./contract.ts";

export const BUILD123D_COMPONENT_KEYS = {
  status: "build123d.geometry-status",
  metrics: "build123d.geometry-metrics",
  canvas: "build123d.geometry-canvas",
  artifacts: "build123d.export-artifacts",
} as const;

export interface GeometryComponentData {
  readonly result: GeometryResult;
}

export interface GeometryStatusValue {
  readonly label: string;
  readonly detail: string;
  readonly tone: "success";
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

export function geometryStatusValue(
  data: GeometryComponentData,
): GeometryStatusValue {
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
