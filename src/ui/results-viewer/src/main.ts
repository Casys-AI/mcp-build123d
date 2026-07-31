/// <reference lib="dom" />

import { createMcpApp, defineView } from "@casys/mcp-view";
import { parseGeometryResult } from "./contract.ts";
import { renderViewer, type ViewerState } from "./render.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("results viewer root is missing");
const root: HTMLElement = rootElement;

const resultView = defineView<ViewerState>({
  render: (ctx) => renderViewer(ctx.state),
});

function mcpErrorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const messages = content.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const block = entry as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return messages.length > 0 ? messages.join("\n") : undefined;
}

async function boot(): Promise<void> {
  const app = await createMcpApp<ViewerState>({
    info: { name: "build123d-results-viewer", version: "1.0.0" },
    root,
    views: { result: resultView },
    initialView: "result",
    initialState: { phase: "loading" },
    async onToolInput(_params, app) {
      root.setAttribute("aria-busy", "true");
      app.ctx.state = { phase: "loading" };
      await app.navigate("result");
    },
    // mcp-view installs this callback before connect(), buffering any result
    // that arrives while the host handshake finishes.
    async onToolResult(params, app) {
      if (params.isError) {
        app.ctx.state = {
          phase: "error",
          message: mcpErrorText(params.content) ??
            "Le calcul build123d a retourné une erreur.",
        };
      } else {
        const parsed = parseGeometryResult(params.structuredContent);
        app.ctx.state = parsed.ok
          ? { phase: "ready", result: parsed.value }
          : { phase: "error", message: parsed.error };
      }
      root.setAttribute("aria-busy", "false");
      await app.navigate("result");
    },
  });
  root.setAttribute("aria-busy", "false");
  if (app.ctx.state.phase === "loading") {
    app.ctx.state = { phase: "empty" };
    await app.navigate("result");
  }
}

boot().catch((error) => {
  root.innerHTML = renderViewer({
    phase: "error",
    message: error instanceof Error
      ? error.message
      : "Connexion au MCP Apps host impossible.",
  });
  root.setAttribute("aria-busy", "false");
});
