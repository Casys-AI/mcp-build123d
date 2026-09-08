import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertMatchingReleaseRef,
  jsrPublicationDecision,
} from "../scripts/release-guard.ts";

Deno.test("release guard requires the exact v-prefixed package tag", () => {
  assertMatchingReleaseRef("refs/tags/v0.6.1", "0.6.1");
  assertThrows(
    () => assertMatchingReleaseRef("refs/tags/v0.6.2", "0.6.1"),
    Error,
    "refs/tags/v0.6.1",
  );
  assertThrows(
    () => assertMatchingReleaseRef("refs/tags/V0.6.1", "0.6.1"),
    Error,
    "refs/tags/v0.6.1",
  );
});

Deno.test("release guard makes JSR reruns a no-op only for an exact version", () => {
  assertEquals(
    jsrPublicationDecision({ versions: { "0.6.1": {} } }, "0.6.1"),
    "already-published",
  );
  assertEquals(
    jsrPublicationDecision({ versions: { "0.5.1": {} } }, "0.6.1"),
    "publish",
  );
  assertThrows(
    () => jsrPublicationDecision({ versions: [] }, "0.6.1"),
    Error,
    "versions object",
  );
});

Deno.test("publish workflow retains tag-only qualified release guards", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
  );
  const constraints = await Deno.readTextFile(
    new URL("../requirements/constraints.txt", import.meta.url),
  );
  const readme = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  assertStringIncludes(workflow, "branches:");
  assertStringIncludes(workflow, "      - main");
  assertStringIncludes(workflow, "tags:");
  assertStringIncludes(workflow, '      - "v*"');
  assertStringIncludes(
    workflow,
    [
      "on:",
      "  push:",
      "    branches:",
      "      - main",
      "    tags:",
      '      - "v*"',
      "  pull_request:",
      "    branches:",
      "      - main",
    ].join("\n"),
  );
  assertStringIncludes(
    workflow,
    "github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v')",
  );
  assertStringIncludes(workflow, "scripts/release-guard.ts tag");
  assertStringIncludes(workflow, "scripts/release-guard.ts published");
  assertStringIncludes(workflow, "deno publish --dry-run");
  assertStringIncludes(workflow, "deno-version: v2.9.6");
  assertStringIncludes(
    workflow,
    "requirements/runtime.txt -c requirements/constraints.txt",
  );
  assertStringIncludes(constraints, "cadquery-ocp-novtk==7.9.3.1.1");
  assertStringIncludes(workflow, "platforms: linux/amd64,linux/arm64");
  assertStringIncludes(workflow, "provenance: mode=max");
  assertStringIncludes(workflow, "sbom: true");
  assertStringIncludes(workflow, "deno test --allow-all tests/");
  assertStringIncludes(
    workflow,
    "ref: b08802df353bb25d25a1c8d64b22ea61b5287ae0",
  );
  assertStringIncludes(workflow, "load: true");
  assertStringIncludes(workflow, "push: false");
  assertStringIncludes(workflow, "push: true");
  assertEquals(workflow.includes("deno publish\n"), true);
  assertEquals(/uses:\s+\S+@v\d/.test(workflow), false);
  const uses = [...workflow.matchAll(/^\s+- uses:\s+(\S+)(.*)$/gm)];
  assertEquals(uses.length > 0, true);
  for (const [, actionRef, rest] of uses) {
    const sha = actionRef.split("@")[1] ?? "";
    assertEquals(/^[0-9a-f]{40}$/.test(sha), true, actionRef);
    assertEquals(rest.trim().startsWith("# v"), true, `${actionRef}${rest}`);
  }
  assertStringIncludes(
    workflow,
    ["permissions:", "  contents: read"].join("\n"),
  );
  assertStringIncludes(workflow, "id-token: write");
  assertStringIncludes(workflow, "packages: write");
  assertStringIncludes(workflow, "attestations: write");
  assertStringIncludes(readme, "wildcard CORS");
  assertStringIncludes(readme, "no authentication");
  assertEquals(/authenticated\s+reverse\s+proxy/.test(readme), true);
  assertStringIncludes(readme, "non-loopback");
  assertStringIncludes(readme, "not sandboxed");
  assertEquals(/host or\s+container user/.test(readme), true);
});
