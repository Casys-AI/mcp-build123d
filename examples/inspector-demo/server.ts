/** Local Inspector tools using the same App bundles and result parsers as build123d. */
import { MCP_APP_MIME_TYPE, McpApp } from "@casys/mcp-platform";
import { dirname, fromFileUrl, join } from "@std/path";
import { parseGeometryResult } from "../../src/ui/results-viewer/src/contract.ts";
import { loadInspectorFixtures } from "./fixtures.ts";

const here = dirname(fromFileUrl(import.meta.url));
const root = join(here, "..", "..");
const port = Number(Deno.env.get("BUILD123D_DEMO_PORT") ?? "3016");
const uris = {
  geometry: "ui://mcp-build123d-example/results-viewer",
  assembly: "ui://mcp-build123d-example/assembly-viewer",
  drawing: "ui://mcp-build123d-example/drawing-viewer",
} as const;

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))
    .toHex();
}

const geometryFixture = JSON.parse(
  await Deno.readTextFile(join(root, "docs/fixtures/bracket-r1.export.json")),
) as Record<string, unknown>;
const parsedGeometry = parseGeometryResult(geometryFixture);
if (!parsedGeometry.ok) throw new Error(parsedGeometry.error);
const gltf = parsedGeometry.value.files.find((file) => file.format === "gltf");
if (!gltf) throw new Error("The geometry example has no GLB resource");
const glb = await Deno.readFile(join(root, "docs/fixtures/bracket-r1.glb"));
if (
  glb.byteLength !== gltf.artifact.bytes ||
  await sha256(glb) !== gltf.artifact.sha256
) throw new Error("The geometry GLB does not match its declared identity");

const fixtures = await loadInspectorFixtures();
const app = new McpApp({
  name: "mcp-build123d-inspector-examples",
  version: "0.1.0",
  transport: "stateless",
  logger: (message) => console.error(`[inspector-demo] ${message}`),
  instructions:
    "Local, read-only examples of build123d MCP Apps. Geometry is a saved " +
    "export, assembly observations are saved results, and the 2D views are " +
    "derived SVG projections. No CAD work runs when an example is called.",
});

for (const viewer of ["geometry", "assembly", "drawing"] as const) {
  const uri = uris[viewer];
  const bundle = viewer === "geometry" ? "results-viewer" : `${viewer}-viewer`;
  const html = await Deno.readTextFile(
    join(root, "src/ui/dist", bundle, "index.html"),
  );
  app.registerResource(
    {
      uri,
      name: `Build123d local ${viewer} example App`,
      description: "Inspector example using the built build123d MCP App bundle",
    },
    () => ({ uri, mimeType: MCP_APP_MIME_TYPE, text: html }),
  );
}

app.registerResource(
  {
    uri: gltf.artifact.uri,
    name: "Verified bracket GLB example",
    mimeType: gltf.artifact.mimeType,
  },
  () => ({
    uri: gltf.artifact.uri,
    mimeType: gltf.artifact.mimeType,
    blob: glb.toBase64(),
  }),
);

function exampleTool(
  name: string,
  title: string,
  viewerUri: string,
  data: Record<string, unknown>,
  resultMeta?: Record<string, unknown>,
): void {
  app.registerTool(
    {
      name,
      description: `${title}. Saved local example; no CAD execution.`,
      annotations: { title },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      _meta: { ui: { resourceUri: viewerUri } },
    },
    () => ({
      content: [{ type: "text", text: `${title} — local example.` }],
      structuredContent: data,
      ...(resultMeta ? { _meta: resultMeta } : {}),
    }),
  );
}

exampleTool(
  "example_geometry_bracket",
  "3D geometry · bracket",
  uris.geometry,
  geometryFixture,
);
for (const fixture of fixtures) {
  exampleTool(
    `example_${fixture.name.replaceAll("-", "_")}`,
    fixture.title,
    uris[fixture.viewer],
    fixture.result,
    fixture.meta,
  );
}

await app.startHttp({
  port,
  hostname: "127.0.0.1",
  cors: true,
  onListen: ({ hostname, port }) =>
    console.error(`[inspector-demo] http://${hostname}:${port}/mcp`),
});
