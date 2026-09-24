# Viewer inventory

This inventory lists the three viewer resources registered by `mcp-build123d`,
the components inside the geometry App, and the role of the local Inspector
examples.

## Registered Build123d viewers

| Resource                             | Bound input                                                                                             | Purpose                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `ui://mcp-build123d/results-viewer`  | `build123d_execute`, `build123d_export`, recorded Digital Thread geometry, and Project geometry reviews | Interactive 3D geometry datasheet        |
| `ui://mcp-build123d/assembly-viewer` | `build123d_observe_assembly_integrity`                                                                  | Factual STEP assembly observation        |
| `ui://mcp-build123d/drawing-viewer`  | `build123d_project_2d`                                                                                  | Fixed STEP-to-SVG inspection projections |

The three resources share the MCP View presentation, host theme and locale
handling, and the exact `Powered by Casys.ai` footer used to identify Casys in
the ERPNext beta viewers. Their generated standalone bundles live under
`src/ui/dist/` and remain optional for text-only MCP clients.

### Geometry viewer

The default `build123d.geometry-datasheet` surface contains one status row, the
verified GLB, up to four readings, and technical details behind the native
disclosure. Its Three.js scene supports orbit, pan, zoom, fit, reset, wireframe,
visual section cuts, and an approximate two-point measurement on the displayed
GLB mesh.

The section and measurement controls are inspection aids. The measurement is
computed from two selected mesh points and does not replace the exact BREP
metrics returned by OCCT. The same registry exposes four smaller components to
Compose hosts:

- `build123d.geometry-status`
- `build123d.geometry-metrics`
- `build123d.geometry-canvas`
- `build123d.export-artifacts`

These are components of the geometry App, not additional viewer resources.

### Assembly viewer

The assembly viewer consumes the existing bounded
`build123d-assembly-integrity-observation/1.0` result. It presents the exact
source and method identity, import and topology facts, direct occurrences and
placements, and the fixed pair observations for minimum distance, contact, and
intersection volume. It does not turn those facts into a fit, motion, strength,
safety, or acceptance verdict.

Readable STEP labels are displayed as supplied. UUID or digest labels receive a
stable localized alias such as `Component 1`; the exact identity remains visible
in the occurrence details. A host may also provide a complete, STEP-digest-bound
presentation-name map in tool-result metadata. The Digital Thread examples use
that channel for their verified SysML names without altering the observation
contract or its pair identities.

### Drawing viewer

The drawing viewer consumes `io.casys.mcp-build123d.drawing-projection/1.0` from
the new `build123d_project_2d` tool. It switches among fixed top, front, right,
and isometric SVG projections. When requested and geometrically available, it
also shows the fixed YZ section at the source envelope's midpoint on X.

This surface is a visual STEP inspection viewer. It has no dimensions,
tolerances, annotations, title block, drawing standard, or manufacturing
approval and is not a manufacturing drawing.

## Shared MCP View implementation

The surfaces use `@casys/mcp-view` and `@casys/mcp-view-components`, including
`FocusedView`, `SemanticElement`, `MetricGrid`, `KeyValueList`, `DataTable`,
`Slot3D`, `Card`, `Badge`, `Button`, `Toolbar`, and `startPreactSurfaceApp`.
Build123d-specific code validates each result or session contract, verifies
digest-bound resources, and renders the CAD-specific 2D or 3D content.

The committed `bracket-r1` fixture and `docs/assets/build123d-export-viewer.png`
exercise the geometry bundle. The Digital Thread-derived assembly and drawing
fixtures under `examples/inspector-demo` provide repeatable local examples for
the other two surfaces.

## ERPNext beta reference

The comparison baseline is `mcp-erpnext` `v3.1.0-beta.11`. It registers nine MCP
App resources: document, document list, invoice, stock, chart, KPI, funnel,
kanban, and immutable Buy evidence viewers.

The visual style in the eight live business viewers is custom: Preact, Tailwind,
the MCP Apps `App` transport, and ERPNext's local `shared/ui.tsx` primitives.
Those viewers use `@casys/mcp-view-components/layout` for the host-aware wide,
panel, and mobile layout decision, but they do not use the MCP View surface
component registry.

The Buy evidence viewer is the exception. It uses `defineComponentRegistry`,
`definePreactComponent`, `startPreactSurfaceApp`, and the MCP View fonts. Its
rendered content still uses ERPNext's custom `ViewerShell` and
`DocumentSurface`.

The ERPNext beta appearance is therefore not a reusable MCP View theme or
component set. Build123d keeps the shared MCP View components and its CAD
renderers, while reusing its concise Casys credit: the exact
`Powered by Casys.ai` footer.

## Local Inspector examples

`examples/inspector-demo` remains a local fixture and capture server. Its
`ui://mcp-build123d-example/...` resources are separate from the three provider
resources and do not call the CAD tools:

- the geometry example uses the verified `bracket-r1` export result and GLB;
- two assembly examples use saved results from the production observation
  contract;
- the drawing example uses a saved, digest-checked result from the production
  projector applied to a Digital Thread STEP.

These examples demonstrate the actual surface design with repeatable inputs.
They are not additional package viewers or evidence that a fresh provider call
was made.

## Future component context

The viewers do not yet add an individually clicked 3D component to model
context. The current aggregate GLB result has no trustworthy mapping from mesh
indices or display names to stable STEP assembly occurrences. That feature needs
an occurrence-aware export contract and stable identities before visual
selection can safely become context selection.
