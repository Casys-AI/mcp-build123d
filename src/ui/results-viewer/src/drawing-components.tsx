/// <reference lib="dom" />

import { defineComponentRegistry } from "@casys/mcp-view-components";
import {
  Badge,
  Button,
  definePreactComponent,
  ElementIdent,
  ElementSection,
  EmptyState,
  FocusedView,
  KeyValueList,
  MetricGrid,
  type PreactSurfaceComponentProps,
  type PreactSurfaceContext,
  SemanticElement,
  Toolbar,
} from "@casys/mcp-view-components/preact";
import { useEffect, useState } from "preact/hooks";
import { ViewerBrandFooter } from "../../shared/branding.tsx";
import type { DrawingProjection, DrawingViewId } from "./drawing-contract.ts";
import { drawingMessages } from "./drawing-locale.ts";
import {
  defaultDrawingViewId,
  DRAWING_COMPONENT_KEYS,
  DRAWING_DEFAULT_SURFACE,
  drawingFacts,
  drawingMetrics,
  drawingViewOptions,
} from "./drawing-model.ts";

type Props = PreactSurfaceComponentProps<DrawingProjection>;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

const DrawingDatasheet = ({ data, context }: Props) => {
  const locale = context.hostContext.locale;
  const t = drawingMessages(locale);
  const options = drawingViewOptions(data, locale);
  const [selectedId, setSelectedId] = useState<DrawingViewId>(() =>
    defaultDrawingViewId(data)
  );
  const [zoom, setZoom] = useState(1);
  const selected = data.views.find((view) => view.id === selectedId) ??
    data.views[0];
  const selectedOption = options.find((option) => option.id === selected.id) ??
    options[0];
  const [imageUrl, setImageUrl] = useState<
    { sha256: string; url: string } | undefined
  >();
  const [loadedDigest, setLoadedDigest] = useState<string | undefined>();
  const [failedDigest, setFailedDigest] = useState<string | undefined>();

  useEffect(() => {
    setSelectedId(defaultDrawingViewId(data));
    setZoom(1);
    setLoadedDigest(undefined);
    setFailedDigest(undefined);
  }, [data.sourceStep.sha256]);

  useEffect(() => {
    // The strict parser has verified these exact UTF-8 bytes and their digest.
    // Keeping the SVG behind an image blob URL prevents it entering the App DOM.
    const url = URL.createObjectURL(
      new Blob([selected.svg.text], { type: "image/svg+xml;charset=utf-8" }),
    );
    setImageUrl({ sha256: selected.svg.sha256, url });
    return () => URL.revokeObjectURL(url);
  }, [selected.svg.sha256, selected.svg.text]);

  const currentImage = imageUrl?.sha256 === selected.svg.sha256
    ? imageUrl.url
    : undefined;
  const imageReady = currentImage !== undefined &&
    loadedDigest === selected.svg.sha256;
  const imageFailed = failedDigest === selected.svg.sha256;
  const zoomPercent = Math.round(zoom * 100);
  const sourceId = data.sourceStep.sha256;

  const chooseView = (id: DrawingViewId) => {
    setSelectedId(id);
    setZoom(1);
    setLoadedDigest(undefined);
    setFailedDigest(undefined);
  };

  return (
    <>
      <FocusedView
        className="drawing-datasheet"
        label={t("drawing")}
        hostContext={context.hostContext}
        status={
          <SemanticElement
            reference={{
              domain: "build123d",
              kind: "drawing-projection",
              id: sourceId,
              basisFingerprint: sourceId,
            }}
            density="row"
            ident={
              <ElementIdent
                marker={<Badge tone="success">{t("verified")}</Badge>}
                label={t("drawing")}
                detail={`${selectedOption.label} · ${selected.orientation}`}
              />
            }
          />
        }
        primary={
          <>
            <Toolbar label={t("views")} className="drawing-controls">
              {options.map((option) => (
                <Button
                  key={option.id}
                  pressed={option.id === selected.id}
                  onClick={() => chooseView(option.id)}
                >
                  {option.label}
                </Button>
              ))}
              <Button
                title={t("zoomOut")}
                disabled={zoom <= MIN_ZOOM}
                onClick={() =>
                  setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
              >
                −
              </Button>
              <Badge>{t("zoomLevel", { percent: zoomPercent })}</Badge>
              <Button
                title={t("zoomIn")}
                disabled={zoom >= MAX_ZOOM}
                onClick={() =>
                  setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
              >
                +
              </Button>
              <Button disabled={zoom === 1} onClick={() => setZoom(1)}>
                {t("fit")}
              </Button>
            </Toolbar>
            <div
              role="group"
              aria-label={t("previewOf", { view: selectedOption.label })}
              data-drawing-state={imageFailed
                ? "error"
                : imageReady
                ? "ready"
                : "loading"}
              data-drawing-view={selected.id}
              style={{
                // The deterministic SVG uses dark technical linework. Keep a
                // paper surface in both host themes so visible edges retain
                // their intended contrast.
                background: "#ffffff",
                border: "1px solid var(--mcp-view-border)",
                borderRadius: "var(--mcp-view-radius)",
                color: "#334155",
                height: "clamp(240px, 52vh, 560px)",
                overflow: "auto",
                marginTop: "0.45rem",
              }}
            >
              {currentImage && !imageFailed
                ? (
                  <img
                    src={currentImage}
                    alt={t("previewOf", { view: selectedOption.label })}
                    decoding="async"
                    onLoad={() => {
                      setLoadedDigest(selected.svg.sha256);
                      setFailedDigest(undefined);
                    }}
                    onError={() => {
                      setLoadedDigest(undefined);
                      setFailedDigest(selected.svg.sha256);
                    }}
                    style={{
                      display: "block",
                      width: zoom === 1 ? "100%" : `${zoomPercent}%`,
                      height: zoom === 1 ? "100%" : "auto",
                      maxWidth: "none",
                      objectFit: "contain",
                      margin: "0 auto",
                    }}
                  />
                )
                : (
                  <EmptyState>
                    {t(imageFailed ? "unavailable" : "loadingPreview")}
                  </EmptyState>
                )}
            </div>
            <MetricGrid
              className="drawing-readings"
              items={drawingMetrics(data, locale)}
            />
          </>
        }
        detailsLabel={t("details")}
        details={
          <>
            {drawingFacts(data, selected.id, locale).map((section) => (
              <ElementSection key={section.id} title={section.title}>
                <KeyValueList layout="inspector" items={section.items} />
              </ElementSection>
            ))}
          </>
        }
      />
      <ViewerBrandFooter />
    </>
  );
};

export const DRAWING_COMPONENT_REGISTRY = defineComponentRegistry<
  DrawingProjection,
  PreactSurfaceContext<DrawingProjection>
>({
  components: {
    [DRAWING_COMPONENT_KEYS.datasheet]: definePreactComponent(
      {
        title: "2D projection",
        description:
          "Verified SVG projections with source STEP identity, engine and method facts.",
      },
      DrawingDatasheet,
    ),
  },
  defaultSurface: DRAWING_DEFAULT_SURFACE,
});
