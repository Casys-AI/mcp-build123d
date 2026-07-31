/**
 * CAD tool contracts
 *
 * @module lib/cad/tools/types
 */

import type { MCPToolMeta, StructuredToolResult } from "@casys/mcp-server";

export type CadToolCategory = "execute";

export type CadToolHandler = (
  args: Record<string, unknown>,
) => Promise<StructuredToolResult> | StructuredToolResult;

/** CAD tool definition with handler */
export interface CadTool {
  name: string;
  description: string;
  category: CadToolCategory;
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the structured result consumed by MCP Apps. */
  outputSchema: Record<string, unknown>;
  handler: CadToolHandler;
  _meta?: MCPToolMeta;
}
