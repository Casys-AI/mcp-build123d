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

/** Raised when the Python interpreter cannot be found. */
export class PythonNotFoundError extends Error {
  constructor(interpreter: string) {
    super(
      `Python interpreter '${interpreter}' was not found on PATH. ` +
        `Install Python 3.10+ and build123d (pip install build123d), ` +
        `or point CAD_PYTHON_BIN at the right interpreter.`,
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

export interface ExportSpec {
  format: "step" | "stl" | "gltf";
  path: string;
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
  exports: Array<{ format: string; path: string; bytes: number }>;
}

interface HarnessResponse {
  ok: boolean;
  metrics?: CadMetrics;
  exports?: Array<{ format: string; path: string; bytes: number }>;
  error?: string;
  traceback?: string | null;
}

const HARNESS_PATH = new URL("./harness.py", import.meta.url).pathname;

/** Python interpreter — override with CAD_PYTHON_BIN. */
function pythonBin(): string {
  return Deno.env.get("CAD_PYTHON_BIN") ?? "python3";
}

/**
 * Run a build123d script through the harness.
 *
 * @throws PythonNotFoundError when the interpreter is missing
 * @throws CadExecutionError on any harness-reported failure — script errors,
 *         missing `result` variable, export failures, missing build123d
 */
export async function runCadScript(
  script: string,
  options?: { densityKgM3?: number; exports?: ExportSpec[]; timeoutMs?: number },
): Promise<HarnessResult> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const interpreter = pythonBin();

  let child;
  try {
    child = new Deno.Command(interpreter, {
      args: [HARNESS_PATH],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) throw new PythonNotFoundError(interpreter);
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

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);

  const { stdout, stderr, success } = await child.output();
  clearTimeout(timer);

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
    throw new CadExecutionError(
      response.error ?? "Unknown harness failure",
      response.traceback ?? undefined,
    );
  }

  if (!response.metrics) {
    throw new CadExecutionError("The harness reported ok without metrics.");
  }

  return { metrics: response.metrics, exports: response.exports ?? [] };
}
