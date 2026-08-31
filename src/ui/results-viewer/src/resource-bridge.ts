/// <reference lib="dom" />

import type {
  Build123dRecordedResourceReader,
  Build123dRecordedResourceResponse,
} from "../../recorded-view-session.ts";

export const MCP_APP_HOST_RESOURCE_READ_SCHEMA =
  "io.casys.mcp-app-host.resource-read/1.0" as const;
export const MCP_APP_HOST_RESOURCE_READ_TYPE =
  "mcp-app-host.resource.read" as const;
export const MCP_APP_HOST_RESOURCE_READ_RESULT_TYPE =
  "mcp-app-host.resource.read.result" as const;
export const MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE =
  "mcp-app-host.resource.port.offer" as const;

const RESOURCE_FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UNAVAILABLE_REASONS = new Set([
  "not-registered",
  "fetch-failed",
  "identity-mismatch",
  "too-large",
]);
const RESOURCE_READ_TIMEOUT_MS = 10_000;
const MAX_PENDING_RESOURCE_READS = 4;
const MAX_VIEWER_RESOURCE_BYTES = 24 * 1024 * 1024;

export interface McpAppHostResourceBridgeTransport {
  createChannel(): Pick<MessageChannel, "port1" | "port2">;
  /** Transfer the App-created host endpoint once; bytes never use WindowProxy. */
  offer(
    message: {
      readonly schemaVersion: typeof MCP_APP_HOST_RESOURCE_READ_SCHEMA;
      readonly type: typeof MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE;
    },
    port: MessagePort,
  ): void;
}

export interface McpAppHostResourceBridge {
  readonly read: Build123dRecordedResourceReader;
  dispose(): void;
}

interface PendingRead {
  readonly fingerprint: `sha256:${string}`;
  readonly resolve: (
    value: Awaited<ReturnType<Build123dRecordedResourceReader>>,
  ) => void;
  readonly timeout: ReturnType<typeof globalThis.setTimeout>;
}

/**
 * Read-only, fingerprint-addressed bridge over one document-scoped MessagePort.
 * The App creates the channel and transfers the host endpoint exactly once.
 * The parent never offers a port through its navigation-stable WindowProxy, so
 * a replacement document cannot inherit this document's bridge. Resource
 * requests and bytes use only the retained App endpoint. The App never selects
 * a URI, MIME type, byte count or host route.
 */
export function createMcpAppHostResourceBridge(
  transport: McpAppHostResourceBridgeTransport,
): McpAppHostResourceBridge {
  const pending = new Map<string, PendingRead>();
  let nextRequest = 1;
  let disposed = false;
  let portFailed = false;
  let port: MessagePort | undefined;
  let onPortMessage: ((event: MessageEvent) => void) | undefined;

  try {
    const channel = transport.createChannel();
    const listener = (message: MessageEvent) => {
      if (disposed || !isRecord(message.data)) return;
      const requestId = message.data.requestId;
      if (typeof requestId !== "string") return;
      const request = pending.get(requestId);
      if (!request) return;
      const parsed = parseResourceReadResult(
        message.data,
        requestId,
        request.fingerprint,
      );
      globalThis.clearTimeout(request.timeout);
      pending.delete(requestId);
      request.resolve(parsed);
    };
    channel.port1.addEventListener("message", listener);
    channel.port1.start();
    port = channel.port1;
    onPortMessage = listener;
    try {
      transport.offer({
        schemaVersion: MCP_APP_HOST_RESOURCE_READ_SCHEMA,
        type: MCP_APP_HOST_RESOURCE_PORT_OFFER_TYPE,
      }, channel.port2);
    } catch (error) {
      channel.port2.close();
      throw error;
    }
  } catch {
    portFailed = true;
    closePort();
  }

  function sendRequest(requestId: string): void {
    const request = pending.get(requestId);
    if (!request || !port) return;
    try {
      port.postMessage({
        schemaVersion: MCP_APP_HOST_RESOURCE_READ_SCHEMA,
        type: MCP_APP_HOST_RESOURCE_READ_TYPE,
        requestId,
        fingerprint: request.fingerprint,
      });
    } catch {
      portFailed = true;
      closePort();
      failPending("Geometry viewer resource port is unavailable");
    }
  }

  function failPending(error: string): void {
    for (const request of pending.values()) {
      globalThis.clearTimeout(request.timeout);
      request.resolve({ ok: false, error });
    }
    pending.clear();
  }

  function closePort(): void {
    if (port && onPortMessage) {
      port.removeEventListener("message", onPortMessage);
    }
    port?.close();
    port = undefined;
    onPortMessage = undefined;
  }

  const read: Build123dRecordedResourceReader = (fingerprint) => {
    if (disposed) {
      return Promise.resolve({
        ok: false,
        error: "Geometry viewer resource bridge is disposed",
      });
    }
    if (!RESOURCE_FINGERPRINT.test(fingerprint)) {
      return Promise.resolve({
        ok: false,
        error: "Geometry viewer resource fingerprint is invalid",
      });
    }
    if (portFailed) {
      return Promise.resolve({
        ok: false,
        error: "Geometry viewer resource port is unavailable",
      });
    }
    if (pending.size >= MAX_PENDING_RESOURCE_READS) {
      return Promise.resolve({
        ok: false,
        error: "Geometry viewer resource bridge has too many pending reads",
      });
    }

    const requestId = `build123d-resource-${nextRequest++}`;
    if (!REQUEST_ID.test(requestId)) {
      return Promise.resolve({
        ok: false,
        error: "Geometry viewer resource request id is invalid",
      });
    }
    return new Promise((resolve) => {
      const timeout = globalThis.setTimeout(() => {
        if (!pending.delete(requestId)) return;
        resolve({
          ok: false,
          error: "Geometry viewer resource bridge timed out",
        });
      }, RESOURCE_READ_TIMEOUT_MS);
      pending.set(requestId, { fingerprint, resolve, timeout });
      sendRequest(requestId);
    });
  };

  return {
    read,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      closePort();
      failPending("Geometry viewer resource bridge is disposed");
    },
  };
}

function parseResourceReadResult(
  value: Record<string, unknown>,
  requestId: string,
  fingerprint: `sha256:${string}`,
): Awaited<ReturnType<Build123dRecordedResourceReader>> {
  if (
    value.schemaVersion !== MCP_APP_HOST_RESOURCE_READ_SCHEMA ||
    value.type !== MCP_APP_HOST_RESOURCE_READ_RESULT_TYPE ||
    value.requestId !== requestId || value.fingerprint !== fingerprint
  ) return invalidResponse();

  if (value.status === "unavailable") {
    if (
      !hasExactKeys(value, [
        "schemaVersion",
        "type",
        "requestId",
        "fingerprint",
        "status",
        "reason",
      ]) || !UNAVAILABLE_REASONS.has(value.reason as string)
    ) return invalidResponse();
    return {
      ok: false,
      error: `Geometry viewer resource is unavailable: ${value.reason}`,
    };
  }

  if (
    value.status !== "available" ||
    !hasExactKeys(value, [
      "schemaVersion",
      "type",
      "requestId",
      "fingerprint",
      "status",
      "resource",
    ]) ||
    !isExactRecord(value.resource, [
      "uri",
      "mimeType",
      "bytes",
      "fingerprint",
      "encoding",
      "data",
    ]) ||
    value.resource.fingerprint !== fingerprint ||
    typeof value.resource.uri !== "string" ||
    value.resource.uri.length > 2_048 ||
    typeof value.resource.mimeType !== "string" ||
    value.resource.mimeType.length > 128 ||
    !Number.isSafeInteger(value.resource.bytes) ||
    (value.resource.bytes as number) < 0 ||
    (value.resource.bytes as number) > MAX_VIEWER_RESOURCE_BYTES ||
    value.resource.encoding !== "base64" ||
    typeof value.resource.data !== "string" ||
    value.resource.data.length !==
      4 * Math.ceil((value.resource.bytes as number) / 3)
  ) return invalidResponse();

  return {
    ok: true,
    resource: Object.freeze({
      uri: value.resource.uri,
      mimeType: value.resource.mimeType,
      bytes: value.resource.bytes,
      fingerprint: value.resource.fingerprint,
      encoding: value.resource.encoding,
      data: value.resource.data,
    }) as Build123dRecordedResourceResponse,
  };
}

function invalidResponse(): {
  readonly ok: false;
  readonly error: string;
} {
  return {
    ok: false,
    error: "Geometry viewer resource bridge response is invalid",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
