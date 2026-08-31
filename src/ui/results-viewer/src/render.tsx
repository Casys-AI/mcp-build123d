/// <reference lib="dom" />
/** @jsxImportSource preact */

import { render } from "preact";
import { StateMessage } from "@casys/mcp-view-components/preact";
import type { GeometryComponentData } from "./component-model.ts";

export interface ViewerState {
  phase: "loading" | "empty" | "error";
  message?: string;
  currentData?: GeometryComponentData;
}

function lifecycleCopy(state: ViewerState): {
  readonly title: string;
  readonly detail: string;
  readonly tone: "info" | "danger";
  readonly busy: boolean;
} {
  if (state.phase === "loading") {
    return {
      title: "Connexion à l’instrument",
      detail: "Réception du résultat de calcul…",
      tone: "info",
      busy: true,
    };
  }
  if (state.phase === "empty") {
    return {
      title: "En attente d’une mesure",
      detail:
        "Lancez build123d_execute ou build123d_export pour afficher le résultat exact.",
      tone: "info",
      busy: false,
    };
  }
  return {
    title: "Résultat non affichable",
    detail: state.message ?? "Erreur inconnue",
    tone: "danger",
    busy: false,
  };
}

function LifecycleState(
  { state }: { readonly state: ViewerState },
) {
  const copy = lifecycleCopy(state);
  return (
    <StateMessage
      className="lifecycle-state"
      title={copy.title}
      tone={copy.tone}
      busy={copy.busy}
    >
      {copy.detail}
    </StateMessage>
  );
}

/** Render only lifecycle states; real geometry is mounted as a component surface. */
export function renderViewer(state: ViewerState): HTMLElement {
  const host = document.createElement("div");
  render(<LifecycleState state={state} />, host);
  const node = host.firstElementChild;
  if (!(node instanceof HTMLElement)) {
    throw new Error("lifecycle state failed to render");
  }
  return node;
}
