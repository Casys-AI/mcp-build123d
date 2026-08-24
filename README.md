# @casys/mcp-build123d

[![JSR](https://jsr.io/badges/@casys/mcp-build123d)](https://jsr.io/@casys/mcp-build123d)
[![CI](https://github.com/Casys-AI/mcp-build123d/actions/workflows/publish.yml/badge.svg)](https://github.com/Casys-AI/mcp-build123d/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Turn a [build123d](https://github.com/gumyr/build123d) Python model into
measured CAD and verifiable export artifacts through MCP. Agent-facing
operations execute a parametric model, report OCCT geometry metrics, and export
STEP, STL, or GLB. The bundled MCP App adds interactive 3D inspection without
putting binary model data in the agent-facing result.

```
agent writes build123d script
        │
   build123d_execute ──► volume, area, centroid, bbox, topology
        │
   build123d_export  ──► part.step   → FEA meshing (Gmsh, CalculiX), other CAD
                   part.stl    → 3D printing
                   part.glb    → 3D viewers
```

At a glance:

- Parametric solids, sketches, extrusions, revolves, sweeps, lofts, booleans,
  holes, fillets, chamfers, patterns, and compounds can use the normal build123d
  API installed with the selected Python interpreter.
- STEP preserves the BREP, while STL and GLB are tessellated delivery formats.
- Every exported file includes its exact byte count and SHA-256 digest.
- Mass is reported only from an explicit uniform density. No material or density
  is guessed.

## Why CAD-as-code for agents

An agent doesn't click — it writes. With a GUI CAD's API, building geometry
means one HTTP call per feature against a stateful document. With build123d,
**the script is the artifact**: generated in one shot, versionable, diffable,
replayable in a pinned Python/build123d environment, and carrying its own
traceability (the SysML element or requirement that motivated a dimension can
live in the code, as a comment or a variable name).

The metrics are not estimates. Volume, surface area, center of mass and bounding
box come analytically from the BREP kernel rather than from the STL or GLB
tessellation.

## Quick start

### Run a source checkout

Requirements are Deno 2.x and Python 3.10+ with build123d. A virtual environment
keeps the OCCT dependency isolated from the system Python:

```bash
git clone https://github.com/Casys-AI/mcp-build123d.git
cd mcp-build123d
python3 -m venv .venv
. .venv/bin/activate
python -m pip install build123d==0.11.1
BUILD123D_PYTHON_BIN="$PWD/.venv/bin/python" deno task serve
```

The server binds to loopback and exposes Streamable HTTP at
`http://127.0.0.1:3014/mcp`. Check the process separately with:

```bash
curl http://127.0.0.1:3014/health
```

### Run the published package

This checkout prepares unpublished `0.4.2`. The currently published JSR package
remains `0.4.1` and can be started directly; Python and build123d are still host
dependencies:

```bash
BUILD123D_PYTHON_BIN="$PWD/.venv/bin/python" \
  deno run -A jsr:@casys/mcp-build123d@0.4.1/server --port=3014
```

`-A` is intentional here: the public tools run arbitrary Python and write
exports. Use the source task or a container when you want to replace it with a
deployment-specific Deno permission set.

Point a Streamable HTTP-capable MCP client at the endpoint. The exact config
file location depends on the host; the connection entry is typically:

```json
{
  "mcpServers": {
    "build123d": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3014/mcp"
    }
  }
}
```

This release is HTTP-only. It does not implement stdio, so a client
configuration with `command` and `args` will not work. HTTP binds to `127.0.0.1`
by default; `--hostname=0.0.0.0` is an explicit network exposure.

### Run the published engineering toolchain image

This repository does not publish a dedicated `mcp-build123d` image. Casys does
publish release `0.4.1` in the broader
[`engineering-toolchain`](https://github.com/Casys-AI/engineering-toolchain)
image, with Python, build123d 0.11.1, and OCCT already installed. Start its
`build123d` entrypoint directly while keeping exports on the host:

```bash
mkdir -p "$PWD/cad-exports"
docker run --rm \
  --publish 127.0.0.1:3014:3014 \
  --volume "$PWD/cad-exports:/exports" \
  ghcr.io/casys-ai/engineering-toolchain:0.4.1 \
  build123d --port=3014 --hostname=0.0.0.0
```

### Build a checkout locally

For a dedicated local image built from this checkout, save the following as
`Dockerfile.local`. It keeps Python, OCCT, Deno, and exports together:

```dockerfile
FROM denoland/deno:debian-2.9.2
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/build123d \
    && /opt/build123d/bin/pip install --no-cache-dir build123d==0.11.1
WORKDIR /app
COPY . .
RUN deno cache --frozen server.ts \
    && mkdir -p /exports \
    && chown -R deno:deno /app /exports
ENV BUILD123D_PYTHON_BIN=/opt/build123d/bin/python
ENV BUILD123D_EXPORT_DIR=/exports
USER deno
EXPOSE 3014
CMD ["deno", "run", "-A", "server.ts", "--hostname=0.0.0.0", "--port=3014"]
```

```bash
docker build -f Dockerfile.local -t mcp-build123d:local .
mkdir -p cad-exports
docker run --rm \
  --publish 127.0.0.1:3014:3014 \
  --volume "$PWD/cad-exports:/exports" \
  mcp-build123d:local
```

The container is packaging, not a sandbox: the submitted Python still has the
container user's authority and can access anything mounted into it.

## Security and trust boundary

`build123d_execute` and `build123d_export` run **arbitrary Python** on the
machine hosting this server. That is the point (CAD-as-code), not an accident.
Consequences:

- Only expose this server to callers you trust with shell-equivalent access.
- `build123d_export`'s managed outputs are confined to `BUILD123D_EXPORT_DIR`:
  file names are reduced to a safe basename (directory components stripped,
  extension imposed by the format). The submitted Python is not confined by that
  output-path rule and can do anything Python can.
- Loopback binding, safe export names, timeouts, and the bounded GLB reader are
  useful controls; none of them isolates the Python process. Put untrusted code
  behind a real sandbox with no secrets, network, or sensitive mounts.
- HTTP authentication is not enabled by this bootstrap. Keep it on loopback or
  add an authenticated deployment boundary before exposing it to a network.

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

The server itself needs no account or API key. A submitted Python script still
inherits the host or container's filesystem, process, and network access.

### Evidence versus canonical product geometry

This standalone server returns real OCCT measurements and exact export-byte
digests. That proves what this invocation computed and wrote; it does not prove
that the script was reviewed, admitted, requirement-compliant, or canonical for
a product Digital Thread.

In `casys-digital-thread`, the canonical STEP route is the governed technical
source capture and compilation review followed by `compile.seal-admission@2`,
`project_admitted_geometry_export`, and `design.write-geometry@1`. The separate
`design.execute-build123d@1` isolated execution and
`design.seal-isolated-geometry@1` publication path is documentary, not the
canonical STEP authority. Keep those product-level authorities distinct from a
direct call to this standalone server.

## Tools and result viewer

`build123d_execute` and `build123d_export` expose the same optional MCP App
resource, `ui://mcp-build123d/results-viewer`. When its HTML bundle is present
at `src/ui/dist/results-viewer/index.html`, compatible hosts can render the
exact geometry result. Until then the server deliberately skips the resource and
keeps the concise text response for every MCP client.

The structured result contract is versioned and never carries the submitted
script or file contents:

```json
{
  "schemaVersion": "1.0",
  "kind": "execution",
  "metrics": { "volume_mm3": 11717.2567, "area_mm2": 5875.3982 },
  "files": []
}
```

`kind: "export"` uses the same metrics and reports each generated file's format,
path, byte size and SHA-256. A GLB also carries a bounded viewer reference; the
viewer must pass that file's `sha256` as `expected_sha256` when it calls the
app-only reader:

```json
{
  "format": "gltf",
  "path": "/exports/assembly.glb",
  "bytes": 204800,
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "viewer": {
    "toolName": "build123d_export_read",
    "name": "assembly.glb"
  }
}
```

The interactive industrial CAD view supports orbit, pan, zoom, fit, reset and
wireframe inspection. `build123d_export_read` is visible only to MCP Apps. It
accepts a basename and the exact `files[].sha256` digest rather than a path,
resolves the real file under `BUILD123D_EXPORT_DIR`, rejects symlink escapes and
digest mismatches, validates the GLB header and returns a versioned
`model/gltf-binary` base64 envelope. The export path is mutable: a later export
with the same basename can replace the file, and a read using a stale digest is
rejected.

### Compose components

The same standalone viewer advertises a catalog of small, independently
mountable components during `ui/initialize`. An MCP Compose dashboard chooses a
declarative surface (component subset, order, grid and gap); without a requested
surface, standalone mode mounts the default component stack.

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

### Script and geometry contract

The server does not maintain a second recipe language or a feature allowlist.
The selected Python environment determines which build123d APIs are available.
The stable server convention is smaller: the script must leave its final `Part`,
`Solid`, `Compound`, or `BuildPart` builder in a top-level variable named
`result`.

Build123d's default length convention is millimetres, which is why the public
metric fields are explicitly named `*_mm`, `*_mm2`, and `*_mm3`. A compound is
measured as one aggregate result, with total topology and one BREP centroid. The
server does not currently return an inertia tensor, per-solid mass properties,
material identity, tolerances, or manufacturing feasibility.

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

Structured response:

```json
{
  "schemaVersion": "1.0",
  "kind": "execution",
  "metrics": {
    "volume_mm3": 11717.2567,
    "area_mm2": 5875.3982,
    "center_of_mass_mm": [-0.362, 0, 0],
    "bounding_box_mm": {
      "min": [-30, -20, -2.5],
      "max": [30, 20, 2.5],
      "size": [60, 40, 5]
    },
    "solids": 1,
    "faces": 8,
    "edges": 18,
    "density_kg_m3": 2700,
    "mass_kg": 0.0316366
  },
  "files": []
}
```

Values are rounded from build123d 0.11.1 / OCCT for this example; the installed
Python environment is part of reproducibility.

**Mass requires an explicit `density_kg_m3`** (2700 for aluminium 6061, 7850 for
steel…). Without it, `mass_kg` is absent — it is never guessed from a material
name. One density applies uniformly to the complete result; heterogeneous
assemblies need to be evaluated per material outside this contract.

### `build123d_export`

Every entry in `files[]` contains `format`, `path`, `bytes`, and `sha256`.
`sha256` identifies the exact bytes written by that export; downstream tools
should copy the file, recompute the digest on their private snapshot, and reject
an `expected_step_sha256` mismatch before processing it.

Same execution, plus files. `formats`: `step` (exact BREP), `stl` (mesh), `gltf`
(binary `.glb`). Files land under `BUILD123D_EXPORT_DIR` (default
`./cad-exports`); the response returns paths and sizes, along with the same
metrics.

Example tool input using the script above:

```json
{
  "script": "from build123d import *\nwith BuildPart() as bracket:\n    Box(60, 40, 5)\nresult = bracket\n",
  "formats": ["step", "stl", "gltf"],
  "name": "bracket-r1",
  "density_kg_m3": 2700,
  "timeout_ms": 60000
}
```

### Content and digest semantics

- Each call runs the script once. `build123d_export` derives all requested
  formats and the reported metrics from that one in-memory result.
- The server does not persist a run ledger or return the submitted script in
  `structuredContent`. Version the source in your own repository or evidence
  store when the script itself matters.
- An export path is a mutable location. Reusing the same `name` can replace its
  contents; `files[].sha256`, not the path, identifies the exact bytes returned
  by that invocation. The app-only GLB reader requires that digest as
  `expected_sha256` and hashes the bytes actually read before encoding them.
- `build123d_export` passes the UTC sentinel `1970-01-01T00:00:00Z` to
  build123d's native STEP `timestamp` parameter. That sentinel is a
  reproducibility marker, not the execution or export time. Byte-for-byte STEP
  identity is scoped to the pinned build123d 0.11.1 / OCCT environment; other
  versions may still change export bytes.
- Digest equality proves byte equality, not geometric equivalence. Export bytes
  can change across build123d, OCCT, or exporter versions even when a shape is
  visually equivalent.
- STEP and STL are files only in this release. GLB has a bounded, digest-bound
  app-only reader for the viewer, but there is no general artifact resource or
  download API.

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
selected host or in its container.

## Composing the chain

In a standalone workflow, `build123d_execute`'s mass feeds
`@casys/constraint-solver` (via `@casys/mcp-syson`'s
`syson_constraint_evaluate`) to check a computed mass against a SysML mass
budget — with units. `build123d_export`'s STEP file is the entry point for FEA
meshing. Each link is a separate MCP server; the agent composes them.

## Development

```bash
deno task test     # needs Python 3.10+ with build123d
deno check mod.ts server.ts
```

## License

MIT
