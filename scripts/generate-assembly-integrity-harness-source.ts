/** Generate the JSR-embedded source for the fixed assembly-integrity harness. */

const harnessPath = new URL(
  "../src/api/assembly-integrity-harness.py",
  import.meta.url,
);
const outputPath = new URL(
  "../src/api/assembly-integrity-harness-source.ts",
  import.meta.url,
);
const source = await Deno.readTextFile(harnessPath);

const generated = [
  "/**",
  " * Generated from assembly-integrity-harness.py by scripts/generate-assembly-integrity-harness-source.ts.",
  " * Do not edit by hand; `deno task generate:assembly-integrity-harness-source` refreshes it.",
  " */",
  "",
  `export const ASSEMBLY_INTEGRITY_HARNESS_SOURCE = ${JSON.stringify(source)};`,
  "",
].join("\n");

await Deno.writeTextFile(outputPath, generated);
