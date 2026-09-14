import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { ACCOUNT_DIRECTORY_KEY_PREFIX } from "./blueprint-archive";
const MAX_DIRECTORY_TERM = 128;
const MAX_DIRECTORY_RESULTS = 10;
const MAX_KV_KEY_BYTES = 512;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function key(kind: "profile" | "name", term: string, profileId: string): string {
  return `${ACCOUNT_DIRECTORY_KEY_PREFIX}${kind}:${encodeURIComponent(normalized(term))}:${encodeURIComponent(profileId)}`;
}

/** Records bounded, derived lookup hints. Exact account state remains authoritative in the User DO. */
export async function indexAccountProfile(directory: KVNamespace, profile: AiChatAuthorInfo): Promise<void> {
  if (typeof profile.id !== "string" || !profile.id || profile.id.length > 256) return;
  const entries = [["profile", profile.id], ["name", profile.name]] as const;
  const keys = entries.filter(([, term]) => typeof term === "string" && term.length > 0 && term.length <= MAX_DIRECTORY_TERM)
    .map(([kind, term]) => key(kind, term, profile.id))
    .filter(candidate => new TextEncoder().encode(candidate).byteLength <= MAX_KV_KEY_BYTES);
  await Promise.all(keys.map(candidate => directory.put(candidate, "1", {expirationTtl: 90 * 24 * 60 * 60})));
}

/** Returns exact profile IDs from a bounded prefix index. Results are stale hints until User-DO validation. */
export async function searchAccountProfileHints(directory: KVNamespace, query: string): Promise<string[]> {
  if (typeof query !== "string" || query.length > MAX_DIRECTORY_TERM || [...query].some(character => character.charCodeAt(0) < 32)) throw new Error("INVALID_ADMIN_INPUT");
  const term = normalized(query.trim());
  if (term.length < 2) return [];
  const prefixes = (["profile", "name"] as const).map(kind => `${ACCOUNT_DIRECTORY_KEY_PREFIX}${kind}:${encodeURIComponent(term)}`);
  if (prefixes.some(prefix => new TextEncoder().encode(prefix).byteLength > MAX_KV_KEY_BYTES)) return [];
  const pages = await Promise.all(prefixes.map(prefix => directory.list({prefix, limit: MAX_DIRECTORY_RESULTS + 1})));
  const result: string[] = [];
  for (const page of pages) for (const entry of page.keys) {
    const encodedProfileId = entry.name.slice(entry.name.lastIndexOf(":") + 1);
    let profileId: string;
    try { profileId = decodeURIComponent(encodedProfileId); } catch { continue; }
    if (!profileId || profileId.length > 256 || [...profileId].some(character => character.charCodeAt(0) < 32)) continue;
    if (!result.includes(profileId)) result.push(profileId);
    if (result.length === MAX_DIRECTORY_RESULTS) return result;
  }
  return result;
}

/** Rechecks that a current profile still matches the normalized discovery term. */
export function accountProfileMatches(profile: Pick<AiChatAuthorInfo, "id" | "name">, query: string): boolean {
  const term = normalized(query.trim());
  return normalized(profile.id).startsWith(term) || normalized(profile.name).startsWith(term);
}

