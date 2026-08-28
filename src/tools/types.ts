/**
 * CAD tool contracts
 *
 * @module lib/cad/tools/types
 */

import type { MCPToolMeta, ToolAnnotations } from "@casys/mcp-server";

export type CadToolCategory = "execute";

export type CadToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** CAD tool definition with handler */
export interface CadTool {
  name: string;
  description: string;
  category: CadToolCategory;
  inputSchema: Record<string, unknown>;
  /** JSON Schema for the structured result consumed by MCP Apps. */
  outputSchema: Record<string, unknown>;
  handler: CadToolHandler;
  /** Client-facing behavioural hints for safe tool selection. */
  annotations?: ToolAnnotations;
  _meta?: MCPToolMeta;
}
