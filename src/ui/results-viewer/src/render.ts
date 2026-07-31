import type { GeometryResult } from "./contract.ts";

export type ViewerState =
  | { phase: "loading" }
  | { phase: "empty" }
  | { phase: "error"; message: string }
  | {
    phase: "ready";
    result: GeometryResult;
    model?:
      | { phase: "loading"; name: string }
      | { phase: "ready" }
      | { phase: "error"; message: string }
      | { phase: "unavailable" };
  };

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

function modelViewport(
  state: Extract<ViewerState, { phase: "ready" }>,
): string {
  const gltf = state.result.files.find((file) => file.format === "gltf");
  if (!gltf) return "";
  const model = state.model ?? { phase: "unavailable" as const };
  const viewport = model.phase === "ready"
    ? `<div class="cad-stage">
        <div id="cad-viewport" role="img" aria-label="Modèle 3D interactif build123d"></div>
        <div class="cad-reticle" aria-hidden="true"></div>
        <div class="cad-hud" aria-live="polite">
          <span><i></i> GLB LOCAL</span>
          <span id="cad-mesh-count">Analyse de la scène…</span>
        </div>
      </div>`
    : `<div class="cad-stage cad-stage-state" aria-live="polite">
        <div class="cad-state-mark" aria-hidden="true">${
      model.phase === "loading" ? "◌" : "!"
    }</div>
        <strong>${
      model.phase === "loading"
        ? "Chargement du modèle"
        : model.phase === "error"
        ? "Aperçu 3D indisponible"
        : "Export GLB non relié"
    }</strong>
        <p>${
      model.phase === "loading"
        ? escapeHtml(model.name)
        : model.phase === "error"
        ? escapeHtml(model.message)
        : "Réexportez ce modèle avec une version récente de mcp-build123d."
    }</p>
      </div>`;
  return `<section class="panel model-panel" aria-labelledby="model-title">
      <div class="model-head">
        <div class="section-heading"><div><p class="eyebrow">Assemblage / espace 3D</p><h2 id="model-title">Inspection géométrique</h2></div></div>
        <div class="cad-controls" aria-label="Commandes du modèle 3D">
          <button type="button" data-cad-action="fit">CADRER</button>
          <button type="button" data-cad-action="reset">RÉINITIALISER</button>
          <button type="button" data-cad-action="wireframe" aria-pressed="false">FIL DE FER</button>
        </div>
      </div>
      ${viewport}
      <footer class="model-foot"><span>Orbit · Pan · Zoom</span><code>${
    escapeHtml(gltf.path)
  }</code><span>${bytes(gltf.bytes)}</span></footer>
    </section>`;
}

function ready(state: Extract<ViewerState, { phase: "ready" }>): string {
  const result = state.result;
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
    ${modelViewport(state)}
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
  if (state.phase === "ready") return ready(state);
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
