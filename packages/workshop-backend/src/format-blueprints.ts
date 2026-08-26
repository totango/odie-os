// Installing the deployment's bundled output-format blueprints.
//
// The archives and their presentation come from a directory chosen at build time (see
// scripts/build-format-blueprints.mjs), so a deployment ships its own formats by pointing
// FORMAT_BLUEPRINTS_DIR at its own tree rather than by editing this repo.
//
// Installation writes an ordinary blueprint -- metadata into BLUEPRINTS, the code snapshot into
// BLUEPRINT_CONTENT -- exactly as publishing does. Nothing downstream knows these are special:
// no reserved id prefix, no fallback branch in the read path. Failure is tolerable: a deployment
// with none installed simply has no standard formats.

import { BlueprintMetadata, BlueprintPublicInfo } from "@gadgets/workshop-shared/api";
import { BlueprintKvRecord, parseBlueprintArchive } from "./blueprint-archive.js";
import {
  BundledFeaturedBlueprint,
  BundledFormatBlueprint,
  FEATURED_BLUEPRINTS,
  FORMAT_BLUEPRINTS,
} from "./generated/format-blueprints.js";
import { fingerprint } from "./admin-config.js";
import { createWorkshopLogger } from "./observability";

const logger = createWorkshopLogger("workshop.formats");

type InstallEnv = Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">;

/**
 * Identifies the exact set of bundled blueprints a deployment has installed, and how. Compared
 * with what was installed last time, so any change here triggers reinstallation.
 *
 * Everything that ends up in the installed metadata contributes, not just `revision`: editing a
 * description would otherwise build, deploy, and change nothing on a deployment that had already
 * installed. `revision` covers the one input this can't see, the archive bytes.
 */
export function formatBlueprintsManifestVersion(): string {
  return FORMAT_BLUEPRINTS
      .map(e => `${e.blueprintId}@${e.revision}+` +
          fingerprint(JSON.stringify([e.title, e.description, e.author, e.output])))
      .toSorted()
      .join(",");
}

/**
 * Identifies the exact featured starter set installed into Explore. Kept separate from the format
 * fingerprint so starters never participate in format promotion or curation.
 */
export function featuredBlueprintsManifestVersion(): string {
  return FEATURED_BLUEPRINTS
      .map(e => `${e.blueprintId}@${e.revision}+` +
          fingerprint(JSON.stringify([e.title, e.description, e.author])))
      .toSorted()
      .join(",");
}

// Install one bundled blueprint, returning its public info for the featured mirror.
async function installOne(env: InstallEnv, entry: BundledFormatBlueprint | BundledFeaturedBlueprint)
    : Promise<BlueprintPublicInfo> {
  // Parse through the ordinary archive reader so a corrupt bundled file fails the same way an
  // uploaded one would, rather than producing a half-installed blueprint.
  let {metadata, contentLength, content} = await parseBlueprintArchive(
      new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);

  // R2 needs a known length, and the archive is already fully in memory (it came out of the
  // Worker bundle), so buffer rather than plumbing a FixedLengthStream through as the upload path
  // does for genuinely streamed uploads.
  let contentBytes = new Uint8Array(await new Response(content).arrayBuffer());
  if (contentBytes.byteLength !== contentLength) {
    throw new Error(`Archive declares ${contentLength} content bytes but holds ` +
        `${contentBytes.byteLength}.`);
  }

  // The archive supplies what the blueprint does -- code, bindings, and the dates from the
  // workspace it was exported from. How it is presented comes from its sidecar, overwriting
  // whatever the archive carries.
  let installed: BlueprintMetadata = {
    ...metadata,
    title: entry.title,
    description: entry.description,
    author: entry.author,
    output: "output" in entry ? entry.output : undefined,
  };

  // Content first: a blueprint whose metadata exists but whose R2 object doesn't is broken, while
  // the reverse is merely an orphaned object that the next install overwrites. The archive's
  // content section is already gzip-compressed, which is exactly what R2 holds.
  await env.BLUEPRINT_CONTENT.put(`${entry.blueprintId}/${installed.version}`, contentBytes);

  let kvRecord: BlueprintKvRecord = {metadata: installed};
  await env.BLUEPRINTS.put(entry.blueprintId, JSON.stringify(kvRecord));

  return {id: entry.blueprintId, metadata: installed};
}

/**
 * Install every bundled blueprint, skipping (and logging) any that fail. Returns the public info
 * of those that installed, so the caller can offer them to users.
 */
export async function installFormatBlueprints(env: InstallEnv): Promise<BlueprintPublicInfo[]> {
  let installed: BlueprintPublicInfo[] = [];
  for (let entry of FORMAT_BLUEPRINTS) {
    try {
      installed.push(await installOne(env, entry));
      logger.info("installed format blueprint", {
        event: "formats.install.ok", blueprintId: entry.blueprintId,
      });
    } catch (err) {
      // One bad archive must not deny the deployment the others.
      logger.error("failed to install format blueprint", {
        event: "formats.install.failed", blueprintId: entry.blueprintId, error: err,
      });
    }
  }
  return installed;
}

/**
 * Install every bundled starter blueprint. These are ordinary ownerless blueprints; AdminSettings
 * mirrors discoverable starters to the deployment featured collection and keeps protected hub
 * content out of that mirror. They are never promoted as output formats.
 */
export async function installFeaturedBlueprints(env: InstallEnv): Promise<BlueprintPublicInfo[]> {
  let installed: BlueprintPublicInfo[] = [];
  for (let entry of FEATURED_BLUEPRINTS) {
    try {
      installed.push(await installOne(env, entry));
      logger.info("installed featured blueprint", {
        event: "featured.install.ok", blueprintId: entry.blueprintId,
      });
    } catch (err) {
      logger.error("failed to install featured blueprint", {
        event: "featured.install.failed", blueprintId: entry.blueprintId, error: err,
      });
    }
  }
  return installed;
}
