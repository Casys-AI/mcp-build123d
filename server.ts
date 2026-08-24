/**
 * MCP Server Bootstrap for CAD Tools
 *
 * Stateless HTTP server (default port: 3014):
 *   deno run --allow-all server.ts --port=3014
 *
 * Environment:
 *   BUILD123D_PYTHON_BIN   Python interpreter with build123d (default: python3)
 *   BUILD123D_EXPORT_DIR   Where build123d_export writes files (default: ./cad-exports)
 *
 * @module lib/cad/server
 */

import { createCadMcpApp } from "./src/server-app.ts";

const DEFAULT_HTTP_PORT = 3014;

async function main() {
  const args = Deno.args;

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

  const { app: server } = createCadMcpApp({ categories });

  await server.startHttp({
    port: httpPort,
    hostname,
    cors: true,
    onListen: (info) => {
      console.error(
        `[mcp-build123d] HTTP server listening on http://${info.hostname}:${info.port}`,
      );
    },
  });
  console.error("[mcp-build123d] Server ready - stateless HTTP");

  Deno.addSignalListener("SIGINT", () => {
    console.error("[mcp-build123d] Shutting down...");
    Deno.exit(0);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-build123d] Fatal error:", error);
    Deno.exit(1);
  });
}
