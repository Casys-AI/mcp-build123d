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
    ? ["Connecting to the instrument", "Receiving a build123d geometry result…"]
    : state.phase === "empty"
    ? [
      "Waiting for a measurement",
      "Run build123d_execute or build123d_export to show the exact result.",
    ]
    : ["Result not displayable", state.message ?? "Unknown error"];
  return `<main class="mcp-view-state lifecycle-state" data-tone="${
    state.phase === "error" ? "danger" : "info"
  }" aria-busy="${state.phase === "loading"}" aria-live="polite"><strong>${
    copy[0]
  }</strong><div class="mcp-view-state-detail">${
    escapeHtml(copy[1])
  }</div></main>`;
}
