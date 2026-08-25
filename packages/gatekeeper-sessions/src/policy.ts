import type { CodingSessionRepository } from "@gadgets/workshop-shared/api";
import { isCodingSessionRepository, validateCodingSessionRepositories } from "@gadgets/workshop-shared/coding-sessions";

const GITHUB_ORIGIN = "https://github.com";

/** Validates and canonically orders a non-empty coding-session repository set. */
export function validateRepositories(values: CodingSessionRepository[]): CodingSessionRepository[] {
  return validateCodingSessionRepositories(values);
}

/** Extracts a canonical Totango repository from an allowed Git smart-HTTP URL. */
export function gitRepositoryFromUrl(url: URL): CodingSessionRepository | null {
  if (url.origin !== GITHUB_ORIGIN || url.username || url.password) return null;
  const match = /^\/totango\/([a-z0-9-]+)\.git(?:\/(?:info\/refs|git-upload-pack|git-receive-pack))?$/.exec(
    url.pathname.toLowerCase());
  return match && isCodingSessionRepository(match[1]) ? match[1] : null;
}
