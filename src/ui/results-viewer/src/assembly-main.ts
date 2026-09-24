/// <reference lib="dom" />

import {
  renderStatusMessage,
  startPreactSurfaceApp,
} from "@casys/mcp-view-components/preact";
import { BUILD123D_MCP_APP_INFO } from "../../view-app-manifest.ts";
import { BUILD123D_ASSEMBLY_COMPONENT_REGISTRY } from "./assembly-components.tsx";
import { assemblyMessages } from "./assembly-locale.ts";
import { assemblyStateFromToolResult } from "./assembly-model.ts";

const root = document.getElementById("root");
if (!root) throw new Error("assembly viewer root is missing");

void startPreactSurfaceApp({
  root,
  info: BUILD123D_MCP_APP_INFO,
  registry: BUILD123D_ASSEMBLY_COMPONENT_REGISTRY,
  strict: true,
  themeUpdates: "in-place",
  surfaceClassName: "build123d-assembly-surface",
  statusClassName: "build123d-viewer-state",
  loadingLabel: (locale) => assemblyMessages(locale)("receiving"),
  documentLanguage: assemblyMessages.locale,
  fromToolResult: assemblyStateFromToolResult,
  onError(error) {
    console.error("[mcp-build123d] Assembly projection failed", error);
  },
}).catch((error: unknown) => {
  root.replaceChildren(renderStatusMessage(
    error instanceof Error
      ? error.message
      : "Could not connect to the MCP Apps host.",
    {
      className: "build123d-viewer-state",
      title: "build123d assembly viewer unavailable",
      tone: "danger",
    },
  ));
  root.setAttribute("aria-busy", "false");
  console.error(error);
});
