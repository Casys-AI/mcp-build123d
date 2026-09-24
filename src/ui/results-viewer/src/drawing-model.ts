/** Pure projection of one verified drawing result into the MCP App surface. */

import {
  type DrawingProjection,
  type DrawingViewId,
  parseDrawingProjection,
} from "./drawing-contract.ts";
import { drawingMessages } from "./drawing-locale.ts";

export const DRAWING_COMPONENT_KEYS = {
  datasheet: "build123d.drawing-datasheet",
} as const;

export const DRAWING_DEFAULT_SURFACE = {
  layout: { type: "stack", gap: "none" },
  components: [{
    id: "drawing-datasheet",
    component: DRAWING_COMPONENT_KEYS.datasheet,
  }],
} as const;

export const DRAWING_TOOL_ERROR_CODE = "drawing-tool-error";
export const DRAWING_RESULT_REJECTED_CODE = "drawing-result-rejected";

export interface DrawingToolResult {
  readonly isError?: boolean;
  readonly content?: unknown;
  readonly structuredContent?: unknown;
}

export type DrawingDisplayState =
  | {
    readonly kind: "error";
    readonly title: string | ((locale?: string) => string);
    readonly code: string;
    readonly message: string | ((locale?: string) => string);
  }
  | { readonly kind: "result"; readonly result: DrawingProjection };

export interface DrawingOption {
  readonly id: DrawingViewId;
  readonly label: string;
  readonly orientation: string;
}

export interface DrawingMetric {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
}

export interface DrawingFact {
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface DrawingFactSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly DrawingFact[];
}

const VIEW_MESSAGE_KEYS = {
  top: "top",
  front: "front",
  right: "right",
  isometric: "isometric",
  "section-yz": "sectionYz",
} as const;

function errorText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const messages = content.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  return messages.length > 0 ? messages.join("\n") : undefined;
}

export async function drawingStateFromToolResult(
  result: DrawingToolResult,
): Promise<DrawingDisplayState> {
  if (result.isError) {
    return {
      kind: "error",
      title: (locale) => drawingMessages(locale)("toolFailed"),
      code: DRAWING_TOOL_ERROR_CODE,
      message: errorText(result.content) ??
        ((locale) => drawingMessages(locale)("toolError")),
    };
  }
  const parsed = await parseDrawingProjection(result.structuredContent);
  if (!parsed.ok) {
    return {
      kind: "error",
      title: (locale) => drawingMessages(locale)("resultRejected"),
      code: DRAWING_RESULT_REJECTED_CODE,
      message: parsed.error,
    };
  }
  return { kind: "result", result: parsed.value };
}

export function defaultDrawingViewId(result: DrawingProjection): DrawingViewId {
  return result.views.find((view) => view.id === "top")?.id ??
    result.views[0].id;
}

/** Wire labels remain available in facts; tab names follow the host locale. */
export function drawingViewOptions(
  result: DrawingProjection,
  locale?: string,
): readonly DrawingOption[] {
  const t = drawingMessages(locale);
  return result.views.map((view) => ({
    id: view.id,
    label: t(VIEW_MESSAGE_KEYS[view.id]),
    orientation: view.orientation,
  }));
}

export function drawingMetrics(
  result: DrawingProjection,
  locale?: string,
): readonly DrawingMetric[] {
  const t = drawingMessages(locale);
  const number = new Intl.NumberFormat(locale ?? "en", {
    maximumFractionDigits: 4,
  });
  return [
    {
      id: "envelope-x",
      label: t("dimensionsX"),
      value: number.format(result.envelopeMm[0]),
      unit: "mm",
    },
    {
      id: "envelope-y",
      label: t("dimensionsY"),
      value: number.format(result.envelopeMm[1]),
      unit: "mm",
    },
    {
      id: "envelope-z",
      label: t("dimensionsZ"),
      value: number.format(result.envelopeMm[2]),
      unit: "mm",
    },
    {
      id: "views",
      label: t("viewCount"),
      value: number.format(result.views.length),
    },
  ];
}

export function drawingFacts(
  result: DrawingProjection,
  viewId: DrawingViewId,
  locale?: string,
): readonly DrawingFactSection[] {
  const t = drawingMessages(locale);
  const view = result.views.find((entry) => entry.id === viewId) ??
    result.views[0];
  return [
    {
      id: "source",
      title: t("source"),
      items: [
        {
          id: "source-mime",
          label: t("mimeType"),
          value: result.sourceStep.mimeType,
        },
        {
          id: "source-sha256",
          label: t("sha256"),
          value: result.sourceStep.sha256,
        },
        {
          id: "source-bytes",
          label: t("bytes"),
          value: String(result.sourceStep.bytes),
        },
      ],
    },
    {
      id: "method",
      title: t("method"),
      items: [
        {
          id: "engine",
          label: t("engine"),
          value:
            `build123d ${result.engine.build123d} · OCP ${result.engine.ocp}`,
        },
        {
          id: "method-id",
          label: t("projection"),
          value: `${result.method.id}@${result.method.version}`,
        },
      ],
    },
    {
      id: "view",
      title: t("selectedView"),
      items: [
        { id: "source-label", label: t("sourceLabel"), value: view.label },
        { id: "orientation", label: t("orientation"), value: view.orientation },
        { id: "svg-sha256", label: t("sha256"), value: view.svg.sha256 },
        { id: "svg-bytes", label: t("bytes"), value: String(view.svg.bytes) },
      ],
    },
  ];
}
