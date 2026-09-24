/** Generate the JSR-embedded source for the fixed 2D projection harness. */

const harnessPath = new URL(
  "../src/api/projection-2d-harness.py",
  import.meta.url,
);
const outputPath = new URL(
  "../src/api/projection-2d-harness-source.ts",
  import.meta.url,
);
const source = await Deno.readTextFile(harnessPath);

const generated = [
  "/**",
  " * Generated from projection-2d-harness.py by scripts/generate-projection-2d-harness-source.ts.",
  " * Do not edit by hand; rerun the generator to refresh it.",
  " */",
  "",
  `export const PROJECTION_2D_HARNESS_SOURCE = ${JSON.stringify(source)};`,
  "",
].join("\n");

await Deno.writeTextFile(outputPath, generated);
