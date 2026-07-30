/** Generate the TypeScript copy of the Python harness used in JSR releases. */

const harnessPath = new URL("../src/api/harness.py", import.meta.url);
const outputPath = new URL("../src/api/harness-source.ts", import.meta.url);
const source = await Deno.readTextFile(harnessPath);

const generated = [
  "/**",
  " * Generated from harness.py by scripts/generate-harness-source.ts.",
  " * Do not edit by hand; `deno task generate:harness-source` refreshes it.",
  " */",
  "",
  `export const HARNESS_SOURCE = ${JSON.stringify(source)};`,
  "",
].join("\n");

await Deno.writeTextFile(outputPath, generated);
