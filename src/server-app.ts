/** Server assembly kept separate from the process bootstrap for wire tests. */

import { McpApp, SchemaValidator } from "@casys/mcp-server";
import { Build123dArtifactStore } from "./artifacts.ts";
import { CadToolsClient } from "./client.ts";
import {
  build123dFallbackToolErrorText,
  build123dInvalidArgumentsResult,
  build123dToolErrorResult,
  logBuild123dToolFailure,
} from "./tool-errors.ts";
import { registerBuild123dViewers, type ViewerFilesystem } from "./viewers.ts";
import { MCP_BUILD123D_VERSION } from "./version.ts";

export interface CreateCadMcpAppOptions {
  categories?: string[];
  /** Server-owned delivery root; intended for embedding and isolated tests. */
  exportDirectory?: string;
  /**
   * Deprecated compatibility slot. Artifact resources are process-local and do
   * not read or write an artifact directory.
   */
  artifactDirectory?: string;
  viewerFilesystem?: ViewerFilesystem;
  viewerModuleUrl?: string;
}

export interface CadMcpAppAssembly {
  app: McpApp;
  artifactStore: Build123dArtifactStore;
  toolsClient: CadToolsClient;
  viewers: { registered: string[]; skipped: string[] };
}

/** Create a fully wired build123d MCP application before it is started. */
export function createCadMcpApp(
  options: CreateCadMcpAppOptions = {},
): CadMcpAppAssembly {
  const app = new McpApp({
    name: "mcp-build123d",
    version: MCP_BUILD123D_VERSION,
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    // Validate inside the app wrapper so failures keep the same structured,
    // path-free public error contract as runner and artifact failures.
    validateSchema: false,
    // Export resources are registered immediately after a successful export,
    // including while a stdio or stateless HTTP transport is already serving.
    expectResources: true,
    instructions:
      "Use build123d_execute for exact OCCT geometry measurements and " +
      "build123d_export when a STEP, STL, or GLB delivery artifact is needed. " +
      "Every export result contains immutable digest-bound artifact URIs; read " +
      "only those URIs through resources/read and never construct a host path. " +
      "Scripts must assign the final Part, Solid, Compound, or BuildPart to " +
      "top-level result. Supply density_kg_m3 only when its value is known. " +
      "This server executes trusted arbitrary Python and returns computation " +
      "evidence, not product admission, fit, safety, manufacturing, or " +
      "requirement verdicts.",
    logger: (msg) => console.error(`[mcp-build123d] ${msg}`),
    // Defense in depth for a framework/middleware exception that happens
    // outside the per-tool wrapper below. Framework fallback content is
    // text-only, so expected validation stays in the structured wrapper.
    toolErrorMapper: (error, tool) => {
      logBuild123dToolFailure(tool, error);
      return build123dFallbackToolErrorText();
    },
  });
  const artifactStore = new Build123dArtifactStore(
    app,
    options.artifactDirectory,
    options.exportDirectory,
  );
  const toolsClient = new CadToolsClient({
    ...(options.categories ? { categories: options.categories } : {}),
    artifactPublisher: artifactStore,
    exportDirectory: options.exportDirectory,
  });

  const handlers = toolsClient.buildHandlersMap();
  const inputValidator = new SchemaValidator();
  for (const tool of toolsClient.toMCPFormat()) {
    const handler = handlers.get(tool.name);
    if (!handler) throw new Error(`Missing handler for tool '${tool.name}'`);
    inputValidator.addSchema(tool.name, tool.inputSchema);
    const agentSafeHandler = async (args: Record<string, unknown>) => {
      if (!inputValidator.validate(tool.name, args).valid) {
        return build123dInvalidArgumentsResult(tool.name);
      }
      try {
        return await handler(args);
      } catch (error) {
        logBuild123dToolFailure(tool.name, error);
        return build123dToolErrorResult(tool.name, error);
      }
    };
    app.registerTool(tool, agentSafeHandler);
  }
  const viewers = registerBuild123dViewers(
    app,
    options.viewerFilesystem,
    options.viewerModuleUrl,
  );
  return { app, artifactStore, toolsClient, viewers };
}
