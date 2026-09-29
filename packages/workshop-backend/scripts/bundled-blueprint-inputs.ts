import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateBundledBlueprintsModule } from "@gadgets/bundled-blueprints";

/** Assemble the deployment default before validation, so local archives share the upstream ID checks. */
export async function generateDefaultBundledBlueprints(upstreamDir: string, localDir: string) {
  const staging = await mkdtemp(join(tmpdir(), "workshop-bundled-blueprints-"));
  try {
    const names = new Set<string>();
    for (const directory of [upstreamDir, localDir]) {
      for (const name of (await readdir(directory)).toSorted()) {
        if (name === "README.md") continue;
        if (names.has(name)) throw new Error(`Duplicate bundled blueprint input: ${name}`);
        names.add(name);
        await cp(join(directory, name), join(staging, name), { recursive: true });
      }
    }
    return await generateBundledBlueprintsModule(staging, {
      builtFrom: "blueprints/ and workshop-backend/format-blueprints/",
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
