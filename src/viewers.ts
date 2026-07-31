/**
 * MCP App viewer registration.
 *
 * The result viewer is deliberately optional during this server-only phase:
 * McpApp logs and skips it until `src/ui/dist/results-viewer/index.html` has
 * been built. This keeps text-only MCP clients fully usable.
 */

import type { McpApp } from "@casys/mcp-server";

const MODULE_URL = new URL("..", import.meta.url).href;
const VIEWERS = ["results-viewer"];

function isRemoteUrl(path: string): boolean {
  return path.startsWith("https://") || path.startsWith("http://");
}

export interface ViewerFilesystem {
  exists(path: string): boolean;
  readFile(path: string): string | Promise<string>;
}

const localFilesystem: ViewerFilesystem = {
  exists: (path) => {
    // JSR modules resolve their bundled viewer to HTTPS. It is shipped through
    // publish.include, so avoid passing a URL to Deno.statSync.
    if (isRemoteUrl(path)) return true;
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  },
  readFile: async (path) => {
    if (!isRemoteUrl(path)) return await Deno.readTextFile(path);
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch build123d results viewer (${response.status} ${response.statusText}): ${path}`,
      );
    }
    return await response.text();
  },
};

/** Register the built result viewer, or report it skipped when absent. */
export function registerBuild123dViewers(
  app: McpApp,
  filesystem: ViewerFilesystem = localFilesystem,
  moduleUrl = MODULE_URL,
): { registered: string[]; skipped: string[] } {
  return app.registerViewers({
    prefix: "mcp-build123d",
    moduleUrl,
    viewers: VIEWERS,
    ...filesystem,
  });
}
