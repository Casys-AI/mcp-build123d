# @casys/mcp-build123d

MCP server for **parametric CAD as code** —
[build123d](https://github.com/gumyr/build123d) (Python, Open CASCADE kernel)
driven by AI agents. **2 tools**: execute a script and read exact geometry
metrics, export STEP / STL / GLTF.

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

## Tools (2) and result viewer

Both tools expose the same optional MCP App resource,
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

`kind: "export"` uses the same metrics and reports only each generated file's
format, path and byte size.

### Build the viewer

The committed viewer bundle is a standalone HTML resource. Rebuild it against
the published, exact `@casys/mcp-view@0.4.0` release:

```bash
deno task build:ui
```

The build retains Deno's dependency-age quarantine for the rest of the graph
and exempts only the exact Casys-owned mcp-view release. The generated HTML
contains no module path or runtime network dependency. The viewer accepts only
the structured result envelopes documented above; it never runs a script or
reads an export file.

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

Same execution, plus files. `formats`: `step` (exact BREP), `stl` (mesh), `gltf`
(binary `.glb`). Files land under `BUILD123D_EXPORT_DIR` (default
`./cad-exports`); the response returns paths and sizes, along with the same
metrics.

## Environment Variables

| Variable               | Default         | Description                           |
| ---------------------- | --------------- | ------------------------------------- |
| `BUILD123D_PYTHON_BIN` | `python3`       | Python interpreter that has build123d |
| `BUILD123D_EXPORT_DIR` | `./cad-exports` | Where `build123d_export` writes files |

## Architecture

```
mod.ts                  # Public API
server.ts               # Stateless HTTP MCP server (port 3014)
src/
  api/
    harness.py          # Python side: exec script, compute metrics, export
    python-bridge.ts    # Deno side: subprocess, JSON over stdin/stdout
  tools/
    execute.ts          # build123d_execute, build123d_export
  client.ts             # CadToolsClient
tests/                  # 9 tests against real build123d
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
deno task test     # 9 tests; need python3 + build123d
deno check mod.ts server.ts
```

## License

MIT
