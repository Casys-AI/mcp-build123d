/**
 * CAD Tools Client
 *
 * Same pattern as the other Casys MCP servers: aggregates tool definitions
 * and produces the MCP wire format plus a handlers map for the server.
 *
 * @module lib/cad/client
 */

import {
  allTools,
  createCadToolCatalogue,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./tools/mod.ts";
import type {
  CadTool,
  CadToolCategory,
  CadToolHandler,
  ExportArtifactPublisher,
} from "./tools/mod.ts";
import type { MCPToolMeta, ToolAnnotations } from "@casys/mcp-server";

export {
  allTools,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
};
export type { CadTool, CadToolCategory, CadToolHandler };

export interface MCPToolWireFormat {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  _meta?: MCPToolMeta;
}

export interface CadToolsClientOptions {
  categories?: string[];
  artifactPublisher?: ExportArtifactPublisher;
  /** Server-owned delivery root shared with the artifact publisher. */
  exportDirectory?: string;
}

/** Client for executing CAD tools. */
export class CadToolsClient {
  private tools: CadTool[];

  constructor(options?: CadToolsClientOptions) {
    const catalogue = createCadToolCatalogue({
      artifactPublisher: options?.artifactPublisher,
      exportDirectory: options?.exportDirectory,
    });
    this.tools = options?.categories
      ? options.categories.flatMap((cat) =>
        catalogue.toolsByCategory[cat] ?? []
      )
      : catalogue.allTools;
  }

  /** List available tools */
  listTools(): CadTool[] {
    return this.tools;
  }

  get count(): number {
    return this.tools.length;
  }

  /** Convert to MCP wire format */
  toMCPFormat(): MCPToolWireFormat[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
      _meta: t._meta,
    }));
  }

  /** Build the name → handler map the server registers */
  buildHandlersMap(): Map<string, CadToolHandler> {
    const handlers = new Map<string, CadToolHandler>();
    for (const tool of this.tools) {
      handlers.set(tool.name, tool.handler);
    }
    return handlers;
  }
}
