export interface ViewerBuildEnvironment {
  get(name: string): string | undefined;
}

export interface AuditedViewerSplitModules {
  readonly core: string;
  readonly components: string;
}

/** Fail closed until the coordinated view-package split is published. */
export function requireAuditedViewerSplitModules(
  environment: ViewerBuildEnvironment,
): AuditedViewerSplitModules {
  return Object.freeze({
    core: requiredModule(environment, "MCP_VIEW_MODULE"),
    components: requiredModule(environment, "MCP_VIEW_COMPONENTS_MODULE"),
  });
}

function requiredModule(
  environment: ViewerBuildEnvironment,
  name: string,
): string {
  const value = environment.get(name)?.trim();
  if (!value) {
    throw new Error(
      `[build:ui] ${name} is required until the audited mcp-view package split is published`,
    );
  }
  return value;
}
