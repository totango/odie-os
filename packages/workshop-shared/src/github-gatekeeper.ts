import type { GatekeeperUserVerifier } from "./gatekeeper.js";

/** GitHub-specific verifier minted from a user's connected GitHub account. */
export interface GitHubVerifierApi extends GatekeeperUserVerifier {
  /** Returns whether the connected user can read a repository. */
  hasRepoAccess(owner: string, repo: string): Promise<boolean>;

  /** Returns whether the connected user can push to a repository. */
  hasRepoWriteAccess(owner: string, repo: string): Promise<boolean>;
}
