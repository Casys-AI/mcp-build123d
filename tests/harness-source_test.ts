import { assertEquals, assertStringIncludes } from "@std/assert";
import { ASSEMBLY_INTEGRITY_HARNESS_SOURCE } from "../src/api/assembly-integrity-harness-source.ts";
import { HARNESS_SOURCE } from "../src/api/harness-source.ts";

Deno.test("harness source module stays in sync with harness.py", async () => {
  const harnessPath = new URL("../src/api/harness.py", import.meta.url);
  assertEquals(HARNESS_SOURCE, await Deno.readTextFile(harnessPath));
  assertStringIncludes(
    HARNESS_SOURCE,
    'STEP_FILE_NAME_TIMESTAMP_SENTINEL = "1970-01-01T00:00:00Z"',
  );
  assertStringIncludes(HARNESS_SOURCE, "not the");
  assertStringIncludes(HARNESS_SOURCE, "execution or export time");
  assertStringIncludes(
    HARNESS_SOURCE,
    "timestamp=STEP_FILE_NAME_TIMESTAMP_SENTINEL",
  );
});

Deno.test("assembly-integrity harness source module stays in sync with its fixed observer", async () => {
  const harnessPath = new URL(
    "../src/api/assembly-integrity-harness.py",
    import.meta.url,
  );
  assertEquals(
    ASSEMBLY_INTEGRITY_HARNESS_SOURCE,
    await Deno.readTextFile(harnessPath),
  );
  assertStringIncludes(ASSEMBLY_INTEGRITY_HARNESS_SOURCE, "GetLocation_s");
  assertStringIncludes(ASSEMBLY_INTEGRITY_HARNESS_SOURCE, "FileUnits");
  assertStringIncludes(
    ASSEMBLY_INTEGRITY_HARNESS_SOURCE,
    "SetMultiThread(False)",
  );
});
