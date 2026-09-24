# Build123d examples in MCP Inspector

This directory is a **local fixture and capture server**, separate from the
`mcp-build123d` provider. The provider registers three resources for geometry,
assembly observation, and fixed 2D inspection projections. This server keeps
repeatable saved inputs for those surface designs under its own
`ui://mcp-build123d-example/...` URIs; the example URIs are not additional
package resources and calling them does not run the CAD tools.

| Tool in Inspector          | What it displays                                                                         | Exact input                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `example_geometry_bracket` | Interactive 3D geometry App, including section and approximate mesh-measurement controls | Verified bracket export JSON and GLB from `docs/fixtures/`                     |
| `example_assembly_tps03`   | Assembly datasheet for two STEP occurrences in observed contact                          | Saved `build123d-assembly-integrity-observation/1.0` result for the TPS03 STEP |
| `example_assembly_msm01`   | Assembly datasheet for three separated STEP occurrences                                  | Saved result with three observed `no-contact` pairs for the MSM01 STEP         |
| `example_drawing_id01`     | Switchable 2D SVG inspection views of CameraMountBracket                                 | Saved production projection of the exact ID01 STEP                             |

The assembly fixtures in `assembly/*.observation.json` use the current direct
observation schema. They are saved examples; calling the tools does not rerun
OCCT. The original 2026-08-26 Digital Thread L3 captures are retained in
`assembly/{tps03,msm01}.json` and identified by `assembly/manifest.json`. They
were produced by an older provider version and remain separate provenance. The
manifest's verified SysML name mapping is sent separately as presentation-only
tool-result metadata, so the App shows names such as `Stand Base` while the
saved observation and its exact UUID identities stay unchanged. The drawing SVGs
are a saved result from the production `projectStep2d` bridge, generated from
the exact ID01 STEP with build123d 0.11.1 and OCP 7.9.3.1.
`drawing/manifest.json` records each digest and the source STEP. Calling the
example does not rerun the projection. These are visual inspection projections,
not a dimensioned manufacturing drawing.

The three provider viewers end with the shared exact `Powered by Casys.ai`
footer. The 3D example still treats the GLB as aggregate display geometry: it
does not select an identified STEP occurrence or add a clicked component to
model context.

## Open the Apps

From this repository:

```bash
deno run -A examples/inspector-demo/server.ts
```

In another terminal:

```bash
npx --yes @modelcontextprotocol/inspector --web
```

Connect **Streamable HTTP** to `http://127.0.0.1:3016/mcp`. If Inspector asks
for a protocol era, choose modern (`2026-07-28`). In **Apps**, open each
`example_*` tool with `{}`. The example server uses loopback and needs no Python
runtime or Digital Thread process.

To verify the advertised App bindings from the CLI:

```bash
npx --yes @modelcontextprotocol/inspector --cli \
  --transport http --server-url http://127.0.0.1:3016/mcp \
  --protocol-era modern --method tools/list --app-info --format json
```

## Capture the actual App surfaces

```bash
deno run -A examples/inspector-demo/capture.ts
```

This runs the local assembly and drawing bundles through an MCP Apps iframe
handshake and refreshes `assets/assembly-tps03.png`,
`assets/assembly-msm01.png`, and `assets/drawing-id01.png`. These are App
surface captures from a small local host, not screenshots of Inspector's own
surrounding interface or evidence of new CAD execution. The 3D geometry capture
already exists at `docs/assets/build123d-export-viewer.png`.

To regenerate the drawing SVGs through the production projector from their
source STEP and Digital Thread capture, set `BUILD123D_PYTHON_BIN` to a
qualified build123d Python runtime and run:

```bash
BUILD123D_PYTHON_BIN=/path/to/python deno run -A \
  examples/inspector-demo/drawing/generate.ts \
  --step /path/to/id01.step \
  --capture /path/to/id01-capture.json
```

The committed SVGs, manifest, and production viewer bundles are sufficient for
the Inspector examples.
