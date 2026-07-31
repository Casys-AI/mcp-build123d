import type { GeometryResult } from "./contract.ts";

export type ViewerState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "error"; message: string }
  | { phase: "ready"; result: GeometryResult };

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

function numeric(value: number, unit: string): string {
  return `${
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)
  } ${unit}`;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function point(value: [number, number, number]): string {
  return value.map((item) => numeric(item, "")).join(" × ");
}

function metric(label: string, value: string, emphasis = false): string {
  return `<div class="metric${
    emphasis ? " metric-emphasis" : ""
  }"><span>${label}</span><strong>${value}</strong></div>`;
}

function ready(result: GeometryResult): string {
  const { metrics } = result;
  const dimensions = metrics.boundingBoxMm
    ? metric("Envelope", `${point(metrics.boundingBoxMm.size)} mm`)
    : "";
  const center = metrics.centerOfMassMm
    ? `<div class="coordinate"><span>Centre de masse</span><code>${
      point(metrics.centerOfMassMm)
    } mm</code></div>`
    : "";
  const mass = metrics.massKg === undefined
    ? `<p class="note">Masse non calculée : fournissez une densité explicite.</p>`
    : metric("Masse", numeric(metrics.massKg, "kg"));
  const density = metrics.densityKgM3 === undefined
    ? ""
    : metric("Densité", numeric(metrics.densityKgM3, "kg/m³"));
  const files = result.files.length === 0
    ? ""
    : `<section class="panel exports" aria-labelledby="exports-title">
      <div class="section-heading"><p class="eyebrow">Artefacts</p><h2 id="exports-title">Exports</h2></div>
      <ul>${
      result.files.map((file) =>
        `<li><span class="file-format">${file.format}</span><code>${
          escapeHtml(file.path)
        }</code><span>${bytes(file.bytes)}</span></li>`
      ).join("")
    }</ul>
    </section>`;
  return `<main class="instrument" aria-busy="false" aria-label="Résultat géométrique build123d">
    <header class="masthead">
      <div><p class="eyebrow">build123d / métrologie</p><h1>Résultat géométrique</h1></div>
      <span class="status ${result.kind}">${
    result.kind === "export" ? "EXPORTÉ" : "CALCULÉ"
  }</span>
    </header>
    <section class="panel primary" aria-label="Mesures principales">
      ${metric("Volume", numeric(metrics.volumeMm3, "mm³"), true)}
      ${metric("Surface", numeric(metrics.areaMm2, "mm²"), true)}
      ${dimensions}
      ${mass}
      ${density}
    </section>
    <section class="split">
      <section class="panel" aria-labelledby="shape-title">
        <div class="section-heading"><p class="eyebrow">Boîte englobante</p><h2 id="shape-title">Géométrie</h2></div>
        ${center}
        ${
    metrics.boundingBoxMm
      ? `<div class="coordinate"><span>Minimum</span><code>${
        point(metrics.boundingBoxMm.min)
      } mm</code></div><div class="coordinate"><span>Maximum</span><code>${
        point(metrics.boundingBoxMm.max)
      } mm</code></div>`
      : `<p class="note">Dimensions non fournies par ce résultat.</p>`
  }
      </section>
      <section class="panel" aria-labelledby="topology-title">
        <div class="section-heading"><p class="eyebrow">Noyau BREP</p><h2 id="topology-title">Topologie</h2></div>
        <div class="topology"><span><b>${metrics.solids}</b> solide${
    metrics.solids === 1 ? "" : "s"
  }</span><span><b>${metrics.faces}</b> faces</span><span><b>${metrics.edges}</b> arêtes</span></div>
      </section>
    </section>
    ${files}
  </main>`;
}

/** Render only data already narrowed by parseGeometryResult; all text is escaped. */
export function renderViewer(state: ViewerState): string {
  if (state.phase === "ready") return ready(state.result);
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
