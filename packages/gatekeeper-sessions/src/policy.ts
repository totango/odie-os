import type { CodingSessionRepository } from "@gadgets/workshop-shared/api";
import { isCodingSessionRepository } from "@gadgets/workshop-shared/coding-sessions";

const GITHUB_ORIGIN = "https://github.com";

/** Validates and canonically orders a non-empty coding-session repository set. */
export function validateRepositories(values: CodingSessionRepository[]): CodingSessionRepository[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error("Select at least one repository.");
  const repositories = [...new Set(values)];
  if (repositories.length !== values.length || repositories.some(value => !isCodingSessionRepository(value))) {
    throw new Error("Coding session repository set is invalid.");
  }
  return repositories.toSorted();
}

/** Extracts a canonical Totango repository from an allowed Git smart-HTTP URL. */
export function gitRepositoryFromUrl(url: URL): CodingSessionRepository | null {
  if (url.origin !== GITHUB_ORIGIN || url.username || url.password) return null;
  const match = /^\/totango\/([a-z0-9-]+)\.git(?:\/(?:info\/refs|git-upload-pack|git-receive-pack))?$/.exec(
    url.pathname.toLowerCase());
  return match && isCodingSessionRepository(match[1]) ? match[1] : null;
}
