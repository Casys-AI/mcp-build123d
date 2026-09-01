import { assertEquals } from "@std/assert";
import { defineViewAppManifest } from "@casys/mcp-view-contracts";
import { BUILD123D_VIEW_APP_MANIFEST } from "../src/ui/view-app-manifest.ts";

Deno.test("the serialized manifest matches its TypeScript source and the shared contract", async () => {
  defineViewAppManifest(BUILD123D_VIEW_APP_MANIFEST);
  const serialized = JSON.parse(
    await Deno.readTextFile(
      new URL("../src/ui/view-app-manifest.json", import.meta.url),
    ),
  );
  assertEquals(serialized, BUILD123D_VIEW_APP_MANIFEST);
});
