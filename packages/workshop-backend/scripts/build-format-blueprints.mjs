// Bundles repository-provided blueprints into a generated TypeScript module, so the Worker can
// install them with no network access when a deployment first serves /api.
//
// The directory defaults to this package's `format-blueprints/`, and `FORMAT_BLUEPRINTS_DIR`
// points somewhere else. That is how a deployment ships its own formats: this repo is often a
// submodule, so a fork can't add files here without conflicting on every update -- it keeps its
// archives in its own tree and points the build at them. Whatever directory is named *is* the
// deployment's format set; it replaces this one rather than adding to it.
//
// Each blueprint is a `<name>.gadget` archive and a `<name>.json` beside it describing how to
// present it. Nothing references a list, so a directory outside this repo is self-contained.
//
// Archives are binary, so they are emitted as base64 -- the same "bundle a data file as a
// generated module" approach gatekeeper-context uses for its SPA.

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as Y from "yjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const formatSourceDir = resolve(pkgRoot, process.env.FORMAT_BLUEPRINTS_DIR ?? "format-blueprints");
const featuredSourceDir = resolve(pkgRoot, process.env.FEATURED_BLUEPRINTS_DIR ?? "featured-blueprints");
const outFile = join(pkgRoot, "src", "generated", "format-blueprints.ts");
const MAX_BLUEPRINT_METADATA_BYTES = 64 * 1024;
const MAX_BLUEPRINT_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const BLUEPRINT_ARCHIVE_MAGIC = 0xec2e2d3a2300e317n;
const BLUEPRINT_ARCHIVE_VERSION = 1;

// Icons a blueprint may declare. Duplicated from the shared API's OUTPUT_ICONS because this script
// runs before (and without) a TypeScript build; the runtime validates against the real list, so
// the cost of drift is a build that rejects an icon the Worker would have accepted.
const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"];

// Must match isReservedBlueprintKey() in src/blueprint-archive.ts. This build script runs without
// loading TypeScript modules, so keep the tiny control-key list here as well.
const RESERVED_BLUEPRINT_KEYS = new Set([".featured", ".adminConfig"]);

// Validated here rather than at runtime so a typo fails the build of whoever made it, instead of
// quietly presenting the wrong thing in production. Unknown keys are rejected too: silently
// ignoring one looks exactly like the field not working.
function parseSidecar(name, raw, kind) {
  let bad = (message) => { throw new Error(`${name}.json: ${message}`); };
  let parsed = JSON.parse(raw);

  let string = (value, what) => {
    if (typeof value !== "string" || value.trim() === "") bad(`${what} must be a non-empty string`);
    return value;
  };

  let { blueprintId, title, description, output, author, revision, bindings, updatedAt, $comment, ...rest } = parsed;
  if (Object.keys(rest).length > 0) bad(`unknown keys: ${Object.keys(rest).join(", ")}`);

  if (!/^[a-zA-Z0-9._-]+$/.test(blueprintId ?? "")) {
    bad("blueprintId must be a non-empty [a-zA-Z0-9._-] string");
  }
  if (RESERVED_BLUEPRINT_KEYS.has(blueprintId)) {
    bad(`blueprintId ${blueprintId} is reserved`);
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    bad("revision must be a positive integer");
  }
  let cleanOutput;
  if (kind === "format") {
    if (typeof output !== "object" || output === null) bad("output is required");
    let { id, noun, plural, icon, ...outputRest } = output;
    if (Object.keys(outputRest).length > 0) {
      bad(`unknown output keys: ${Object.keys(outputRest).join(", ")}`);
    }
    if (!OUTPUT_ICONS.includes(icon)) {
      bad(`output.icon must be one of: ${OUTPUT_ICONS.join(", ")}`);
    }
    cleanOutput = {
      id: string(id, "output.id"),
      noun: string(noun, "output.noun"),
      plural: string(plural, "output.plural"),
      icon,
    };
  } else if (output !== undefined) {
    bad("output is only allowed for bundled format blueprints");
  }
  if (kind === "format" && bindings !== undefined) {
    bad("bindings is only allowed for bundled featured blueprints");
  }
  if (kind === "format" && updatedAt !== undefined) {
    bad("updatedAt is only allowed for bundled featured blueprints");
  }
  if (kind === "featured" && bindings !== undefined) {
    let emptyArray = Array.isArray(bindings) && bindings.length === 0;
    let emptyObject = typeof bindings === "object" && bindings !== null &&
        !Array.isArray(bindings) && Object.keys(bindings).length === 0;
    if (!emptyArray && !emptyObject) bad("bindings must be omitted, an empty array, or an empty object");
  }
  let cleanUpdatedAt;
  if (kind === "featured") {
    if (typeof updatedAt !== "string" || Number.isNaN(Date.parse(updatedAt)) ||
        new Date(updatedAt).toISOString() !== updatedAt) {
      bad("updatedAt must be an ISO 8601 UTC timestamp");
    }
    cleanUpdatedAt = updatedAt;
  }
  if (typeof author !== "object" || author === null) bad("author is required");
  let { type: authorType, name: authorName, id: authorId, ...authorRest } = author;
  if (Object.keys(authorRest).length > 0) {
    bad(`unknown author keys: ${Object.keys(authorRest).join(", ")}`);
  }
  if (authorType !== undefined && authorType !== "user") bad(`author.type must be "user"`);

  return {
    blueprintId,
    title: string(title, "title"),
    description: string(description, "description"),
    ...(cleanOutput ? { output: cleanOutput } : {}),
    author: {
      type: "user",
      name: string(authorName, "author.name"),
      id: string(authorId, "author.id"),
    },
    revision,
    ...(cleanUpdatedAt ? { updatedAt: cleanUpdatedAt } : {}),
  };
}

function encodeArchive(metadata, gzipContent) {
  let metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_BLUEPRINT_METADATA_BYTES) {
    throw new Error(`${metadata.title}: metadata is too large`);
  }
  if (gzipContent.byteLength > MAX_BLUEPRINT_CONTENT_BYTES) {
    throw new Error(`${metadata.title}: content archive is too large`);
  }

  let result = new Uint8Array(24 + metadataBytes.byteLength + gzipContent.byteLength);
  let view = new DataView(result.buffer);
  view.setBigUint64(0, BLUEPRINT_ARCHIVE_MAGIC);
  view.setUint32(8, BLUEPRINT_ARCHIVE_VERSION);
  view.setUint32(12, metadataBytes.byteLength);
  view.setBigUint64(16, BigInt(gzipContent.byteLength));
  result.set(metadataBytes, 24);
  result.set(gzipContent, 24 + metadataBytes.byteLength);
  return Buffer.from(result).toString("base64");
}

function stableClientId(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

async function readStarterFile(dir, name) {
  let path = join(dir, name);
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    throw new Error(`${dir} is missing required ${name}`, { cause: err });
  }
  if (!info.isFile()) throw new Error(`${path} must be a file`);
  if (info.size > MAX_SOURCE_FILE_BYTES) throw new Error(`${path} exceeds ${MAX_SOURCE_FILE_BYTES} bytes`);
  return readFile(path, "utf8");
}

async function packageFeaturedBlueprint(slug, dir) {
  const requiredFiles = new Set(["README.md", "blueprint.json", "client.js", "server.js"]);
  let sourceEntries = await readdir(dir, { withFileTypes: true });
  let unexpected = sourceEntries
      .filter(entry => !entry.isFile() || !requiredFiles.has(entry.name))
      .map(entry => entry.name)
      .toSorted();
  if (unexpected.length > 0) {
    throw new Error(`${dir} contains unexpected entries: ${unexpected.join(", ")}`);
  }
  let missing = [...requiredFiles].filter(name => !sourceEntries.some(entry => entry.name === name));
  if (missing.length > 0) throw new Error(`${dir} is missing required files: ${missing.join(", ")}`);

  let raw = await readStarterFile(dir, "blueprint.json");
  let entry = parseSidecar(`${slug}/blueprint`, raw, "featured");
  let [client, server, readme] = await Promise.all([
    readStarterFile(dir, "client.js"),
    readStarterFile(dir, "server.js"),
    readStarterFile(dir, "README.md"),
  ]);

  let doc = new Y.Doc();
  doc.clientID = stableClientId(slug);
  let files = doc.getMap();
  for (let [name, contents] of [["README.md", readme], ["client.js", client], ["server.js", server]]) {
    let text = new Y.Text();
    text.insert(0, contents);
    files.set(name, text);
  }
  let update = Y.encodeStateAsUpdateV2(doc);
  let gzipContent = gzipSync(update, { mtime: 0 });
  let { updatedAt: archiveDate, ...bundledEntry } = entry;
  let metadata = {
    title: entry.title,
    description: entry.description,
    author: entry.author,
    created: archiveDate,
    version: entry.revision,
    lastUpdated: archiveDate,
    bindings: {},
  };
  return { ...bundledEntry, archive: encodeArchive(metadata, gzipContent) };
}

// An empty directory is a supported way to ship no formats, so it is a warning rather than an
// error. A mistyped FORMAT_BLUEPRINTS_DIR fails in readdir() above, which is the case worth
// catching.
let archives = (await readdir(formatSourceDir)).filter((f) => f.endsWith(".gadget")).toSorted();
if (archives.length === 0) {
  console.warn(`No *.gadget archives in ${formatSourceDir}; the deployment will bundle no formats.`);
}

let formatEntries = [];
let totalBytes = 0;
let seen = new Map();
for (let file of archives) {
  let name = basename(file, ".gadget");
  let raw;
  try {
    raw = await readFile(join(formatSourceDir, `${name}.json`), "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    throw new Error(`${file} has no ${name}.json describing it.`, { cause: err });
  }

  let entry = parseSidecar(name, raw, "format");
  // Two archives installing under one id would race, and only one would survive.
  let duplicate = seen.get(entry.blueprintId);
  if (duplicate) throw new Error(`${name}.json and ${duplicate}.json share id ${entry.blueprintId}`);
  seen.set(entry.blueprintId, name);

  let bytes = await readFile(join(formatSourceDir, file));
  totalBytes += bytes.byteLength;
  formatEntries.push({ ...entry, archive: bytes.toString("base64") });
}

let featuredEntries = [];
let featuredDirs = [];
try {
  for (let dirent of await readdir(featuredSourceDir, { withFileTypes: true })) {
    if (dirent.isDirectory()) featuredDirs.push(dirent.name);
  }
} catch (err) {
  if (err?.code !== "ENOENT") throw err;
}
for (let slug of featuredDirs.toSorted()) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`featured blueprint directory ${slug} must be a lowercase slug`);
  }
  let entry = await packageFeaturedBlueprint(slug, join(featuredSourceDir, slug));
  let duplicate = seen.get(entry.blueprintId);
  if (duplicate) throw new Error(`${slug}/blueprint.json and ${duplicate}.json share id ${entry.blueprintId}`);
  seen.set(entry.blueprintId, `${slug}/blueprint`);
  featuredEntries.push(entry);
}

let generated = `// GENERATED by scripts/build-format-blueprints.mjs -- do not edit.
//
// The deployment's bundled blueprints, with their archives base64-encoded so they can be bundled
// into the Worker. Formats are built from ${process.env.FORMAT_BLUEPRINTS_DIR ? "FORMAT_BLUEPRINTS_DIR" : "format-blueprints/"}; featured starters are built from ${process.env.FEATURED_BLUEPRINTS_DIR ? "FEATURED_BLUEPRINTS_DIR" : "featured-blueprints/"}.

import type { AiChatAuthorInfo, BlueprintOutput } from "@gadgets/workshop-shared/api";

// One bundled blueprint: how to present it, and the archive that says what it does. The build
// validates these sidecar fields; the archive itself is copied verbatim and checked when the
// importer writes it.
export type BundledFormatBlueprint = {
  blueprintId: string;
  title: string;
  description: string;
  output: BlueprintOutput;
  author: AiChatAuthorInfo;

  // Bumped when the archive changes, to trigger a reinstall on deployments already holding an
  // older copy. Everything else here is covered by the install fingerprint.
  revision: number;

  // The archive's bytes, base64-encoded.
  archive: string;
};

// One bundled featured starter blueprint. Unlike formats, these are discoverable examples only and
// are never promoted into AdminConfig.formats.
export type BundledFeaturedBlueprint = {
  blueprintId: string;
  title: string;
  description: string;
  author: AiChatAuthorInfo;
  revision: number;
  archive: string;
};

export const FORMAT_BLUEPRINTS: BundledFormatBlueprint[] = ${JSON.stringify(formatEntries, null, 2)};

export const FEATURED_BLUEPRINTS: BundledFeaturedBlueprint[] = ${JSON.stringify(featuredEntries, null, 2)};
`;

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, generated);

console.log(`Bundled ${formatEntries.length} format blueprint(s) from ${formatSourceDir} and ` +
    `${featuredEntries.length} featured starter blueprint(s), ${(totalBytes / 1024).toFixed(0)} KiB raw -> ${outFile}`);
