# Changelog

All notable changes to `@casys/mcp-build123d` will be documented in this file.

## [Unreleased]

- **Geometry datasheet.** The results viewer default surface is now one bounded
  `build123d.geometry-datasheet`: a literal status marker (`exported`,
  `computed`, `recorded`, `provisional`, `documentary`, or the projection
  status), at most four readings (volume, surface, mass, envelope), the verified
  3D model in a kit `Slot3D`, titled fact sections (geometry; or Thread/Project
  basis, capture and GLB projection for sessions), one `ArtifactRow` per sealed
  export and a single provenance line. Recorded and review sessions mount the
  same datasheet. The four small catalog components remain for Compose hosts and
  slice the same model.
- **Host locale.** Every number in the viewer follows `hostContext.locale` from
  `ui/initialize`; the previous hard-coded `en-US` formatting and the mixed
  French/English labels are gone.
- **Kit lifecycle.** The viewer is mounted by `startPreactSurfaceApp` from
  `@casys/mcp-view-components/preact` instead of a hand-rolled App: the kit owns
  the loading/surface routes, the serialized navigations, the host-context
  remounts (which now also cover recorded sessions) and the status rendering.
  What stays local is kit-free and tested directly: `projection.ts` turns a tool
  result or a recorded session into a display state with stable error codes
  (`tool-error`, `result-rejected`, `session-rejected`),
  `geometrySurfaceOverride` is passed as `surfaceFor` so a session keeps owning
  its whole-view surface, and `onTeardown` disposes the host resource bridge.
  The `render.ts` / `render-generation.ts` modules are gone. The viewer stays on
  its loading status until the first result rather than showing an empty state
  after the handshake.
- **Kit pin.** The bundle is rebuilt against `@casys/mcp-view@0.9.3` and
  `@casys/mcp-view-components@0.7.0` (`Casys-AI/mcp-server@59eeb37`), whose text
  token fallback is `#101519`.
- **Reproducible documentation capture.** `deno task capture:docs` renders the
  committed bundle with the real `build123d_export` fixture
  `docs/fixtures/bracket-r1.{py,export.json,glb}` (produced by the published
  provider image) in headless Chrome and writes
  `docs/assets/build123d-export-viewer.png`, now shown in the README.

## [0.6.1] - 2026-08-29

- **Release-gate correction.** The container Deno identity check now matches the
  exact `2.9.6` version prefix emitted by `deno --version`, while allowing its
  platform suffix. No provider contract or runtime qualification changed.

## [0.6.0] - 2026-08-29

- **Bounded provider execution.** Scripts, bridge stdout/stderr, individual
  promoted exports, and retained current-process artifact storage now have fixed
  byte budgets. Limit exhaustion is a stable non-retryable tool recovery; it
  never relies on unbounded `ChildProcess.output()` buffering.
- **Timeout tree cleanup.** The private Python harness creates a POSIX process
  group before user code runs. A timeout or output-budget breach kills that
  group, and adversarial coverage verifies a normal spawned descendant cannot
  outlive its timed-out parent.
- **Qualified runtime, fail closed.** Startup verifies the exact
  `build123d==0.11.1` / `cadquery-ocp-novtk==7.9.3.1.1` pair, including the
  expected Python binding identity `OCP.__version__ == "7.9.3.1"`. CI and the
  dedicated image share committed constraints instead of resolver-selected OCP.
- **Dedicated published image.** GHCR builds the exact Deno 2.9.6 base for
  linux/amd64 and linux/arm64 with OCI source/version/revision labels, SBOM and
  provenance. The workflow smokes HTTP, stdio, and a real OCCT calculation
  before publication.
- **Pinned server framework.** The JSR framework dependency is exact in the
  import map and covered by the committed lockfile.

## [0.5.1] - 2026-08-28

- **Fixed STEP-only assembly observation.**
  `build123d_observe_assembly_integrity` accepts one digest-bound, bounded,
  canonical-base64 `model/step` artifact and returns only XCAF/OCCT facts:
  importability, explicit file units, BREP topology, direct occurrence labels
  and locations, and deterministic pair distance/intersection/contact metrics.
  It accepts no caller code, path, tolerance, transform or runtime option.
- **Closed factual response provenance.** The observation binds the exact input
  artifact, fixed OCCT method, and the fixed `mcp-build123d` / `cadquery-ocp`
  producer identity. This is not a sandbox or network-denied attestation, and it
  does not make a product judgement.
- **Bounded HTTP transport.** The server explicitly admits the maximum legal
  inline STEP envelope (128 MiB decoded plus finite JSON-RPC overhead), instead
  of inheriting the generic 1 MiB HTTP body limit.

- **Native deterministic STEP timestamps.** `build123d_export` passes the UTC
  sentinel `1970-01-01T00:00:00Z` to build123d 0.11.1's native
  `export_step(..., timestamp=)` parameter. That sentinel is a reproducibility
  marker, not the execution or export time. CI pins build123d 0.11.1, while its
  `cadquery-ocp-novtk` dependency remains resolver-selected in build123d's
  `>=7.9,<8` range; exact OCP/OCCT identity is invocation-specific.
- **Native stdio and HTTP share one application factory.** `server.ts --stdio`
  uses `McpApp.start()` while HTTP keeps the stateless endpoint; both expose the
  same instructions, tool annotations, structured errors, viewers and resource
  registry.
- **Immutable export resources.** STEP, STL and GLB delivery bytes are verified
  against the Python bridge, copied into current-process memory, and returned as
  `casys://build123d/artifacts/<sha256>.<ext>` references with MIME type, size
  and SHA-256. `resources/read` rehashes the exact issued bytes. The receipt
  binds source, request, metrics and output-set digests with literal
  `not-admitted` status, but nothing is restored from disk after a restart: a
  preseeded object or receipt is ignored. This is not a Digital Thread operation
  or admission ledger. Delivery promotion uses a fixed five-second isolated read
  deadline, so a special file or post-check swap fails closed without blocking
  the artifact queue. The old app-only GLB reader is removed. Promotion requires
  POSIX directory-descriptor safeguards and refuses unsupported hosts rather
  than weakening containment.
- **Agent-oriented contracts.** Execution, export and fixed assembly-observation
  tools carry behavioral annotations, the server gives concise operational
  instructions, and runner, artifact or assembly-observation failures return a
  versioned `build123d-tool-error/1.0` payload with recovery guidance.
- **Hardened tool input schemas.** `additionalProperties: false` on
  `build123d_execute` and `build123d_export`; `formats` is a unique 1–3 list;
  `density_kg_m3` is strictly positive; `timeout_ms` is an integer from 1 to
  60000; export `name` is capped at 251 characters so `"<name>.glb"` stays
  within 255.
- **CI** installs `build123d==0.11.1`.

## [0.5.0] - 2026-08-25

- Published JSR package. Its immutable package contents differ from this `0.5.1`
  candidate; use JSR when the exact `0.5.0` release is required.

## [0.4.1] - 2026-08-02

- `build123d_export.files[]` now includes a lowercase SHA-256 digest computed
  from the exact exported bytes, allowing downstream CAD-to-FEA provenance to
  distinguish different content written to the same path.

## [0.4.0] - 2026-08-01

### Changed

- **The results viewer now consumes the shared `@casys/mcp-view` Preact
  component library.** Status, identity, metrics, tables, controls and system
  states use the same presentation language as the ERPNext components. Local CSS
  is limited to the Three.js viewport and CAD-specific layout, while the
  existing GLB tool call, controls and per-instance WebGL cleanup are retained.

## [0.3.1] - 2026-07-31

### Fixed

- **Published server metadata now matches the package release.**
  `server/discover`, `/health`, and the published viewer bundle path report
  `0.3.1` rather than the stale `0.2.0` value.

## [0.3.0] - 2026-07-31

### Added

- **Interactive 3D inspection for GLB exports.** The existing results MCP App
  now renders build123d assemblies with offline Three.js orbit, pan, zoom, fit,
  reset and wireframe controls while retaining the metrics and export evidence.
- **Bounded app-only GLB transport.** `build123d_export_read` accepts only a
  safe `.glb` basename, enforces real-path containment and a configurable limit
  (8 MiB default, 24 MiB hard maximum), and returns a versioned binary glTF
  envelope without placing base64 in the agent-facing export result. This inline
  transport is an MVP; large assemblies will use a stable artifact URI via
  `resources/read`.

### Changed

- The viewer bundle is built against `@casys/mcp-view@0.4.1`, whose lifecycle
  buffering registers result handling before the MCP Apps handshake completes.

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
