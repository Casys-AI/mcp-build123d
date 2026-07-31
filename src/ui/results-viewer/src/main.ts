/// <reference lib="dom" />

import { createMcpApp, defineView } from "@casys/mcp-view";
import { decodeGltfArtifact, parseGeometryResult } from "./contract.ts";
import { renderViewer, type ViewerState } from "./render.ts";
import { type CadSceneController, mountCadScene } from "./scene.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("results viewer root is missing");
const root: HTMLElement = rootElement;

const resultView = defineView<ViewerState>({
  render: (ctx) => renderViewer(ctx.state),
});

let sceneController: CadSceneController | undefined;

function disposeScene(): void {
  sceneController?.dispose();
  sceneController = undefined;
}

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
      disposeScene();
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
        if (!parsed.ok) {
          app.ctx.state = { phase: "error", message: parsed.error };
        } else {
          const result = parsed.value;
          const gltf = result.files.find((file) => file.format === "gltf");
          if (!gltf?.viewer) {
            app.ctx.state = {
              phase: "ready",
              result,
              model: gltf ? { phase: "unavailable" } : undefined,
            };
          } else {
            app.ctx.state = {
              phase: "ready",
              result,
              model: { phase: "loading", name: gltf.viewer.name },
            };
            await app.navigate("result");
            try {
              const artifact = await app.ctx.callTool(gltf.viewer.toolName, {
                name: gltf.viewer.name,
              });
              if (artifact.isError) {
                throw new Error(
                  mcpErrorText(artifact.content) ??
                    "Le serveur a refusé l’artefact GLB.",
                );
              }
              const decoded = decodeGltfArtifact(artifact.structuredContent);
              if (!decoded.ok) throw new Error(decoded.error);
              app.ctx.state = {
                phase: "ready",
                result,
                model: { phase: "ready" },
              };
              await app.navigate("result");
              const viewport = document.getElementById("cad-viewport");
              if (!viewport) throw new Error("Le viewport 3D est introuvable.");
              sceneController = await mountCadScene(viewport, decoded.value);
              const count = document.getElementById("cad-mesh-count");
              if (count) {
                count.textContent = `${sceneController.meshes} maillage${
                  sceneController.meshes === 1 ? "" : "s"
                } · ${sceneController.nodes} nœuds`;
              }
            } catch (error) {
              disposeScene();
              app.ctx.state = {
                phase: "ready",
                result,
                model: {
                  phase: "error",
                  message: error instanceof Error
                    ? error.message
                    : "Le modèle 3D n’a pas pu être chargé.",
                },
              };
              await app.navigate("result");
            }
            root.setAttribute("aria-busy", "false");
            return;
          }
        }
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
