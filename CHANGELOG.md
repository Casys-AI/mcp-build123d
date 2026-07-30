# Changelog

All notable changes to `@casys/mcp-build123d` will be documented in this file.

## [0.1.0] - 2026-07-30

Initial release.

### Added

- **`build123d_execute`** — run a build123d (Python/OCCT) script and return exact analytical geometry metrics: volume, surface area, center of mass, bounding box, solid/face/edge counts. Mass is computed **only** when `density_kg_m3` is provided explicitly — never guessed from a material name.
- **`build123d_export`** — same execution plus STEP (exact BREP, the FEA entry point), STL and binary GLTF outputs. File names are reduced to a safe basename and confined to `BUILD123D_EXPORT_DIR`; the extension is imposed by the format.
- **Python bridge over a subprocess** speaking JSON on stdin/stdout — identical behaviour under Deno and Node, no WASM, with `BUILD123D_PYTHON_BIN` to select the interpreter and actionable errors when Python or build123d is missing.
- **Explicit security model** — the tools run arbitrary Python by design (CAD-as-code); the README says so plainly instead of pretending there is a sandbox.

### Notes

- The script contract is one convention: assign the final shape to a variable named `result`. Violations fail with the list of variables the script actually defined.
