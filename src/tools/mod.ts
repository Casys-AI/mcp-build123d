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
export {
  createProjection2dTools,
  type CreateProjection2dToolsOptions,
  projection2dTools,
  PROJECTION_2D_INPUT_SCHEMA,
  PROJECTION_2D_OUTPUT_SCHEMA,
  PROJECTION_2D_TOOL,
} from "./projection-2d.ts";

import {
  assemblyIntegrityTools,
  createAssemblyIntegrityTools,
} from "./assembly-integrity.ts";
import {
  createExecuteTools,
  type CreateExecuteToolsOptions,
  executeTools,
} from "./execute.ts";
import { createProjection2dTools, projection2dTools } from "./projection-2d.ts";
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
  const projection = createProjection2dTools({
    resolveOwnedStep: options.resolveOwnedStep,
  });
  const allTools = [...execution, ...observation, ...projection];
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
  allTools: [...executeTools, ...assemblyIntegrityTools, ...projection2dTools],
  toolsByCategory: {
    execute: [...executeTools, ...assemblyIntegrityTools, ...projection2dTools],
  },
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
