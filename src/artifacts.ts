/**
 * Digest-bound export artifacts exposed through MCP resources.
 *
 * Delivery files under BUILD123D_EXPORT_DIR are mutable and never become MCP
 * read surfaces. A successful export is copied into server-owned storage and
 * issued as a resource only by the running server instance. The store never
 * scans or restores filesystem objects: a digest-shaped file or receipt left
 * on disk is deliberately invisible after restart.
 */

import type { McpApp, MCPResource, ResourceHandler } from "@casys/mcp-server";
import { isAbsolute, relative, resolve } from "@std/path";
import type {
  CadExportFile,
  CadMetrics,
  ExportSpec,
} from "./api/python-bridge.ts";
import {
  collectBoundedChildOutput,
  ProcessOutputLimitError,
} from "./api/process.ts";
import { MCP_BUILD123D_VERSION } from "./version.ts";

export const BUILD123D_ARTIFACT_SCHEMA =
  "build123d-export-artifact/1.0" as const;
export const BUILD123D_ARTIFACT_URI_PREFIX =
  "casys://build123d/artifacts/" as const;
export const BUILD123D_EXPORT_EXECUTION_SCHEMA =
  "build123d-export-execution/1.0" as const;

const BUILD123D_EXPORT_REQUEST_SCHEMA = "build123d-export-request/1.0" as const;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DELIVERY_READ_TIMEOUT_MS = 5_000;
/** Maximum bytes for one promotable delivery artifact. */
export const BUILD123D_MAXIMUM_ARTIFACT_BYTES = 32 * 1_024 * 1_024;
/** Fixed current-process memory ceiling for all issued artifact resources. */
export const BUILD123D_MAXIMUM_ARTIFACT_STORE_BYTES = 96 * 1_024 * 1_024;
const DELIVERY_READER_MAXIMUM_STDERR_BYTES = 64 * 1_024;
const DELIVERY_FILE_READER_SOURCE = String.raw`
import os, stat, sys

root, child = sys.argv[1:3]
if (
    not child
    or os.path.isabs(child)
    or (os.altsep and os.altsep in child)
    or any(part in ("", ".", "..") for part in child.split(os.sep))
):
    raise RuntimeError("invalid managed delivery relative path")
if (
    not all(hasattr(os, flag) for flag in ("O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK"))
    or os.open not in os.supports_dir_fd
):
    raise RuntimeError("secure delivery file opening is unsupported")

directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
file_flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
directory_fd = os.open(root, directory_flags)
try:
    for part in child.split(os.sep)[:-1]:
        next_directory_fd = os.open(part, directory_flags, dir_fd=directory_fd)
        os.close(directory_fd)
        directory_fd = next_directory_fd
    file_fd = os.open(child.split(os.sep)[-1], file_flags, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(file_fd).st_mode):
            raise RuntimeError("managed delivery object is not regular")
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            sys.stdout.buffer.write(chunk)
    finally:
        os.close(file_fd)
finally:
    os.close(directory_fd)
`;

export type Build123dArtifactFormat = ExportSpec["format"];

interface ArtifactFormatMetadata {
  readonly extension: "step" | "stl" | "glb";
  readonly mimeType: "model/step" | "model/stl" | "model/gltf-binary";
  readonly title: string;
}

type ArtifactMimeType = ArtifactFormatMetadata["mimeType"];

const FORMAT_METADATA: Readonly<
  Record<Build123dArtifactFormat, ArtifactFormatMetadata>
> = Object.freeze({
  step: { extension: "step", mimeType: "model/step", title: "STEP" },
  stl: { extension: "stl", mimeType: "model/stl", title: "STL" },
  gltf: {
    extension: "glb",
    mimeType: "model/gltf-binary",
    title: "GLB",
  },
});

export interface Build123dArtifactReference {
  readonly schemaVersion: typeof BUILD123D_ARTIFACT_SCHEMA;
  readonly uri: string;
  readonly format: Build123dArtifactFormat;
  readonly mimeType: ArtifactMimeType;
  readonly bytes: number;
  readonly sha256: string;
}

/** One output identity returned by a successful build123d export execution. */
export interface Build123dExportOutput {
  readonly format: Build123dArtifactFormat;
  readonly mimeType: ArtifactMimeType;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * In-memory receipt passed from build123d_export after the Python bridge
 * succeeds. It stores digests, never submitted source text. `not-admitted` is
 * literal: this is direct execution evidence, not Digital Thread authority.
 */
export interface Build123dExportExecution {
  readonly schemaVersion: typeof BUILD123D_EXPORT_EXECUTION_SCHEMA;
  readonly source: {
    readonly kind: "build123d-python-script";
    readonly sha256: string;
  };
  readonly admission: {
    readonly status: "not-admitted";
    readonly authority: "standalone-direct-execution";
  };
  readonly execution: {
    readonly tool: "build123d_export";
    readonly serverVersion: string;
    readonly requestSha256: string;
    readonly metricsSha256: string;
    readonly exportSetSha256: string;
  };
  readonly outputs: readonly Build123dExportOutput[];
}

export interface CreateBuild123dExportExecutionInput {
  readonly script: string;
  readonly formats: readonly Build123dArtifactFormat[];
  readonly name: string;
  readonly densityKgM3?: number;
  readonly timeoutMs?: number;
  readonly metrics: CadMetrics;
  readonly exports: readonly Pick<
    CadExportFile,
    "format" | "bytes" | "sha256"
  >[];
}

export interface PublishedCadExportFile {
  readonly format: ExportSpec["format"];
  readonly artifact: Build123dArtifactReference;
}

interface ArtifactDescriptor extends Build123dArtifactReference {
  readonly fileName: string;
}

/** Internal seam for a deterministic post-stat hostile-mount regression. */
type BeforeDeliveryRead = (path: string) => Promise<void>;

/** A named artifact cannot be promoted or re-read with its stated digest. */
export class Build123dArtifactError extends Error {
  constructor(
    readonly code:
      | "artifact.integrity_failed"
      | "artifact.not_regular_file"
      | "artifact.outside_managed_root"
      | "artifact.store_unavailable"
      | "artifact.too_large"
      | "artifact.store_capacity_exceeded",
    message: string,
    readonly recovery: string,
  ) {
    super(message);
    this.name = "Build123dArtifactError";
  }
}

function exportDirectory(): string {
  return Deno.env.get("BUILD123D_EXPORT_DIR") ?? `${Deno.cwd()}/cad-exports`;
}

function pythonBin(): string {
  return Deno.env.get("BUILD123D_PYTHON_BIN") ?? "python3";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactFormat(value: unknown): value is Build123dArtifactFormat {
  return value === "step" || value === "stl" || value === "gltf";
}

function metadataFor(format: Build123dArtifactFormat): ArtifactFormatMetadata {
  if (!isArtifactFormat(format)) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Artifact format is invalid.",
      "Re-run build123d_export with one supported format.",
    );
  }
  return FORMAT_METADATA[format];
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return crypto.subtle.digest("SHA-256", copy).then((digest) =>
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}

async function readDeliveryFileWithinDeadline(
  root: string,
  relativePath: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(pythonBin(), {
      args: [
        "-c",
        DELIVERY_FILE_READER_SOURCE,
        root,
        relativePath,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  } catch {
    throw new Error("The isolated delivery reader could not start.");
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The reader can exit naturally at the deadline boundary.
    }
  }, DELIVERY_READ_TIMEOUT_MS);
  try {
    const result = await collectBoundedChildOutput(child, {
      maximumStdoutBytes: maximumBytes,
      maximumStderrBytes: DELIVERY_READER_MAXIMUM_STDERR_BYTES,
      terminate: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The fixed reader can naturally exit at the byte-limit boundary.
        }
      },
    });
    if (timedOut) {
      throw new Error("The isolated delivery reader exceeded its deadline.");
    }
    if (!result.success) {
      throw new Error("The isolated delivery reader did not complete.");
    }
    return result.stdout;
  } finally {
    clearTimeout(timer);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        "Artifact execution identity contains a non-finite number.",
        "Re-run build123d_export with finite geometry metrics and request values.",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${
      Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      ).join(",")
    }}`;
  }
  throw new Build123dArtifactError(
    "artifact.integrity_failed",
    "Artifact execution identity contains an unsupported value.",
    "Re-run build123d_export with the documented request contract.",
  );
}

function sha256Canonical(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

function assertContained(root: string, candidate: string, label: string): void {
  const child = relative(root, candidate);
  if (
    child === "" || child === ".." || child.startsWith("../") ||
    child.startsWith("..\\") || isAbsolute(child)
  ) {
    throw new Build123dArtifactError(
      "artifact.outside_managed_root",
      `${label} escapes its managed directory.`,
      "Use only the artifact URI returned by build123d_export; do not derive filesystem paths.",
    );
  }
}

function descriptorFor(
  format: Build123dArtifactFormat,
  bytes: number,
  sha256: string,
): ArtifactDescriptor {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA256_HEX.test(sha256)) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Artifact identity is invalid.",
      "Re-run build123d_export to create a new verified artifact.",
    );
  }
  const metadata = metadataFor(format);
  const fileName = `${sha256}.${metadata.extension}`;
  return {
    schemaVersion: BUILD123D_ARTIFACT_SCHEMA,
    uri: `${BUILD123D_ARTIFACT_URI_PREFIX}${fileName}`,
    format,
    mimeType: metadata.mimeType,
    bytes,
    sha256,
    fileName,
  };
}

function publicReference(
  descriptor: ArtifactDescriptor,
): Build123dArtifactReference {
  const { fileName: _fileName, ...reference } = descriptor;
  return reference;
}

function outputFor(
  format: Build123dArtifactFormat,
  bytes: number,
  sha256: string,
): Build123dExportOutput {
  const descriptor = descriptorFor(format, bytes, sha256);
  return {
    format: descriptor.format,
    mimeType: descriptor.mimeType,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
  };
}

function outputSort(
  left: Build123dExportOutput,
  right: Build123dExportOutput,
): number {
  return left.format.localeCompare(right.format) ||
    left.sha256.localeCompare(right.sha256) ||
    left.bytes - right.bytes;
}

function sortedOutputs(
  outputs: readonly Build123dExportOutput[],
): Build123dExportOutput[] {
  return [...outputs].sort(outputSort);
}

function sameDescriptor(
  left: ArtifactDescriptor,
  right: ArtifactDescriptor,
): boolean {
  return left.uri === right.uri && left.format === right.format &&
    left.mimeType === right.mimeType && left.bytes === right.bytes &&
    left.sha256 === right.sha256;
}

function duplicateFormat(outputs: readonly Build123dExportOutput[]): boolean {
  return new Set(outputs.map((output) => output.format)).size !==
    outputs.length;
}

function assertRequestedOutputs(
  formats: readonly Build123dArtifactFormat[],
  outputs: readonly Build123dExportOutput[],
): void {
  if (
    formats.length === 0 ||
    formats.some((format) => !isArtifactFormat(format)) ||
    new Set(formats).size !== formats.length ||
    outputs.length !== formats.length || duplicateFormat(outputs) ||
    canonicalJson([...formats].sort()) !==
      canonicalJson(outputs.map((output) => output.format).sort())
  ) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Successful export output identity does not match the requested formats.",
      "Re-run build123d_export; do not promote a partial or substituted delivery set.",
    );
  }
}

/**
 * Create the in-memory receipt only after the Python bridge returned successful
 * exports. It carries exact hashes of source, request, metrics and output set.
 */
export async function createBuild123dExportExecution(
  input: CreateBuild123dExportExecutionInput,
): Promise<Build123dExportExecution> {
  if (typeof input.script !== "string" || input.script.length === 0) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Export source identity is invalid.",
      "Run build123d_export with a non-empty script.",
    );
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Export request identity is invalid.",
      "Run build123d_export with a non-empty export name.",
    );
  }
  if (
    input.densityKgM3 !== undefined &&
    (!Number.isFinite(input.densityKgM3) || input.densityKgM3 <= 0)
  ) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Export request density identity is invalid.",
      "Run build123d_export with a positive finite density when mass is needed.",
    );
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
  ) {
    throw new Build123dArtifactError(
      "artifact.integrity_failed",
      "Export request timeout identity is invalid.",
      "Run build123d_export with a positive integer timeout.",
    );
  }
  const formats = [...input.formats];
  const outputs = sortedOutputs(
    input.exports.map((file) =>
      outputFor(file.format, file.bytes, file.sha256)
    ),
  );
  assertRequestedOutputs(formats, outputs);

  const sourceSha256 = await sha256Hex(new TextEncoder().encode(input.script));
  const requestSha256 = await sha256Canonical({
    schemaVersion: BUILD123D_EXPORT_REQUEST_SCHEMA,
    sourceSha256,
    formats,
    name: input.name,
    densityKgM3: input.densityKgM3 ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });
  return {
    schemaVersion: BUILD123D_EXPORT_EXECUTION_SCHEMA,
    source: { kind: "build123d-python-script", sha256: sourceSha256 },
    admission: {
      status: "not-admitted",
      authority: "standalone-direct-execution",
    },
    execution: {
      tool: "build123d_export",
      serverVersion: MCP_BUILD123D_VERSION,
      requestSha256,
      metricsSha256: await sha256Canonical(input.metrics),
      exportSetSha256: await sha256Canonical(outputs),
    },
    outputs,
  };
}

async function assertExecutionReceipt(
  value: Build123dExportExecution,
): Promise<Build123dExportExecution> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== BUILD123D_EXPORT_EXECUTION_SCHEMA
  ) {
    throw invalidReceipt();
  }
  const source = value.source;
  const admission = value.admission;
  const execution = value.execution;
  if (
    !isRecord(source) || source.kind !== "build123d-python-script" ||
    typeof source.sha256 !== "string" || !SHA256_HEX.test(source.sha256) ||
    !isRecord(admission) || admission.status !== "not-admitted" ||
    admission.authority !== "standalone-direct-execution" ||
    !isRecord(execution) || execution.tool !== "build123d_export" ||
    typeof execution.serverVersion !== "string" ||
    execution.serverVersion.length === 0 ||
    execution.serverVersion.length > 128 ||
    typeof execution.requestSha256 !== "string" ||
    !SHA256_HEX.test(execution.requestSha256) ||
    typeof execution.metricsSha256 !== "string" ||
    !SHA256_HEX.test(execution.metricsSha256) ||
    typeof execution.exportSetSha256 !== "string" ||
    !SHA256_HEX.test(execution.exportSetSha256) ||
    !Array.isArray(value.outputs) || value.outputs.length === 0
  ) {
    throw invalidReceipt();
  }
  const outputs = value.outputs.map((output) => {
    if (
      !isRecord(output) || !isArtifactFormat(output.format) ||
      typeof output.bytes !== "number" || typeof output.sha256 !== "string" ||
      typeof output.mimeType !== "string"
    ) {
      throw invalidReceipt();
    }
    const normalized = outputFor(output.format, output.bytes, output.sha256);
    if (output.mimeType !== normalized.mimeType) throw invalidReceipt();
    return normalized;
  });
  if (
    duplicateFormat(outputs) ||
    canonicalJson(outputs) !== canonicalJson(sortedOutputs(outputs)) ||
    await sha256Canonical(outputs) !== execution.exportSetSha256
  ) {
    throw invalidReceipt();
  }
  return {
    schemaVersion: BUILD123D_EXPORT_EXECUTION_SCHEMA,
    source: { kind: "build123d-python-script", sha256: source.sha256 },
    admission: {
      status: "not-admitted",
      authority: "standalone-direct-execution",
    },
    execution: {
      tool: "build123d_export",
      serverVersion: execution.serverVersion,
      requestSha256: execution.requestSha256,
      metricsSha256: execution.metricsSha256,
      exportSetSha256: execution.exportSetSha256,
    },
    outputs,
  };
}

function invalidReceipt(): Build123dArtifactError {
  return new Build123dArtifactError(
    "artifact.integrity_failed",
    "Export execution receipt is invalid.",
    "Re-run build123d_export; only a current successful export can issue an artifact resource.",
  );
}

/**
 * Server-owned resource registry for the current process only.
 *
 * Re-reading checks SHA-256 before returning bytes. `restore()` intentionally
 * registers nothing, because the arbitrary Python runner is not isolated from
 * host filesystem state and persisted filenames/receipts cannot prove issuance.
 */
export class Build123dArtifactStore {
  readonly #descriptors = new Map<string, ArtifactDescriptor>();
  readonly #receipts = new Map<string, Build123dExportExecution>();
  readonly #objects = new Map<string, Uint8Array>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: McpApp,
    // Kept as a constructor slot for embedders that supplied an artifact
    // directory before resources became process-local. It is intentionally not
    // read or written: arbitrary Python is not isolated from host filesystem.
    _artifactDirectory?: string,
    private readonly exportsDirectory: string = exportDirectory(),
    private readonly beforeDeliveryRead?: BeforeDeliveryRead,
  ) {
    void _artifactDirectory;
  }

  /** Deliberately do not re-admit any on-disk object or receipt after restart. */
  async restore(): Promise<void> {
    await Promise.resolve();
  }

  /** Promote verified delivery bytes and issue resources in this process only. */
  async publishExports(
    exports: readonly CadExportFile[],
    execution: Build123dExportExecution,
  ): Promise<PublishedCadExportFile[]> {
    return await this.mutate(async () => {
      const receipt = await assertExecutionReceipt(execution);
      const candidates = await Promise.all(
        exports.map((file) => this.readVerifiedDeliveryExport(file)),
      );
      const descriptors = candidates.map((candidate) =>
        descriptorFor(
          candidate.format,
          candidate.bytes.byteLength,
          candidate.sha256,
        )
      );
      const outputs = sortedOutputs(
        descriptors.map((descriptor) =>
          outputFor(descriptor.format, descriptor.bytes, descriptor.sha256)
        ),
      );
      if (canonicalJson(receipt.outputs) !== canonicalJson(outputs)) {
        throw new Build123dArtifactError(
          "artifact.integrity_failed",
          "Export execution receipt does not match the verified delivery outputs.",
          "Re-run build123d_export; do not promote substituted delivery bytes.",
        );
      }

      const newBytes = descriptors.reduce(
        (total, descriptor, index) =>
          this.#objects.has(descriptor.uri)
            ? total
            : total + candidates[index].bytes.byteLength,
        0,
      );
      const retainedBytes = Array.from(this.#objects.values()).reduce(
        (total, bytes) => total + bytes.byteLength,
        0,
      );
      if (retainedBytes + newBytes > BUILD123D_MAXIMUM_ARTIFACT_STORE_BYTES) {
        throw new Build123dArtifactError(
          "artifact.store_capacity_exceeded",
          "Current-process artifact storage reached its fixed byte budget.",
          "Read or persist already-issued artifacts, then restart the server before requesting additional exports.",
        );
      }

      for (let index = 0; index < descriptors.length; index += 1) {
        const descriptor = descriptors[index];
        const bytes = candidates[index].bytes;
        const existing = this.#objects.get(descriptor.uri);
        if (!existing) continue;
        const existingSha256 = await sha256Hex(existing);
        if (
          existing.byteLength !== descriptor.bytes ||
          existingSha256 !== descriptor.sha256
        ) {
          throw new Build123dArtifactError(
            "artifact.integrity_failed",
            `Artifact URI '${descriptor.uri}' is already associated with different bytes.`,
            "Run build123d_export in a fresh server process to create a new resource.",
          );
        }
        if (bytes.byteLength !== existing.byteLength) {
          throw new Build123dArtifactError(
            "artifact.integrity_failed",
            `Artifact URI '${descriptor.uri}' has an unexpected byte length.`,
            "Run build123d_export in a fresh server process to create a new resource.",
          );
        }
      }
      for (let index = 0; index < descriptors.length; index += 1) {
        const descriptor = descriptors[index];
        if (!this.#objects.has(descriptor.uri)) {
          this.#objects.set(descriptor.uri, candidates[index].bytes.slice());
        }
        this.#receipts.set(descriptor.uri, receipt);
      }
      this.registerDescriptors(descriptors);
      return candidates.map((candidate, index) => ({
        format: candidate.format,
        artifact: publicReference(descriptors[index]),
      }));
    });
  }

  private async readVerifiedDeliveryExport(
    file: CadExportFile,
  ): Promise<
    { format: ExportSpec["format"]; bytes: Uint8Array; sha256: string }
  > {
    if (
      !Number.isSafeInteger(file.bytes) || file.bytes < 1 ||
      file.bytes > BUILD123D_MAXIMUM_ARTIFACT_BYTES
    ) {
      throw new Build123dArtifactError(
        "artifact.too_large",
        `Export '${file.format}' exceeds the fixed artifact byte limit.`,
        "Reduce export complexity or split the delivery; no oversized artifact is read or retained by this server.",
      );
    }
    const root = await this.realManagedRoot(this.exportsDirectory, "export");
    const candidate = isAbsolute(file.path)
      ? file.path
      : resolve(this.exportsDirectory, file.path);
    let realPath: string;
    try {
      realPath = await Deno.realPath(candidate);
    } catch (error) {
      logArtifactFailure("delivery export lookup", error);
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Export '${file.format}' is no longer available for promotion.`,
        "Run build123d_export again; managed delivery output may have been replaced.",
      );
    }
    assertContained(root, realPath, "Export artifact");
    const child = relative(root, realPath);
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(realPath);
    } catch (error) {
      logArtifactFailure("delivery export inspection", error);
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Export '${file.format}' is no longer available for promotion.`,
        "Run build123d_export again; managed delivery output may have been replaced.",
      );
    }
    if (!stat.isFile) {
      throw new Build123dArtifactError(
        "artifact.not_regular_file",
        `Export '${file.format}' is not a regular file.`,
        "Run build123d_export again with a writable managed export directory.",
      );
    }
    if (stat.size > BUILD123D_MAXIMUM_ARTIFACT_BYTES) {
      throw new Build123dArtifactError(
        "artifact.too_large",
        `Export '${file.format}' exceeds the fixed artifact byte limit.`,
        "Reduce export complexity or split the delivery; no oversized artifact is read or retained by this server.",
      );
    }
    if (stat.size !== file.bytes) {
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Export '${file.format}' changed before artifact promotion.`,
        "Run build123d_export again; do not reuse a mutable delivery path as evidence.",
      );
    }
    let bytes: Uint8Array;
    try {
      await this.beforeDeliveryRead?.(realPath);
      bytes = await readDeliveryFileWithinDeadline(
        root,
        child,
        BUILD123D_MAXIMUM_ARTIFACT_BYTES,
      );
    } catch (error) {
      logArtifactFailure("delivery export read", error);
      if (error instanceof ProcessOutputLimitError) {
        throw new Build123dArtifactError(
          "artifact.too_large",
          `Export '${file.format}' exceeds the fixed artifact byte limit.`,
          "Reduce export complexity or split the delivery; no oversized artifact is read or retained by this server.",
        );
      }
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Export '${file.format}' could not be read before promotion completed.`,
        "Run build123d_export again; managed delivery output may have been replaced.",
      );
    }
    const sha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== file.bytes || sha256 !== file.sha256) {
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Export '${file.format}' changed before artifact promotion.`,
        "Run build123d_export again; do not reuse a mutable delivery path as evidence.",
      );
    }
    return { format: file.format, bytes, sha256 };
  }

  private registerDescriptors(
    descriptors: readonly ArtifactDescriptor[],
  ): void {
    for (const descriptor of descriptors) {
      if (!this.#receipts.has(descriptor.uri)) {
        throw new Build123dArtifactError(
          "artifact.integrity_failed",
          `Artifact URI '${descriptor.uri}' was not issued by this server process.`,
          "Run build123d_export in the current server process to create a resource.",
        );
      }
    }
    const unseen = descriptors.filter((descriptor) => {
      const known = this.#descriptors.get(descriptor.uri);
      if (!known) return true;
      if (!sameDescriptor(known, descriptor)) {
        throw new Build123dArtifactError(
          "artifact.integrity_failed",
          `Artifact URI '${descriptor.uri}' is already associated with different bytes.`,
          "Use the returned resource URI; do not construct or reuse conflicting artifact identities.",
        );
      }
      return false;
    });
    if (unseen.length === 0) return;
    for (const descriptor of unseen) {
      if (this.app.hasResource(descriptor.uri)) {
        throw new Build123dArtifactError(
          "artifact.integrity_failed",
          `Artifact URI '${descriptor.uri}' is already registered outside the artifact store.`,
          "Restart the server with a clean artifact registry.",
        );
      }
    }

    const resources: MCPResource[] = unseen.map((descriptor) => ({
      uri: descriptor.uri,
      name: `${metadataFor(descriptor.format).title} artifact ${
        descriptor.sha256.slice(0, 12)
      }`,
      description:
        `Immutable current-process build123d ${descriptor.format} export. ` +
        `Read rehashes the issued in-memory byte copy as sha256:${descriptor.sha256}. ` +
        "It is direct execution evidence, not canonical Digital Thread geometry.",
      mimeType: descriptor.mimeType,
      size: descriptor.bytes,
      annotations: { audience: ["assistant"], priority: 0.8 },
      _meta: {
        "io.casys.mcp-build123d/artifact": {
          schemaVersion: BUILD123D_ARTIFACT_SCHEMA,
          format: descriptor.format,
          sha256: descriptor.sha256,
          immutable: true,
          issuedInCurrentProcess: true,
          admissionStatus: "not-admitted",
        },
      },
    }));
    const handlers = new Map<string, ResourceHandler>(
      unseen.map((descriptor) => [
        descriptor.uri,
        async (requested) => {
          if (requested.toString() !== descriptor.uri) {
            throw new Build123dArtifactError(
              "artifact.integrity_failed",
              "Requested URI does not match its registered artifact identity.",
              "Read exactly the resource URI returned by build123d_export.",
            );
          }
          if (!this.#receipts.has(descriptor.uri)) {
            throw new Build123dArtifactError(
              "artifact.integrity_failed",
              "Artifact resource was not issued by this server process.",
              "Run build123d_export in the current server process to create a resource.",
            );
          }
          const bytes = await this.readVerified(descriptor);
          return {
            uri: descriptor.uri,
            mimeType: descriptor.mimeType,
            blob: bytes.toBase64(),
            _meta: {
              "io.casys.mcp-build123d/artifact": {
                schemaVersion: BUILD123D_ARTIFACT_SCHEMA,
                sha256: descriptor.sha256,
                bytes: descriptor.bytes,
                issuedInCurrentProcess: true,
                admissionStatus: "not-admitted",
              },
            },
          };
        },
      ]),
    );
    this.app.registerResources(resources, handlers);
    for (const descriptor of unseen) {
      this.#descriptors.set(descriptor.uri, descriptor);
    }
  }

  private async realManagedRoot(
    directory: string,
    label: string,
  ): Promise<string> {
    try {
      const root = await Deno.realPath(directory);
      const stat = await Deno.stat(root);
      if (!stat.isDirectory) {
        throw new Build123dArtifactError(
          "artifact.store_unavailable",
          `Managed ${label} directory is not a directory.`,
          "Set BUILD123D_EXPORT_DIR to a directory.",
        );
      }
      return root;
    } catch (error) {
      if (error instanceof Build123dArtifactError) throw error;
      logArtifactFailure(`managed ${label} root resolution`, error);
      throw new Build123dArtifactError(
        "artifact.store_unavailable",
        `Managed ${label} storage is unavailable.`,
        "Set BUILD123D_EXPORT_DIR to an accessible directory.",
      );
    }
  }

  private async readVerified(
    descriptor: ArtifactDescriptor,
  ): Promise<Uint8Array> {
    const issued = this.#objects.get(descriptor.uri);
    if (!issued) {
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Artifact '${descriptor.uri}' is no longer available.`,
        "Run build123d_export in the current server process to create a new verified resource.",
      );
    }
    const bytes = issued.slice();
    const sha256 = await sha256Hex(bytes);
    if (bytes.byteLength !== descriptor.bytes || sha256 !== descriptor.sha256) {
      throw new Build123dArtifactError(
        "artifact.integrity_failed",
        `Artifact '${descriptor.uri}' no longer matches its immutable SHA-256 identity.`,
        "Run build123d_export in the current server process to create a new artifact.",
      );
    }
    return bytes;
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release: (() => void) | undefined;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function logArtifactFailure(context: string, error: unknown): void {
  console.error(
    `[mcp-build123d] ${context}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}
