/// <reference lib="dom" />

import {
  defineComponentRegistry,
  defineCustomComponent,
  defineMetricGridComponent,
  defineStatusComponent,
} from "@casys/mcp-view";
import { decodeGltfArtifact } from "./contract.ts";
import {
  BUILD123D_COMPONENT_KEYS,
  BUILD123D_DEFAULT_SURFACE,
  type GeometryComponentData,
  geometryMetricValues,
  geometryStatusValue,
} from "./component-model.ts";
import { mountCadScene } from "./scene.ts";

interface ComponentToolResult {
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}

export interface GeometryComponentAppContext {
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ComponentToolResult>;
}

const statusComponent = defineStatusComponent<
  GeometryComponentData,
  GeometryComponentAppContext
>({
  title: "Geometry status",
  description: "Computation/export status and available geometry identity.",
  select: geometryStatusValue,
});

const metricsComponent = defineMetricGridComponent<
  GeometryComponentData,
  GeometryComponentAppContext
>({
  title: "Geometry metrics",
  description:
    "Exact OCCT volume, surface, envelope, topology and optional mass data.",
  select: geometryMetricValues,
});

const canvasComponent = defineCustomComponent<
  GeometryComponentData,
  GeometryComponentAppContext
>({
  title: "Interactive geometry",
  description: "Interactive local GLB canvas with orbit, pan and inspection.",
  async mount(target, context) {
    target.classList.add("panel", "model-panel");
    const gltf = context.data.result.files.find((file) =>
      file.format === "gltf"
    );
    if (!gltf?.viewer) {
      mountCanvasState(
        target,
        "Aperçu 3D indisponible",
        gltf
          ? "Cet export GLB ne fournit pas de référence de lecture bornée."
          : "Ajoutez le format gltf à build123d_export pour monter ce composant.",
      );
      return;
    }

    const viewport = mountCanvasShell(target, gltf.path, gltf.bytes);
    try {
      const artifact = await context.appContext.callTool(gltf.viewer.toolName, {
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
      const scene = await mountCadScene(viewport, decoded.value);
      const count = target.querySelector<HTMLElement>("[data-cad-mesh-count]");
      if (count) {
        count.textContent = `${scene.meshes} maillage${
          scene.meshes === 1 ? "" : "s"
        } · ${scene.nodes} nœuds`;
      }
      return () => scene.dispose();
    } catch (error) {
      mountCanvasState(
        target,
        "Aperçu 3D indisponible",
        error instanceof Error
          ? error.message
          : "Le modèle 3D n’a pas pu être chargé.",
      );
    }
  },
});

const artifactsComponent = defineCustomComponent<
  GeometryComponentData,
  GeometryComponentAppContext
>({
  title: "Export artifacts",
  description: "Exact generated formats, paths and byte sizes.",
  mount(target, context) {
    target.classList.add("panel", "exports");
    target.append(sectionHeading("Artefacts", "Exports"));
    const files = context.data.result.files;
    if (files.length === 0) {
      const note = element(
        "p",
        "Aucun export pour ce calcul. Utilisez build123d_export pour produire STEP, STL ou GLB.",
      );
      note.className = "note";
      target.append(note);
      return;
    }
    const list = document.createElement("ul");
    for (const file of files) {
      const item = document.createElement("li");
      const format = element("span", file.format);
      format.className = "file-format";
      item.append(
        format,
        element("code", file.path),
        element("span", bytes(file.bytes)),
      );
      list.append(item);
    }
    target.append(list);
  },
});

export const BUILD123D_COMPONENT_REGISTRY = defineComponentRegistry<
  GeometryComponentData,
  GeometryComponentAppContext
>({
  components: {
    [BUILD123D_COMPONENT_KEYS.status]: statusComponent,
    [BUILD123D_COMPONENT_KEYS.metrics]: metricsComponent,
    [BUILD123D_COMPONENT_KEYS.canvas]: canvasComponent,
    [BUILD123D_COMPONENT_KEYS.artifacts]: artifactsComponent,
  },
  defaultSurface: BUILD123D_DEFAULT_SURFACE,
});

function mountCanvasShell(
  target: HTMLElement,
  path: string,
  fileBytes: number,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "model-head";
  head.append(
    sectionHeading("Assemblage / espace 3D", "Inspection géométrique"),
  );
  const controls = document.createElement("div");
  controls.className = "cad-controls";
  controls.setAttribute("aria-label", "Commandes du modèle 3D");
  for (
    const [action, label] of [
      ["fit", "CADRER"],
      ["reset", "RÉINITIALISER"],
      ["wireframe", "FIL DE FER"],
    ] as const
  ) {
    const button = element("button", label);
    button.type = "button";
    button.dataset.cadAction = action;
    if (action === "wireframe") button.setAttribute("aria-pressed", "false");
    controls.append(button);
  }
  head.append(controls);

  const stage = document.createElement("div");
  stage.className = "cad-stage";
  const viewport = document.createElement("div");
  viewport.className = "cad-viewport";
  viewport.setAttribute("role", "img");
  viewport.setAttribute("aria-label", "Modèle 3D interactif build123d");
  const reticle = document.createElement("div");
  reticle.className = "cad-reticle";
  reticle.setAttribute("aria-hidden", "true");
  const hud = document.createElement("div");
  hud.className = "cad-hud";
  hud.setAttribute("aria-live", "polite");
  const local = element("span", "GLB LOCAL");
  local.prepend(document.createElement("i"));
  const count = element("span", "Analyse de la scène…");
  count.dataset.cadMeshCount = "";
  hud.append(local, count);
  stage.append(viewport, reticle, hud);

  const foot = document.createElement("footer");
  foot.className = "model-foot";
  foot.append(
    element("span", "Orbit · Pan · Zoom"),
    element("code", path),
    element("span", bytes(fileBytes)),
  );
  target.replaceChildren(head, stage, foot);
  return viewport;
}

function mountCanvasState(
  target: HTMLElement,
  title: string,
  detail: string,
): void {
  const state = document.createElement("div");
  state.className = "cad-stage cad-stage-state";
  const mark = element("div", "!");
  mark.className = "cad-state-mark";
  mark.setAttribute("aria-hidden", "true");
  state.append(mark, element("strong", title), element("p", detail));
  target.replaceChildren(state);
}

function sectionHeading(eyebrow: string, title: string): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "section-heading";
  const label = element("p", eyebrow);
  label.className = "eyebrow";
  heading.append(label, element("h2", title));
  return heading;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
