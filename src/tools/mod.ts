/**
 * CAD tools — aggregated exports
 *
 * @module lib/cad/tools/mod
 */

export type { CadTool, CadToolCategory, CadToolHandler } from "./types.ts";
export { executeTools } from "./execute.ts";

import { executeTools } from "./execute.ts";
import type { CadTool } from "./types.ts";

/** All CAD tools combined */
export const allTools: CadTool[] = [...executeTools];

/** Tools organized by category */
export const toolsByCategory: Record<string, CadTool[]> = {
  execute: executeTools,
};

/** Get tools by category */
export function getToolsByCategory(category: string): CadTool[] {
  return toolsByCategory[category] || [];
}

/** Get a specific tool by name */
export function getToolByName(name: string): CadTool | undefined {
  return allTools.find((t) => t.name === name);
}

/** Get all available categories */
export function getCategories(): string[] {
  return Object.keys(toolsByCategory);
}
