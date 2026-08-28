# @casys/mcp-build123d

[![JSR](https://jsr.io/badges/@casys/mcp-build123d)](https://jsr.io/@casys/mcp-build123d)
[![CI](https://github.com/Casys-AI/mcp-build123d/actions/workflows/publish.yml/badge.svg)](https://github.com/Casys-AI/mcp-build123d/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Turn a [build123d](https://github.com/gumyr/build123d) Python model into
measured CAD and verifiable export artifacts through MCP. Agent-facing
operations execute a parametric model, report OCCT geometry metrics, and export
STEP, STL, or GLB. Every export is promoted into a server-owned, immutable MCP
resource addressed by its SHA-256; agents receive the resource URI, MIME type,
size, and digest—not a host path.

```
agent writes build123d script
        │
   build123d_execute ──► volume, area, centroid, bbox, topology
        │
   build123d_export  ──► private delivery staging
        │
        └──────────────► casys://build123d/artifacts/<sha256>.step → FEA/CAD
                          casys://build123d/artifacts/<sha256>.stl  → printing
                          casys://build123d/artifacts/<sha256>.glb  → viewers
                                      │
                               resources/read (rehashes bytes)

exact STEP bytes ──► build123d_observe_assembly_integrity ──► factual XCAF/OCCT assembly observation
```

At a glance:

- Parametric solids, sketches, extrusions, revolves, sweeps, lofts, booleans,
  holes, fillets, chamfers, patterns, and compounds can use the normal build123d
  API installed with the selected Python interpreter.
- STEP preserves the BREP, while STL and GLB are tessellated delivery formats.
- Every export returns an immutable resource URI with exact MIME type, byte
  count, and SHA-256 digest. `resources/read` rehashes the issued in-memory
  bytes before returning them.
- Mass is reported only from an explicit uniform density. No material or density
  is guessed.
- `build123d_observe_assembly_integrity` accepts one bounded, digest-bound STEP
  artifact only; it never executes caller code and returns factual import, unit,
  topology, occurrence, placement and pair observations.

## Why CAD-as-code for agents

An agent doesn't click — it writes. With a GUI CAD's API, building geometry
means one HTTP call per feature against a stateful document. With build123d,
**the script is the artifact**: generated in one shot, versionable, diffable,
replayable with a pinned build123d package and a configured execution
environment, and carrying its own traceability (the SysML element or requirement
that motivated a dimension can live in the code, as a comment or a variable
name).

The metrics are not estimates. Volume, surface area, center of mass and bounding
box come analytically from the BREP kernel rather than from the STL or GLB
tessellation.

## Quick start

### Run a source checkout

Requirements are Deno 2.9.6 and Python 3.10+. The provider qualifies the exact
`build123d==0.11.1` / `cadquery-ocp-novtk==7.9.3.1.1` pair (reported by Python
as `OCP.__version__ == "7.9.3.1"`). Immutable export promotion uses POSIX
directory-descriptor safeguards, so this release supports that promotion on
macOS and Linux; an unsupported host refuses promotion rather than weakening
containment. A virtual environment keeps the OCCT dependency isolated from the
system Python:

```bash
git clone https://github.com/Casys-AI/mcp-build123d.git
cd mcp-build123d
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements/runtime.txt -c requirements/constraints.txt
BUILD123D_PYTHON_BIN="$PWD/.venv/bin/python" deno task serve
```

The server binds to loopback and exposes Streamable HTTP at
`http://127.0.0.1:3014/mcp`. Check the process separately with:

```bash
curl http://127.0.0.1:3014/health
```

The same source checkout also runs as native stdio, with the identical tool,
resource, viewer, and error contracts:

```bash
BUILD123D_PYTHON_BIN="$PWD/.venv/bin/python" deno task serve:stdio
```

For example, a checkout-backed stdio entry is:

```json
{
  "mcpServers": {
    "build123d": {
      "command": "deno",
      "args": [
        "run",
        "-A",
        "/absolute/path/to/mcp-build123d/server.ts",
        "--stdio"
      ]
    }
  }
}
```

### Run the published package

The published JSR package `0.6.1` can be started directly; Python and build123d
are still host dependencies:

```bash
BUILD123D_PYTHON_BIN="$PWD/.venv/bin/python" \
  deno run -A jsr:@casys/mcp-build123d@0.6.1/server --port=3014
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

HTTP binds to `127.0.0.1` by default; `--hostname=0.0.0.0` is an explicit
network exposure. The `0.6.1` checkout supports native stdio and the
digest-bound resource contract described below.

### Run the published provider image

The dedicated image includes the qualified Python/CAD pair and Deno runtime. Use
the immutable digest published for this release (the repository README is pinned
after image publication); do not substitute the historical broader
`engineering-toolchain` image, which is a different server release.

```bash
mkdir -p "$PWD/cad-exports"
docker run --rm \
  --publish 127.0.0.1:3014:3014 \
  --volume "$PWD/cad-exports:/exports" \
  ghcr.io/casys-ai/mcp-build123d:0.6.1
```

### Build a checkout locally

For a dedicated local image built from this checkout, use the committed
[`Dockerfile`](Dockerfile). It applies the same exact constraints and Deno base
image as CI and the published image:

```bash
docker build -t mcp-build123d:local .
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
  extension imposed by the format). Those mutable delivery paths are verified,
  then copied into the server process's immutable resource memory; they are
  never a `resources/read` surface. The submitted Python is not confined by that
  output-path rule and can do anything Python can.
- Promotion reads delivery bytes through a short-lived isolated reader with a
  fixed five-second deadline. A special file or post-check staging swap fails
  closed; it cannot indefinitely block artifact issuance.
- Inputs, bridge stdout/stderr, each promoted export, and retained
  current-process artifacts have fixed server-side byte budgets. Exceeding one
  returns a stable non-retryable resource-limit recovery rather than retaining
  unbounded bytes. The bridge kills its POSIX process group on timeout or output
  overflow; this covers normal descendants, not a hostile process that escapes
  the group or a security sandbox.
- Loopback binding, safe export names, content-addressed resources, and timeouts
  are useful controls; none of them isolates the Python process. Put untrusted
  code behind a real sandbox with no secrets, network, or sensitive mounts.
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
source capture and compilation review followed by `compile.seal-admission@3`,
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

`kind: "export"` uses the same metrics and returns one immutable artifact
reference per requested format:

```json
{
  "format": "gltf",
  "artifact": {
    "schemaVersion": "build123d-export-artifact/1.0",
    "uri": "casys://build123d/artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.glb",
    "format": "gltf",
    "mimeType": "model/gltf-binary",
    "bytes": 204800,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
}
```

Read exactly the returned `artifact.uri` with MCP `resources/read`. The server
does not accept a path parameter, and rehashes its issued in-memory byte copy
before returning it. The bundled viewer follows the same resource path, checks
the GLB header and digest, then provides orbit, pan, zoom, fit, reset, and
wireframe inspection.

### Compose components

The same standalone viewer advertises a catalog of small, independently
mountable components during `ui/initialize`. An MCP Compose dashboard chooses a
declarative surface (component subset, order, grid and gap); without a requested
surface, standalone mode mounts the default component stack.

Every component is a Preact component built from the shared `@casys/mcp-view`
presentation primitives (`Card`, `Badge`, `MetricGrid`, `KeyValueList`,
`DataTable`, `Button`, `Toolbar` and system states). The local stylesheet owns
only the Three.js viewport and CAD-specific responsive layout.

| Component key                | Real data and behaviour                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `build123d.geometry-status`  | computation/export status and SHA-256 artifact identity           |
| `build123d.geometry-metrics` | OCCT metrics, topology, optional mass and density                 |
| `build123d.geometry-canvas`  | verified GLB resource plus interactive Three.js scene and cleanup |
| `build123d.export-artifacts` | immutable resource URIs, digests, MIME types and byte sizes       |

Repeating a canvas component is supported: controls and Three.js cleanup are
scoped to each surface instance. A resource URI identifies exact bytes; it does
not establish stable feature, face, instance, motion, fit, or requirement
semantics.

No Compose event is emitted or accepted yet. Geometry selection would be a
meaningful future event only once the result contract exposes stable shape or
face identifiers; emitting a generic click today would invent semantics.

The resource metadata lets a host decide whether to fetch a large delivery
artifact. The bundled GLB viewer has a 24 MiB local safety cap; resource
identity and retrieval remain available separately for larger artifacts. The
server does not invent an assembly manifest: a compound export is one aggregate
shape unless a future, independently evidenced instance contract is introduced.

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
read only the exact GLB resource URI explicitly returned by `build123d_export`.
`src/ui/dist/` is generated bundle output and is intentionally excluded from
Deno source formatting; the viewer source remains covered by the normal format
check.

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

Every entry in `files[]` contains `format` and an `artifact` object with a
content-addressed `uri`, MIME type, byte size, and SHA-256. The tool writes into
private managed delivery staging, verifies the bridge-reported bytes, then
issues a process-local immutable resource copy. Downstream tools should use
`resources/read` on that exact URI and recompute the digest on their own copy
when retaining evidence.

Same execution, plus files. `formats`: `step` (exact BREP), `stl` (mesh), `gltf`
(binary `.glb`). `BUILD123D_EXPORT_DIR` is mutable staging (default
`./cad-exports`); it is not an agent-readable interface. The response returns
only immutable artifact references alongside the same metrics.

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

### `build123d_observe_assembly_integrity`

Observes one exact STEP Part 21 artifact without executing caller code. Its
closed input is deliberately small:

```json
{
  "step": {
    "mimeType": "model/step",
    "sha256": "lowercase-sha256-of-the-decoded-bytes",
    "bytes": 32536,
    "blob": "canonical-padded-base64-of-those-exact-bytes"
  }
}
```

`bytes` must be positive and at most 128 MiB. The bridge rehashes and checks the
Part 21 envelope before staging the bytes privately for a fixed OCCT/XCAF
harness. There are no caller-selected paths, Python, tolerances, transforms or
timeouts.

The versioned `build123d-assembly-integrity-observation/1.0` result carries the
exact input identity, fixed method, and a closed producer block:

```json
{
  "producer": {
    "service": "mcp-build123d",
    "packageVersion": "0.6.1",
    "tool": "build123d_observe_assembly_integrity",
    "engine": { "name": "cadquery-ocp", "version": "7.9.3.1" }
  }
}
```

Every fact is either `observed`, `unresolved`, or `unavailable`. Direct
occurrences are printable-ASCII labels sorted bytewise (maximum 32). An observed
placement is a row-major rigid 4×4 XCAF `Location` matrix in the STEP file's
observed millimetres; it is not an expected or requested pose. The tool emits
every canonical direct-label pair (maximum 496) with the fixed `1e-6 mm`
tolerance, minimum distance, intersection volume, and `contact` fact. These are
kernel facts, not a pass/fail decision. The contract has no project,
requirement, fitness, safety, motion, strength, or verdict fields.

The `producer.engine` block identifies the installed `cadquery-ocp` binding
whose `OCP.__version__` is read by the fixed harness. It does not claim a
Standard OCCT API build version, an image digest, or a sandbox/network policy
attestation; the fixed method still describes the OCCT/XCAF observation.

### Content and digest semantics

- Each call runs the script once. `build123d_export` derives all requested
  formats and the reported metrics from that one in-memory result.
- After that successful bridge result, the current server process holds a
  direct-execution receipt alongside an immutable in-memory artifact copy. The
  receipt binds source, request, metrics and output-set digests with literal
  `not-admitted` status; it never stores submitted source text or crosses
  `structuredContent`. Resources are deliberately not restored after restart:
  any object or receipt prewritten on disk is ignored. This is not a Digital
  Thread operation or admission ledger, and it does not make an artifact
  canonical product geometry.
- An export delivery path is mutable and private. Reusing a `name` can replace
  staging bytes, but the returned `artifact.uri` is digest-bound and names the
  immutable current-process copy. `resources/read` rehashes that copy before it
  returns any bytes. Promotion uses a fixed five-second isolated read deadline,
  so a special file or staging swap fails closed instead of stalling the
  artifact queue. After a server restart, run a new export before reading an
  artifact URI again.
- `build123d_export` passes the UTC sentinel `1970-01-01T00:00:00Z` to
  build123d's native STEP `timestamp` parameter. That sentinel is a
  reproducibility marker, not the execution or export time. This provider starts
  only with the qualified `build123d==0.11.1` and
  `cadquery-ocp-novtk==7.9.3.1.1` pair. Its observed `OCP.__version__` is
  `7.9.3.1`; other provider releases may change bytes.
- Digest equality proves byte equality, not geometric equivalence. Export bytes
  can change across build123d, OCCT, or exporter versions even when a shape is
  visually equivalent.
- STEP, STL, and GLB all use the same general artifact-resource contract.
  Resource metadata contains the MIME type, size, SHA-256, format, and immutable
  flag. No caller-controlled filesystem path is accepted by the resource reader.

## Environment Variables

| Variable               | Default         | Description                                            |
| ---------------------- | --------------- | ------------------------------------------------------ |
| `BUILD123D_PYTHON_BIN` | `python3`       | Python interpreter that has build123d                  |
| `BUILD123D_EXPORT_DIR` | `./cad-exports` | Private mutable delivery staging for the Python bridge |

## Architecture

```
mod.ts                  # Public API
server.ts               # HTTP bootstrap or native stdio bootstrap
src/
  api/
    harness.py          # Python side: exec script, compute metrics, export
    python-bridge.ts    # Deno side: subprocess, JSON over stdin/stdout
    assembly-integrity-harness.py # fixed OCCT/XCAF factual STEP observer
    assembly-integrity-bridge.ts  # digest-bound staging and receipt parser
  artifacts.ts          # process-local digest-bound export resources and handlers
  tool-errors.ts        # stable structured tool-error envelope
  tools/
    execute.ts          # execute and immutable artifact export
    assembly-integrity.ts # standalone factual assembly observation
  ui/results-viewer/    # small CAD components and resource-backed GLB viewer
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
budget — with units. A STEP artifact read from `build123d_export` is the entry
point for FEA meshing. Each link is a separate MCP server; the agent composes
them.

## Development

```bash
deno task test     # full CAD integration cases need Python 3.10+ with build123d
deno check mod.ts server.ts
```

## License

MIT
