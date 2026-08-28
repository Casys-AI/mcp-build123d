/**
 * @casys/mcp-build123d
 *
 * MCP tools for parametric CAD as code, over build123d (Python, OCCT
 * kernel). Execute a script, get exact analytical geometry metrics, export
 * STEP / STL / GLTF.
 *
 * @module
 */

export {
  allTools,
  CadToolsClient,
  getCategories,
  getToolByName,
  getToolsByCategory,
  toolsByCategory,
} from "./src/client.ts";
export type {
  CadTool,
  CadToolCategory,
  CadToolHandler,
  CadToolsClientOptions,
  MCPToolWireFormat,
} from "./src/client.ts";

export { executeTools } from "./src/tools/execute.ts";
export { createExecuteTools, geometryToolResult } from "./src/tools/execute.ts";
export type {
  CreateExecuteToolsOptions,
  ExportArtifactPublisher,
  GeometryStructuredContent,
} from "./src/tools/execute.ts";
export {
  BUILD123D_ARTIFACT_SCHEMA,
  BUILD123D_ARTIFACT_URI_PREFIX,
  BUILD123D_EXPORT_EXECUTION_SCHEMA,
  Build123dArtifactError,
  Build123dArtifactStore,
  createBuild123dExportExecution,
} from "./src/artifacts.ts";
export type {
  Build123dArtifactFormat,
  Build123dArtifactReference,
  Build123dExportExecution,
  Build123dExportOutput,
  CreateBuild123dExportExecutionInput,
  PublishedCadExportFile,
} from "./src/artifacts.ts";
export { createCadMcpApp } from "./src/server-app.ts";
export type {
  CadMcpAppAssembly,
  CreateCadMcpAppOptions,
} from "./src/server-app.ts";
export {
  BUILD123D_TOOL_ERROR_SCHEMA,
  build123dToolErrorResult,
} from "./src/tool-errors.ts";
export type { Build123dToolErrorPayload } from "./src/tool-errors.ts";
export {
  ASSEMBLY_INTEGRITY_OUTPUT_SCHEMA,
  ASSEMBLY_INTEGRITY_TOOL,
  assemblyIntegrityTools,
} from "./src/tools/assembly-integrity.ts";
export { RESULTS_VIEWER_URI } from "./src/ui/constants.ts";

export {
  ASSEMBLY_INTEGRITY_MAXIMUM_BASE64_CHARACTERS,
  ASSEMBLY_INTEGRITY_MAXIMUM_HTTP_BODY_BYTES,
  ASSEMBLY_INTEGRITY_MAXIMUM_OCCURRENCES,
  ASSEMBLY_INTEGRITY_MAXIMUM_PAIRS,
  ASSEMBLY_INTEGRITY_MAXIMUM_STEP_BYTES,
  ASSEMBLY_INTEGRITY_OBSERVATION_SCHEMA,
  ASSEMBLY_INTEGRITY_PRODUCER,
  AssemblyIntegrityInputError,
  AssemblyIntegrityObservationError,
  observeAssemblyIntegrity,
  OCCT_ASSEMBLY_INTEGRITY_METHOD,
  parseAssemblyIntegrityObservation,
} from "./src/api/assembly-integrity-bridge.ts";
export {
  CadExecutionError,
  PythonNotFoundError,
  runCadScript,
} from "./src/api/python-bridge.ts";
export type {
  AssemblyIntegrityFact,
  AssemblyIntegrityInputArtifact,
  AssemblyIntegrityObservation,
  AssemblyIntegrityObservationInput,
  AssemblyIntegrityOccurrence,
  AssemblyIntegrityPair,
  AssemblyIntegrityProducer,
  AssemblyIntegrityRigidTransform,
  AssemblyIntegrityTopology,
} from "./src/api/assembly-integrity-bridge.ts";
export { MCP_BUILD123D_VERSION } from "./src/version.ts";
export type {
  CadExportFile,
  CadMetrics,
  ExportSpec,
  HarnessResult,
} from "./src/api/python-bridge.ts";
