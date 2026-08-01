/// <reference lib="dom" />

import { createMcpApp, defineView, installMcpViewTheme } from "@casys/mcp-view";

type ArtifactHelperState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "ready"; name: string; bytes: number }
  | { phase: "error"; message: string };

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("artifact helper viewer root is missing");
const root: HTMLElement = rootElement;
installMcpViewTheme();

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[char] ?? char);
}

function parseArtifactSummary(
  value: unknown,
): { name: string; bytes: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const payload = value as Record<string, unknown>;
  return payload.schemaVersion === "1.0" && payload.kind === "gltf-binary" &&
      typeof payload.name === "string" && typeof payload.bytes === "number" &&
      Number.isSafeInteger(payload.bytes) && payload.bytes >= 12
    ? { name: payload.name, bytes: payload.bytes }
    : undefined;
}

const statusView = defineView<ArtifactHelperState>({
  render(ctx) {
    const state = ctx.state;
    if (state.phase === "ready") {
      return `<main class="mcp-view-state lifecycle-state" data-tone="success" aria-busy="false"><strong>Artefact GLB chargé</strong><div class="mcp-view-state-detail"><code>${
        escapeHtml(state.name)
      }</code> · ${state.bytes.toLocaleString()} octets</div></main>`;
    }
    const copy = state.phase === "loading"
      ? ["Chargement de l’artefact", "Réception du GLB local…"]
      : state.phase === "empty"
      ? [
        "Lecteur interne",
        "Cette ressource est appelée par le viewer géométrique.",
      ]
      : ["Artefact non affichable", state.message];
    return `<main class="mcp-view-state lifecycle-state" aria-busy="${
      state.phase === "loading"
    }" data-tone="${state.phase === "error" ? "danger" : "info"}"><strong>${
      copy[0]
    }</strong><div class="mcp-view-state-detail">${
      escapeHtml(copy[1])
    }</div></main>`;
  },
});

async function boot(): Promise<void> {
  const app = await createMcpApp<ArtifactHelperState>({
    info: { name: "build123d-artifact-helper-viewer", version: "1.0.0" },
    strict: true,
    root,
    views: { status: statusView },
    initialView: "status",
    initialState: { phase: "loading" },
    async onToolInput(_params, handle) {
      root.setAttribute("aria-busy", "true");
      handle.ctx.state = { phase: "loading" };
      await handle.navigate("status");
    },
    async onToolResult(result, handle) {
      if (result.isError) {
        handle.ctx.state = {
          phase: "error",
          message: "Le serveur a refusé l’artefact GLB.",
        };
      } else {
        const summary = parseArtifactSummary(result.structuredContent);
        handle.ctx.state = summary
          ? { phase: "ready", ...summary }
          : { phase: "error", message: "L’enveloppe GLB est invalide." };
      }
      root.setAttribute("aria-busy", "false");
      await handle.navigate("status");
    },
  });
  root.setAttribute("aria-busy", "false");
  if (app.ctx.state.phase === "loading") {
    app.ctx.state = { phase: "empty" };
    await app.navigate("status");
  }
}

boot().catch((error) => {
  root.innerHTML =
    `<main class="mcp-view-state lifecycle-state" data-tone="danger" aria-busy="false"><strong>Viewer indisponible</strong><div class="mcp-view-state-detail">${
      escapeHtml(
        error instanceof Error
          ? error.message
          : "Connexion MCP Apps impossible.",
      )
    }</div></main>`;
  root.setAttribute("aria-busy", "false");
});
