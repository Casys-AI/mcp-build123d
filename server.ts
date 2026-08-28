/**
 * MCP Server Bootstrap for CAD Tools
 *
 * Stateless HTTP server (default port: 3014):
 *   deno run --allow-all server.ts --port=3014
 * Native stdio server:
 *   deno run --allow-all server.ts --stdio
 *
 * Environment:
 *   BUILD123D_PYTHON_BIN   Python interpreter with build123d (default: python3)
 *   BUILD123D_EXPORT_DIR   Where build123d_export writes files (default: ./cad-exports)
 *
 * @module lib/cad/server
 */

import { createCadMcpApp } from "./src/server-app.ts";
import { ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES } from "./src/api/assembly-integrity-bridge.ts";

const DEFAULT_HTTP_PORT = 3014;

async function main() {
  const args = Deno.args;
  const stdio = args.includes("--stdio");

  const categoriesArg = args.find((arg) => arg.startsWith("--categories="));
  const categories = categoriesArg
    ? categoriesArg.split("=")[1].split(",")
    : undefined;

  const portArg = args.find((arg) => arg.startsWith("--port="));
  const httpPort = portArg
    ? parseInt(portArg.split("=")[1], 10)
    : DEFAULT_HTTP_PORT;
  const hostnameArg = args.find((arg) => arg.startsWith("--hostname="));
  const hostname = hostnameArg ? hostnameArg.split("=")[1] : "127.0.0.1"; // loopback by default — these tools execute code; exposing them is an explicit choice

  const { app: server, artifactStore } = createCadMcpApp({ categories });
  // Process-local artifact resources are never re-admitted from disk. This no-op
  // keeps the bootstrap explicit and makes a preseeded object invisible.
  await artifactStore.restore();

  if (stdio) {
    await server.start();
    console.error("[mcp-build123d] Server ready - stdio");
  } else {
    await server.startHttp({
      port: httpPort,
      hostname,
      // The observer's closed artifact envelope is inline base64. Keep this cap
      // finite, but large enough for its documented 128 MiB decoded STEP bound.
      maxBodyBytes: ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES,
      cors: true,
      onListen: (info) => {
        console.error(
          `[mcp-build123d] HTTP server listening on http://${info.hostname}:${info.port}`,
        );
      },
    });
    console.error("[mcp-build123d] Server ready - stateless HTTP");
  }

  let stopping = false;
  Deno.addSignalListener("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    console.error("[mcp-build123d] Shutting down...");
    void server.stop().finally(() => Deno.exit(0));
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-build123d] Fatal error:", error);
    Deno.exit(1);
  });
}
