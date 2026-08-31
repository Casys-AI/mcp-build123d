/// <reference lib="dom" />

import { createMcpApp, defineView } from "@casys/mcp-view";
import type { AppHandle } from "@casys/mcp-view";
import {
  componentCatalogCapabilities,
  installMcpViewTheme,
  mountComponentSurface,
  readSurfaceContext,
} from "@casys/mcp-view-components";
import type { MountedComponentSurface } from "@casys/mcp-view-components";
import {
  type Build123dViewerSession,
  parseBuild123dViewerSession,
} from "../../recorded-view-session.ts";
import { BUILD123D_MCP_APP_INFO } from "../../view-app-manifest.ts";
import { BUILD123D_COMPONENT_REGISTRY } from "./components.tsx";
import {
  BUILD123D_DEFAULT_SURFACE,
  type GeometryComponentData,
  geometrySurfaceOverride,
  isViewerSessionGeometryData,
} from "./component-model.ts";
import { parseGeometryResult } from "./contract.ts";
import { renderViewer, type ViewerState } from "./render.ts";
import {
  commitLatestStagedRender,
  createLatestRenderGate,
} from "./render-generation.ts";
import { createMcpAppHostResourceBridge } from "./resource-bridge.ts";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("results viewer root is missing");
const root: HTMLElement = rootElement;
installMcpViewTheme();

const appHostResourceBridge = createMcpAppHostResourceBridge({
  createChannel: () => new MessageChannel(),
  offer(message, port) {
    globalThis.parent.postMessage(message, "*", [port]);
  },
});
const onPageHide = () => appHostResourceBridge.dispose();
globalThis.addEventListener("pagehide", onPageHide, { once: true });

const statusView = defineView<ViewerState>({
  render: (ctx) => renderViewer(ctx.state),
});

let mountedSurface: MountedComponentSurface | undefined;
let currentData: GeometryComponentData | undefined;
let surfaceSignature: string | undefined;
const renderGate = createLatestRenderGate();
let disposed = false;
let viewerSessionSeen = false;
let viewerSessionActive = false;
let removeHostContextListener: (() => void) | undefined;

function beginRender(): number {
  return renderGate.next();
}

function isCurrentRender(sequence: number): boolean {
  return !disposed && renderGate.isCurrent(sequence);
}

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
      : BUILD123D_DEFAULT_SURFACE,
  );
}

async function mountGeometrySurface(
  handle: AppHandle<ViewerState>,
  data: GeometryComponentData,
  sequence: number,
): Promise<void> {
  const surface = geometrySurfaceOverride(data);
  await disposeSurface();
  if (!isCurrentRender(sequence)) return;
  root.setAttribute("aria-busy", "true");
  await commitLatestStagedRender({
    gate: renderGate,
    generation: sequence,
    createStage: () => document.createElement("div"),
    load: (staging) =>
      mountComponentSurface({
        root: staging,
        registry: BUILD123D_COMPONENT_REGISTRY,
        data,
        appContext: handle.ctx,
        hostContext: handle.ctx.hostContext,
        surface,
      }),
    commit(staging, mounted) {
      const nodes = [...staging.childNodes];
      root.replaceChildren(...nodes);
      mountedSurface = {
        surface: mounted.surface,
        async dispose() {
          try {
            await mounted.dispose();
          } finally {
            for (const node of nodes) {
              if (node.parentNode === root) root.removeChild(node);
            }
          }
        },
      };
      surfaceSignature = surface === undefined
        ? JSON.stringify(mounted.surface)
        : undefined;
      root.setAttribute("aria-busy", "false");
    },
    discard: (_staging, mounted) => mounted.dispose(),
  });
}

async function showState(
  handle: AppHandle<ViewerState>,
  state: ViewerState,
): Promise<void> {
  const sequence = beginRender();
  await showStateForRender(handle, state, sequence);
}

async function showStateForRender(
  handle: AppHandle<ViewerState>,
  state: ViewerState,
  sequence: number,
): Promise<void> {
  if (!isCurrentRender(sequence)) return;
  currentData = undefined;
  surfaceSignature = undefined;
  await disposeSurface();
  if (!isCurrentRender(sequence)) return;
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
  const runtime: { activeApp?: AppHandle<ViewerState> } = {};
  let latestSessionMessage = 0;
  let pendingInvalidSession:
    | {
      readonly messageSequence: number;
      readonly renderSequence: number;
      readonly error: string;
    }
    | undefined;
  const sessionSequences = new WeakMap<
    object,
    { readonly messageSequence: number; readonly renderSequence: number }
  >();

  const app = await createMcpApp<
    ViewerState,
    Build123dViewerSession
  >({
    info: BUILD123D_MCP_APP_INFO,
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
    viewerSession: {
      validate(value): value is Build123dViewerSession {
        viewerSessionSeen = true;
        viewerSessionActive = true;
        const messageSequence = ++latestSessionMessage;
        // Invalidate an older mount immediately, not when the core's
        // serialized callback for this replacement eventually starts.
        const renderSequence = beginRender();
        const parsed = parseBuild123dViewerSession(value);
        if (!parsed.ok) {
          pendingInvalidSession = {
            messageSequence,
            renderSequence,
            error: parsed.error,
          };
          return false;
        }
        sessionSequences.set(value as object, {
          messageSequence,
          renderSequence,
        });
        return true;
      },
      async onSession(session, _payload, handle) {
        const sessionSequence = sessionSequences.get(session as object);
        if (
          !sessionSequence ||
          sessionSequence.messageSequence !== latestSessionMessage ||
          !isCurrentRender(sessionSequence.renderSequence)
        ) return;
        pendingInvalidSession = undefined;
        const sequence = sessionSequence.renderSequence;
        const parsed = parseBuild123dViewerSession(session);
        if (!parsed.ok) {
          await showStateForRender(handle, {
            phase: "error",
            message: parsed.error,
          }, sequence);
          return;
        }
        currentData = {
          source: "viewer-session",
          session: parsed.value,
          readResource: appHostResourceBridge.read,
        };
        try {
          await mountGeometrySurface(handle, currentData, sequence);
        } catch (error) {
          if (!isCurrentRender(sequence)) return;
          await showStateForRender(handle, {
            phase: "error",
            message: error instanceof Error
              ? error.message
              : "La projection de géométrie n’a pas pu être montée.",
          }, sequence);
        }
      },
      onInvalid() {
        const invalid = pendingInvalidSession;
        if (
          !invalid || invalid.messageSequence !== latestSessionMessage ||
          !isCurrentRender(invalid.renderSequence)
        ) return;
        const handle = runtime.activeApp;
        if (!handle) return;
        void showStateForRender(handle, {
          phase: "error",
          message: invalid.error,
        }, invalid.renderSequence);
      },
    },
    async onToolInput(_params, handle) {
      if (disposed) return;
      viewerSessionActive = false;
      await showState(handle, { phase: "loading" });
    },
    async onToolResult(params, handle) {
      if (disposed) return;
      viewerSessionActive = false;
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
      const sequence = beginRender();
      currentData = { result: parsed.value };
      await mountGeometrySurface(handle, currentData, sequence);
    },
    async onTeardown() {
      disposed = true;
      renderGate.dispose();
      currentData = undefined;
      surfaceSignature = undefined;
      removeHostContextListener?.();
      removeHostContextListener = undefined;
      globalThis.removeEventListener("pagehide", onPageHide);
      appHostResourceBridge.dispose();
      await disposeSurface();
    },
  });
  if (disposed) return;
  runtime.activeApp = app;

  const invalid = pendingInvalidSession;
  if (
    invalid?.messageSequence === latestSessionMessage &&
    isCurrentRender(invalid.renderSequence)
  ) {
    await showStateForRender(app, {
      phase: "error",
      message: invalid.error,
    }, invalid.renderSequence);
    pendingInvalidSession = undefined;
  }

  const onHostContextChanged = () => {
    if (
      !currentData || viewerSessionActive ||
      isViewerSessionGeometryData(currentData) || disposed
    ) return;
    const nextSignature = selectedSurfaceSignature(app);
    if (nextSignature === surfaceSignature) return;
    const data = currentData;
    const sequence = beginRender();
    void mountGeometrySurface(app, data, sequence).catch(async (error) => {
      if (!isCurrentRender(sequence)) return;
      await showStateForRender(app, {
        phase: "error",
        message: error instanceof Error
          ? error.message
          : "La surface de composants n’a pas pu être montée.",
      }, sequence);
    });
  };
  app.ctx.app.addEventListener("hostcontextchanged", onHostContextChanged);
  removeHostContextListener = () =>
    app.ctx.app.removeEventListener(
      "hostcontextchanged",
      onHostContextChanged,
    );

  root.setAttribute("aria-busy", "false");
  if (app.ctx.state.phase === "loading" && !currentData && !viewerSessionSeen) {
    app.ctx.state = { phase: "empty" };
    await app.navigate("status");
  }
}

boot().catch((error) => {
  globalThis.removeEventListener("pagehide", onPageHide);
  appHostResourceBridge.dispose();
  root.innerHTML = renderViewer({
    phase: "error",
    message: error instanceof Error
      ? error.message
      : "Connexion au MCP Apps host impossible.",
  });
  root.setAttribute("aria-busy", "false");
});
