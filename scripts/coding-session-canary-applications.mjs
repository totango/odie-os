import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^odie-coding-canary-[1-9][0-9]*-standard-[1-4]-container$/;
const MAX_PAGES = 1_000;

/** Walks every Containers applications page and returns the sole exact-name UUID, or null. */
export async function findExactApplication(options) {
  if (!/^[0-9a-f]{32}$/.test(options.accountId)) throw new Error("Invalid Cloudflare account ID.");
  if (!NAME.test(options.name)) throw new Error("Invalid canary application name.");
  const matches = [];
  const seenTokens = new Set();
  let pageToken;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/containers/dash/applications`);
    url.searchParams.set("per_page", "100");
    if (pageToken !== undefined) url.searchParams.set("page_token", pageToken);
    const response = await options.fetch(url, {
      headers: { Authorization: `Bearer ${options.apiToken}` },
    });
    if (!response.ok) throw new Error("Cloudflare applications page request failed.");
    const body = await response.text();
    if (body.length > 1024 * 1024) throw new Error("Cloudflare applications page is too large.");
    let page;
    try { page = JSON.parse(body); } catch { throw new Error("Malformed Cloudflare applications page."); }
    const nextPageToken = validatePage(page);
    for (const application of page.result) {
      if (application.name !== options.name) continue;
      if (!UUID.test(application.id)) throw new Error("Exact canary application has an invalid UUID.");
      matches.push(application.id);
      if (matches.length > 1) throw new Error("Duplicate exact canary application names found.");
    }
    if (nextPageToken === undefined) return matches[0] ?? null;
    if (seenTokens.has(nextPageToken)) throw new Error("Repeated applications page token.");
    seenTokens.add(nextPageToken);
    pageToken = nextPageToken;
  }
  throw new Error("Applications pagination exceeded its bound.");
}

function validatePage(page) {
  if (!page || typeof page !== "object" || Array.isArray(page) || page.success !== true || !Array.isArray(page.result) ||
      !page.result_info || typeof page.result_info !== "object" || Array.isArray(page.result_info)) {
    throw new Error("Malformed Cloudflare applications page.");
  }
  for (const application of page.result) {
    if (!application || typeof application !== "object" || Array.isArray(application) ||
        typeof application.id !== "string" || typeof application.name !== "string") {
      throw new Error("Malformed Cloudflare application record.");
    }
  }
  const token = page.result_info.next_page_token;
  if (token === undefined || token === null || token === "") return undefined;
  if (typeof token !== "string" || token.length > 2_048 ||
      [...token].some(character => character.charCodeAt(0) < 0x21 || character.charCodeAt(0) > 0x7e)) {
    throw new Error("Malformed applications page token.");
  }
  return token;
}

function parseArgs(values) {
  const allowed = new Set(["--name", "--out"]);
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!allowed.has(name) || value === undefined || result.has(name)) throw new Error("Invalid application lookup arguments.");
    result.set(name, value);
  }
  if (result.size !== allowed.size) throw new Error("Missing application lookup argument.");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is required.");
  const applicationId = await findExactApplication({
    accountId, apiToken, name: args.get("--name"), fetch,
  });
  writeFileSync(args.get("--out"), `${JSON.stringify({ applicationId })}\n`, { mode: 0o600 });
}
