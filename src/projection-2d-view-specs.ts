/** Canonical public identities for each fixed 2D projection view. */

export const DRAWING_PROJECTION_REQUIRED_VIEW_IDS = [
  "top",
  "front",
  "right",
  "isometric",
] as const;

export const DRAWING_PROJECTION_SECTION_VIEW_ID = "section-yz" as const;

export const DRAWING_PROJECTION_REQUIRED_VIEW_SPECS = [
  {
    id: DRAWING_PROJECTION_REQUIRED_VIEW_IDS[0],
    label: "Top",
    orientation: "Orthographic projection along -Z",
  },
  {
    id: DRAWING_PROJECTION_REQUIRED_VIEW_IDS[1],
    label: "Front",
    orientation: "Orthographic projection along +Y",
  },
  {
    id: DRAWING_PROJECTION_REQUIRED_VIEW_IDS[2],
    label: "Right",
    orientation: "Orthographic projection along -X",
  },
  {
    id: DRAWING_PROJECTION_REQUIRED_VIEW_IDS[3],
    label: "Isometric",
    orientation: "Orthographic projection along (-1,-1,-1)",
  },
] as const;

export const DRAWING_PROJECTION_SECTION_VIEW_SPEC = {
  id: DRAWING_PROJECTION_SECTION_VIEW_ID,
  label: "Section YZ",
  orientation: "YZ section at envelope midpoint X",
} as const;

export const DRAWING_PROJECTION_VIEW_SPECS = [
  ...DRAWING_PROJECTION_REQUIRED_VIEW_SPECS,
  DRAWING_PROJECTION_SECTION_VIEW_SPEC,
] as const;
