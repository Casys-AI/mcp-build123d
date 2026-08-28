/** Bounded subprocess I/O primitives for provider-owned child processes. */

export type ProcessOutputStream = "stdout" | "stderr";

/** A child emitted more data than the server's fixed protocol budget permits. */
export class ProcessOutputLimitError extends Error {
  constructor(
    readonly stream: ProcessOutputStream,
    readonly maximumBytes: number,
  ) {
    super(`${stream} exceeded the fixed ${maximumBytes}-byte process budget.`);
    this.name = "ProcessOutputLimitError";
  }
}

export interface BoundedChildOutput {
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly success: boolean;
  readonly code: number;
}

export interface BoundedChildOutputOptions {
  readonly maximumStdoutBytes: number;
  readonly maximumStderrBytes: number;
  /** Called synchronously once a fixed output budget is exceeded. */
  readonly terminate: () => void;
}

function combine(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  kind: ProcessOutputStream,
  maximumBytes: number,
  terminate: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return combine(chunks, total);
      if (!value) continue;
      if (value.byteLength > maximumBytes - total) {
        const error = new ProcessOutputLimitError(kind, maximumBytes);
        terminate();
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }
      const copy = value.slice();
      chunks.push(copy);
      total += copy.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Drain stdout and stderr concurrently with strict byte ceilings. This never
 * delegates buffering to `ChildProcess.output()`, whose convenience API has no
 * caller-provided output limit.
 */
export async function collectBoundedChildOutput(
  child: Deno.ChildProcess,
  options: BoundedChildOutputOptions,
): Promise<BoundedChildOutput> {
  const stdout = readBounded(
    child.stdout,
    "stdout",
    options.maximumStdoutBytes,
    options.terminate,
  );
  const stderr = readBounded(
    child.stderr,
    "stderr",
    options.maximumStderrBytes,
    options.terminate,
  );
  const [stdoutResult, stderrResult, statusResult] = await Promise.allSettled([
    stdout,
    stderr,
    child.status,
  ]);

  if (stdoutResult.status === "rejected") throw stdoutResult.reason;
  if (stderrResult.status === "rejected") throw stderrResult.reason;
  if (statusResult.status === "rejected") throw statusResult.reason;
  return {
    stdout: stdoutResult.value,
    stderr: stderrResult.value,
    success: statusResult.value.success,
    code: statusResult.value.code,
  };
}
