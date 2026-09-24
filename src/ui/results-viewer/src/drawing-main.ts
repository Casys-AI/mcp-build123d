/// <reference lib="dom" />

import {
  renderStatusMessage,
  startPreactSurfaceApp,
} from "@casys/mcp-view-components/preact";
import { BUILD123D_MCP_APP_INFO } from "../../view-app-manifest.ts";
import { DRAWING_COMPONENT_REGISTRY } from "./drawing-components.tsx";
import { drawingMessages } from "./drawing-locale.ts";
import { drawingStateFromToolResult } from "./drawing-model.ts";

const root = document.getElementById("root");
if (!root) throw new Error("drawing viewer root is missing");

void startPreactSurfaceApp({
  root,
  info: BUILD123D_MCP_APP_INFO,
  registry: DRAWING_COMPONENT_REGISTRY,
  strict: true,
  themeUpdates: "in-place",
  surfaceClassName: "build123d-drawing-surface",
  statusClassName: "build123d-drawing-state",
  loadingLabel: (locale) => drawingMessages(locale)("receiving"),
  documentLanguage: drawingMessages.locale,
  fromToolResult: drawingStateFromToolResult,
  onError: (error) => {
    console.error("[mcp-build123d] Drawing projection failed", error);
  },
}).catch((error: unknown) => {
  root.replaceChildren(renderStatusMessage(
    error instanceof Error
      ? error.message
      : "Could not connect to the MCP Apps host.",
    {
      className: "build123d-drawing-state",
      title: "build123d drawing viewer unavailable",
      tone: "danger",
    },
  ));
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
