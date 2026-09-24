export type SectionAxis = "x" | "y" | "z";

export type ScenePoint = readonly [number, number, number];

export interface SceneBounds {
  readonly min: ScenePoint;
  readonly max: ScenePoint;
}

export interface SectionPlaneState {
  readonly enabled: boolean;
  readonly axis: SectionAxis;
  /** Normalized position inside the complete GLB bounds. */
  readonly position: number;
  /** Keep the negative side of the selected axis instead of the positive side. */
  readonly flipped: boolean;
}

export interface SectionPlaneDefinition {
  readonly normal: ScenePoint;
  readonly constant: number;
  readonly coordinateMm: number;
}

export interface CadMeasurement {
  readonly pointsMm: readonly [ScenePoint] | readonly [ScenePoint, ScenePoint];
  readonly distanceMm?: number;
}

/** glTF defines linear coordinates in metres; Build123d reports its CAD facts in mm. */
export const GLTF_METRES_TO_MILLIMETRES = 1_000;

export const DEFAULT_SECTION_PLANE: SectionPlaneState = Object.freeze({
  enabled: false,
  axis: "x",
  position: 0.5,
  flipped: false,
});

/** Resolve the visual clipping plane from the complete, uncut model bounds. */
export function sectionPlaneDefinition(
  bounds: SceneBounds,
  state: SectionPlaneState,
): SectionPlaneDefinition {
  const axisIndex = state.axis === "x" ? 0 : state.axis === "y" ? 1 : 2;
  const position = Number.isFinite(state.position)
    ? Math.min(Math.max(state.position, 0), 1)
    : DEFAULT_SECTION_PLANE.position;
  const coordinate = bounds.min[axisIndex] +
    (bounds.max[axisIndex] - bounds.min[axisIndex]) * position;
  const direction = state.flipped ? -1 : 1;
  const normal: [number, number, number] = [0, 0, 0];
  normal[axisIndex] = direction;
  return {
    normal,
    constant: -direction * coordinate,
    coordinateMm: coordinate * GLTF_METRES_TO_MILLIMETRES,
  };
}

export function scenePointToMillimetres(point: ScenePoint): ScenePoint {
  return point.map((value) => value * GLTF_METRES_TO_MILLIMETRES) as [
    number,
    number,
    number,
  ];
}

/** A third pick begins a fresh two-point measurement. */
export function appendMeasurementPoint(
  current: CadMeasurement | undefined,
  scenePoint: ScenePoint,
): CadMeasurement {
  const pointMm = scenePointToMillimetres(scenePoint);
  if (!current || current.pointsMm.length === 2) {
    return { pointsMm: [pointMm] };
  }
  const start = current.pointsMm[0];
  return {
    pointsMm: [start, pointMm],
    distanceMm: Math.hypot(
      pointMm[0] - start[0],
      pointMm[1] - start[1],
      pointMm[2] - start[2],
    ),
  };
}

export function formatMillimetres(value: number, locale?: string): string {
  const displayValue = Math.abs(value) < 0.0005 ? 0 : value;
  return new Intl.NumberFormat(locale ?? "en", {
    maximumFractionDigits: 3,
  }).format(displayValue);
}
