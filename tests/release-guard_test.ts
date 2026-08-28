import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertMatchingReleaseRef,
  jsrPublicationDecision,
} from "../scripts/release-guard.ts";

Deno.test("release guard requires the exact v-prefixed package tag", () => {
  assertMatchingReleaseRef("refs/tags/v0.5.1", "0.5.1");
  assertThrows(
    () => assertMatchingReleaseRef("refs/tags/v0.5.2", "0.5.1"),
    Error,
    "refs/tags/v0.5.1",
  );
  assertThrows(
    () => assertMatchingReleaseRef("refs/tags/V0.5.1", "0.5.1"),
    Error,
    "refs/tags/v0.5.1",
  );
});

Deno.test("release guard makes JSR reruns a no-op only for an exact version", () => {
  assertEquals(
    jsrPublicationDecision({ versions: { "0.5.1": {} } }, "0.5.1"),
    "already-published",
  );
  assertEquals(
    jsrPublicationDecision({ versions: { "0.5.0": {} } }, "0.5.1"),
    "publish",
  );
  assertThrows(
    () => jsrPublicationDecision({ versions: [] }, "0.5.1"),
    Error,
    "versions object",
  );
});

Deno.test("publish workflow retains tag-only qualified release guards", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  );
  assertStringIncludes(workflow, "branches:");
  assertStringIncludes(workflow, "      - main");
  assertStringIncludes(workflow, "tags:");
  assertStringIncludes(workflow, '      - "v*"');
  assertStringIncludes(
    workflow,
    "github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')",
  );
  assertStringIncludes(workflow, "scripts/release-guard.ts tag");
  assertStringIncludes(workflow, "scripts/release-guard.ts published");
  assertStringIncludes(workflow, "deno publish --dry-run");
  assertStringIncludes(workflow, "pip install build123d==0.11.1");
  assertStringIncludes(workflow, "deno test --allow-all tests/");
});
