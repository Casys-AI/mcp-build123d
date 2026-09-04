/// <reference lib="dom" />

import {
  renderStatusMessage,
  startPreactSurfaceApp,
} from "@casys/mcp-view-components/preact";
import { BUILD123D_MCP_APP_INFO } from "../../view-app-manifest.ts";
import { geometrySurfaceOverride } from "./component-model.ts";
import { BUILD123D_COMPONENT_REGISTRY } from "./components.tsx";
import {
  geometryStateFromToolResult,
  geometryStateFromViewerSession,
} from "./projection.ts";
import { createMcpAppHostResourceBridge } from "./resource-bridge.ts";

/** The status class every build123d message carries, in and out of the App. */
const BUILD123D_STATUS_CLASS = "build123d-viewer-state";

const root = document.getElementById("root");
if (!root) throw new Error("results viewer root is missing");

// The bridge exists before the App connects: a recorded session replayed by
// the handshake reads through it as soon as its datasheet mounts.
const appHostResourceBridge = createMcpAppHostResourceBridge({
  createChannel: () => new MessageChannel(),
  offer(message, port) {
    globalThis.parent.postMessage(message, "*", [port]);
  },
});
const onPageHide = () => appHostResourceBridge.dispose();
globalThis.addEventListener("pagehide", onPageHide, { once: true });

/**
 * The App lifecycle — loading until the first result, one projection per tool
 * result, the host-selected surface remounted when the host context moves,
 * recorded sessions buffered before the transport connects, one live mount
 * at a time — belongs to `startPreactSurfaceApp`. This entry only says what
 * build123d projects, which surface a recorded session owns, and what the
 * App holds outside its surface.
 */
void startPreactSurfaceApp({
  root,
  info: BUILD123D_MCP_APP_INFO,
  registry: BUILD123D_COMPONENT_REGISTRY,
  strict: true,
  surfaceClassName: "build123d-component-surface",
  statusClassName: BUILD123D_STATUS_CLASS,
  loadingLabel: "Receiving a build123d geometry result or recorded session…",
  fromToolResult: geometryStateFromToolResult,
  viewerSession: {
    // Every `viewer.session.apply` payload addresses this whole-view App; the
    // strict parser decides in `toState`, and a rejection is shown, never dropped.
    validate: (_value: unknown): _value is unknown => true,
    toState: (value) =>
      geometryStateFromViewerSession(value, appHostResourceBridge.read),
  },
  // Recorded sessions own their whole-view surface; direct results follow the
  // host selection, with the datasheet as the standalone default.
  surfaceFor: geometrySurfaceOverride,
  onTeardown() {
    globalThis.removeEventListener("pagehide", onPageHide);
    appHostResourceBridge.dispose();
  },
  onError: (error) => {
    console.error("[mcp-build123d] Geometry projection failed", error);
  },
}).catch((error: unknown) => {
  globalThis.removeEventListener("pagehide", onPageHide);
  appHostResourceBridge.dispose();
  root.replaceChildren(renderStatusMessage(
    error instanceof Error
      ? error.message
      : "Could not connect to the MCP Apps host.",
    {
      className: BUILD123D_STATUS_CLASS,
      title: "build123d viewer unavailable",
      tone: "danger",
    },
  ));
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
