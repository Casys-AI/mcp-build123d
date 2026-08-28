/** Fixed runtime qualification for the published Build123d provider. */

import { collectBoundedChildOutput } from "./process.ts";

export const QUALIFIED_BUILD123D_VERSION = "0.11.1" as const;
export const QUALIFIED_CADQUERY_OCP_VERSION = "7.9.3.1" as const;

const RUNTIME_PROBE_MAXIMUM_STDOUT_BYTES = 4 * 1_024;
const RUNTIME_PROBE_MAXIMUM_STDERR_BYTES = 4 * 1_024;
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;

const RUNTIME_PROBE_SOURCE = String.raw`
import json
import sys

try:
    import build123d
    import OCP
except Exception:
    print(json.dumps({"ok": False}))
    sys.exit(0)

print(json.dumps({
    "ok": True,
    "build123d": getattr(build123d, "__version__", None),
    "cadqueryOcp": getattr(OCP, "__version__", None),
}, sort_keys=True, separators=(",", ":")))
`;

export class Build123dRuntimeQualificationError extends Error {
  constructor() {
    super(
      "The configured Python runtime is not the qualified Build123d/OCP pair.",
    );
    this.name = "Build123dRuntimeQualificationError";
  }
}

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

function isQualifiedResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  return response.ok === true &&
    response.build123d === QUALIFIED_BUILD123D_VERSION &&
    response.cadqueryOcp === QUALIFIED_CADQUERY_OCP_VERSION;
}

/**
 * Refuse startup unless the provider owns the exact tested Build123d/OCP pair.
 * This is a provider-runtime qualification, not an attestation of isolation,
 * network policy, admission, or Digital Thread canonical geometry.
 */
export async function assertQualifiedBuild123dRuntime(): Promise<void> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(pythonBin(), {
      args: ["-I", "-B", "-c", RUNTIME_PROBE_SOURCE],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    throw new Build123dRuntimeQualificationError();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The fixed probe can naturally exit at the deadline boundary.
    }
  }, RUNTIME_PROBE_TIMEOUT_MS);
  try {
    const result = await collectBoundedChildOutput(child, {
      maximumStdoutBytes: RUNTIME_PROBE_MAXIMUM_STDOUT_BYTES,
      maximumStderrBytes: RUNTIME_PROBE_MAXIMUM_STDERR_BYTES,
      terminate: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The fixed probe can naturally exit at the byte-limit boundary.
        }
      },
    });
    // The qualified CAD import can emit a non-protocol diagnostic from an
    // optional Python dependency (for example font discovery). The exact,
    // bounded JSON probe on stdout and successful process status are the
    // qualification contract; stderr is deliberately bounded but not identity.
    if (timedOut || !result.success) {
      throw new Build123dRuntimeQualificationError();
    }
    let response: unknown;
    try {
      response = JSON.parse(new TextDecoder().decode(result.stdout));
    } catch {
      throw new Build123dRuntimeQualificationError();
    }
    if (!isQualifiedResponse(response)) {
      throw new Build123dRuntimeQualificationError();
    }
  } catch (error) {
    if (error instanceof Build123dRuntimeQualificationError) throw error;
    throw new Build123dRuntimeQualificationError();
  } finally {
    clearTimeout(timer);
  }
}
