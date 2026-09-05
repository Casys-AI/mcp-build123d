# MCP App viewer

The Build123d viewer renders geometry results, recorded Digital Thread geometry,
and Project geometry reviews. Its presentation comes from MCP View components;
Build123d owns the geometry projection, resource validation, and Three.js scene.

## Resource and manifest

`build123d_execute` and `build123d_export` expose the optional resource
`ui://mcp-build123d/results-viewer`. The committed standalone HTML lives at
`src/ui/dist/results-viewer/index.html`. If that bundle is absent, the server
skips resource registration and keeps the text response available.

`BUILD123D_VIEW_APP_MANIFEST` declares this resource with
`ownership: "whole-view"`. Hosts can read the serialized manifest from the
package's `./view-app-manifest` export. The MCP Apps handshake announces the
manifest App id, `io.casys.mcp-build123d.results`, and the package version.

| Input                       | Contract identity                                      | Delivery               |
| --------------------------- | ------------------------------------------------------ | ---------------------- |
| Execution or export result  | `io.casys.mcp-build123d.geometry-result/1.0`           | MCP tool result        |
| Recorded canonical geometry | `io.casys.mcp-build123d.recorded-geometry-session/1.0` | `viewer.session.apply` |
| Project geometry review     | `io.casys.mcp-build123d.geometry-review-session/1.0`   | `viewer.session.apply` |

The result contract name maps to the top-level
`GeometryStructuredContent.schemaVersion: "1.0"` union, discriminated by
`kind: "execution" | "export"`. The nested `build123d-export-artifact/1.0`
schema identifies an immutable artifact, not a complete result envelope. Session
schemas contain no endpoint, credential, tool argument, or host-routing policy.

## Direct tool results

The versioned structured result includes geometry metrics and artifact
references. It does not include the submitted script or file contents. An export
returns one reference per requested format, with its exact URI, MIME type, byte
count, and SHA-256 digest. The [tool examples](../README.md#build123d_execute)
show the execution and export envelopes.

For an exported GLB, the App reads exactly the returned `artifact.uri` through
MCP `resources/read`. The server rehashes its issued in-memory byte copy before
returning it. The App then validates the GLB header and digest before mounting
the scene. This direct-result path uses the server's process-local artifact
store.

## Recorded viewer sessions

### Canonical geometry

`io.casys.mcp-build123d.recorded-geometry-session/1.0` carries the exact
project/Thread basis, graph anchor, canonical `design.write-geometry@1` capture
provenance, and a literal `available`, `unavailable`, or `unresolved`
projection.

The sealed canonical capture is a JSON Thread artifact. An available 3D
projection records a distinct sibling GLB artifact, its exact preview producer,
and its own fingerprint. The App rejects a session that equates the capture and
GLB fingerprints or artifact identities.

### Project review

`io.casys.mcp-build123d.geometry-review-session/1.0` carries an exact pre-MRTR
Project geometry review. Its basis contains the Project revision but no Thread
claim. Its `project-review` anchor binds the review id, that same revision, and
exact SHA-256 fingerprint.

The admitted review statuses are literal `provisional` and `documentary`. A
separate draft capture and optional GLB projection retain their exact identities
and producers. This session never claims canonical geometry, proof, an MRTR
decision, or provider authority.

### Session lifecycle

The host waits for the MCP Apps initialized notification before sending
`viewer.session.apply`. The core `viewerSession` lifecycle installs its action
subscription before the handshake and serializes delivery. The kit's surface App
owns projection and mount lifecycle; obsolete asynchronous work cannot replace a
newer geometry scene.

A session owns the whole geometry datasheet and needs no host-selected component
surface. The host separately registers the projection fingerprint in its bounded
`readResources` descriptor. Without that registration, the App reports GLB
transport as unavailable while retaining the session's recorded domain status.

### Host resource bridge

In recorded-session mode, the opaque-origin App requests the GLB by fingerprint
over one dedicated, document-scoped `MessagePort`:

1. Before connecting, the App creates a `MessageChannel`, retains its endpoint,
   and transfers the host endpoint once with `mcp-app-host.resource.port.offer`.
2. The host resolves only a resource registered on that exact viewer session,
   bounds and rehashes its bytes, and returns its root-relative URI, MIME type,
   byte count, fingerprint, and canonical base64.
3. The App independently validates and rehashes those bytes before mounting its
   orbit/pan/zoom scene. The port closes at teardown or navigation.

The host never offers or retransfers a port through the navigation-stable parent
`WindowProxy`. Requests and bytes use only the retained channel. The returned
URI is resource identity metadata: the App does not choose or fetch it.
Root-relative `.glb` paths and paths ending in a lowercase SHA-256 hash, such as
`/api/thread/viewer-apps/resources/<64-hex-digest>`, are accepted. Absolute
URLs, dot segments, query strings, and fragments are rejected.

This mode makes no Build123d call, provider-tool call, MCP resource request, or
process-local artifact-store lookup, and does not require `allow-same-origin`.

## Compose components

The App advertises independently mountable components during `ui/initialize`.
For direct tool results, a Compose host can choose the component subset, order,
grid, and gap. Without a requested surface, the default is one geometry
datasheet. Recorded sessions always mount that same datasheet.

| Component key                  | Presentation                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `build123d.geometry-datasheet` | Literal status, at most four readings, verified 3D model, titled facts, artifacts, provenance |
| `build123d.geometry-status`    | One-row computation/export or session identity with its provenance                            |
| `build123d.geometry-metrics`   | OCCT readings, topology, bounding box, center of mass, optional density                       |
| `build123d.geometry-canvas`    | Verified GLB resource and interactive Three.js scene                                          |
| `build123d.export-artifacts`   | Resource URIs, digests, MIME types, byte sizes; session basis and capture provenance          |

Each is a Preact component built with the optional `@casys/mcp-view-components`
package: `SemanticElement` and its ident, section, and provenance slots,
`MetricGrid`, `KeyValueList`, `ArtifactRow`, `Slot3D`, `Card`, `Badge`,
`Button`, `Toolbar`, and system states. The entry point uses
`startPreactSurfaceApp`; the lifecycle/router is provided by renderer-neutral
`@casys/mcp-view`. Local styles cover the Three.js viewport and CAD layout.
Numbers follow the host `locale` from `ui/initialize`.

Repeated canvas instances have independent controls and Three.js cleanup. No
component-level semantic Compose event is emitted or accepted: the result
contract does not provide stable feature, face, or instance identifiers.
`viewer.session.apply` replaces the whole App read model and is a resource-level
action, not a component interaction event.

The GLB viewer has a 24 MiB local cap; resource identity and retrieval remain
available separately for larger artifacts. A compound export remains an
aggregate shape. Its resource identity establishes exact bytes, not assembly,
motion, fit, or requirement semantics.

## Build the viewer

The committed bundle uses `@casys/mcp-view@0.9.3` and
`@casys/mcp-view-components@0.7.0`, built from `Casys-AI/mcp-server` commit
`59eeb3750d2049b8141b09d3a6f29f66f9d3c657`. Use that checkout for both module
entries:

```bash
MCP_VIEW_MODULE=file:///absolute/path/to/mcp-server/packages/view/mod.ts \
MCP_VIEW_COMPONENTS_MODULE=file:///absolute/path/to/mcp-server/packages/view-components/mod.ts \
  deno task build:ui
```

The build requires both module entries explicitly. Local Preact and contracts
entries are derived from those paths; `MCP_VIEW_COMPONENTS_PREACT_MODULE` and
`MCP_VIEW_CONTRACTS_MODULE` can override those derived entries when the layout
differs. Deno's dependency-age quarantine applies to the rest of the graph, with
exceptions for the Casys view packages.

The generated HTML bundles its dependencies. At runtime it accepts the result
and session contracts above. Direct export GLBs arrive through MCP
`resources/read`; recorded-session GLBs arrive through the host resource bridge.
The viewer never executes the submitted Python. Generated `src/ui/dist/` is
excluded from Deno source formatting; viewer source remains covered.

## Capture the viewer

From a source checkout, `deno task capture:docs` renders the committed bundle
through `scripts/capture-viewer-doc.ts` with the real export fixture
`docs/fixtures/bracket-r1.export.json` and its digest-checked GLB. Headless
Chrome uses software WebGL and writes `docs/assets/build123d-export-viewer.png`.
Set `CHROME_BIN` and, if needed, `FFMPEG_BIN` when those executables are
elsewhere.

The [README screenshot](assets/build123d-export-viewer.png) shows that direct
export flow. A recorded-session capture must exercise the separate host resource
bridge described above.
