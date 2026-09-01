import { MCP_BUILD123D_VERSION } from "../version.ts";
import { RESULTS_VIEWER_URI } from "./constants.ts";
import {
  BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
  VIEWER_SESSION_APPLY_ACTION,
} from "./recorded-view-session.ts";
import { VIEW_APP_MANIFEST_SCHEMA } from "@casys/mcp-view-contracts";
export { VIEW_APP_MANIFEST_SCHEMA };

export const BUILD123D_GEOMETRY_RESULT_SCHEMA =
  "io.casys.mcp-build123d.geometry-result/1.0" as const;

export interface Build123dViewAppResourceDeclaration {
  readonly uri: typeof RESULTS_VIEWER_URI;
  readonly ownership: "whole-view";
  /**
   * App-owned identity for the existing `GeometryStructuredContent` union.
   * Its unchanged wire payload remains `schemaVersion: "1.0"`, discriminated
   * by `kind: "execution" | "export"`.
   */
  readonly resultSchemas: readonly [typeof BUILD123D_GEOMETRY_RESULT_SCHEMA];
  readonly acceptedActions: readonly [typeof VIEWER_SESSION_APPLY_ACTION];
  readonly sessionSchemas: readonly [
    typeof BUILD123D_RECORDED_VIEW_SESSION_SCHEMA,
    typeof BUILD123D_GEOMETRY_REVIEW_SESSION_SCHEMA,
  ];
}

export interface Build123dViewAppManifest {
  readonly schemaVersion: typeof VIEW_APP_MANIFEST_SCHEMA;
  readonly app: {
    readonly id: "io.casys.mcp-build123d.results";
    readonly title: "Build123d geometry";
    readonly version: typeof MCP_BUILD123D_VERSION;
  };
  readonly resources: readonly [Build123dViewAppResourceDeclaration];
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
      title: "Build123d geometry",
      version: MCP_BUILD123D_VERSION,
    }),
    resources: Object.freeze(
      [
        Object.freeze({
          uri: RESULTS_VIEWER_URI,
          ownership: "whole-view",
          resultSchemas: Object.freeze(
            [BUILD123D_GEOMETRY_RESULT_SCHEMA] as const,
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
      ] as const,
    ),
  });

/** MCP Apps handshake identity, derived from the exact published manifest. */
export const BUILD123D_MCP_APP_INFO: Build123dMcpAppInfo = Object.freeze({
  name: BUILD123D_VIEW_APP_MANIFEST.app.id,
  version: BUILD123D_VIEW_APP_MANIFEST.app.version,
});
