/**
 * CAD tool contracts
 *
 * @module lib/cad/tools/types
 */

import type { MCPToolMeta } from "@casys/mcp-server";

export type CadToolCategory = "execute";

export type CadToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;

/** CAD tool definition with handler */
export interface CadTool {
  name: string;
  description: string;
  category: CadToolCategory;
  inputSchema: Record<string, unknown>;
  handler: CadToolHandler;
  _meta?: MCPToolMeta;
}
