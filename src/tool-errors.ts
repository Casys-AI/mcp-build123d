/** Agent-readable, machine-actionable errors for build123d tool execution. */

import {
  Build123dUnavailableError,
  CadExecutionError,
  PythonNotFoundError,
} from "./api/python-bridge.ts";
import {
  AssemblyIntegrityInputError,
  AssemblyIntegrityObservationError,
} from "./api/assembly-integrity-bridge.ts";
import { Build123dArtifactError } from "./artifacts.ts";

export const BUILD123D_TOOL_ERROR_SCHEMA = "build123d-tool-error/1.0" as const;

export interface Build123dToolErrorPayload extends Record<string, unknown> {
  readonly schemaVersion: typeof BUILD123D_TOOL_ERROR_SCHEMA;
  readonly kind: "error";
  readonly tool: string;
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
  readonly retryable: boolean;
}

/** A preformatted MCP tool error; it remains a completed tools/call result. */
export interface Build123dToolErrorResult extends Record<string, unknown> {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError: true;
  readonly structuredContent: Build123dToolErrorPayload;
}

interface PublicToolFailure {
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
  readonly retryable: boolean;
}

const INVALID_ARGUMENTS_FAILURE: PublicToolFailure = {
  code: "request.invalid_arguments",
  message: "Tool arguments do not satisfy the documented input schema.",
  recovery:
    "Retry with only supported fields and values that satisfy the tool input schema.",
  retryable: false,
};

const UNEXPECTED_FAILURE: PublicToolFailure = {
  code: "server.unexpected",
  message: "The build123d server could not complete the tool call.",
  recovery:
    "Retry only after checking the server log and the documented request contract; do not infer an artifact from a failed call.",
  retryable: true,
};

/**
 * Convert every app-level tool failure into one stable public recovery contract.
 * Raw bridge, interpreter, harness and filesystem details stay out of MCP
 * content and structuredContent; the server may log them on stderr instead.
 */
export function build123dToolErrorResult(
  tool: string,
  error: unknown,
): Build123dToolErrorResult {
  return resultFor(tool, classify(error));
}

/** Return a structured safe error before a registered handler is invoked. */
export function build123dInvalidArgumentsResult(
  tool: string,
): Build123dToolErrorResult {
  return resultFor(tool, INVALID_ARGUMENTS_FAILURE);
}

/** Safe text-only fallback for framework failures outside the app wrapper. */
export function build123dFallbackToolErrorText(): string {
  return `${UNEXPECTED_FAILURE.message} Recovery: ${UNEXPECTED_FAILURE.recovery}`;
}

/** Emit raw diagnostic detail only to the server's stderr logger. */
export function logBuild123dToolFailure(tool: string, error: unknown): void {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  console.error(`[mcp-build123d] ${tool} internal failure: ${detail}`);
}

function resultFor(
  tool: string,
  mapped: PublicToolFailure,
): Build123dToolErrorResult {
  const structuredContent: Build123dToolErrorPayload = {
    schemaVersion: BUILD123D_TOOL_ERROR_SCHEMA,
    kind: "error",
    tool,
    ...mapped,
  };
  return {
    content: [{
      type: "text",
      text: `${mapped.message} Recovery: ${mapped.recovery}`,
    }],
    isError: true,
    structuredContent,
  };
}

function classify(error: unknown): PublicToolFailure {
  if (error instanceof Build123dArtifactError) {
    return {
      code: error.code,
      ...safeArtifactError(error.code),
      retryable: error.code === "artifact.store_unavailable",
    };
  }
  if (error instanceof AssemblyIntegrityInputError) {
    return {
      code: "assembly_integrity.input_invalid",
      message: "Assembly-integrity input is invalid.",
      recovery:
        "Provide one exact digest-bound padded-base64 model/step input; do not pass a path, code, tolerance, transform, or runtime option.",
      retryable: false,
    };
  }
  if (error instanceof AssemblyIntegrityObservationError) {
    return {
      code: "assembly_integrity.observation_failed",
      message: "Assembly-integrity observation could not complete.",
      recovery:
        "Inspect the exact STEP bytes and the fixed observation method; retry only after either one changes.",
      retryable: false,
    };
  }
  if (error instanceof PythonNotFoundError) {
    return {
      code: "runtime.python_unavailable",
      message: "The configured Python interpreter is unavailable.",
      recovery:
        "Set BUILD123D_PYTHON_BIN to Python 3.10+ with build123d installed, then retry the same request.",
      retryable: true,
    };
  }
  if (error instanceof Build123dUnavailableError) {
    return {
      code: "runtime.build123d_unavailable",
      message: "build123d is unavailable in the configured Python interpreter.",
      recovery:
        "Set BUILD123D_PYTHON_BIN to Python 3.10+ with build123d installed, then retry the same request.",
      retryable: true,
    };
  }
  if (error instanceof CadExecutionError) {
    return {
      code: "cad.execution_failed",
      message: "CAD execution failed before a verified result was produced.",
      recovery:
        "Correct the build123d script or its top-level result value, then execute a new request.",
      retryable: false,
    };
  }
  return UNEXPECTED_FAILURE;
}

function safeArtifactError(
  code: Build123dArtifactError["code"],
): { message: string; recovery: string } {
  switch (code) {
    case "artifact.outside_managed_root":
      return {
        message: "An artifact path is outside server-managed storage.",
        recovery:
          "Use only the artifact URI returned by build123d_export; do not submit or derive host paths.",
      };
    case "artifact.not_regular_file":
      return {
        message: "A managed artifact is not a regular file.",
        recovery:
          "Re-run build123d_export to create a new server-owned immutable resource.",
      };
    case "artifact.store_unavailable":
      return {
        message: "Server-owned artifact storage is unavailable.",
        recovery:
          "Fix server storage configuration or permissions, then retry the request.",
      };
    case "artifact.integrity_failed":
      return {
        message: "Artifact integrity verification failed.",
        recovery:
          "Do not reuse a path or modified object; run build123d_export again to create a new verified resource.",
      };
  }
}
