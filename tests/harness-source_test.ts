import { assertEquals } from "@std/assert";
import { HARNESS_SOURCE } from "../src/api/harness-source.ts";

Deno.test("harness source module stays in sync with harness.py", async () => {
  const harnessPath = new URL("../src/api/harness.py", import.meta.url);
  assertEquals(HARNESS_SOURCE, await Deno.readTextFile(harnessPath));
});
