/// <reference lib="dom" />

import {
  componentCatalogCapabilities,
  createMcpApp,
  defineView,
  mountComponentSurface,
  readSurfaceContext,
} from "@casys/mcp-view";
import type { AppHandle, MountedComponentSurface } from "@casys/mcp-view";
import {
  BUILD123D_COMPONENT_REGISTRY,
  type GeometryComponentAppContext,
} from "./components.ts";
import type { GeometryComponentData } from "./component-model.ts";
import { parseGeometryResult } from "./contract.ts";
import { renderViewer, type ViewerState } from "./render.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("results viewer root is missing");
const root: HTMLElement = rootElement;

const statusView = defineView<ViewerState>({
  render: (ctx) => renderViewer(ctx.state),
});

let mountedSurface: MountedComponentSurface | undefined;
let currentData: GeometryComponentData | undefined;
let surfaceSignature: string | undefined;
let renderSequence = 0;
let disposed = false;
let removeHostContextListener: (() => void) | undefined;

async function disposeSurface(): Promise<void> {
  const mounted = mountedSurface;
  mountedSurface = undefined;
  await mounted?.dispose();
}

function selectedSurfaceSignature(
  handle: AppHandle<ViewerState>,
): string {
  const context = readSurfaceContext(handle.ctx.hostContext);
  return JSON.stringify(
    context?.status === "ready" && context.surface
      ? context.surface
      : BUILD123D_COMPONENT_REGISTRY.defaultSurface,
  );
}

async function mountGeometrySurface(
  handle: AppHandle<ViewerState>,
  data: GeometryComponentData,
): Promise<void> {
  const sequence = ++renderSequence;
  await disposeSurface();
  if (disposed || sequence !== renderSequence) return;
  root.setAttribute("aria-busy", "true");
  const mounted = await mountComponentSurface({
    root,
    registry: BUILD123D_COMPONENT_REGISTRY,
    data,
    appContext: handle.ctx as GeometryComponentAppContext,
    hostContext: handle.ctx.hostContext,
  });
  if (disposed || sequence !== renderSequence) {
    await mounted.dispose();
    return;
  }
  mountedSurface = mounted;
  surfaceSignature = selectedSurfaceSignature(handle);
  root.setAttribute("aria-busy", "false");
}

async function showState(
  handle: AppHandle<ViewerState>,
  state: ViewerState,
): Promise<void> {
  renderSequence += 1;
  currentData = undefined;
  surfaceSignature = undefined;
  await disposeSurface();
  if (disposed) return;
  handle.ctx.state = state;
  root.setAttribute("aria-busy", String(state.phase === "loading"));
  await handle.navigate("status");
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
    capabilities: {
      experimental: componentCatalogCapabilities(
        BUILD123D_COMPONENT_REGISTRY,
      ),
    },
    strict: true,
    root,
    views: { status: statusView },
    initialView: "status",
    initialState: { phase: "loading" },
    async onToolInput(_params, handle) {
      if (disposed) return;
      await showState(handle, { phase: "loading" });
    },
    async onToolResult(params, handle) {
      if (disposed) return;
      if (params.isError) {
        await showState(handle, {
          phase: "error",
          message: mcpErrorText(params.content) ??
            "Le calcul build123d a retourné une erreur.",
        });
        return;
      }
      const parsed = parseGeometryResult(params.structuredContent);
      if (!parsed.ok) {
        await showState(handle, { phase: "error", message: parsed.error });
        return;
      }
      currentData = { result: parsed.value };
      await mountGeometrySurface(handle, currentData);
    },
    async onTeardown() {
      disposed = true;
      renderSequence += 1;
      currentData = undefined;
      removeHostContextListener?.();
      removeHostContextListener = undefined;
      await disposeSurface();
    },
  });
  if (disposed) return;

  const onHostContextChanged = () => {
    if (!currentData || disposed) return;
    const nextSignature = selectedSurfaceSignature(app);
    if (nextSignature === surfaceSignature) return;
    void mountGeometrySurface(app, currentData).catch(async (error) => {
      if (disposed) return;
      await showState(app, {
        phase: "error",
        message: error instanceof Error
          ? error.message
          : "La surface de composants n’a pas pu être montée.",
      });
    });
  };
  app.ctx.app.addEventListener("hostcontextchanged", onHostContextChanged);
  removeHostContextListener = () =>
    app.ctx.app.removeEventListener("hostcontextchanged", onHostContextChanged);

  root.setAttribute("aria-busy", "false");
  if (app.ctx.state.phase === "loading" && !currentData) {
    app.ctx.state = { phase: "empty" };
    await app.navigate("status");
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
