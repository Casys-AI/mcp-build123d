# @casys/mcp-build123d

MCP server for **parametric CAD as code** —
[build123d](https://github.com/gumyr/build123d) (Python, Open CASCADE kernel)
driven by AI agents. **2 agent tools** execute a script, read exact geometry
metrics and export STEP / STL / GLTF. One app-only helper hydrates the bundled
3D viewer without exposing another filesystem path.

```
agent writes build123d script
        │
   build123d_execute ──► volume, mass, center of gravity, bbox   (OCCT, analytical)
        │
   build123d_export  ──► part.step   → FEA meshing (Gmsh, CalculiX), other CAD
                   part.stl    → 3D printing
                   part.glb    → 3D viewers
```

## Why CAD-as-code for agents

An agent doesn't click — it writes. With a GUI CAD's API, building geometry
means one HTTP call per feature against a stateful document. With build123d,
**the script is the artifact**: generated in one shot, versionable, diffable,
reproducible by anyone with Python, and carrying its own traceability (the SysML
element or requirement that motivated a dimension can live in the code, as a
comment or a variable name).

The metrics are not estimates. Volume, surface area, center of mass and bounding
box come analytically from the BREP kernel — the same numbers a commercial CAD
reports.

## Security model — read this

`build123d_execute` and `build123d_export` run **arbitrary Python** on the
machine hosting this server. That is the point (CAD-as-code), not an accident.
Consequences:

- Only expose this server to callers you trust with shell-equivalent access.
- Exports are confined to `BUILD123D_EXPORT_DIR`: file names are reduced to a
  safe basename (directory components stripped, extension imposed by the
  format), so a script cannot choose where files land — but the Python it
  contains can do anything Python can.

## Requirements

- **Python 3.10+** with **build123d**: `pip install build123d` (pulls the
  OCP/OCCT wheel, ~150 MB)
- Deno 2.x to run the server

No account, no API key, no network access at runtime.

## Quick Start

### Stateless HTTP

```bash
deno task serve      # port 3014
```

## Tools (2 + 1 app-only helper) and result viewer

Both public tools expose the same optional MCP App resource,
`ui://mcp-build123d/results-viewer`. When its HTML bundle is present at
`src/ui/dist/results-viewer/index.html`, compatible hosts can render the exact
geometry result. Until then the server deliberately skips the resource and keeps
the concise text response for every MCP client.

The structured result contract is versioned and never carries the submitted
script or file contents:

```json
{
  "schemaVersion": "1.0",
  "kind": "execution",
  "metrics": { "volume_mm3": 11717.2, "area_mm2": 6303.4 },
  "files": []
}
```

`kind: "export"` uses the same metrics and reports each generated file's format,
path and byte size. A GLB also carries a bounded viewer reference:

```json
{
  "format": "gltf",
  "path": "/exports/assembly.glb",
  "bytes": 204800,
  "viewer": {
    "toolName": "build123d_export_read",
    "name": "assembly.glb"
  }
}
```

The interactive industrial CAD view supports orbit, pan, zoom, fit, reset and
wireframe inspection. `build123d_export_read` is visible only to MCP Apps. It
accepts a basename rather than a path, resolves the real file under
`BUILD123D_EXPORT_DIR`, rejects symlink escapes, validates the GLB header and
returns a versioned `model/gltf-binary` base64 envelope.

### Compose components

The same standalone viewer advertises a catalog of small, independently
mountable components during `ui/initialize`. An MCP Compose dashboard chooses a
declarative surface (component subset, order, grid and gap); without a requested
surface, standalone mode mounts the default stack containing all four.

Every component is a Preact component built from the shared `@casys/mcp-view`
presentation primitives (`Card`, `Badge`, `MetricGrid`, `KeyValueList`,
`DataTable`, `Button`, `Toolbar` and system states). The local stylesheet owns
only the Three.js viewport and CAD-specific responsive layout.

| Component key                | Real data and behaviour                                       |
| ---------------------------- | ------------------------------------------------------------- |
| `build123d.geometry-status`  | computation/export status and available file identity         |
| `build123d.geometry-metrics` | OCCT metrics, topology, optional mass and density             |
| `build123d.geometry-canvas`  | bounded GLB fetch plus interactive Three.js scene and cleanup |
| `build123d.export-artifacts` | exact generated formats, paths and byte sizes                 |

The app-only GLB reader is bound to the non-composable
`ui://mcp-build123d/artifact-helper-viewer`, so its binary envelope cannot be
mistaken for a geometry component surface. Repeating a canvas component is
supported: controls and Three.js cleanup are scoped to each surface instance.

No Compose event is emitted or accepted yet. Geometry selection would be a
meaningful future event only once the result contract exposes stable shape or
face identifiers; emitting a generic click today would invent semantics.

This inline base64 transport is deliberately an MVP for dashboard-sized models:
8 MiB by default (roughly 10.7 MiB before the surrounding JSON), with a 24 MiB
hard ceiling. Large assemblies should move to a future stable artifact URI read
through `resources/read`, rather than increasing conversational payloads.

### Build the viewer

The committed viewer bundle is a standalone HTML resource. A normal
`deno task build:ui` uses the published `@casys/mcp-view@0.7.0` component API.
To develop both repositories together, the exact bundle can instead be built
against a sibling `mcp-server` checkout explicitly:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts \
MCP_VIEW_PREACT_MODULE=file:///absolute/path/to/mcp-server/packages/view/preact.ts \
  deno task build:ui
```

The build retains Deno's dependency-age quarantine for the rest of the graph and
exempts only the exact Casys-owned mcp-view release. The generated HTML contains
no module path or runtime network dependency. The viewer accepts only the
structured result envelopes documented above; it never runs a script and can
read only the GLB basename explicitly returned by `build123d_export`.

### `build123d_execute`

Runs a build123d script, returns exact metrics. The script must assign its final
shape to a variable named **`result`** (a Part, Solid, Compound, or a BuildPart
builder):

```python
from build123d import *

length, width, thickness = 60.0, 40.0, 5.0   # from a SysML PartUsage

with BuildPart() as bracket:
    Box(length, width, thickness)
    with Locations((15, 12, 0), (15, -12, 0)):
        Hole(3)

result = bracket
```

Response:

```json
{
  "volume_mm3": 11717.2,
  "area_mm2": 6303.4,
  "center_of_mass_mm": [-0.4, 0.0, 0.0],
  "bounding_box_mm": { "min": [...], "max": [...], "size": [60, 40, 5] },
  "solids": 1, "faces": 8, "edges": 18,
  "density_kg_m3": 2700,
  "mass_kg": 0.0316
}
```

**Mass requires an explicit `density_kg_m3`** (2700 for aluminium 6061, 7850 for
steel…). Without it, `mass_kg` is absent — it is never guessed from a material
name.

### `build123d_export`

Every entry in `files[]` contains `format`, `path`, `bytes`, and `sha256`.
`sha256` identifies the exact bytes written by that export; downstream tools
should copy the file, recompute the digest on their private snapshot, and reject
an `expected_step_sha256` mismatch before processing it.

Same execution, plus files. `formats`: `step` (exact BREP), `stl` (mesh), `gltf`
(binary `.glb`). Files land under `BUILD123D_EXPORT_DIR` (default
`./cad-exports`); the response returns paths and sizes, along with the same
metrics.

## Environment Variables

| Variable                   | Default         | Description                              |
| -------------------------- | --------------- | ---------------------------------------- |
| `BUILD123D_PYTHON_BIN`     | `python3`       | Python interpreter that has build123d    |
| `BUILD123D_EXPORT_DIR`     | `./cad-exports` | Where `build123d_export` writes files    |
| `BUILD123D_GLTF_MAX_BYTES` | `8388608`       | App payload limit; hard-capped at 24 MiB |

## Architecture

```
mod.ts                  # Public API
server.ts               # Stateless HTTP MCP server (port 3014)
src/
  api/
    harness.py          # Python side: exec script, compute metrics, export
    python-bridge.ts    # Deno side: subprocess, JSON over stdin/stdout
  tools/
    execute.ts          # execute, export and app-only GLB reader
  ui/results-viewer/    # small CAD components plus non-composable GLB helper
  client.ts             # CadToolsClient
tests/                  # contract, wire, viewer and real build123d tests
```

The bridge is a subprocess speaking JSON — the same architectural choice as
`@casys/constraint-solver`'s z3 backend: identical behaviour under Deno and
Node, no WASM, and the heavyweight dependency (Python + OCCT) stays on the
machine where one pip command installs it.

## Composing the chain

`build123d_execute`'s mass feeds `@casys/constraint-solver` (via
`@casys/mcp-syson`'s `syson_constraint_evaluate`) to check a computed mass
against a SysML mass budget — with units. `build123d_export`'s STEP file is the
entry point for FEA meshing. Each link is a separate MCP server; the agent
composes them.

## Development

```bash
deno task test     # 31 tests; needs Python 3.10+ with build123d
deno check mod.ts server.ts
```

## License

MIT
