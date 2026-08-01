/** Server assembly kept separate from the process bootstrap for wire tests. */

import { McpApp } from "@casys/mcp-server";
import { CadToolsClient } from "./client.ts";
import { registerBuild123dViewers, type ViewerFilesystem } from "./viewers.ts";

export interface CreateCadMcpAppOptions {
  categories?: string[];
  viewerFilesystem?: ViewerFilesystem;
  viewerModuleUrl?: string;
}

export interface CadMcpAppAssembly {
  app: McpApp;
  toolsClient: CadToolsClient;
  viewers: { registered: string[]; skipped: string[] };
}

/** Create a fully wired build123d MCP application before it is started. */
export function createCadMcpApp(
  options: CreateCadMcpAppOptions = {},
): CadMcpAppAssembly {
  const toolsClient = new CadToolsClient(
    options.categories ? { categories: options.categories } : undefined,
  );
  const app = new McpApp({
    name: "mcp-build123d",
    version: "0.4.0",
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    logger: (msg) => console.error(`[mcp-build123d] ${msg}`),
  });

  app.registerTools(toolsClient.toMCPFormat(), toolsClient.buildHandlersMap());
  const viewers = registerBuild123dViewers(
    app,
    options.viewerFilesystem,
    options.viewerModuleUrl,
  );
  return { app, toolsClient, viewers };
}
