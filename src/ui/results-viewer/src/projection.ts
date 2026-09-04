/**
 * What the viewer projects, kit-free: one host tool result or one recorded
 * session becomes a display state the surface App routes. The App binding in
 * `main.ts` only wires these onto `startPreactSurfaceApp`, so every branch
 * here is testable without an MCP Apps host.
 */

import {
  type Build123dRecordedResourceReader,
  parseBuild123dViewerSession,
} from "../../recorded-view-session.ts";
import type { GeometryComponentData } from "./component-model.ts";
import { parseGeometryResult } from "./contract.ts";

/** `code` of the danger state shown when the tool itself reported an error. */
export const TOOL_ERROR_CODE = "tool-error";
/** `code` of the danger state shown when a result fails the strict envelope parser. */
export const RESULT_REJECTED_CODE = "result-rejected";
/** `code` of the danger state shown when a recorded session fails the strict parser. */
export const SESSION_REJECTED_CODE = "session-rejected";

/** The tool result fields the projection reads; the App hands it the whole envelope. */
export interface GeometryToolResult {
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}

/** The surface App states this viewer produces, mirrored without the kit types. */
export type GeometryDisplayState =
  | {
    readonly kind: "error";
    readonly title: string;
    readonly code: string;
    readonly message: string;
  }
  | { readonly kind: "result"; readonly result: GeometryComponentData };

/** A tool error is shown with its own text; a malformed envelope with the parser's. */
export function geometryStateFromToolResult(
  result: GeometryToolResult,
): GeometryDisplayState {
  if (result.isError) {
    return {
      kind: "error",
      title: "Computation failed",
      code: TOOL_ERROR_CODE,
      message: mcpErrorText(result.content) ??
        "The build123d computation returned an error.",
    };
  }
  const parsed = parseGeometryResult(result.structuredContent);
  if (!parsed.ok) {
    return {
      kind: "error",
      title: "Result not displayable",
      code: RESULT_REJECTED_CODE,
      message: parsed.error,
    };
  }
  return { kind: "result", result: { result: parsed.value } };
}

/**
 * A recorded session replaces the whole read model. Its GLB bytes come only
 * through `readResource`, the fingerprint-addressed bridge to the parent page.
 */
export function geometryStateFromViewerSession(
  value: unknown,
  readResource: Build123dRecordedResourceReader,
): GeometryDisplayState {
  const parsed = parseBuild123dViewerSession(value);
  if (!parsed.ok) {
    return {
      kind: "error",
      title: "Session rejected",
      code: SESSION_REJECTED_CODE,
      message: parsed.error,
    };
  }
  return {
    kind: "result",
    result: {
      source: "viewer-session",
      session: parsed.value,
      readResource,
    },
  };
}

/** The text blocks of an MCP error result, joined; `undefined` when it carries none. */
export function mcpErrorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const messages = content.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const block = entry as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return messages.length > 0 ? messages.join("\n") : undefined;
}
