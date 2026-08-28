/**
 * Python bridge — runs the build123d harness as a subprocess
 *
 * Same architectural choice as @casys/constraint-solver's z3 backend: a
 * subprocess speaking JSON over stdin/stdout behaves identically under Deno
 * and Node, needs no WASM, and keeps the Python dependency where it belongs —
 * on the machine, installable with one pip command.
 *
 * @module lib/cad/api/python-bridge
 */

import { HARNESS_SOURCE } from "./harness-source.ts";
import {
  collectBoundedChildOutput,
  ProcessOutputLimitError,
} from "./process.ts";

export const BUILD123D_MAXIMUM_SCRIPT_BYTES = 256 * 1_024;
export const BUILD123D_MAXIMUM_HARNESS_STDOUT_BYTES = 1 * 1_024 * 1_024;
export const BUILD123D_MAXIMUM_HARNESS_STDERR_BYTES = 64 * 1_024;

/** Raised when the Python interpreter cannot be found. */
export class PythonNotFoundError extends Error {
  constructor(interpreter: string) {
    super(
      `Python interpreter '${interpreter}' was not found on PATH. ` +
        `Install Python 3.10+ and build123d (pip install build123d), ` +
        `or point BUILD123D_PYTHON_BIN at the right interpreter.`,
    );
    this.name = "PythonNotFoundError";
  }
}

/** Raised when the harness reports a failure (script error, bad result…). */
export class CadExecutionError extends Error {
  constructor(message: string, readonly pythonTraceback?: string) {
    super(message);
    this.name = "CadExecutionError";
  }
}

/** Raised when the selected interpreter cannot import build123d. */
export class Build123dUnavailableError extends CadExecutionError {
  constructor(message: string, pythonTraceback?: string) {
    super(message, pythonTraceback);
    this.name = "Build123dUnavailableError";
  }
}

/** The caller exceeded a server-owned script or subprocess-output budget. */
export class CadExecutionLimitError extends CadExecutionError {
  constructor(
    readonly limit: "script" | "stdout" | "stderr" | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "CadExecutionLimitError";
  }
}

export interface ExportSpec {
  format: "step" | "stl" | "gltf";
  path: string;
}

/** A file written by the harness as part of an export request. */
export interface CadExportFile {
  format: ExportSpec["format"];
  path: string;
  bytes: number;
  /** SHA-256 of the exact bytes written by this export. */
  sha256: string;
}

export interface CadMetrics {
  volume_mm3: number;
  area_mm2: number;
  center_of_mass_mm: [number, number, number];
  bounding_box_mm: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
  solids: number;
  faces: number;
  edges: number;
  /** Present only when density_kg_m3 was provided. */
  density_kg_m3?: number;
  /** Present only when density_kg_m3 was provided. */
  mass_kg?: number;
}

export interface HarnessResult {
  metrics: CadMetrics;
  exports: CadExportFile[];
}

interface HarnessResponse {
  ok: boolean;
  metrics?: CadMetrics;
  exports?: CadExportFile[];
  error?: string;
  traceback?: string | null;
}

/** Python interpreter — override with BUILD123D_PYTHON_BIN. */
function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

function assertScriptWithinLimit(script: string): void {
  if (
    new TextEncoder().encode(script).byteLength > BUILD123D_MAXIMUM_SCRIPT_BYTES
  ) {
    throw new CadExecutionLimitError(
      "script",
      `CAD script exceeds the fixed ${BUILD123D_MAXIMUM_SCRIPT_BYTES}-byte limit.`,
    );
  }
}

/** Kill the POSIX session created by the trusted Python harness. */
function killExecutionTree(child: Deno.ChildProcess): void {
  try {
    if (Deno.build.os !== "windows") {
      // The harness calls os.setsid() before it accepts caller code, making its
      // PID the process-group ID. A negative PID signals ordinary descendants.
      Deno.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // Bootstrap can exit before setsid(). Fall through to the direct child;
    // no caller code is accepted if the harness cannot establish the session.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process can naturally exit at a timeout or output-limit boundary.
  }
}

/**
 * Run a build123d script through the harness.
 *
 * @throws PythonNotFoundError when the interpreter is missing
 * @throws Build123dUnavailableError when the selected interpreter lacks build123d
 * @throws CadExecutionError on other harness-reported failures — script errors,
 *         missing `result` variable or export failures
 */
export async function runCadScript(
  script: string,
  options?: {
    densityKgM3?: number;
    exports?: ExportSpec[];
    timeoutMs?: number;
  },
): Promise<HarnessResult> {
  assertScriptWithinLimit(script);
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const interpreter = pythonBin();

  let child;
  try {
    child = new Deno.Command(interpreter, {
      // A JSR module's `import.meta.url` is an HTTPS URL, not a local path.
      // The generated TS module carries the harness source in the package
      // graph, so `-c` never needs to know Deno's cache-file location.
      args: ["-I", "-B", "-c", HARNESS_SOURCE],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new PythonNotFoundError(interpreter);
    }
    throw e;
  }

  const request = JSON.stringify({
    script,
    density_kg_m3: options?.densityKgM3 ?? null,
    exports: options?.exports ?? [],
  });
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(request));
  await writer.close();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killExecutionTree(child);
  }, timeoutMs);

  let processResult;
  try {
    processResult = await collectBoundedChildOutput(child, {
      maximumStdoutBytes: BUILD123D_MAXIMUM_HARNESS_STDOUT_BYTES,
      maximumStderrBytes: BUILD123D_MAXIMUM_HARNESS_STDERR_BYTES,
      terminate: () => killExecutionTree(child),
    });
  } catch (error) {
    if (error instanceof ProcessOutputLimitError) {
      throw new CadExecutionLimitError(
        error.stream,
        `CAD execution ${error.stream} exceeded its fixed server budget.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    throw new CadExecutionLimitError(
      "timeout",
      `CAD execution exceeded the ${timeoutMs}ms limit.`,
    );
  }

  const { stdout, stderr, success } = processResult;

  const stdoutText = new TextDecoder().decode(stdout);

  if (!stdoutText.trim()) {
    const stderrText = new TextDecoder().decode(stderr);
    throw new CadExecutionError(
      success
        ? "The harness produced no output."
        : `The harness was killed (timeout ${timeoutMs}ms) or crashed. ` +
          (stderrText ? `stderr: ${stderrText.slice(0, 500)}` : ""),
    );
  }

  let response: HarnessResponse;
  try {
    response = JSON.parse(stdoutText);
  } catch {
    throw new CadExecutionError(
      `The harness printed non-JSON output: ${stdoutText.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    const message = response.error ?? "Unknown harness failure";
    if (
      message.startsWith(
        "build123d is not installed for this Python interpreter.",
      )
    ) {
      throw new Build123dUnavailableError(
        message,
        response.traceback ?? undefined,
      );
    }
    throw new CadExecutionError(message, response.traceback ?? undefined);
  }

  if (!response.metrics) {
    throw new CadExecutionError("The harness reported ok without metrics.");
  }

  return { metrics: response.metrics, exports: response.exports ?? [] };
}
