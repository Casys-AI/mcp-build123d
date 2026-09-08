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
  createAssemblyIntegrityTools,
  type CreateAssemblyIntegrityToolsOptions,
} from "./assembly-integrity.ts";
export {
  createExecuteTools,
  type CreateExecuteToolsOptions,
  executeTools,
  type ExportArtifactPublisher,
} from "./execute.ts";

import {
  assemblyIntegrityTools,
  createAssemblyIntegrityTools,
} from "./assembly-integrity.ts";
import {
  createExecuteTools,
  type CreateExecuteToolsOptions,
  executeTools,
} from "./execute.ts";
import type { OwnedStepResolver } from "../artifacts.ts";
import type { CadTool } from "./types.ts";

export interface CadToolCatalogue {
  readonly allTools: CadTool[];
  readonly toolsByCategory: Record<string, CadTool[]>;
}

export interface CreateCadToolCatalogueOptions
  extends CreateExecuteToolsOptions {
  /** Server-assembly owned STEP resolver. Never an MCP input. */
  resolveOwnedStep?: OwnedStepResolver;
}

/** Build the catalogue around the server-owned export artifact registry. */
export function createCadToolCatalogue(
  options: CreateCadToolCatalogueOptions = {},
): CadToolCatalogue {
  const execution = createExecuteTools(options);
  const observation = createAssemblyIntegrityTools({
    resolveOwnedStep: options.resolveOwnedStep,
  });
  const allTools = [...execution, ...observation];
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
