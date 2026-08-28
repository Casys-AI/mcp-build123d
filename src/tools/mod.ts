/**
 * CAD tools — aggregated exports
 *
 * @module lib/cad/tools/mod
 */

export type { CadTool, CadToolCategory, CadToolHandler } from "./types.ts";
export {
  ASSEMBLY_INTEGRITY_OUTPUT_SCHEMA,
  ASSEMBLY_INTEGRITY_TOOL,
  assemblyIntegrityTools,
} from "./assembly-integrity.ts";
export {
  createExecuteTools,
  type CreateExecuteToolsOptions,
  executeTools,
  type ExportArtifactPublisher,
} from "./execute.ts";

import { assemblyIntegrityTools } from "./assembly-integrity.ts";
import {
  createExecuteTools,
  type CreateExecuteToolsOptions,
  executeTools,
} from "./execute.ts";
import type { CadTool } from "./types.ts";

export interface CadToolCatalogue {
  readonly allTools: CadTool[];
  readonly toolsByCategory: Record<string, CadTool[]>;
}

/** Build the catalogue around the server-owned export artifact registry. */
export function createCadToolCatalogue(
  options: CreateExecuteToolsOptions = {},
): CadToolCatalogue {
  const execution = createExecuteTools(options);
  const allTools = [...execution, ...assemblyIntegrityTools];
  return {
    allTools,
    toolsByCategory: {
      execute: allTools,
    },
  };
}

/**
 * Direct-library catalogue. Its export operation intentionally requires a
 * concrete artifact publisher; the process server installs one at assembly.
 */
const defaultCatalogue: CadToolCatalogue = {
  allTools: [...executeTools, ...assemblyIntegrityTools],
  toolsByCategory: { execute: [...executeTools, ...assemblyIntegrityTools] },
};

/** All CAD tools combined */
export const allTools: CadTool[] = defaultCatalogue.allTools;

/** Tools organized by category */
export const toolsByCategory: Record<string, CadTool[]> =
  defaultCatalogue.toolsByCategory;

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
