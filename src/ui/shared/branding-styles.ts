/**
 * Small, self-contained branding layer shared by every Build123d viewer.
 *
 * The geometry viewer is bundled into one HTML file without a CSS loader, so
 * these rules travel with the Preact component that uses them. Colors, type and
 * radii intentionally consume the mcp-view-components theme tokens: they keep
 * the ERPNext visual language while still honoring host light/dark overrides.
 */
export const CASYS_BRANDING_STYLES = String.raw`
.casys-viewer-brand-footer {
  display: flex;
  min-width: 0;
  flex: 0 0 auto;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
  padding: 4px 16px;
  border-top: 1px solid var(--mcp-view-border, #dbe3e7);
  background: var(--mcp-view-panel, #fff);
}

.casys-viewer-brand-footer[data-has-content="true"] {
  justify-content: space-between;
}

.casys-viewer-brand-footer-content {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 10px;
  color: var(--mcp-view-quiet, #687781);
  font-family: var(
    --mcp-view-font-mono,
    "JetBrains Mono",
    "SFMono-Regular",
    Consolas,
    monospace
  );
  font-size: var(--mcp-view-size-chip, 10.5px);
  line-height: 1.25;
}

.casys-credit {
  display: inline-flex;
  min-height: 24px;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  border-radius: var(--mcp-view-radius-sm, 4px);
  color: var(--mcp-view-quiet, #687781);
  font-family: var(
    --mcp-view-font-mono,
    "JetBrains Mono",
    "SFMono-Regular",
    Consolas,
    monospace
  );
  font-size: var(--mcp-view-size-chip, 10.5px);
  line-height: 1.25;
  letter-spacing: 0.04em;
  text-decoration: none;
  white-space: nowrap;
  transition: color 120ms ease;
}

.casys-credit:hover {
  color: var(--mcp-view-accent, #0d7c8a);
}

.casys-credit:focus-visible {
  outline: 2px solid var(--mcp-view-accent, #0d7c8a);
  outline-offset: 2px;
}

.casys-credit-logo {
  display: block;
  width: 13px;
  height: 13px;
  flex: 0 0 auto;
}

.casys-credit[data-compact="true"] {
  gap: 6px;
  font-size: var(--mcp-view-size-micro, 10px);
}

.casys-credit[data-compact="true"] .casys-credit-logo {
  width: 12px;
  height: 12px;
}

.casys-viewer-brand-footer[data-compact="true"] {
  padding-inline: 12px;
}

@container build123d-view (max-width: 480px) {
  .casys-viewer-brand-footer {
    padding-inline: 12px;
  }

  .casys-credit {
    gap: 6px;
    font-size: var(--mcp-view-size-micro, 10px);
  }

  .casys-viewer-brand-footer-content {
    font-size: var(--mcp-view-size-micro, 10px);
  }

  .casys-credit-logo {
    width: 12px;
    height: 12px;
  }
}

@media (max-width: 480px) {
  .casys-viewer-brand-footer {
    padding-inline: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .casys-credit {
    transition: none;
  }
}
`;
