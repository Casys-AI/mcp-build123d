# Changelog

All notable changes to `@casys/mcp-build123d` will be documented in this file.

## [0.2.0] - 2026-07-31

### Changed

- **Stateless HTTP is now the only server transport.** `server.ts` always starts
  the 2026-07-28 HTTP transport; the obsolete stdio path and its
  transport-selection flag are removed. The remaining launch options are
  `--port`, `--hostname`, and `--categories`.
- **Geometry results now include a bundled MCP App viewer.** The standalone
  resource presents validated v1 execution and export metrics, topology,
  bounding box, optional mass properties, and exported file metadata.

## [0.1.2] - 2026-07-30

### Fixed

- **JSR execution now includes the Python harness.** A generated TypeScript
  module carries its source and `python3 -c` executes it, rather than treating a
  JSR module URL as a local filesystem path. `build123d_execute` and
  `build123d_export` therefore work from the published package as well as from a
  source checkout.

## [0.1.0] - 2026-07-30

Initial release.

### Added

- **`build123d_execute`** — run a build123d (Python/OCCT) script and return
  exact analytical geometry metrics: volume, surface area, center of mass,
  bounding box, solid/face/edge counts. Mass is computed **only** when
  `density_kg_m3` is provided explicitly — never guessed from a material name.
- **`build123d_export`** — same execution plus STEP (exact BREP, the FEA entry
  point), STL and binary GLTF outputs. File names are reduced to a safe basename
  and confined to `BUILD123D_EXPORT_DIR`; the extension is imposed by the
  format.
- **Python bridge over a subprocess** speaking JSON on stdin/stdout — identical
  behaviour under Deno and Node, no WASM, with `BUILD123D_PYTHON_BIN` to select
  the interpreter and actionable errors when Python or build123d is missing.
- **Explicit security model** — the tools run arbitrary Python by design
  (CAD-as-code); the README says so plainly instead of pretending there is a
  sandbox.

### Notes

- The script contract is one convention: assign the final shape to a variable
  named `result`. Violations fail with the list of variables the script actually
  defined.

## [0.1.1] - 2026-07-30

### Security

- **HTTP mode binds to loopback by default.** This server executes arbitrary
  Python by design; exposing it on the network (`--hostname=0.0.0.0`) is now an
  explicit choice, not the default.
