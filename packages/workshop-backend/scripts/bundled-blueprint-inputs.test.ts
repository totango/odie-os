import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BUNDLED_BLUEPRINTS_DIR } from "@gadgets/bundled-blueprints";
import { generateDefaultBundledBlueprints } from "./bundled-blueprint-inputs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const localDir = join(here, "..", "format-blueprints");

test("default formats retain all support IDs and archive bytes deterministically", async () => {
  const first = await generateDefaultBundledBlueprints(BUNDLED_BLUEPRINTS_DIR, localDir);
  const second = await generateDefaultBundledBlueprints(BUNDLED_BLUEPRINTS_DIR, localDir);
  assert.deepEqual(first, second);
  assert.equal(first.count, 8);
  const entries = JSON.parse(first.text.split("export const BUNDLED_BLUEPRINTS: BundledBlueprint[] = ")[1]!.trim().slice(0, -1));
  for (const slug of ["customer-impact-brief", "engineering-escalation", "handoff", "incident-rca-summary", "weekly-digest"]) {
    const id = `format.support.${slug}`;
    const matches = entries.filter((entry: {blueprintId: string}) => entry.blueprintId === id);
    assert.equal(matches.length, 1, id);
    // Resolve the sidecar by its stable ID rather than assuming the archive's filename.
    const { readdir } = await import("node:fs/promises");
    for (const file of await readdir(localDir)) {
      if (!file.endsWith(".json")) continue;
      const sidecar = JSON.parse(await readFile(join(localDir, file), "utf8"));
      if (sidecar.blueprintId !== id) continue;
      assert.equal(matches[0].archive, (await readFile(join(localDir, file.replace(/\.json$/, ".gadget")))).toString("base64"));
      assert.equal(matches[0].revision, sidecar.revision);
    }
  }
  assert.equal(entries.some((entry: {blueprintId: string}) => entry.blueprintId.startsWith("starter.")), false);
});

test("an explicit empty override replaces the entire default set", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kernel-formats-test-"));
  try {
    const out = join(directory, "generated.ts");
    execFileSync(process.execPath, [join(here, "build-bundled-blueprints.ts"), "--out", out], {
      env: {...process.env, BUNDLED_BLUEPRINTS_DIR: directory},
    });
    assert.match(await readFile(out, "utf8"), /BUNDLED_BLUEPRINTS: BundledBlueprint\[\] = \[\];/);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
