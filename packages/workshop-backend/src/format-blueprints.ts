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

import { BlueprintMetadata, BlueprintPublicInfo, FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID } from "@gadgets/workshop-shared/api";
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

const FINANCE_OPERATIONS_WORKBENCH_TITLE = "Finance Operations Workbench";

type InstallEnv = Pick<Cloudflare.Env, "BLUEPRINTS" | "BLUEPRINT_CONTENT">;

/** Canonical bundled Finance app source used only to recover an uninitialized claimed workspace. */
export type BundledFinanceOperationsWorkbenchSource = {
  /** Stable protected blueprint id that supplied the source. */
  blueprintId: typeof FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID;
  /** Validated metadata with the bundled sidecar's presentation fields applied. */
  metadata: BlueprintMetadata;
  /** Uncompressed Yjs V2 update containing the Finance app files. */
  code: Uint8Array;
};

/**
 * Return the validated, immutable Finance Operations Workbench source bundled into this Worker.
 * This deliberately reads only the generated FEATURED_BLUEPRINTS module, never mutable KV/R2 or
 * caller-provided bytes, and fails closed if the bundle no longer contains exactly one protected
 * Finance entry with the expected archive metadata.
 */
export async function loadBundledFinanceOperationsWorkbenchSource()
    : Promise<BundledFinanceOperationsWorkbenchSource> {
  let matches = FEATURED_BLUEPRINTS.filter(
      entry => entry.blueprintId === FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one bundled ${FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID}.`);
  }

  let entry = matches[0]!;
  if (entry.title !== FINANCE_OPERATIONS_WORKBENCH_TITLE) {
    throw new Error("Bundled Finance blueprint sidecar title is not canonical.");
  }

  let {metadata, contentLength, content} = await parseBlueprintArchive(
      new Response(Uint8Array.fromBase64(entry.archive) as BufferSource).body!);
  let gzipBytes = new Uint8Array(await new Response(content).arrayBuffer());
  if (gzipBytes.byteLength !== contentLength) {
    throw new Error(`Archive declares ${contentLength} content bytes but holds ` +
        `${gzipBytes.byteLength}.`);
  }
  if (metadata.version !== entry.revision) {
    throw new Error("Bundled Finance archive version does not match its revision.");
  }
  if (metadata.title !== FINANCE_OPERATIONS_WORKBENCH_TITLE) {
    throw new Error("Bundled Finance archive title is not canonical.");
  }
  if (Object.keys(metadata.bindings).length !== 0) {
    throw new Error("Bundled Finance archive declares bindings.");
  }

  let decompressed = new Response(gzipBytes).body!.pipeThrough(new DecompressionStream("gzip"));
  let code = new Uint8Array(await new Response(decompressed).arrayBuffer());
  if (code.byteLength === 0) {
    throw new Error("Bundled Finance archive has no code.");
  }

  let installed: BlueprintMetadata = {
    ...metadata,
    title: entry.title,
    description: entry.description,
    author: entry.author,
    output: undefined,
  };

  return {
    blueprintId: FINANCE_OPERATIONS_WORKBENCH_BLUEPRINT_ID,
    metadata: installed,
    code,
  };
}

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
