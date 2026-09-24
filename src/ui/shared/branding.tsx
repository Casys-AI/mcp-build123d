/// <reference lib="dom" />
/** @jsxImportSource preact */

import type { ComponentChildren } from "preact";
import { CASYS_BRANDING_STYLES } from "./branding-styles.ts";

export interface CasysCreditProps {
  readonly compact?: boolean;
  readonly className?: string;
}

export interface ViewerBrandFooterProps extends CasysCreditProps {
  readonly children?: ComponentChildren;
}

const classNames = (
  ...values: readonly (string | false | null | undefined)[]
): string => values.filter(Boolean).join(" ");

const BrandingStyles = () => (
  <style data-casys-viewer-branding>{CASYS_BRANDING_STYLES}</style>
);

/**
 * ERPNext's current Casys mark, reduced from its verbose exported SVG without
 * changing its rendered geometry or gradient endpoints.
 */
const CasysMark = ({ compact = false }: { readonly compact?: boolean }) => (
  <svg
    class="casys-credit-logo"
    width={compact ? 12 : 13}
    height={compact ? 12 : 13}
    viewBox="0 0 375 375"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <linearGradient
        id="casys-credit-gradient"
        x1="69.5"
        y1="187.5"
        x2="305.5"
        y2="187.5"
        gradientUnits="userSpaceOnUse"
      >
        <stop offset="0" stop-color="#000000" />
        <stop offset="1" stop-color="#dbbddb" />
      </linearGradient>
    </defs>
    <circle cx="187.5" cy="187.5" r="118" fill="url(#casys-credit-gradient)" />
  </svg>
);

const CasysCreditLink = (
  { compact = false, className }: CasysCreditProps,
) => (
  <a
    class={classNames("casys-credit", className)}
    data-compact={String(compact)}
    href="https://casys.ai"
    target="_blank"
    rel="noopener noreferrer"
  >
    <CasysMark compact={compact} />
    <span>Powered by Casys.ai</span>
  </a>
);

/** Standalone ERPNext-style Casys credit for a custom viewer footer. */
export function CasysCredit(props: CasysCreditProps = {}) {
  return (
    <>
      <BrandingStyles />
      <CasysCreditLink {...props} />
    </>
  );
}

/**
 * Shared footer. Optional controls or pagination stay on the left; the Casys
 * credit remains aligned to the right and compacts at narrow viewer widths.
 */
export function ViewerBrandFooter(
  { children, compact = false, className }: ViewerBrandFooterProps,
) {
  const hasContent = children !== undefined && children !== null &&
    children !== false;
  return (
    <>
      <BrandingStyles />
      <footer
        class={classNames("casys-viewer-brand-footer", className)}
        data-compact={String(compact)}
        data-has-content={String(hasContent)}
      >
        {hasContent && (
          <div class="casys-viewer-brand-footer-content">{children}</div>
        )}
        <CasysCreditLink compact={compact} />
      </footer>
    </>
  );
}
