/**
 * @casys/mcp-cad
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

export { executeTools } from "./src/tools/mod.ts";

export {
  CadExecutionError,
  PythonNotFoundError,
  runCadScript,
} from "./src/api/python-bridge.ts";
export type { CadMetrics, ExportSpec, HarnessResult } from "./src/api/python-bridge.ts";
