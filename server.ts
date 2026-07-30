/**
 * MCP Server Bootstrap for CAD Tools
 *
 * Usage in an MCP config (stdio mode):
 * {
 *   "mcpServers": {
 *     "cad": {
 *       "command": "deno",
 *       "args": ["run", "--allow-all", "jsr:@casys/mcp-cad/server"]
 *     }
 *   }
 * }
 *
 * HTTP mode (default port: 3014):
 *   deno run --allow-all server.ts --http --port=3014
 *
 * Environment:
 *   CAD_PYTHON_BIN   Python interpreter with build123d (default: python3)
 *   CAD_EXPORT_DIR   Where cad_export writes files (default: ./cad-exports)
 *
 * @module lib/cad/server
 */

import { ConcurrentMCPServer } from "@casys/mcp-server";
import { CadToolsClient } from "./src/client.ts";

const DEFAULT_HTTP_PORT = 3014;

async function main() {
  const args = Deno.args;

  const categoriesArg = args.find((arg) => arg.startsWith("--categories="));
  const categories = categoriesArg ? categoriesArg.split("=")[1].split(",") : undefined;

  const httpFlag = args.includes("--http");
  const portArg = args.find((arg) => arg.startsWith("--port="));
  const httpPort = portArg ? parseInt(portArg.split("=")[1], 10) : DEFAULT_HTTP_PORT;
  const hostnameArg = args.find((arg) => arg.startsWith("--hostname="));
  const hostname = hostnameArg ? hostnameArg.split("=")[1] : "0.0.0.0";

  const toolsClient = new CadToolsClient(categories ? { categories } : undefined);

  const server = new ConcurrentMCPServer({
    name: "mcp-cad",
    version: "0.1.0",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    logger: (msg) => console.error(`[mcp-cad] ${msg}`),
  });

  server.registerTools(toolsClient.toMCPFormat(), toolsClient.buildHandlersMap());

  if (httpFlag) {
    await server.startHttp({
      port: httpPort,
      hostname,
      cors: true,
      onListen: (info) => {
        console.error(`[mcp-cad] HTTP server listening on http://${info.hostname}:${info.port}`);
      },
    });
    console.error(`[mcp-cad] Server ready (${toolsClient.count} tools) - HTTP mode`);
  } else {
    await server.start();
    console.error(`[mcp-cad] Server ready (${toolsClient.count} tools) - stdio mode`);
  }

  Deno.addSignalListener("SIGINT", () => {
    console.error("[mcp-cad] Shutting down...");
    Deno.exit(0);
  });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[mcp-cad] Fatal error:", error);
    Deno.exit(1);
  });
}
