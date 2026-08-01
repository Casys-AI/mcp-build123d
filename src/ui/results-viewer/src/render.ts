export type ViewerState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "error"; message: string };

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
    : ["Résultat non affichable", state.message];
  return `<main class="instrument state" aria-busy="${
    state.phase === "loading"
  }" aria-live="polite"><p class="eyebrow">build123d / métrologie</p><h1>${
    copy[0]
  }</h1><p>${escapeHtml(copy[1])}</p></main>`;
}
