import type { GatekeeperUserVerifier } from "./gatekeeper.js";
import type { CodingSessionRepositoryOption } from "./api.js";

/** GitHub-specific verifier minted from a user's connected GitHub account. */
export interface GitHubVerifierApi extends GatekeeperUserVerifier {
  /** Returns whether the connected user can read a repository. */
  hasRepoAccess(owner: string, repo: string): Promise<boolean>;

  /** Returns whether the connected user can push to a repository. */
  hasRepoWriteAccess(owner: string, repo: string): Promise<boolean>;

  /** Lists repositories for one owner that the connected user can push to, bounded by `limit`. */
  listReposWithWriteAccess(owner: string, limit: number): Promise<CodingSessionRepositoryOption[]>;

  /** Searches repositories for one owner that the connected user can push to, bounded by `limit`. */
  searchReposWithWriteAccess(owner: string, query: string, limit: number): Promise<CodingSessionRepositoryOption[]>;
}
