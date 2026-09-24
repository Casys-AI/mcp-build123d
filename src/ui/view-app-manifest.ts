import { MCP_BUILD123D_VERSION } from "../version.ts";
import {
  ASSEMBLY_VIEWER_URI,
  DRAWING_VIEWER_URI,
  RESULTS_VIEWER_URI,
} from "./constants.ts";
import {
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "./recorded-view-session.ts";
import { VIEW_APP_MANIFEST_SCHEMA } from "@casys/mcp-view-contracts";
export { VIEW_APP_MANIFEST_SCHEMA };

export const BUILD123D_GEOMETRY_RESULT_SCHEMA =
  "io.casys.mcp-build123d.geometry-result/1.0" as const;
export const BUILD123D_GEOMETRY_EXECUTION_RESULT_SCHEMA =
  "io.casys.mcp-build123d.geometry-execution-result/1.0" as const;
export const BUILD123D_GEOMETRY_EXPORT_RESULT_SCHEMA =
  "io.casys.mcp-build123d.geometry-export-result/1.0" as const;
export const BUILD123D_ASSEMBLY_RESULT_SCHEMA =
  "build123d-assembly-integrity-observation/1.0" as const;
export const BUILD123D_DRAWING_RESULT_SCHEMA =
  "io.casys.mcp-build123d.drawing-projection/1.0" as const;

export interface Build123dGeometryViewAppResourceDeclaration {
  readonly uri: typeof RESULTS_VIEWER_URI;
  readonly ownership: "whole-view";
  /**
   * Exact `$id` values of the tool output schemas. The legacy wire payload
   * keeps `schemaVersion: "1.0"`; `kind` selects the corresponding schema.
   */
  readonly resultSchemas: readonly [
    typeof BUILD123D_GEOMETRY_EXECUTION_RESULT_SCHEMA,
    typeof BUILD123D_GEOMETRY_EXPORT_RESULT_SCHEMA,
  ];
  readonly acceptedActions: readonly [typeof VIEWER_SESSION_APPLY_ACTION];
  readonly sessionSchemas: readonly [
    typeof BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
    typeof BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  ];
}

export interface Build123dAssemblyViewAppResourceDeclaration {
  readonly uri: typeof ASSEMBLY_VIEWER_URI;
  readonly ownership: "whole-view";
  readonly resultSchemas: readonly [typeof BUILD123D_ASSEMBLY_RESULT_SCHEMA];
}

export interface Build123dDrawingViewAppResourceDeclaration {
  readonly uri: typeof DRAWING_VIEWER_URI;
  readonly ownership: "whole-view";
  readonly resultSchemas: readonly [typeof BUILD123D_DRAWING_RESULT_SCHEMA];
}

export type Build123dViewAppResourceDeclaration =
  | Build123dGeometryViewAppResourceDeclaration
  | Build123dAssemblyViewAppResourceDeclaration
  | Build123dDrawingViewAppResourceDeclaration;

export interface Build123dViewAppManifest {
  readonly schemaVersion: typeof VIEW_APP_MANIFEST_SCHEMA;
  readonly app: {
    readonly id: "io.casys.mcp-build123d.results";
    readonly title: "Build123d inspection";
    readonly version: typeof MCP_BUILD123D_VERSION;
  };
  readonly resources: readonly [
    Build123dGeometryViewAppResourceDeclaration,
    Build123dAssemblyViewAppResourceDeclaration,
    Build123dDrawingViewAppResourceDeclaration,
  ];
}

export interface Build123dMcpAppInfo {
  readonly name: Build123dViewAppManifest["app"]["id"];
  readonly version: Build123dViewAppManifest["app"]["version"];
}

/** App-owned, authority-free declaration for its exact MCP App resource. */
export const BUILD123D_VIEW_APP_MANIFEST: Build123dViewAppManifest = Object
  .freeze({
    schemaVersion: VIEW_APP_MANIFEST_SCHEMA,
    app: Object.freeze({
      id: "io.casys.mcp-build123d.results",
      title: "Build123d inspection",
      version: MCP_BUILD123D_VERSION,
    }),
    resources: Object.freeze(
      [
        Object.freeze({
          uri: RESULTS_VIEWER_URI,
          ownership: "whole-view",
          resultSchemas: Object.freeze(
            [
              BUILD123D_GEOMETRY_EXECUTION_RESULT_SCHEMA,
              BUILD123D_GEOMETRY_EXPORT_RESULT_SCHEMA,
            ] as const,
          ),
          acceptedActions: Object.freeze(
            [VIEWER_SESSION_APPLY_ACTION] as const,
          ),
          sessionSchemas: Object.freeze(
            [
              BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
              BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
            ] as const,
          ),
        }),
        Object.freeze({
          uri: ASSEMBLY_VIEWER_URI,
          ownership: "whole-view",
          resultSchemas: Object.freeze(
            [BUILD123D_ASSEMBLY_RESULT_SCHEMA] as const,
          ),
        }),
        Object.freeze({
          uri: DRAWING_VIEWER_URI,
          ownership: "whole-view",
          resultSchemas: Object.freeze(
            [BUILD123D_DRAWING_RESULT_SCHEMA] as const,
          ),
        }),
      ] as const,
    ),
  });

/** MCP Apps handshake identity, derived from the exact published manifest. */
export const BUILD123D_MCP_APP_INFO: Build123dMcpAppInfo = Object.freeze({
  name: BUILD123D_VIEW_APP_MANIFEST.app.id,
  version: BUILD123D_VIEW_APP_MANIFEST.app.version,
});
