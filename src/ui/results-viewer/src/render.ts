import type { GeometryComponentData } from "./component-model.ts";

export interface ViewerState {
  phase: "loading" | "empty" | "error";
  message?: string;
  currentData?: GeometryComponentData;
}

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

/** Render only lifecycle states; real geometry is mounted as a component surface. */
export function renderViewer(state: ViewerState): string {
  const copy = state.phase === "loading"
    ? ["Connexion à l’instrument", "Réception du résultat de calcul…"]
    : state.phase === "empty"
    ? [
      "En attente d’une mesure",
      "Lancez build123d_execute ou build123d_export pour afficher le résultat exact.",
    ]
    : ["Résultat non affichable", state.message ?? "Erreur inconnue"];
  return `<main class="mcp-view-state lifecycle-state" data-tone="${
    state.phase === "error" ? "danger" : "info"
  }" aria-busy="${state.phase === "loading"}" aria-live="polite"><strong>${
    copy[0]
  }</strong><div class="mcp-view-state-detail">${
    escapeHtml(copy[1])
  }</div></main>`;
}
