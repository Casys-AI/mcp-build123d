/** Guard exact release tags and JSR idempotency before a publication upload. */

export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function assertMatchingReleaseRef(
  ref: string,
  version: string,
): void {
  const expected = `refs/tags/v${version}`;
  if (ref !== expected) {
    throw new Error(`Release tag must exactly match ${expected}.`);
  }
}

/** Fail closed when JSR metadata does not have the expected version table. */
export function jsrPublicationDecision(
  metadata: unknown,
  version: string,
): "already-published" | "publish" {
  if (!isRecord(metadata) || !isRecord(metadata.versions)) {
    throw new Error("JSR metadata did not contain a versions object.");
  }
  return Object.hasOwn(metadata.versions, version)
    ? "already-published"
    : "publish";
}

export async function readPackageIdentity(): Promise<PackageIdentity> {
  const config = JSON.parse(await Deno.readTextFile("deno.json")) as unknown;
  if (
    !isRecord(config) || typeof config.name !== "string" ||
    typeof config.version !== "string" || config.name.length === 0 ||
    config.version.length === 0 || config.version.trim() !== config.version ||
    /[\r\n]/.test(config.version)
  ) {
    throw new Error(
      "deno.json must contain non-empty package name and single-line version strings.",
    );
  }
  return { name: config.name, version: config.version };
}

export async function jsrPublicationDecisionForPackage(
  identity: PackageIdentity,
): Promise<"already-published" | "publish"> {
  const response = await fetch(`https://jsr.io/${identity.name}/meta.json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return "publish";
  if (!response.ok) {
    throw new Error(
      `JSR metadata request failed with HTTP ${response.status}.`,
    );
  }
  return jsrPublicationDecision(await response.json(), identity.version);
}

async function main(): Promise<void> {
  const [command, value] = Deno.args;
  const identity = await readPackageIdentity();
  if (command === "tag" && typeof value === "string") {
    assertMatchingReleaseRef(value, identity.version);
    console.log(identity.version);
    return;
  }
  if (command === "published" && value === identity.version) {
    console.log(await jsrPublicationDecisionForPackage(identity));
    return;
  }
  throw new Error(
    "Usage: release-guard.ts tag <refs/tags/vVERSION> | published <VERSION>",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[release-guard] ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }
}
